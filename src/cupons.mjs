// Coleta automática de cupons para a aba de cupons do site.
//   Shopee: lê o canal público de afiliados no Telegram (t.me/s/...).
//   AliExpress: usa os cupons da lista "em alta" (data/hot.aliexpress.bruto.json).
// Os cupons colocados à mão em data/cupons.json (sem o campo "auto") ficam
// como estão; os automáticos de cada fonte são trocados a cada execução.
//   node src/cupons.mjs            grava data/cupons.json
//   node src/cupons.mjs --dry-run  só mostra o que entraria
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const couponsPath = join(root, "data", "cupons.json");
const hotPath = join(root, "data", "hot.aliexpress.bruto.json");
const SHOPEE_CHANNEL = "https://t.me/s/afiliadosshopeebroficial";
const ALI_MAX = 10;
const DRY = process.argv.includes("--dry-run");

const decode = (html) => html
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const clean = (text) => text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/\s+/g, " ").trim();
const money = (text) => Number(String(text).replace(/\./g, "").replace(",", "."));
// Meia-noite (horário de Brasília) do dia seguinte a dd/mm.
const endOfDay = (day, month, year) => new Date(Date.UTC(year, month - 1, day + 1, 3)).toISOString().replace(".000Z", "Z");

async function credentials() {
  let file = "";
  try { file = await readFile(join(root, ".env"), "utf8"); } catch { /* no GitHub as credenciais vêm do ambiente */ }
  const fromFile = Object.fromEntries(file.split(/[\r\n]+/).filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
  return { id: process.env.SHOPEE_APP_ID || fromFile.SHOPEE_APP_ID, secret: process.env.SHOPEE_SECRET || fromFile.SHOPEE_SECRET };
}

// Link de afiliado da Shopee; se a API recusar, fica o link original.
async function shopeeLink(url, keys) {
  if (!keys.id || !keys.secret) return url;
  try {
    const payload = JSON.stringify({ query: `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(url)}, subIds: ["cupons"] }) { shortLink } }` });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHash("sha256").update(`${keys.id}${timestamp}${payload}${keys.secret}`).digest("hex");
    const response = await fetch("https://open-api.affiliate.shopee.com.br/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${keys.id},Timestamp=${timestamp},Signature=${signature}` },
      body: payload,
    });
    const json = await response.json();
    return json.data?.generateShortLink?.shortLink || url;
  } catch { return url; }
}

async function channelMessages() {
  const messages = [];
  let url = SHOPEE_CHANNEL;
  for (let page = 0; page < 3 && url; page++) {
    const html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
    const parts = html.split('<div class="tgme_widget_message_wrap').slice(1);
    for (const part of parts) {
      const id = Number(part.match(/data-post="[^"/]+\/(\d+)"/)?.[1]);
      const body = part.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1];
      const date = part.match(/datetime="([^"]+)"/)?.[1];
      if (id && body && date) messages.push({ id, text: decode(body), date: new Date(date) });
    }
    const oldest = Math.min(...messages.map((m) => m.id));
    url = Number.isFinite(oldest) ? `${SHOPEE_CHANNEL}?before=${oldest}` : "";
  }
  return [...new Map(messages.map((m) => [m.id, m])).values()].sort((a, b) => b.id - a.id);
}

async function shopeeCoupons() {
  const keys = await credentials();
  const found = [];
  for (const msg of await channelMessages()) {
    const local = new Date(msg.date.getTime() - 3 * 3600e3);
    const year = local.getUTCFullYear();
    const validity = msg.text.match(/at[ée]\s+(\d{1,2})\/(\d{1,2})/i);
    const fim = validity ? endOfDay(Number(validity[1]), Number(validity[2]), year) : endOfDay(local.getUTCDate(), local.getUTCMonth() + 1, year);
    const minText = msg.text.match(/(?:acima de|a partir de)\s*R\$\s*([\d.,]+)/i);
    const url = msg.text.match(/https:\/\/(?:www\.)?shopee\.com\.br\/[^\s]+/)?.[0];
    const selected = /selecionad/i.test(msg.text);
    const codes = [...msg.text.matchAll(/🎟️?\s*([A-Z0-9]{5,20})\s*:\s*([^\n]+)/gu)];
    for (const [, codigo, desc] of codes) {
      const rules = [
        minText ? `Compras acima de R$ ${minText[1]}` : "Sem valor mínimo informado",
        selected ? "só em produtos selecionados" : "",
        `válido até ${new Date(Date.parse(fim) - 1).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })} ou enquanto durar`,
      ].filter(Boolean);
      found.push({
        loja: "shopee", codigo, descricao: clean(desc).replace(/\s*(?:nas compras|em compras)\s+(?:acima de|a partir de)\s*R\$\s*[\d.,]+/i, ""),
        regra: rules.join(" · "), precoMinimo: minText ? money(minText[1]) : 0,
        soLista: selected, fim, link: url ? await shopeeLink(url, keys) : null,
        auto: "shopee-telegram", postadoEm: msg.date.toISOString(),
      });
    }
  }
  const now = Date.now();
  return [...new Map(found.map((c) => [c.codigo, c])).values()].filter((c) => Date.parse(c.fim) > now);
}

async function aliexpressCoupons() {
  let items = [];
  try { items = JSON.parse(await readFile(hotPath, "utf8")); } catch { return null; }
  const now = Date.now();
  const byCode = new Map();
  for (const item of items) {
    const c = item.cupom;
    if (!c?.codigo || !c.valor || !item.promotion_link) continue;
    const fim = new Date(`${String(c.fim).replace(" ", "T")}-03:00`);
    if (!(fim.getTime() > now)) continue;
    const prev = byCode.get(c.codigo);
    if (!prev || Number(item.lastest_volume) > Number(prev.item.lastest_volume)) byCode.set(c.codigo, { c, item, fim });
  }
  const brl = (n) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return [...byCode.values()]
    .sort((a, b) => b.c.valor - a.c.valor)
    .slice(0, ALI_MAX)
    .map(({ c, item, fim }) => ({
      loja: "aliexpress", codigo: c.codigo,
      descricao: `${brl(c.valor)} OFF em ${clean(item.product_title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ")).split(" ").slice(0, 6).join(" ").replace(/[,;:-]+$/, "")}`,
      regra: [Number(c.minimo) > Number(c.valor) + 1 ? `Compras acima de ${brl(c.minimo)}` : "", "vale no produto do link", `até ${fim.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })}`].filter(Boolean).join(" · "),
      precoMinimo: Number(c.minimo) || 0, soLista: true, fim: fim.toISOString(),
      link: item.promotion_link, auto: "aliexpress-hot",
    }));
}

const current = JSON.parse(await readFile(couponsPath, "utf8"));
const shopee = await shopeeCoupons();
const ali = await aliexpressCoupons();
console.log(`Shopee (canal do Telegram): ${shopee.length} cupons válidos.`);
console.log(ali ? `AliExpress (em alta): ${ali.length} cupons válidos.` : "AliExpress: lista em alta não encontrada, mantidos os anteriores.");

const keep = current.filter((c) => c.auto !== "shopee-telegram" && (ali === null || c.auto !== "aliexpress-hot"));
const next = [...keep, ...shopee, ...(ali || [])];
if (DRY) {
  for (const c of [...shopee, ...(ali || [])]) console.log(`- ${c.loja} ${c.codigo}: ${c.descricao} | ${c.regra} | ${c.link}`);
} else {
  await writeFile(couponsPath, JSON.stringify(next, null, 1) + "\n");
  console.log(`cupons.json: ${next.length} cupons (${keep.length} manuais ou anteriores).`);
}
