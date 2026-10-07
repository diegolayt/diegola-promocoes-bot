// Vitrine da Shopee para o site: os melhores de cada categoria, com a mesma
// régua do bot (nota, vendas, loja oficial, desconto plausível). Não publica
// nada no Telegram e não mexe no histórico de publicações.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FONTES } from "./fontes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "data", "vitrine.shopee.json");
const PER_SOURCE = 4;
const BLOCKED = ["replica", "inspirad", "primeira linha", "1:1", "usado", "usada", "seminov", "recondicionad", "vitrine", "open box", "validade proxima", "com defeito", "desbloquead", "destravad", "mil jogos"];

async function credentials() {
  let file = "";
  try { file = await readFile(join(root, ".env"), "utf8"); } catch { /* no GitHub as credenciais vêm do ambiente */ }
  const fromFile = Object.fromEntries(file.split(/[\r\n]+/).filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
  const id = process.env.SHOPEE_APP_ID || fromFile.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET || fromFile.SHOPEE_SECRET;
  if (!id || !secret) throw new Error("Faltam SHOPEE_APP_ID e SHOPEE_SECRET.");
  return { id, secret };
}

async function fetchOffers({ id, secret }, cat, page) {
  const payload = JSON.stringify({ query: `{ productOfferV2(productCatId:${cat}, sortType:2, page:${page}, limit:50) { nodes { itemId productName imageUrl offerLink priceMin priceDiscountRate sales ratingStar shopType } } }` });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHash("sha256").update(`${id}${timestamp}${payload}${secret}`).digest("hex");
  const response = await fetch("https://open-api.affiliate.shopee.com.br/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${id},Timestamp=${timestamp},Signature=${signature}` },
    body: payload,
  });
  const json = await response.json();
  return json.data?.productOfferV2?.nodes || [];
}

const plain = (text) => String(text).toLocaleLowerCase("pt-BR").normalize("NFD").replace(/\p{Diacritic}/gu, "");
const official = (offer) => (offer.shopType || []).includes(1);
const score = (offer) => Math.min(Number(offer.priceDiscountRate), 60) * 0.6 + Math.log10(Number(offer.sales) + 1) * 8 + (Number(offer.ratingStar) - 4.5) * 30 + (official(offer) ? 14 : 0);

function good(offer, source) {
  const name = plain(offer.productName);
  const discount = Number(offer.priceDiscountRate || 0);
  return Number(offer.priceMin) >= source.min && Number(offer.ratingStar) >= 4.5
    && Number(offer.sales) >= (official(offer) ? 20 : 50) && discount >= 10 && discount <= 80
    && (!source.oficial || official(offer))
    && (!source.exige || source.exige.test(name)) && (!source.evita || !source.evita.test(name))
    && !BLOCKED.some((term) => name.includes(term)) && !/[0-9] ?tb ?[/] ?[0-9]/.test(name) && !/(16|30|32|64) ?tb/.test(name);
}

const keys = await credentials();
const picks = new Map();
for (const sources of Object.values(FONTES)) {
  for (const source of sources) {
    try {
      const offers = [...await fetchOffers(keys, source.cat, 1), ...await fetchOffers(keys, source.cat, 2)];
      const best = offers.filter((offer) => good(offer, source)).sort((a, b) => score(b) - score(a)).slice(0, PER_SOURCE);
      for (const offer of best) picks.set(String(offer.itemId), { ...offer, fonte: source.nome });
    } catch (error) {
      console.warn(`${source.nome}: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

console.log(`Vitrine da Shopee: ${picks.size} produtos.`);
// Uma execução fraca não apaga a vitrine anterior.
if (picks.size >= 40) {
  const now = new Date().toISOString();
  const entries = [...picks.values()].map((offer) => {
    const price = Number(offer.priceMin);
    const discount = Number(offer.priceDiscountRate);
    return {
      id: `shopee-${offer.itemId}`,
      loja: "shopee",
      titulo: String(offer.productName).replace(/ +/g, " ").trim(),
      imagem: offer.imageUrl || null,
      preco: price,
      precoDe: Math.round((price / (1 - discount / 100)) * 100) / 100,
      link: offer.offerLink,
      vendidos: Number(offer.sales || 0),
      nota: Number(offer.ratingStar || 0) || null,
      lojaOficial: official(offer),
      fonte: offer.fonte,
      publicadoEm: now,
    };
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(entries, null, 1));
}
