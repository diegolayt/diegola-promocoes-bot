import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(root, "data", "posted.mercadolivre.json");
const backupPath = join(root, "data", "posted.mercadolivre.backup.json");
const pendingPath = join(root, "data", "pending.mercadolivre.json");
const ROTATION_ITEMS = 200;
const CATEGORY_ROTATION_ITEMS = 8;

const searches = [
  ["celular", "celular smartphone"], ["notebook", "notebook"], ["televisão", "smart tv"],
  ["monitor", "monitor gamer"], ["console", "console videogame"], ["tablet", "tablet"],
  ["áudio", "fone bluetooth"], ["áudio", "caixa de som bluetooth"], ["periférico", "teclado gamer"],
  ["periférico", "mouse gamer"], ["eletrodoméstico", "air fryer"], ["eletrodoméstico", "cafeteira elétrica"],
  ["eletrodoméstico", "sanduicheira elétrica"], ["eletrodoméstico", "aspirador de pó"],
  ["eletrodoméstico", "ventilador"], ["ferramenta", "furadeira parafusadeira"],
  ["masculino", "tênis masculino"], ["masculino", "perfume masculino original"],
  ["masculino", "relógio masculino"], ["casa", "jogo de panelas"],
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

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: required("MERCADOLIVRE_CLIENT_ID"),
    client_secret: required("MERCADOLIVRE_CLIENT_SECRET"),
  });
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw new Error(`Autenticação do Mercado Livre falhou (HTTP ${response.status}): ${json.message || json.error || "resposta inválida"}`);
  return json.access_token;
}

async function searchProducts(token, query, category) {
  const url = new URL("https://api.mercadolibre.com/sites/MLB/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "50");
  url.searchParams.set("condition", "new");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = await response.json();
  if (!response.ok) throw new Error(`Busca "${query}" falhou (HTTP ${response.status}): ${json.message || "resposta inválida"}`);
  return (json.results || []).map((item) => ({ ...item, rotationCategory: category }));
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
  if (!item.id || !item.permalink || !item.title || Number(item.price) < 19.99) return false;
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
  return Math.log10(sold + 1) * 25 + discount * 100 + (item.official_store_id ? 20 : 0) + (item.shipping?.free_shipping ? 8 : 0);
}

async function selectProduct(history) {
  const token = await getAccessToken();
  const offset = history.length % searches.length;
  const ordered = [...searches.slice(offset), ...searches.slice(0, offset)];
  const candidates = [];
  for (const [category, query] of ordered) {
    try { candidates.push(...await searchProducts(token, query, category)); }
    catch (error) { console.warn(error.message); }
  }
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
