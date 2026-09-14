import { createYaniApi, groupVideos, fetchYummyTvAnime, pickBestMatch, extractPageId } from "./lib/yani.js";
import { fetchKodikLinks } from "./lib/kodik.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "./lib/settings.js";

const SITE_PATTERN = /^https?:\/\/([^/]+\.)?yummyanime\.tv(\/|$)/i;
const MENU_ID = "dav-download-season";

const api = createYaniApi({ fetchImpl: (...args) => fetch(...args) });

function isTrustedSender(sender) {
  if (!sender) return false;
  const url = (sender.tab && sender.tab.url) || sender.url || "";
  const extensionRoot = chrome.runtime.getURL("");
  if (url.startsWith(extensionRoot)) return true;
  if (!sender.tab) return true;
  return SITE_PATTERN.test(url);
}

async function resolveAnime({ source, title, altTitle, year }) {
  let query = title || "";
  let wantedYear = Number(year) || 0;
  let pageId = 0;

  if (source && SITE_PATTERN.test(source) && !query) {
    const parsed = await fetchYummyTvAnime(source, { fetchImpl: (...args) => fetch(...args) });
    query = parsed.title || parsed.altTitle;
    wantedYear = parsed.year || wantedYear;
    pageId = parsed.pageId || extractPageId(source);
  }

  if (!query) {
    return { anime: null, candidates: [], pageId, query };
  }

  const results = await api.search(query);
  const ranked = pickBestMatch(results, query, wantedYear).filter((entry) => entry.score > 0.25);
  return {
    anime: ranked.length ? ranked[0].item : null,
    score: ranked.length ? ranked[0].score : 0,
    candidates: ranked.slice(0, 8).map((entry) => ({ ...entry.item, score: entry.score })),
    pageId,
    query,
  };
}

async function loadDubs({ animeId }) {
  const anime = await api.anime(animeId);
  const videos = await api.videos(animeId);
  const groups = groupVideos(videos);
  return {
    anime,
    groups: groups.map((group) => ({
      dubbing: group.dubbing,
      count: group.episodes.length,
      allohaCount: group.alloha.length,
      supported: group.supported,
      episodes: group.episodes.map((episode) => ({
        number: episode.number,
        index: episode.index,
        url: episode.url,
        duration: episode.duration,
      })),
    })),
  };
}

async function openManager(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const url = chrome.runtime.getURL("manager.html") + (query.toString() ? "?" + query.toString() : "");
  await chrome.tabs.create({ url, active: true });
  return url;
}

async function handleMessage(message, sender) {
  if (!isTrustedSender(sender)) throw new Error("Недоверенный источник сообщения");
  switch (message.type) {
    case "dav:openManager":
      return { url: await openManager(message.params) };
    case "dav:resolve":
      return resolveAnime(message.params || {});
    case "dav:dubs":
      return loadDubs(message.params || {});
    case "dav:probe":
      return fetchKodikLinks(message.params.url, { onLog: null });
    case "dav:settings:get":
      return loadSettings();
    case "dav:settings:set":
      return saveSettings(message.params || {});
    case "dav:defaults":
      return DEFAULT_SETTINGS;
    default:
      throw new Error("Неизвестный запрос: " + message.type);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Скачать сезон — Download anime videos",
      contexts: ["page", "link"],
      documentUrlPatterns: ["*://yummyanime.tv/*", "*://*.yummyanime.tv/*"],
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  createContextMenu();
  const settings = await loadSettings();
  await saveSettings(settings);
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const target = info.linkUrl && SITE_PATTERN.test(info.linkUrl) ? info.linkUrl : (tab && tab.url) || "";
  if (!SITE_PATTERN.test(target)) return;
  openManager({ source: target, autorun: "1" });
});
