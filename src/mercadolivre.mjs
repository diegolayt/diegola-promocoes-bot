import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(root, "data", "posted.mercadolivre.json");
const backupPath = join(root, "data", "posted.mercadolivre.backup.json");
const pendingPath = join(root, "data", "pending.mercadolivre.json");
const authPath = join(root, "data", "mercadolivre-auth.json");
const ROTATION_ITEMS = 200;
const CATEGORY_ROTATION_ITEMS = 12;

// Categorias-folha com ranking oficial de mais vendidos. O endpoint /search
// não é liberado para esta aplicação; /highlights é o recurso oficial feito
// justamente para obter os 20 campeões de venda por categoria.
const searches = [
  ["celular", "MLB1055"], ["televisão", "MLB1002"], ["monitor", "MLB99245"],
  ["console", "MLB11172"], ["tablet", "MLB99889"], ["áudio", "MLB3843"],
  ["periférico", "MLB1714"], ["eletrodoméstico", "MLB456045"],
  ["eletrodoméstico", "MLB9188"], ["eletrodoméstico", "MLB31683"],
  ["ferramenta", "MLB189007"], ["masculino", "MLB23332"],
  ["perfume", "MLB6284"], ["relógio", "MLB26426"], ["casa", "MLB107564"],
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta o segredo ${name}.`);
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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

async function apiGet(token, path) {
  const response = await fetch(`https://api.mercadolibre.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = await response.json();
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
    // Rankings podem devolver uma página de catálogo sem preço. Nesse caso,
    // seleciona uma oferta ativa e nunca publica um valor fictício de R$ 0,00.
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
  const wanted = [...desired.slice(offset), ...desired.slice(0, offset)].slice(0, 8);
  const resolved = [];
  for (const trend of wanted) {
    try {
      const found = await apiGet(token, `/products/search?status=active&site_id=MLB&limit=3&q=${encodeURIComponent(trend.keyword)}`);
      for (const product of (found.results || []).slice(0, 3)) {
        const item = await resolveHighlight(token, { id: product.id, type: "PRODUCT", position: 20 }, broadCategory(product.name || trend.keyword));
        if (item) resolved.push({ ...item, trendRank: true });
      }
    } catch (error) {
      console.warn(`Tendência ${trend.keyword} ignorada: ${error.message}`);
    }
  }
  return resolved;
}

async function searchProducts(token, categoryId, category) {
  const ranking = await apiGet(token, `/highlights/MLB/category/${categoryId}`);
  const resolved = [];
  for (const highlight of (ranking.content || []).slice(0, 20)) {
    try {
      const item = await resolveHighlight(token, highlight, category);
      if (item) resolved.push(item);
    } catch (error) {
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

function isEligible(item, history) {
  const price = Number(item.price);
  if (!item.id || !item.permalink || !item.title || !Number.isFinite(price) || price < 19.99) return false;
  const title = normalizedTitle(item.title);
  if (/replica|inspirado|primeira linha|1 1|mochila|bolsa|backpack/.test(title) && item.rotationCategory !== "masculino") return false;
  const recent = history.slice(-ROTATION_ITEMS);
  const key = productKey(item);
  if (recent.some((entry) => entry.productKey === key || entry.itemId === item.id)) return false;
  const titleHash = fingerprint(title);
  if (recent.some((entry) => entry.titleHash === titleHash)) return false;
  if (history.slice(-CATEGORY_ROTATION_ITEMS).some((entry) => entry.category === item.rotationCategory)) return false;
  return true;
}

function score(item) {
  const sold = Number(item.sold_quantity || 0);
  const price = Number(item.price || 0);
  const original = Number(item.original_price || 0);
  const discount = original > price ? (original - price) / original : 0;
  // Mais vendidos têm prioridade; tendências entram como segunda fonte.
  return Math.log10(sold + 1) * 25 + discount * 100 + (item.official_store_id ? 20 : 0) + (item.shipping?.free_shipping ? 8 : 0) - (item.trendRank ? 15 : 0);
}

async function selectProduct(history) {
  const token = await getAccessToken();
  const offset = history.length % searches.length;
  const ordered = [...searches.slice(offset), ...searches.slice(0, offset)];
  const candidates = [];
  for (const [category, categoryId] of ordered) {
    try { candidates.push(...await searchProducts(token, categoryId, category)); }
    catch (error) { console.warn(error.message); }
  }
  try { candidates.push(...await searchTrendingProducts(token, history)); }
  catch (error) { console.warn(`Tendências indisponíveis: ${error.message}`); }
  const distinct = [...new Map(candidates.map((item) => [item.catalog_product_id || item.id, item])).values()];
  const available = distinct.filter((item) => isEligible(item, history)).sort((a, b) => score(b) - score(a));
  console.log(`Mercado Livre: ${candidates.length} resultados, ${distinct.length} produtos distintos e ${available.length} aprovados.`);
  return available[0] || null;
}

function money(value) {
  return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function postToTelegram(item) {
  const link = affiliateUrl(item.permalink);
  const original = Number(item.original_price || 0);
  const price = Number(item.price || 0);
  const discount = original > price ? Math.round((1 - price / original) * 100) : 0;
  const lines = [
    `🟡 <b>${String(item.title).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</b>`,
    "",
    original > price ? `De <s>${money(original)}</s> por <b>${money(price)}</b>${discount ? ` (${discount}% OFF)` : ""}` : `💥 Por <b>${money(price)}</b>`,
    item.shipping?.free_shipping ? "🚚 Frete grátis" : "",
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

async function reserve() {
  if (await getPending()) {
    console.warn("Reserva anterior descartada sem liberar o produto, evitando duplicidade.");
    await clearPending();
    return false;
  }
  const history = await loadHistory();
  const item = await selectProduct(history);
  if (!item) throw new Error("Nenhum produto novo aprovado nesta rodada.");
  history.push({ itemId: item.id, productKey: productKey(item), titleHash: fingerprint(normalizedTitle(item.title)), category: item.rotationCategory, reservedAt: new Date().toISOString() });
  await saveHistory(history);
  await writeFile(pendingPath, JSON.stringify({ item, reservedAt: new Date().toISOString() }, null, 2));
  console.log(`Reservado Mercado Livre: ${item.id} (${item.rotationCategory}).`);
  return true;
}

async function publishReserved() {
  const pending = await getPending();
  if (!pending?.item) return console.log("Nenhuma oferta do Mercado Livre reservada."), false;
  await postToTelegram(pending.item);
  await clearPending();
  console.log(`Publicado Mercado Livre: ${pending.item.id}.`);
  return true;
}

if (process.argv.includes("--reserve")) await reserve();
else if (process.argv.includes("--publish-reserved")) await publishReserved();
else if (await reserve()) await publishReserved();
