export const SETTINGS_KEY = "download-anime-videos:settings";

export const DEFAULT_SETTINGS = {
  quality: "max",
  concurrency: 4,
  outputMode: "files",
  filenameTemplate: "{title} - {ep}.mp4",
  folderTemplate: "{title} [{dub}]",
  preferredDubs: [
    "AniLibria",
    "AniStar",
    "AniDUB",
    "AnimeVost",
    "Dream Cast",
    "ТО Дубляжная",
    "AniMaunt",
    "Freedub",
    "Субтитры",
  ],
  autoMatch: true,
  skipExisting: true,
  politeDelay: 350,
  rememberFolder: true,
};

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}

export async function loadSettings() {
  try {
    if (hasChromeStorage()) {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      return { ...DEFAULT_SETTINGS, ...((stored && stored[SETTINGS_KEY]) || {}) };
    }
    const raw = globalThis.localStorage ? localStorage.getItem(SETTINGS_KEY) : null;
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  try {
    if (hasChromeStorage()) await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    else if (globalThis.localStorage) localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}

export function pickPreferredDub(dubs, preferred = []) {
  for (const want of preferred) {
    const needle = String(want).toLowerCase();
    const found = dubs.find((item) => {
      const name = typeof item === "string" ? item : item.dubbing;
      return String(name || "").toLowerCase().includes(needle);
    });
    if (found) return typeof found === "string" ? found : found.dubbing;
  }
  return null;
}
