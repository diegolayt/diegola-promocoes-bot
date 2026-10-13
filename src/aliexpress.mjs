// AliExpress (API de afiliados): vitrine para o site e publicação no tópico
// "AliExpress" do grupo do Telegram.
//   node src/aliexpress.mjs --showcase            grava data/vitrine.aliexpress.json
//   node src/aliexpress.mjs --publish [--dry-run]  publica uma oferta ainda não enviada
//   node src/aliexpress.mjs --receive-hot          recebe do navegador a lista "em alta" com cupons
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = (name) => join(root, "data", name);
const showcasePath = dataPath("vitrine.aliexpress.json");
const feedPath = dataPath("feed.aliexpress.json");
const statePath = dataPath("posted.aliexpress.json");
const topicPath = dataPath("aliexpress-topic.json");
const hotPath = dataPath("hot.aliexpress.json");
const hotRawPath = dataPath("hot.aliexpress.bruto.json");
const HOT_PORT = 8772;
const PER_SOURCE = 5;
const FEED_ITEMS = 1200;
const HISTORY_ITEMS = 800;
const SLOT_MS = 30 * 60_000;
const BLOCKED = ["replica", "1:1", "adult", "sexy", "erotic", "vape", "cigarr", "knife", "faca tatica", "airsoft", "spy", "espia"];
const USED = ["usado", "usada", "used", "refurbished", "recondicionad", "seminov"];

// Buscas em inglês rendem mais resultado; o título volta em português.
// "categoria" é a do site e "min" é o preço mínimo em reais. Opcionais:
// "exige"/"evita" (padrões no título sem acento), "usados" (aceita peça usada,
// comum em placa de vídeo e processador), "nota"/"vendas" (régua própria) e
// "promo" (lista pronta do AliExpress em vez de busca).
const FONTES = [
  { nome: "ali_smartphone", categoria: "Celulares", busca: "smartphone global version", min: 400, exige: /smartphone|celular|telefone/, evita: /capa|pelicula|suporte|alto-falante|caixa de som/ },
  { nome: "ali_carregador", categoria: "Celulares", busca: "gan charger usb c", min: 40, exige: /carregador/ },
  { nome: "ali_powerbank", categoria: "Celulares", busca: "power bank 20000mah", min: 60, exige: /power ?bank|bateria (externa|portatil)|carregador portatil/, evita: /ventilador|radio|caixa carregadora|diy|lanterna/ },
  { nome: "ali_fone", categoria: "Áudio e TV", busca: "bluetooth earbuds", min: 50, exige: /fone|earbud|headphone|headset/ },
  { nome: "ali_tvbox", categoria: "Áudio e TV", busca: "tv stick 4k", min: 100 },
  { nome: "ali_projetor", categoria: "Áudio e TV", busca: "projector 1080p", min: 250, exige: /projetor/ },
  { nome: "ali_ssd", categoria: "Informática", busca: "ssd nvme 1tb", min: 150, exige: /ssd|nvme/ },
  { nome: "ali_ram", categoria: "Informática", busca: "ddr4 16gb ram desktop", min: 80, exige: /ddr[345]|memoria/, usados: true },
  { nome: "ali_ram_notebook", categoria: "Informática", busca: "ddr4 sodimm laptop ram", min: 80, exige: /ddr[345]|memoria/, usados: true },
  { nome: "ali_placa_video", categoria: "Informática", busca: "rx 580 graphics card", min: 300, exige: /placa (de video|grafica)|rtx|gtx|rx ?\d{3,4}|radeon|geforce/, evita: /suporte|cabo|riser|cooler|ventoinha/, usados: true, nota: 88, vendas: 20 },
  { nome: "ali_placa_video_rtx", categoria: "Informática", busca: "rtx graphics card", min: 600, exige: /placa (de video|grafica)|rtx|gtx|radeon|geforce/, evita: /suporte|cabo|riser|cooler|ventoinha/, usados: true, nota: 88, vendas: 20 },
  { nome: "ali_processador", categoria: "Informática", busca: "ryzen 5 cpu processor", min: 200, exige: /processador|ryzen|xeon|core i[3579]|cpu/, evita: /cooler|ventoinha|pasta termica|suporte/, usados: true, nota: 88, vendas: 20 },
  { nome: "ali_kit_xeon", categoria: "Informática", busca: "x99 motherboard kit xeon", min: 300, exige: /x99|x79|placa[- ]mae|motherboard/, usados: true, nota: 88, vendas: 20 },
  { nome: "ali_placa_mae", categoria: "Informática", busca: "b450 motherboard", min: 300, exige: /placa[- ]mae|motherboard/, usados: true, nota: 88, vendas: 20 },
  { nome: "ali_cooler", categoria: "Informática", busca: "cpu air cooler", min: 60, exige: /cooler|ventoinha|refrigera/ },
  { nome: "ali_fonte_pc", categoria: "Informática", busca: "pc power supply 600w", min: 150, exige: /fonte|psu|alimentacao/ },
  { nome: "ali_monitor", categoria: "Informática", busca: "gaming monitor 144hz", min: 500, exige: /monitor/, evita: /suporte|braco/ },
  { nome: "ali_teclado", categoria: "Informática", busca: "mechanical keyboard", min: 100, exige: /teclado/ },
  { nome: "ali_mouse", categoria: "Informática", busca: "wireless gaming mouse", min: 60, exige: /mouse/ },
  { nome: "ali_tablet", categoria: "Informática", busca: "tablet android", min: 400, exige: /tablet/, evita: /capa|suporte|pelicula/ },
  { nome: "ali_minipc", categoria: "Informática", busca: "mini pc", min: 600, exige: /mini ?pc|computador/ },
  { nome: "ali_camera", categoria: "Informática", busca: "wifi security camera", min: 80, exige: /camera/ },
  { nome: "ali_controle", categoria: "Games", busca: "wireless gamepad controller", min: 80, exige: /controle|gamepad|joystick/ },
  { nome: "ali_portatil", categoria: "Games", busca: "handheld game console", min: 150, exige: /console|portatil|videogame|video game/ },
  { nome: "ali_retro", categoria: "Games", busca: "retro handheld game console 10000 games", min: 80, exige: /console|portatil|retro|videogame|video game/ },
  { nome: "ali_game_stick", categoria: "Games", busca: "game stick 4k retro tv", min: 80, exige: /game ?stick|console|retro/ },
  { nome: "ali_smartwatch", categoria: "Moda", busca: "smartwatch", min: 80 },
  { nome: "ali_mochila", categoria: "Moda", busca: "laptop backpack", min: 80, exige: /mochila/ },
  { nome: "ali_aspirador", categoria: "Eletrodomésticos", busca: "robot vacuum cleaner", min: 400, exige: /aspirador/ },
  { nome: "ali_airfryer", categoria: "Eletrodomésticos", busca: "air fryer", min: 200, exige: /air ?fryer|fritadeira/ },
  { nome: "ali_led", categoria: "Casa", busca: "led strip lights rgb", min: 30 },
  { nome: "ali_parafusadeira", categoria: "Casa", busca: "cordless electric screwdriver", min: 80 },
  { nome: "ali_barbeador", categoria: "Beleza", busca: "electric shaver men", min: 60 },
  { nome: "ali_secador", categoria: "Beleza", busca: "hair dryer", min: 80, exige: /secador/ },
  { nome: "ali_blocos", categoria: "Brinquedos", busca: "building blocks set", min: 60 },
  { nome: "ali_bike", categoria: "Esportes", busca: "bicycle light", min: 40 },
  // Os mais vendidos entre os que saem de estoque no Brasil (chegam rápido e sem imposto de importação).
  { nome: "ali_envio_brasil", promo: "AEB_BR_ShipFromBR_20241114", min: 40, doBrasil: true },
];
let envFile;
async function env(name, fallback) {
  if (envFile === undefined) {
    let text = "";
    try { text = await readFile(join(root, ".env"), "utf8"); } catch { /* no GitHub as credenciais vêm do ambiente */ }
    envFile = Object.fromEntries(text.split(/[\r\n]+/).filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
  }
  const value = process.env[name] || envFile[name] || fallback;
  if (!value) throw new Error(`Falta ${name}.`);
  return value;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 1));
}

// Assinatura da Open Platform: parâmetros em ordem alfabética, chave+valor
// colados, HMAC-SHA256 com o App Secret, em maiúsculas.
async function api(method, parameters) {
  const all = {
    ...parameters,
    method,
    app_key: await env("ALIEXPRESS_APP_KEY"),
    sign_method: "sha256",
    timestamp: Date.now().toString(),
  };
  const base = Object.keys(all).sort().map((key) => key + all[key]).join("");
  all.sign = createHmac("sha256", await env("ALIEXPRESS_APP_SECRET")).update(base).digest("hex").toUpperCase();
  const response = await fetch("https://api-sg.aliexpress.com/sync", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(all),
  });
  const json = await response.json();
  if (json.error_response) throw new Error(`${method}: ${json.error_response.msg || json.error_response.code}`);
  const result = json[`${method.replaceAll(".", "_")}_response`]?.resp_result;
  if (!result || Number(result.resp_code) !== 200) throw new Error(`${method}: ${result?.resp_msg || "resposta inesperada"}`);
  return result.result;
}

async function search(source, page) {
  if (source.promo) {
    const result = await api("aliexpress.affiliate.featuredpromo.products.get", {
      promotion_name: source.promo,
      page_no: String(page),
      page_size: "50",
      sort: "volumeDesc",
      country: "BR",
      target_currency: "BRL",
      target_language: "PT",
      tracking_id: await env("ALIEXPRESS_TRACKING_ID", "default"),
    });
    return result?.products?.product || [];
  }
  const result = await api("aliexpress.affiliate.product.query", {
    keywords: source.busca,
    min_sale_price: String(Math.round(source.min * 100)),
    page_no: String(page),
    page_size: "50",
    sort: "LAST_VOLUME_DESC",
    target_currency: "BRL",
    target_language: "PT",
    ship_to_country: "BR",
    tracking_id: await env("ALIEXPRESS_TRACKING_ID", "default"),
  });
  return result?.products?.product || [];
}

const plain = (text) => String(text).toLocaleLowerCase("pt-BR").normalize("NFD").replace(/\p{Diacritic}/gu, "");
const percent = (value) => Number(String(value || "0").replace("%", "")) || 0;
const price = (offer) => Number(offer.target_sale_price || 0);
const original = (offer) => Number(offer.target_original_price || 0);
const discount = (offer) => (original(offer) > price(offer) ? Math.round((1 - price(offer) / original(offer)) * 100) : 0);
const score = (offer) => Math.min(discount(offer), 60) * 0.6 + Math.log10(Number(offer.lastest_volume || 0) + 1) * 8 + (percent(offer.evaluate_rate) - 90) * 1.5;

function good(offer, source) {
  const name = plain(offer.product_title);
  return price(offer) >= source.min && percent(offer.evaluate_rate) >= (source.nota || 92) && Number(offer.lastest_volume || 0) >= (source.vendas || 50)
    && discount(offer) >= 10 && discount(offer) <= 80 && offer.promotion_link && offer.product_main_image_url
    && (!source.exige || source.exige.test(name)) && (!source.evita || !source.evita.test(name))
    && (source.usados || !USED.some((term) => name.includes(term)))
    && !BLOCKED.some((term) => name.includes(term));
}

async function bestOf(source, pages = 2) {
  const offers = [];
  for (let page = 1; page <= pages; page++) offers.push(...await search(source, page));
  const unique = new Map(offers.filter((offer) => good(offer, source)).map((offer) => [String(offer.product_id), { ...offer, fonte: source.nome, categoria: source.categoria, doBrasil: Boolean(source.doBrasil) }]));
  return [...unique.values()].sort((a, b) => score(b) - score(a));
}

// A busca devolve um link de afiliado com mais de mil letras, que estoura a
// legenda do Telegram. Aqui ele é trocado pelo link curto (s.click.aliexpress.com/e/...).
async function shorten(offers) {
  for (let start = 0; start < offers.length; start += 40) {
    const batch = offers.slice(start, start + 40).filter((offer) => offer.product_detail_url);
    if (!batch.length) continue;
    try {
      const result = await api("aliexpress.affiliate.link.generate", {
        promotion_link_type: "0",
        source_values: batch.map((offer) => offer.product_detail_url).join(","),
        tracking_id: await env("ALIEXPRESS_TRACKING_ID", "default"),
      });
      const short = new Map((result?.promotion_links?.promotion_link || []).map((link) => [link.source_value, link.promotion_link]));
      for (const offer of batch) offer.promotion_link = short.get(offer.product_detail_url) || offer.promotion_link;
    } catch (error) {
      console.warn(`link curto: ${error.message}`);
    }
  }
  return offers;
}

// O site de ofertas lê este formato, com o link de afiliado já montado.
function feedEntry(offer) {
  return {
    id: `aliexpress-${offer.product_id}`,
    loja: "aliexpress",
    titulo: String(offer.product_title || "").replace(/\s+/g, " ").trim(),
    imagem: String(offer.product_main_image_url || "").replace(/^http:/, "https:") || null,
    preco: price(offer),
    precoDe: original(offer) > price(offer) ? original(offer) : null,
    link: offer.promotion_link,
    vendidos: Number(offer.lastest_volume || 0),
    nota: Math.round(percent(offer.evaluate_rate) / 2) / 10 || null,
    // Sem categoria (lista pronta do AliExpress), o site adivinha pelo título.
    ...(offer.categoria ? { categoria: offer.categoria } : {}),
    ...(offer.cupom ? { cupom: offer.cupom.codigo } : {}),
    fonte: offer.fonte,
    publicadoEm: new Date().toISOString(),
  };
}

async function buildShowcase() {
  const picks = new Map();
  for (const source of FONTES) {
    try {
      for (const offer of (await bestOf(source)).slice(0, PER_SOURCE)) picks.set(String(offer.product_id), offer);
    } catch (error) {
      console.warn(`${source.nome}: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  console.log(`Vitrine do AliExpress: ${picks.size} produtos.`);
  // Uma execução fraca não apaga a vitrine anterior.
  if (picks.size >= 30) await writeJson(showcasePath, (await shorten([...picks.values()])).map(feedEntry));
}

const escapeHtml = (text) => String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const money = (value) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${await env("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(`Telegram (${method}): ${json.description || response.status}`);
  return json.result;
}

// O tópico é criado na primeira publicação e o número fica guardado no repositório.
async function topicId() {
  if (process.env.TELEGRAM_MESSAGE_THREAD_ID) return Number(process.env.TELEGRAM_MESSAGE_THREAD_ID);
  const saved = await readJson(topicPath, null);
  if (saved?.id) return saved.id;
  const topic = await telegram("createForumTopic", { chat_id: await env("TELEGRAM_CHAT_ID"), name: "Promoções AliExpress" });
  await writeJson(topicPath, { id: topic.message_thread_id, criadoEm: new Date().toISOString() });
  return topic.message_thread_id;
}

function caption(offer) {
  const off = discount(offer);
  return [
    `🔴 <b>${escapeHtml(offer.product_title)}</b>`,
    "",
    off ? `De <s>${money(original(offer))}</s> por <b>${money(price(offer))}</b> (${off}% OFF)` : `💥 Por <b>${money(price(offer))}</b>`,
    `⭐ ${percent(offer.evaluate_rate)}% de avaliações positivas · ${Number(offer.lastest_volume)} vendidos`,
    ...(offer.doBrasil ? ["🇧🇷 Enviado do Brasil"] : []),
    ...(offer.cupom ? [`🎟️ Cupom <code>${escapeHtml(offer.cupom.codigo)}</code>: ${money(offer.cupom.valor)} OFF em compras acima de ${money(offer.cupom.minimo)}`] : []),
    ...(offer.cupom && price(offer) >= offer.cupom.minimo ? [`💰 Com o cupom sai por <b>${money(price(offer) - offer.cupom.valor)}</b>`] : []),
    `🛒 <a href="${String(offer.promotion_link).replace(/&/g, "&amp;")}">Compre aqui pelo AliExpress</a>`,
    "",
    offer.doBrasil ? "⚠️ Preço e estoque podem mudar no site." : "⚠️ Preço e estoque podem mudar. Compra internacional pode ter imposto de importação.",
  ].join("\n");
}

async function publish(dryRun) {
  const history = await readJson(statePath, []);
  const seen = new Set(history.map((entry) => entry.id));
  // Cada publicação começa por uma fonte diferente, para o tópico não repetir categoria.
  // A rodada publica quatro vezes seguidas (ALI_PASSO de 0 a 3), então o passo entra na conta.
  const turn = Math.floor(Date.now() / SLOT_MS) * 4 + Number(process.env.ALI_PASSO || 0);
  const start = turn % FONTES.length;
  // Metade das publicações sai da lista "em alta no Brasil" (com cupom); a outra metade, das buscas.
  let offer = turn % 2 === 0 ? await nextHot(seen, turn) : null;
  for (let step = 0; step < FONTES.length && !offer; step++) {
    const source = FONTES[(start + step) % FONTES.length];
    try {
      offer = (await bestOf(source, 1)).find((candidate) => !seen.has(String(candidate.product_id)));
    } catch (error) {
      console.warn(`${source.nome}: ${error.message}`);
    }
  }
  if (!offer) throw new Error("Nenhuma oferta nova do AliExpress nesta execução.");
  if (offer.fonte !== "ali_em_alta") await shorten([offer]);
  if (dryRun) {
    console.log(caption(offer));
    return;
  }
  const payload = {
    chat_id: await env("TELEGRAM_CHAT_ID"),
    message_thread_id: await topicId(),
    parse_mode: "HTML",
    caption: caption(offer),
    photo: offer.product_main_image_url,
    reply_markup: { inline_keyboard: [[{ text: "🛒 Ver oferta no AliExpress", url: offer.promotion_link }]] },
  };
  try {
    await telegram("sendPhoto", payload);
  } catch {
    const { photo, caption: text, ...rest } = payload;
    await telegram("sendMessage", { ...rest, text });
  }
  await writeJson(statePath, [{ id: String(offer.product_id), em: new Date().toISOString() }, ...history].slice(0, HISTORY_ITEMS));
  const entry = feedEntry(offer);
  const feed = await readJson(feedPath, []);
  await writeJson(feedPath, [entry, ...(Array.isArray(feed) ? feed : []).filter((existing) => existing.id !== entry.id)].slice(0, FEED_ITEMS));
  console.log(`Publicado: ${entry.titulo}`);
}

// "Em alta no Brasil" com cupom: a lista vem do portal de afiliados (Ad Center),
// que só abre com login, então é coletada no navegador (aliexpress-coletor.js)
// e mandada para cá por formulário. Aqui os links viram links de afiliado.
function fromPortal(item) {
  const code = item.code?.codeId ? item.code : null;
  return {
    product_id: String(item.id),
    product_title: String(item.titulo || "").replace(/\s+/g, " ").trim(),
    product_main_image_url: item.img,
    product_detail_url: String(item.url || "").split("?")[0],
    target_sale_price: Number(item.preco || 0),
    target_original_price: Number(item.de || 0),
    evaluate_rate: `${Math.round(Number(item.nota || 0) * 20)}%`,
    lastest_volume: Number(item.vendas || 0),
    fonte: "ali_em_alta",
    doBrasil: false,
    cupom: code && { codigo: code.codeId, valor: Number(code.codeValue), minimo: Number(code.codeMinimumSpending), fim: code.endTime },
  };
}

async function receiveHot() {
  const body = await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        if (request.method !== "POST") return response.end("Envie a coleta por POST.");
        response.end("Recebido. Veja o resultado no terminal.");
        server.close();
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    }).listen(HOT_PORT, "127.0.0.1", () => console.log(`Esperando a coleta em http://127.0.0.1:${HOT_PORT} ...`));
    setTimeout(() => { server.close(); reject(new Error("Nada recebido em 20 minutos.")); }, 20 * 60_000).unref();
  });
  const items = JSON.parse(body.startsWith("dados=") ? new URLSearchParams(body).get("dados") : body);
  const unique = new Map(items.map(fromPortal)
    .filter((offer) => price(offer) >= 25 && percent(offer.evaluate_rate) >= 90 && offer.lastest_volume >= 100 && offer.product_main_image_url
      && !BLOCKED.some((term) => plain(offer.product_title).includes(term)) && !/calcinha|lingerie|sutia|cueca/.test(plain(offer.product_title)))
    .map((offer) => [offer.product_id, offer]));
  const offers = (await shorten([...unique.values()])).filter((offer) => offer.promotion_link);
  console.log(`Em alta no AliExpress: ${offers.length} de ${items.length} recebidos (${offers.filter((offer) => offer.cupom).length} com cupom).`);
  // Coleta fraca (portal deslogado, página mudou) não apaga a lista anterior.
  if (offers.length < 30) throw new Error("Coleta fraca; arquivos mantidos.");
  const now = new Date().toISOString();
  await writeJson(hotRawPath, offers.map((offer) => ({ ...offer, coletadoEm: now })));
  await writeJson(hotPath, offers.map(feedEntry));
}

// Oferta em alta ainda válida (coletada há menos de 72h, cupom dentro do prazo) e não publicada.
async function nextHot(seen, turn) {
  const limit = Date.now() - 72 * 3_600_000;
  const valid = (await readJson(hotRawPath, [])).filter((offer) => Date.parse(offer.coletadoEm) > limit && !seen.has(String(offer.product_id))
    && (!offer.cupom || Date.parse(offer.cupom.fim.replace(" ", "T")) > Date.now() + 24 * 3_600_000));
  // A lista vem com produtos parecidos em sequência; saltar pela lista evita repetir o mesmo tipo.
  return valid[(turn * 37) % (valid.length || 1)];
}

const args = process.argv.slice(2);
if (args.includes("--receive-hot")) await receiveHot();
else if (args.includes("--showcase")) await buildShowcase();
else if (args.includes("--publish")) await publish(args.includes("--dry-run"));
else console.log("Use --showcase ou --publish [--dry-run].");
