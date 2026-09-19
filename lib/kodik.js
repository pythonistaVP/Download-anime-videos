import { withRetry, abortError } from "./util.js";

export const KODIK_REFERER = "https://yummyani.me/";

export function normalizeKodikUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return "https:" + text;
  if (/^https?:/i.test(text)) return text;
  return "https://" + text;
}

export function isKodikUrl(url) {
  return /kodik/i.test(String(url || ""));
}

export function decodeKodikLink(source) {
  const text = String(source || "");
  if (!text) return "";
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  for (let shift = 0; shift < 26; shift++) {
    const rotated = normalized.replace(/[a-zA-Z]/g, (char) => {
      const base = char <= "Z" ? 65 : 97;
      return String.fromCharCode(((char.charCodeAt(0) - base + shift) % 26) + base);
    });
    try {
      const padded = rotated + "=".repeat((4 - (rotated.length % 4)) % 4);
      const decoded = atob(padded);
      if (decoded.includes("m3u8") || decoded.includes(".mp4")) {
        return decoded.startsWith("//") ? "https:" + decoded : decoded;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function extractVar(html, name) {
  const match = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*"([^"]*)"'));
  return match ? match[1] : "";
}

function extractQuoted(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1] : "";
}

export async function fetchKodikLinks(iframeUrl, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    referer = KODIK_REFERER,
    retries = 2,
    onLog = null,
    signal = null,
  } = options;

  const playerUrl = normalizeKodikUrl(iframeUrl);
  if (!playerUrl) throw new Error("Пустая ссылка на плеер");

  const html = await withRetry(
    async () => {
      const response = await fetchImpl(playerUrl, {
        headers: { Referer: referer },
        referrer: referer,
        referrerPolicy: "unsafe-url",
        signal,
      });
      if (!response.ok) throw new Error("Kodik: страница плеера ответила " + response.status);
      return response.text();
    },
    { retries, baseDelay: 600, onRetry: (e) => onLog && onLog("Kodik: повтор (" + e.message + ")"), signal }
  );

  const payload = {
    d: extractVar(html, "domain") || "kodikplayer.com",
    d_sign: extractVar(html, "d_sign"),
    pd: extractVar(html, "pd") || "kodikplayer.com",
    pd_sign: extractVar(html, "pd_sign"),
    ref: extractVar(html, "ref"),
    ref_sign: extractVar(html, "ref_sign"),
    bad_user: "false",
    cdn_is_working: "true",
    type: extractQuoted(html, /\.type = '([^']+)'/),
    hash: extractQuoted(html, /\.hash = '([^']+)'/),
    id: extractQuoted(html, /\.id = '([^']+)'/),
  };

  if (!payload.hash || !payload.id) throw new Error("Kodik: не удалось разобрать данные плеера (возможно, эпизод недоступен)");

  const endpoint = "https://" + payload.d + "/ftor";
  const body = new URLSearchParams(payload).toString();

  const json = await withRetry(
    async () => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: playerUrl,
          Origin: "https://" + payload.d,
        },
        referrer: playerUrl,
        referrerPolicy: "unsafe-url",
        body,
        signal,
      });
      if (!response.ok) throw new Error("Kodik: сервер ссылок ответил " + response.status);
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Kodik: неожиданный ответ сервера ссылок");
      }
    },
    { retries, baseDelay: 600, onRetry: (e) => onLog && onLog("Kodik: повтор запроса ссылок (" + e.message + ")"), signal }
  );

  const qualities = {};
  const mirrors = {};
  const links = (json && json.links) || {};
  for (const [quality, list] of Object.entries(links)) {
    const items = Array.isArray(list) ? list : [list];
    const urls = [];
    for (const item of items) {
      if (!item || !item.src) continue;
      const decoded = decodeKodikLink(item.src);
      if (decoded && !urls.includes(decoded)) urls.push(decoded);
    }
    if (!urls.length) continue;
    const numeric = Number(String(quality).replace(/[^\d]/g, ""));
    const key = Number.isFinite(numeric) && numeric > 0 ? numeric : quality;
    qualities[key] = urls[0];
    mirrors[key] = urls;
  }

  const keys = Object.keys(qualities);
  if (!keys.length) throw new Error("Kodik не отдал ссылки на видео (эпизод может быть недоступен)");

  return {
    qualities,
    mirrors,
    available: keys.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b),
    defaultQuality: Number(json.default) || null,
    playerType: payload.type,
    playerId: payload.id,
    playerUrl,
  };
}

export function pickQuality(qualities, wanted) {
  const numeric = Object.keys(qualities)
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!numeric.length) return null;
  if (!wanted || wanted === "max" || String(wanted) === "max") return numeric[numeric.length - 1];
  const target = Number(wanted);
  if (!Number.isFinite(target)) return numeric[numeric.length - 1];
  const lower = numeric.filter((value) => value <= target);
  return lower.length ? lower[lower.length - 1] : numeric[0];
}

export async function probeQualities(iframeUrl, options = {}) {
  const result = await fetchKodikLinks(iframeUrl, options);
  return result.available;
}

export { abortError };
