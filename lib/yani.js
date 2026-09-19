import { sleep, withRetry, tokenOverlap, normalizeText } from "./util.js";
import { parsePage } from "./sites.js";

export const YANI_BASES = ["https://yummyani.me", "https://old.yummyani.me"];

export const YANI_HEADERS = {
  "X-Application": "wawegr8j13it4rdw",
  Lang: "ru",
  Accept: "application/json",
};

export function createYaniApi(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    bases = YANI_BASES,
    headers = YANI_HEADERS,
    retries = 2,
    timeoutMs = 30000,
    onLog = null,
  } = options;

  async function request(path) {
    let lastError = null;
    try {
      return await withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetchImpl(bases[0] + path, { headers, signal: controller.signal });
            if (!response.ok) throw new Error("API вернул " + response.status);
            const json = await response.json();
            if (json && json.error) throw new Error(json.error);
            return json.response;
          } finally {
            clearTimeout(timer);
          }
        },
        { retries, baseDelay: 500, onRetry: onLog ? (e) => onLog("Повтор запроса " + path + ": " + e.message) : null }
      );
    } catch (error) {
      lastError = error;
    }
    for (const base of bases.slice(1)) {
      try {
        const response = await fetchImpl(base + path, { headers });
        if (!response.ok) continue;
        const json = await response.json();
        if (json && json.error) continue;
        return json.response;
      } catch {
        continue;
      }
    }
    throw lastError || new Error("Не удалось получить данные от API");
  }

  return {
    search: (query) => request("/api/search?q=" + encodeURIComponent(String(query || "").trim())),
    anime: (id) => request("/api/anime/" + id),
    videos: (id) => request("/api/anime/" + id + "/videos"),
    base: bases[0],
  };
}

export function scoreMatch(candidate, wantedTitle, wantedYear = 0) {
  const candidateTitles = [candidate.title, candidate.title_original, candidate.other_titles]
    .flat()
    .filter(Boolean);
  let best = 0;
  for (const title of candidateTitles) {
    const score = tokenOverlap(title, wantedTitle);
    if (score > best) best = score;
  }
  const wantedTokens = new Set(normalizeText(wantedTitle).split(" "));
  const year = Number(candidate.year) || 0;
  if (wantedYear && year && wantedYear === year) best += 0.08;
  else if (wantedYear && year && Math.abs(wantedYear - year) > 2) best -= 0.12;

  const wantedNumber = wantedTitle.match(/(\d+)\s*(?:сезон|season)/i) || wantedTitle.match(/\b(\d+)\b\s*$/);
  const season = wantedNumber ? wantedNumber[1] : null;
  if (season) {
    const candTitle = normalizeText(candidate.title);
    const candTokens = new Set(candTitle.split(" "));
    if (candTokens.has(season)) best += 0.12;
  }
  return best;
}

export function pickBestMatch(results, wantedTitle, wantedYear = 0) {
  const scored = (results || [])
    .map((item) => ({ item, score: scoreMatch(item, wantedTitle, wantedYear) }))
    .sort((a, b) => b.score - a.score);
  return scored;
}

export function animePageUrl(anime) {
  return "https://yummyani.me/anime/" + anime.anime_url;
}

export function extractPageId(url) {
  const text = String(url || "");
  const tv = text.match(/\/(\d+)-[^/]*\.html/);
  if (tv) return Number(tv[1]);
  const short = text.match(/\/a(\d+)(?:[\/?#]|$)/);
  if (short) return Number(short[1]);
  const me = text.match(/\/(?:anime\/)?(\d+)(?:[-/]|$)/);
  if (me) return Number(me[1]);
  return 0;
}

export function parseYummyTvHtml(html, url = "") {
  return parsePage(html, url);
}

export async function fetchPageInfo(url, options = {}) {
  const { fetchImpl = globalThis.fetch, retries = 1 } = options;
  const html = await withRetry(
    async () => {
      const response = await fetchImpl(url, { credentials: "omit" });
      if (!response.ok) throw new Error("Страница вернула " + response.status);
      return response.text();
    },
    { retries, baseDelay: 500 }
  );
  const parsed = parsePage(html, url);
  return { ...parsed, url, pageId: extractPageId(url) };
}

export const fetchYummyTvAnime = fetchPageInfo;

function episodeSortValue(entry) {
  const number = Number(String(entry.number).replace(/[^\d]/g, ""));
  if (Number.isFinite(number) && number > 0) return number;
  return 100000 + (Number(entry.index) || 0);
}

export function groupVideos(videos) {
  const groups = new Map();
  for (const video of videos || []) {
    const data = video.data || {};
    const dubbing = String(data.dubbing || "Без озвучки").trim();
    const player = String(data.player || "");
    const entry = {
      number: String(video.number == null ? "" : video.number),
      index: Number(video.index) || 0,
      url: video.iframe_url || "",
      duration: Number(video.duration) || 0,
      videoId: video.video_id,
      player,
    };
    if (!entry.url) continue;
    if (!groups.has(dubbing)) groups.set(dubbing, { dubbing, kodik: [], alloha: [], cvh: [] });
    const group = groups.get(dubbing);
    if (/kodik/i.test(player) || /kodik/i.test(entry.url)) group.kodik.push(entry);
    else if (/alloha/i.test(player) || /alloha/i.test(entry.url)) group.alloha.push(entry);
    else group.cvh.push(entry);
  }

  const list = [];
  for (const group of groups.values()) {
    const dedupe = (items) => {
      const seen = new Set();
      return items
        .filter((item) => {
          const key = item.number + "|" + item.url;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => episodeSortValue(a) - episodeSortValue(b));
    };
    group.kodik = dedupe(group.kodik);
    group.alloha = dedupe(group.alloha);
    group.cvh = dedupe(group.cvh);
    group.supported = group.kodik.length > 0;
    group.playerKind = group.supported ? "kodik" : group.alloha.length ? "alloha" : "unknown";
    group.playerLabel = group.playerKind === "kodik" ? "Kodik" : group.playerKind === "alloha" ? "Alloha" : "";
    group.needsSniffer = !group.supported && group.alloha.length > 0;
    group.episodes = group.supported ? group.kodik : group.alloha.length ? group.alloha : group.cvh;
    group.episodeCount = Math.max(group.kodik.length, group.alloha.length, group.cvh.length);
    list.push(group);
  }
  list.sort((a, b) => {
    if (a.supported !== b.supported) return a.supported ? -1 : 1;
    if (b.episodeCount !== a.episodeCount) return b.episodeCount - a.episodeCount;
    return a.dubbing.localeCompare(b.dubbing, "ru");
  });
  return list;
}

export function describeDub(dubbing) {
  const text = String(dubbing || "").trim();
  if (/субтитр/i.test(text)) return { kind: "subs", label: text.replace(/^Субтитры\s*/i, "") || "Субтитры" };
  if (/одноголос/i.test(text)) return { kind: "single", label: text.replace(/^Озвучка\s*/i, "") };
  return { kind: "dub", label: text.replace(/^Озвучка\s*/i, "") };
}

export function episodeRangeLabel(episodes) {
  if (!episodes.length) return "—";
  const numbers = episodes.map((e) => Number(String(e.number).replace(/[^\d]/g, ""))).filter((n) => n > 0);
  if (!numbers.length) return "фильм";
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? "серия " + min : min + "–" + max;
}

export { sleep };
