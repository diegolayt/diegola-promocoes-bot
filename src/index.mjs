import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const envPath = join(root, ".env");
const statePath = join(root, "data", "posted.json");

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
    focusTerms: (config.FOCUS_TERMS || "masculino,perfume,fragrância,smartphone,celular,notebook,fone,headset,teclado,mouse,gamer,smartwatch,relógio,monitor,ssd,memória,caixa de som,bluetooth,console,carregador,power bank,blusa").split(",").map((value) => value.trim().toLocaleLowerCase("pt-BR")).filter(Boolean),
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
  return JSON.stringify({ query, operationName: "ProductOffers", variables: { keyword, page: 1, limit: 20 } });
}

async function getShopeeOffers(config, keyword) {
  const payload = payloadFor(keyword);
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
}

async function getPosted() {
  try { return new Set(JSON.parse(await readFile(statePath, "utf8"))); } catch { return new Set(); }
}

async function savePosted(posted) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify([...posted].slice(-2000), null, 2));
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function offerNameKey(offer) {
  return `name:${String(offer.productName || "").trim().toLocaleLowerCase("pt-BR")}`;
}

function matchesFocus(offer, config) {
  const name = String(offer.productName || "").toLocaleLowerCase("pt-BR");
  return config.focusTerms.some((term) => name.includes(term));
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
    ["armazenamento", ["ssd", "memoria"]],
    ["console", ["console"]],
    ["energia", ["carregador", "power bank"]],
    ["camiseta", ["camiseta"]],
    ["camisa", ["camisa"]],
    ["blusa", ["blusa"]],
    ["bermuda", ["bermuda"]],
    ["calca", ["calca"]],
    ["tenis", ["tenis"]],
    ["bone", ["bone"]],
    ["carteira", ["carteira"]],
  ];
  const found = categories.find(([, terms]) => terms.some((term) => name.includes(term)));
  if (found) return `category:${found[0]}`;
  return null;
}

function hasRecentCategory(posted, category) {
  if (!category) return false;
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  return [...posted].some((value) => value.startsWith(`${category}:`) && Number(value.slice(category.length + 1)) >= limit);
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
  return key && offer.offerLink && matchesFocus(offer, config) && !posted.has(key) && !posted.has(offerNameKey(offer)) && !hasRecentCategory(posted, categoryKey(offer)) && Number(offer.priceMin || offer.priceMax) > 0
    && Number(offer.priceDiscountRate || 0) >= config.minDiscount && commission >= config.minCommission;
}

async function cycle(config) {
  const posted = await getPosted();
  const candidates = [];
  for (const keyword of config.keywords) {
    const offers = await getShopeeOffers(config, keyword);
    candidates.push(...offers);
    await new Promise((resolve) => setTimeout(resolve, 31_000)); // regra da Shopee sem scrollId
  }
  const unique = [...new Map(candidates.map((offer) => [String(offer.itemId), offer])).values()]
    .filter((offer) => qualifies(offer, config, posted))
    .sort((a, b) => Number(b.priceDiscountRate || 0) - Number(a.priceDiscountRate || 0));
  for (const offer of unique.slice(0, config.postsPerCycle)) {
    await postOffer(config, offer);
    posted.add(String(offer.itemId));
    posted.add(offerNameKey(offer));
    const category = categoryKey(offer);
    if (category) {
      for (const value of posted) if (value.startsWith(`${category}:`)) posted.delete(value);
      posted.add(`${category}:${Date.now()}`);
    }
    console.log(`Publicado: ${offer.productName}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await savePosted(posted);
  console.log(`${Math.min(unique.length, config.postsPerCycle)} oferta(s) publicada(s).`);
}

const config = await loadConfig();
await cycle(config);
if (!process.argv.includes("--once")) {
  console.log(`Aguardando ${config.pollMs / 60_000} minutos entre ciclos.`);
  setInterval(() => cycle(config).catch((error) => console.error(error.message)), config.pollMs);
}
