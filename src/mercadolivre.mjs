import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(root, "data", "posted.mercadolivre.json");
const backupPath = join(root, "data", "posted.mercadolivre.backup.json");
const pendingPath = join(root, "data", "pending.mercadolivre.json");
const authPath = join(root, "data", "mercadolivre-auth.json");
const feedPath = join(root, "data", "feed.mercadolivre.json");
const showcasePath = join(root, "data", "vitrine.mercadolivre.json");
const couponsPath = join(root, "data", "cupons.json");
const FEED_ITEMS = 300;
// Com 96 publicações por dia, 600 itens dão cerca de seis dias sem repetir.
const ROTATION_ITEMS = 600;
const SLOT_MS = 15 * 60_000;
const CATEGORY_ROTATION_ITEMS = 12;
const MAX_API_CALLS = 28;
const MIN_REQUEST_INTERVAL_MS = 750;
const CATEGORIES_PER_RUN = 4;
const HIGHLIGHTS_PER_CATEGORY = 2;
// A vitrine do site consulta muito mais que uma rodada normal, então roda com
// um teto próprio, mais devagar e esperando quando a API pede para esperar.
const SHOWCASE_MAX_CALLS = 750;
const SHOWCASE_SAMPLE = 6;
const SHOWCASE_PER_CATEGORY = 4;
let maxApiCalls = MAX_API_CALLS;
let requestIntervalMs = MIN_REQUEST_INTERVAL_MS;
let showcaseMode = false;
let apiCalls = 0;
let lastApiCallAt = 0;

class ApiLimitError extends Error {}

// Categorias-folha com ranking oficial de mais vendidos. O endpoint /search
// não é liberado para esta aplicação; /highlights é o recurso oficial feito
// justamente para obter os 20 campeões de venda por categoria.
// O terceiro valor é o preço mínimo: nas categorias que misturam produto e
// acessório, ele deixa passar o produto e barra capinha, cabo e peça.
// A ordem intercala os assuntos para o grupo não receber quatro ofertas
// parecidas em sequência.
const searches = [
  ["celular", "MLB1055", 400], ["televisão", "MLB1002", 700], ["monitor", "MLB99245", 350],
  ["console", "MLB11172", 300], ["tablet", "MLB99889", 350], ["áudio", "MLB3843", 60],
  ["periférico", "MLB1714", 50], ["eletrodoméstico", "MLB456045", 80],
  ["eletrodoméstico", "MLB9188", 80], ["eletrodoméstico", "MLB31683", 80],
  ["ferramenta", "MLB189007", 60], ["masculino", "MLB23332", 40],
  ["perfume", "MLB6284", 60], ["relógio", "MLB26426", 60], ["casa", "MLB107564", 40],
  ["jogos", "MLB186456", 80], ["notebook", "MLB430687", 900], ["cozinha", "MLB1618", 50],
  ["smartwatch", "MLB417704", 100], ["climatização", "MLB252358", 120], ["suplemento", "MLB438178", 50],
  ["componente", "MLB1712", 150], ["refrigeração", "MLB1576", 500], ["calçado", "MLB23262", 80],
  ["armazenamento", "MLB430598", 100], ["lavadora", "MLB438282", 400], ["cabelo", "MLB1263", 40],
  ["computador", "MLB430637", 900], ["fogão", "MLB1580", 250], ["móveis", "MLB436380", 150],
  ["som", "MLB3835", 80], ["cuidado pessoal", "MLB439347", 60], ["colchão", "MLB438928", 200],
  ["redes", "MLB1700", 80], ["projetor", "MLB2830", 200], ["pele", "MLB199407", 40],
  ["impressão", "MLB5875", 300], ["ferramenta elétrica", "MLB2526", 120], ["fitness", "MLB1338", 80],
  ["streaming", "MLB133950", 150], ["purificador", "MLB21171", 150], ["barbearia", "MLB264787", 60],
  ["drone", "MLB264065", 250], ["iluminação", "MLB1582", 50], ["ciclismo", "MLB1292", 100],
  ["segurança", "MLB7069", 80], ["livros", "MLB437616", 25], ["natal", "MLB117798", 40],
  ["brinquedos", "MLB1132", 50], ["maquiagem", "MLB1248", 40], ["jogos de tabuleiro", "MLB432988", 50],
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta o segredo ${name}.`);
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// O histórico novo guarda só o começo de cada hash para o arquivo não crescer
// com a janela maior; os registros antigos, completos, continuam valendo.
const HASH_CHARS = 16;
function sameHash(saved, full) {
  return Boolean(saved) && String(saved).slice(0, HASH_CHARS) === full.slice(0, HASH_CHARS);
}

async function loadHistory(path = statePath) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (path === statePath) {
      try { return JSON.parse(await readFile(backupPath, "utf8")); }
      catch (backupError) {
        if (error.code === "ENOENT" && backupError.code === "ENOENT") return [];
      }
    }
    throw new Error(`Histórico do Mercado Livre indisponível: ${error.message}`);
  }
}

async function saveHistory(history) {
  await mkdir(dirname(statePath), { recursive: true });
  const contents = JSON.stringify(history.slice(-ROTATION_ITEMS), null, 2);
  await Promise.all([writeFile(statePath, contents), writeFile(backupPath, contents)]);
}

async function getPending() {
  try { return JSON.parse(await readFile(pendingPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function clearPending() {
  try { await unlink(pendingPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function cryptKey() {
  return createHash("sha256").update(required("MERCADOLIVRE_CLIENT_SECRET")).digest();
}

async function readAuth() {
  try {
    const saved = JSON.parse(await readFile(authPath, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", cryptKey(), Buffer.from(saved.iv, "base64"));
    decipher.setAuthTag(Buffer.from(saved.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, "base64")), decipher.final()]).toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Credencial renovável do Mercado Livre inválida: ${error.message}`);
  }
}

async function writeAuth(auth) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(auth)), cipher.final()]);
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") }, null, 2));
}

async function exchangeToken(parameters) {
  const body = new URLSearchParams({ client_id: required("MERCADOLIVRE_CLIENT_ID"), client_secret: required("MERCADOLIVRE_CLIENT_SECRET"), ...parameters });
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw new Error(`Autenticação do Mercado Livre falhou (HTTP ${response.status}): ${json.message || json.error || "resposta inválida"}`);
  return { ...json, expiresAt: Date.now() + Number(json.expires_in || 21600) * 1000 };
}

async function getAccessToken() {
  let auth = await readAuth();
  if (auth?.access_token && Number(auth.expiresAt) > Date.now() + 5 * 60_000) return auth.access_token;
  if (auth?.refresh_token) {
    auth = await exchangeToken({ grant_type: "refresh_token", refresh_token: auth.refresh_token });
  } else {
    const code = required("MERCADOLIVRE_AUTH_CODE");
    auth = await exchangeToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://github.com/diegolayt/diegola-promocoes-bot",
    });
  }
  await writeAuth(auth);
  return auth.access_token;
}

async function apiGet(token, path, attempt = 0) {
  if (apiCalls >= maxApiCalls) throw new ApiLimitError("Limite seguro de consultas desta rodada atingido.");
  const wait = Math.max(0, requestIntervalMs - (Date.now() - lastApiCallAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  apiCalls += 1;
  lastApiCallAt = Date.now();
  const response = await fetch(`https://api.mercadolibre.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = await response.json();
  if (response.status === 429 && showcaseMode && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 30_000 * (attempt + 1)));
    return apiGet(token, path, attempt + 1);
  }
  // Na vitrine o token nunca é renovado; se vencer no meio, para e salva o que tem.
  if (response.status === 401 && showcaseMode) throw new ApiLimitError("O token venceu durante a vitrine.");
  if (response.status === 429) throw new ApiLimitError(`${path} atingiu o limite temporário da API do Mercado Livre.`);
  if (!response.ok) throw new Error(`${path} falhou (HTTP ${response.status}): ${json.message || "resposta inválida"}`);
  return json;
}

async function resolveHighlight(token, highlight, category) {
  let raw;
  if (highlight.type === "ITEM") {
    raw = await apiGet(token, `/items/${encodeURIComponent(highlight.id)}`);
  } else if (highlight.type === "PRODUCT") {
    const product = await apiGet(token, `/products/${encodeURIComponent(highlight.id)}`);
    raw = product.buy_box_winner;
    // Algumas páginas de catálogo não têm uma oferta vencedora com preço.
    // Busca uma oferta ativa, mas somente dentro do pequeno lote espaçado da
    // rodada para não atingir novamente o limite da API.
    if (!raw || !Number.isFinite(Number(raw.price)) || Number(raw.price) <= 0) {
      const offers = await apiGet(token, `/products/${encodeURIComponent(product.id)}/items?status=active`);
      const rows = offers.results || offers.items || [];
      raw = rows
        .filter((entry) => Number.isFinite(Number(entry.price)) && Number(entry.price) > 0)
        .sort((a, b) => Number(b.sold_quantity || 0) - Number(a.sold_quantity || 0))[0];
    }
    if (!raw) return null;
    raw.catalog_product_id ||= product.id;
    raw.title ||= product.name;
    raw.thumbnail ||= product.pictures?.[0]?.url;
    raw.permalink ||= product.permalink || `https://www.mercadolivre.com.br/p/${product.id}`;
  } else {
    return null;
  }
  return {
    ...raw,
    id: raw.item_id || raw.id,
    title: raw.title || raw.name,
    permalink: raw.permalink || `https://produto.mercadolivre.com.br/${String(raw.item_id || raw.id).replace(/^MLB/, "MLB-")}`,
    sold_quantity: raw.sold_quantity || Math.max(1, 21 - Number(highlight.position || 20)) * 100,
    rotationCategory: category,
  };
}

function broadCategory(value) {
  const title = normalizedTitle(value);
  const groups = [
    ["celular", /celular|smartphone|iphone|galaxy|xiaomi|motorola/],
    ["computador", /notebook|computador|monitor|teclado|mouse|webcam|impressora/],
    ["áudio", /fone|headset|caixa de som|soundbar|microfone|alto falante/],
    ["tv", /televisao|smart tv|projetor/],
    ["games", /videogame|console|playstation|xbox|nintendo|controle gamer/],
    ["eletrodoméstico", /air fryer|fritadeira|geladeira|microondas|forno|liquidificador|cafeteira|aspirador|ventilador|ar condicionado|sanduicheira/],
    ["moda", /camisa|camiseta|calca|tenis|sapato|jaqueta|moletom|bermuda|vestido/],
    ["beleza", /perfume|cosmetico|maquiagem|barbeador|secador/],
    ["casa", /cadeira|mesa|colchao|cozinha|banheiro|torneira|ferramenta/],
    ["esporte", /academia|fitness|bicicleta|futebol|corrida|whey|creatina/],
  ];
  return groups.find(([, regex]) => regex.test(title))?.[0] || `outros:${title.split(" ").slice(0, 2).join("-")}`;
}

async function searchTrendingProducts(token, history) {
  const trends = await apiGet(token, "/trends/MLB");
  const desired = Array.isArray(trends) ? trends.slice(10, 30) : [];
  const offset = history.length % Math.max(1, desired.length);
  const wanted = [...desired.slice(offset), ...desired.slice(0, offset)].slice(0, 2);
  const resolved = [];
  for (const trend of wanted) {
    try {
      const found = await apiGet(token, `/products/search?status=active&site_id=MLB&limit=1&q=${encodeURIComponent(trend.keyword)}`);
      for (const product of (found.results || []).slice(0, 1)) {
        const item = await resolveHighlight(token, { id: product.id, type: "PRODUCT", position: 20 }, broadCategory(product.name || trend.keyword));
        if (item) resolved.push({ ...item, trendRank: true });
      }
    } catch (error) {
      if (error instanceof ApiLimitError) throw error;
      console.warn(`Tendência ${trend.keyword} ignorada: ${error.message}`);
    }
  }
  return resolved;
}

async function searchProducts(token, categoryId, category, history, sampleOffset = 0, minPrice = 19.99) {
  const ranking = await apiGet(token, `/highlights/MLB/category/${categoryId}`);
  const resolved = [];
  const recent = history.slice(-ROTATION_ITEMS);
  const content = (ranking.content || []).filter((highlight) => {
    const key = fingerprint(highlight.id);
    return !recent.some((entry) => sameHash(entry.productKey, key) || entry.itemId === highlight.id);
  });
  const offset = content.length ? sampleOffset % content.length : 0;
  const sample = [...content.slice(offset), ...content.slice(0, offset)].slice(0, HIGHLIGHTS_PER_CATEGORY);
  for (const highlight of sample) {
    try {
      const item = await resolveHighlight(token, highlight, category);
      if (item) resolved.push({ ...item, sourceCategoryId: categoryId, minPrice });
    } catch (error) {
      if (error instanceof ApiLimitError) throw error;
      console.warn(`Ignorando ${highlight.id}: ${error.message}`);
    }
  }
  return resolved;
}

function affiliateUrl(permalink) {
  const url = new URL(permalink);
  url.searchParams.set("matt_word", required("MERCADOLIVRE_MATT_WORD"));
  url.searchParams.set("matt_tool", required("MERCADOLIVRE_MATT_TOOL"));
  return url.toString();
}

function productKey(item) {
  return fingerprint(item.catalog_product_id || item.id || item.permalink);
}

function normalizedTitle(title) {
  return String(title || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(kit|novo|original|of0|unidade|unidades|cor|cores)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function rejectionReason(item, history, enforceCategorySpacing = true) {
  const price = Number(item.price);
  if (!item.id || !item.permalink || !item.title) return "dados incompletos";
  if (!Number.isFinite(price) || price < 19.99) return "preco invalido";
  if (price < Number(item.minPrice || 0)) return "abaixo do preco minimo da categoria";
  const title = normalizedTitle(item.title);
  if (/replica|inspirado|primeira linha|1 1|mochila|bolsa|backpack/.test(title) && item.rotationCategory !== "masculino") return "termo bloqueado";
  const recent = history.slice(-ROTATION_ITEMS);
  const key = productKey(item);
  if (recent.some((entry) => sameHash(entry.productKey, key) || entry.itemId === item.id)) return "produto publicado recentemente";
  const titleHash = fingerprint(title);
  if (recent.some((entry) => sameHash(entry.titleHash, titleHash))) return "titulo publicado recentemente";
  if (enforceCategorySpacing && history.slice(-CATEGORY_ROTATION_ITEMS).some((entry) => entry.category === item.rotationCategory)) return "categoria recente";
  return null;
}

function approvedProducts(items, history, enforceCategorySpacing = true) {
  return items
    .filter((item) => !rejectionReason(item, history, enforceCategorySpacing))
    .sort((a, b) => score(b) - score(a));
}

function score(item) {
  const sold = Number(item.sold_quantity || 0);
  const price = Number(item.price || 0);
  const original = Number(item.original_price || 0);
  const discount = original > price ? (original - price) / original : 0;
  // Entre os mais vendidos, quem está com desconto de verdade passa na frente:
  // 20% de desconto pesa tanto quanto ser de loja oficial e ter frete grátis
  // juntos. Tendências entram como segunda fonte.
  return Math.log10(sold + 1) * 15 + discount * 200 + (item.official_store_id ? 20 : 0) + (item.shipping?.free_shipping ? 8 : 0) - (item.trendRank ? 15 : 0);
}

async function selectProduct(history) {
  apiCalls = 0;
  lastApiCallAt = 0;
  const token = await getAccessToken();
  // O ponto de partida avança com o relógio, não com a última publicação.
  // Antes, quando as categorias seguintes à última publicada não tinham nada
  // novo, toda rodada consultava as mesmas e falhava por horas seguidas.
  const offset = (Math.floor(Date.now() / SLOT_MS) * CATEGORIES_PER_RUN) % searches.length;
  const ordered = [...searches.slice(offset), ...searches.slice(0, offset)];
  const candidates = [];
  let distinct = [];
  let available = [];
  for (const [index, [category, categoryId, minPrice]] of ordered.entries()) {
    // Depois do lote normal, só continua enquanto não houver aprovado e ainda
    // sobrar folga no limite de consultas da rodada.
    if (index >= CATEGORIES_PER_RUN && (available.length || apiCalls > MAX_API_CALLS - 6)) break;
    const visits = history.filter((entry) =>
      entry.sourceCategoryId ? entry.sourceCategoryId === categoryId : entry.category === category
    ).length;
    try {
      candidates.push(...await searchProducts(token, categoryId, category, history, visits * HIGHLIGHTS_PER_CATEGORY, minPrice));
    } catch (error) {
      console.warn(error.message);
      if (error instanceof ApiLimitError) break;
    }
    distinct = [...new Map(candidates.map((item) => [item.catalog_product_id || item.id, item])).values()];
    available = approvedProducts(distinct, history);
  }
  if (!available.length && apiCalls < MAX_API_CALLS - 4) {
    try { candidates.push(...await searchTrendingProducts(token, history)); }
    catch (error) { console.warn(`Tendências indisponíveis: ${error.message}`); }
    distinct = [...new Map(candidates.map((item) => [item.catalog_product_id || item.id, item])).values()];
    available = approvedProducts(distinct, history);
  }
  // A identidade e o título continuam bloqueados por 200 publicações. Somente
  // o espaçamento de categoria é relaxado quando ele, sozinho, impedir toda a
  // rodada; assim o bot não para e nunca repete o mesmo produto nesse ciclo.
  if (!available.length) available = approvedProducts(distinct, history, false);
  if (!available.length && distinct.length) {
    const reasons = distinct.reduce((counts, item) => {
      const reason = rejectionReason(item, history, false) || "aprovado";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    console.warn(`Rejeicoes do Mercado Livre: ${JSON.stringify(reasons)}.`);
  }
  console.log(`Mercado Livre: ${apiCalls} consultas, ${candidates.length} resultados, ${distinct.length} produtos distintos e ${available.length} aprovados.`);
  return available[0] || null;
}

// Cupons válidos agora. O arquivo é mantido a partir dos canais oficiais do
// programa de afiliados; o site lê o mesmo arquivo.
const TICKET = String.fromCodePoint(0x1F39F, 0xFE0F);
const NL = String.fromCharCode(10);

async function loadCoupons() {
  try {
    const now = Date.now();
    return JSON.parse(await readFile(couponsPath, "utf8")).filter((c) => c?.loja === "mercadolivre" && c.codigo && c.descricao
      && (!c.inicio || Date.parse(c.inicio) <= now) && (!c.fim || Date.parse(c.fim) > now));
  } catch { return []; }
}

// Cupom que vale para este produto: mesma categoria de origem e preço mínimo.
function couponFor(item, coupons) {
  return coupons.find((c) => !c.soLista && (c.fontes || []).includes(item.rotationCategory) && Number(item.price) >= Number(c.precoMinimo || 0)) || null;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function money(value) {
  return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function postToTelegram(item) {
  const link = affiliateUrl(item.permalink);
  const original = Number(item.original_price || 0);
  const price = Number(item.price || 0);
  const discount = original > price ? Math.round((1 - price / original) * 100) : 0;
  const coupon = couponFor(item, await loadCoupons());
  const lines = [
    `🟡 <b>${String(item.title).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</b>`,
    "",
    original > price ? `De <s>${money(original)}</s> por <b>${money(price)}</b>${discount ? ` (${discount}% OFF)` : ""}` : `💥 Por <b>${money(price)}</b>`,
    item.shipping?.free_shipping ? "🚚 Frete grátis" : "",
    coupon ? `${TICKET} Cupom <code>${escapeHtml(coupon.codigo)}</code>: ${escapeHtml(coupon.descricao)}` : "",
    `🛒 <a href="${link.replace(/&/g, "&amp;")}">Compre aqui pelo Mercado Livre</a>`,
    "",
    "⚠️ Preço e estoque podem mudar no site.",
  ].filter((line, index, all) => line || (index && all[index - 1]));
  const payload = {
    chat_id: required("TELEGRAM_CHAT_ID"),
    message_thread_id: Number(process.env.TELEGRAM_MESSAGE_THREAD_ID || 960130),
    parse_mode: "HTML",
    caption: lines.join("\n"),
    photo: String(item.thumbnail || "").replace(/-I\.(jpg|webp)$/i, "-O.$1"),
    reply_markup: { inline_keyboard: [[{ text: "🛒 Ver oferta no Mercado Livre", url: link }]] },
  };
  let response = await fetch(`https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/sendPhoto`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) {
    delete payload.photo;
    payload.text = payload.caption;
    delete payload.caption;
    response = await fetch(`https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
  }
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(`Telegram recusou a publicação: ${json.description || response.status}`);
}

// O site de ofertas lê este arquivo, com o link de afiliado já montado.
function feedEntry(item) {
  const price = Number(item.price || 0);
  const original = Number(item.original_price || 0);
  return {
    id: `mercadolivre-${item.id}`,
    loja: "mercadolivre",
    titulo: String(item.title || "").replace(/\s+/g, " ").trim(),
    imagem: String(item.thumbnail || "").replace(/^http:/, "https:").replace(/-I\.(jpg|webp)$/i, "-O.$1") || null,
    preco: price,
    precoDe: original > price ? original : null,
    link: affiliateUrl(item.permalink),
    freteGratis: Boolean(item.shipping?.free_shipping),
    lojaOficial: Boolean(item.official_store_id),
    nota: Number(item.ratingAverage || 0) || null,
    fonte: item.rotationCategory || null,
    publicadoEm: new Date().toISOString(),
  };
}

async function appendFeed(item) {
  const entry = feedEntry(item);
  let feed = [];
  try { feed = JSON.parse(await readFile(feedPath, "utf8")); } catch { /* primeiro registro ou arquivo inválido: recomeça */ }
  if (!Array.isArray(feed)) feed = [];
  feed = [entry, ...feed.filter((existing) => existing.id !== entry.id)].slice(0, FEED_ITEMS);
  await writeFile(feedPath, JSON.stringify(feed, null, 1));
}

async function reserve() {
  if (await getPending()) {
    console.warn("Reserva anterior descartada sem liberar o produto, evitando duplicidade.");
    await clearPending();
    return false;
  }
  const history = await loadHistory();
  const item = await selectProduct(history);
  if (!item) throw new Error("Nenhum produto novo aprovado nesta rodada.");
  history.push({ itemId: item.id, productKey: productKey(item).slice(0, HASH_CHARS), titleHash: fingerprint(normalizedTitle(item.title)).slice(0, HASH_CHARS), category: item.rotationCategory, sourceCategoryId: item.sourceCategoryId || null, reservedAt: new Date().toISOString() });
  await saveHistory(history);
  await writeFile(pendingPath, JSON.stringify({ item, reservedAt: new Date().toISOString() }, null, 2));
  console.log(`Reservado Mercado Livre: ${item.id} (${item.rotationCategory}).`);
  return true;
}

async function publishReserved() {
  const pending = await getPending();
  if (!pending?.item) return console.log("Nenhuma oferta do Mercado Livre reservada."), false;
  await postToTelegram(pending.item);
  // A publicação no Telegram já aconteceu; uma falha no feed do site não
  // pode derrubar a rodada nem deixar a reserva presa.
  try { await appendFeed(pending.item); } catch (error) { console.warn(`Feed do site não atualizado: ${error.message}`); }
  await clearPending();
  console.log(`Publicado Mercado Livre: ${pending.item.id}.`);
  return true;
}

// Vitrine do site: os melhores de cada categoria (mais vendidos com desconto
// real ou de loja oficial), gravados em um arquivo que o site lê. Não publica
// nada no Telegram e não mexe no histórico de publicações.
async function buildShowcase() {
  // Só usa um token ainda válido. Renovar aqui poderia invalidar o token que a
  // rodada de publicação está usando ao mesmo tempo.
  const auth = await readAuth();
  if (!auth?.access_token || Number(auth.expiresAt) < Date.now() + 20 * 60_000) {
    console.log("Token do Mercado Livre perto de vencer; a vitrine fica para a próxima execução.");
    return;
  }
  const token = auth.access_token;
  apiCalls = 0;
  lastApiCallAt = 0;
  maxApiCalls = SHOWCASE_MAX_CALLS;
  requestIntervalMs = Number(process.env.ML_SHOWCASE_INTERVAL_MS || 1_000);
  showcaseMode = true;
  const picks = new Map();
  try {
    for (const [category, categoryId, minPrice] of searches) {
      let ranking;
      try { ranking = await apiGet(token, `/highlights/MLB/category/${categoryId}`); }
      catch (error) {
        if (error instanceof ApiLimitError) throw error;
        console.warn(`${category}: ${error.message}`);
        continue;
      }
      const resolved = [];
      for (const highlight of (ranking.content || []).slice(0, SHOWCASE_SAMPLE)) {
        try {
          const item = await resolveHighlight(token, highlight, category);
          if (item) resolved.push({ ...item, minPrice });
        } catch (error) {
          if (error instanceof ApiLimitError) throw error;
        }
      }
      const good = resolved
        .filter((item) => !rejectionReason(item, [], false))
        .filter((item) => Number(item.original_price || 0) > Number(item.price) * 1.05 || item.official_store_id)
        .sort((a, b) => score(b) - score(a))
        .slice(0, SHOWCASE_PER_CATEGORY);
      for (const item of good) {
        try {
          const reviews = await apiGet(token, `/reviews/item/${encodeURIComponent(item.id)}`);
          item.ratingAverage = reviews.rating_average;
        } catch (error) {
          if (error instanceof ApiLimitError) throw error;
        }
        // Com avaliação conhecida e ruim, fica de fora; sem avaliação, entra pelo resto.
        if (!item.ratingAverage || item.ratingAverage >= 4.3) picks.set(item.catalog_product_id || item.id, item);
      }
      console.log(`${category}: ${resolved.length} consultados, ${good.length} aprovados.`);
    }
  } catch (error) {
    if (!(error instanceof ApiLimitError)) throw error;
    console.warn(`Vitrine parcial: ${error.message}`);
  }
  console.log(`Vitrine do Mercado Livre: ${apiCalls} consultas, ${picks.size} produtos.`);
  // Uma execução fraca não apaga a vitrine anterior.
  if (picks.size < 20) return;
  await mkdir(dirname(showcasePath), { recursive: true });
  await writeFile(showcasePath, JSON.stringify([...picks.values()].map(feedEntry), null, 1));
}

// Resumo dos cupons válidos, publicado no tópico algumas vezes por dia.
async function postCouponDigest() {
  const coupons = await loadCoupons();
  if (!coupons.length) return console.log("Nenhum cupom válido para divulgar.");
  const blocks = coupons.map((c) => [
    `${TICKET} <code>${escapeHtml(c.codigo)}</code> · <b>${escapeHtml(c.descricao)}</b>`,
    c.regra ? escapeHtml(c.regra) : "",
    c.link ? `<a href="${String(c.link).replace(/&/g, "&amp;")}">Ver produtos</a>` : "",
  ].filter(Boolean).join(NL));
  const text = [`<b>${TICKET} Cupons do Mercado Livre válidos hoje</b>`, "Toque no código para copiar e use no fechamento da compra.", "", blocks.join(NL + NL)].join(NL);
  const response = await fetch(`https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: required("TELEGRAM_CHAT_ID"), message_thread_id: Number(process.env.TELEGRAM_MESSAGE_THREAD_ID || 960130), parse_mode: "HTML", text, disable_web_page_preview: true }),
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(`Telegram recusou os cupons: ${json.description || response.status}`);
  console.log(`Cupons divulgados: ${coupons.length}.`);
}

if (process.argv.includes("--cupons")) await postCouponDigest();
else if (process.argv.includes("--vitrine")) await buildShowcase();
else if (process.argv.includes("--reserve")) await reserve();
else if (process.argv.includes("--publish-reserved")) await publishReserved();
else if (await reserve()) await publishReserved();
