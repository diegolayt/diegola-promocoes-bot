// Avisa no canal do Telegram quando sai vídeo novo no canal do YouTube.
// Uso: node src/youtube.mjs [--dry-run]
// Na primeira execução só guarda os vídeos que já existem, sem publicar nada.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, "data/youtube.json");
const dryRun = process.argv.includes("--dry-run");

const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "UCaRDttbPh8WcogMeMiR9uBg";
const HANDLE = process.env.YOUTUBE_HANDLE || "@diegola021";
const CHAT_ID = process.env.YOUTUBE_TELEGRAM_CHAT_ID || "@Diegolanftweb3";
const MAX_POR_VEZ = 2;
const HISTORY_ITEMS = 300;

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Cookie: "SOCS=CAI; CONSENT=YES+1",
};

const unique = (list) => [...new Set(list)];
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function page(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} respondeu ${response.status}`);
  return response.text();
}

// O feed oficial costuma falhar; a aba "Vídeos" do canal é a reserva (não traz Shorts nem lives).
async function listar() {
  try {
    const xml = await page(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
    const ids = unique([...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]));
    if (ids.length) return ids;
  } catch {}
  const html = await page(`https://www.youtube.com/${HANDLE}/videos`);
  const ids = unique([...html.matchAll(/"contentId":"([\w-]{11})"/g)].map((m) => m[1]));
  if (!ids.length) throw new Error("Não achei nenhum vídeo na página do canal.");
  return ids;
}

async function titulo(id) {
  const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { headers });
  if (!response.ok) throw new Error(`Título do vídeo ${id} respondeu ${response.status}`);
  return (await response.json()).title;
}

// Estreia agendada aparece na lista antes da hora; só avisa quando o vídeo estiver no ar.
async function aindaNaoSaiu(id) {
  try {
    return /"isUpcoming":true/.test(await page(`https://www.youtube.com/watch?v=${id}`));
  } catch {
    return false;
  }
}

async function telegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Falta TELEGRAM_BOT_TOKEN.");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function avisar(id, title) {
  const link = `https://youtu.be/${id}`;
  const text = `🚨 <b>VÍDEO NOVO NO CANAL!</b>\n\n🎬 ${escapeHtml(title)}\n\n▶️ Assista agora: ${link}`;
  if (dryRun) {
    console.log(`[teste] publicaria em ${CHAT_ID}:\n${text}\n`);
    return;
  }
  const payload = {
    chat_id: CHAT_ID,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "▶️ Assistir no YouTube", url: link }]] },
  };
  for (const capa of ["maxresdefault", "hqdefault"]) {
    try {
      await telegram("sendPhoto", { ...payload, caption: text, photo: `https://i.ytimg.com/vi/${id}/${capa}.jpg` });
      return;
    } catch {}
  }
  await telegram("sendMessage", { ...payload, text });
}

async function main() {
  const ids = await listar();
  let state = null;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {}

  if (!state) {
    console.log(`Primeira execução: ${ids.length} vídeos guardados, nada publicado.`);
    if (!dryRun) {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify({ vistos: ids }, null, 2)}\n`);
    }
    return;
  }

  // Do mais antigo para o mais novo, para o canal receber na ordem certa.
  const novos = ids.filter((id) => !state.vistos.includes(id)).reverse().slice(0, MAX_POR_VEZ);
  if (!novos.length) {
    console.log("Nenhum vídeo novo.");
    return;
  }

  let publicados = 0;
  for (const id of novos) {
    if (await aindaNaoSaiu(id)) {
      console.log(`${id} ainda é estreia agendada, fica para depois.`);
      continue;
    }
    const title = await titulo(id);
    await avisar(id, title);
    console.log(`Avisado: ${id} | ${title}`);
    publicados += 1;
    if (!dryRun) {
      state.vistos = [id, ...state.vistos].slice(0, HISTORY_ITEMS);
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
  }
  console.log(`${publicados} aviso(s) nesta execução.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
