import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const envPath = join(root, ".env");
const stateNamespace = process.env.STATE_NAMESPACE || "";
if (stateNamespace && !/^[a-z0-9-]+$/i.test(stateNamespace)) throw new Error("STATE_NAMESPACE inválido.");
const stateStem = stateNamespace ? `posted.${stateNamespace}` : "posted";
const statePath = join(root, "data", `${stateStem}.json`);
const backupStatePath = join(root, "data", `${stateStem}.backup.json`);
const pendingPath = join(root, "data", `pending${stateNamespace ? `.${stateNamespace}` : ""}.json`);
const BLOCK_MS = 24 * 60 * 60 * 1000;
// Cada tópico mantém uma fila própria: nenhum produto (nem variações de nome,
// link ou imagem) pode retornar antes de 200 publicações daquele tópico.
const ROTATION_ITEMS = 200;
// Evita uma sequência monótona sem bloquear uma categoria durante o dia todo.
// A categoria só volta depois de pelo menos oito outras categorias, para que
// os termos de busca ampliem o catálogo sem virar uma prioridade de postagem.
const CATEGORY_ROTATION_ITEMS = 8;

function parseEnv(text) {
  return Object.fromEntries(
    text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      .map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }),
  );
}

async function loadConfig() {
  let file = "";
  try { file = await readFile(envPath, "utf8"); } catch { /* Em hospedagens, as credenciais podem vir apenas das variáveis de ambiente. */ }
  const config = { ...parseEnv(file), ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value)) };
  for (const key of ["SHOPEE_APP_ID", "SHOPEE_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!config[key]) throw new Error(`Falta preencher ${key} no arquivo .env.`);
  }
  return {
    ...config,
    keywords: (config.KEYWORDS || "oferta").split(",").map((value) => value.trim()).filter(Boolean),
    minDiscount: Number(config.MIN_DISCOUNT_PERCENT || 0),
    minCommission: Number(config.MIN_COMMISSION_PERCENT || 0),
    minPrice: Number(config.MIN_PRICE || 0),
    focusTerms: (config.FOCUS_TERMS || "masculino,perfume,fragrância,smartphone,celular,notebook,fone,headset,teclado,mouse,smartwatch,relógio,monitor,ssd,memória,cartão de memória,caixa de som,bluetooth,console,carregador,power bank,blusa,camisa,camiseta,moletom,casaco,bermuda,calça,tênis,boné,carteira").split(",").map((value) => value.trim().toLocaleLowerCase("pt-BR")).filter(Boolean),
    requiredTerms: (config.REQUIRED_TERMS || "").split(",").map((value) => value.trim().toLocaleLowerCase("pt-BR")).filter(Boolean),
    excludedTerms: (config.EXCLUDED_TERMS || "mesa,boia,brinquedo,infantil,bebê,bebe,papelaria").split(",").map((value) => value.trim().toLocaleLowerCase("pt-BR")).filter(Boolean),
    postsPerCycle: Math.max(1, Number(config.POSTS_PER_CYCLE || 3)),
    pollMs: Math.max(60_000, Number(config.POLL_MINUTES || 45) * 60_000),
  };
}

function payloadFor(keyword) {
  const query = `query ProductOffers($keyword: String!, $page: Int!, $limit: Int!) {
    productOfferV2(keyword: $keyword, sortType: 2, page: $page, limit: $limit) {
      nodes {
        itemId productName imageUrl offerLink priceMin priceMax priceDiscountRate
        commissionRate commission shopName sales periodEndTime
      }
    }
  }`;
  // Vinte resultados por busca eram poucos: depois das travas de repetição e
  // de categoria, alguns tópicos ficavam sem uma opção válida apesar de haver
  // muitas ofertas na Shopee. O limite máximo aceito pela API é 50; ampliar
  // de 20 para 50 aumenta a variedade sem invalidar a consulta.
  return JSON.stringify({ query, operationName: "ProductOffers", variables: { keyword, page: 1, limit: 50 } });
}

async function getShopeeOffers(config, keyword) {
  const payload = payloadFor(keyword);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHash("sha256").update(`${config.SHOPEE_APP_ID}${timestamp}${payload}${config.SHOPEE_SECRET}`).digest("hex");
      const response = await fetch("https://open-api.affiliate.shopee.com.br/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `SHA256 Credential=${config.SHOPEE_APP_ID},Timestamp=${timestamp},Signature=${signature}`,
        },
        body: payload,
      });
      const json = await response.json();
      if (!response.ok || json.errors?.length) throw new Error(json.errors?.map((item) => item.message).join("; ") || `Shopee respondeu HTTP ${response.status}`);
      return json.data?.productOfferV2?.nodes || [];
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`Consulta "${keyword}" indisponível (tentativa ${attempt}/3): ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
  }
  throw lastError;
}

async function getPosted() {
  const parseHistory = (contents) => {
    try { return JSON.parse(contents); } catch { /* tenta o formato legado abaixo */ }
    // Recupera os dois históricos que uma versão anterior gravou com os
    // caracteres literais "\\n" depois do JSON. O próximo salvamento já os
    // normaliza; nunca descartamos o histórico por causa desse defeito.
    return JSON.parse(contents.replace(/\\n\s*$/, "\n"));
  };
  try { return migrateLegacyPosted(new Set(parseHistory(await readFile(statePath, "utf8")))); }
  catch (error) {
    try {
      const backup = migrateLegacyPosted(new Set(parseHistory(await readFile(backupStatePath, "utf8"))));
      console.warn(`Histórico principal recuperado pela cópia de segurança: ${error.message}`);
      return backup;
    } catch (backupError) {
      if (error.code === "ENOENT" && backupError.code === "ENOENT") return new Set();
      throw new Error(`Histórico e cópia de segurança indisponíveis; publicação bloqueada: ${error.message}`);
    }
  }
}

async function savePosted(posted) {
  await mkdir(dirname(statePath), { recursive: true });
  const contents = JSON.stringify([...compactPosted(posted)], null, 2);
  await Promise.all([writeFile(statePath, contents), writeFile(backupStatePath, contents)]);
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function seenKey(value, timestamp = Date.now()) {
  return `seen:${fingerprint(value)}:${timestamp}`;
}

function seenTimestampsInRotation(posted) {
  return new Set([...posted]
    .filter((entry) => entry.startsWith("seen:"))
    .map((entry) => Number(entry.slice(entry.lastIndexOf(":") + 1)))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
    .filter((timestamp, index, values) => index === 0 || timestamp !== values[index - 1])
    .slice(0, ROTATION_ITEMS));
}

function hasRecentValue(posted, value) {
  const prefix = `seen:${fingerprint(value)}:`;
  // A trava por tempo impede repetição rápida mesmo se houver um pico de
  // publicações. A fila impede a repetição depois da virada de 24 horas.
  const rotation = seenTimestampsInRotation(posted);
  return [...posted].some((entry) => {
    if (!entry.startsWith(prefix)) return false;
    const publishedAt = Number(entry.slice(prefix.length));
    return publishedAt >= Date.now() - BLOCK_MS || rotation.has(publishedAt);
  });
}

function migrateLegacyPosted(posted) {
  const now = Date.now();
  const migrated = new Set();
  for (const value of posted) {
    if (value.startsWith("seen:") || value.startsWith("category:")) migrated.add(value);
    else migrated.add(seenKey(value, now));
  }
  return migrated;
}

function compactPosted(posted) {
  const limit = Date.now() - BLOCK_MS;
  const rotation = seenTimestampsInRotation(posted);
  const categoryRotation = recentCategoryEntries(posted);
  return new Set([...posted].filter((entry) => {
    const timestamp = Number(entry.slice(entry.lastIndexOf(":") + 1));
    if (entry.startsWith("seen:")) return timestamp >= limit || rotation.has(timestamp);
    if (entry.startsWith("category:")) return categoryRotation.has(entry);
    return false;
  }));
}

async function getPending() {
  try { return JSON.parse(await readFile(pendingPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Reserva de oferta indisponível; publicação bloqueada: ${error.message}`);
  }
}

async function savePending(reservation) {
  await mkdir(dirname(pendingPath), { recursive: true });
  await writeFile(pendingPath, JSON.stringify(reservation, null, 2));
}

async function clearPending() {
  try { await unlink(pendingPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function offerNameKey(offer) {
  return `name:${String(offer.productName || "").trim().toLocaleLowerCase("pt-BR")}`;
}

function offerNameSignatureKey(offer) {
  // A Shopee pode devolver o mesmo item com pequenas diferenças no título
  // (emoji, "oficial", pontuação, cor etc.). Esta assinatura deliberadamente
  // ignora essas variações para impedir uma cópia quase idêntica por 24h.
  const ignored = new Set(["a", "o", "as", "os", "de", "da", "do", "e", "em", "para", "com", "por", "original", "oficial", "premium", "novo", "nova", "oferta", "promoção", "promocao"]);
  const terms = String(offer.productName || "")
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .split(" ")
    .filter((term) => term.length > 1 && !ignored.has(term))
    .sort();
  return `signature:${terms.join("|")}`;
}

function offerLinkKey(offer) {
  return `link:${createHash("sha256").update(String(offer.offerLink || "")).digest("hex")}`;
}

function offerImageKey(offer) {
  // A mesma oferta pode chegar com título ou ID alternativo; a imagem é uma
  // segunda assinatura independente para barrar esse tipo de repetição.
  const image = String(offer.imageUrl || "").split("?")[0];
  return image ? `image:${createHash("sha256").update(image).digest("hex")}` : null;
}

function matchesFocus(offer, config) {
  const name = String(offer.productName || "").toLocaleLowerCase("pt-BR");
  return config.focusTerms.some((term) => name.includes(term))
    && (!config.requiredTerms.length || config.requiredTerms.some((term) => name.includes(term)))
    && !config.excludedTerms.some((term) => name.includes(term));
}

function categoryKey(offer) {
  const name = String(offer.productName || "").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const categories = [
    ["mochila", ["mochila", "mochla", "backpack"]],
    ["smartwatch", ["smartwatch"]],
    ["relogio", ["relogio", "watch"]],
    ["perfume", ["perfume", "fragancia"]],
    ["smartphone", ["smartphone", "celular"]],
    ["notebook", ["notebook"]],
    ["fone", ["fone"]],
    ["headset", ["headset"]],
    ["caixa_som", ["caixa de som"]],
    ["teclado", ["teclado"]],
    ["mouse", ["mouse"]],
    ["gamer", ["gamer"]],
    ["monitor", ["monitor"]],
    ["armazenamento", ["ssd", "memoria", "cartao de memoria"]],
    ["console", ["console"]],
    ["controle", ["controle", "gamepad"]],
    ["webcam", ["webcam"]],
    ["tablet", ["tablet"]],
    ["tv", ["smart tv", "televisao", "televisão", " tv "]],
    ["air_fryer", ["air fryer"]],
    ["aspirador", ["aspirador"]],
    ["forno_eletrico", ["forno eletrico"]],
    ["liquidificador", ["liquidificador"]],
    ["ventilador", ["ventilador"]],
    ["sanduicheira", ["sanduicheira", "grill eletrico", "grill elétrico"]],
    ["cafeteira", ["cafeteira"]],
    // Carregador portátil, bateria externa e power bank são o mesmo tipo de
    // produto para a rotação. Não podem alternar entre nomes para furar a
    // trava de variedade.
    ["power_bank", ["power bank", "powerbank", "carregador portatil", "carregador portátil", "bateria portatil", "bateria portátil", "bateria externa"]],
    ["soprador", ["soprador", "soprador de ar"]],
    ["energia", ["carregador", "power bank"]],
    ["camiseta", ["camiseta"]],
    ["camisa", ["camisa"]],
    ["moletom", ["moletom"]],
    ["casaco", ["casaco", "jaqueta"]],
    ["blusa", ["blusa"]],
    ["bermuda", ["bermuda"]],
    ["shorts", ["shorts"]],
    ["calca", ["calca"]],
    ["tenis", ["tenis"]],
    ["bone", ["bone"]],
    ["carteira", ["carteira"]],
    ["cinto", ["cinto"]],
    ["bolsa", ["bolsa masculina", "bolsa feminina", "pochete"]],
    ["vestido", ["vestido"]],
    ["lingerie", ["lingerie", "sutia", "calcinha"]],
    ["maquiagem", ["maquiagem", "batom", "base facial", "mascara de cilios"]],
    ["saia", ["saia"]],
    ["chocolate", ["chocolate", "bombom", "bis ", "kitkat", "nutella", "creme de avela", "creme de avelã"]],
    ["biscoito", ["biscoito", "bolacha", "cookie", "traquinas", "passatempo", "oreo"]],
    ["salgadinho", ["salgadinho", "cheetos", "doritos", "lays", "elma chips", "pringles", "batata chips"]],
    ["energetico", ["energetico", "red bull", "monster", "fusion"]],
    // Whey e creatina são suplementos da mesma família editorial. Tratá-los
    // juntos impede que um fique alternando com o outro em ciclos curtos.
    ["suplementos", ["whey", "creatina", "barra de proteina", "barra de proteína", "pre treino", "pré treino"]],
    ["iogurte", ["danone", "iogurte"]],
    ["bebida", ["refrigerante", "suco", "cafe"]],
    ["sabao", ["sabao em po", "sabao em pó", "sabao liquido", "sabão líquido", "omo", "tixan"]],
    ["amaciante", ["amaciante", "comfort", "downy"]],
    ["detergente", ["detergente"]],
    ["desinfetante", ["desinfetante", "agua sanitaria", "água sanitária", "multiuso", "limpeza"]],
  ];
  const found = categories.find(([, terms]) => terms.some((term) => name.includes(term)));
  if (found) return `category:${found[0]}`;
  return null;
}

function hasRecentCategory(posted, category) {
  if (!category) return false;
  return [...recentCategoryEntries(posted)].some((entry) => categoryAliases(category).some((item) => entry.startsWith(`${item}:`)));
}

function categoryAliases(category) {
  // Mantém a nova regra de rotação mesmo para itens gravados antes de duas
  // categorias serem agrupadas em uma família editorial.
  const legacyCategories = {
    "category:fone": ["category:audio"],
    "category:headset": ["category:audio"],
    "category:caixa_som": ["category:audio"],
    "category:smartwatch": ["category:relogio"],
    "category:suplementos": ["category:whey", "category:creatina"],
    "category:power_bank": ["category:energia"],
  };
  return [category, ...(legacyCategories[category] || [])];
}

function recentCategoryEntries(posted) {
  return new Set([...posted]
    .filter((entry) => entry.startsWith("category:"))
    .sort((a, b) => Number(b.slice(b.lastIndexOf(":") + 1)) - Number(a.slice(a.lastIndexOf(":") + 1)))
    .slice(0, CATEGORY_ROTATION_ITEMS));
}

function categoryLastPublishedAt(posted, category) {
  if (!category) return 0;
  const categories = categoryAliases(category);
  return [...posted].reduce((latest, value) => {
    const matched = categories.find((item) => value.startsWith(`${item}:`));
    return matched ? Math.max(latest, Number(value.slice(matched.length + 1)) || 0) : latest;
  }, 0);
}

function offerText(offer) {
  const low = Number(offer.priceMin || offer.priceMax || 0);
  const high = Number(offer.priceMax || 0);
  const price = high && high !== low ? `A partir de ${money(low)}` : `Por ${money(low)}`;
  return [
    `🛍️ ${offer.productName}`,
    "",
    `💥 ${price}`,
    `🛒 Compre aqui 👉 ${offer.offerLink}`,
    "",
    "⚠️ Oferta sujeita à alteração de preço e estoque no site.",
  ].join("\n");
}

async function telegram(config, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`Telegram: ${json.description || "erro desconhecido"}`);
  return json.result;
}

async function postOffer(config, offer) {
  const base = {
    chat_id: config.TELEGRAM_CHAT_ID,
    caption: offerText(offer),
    reply_markup: { inline_keyboard: [[{ text: "🛒 Garantir oferta na Shopee", url: offer.offerLink }]] },
  };
  if (config.TELEGRAM_MESSAGE_THREAD_ID) base.message_thread_id = Number(config.TELEGRAM_MESSAGE_THREAD_ID);
  if (offer.imageUrl) {
    try { return await telegram(config, "sendPhoto", { ...base, photo: offer.imageUrl }); }
    catch (error) { console.warn(`Foto indisponível; enviando texto: ${error.message}`); }
  }
  const textBody = { chat_id: base.chat_id, text: base.caption, disable_web_page_preview: false, reply_markup: base.reply_markup };
  if (base.message_thread_id) textBody.message_thread_id = base.message_thread_id;
  return telegram(config, "sendMessage", textBody);
}

function qualifies(offer, config, posted) {
  const key = String(offer.itemId);
  const commission = Number(offer.commissionRate || 0) * 100;
  const imageKey = offerImageKey(offer);
  const category = categoryKey(offer);
  const price = Number(offer.priceMin || offer.priceMax || 0);
  return key && offer.offerLink && category && matchesFocus(offer, config) && !hasRecentValue(posted, key) && !hasRecentValue(posted, offerNameKey(offer)) && !hasRecentValue(posted, offerNameSignatureKey(offer)) && !hasRecentValue(posted, offerLinkKey(offer)) && (!imageKey || !hasRecentValue(posted, imageKey)) && !hasRecentCategory(posted, category) && price >= config.minPrice
    && Number(offer.priceDiscountRate || 0) >= config.minDiscount && commission >= config.minCommission;
}

// Usa exatamente os mesmos critérios de qualidade e de antirrepetição, mas
// ignora somente a trava editorial de categoria. É acionado apenas se a
// rotação rígida não encontrar nada, evitando que um tópico fique horas sem
// publicar por haver poucas categorias elegíveis naquele momento.
function qualifiesIgnoringCategoryRotation(offer, config, posted) {
  const key = String(offer.itemId);
  const commission = Number(offer.commissionRate || 0) * 100;
  const imageKey = offerImageKey(offer);
  const category = categoryKey(offer);
  const price = Number(offer.priceMin || offer.priceMax || 0);
  return key && offer.offerLink && category && matchesFocus(offer, config) && !hasRecentValue(posted, key) && !hasRecentValue(posted, offerNameKey(offer)) && !hasRecentValue(posted, offerNameSignatureKey(offer)) && !hasRecentValue(posted, offerLinkKey(offer)) && (!imageKey || !hasRecentValue(posted, imageKey)) && price >= config.minPrice
    && Number(offer.priceDiscountRate || 0) >= config.minDiscount && commission >= config.minCommission;
}

function rememberOffer(posted, offer) {
  const publishedAt = Date.now();
  posted.add(seenKey(String(offer.itemId), publishedAt));
  posted.add(seenKey(offerNameKey(offer), publishedAt));
  posted.add(seenKey(offerNameSignatureKey(offer), publishedAt));
  posted.add(seenKey(offerLinkKey(offer), publishedAt));
  const imageKey = offerImageKey(offer);
  if (imageKey) posted.add(seenKey(imageKey, publishedAt));
  const category = categoryKey(offer);
  if (category) {
    posted.add(`${category}:${publishedAt}`);
  }
}

async function selectOffer(config, posted) {
  const candidates = [];
  for (const keyword of config.keywords) {
    try {
      const offers = await getShopeeOffers(config, keyword);
      candidates.push(...offers);
    } catch (error) {
      // Uma resposta temporariamente indisponível da Shopee não deve parar o
      // ciclo inteiro nem gerar uma publicação repetida. As demais buscas
      // continuam normalmente e o próximo ciclo tenta esta palavra de novo.
      console.warn(`Pulando consulta "${keyword}": ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 31_000)); // regra da Shopee sem scrollId
  }
  const distinct = [...new Map(candidates.map((offer) => [String(offer.itemId), offer])).values()];
  let unique = distinct
    .filter((offer) => qualifies(offer, config, posted))
    // Primeiro vem a categoria que está há mais tempo sem aparecer. Só depois
    // usamos o desconto como desempate. Isso impede uma sequência de casacos,
    // fones ou mochilas mesmo quando uma dessas categorias tiver desconto maior.
    .sort((a, b) => {
      const byCategoryAge = categoryLastPublishedAt(posted, categoryKey(a)) - categoryLastPublishedAt(posted, categoryKey(b));
      return byCategoryAge || Number(b.priceDiscountRate || 0) - Number(a.priceDiscountRate || 0);
    });
  if (!unique.length) {
    unique = distinct
      .filter((offer) => qualifiesIgnoringCategoryRotation(offer, config, posted))
      .sort((a, b) => {
        const byCategoryAge = categoryLastPublishedAt(posted, categoryKey(a)) - categoryLastPublishedAt(posted, categoryKey(b));
        return byCategoryAge || Number(b.priceDiscountRate || 0) - Number(a.priceDiscountRate || 0);
      });
    if (unique.length) console.warn("Rotação de categorias esgotada; usando a categoria aprovada há mais tempo sem repetir produto.");
  }
  console.log(`Busca concluída: ${candidates.length} ofertas recebidas, ${distinct.length} distintas e ${unique.length} aprovadas.`);
  return unique[0] || null;
}

async function reserveOffer(config) {
  const pending = await getPending();
  if (pending) {
    // Se uma execução anterior caiu após a reserva, não tentamos reenviar o
    // item: ele já está marcado no histórico. Descartamos apenas a reserva
    // pendente para que o próximo ciclo siga com outra oferta.
    console.warn("Reserva anterior sem confirmação descartada; a oferta continua bloqueada para evitar repetição.");
    await clearPending();
    return false;
  }
  const posted = await getPosted();
  const offer = await selectOffer(config, posted);
  if (!offer) {
    console.log("Nenhuma oferta nova aprovada.");
    return false;
  }
  // A reserva é salva e sincronizada antes de chamar o Telegram.
  // Se qualquer etapa posterior falhar, a oferta continua bloqueada.
  rememberOffer(posted, offer);
  await savePosted(posted);
  await savePending({ offer, reservedAt: new Date().toISOString() });
  console.log(`Reservado: ${offer.productName}`);
  return true;
}

async function publishReservedOffer(config) {
  const pending = await getPending();
  if (!pending?.offer) {
    console.log("Nenhuma oferta reservada para publicar.");
    return false;
  }
  await postOffer(config, pending.offer);
  await clearPending();
  console.log(`Publicado: ${pending.offer.productName}`);
  return true;
}

async function cycle(config) {
  if (await reserveOffer(config)) await publishReservedOffer(config);
}

const config = await loadConfig();
if (process.argv.includes("--reserve")) {
  await reserveOffer(config);
} else if (process.argv.includes("--publish-reserved")) {
  await publishReservedOffer(config);
} else {
  await cycle(config);
}
if (!process.argv.includes("--once") && !process.argv.includes("--reserve") && !process.argv.includes("--publish-reserved")) {
  console.log(`Aguardando ${config.pollMs / 60_000} minutos entre ciclos.`);
  setInterval(() => cycle(config).catch((error) => console.error(error.message)), config.pollMs);
}
