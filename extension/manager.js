import { createYaniApi, groupVideos, pickBestMatch, fetchYummyTvAnime, describeDub, episodeRangeLabel } from "./lib/yani.js";
import { fetchKodikLinks, pickQuality } from "./lib/kodik.js";
import { downloadHls } from "./lib/hls.js";
import { ZipWriter } from "./lib/zip.js";
import { loadSettings, saveSettings, pickPreferredDub } from "./lib/settings.js";
import {
  supportsFileSystemAccess,
  pickDirectory,
  ensurePermission,
  openFileSink,
  readFileChunks,
  getFileSize,
  removeEntry,
  MemorySink,
  downloadBlob,
  opfsRoot,
} from "./lib/sinks.js";
import { idbSet, idbGet } from "./lib/idb.js";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  sanitizeFilename,
  renderTemplate,
  toUint8,
  PauseController,
  Crc32,
  pad,
  sleep,
  clamp,
  isAbortError,
} from "./lib/util.js";

const SITE_URL = "https://github.com/pythonistaVP/Download-anime-videos";
const DEV_URL = "https://github.com/pythonistaVP/";
const FOLDER_KEY = "download-anime-videos:folder";
const TEMP_DIR = "dav-tmp";
const BITRATE = { 240: 34 * 1024, 360: 52 * 1024, 480: 74 * 1024, 720: 112 * 1024, 1080: 190 * 1024, 1440: 320 * 1024 };
const DEFAULT_DURATION = 1440;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  settings: null,
  source: params.get("source") || "",
  pretitle: params.get("title") || "",
  preAnimeId: Number(params.get("animeId")) || 0,
  prePoster: params.get("poster") || "",
  preDub: params.get("dub") || "",
  preQuality: params.get("quality") || "",
  preMode: params.get("mode") || "",
  preEpisodes: params.get("episodes") || "",
  autorun: params.get("autorun") === "1",
  anime: null,
  candidates: [],
  groups: [],
  selectedDub: "",
  qualities: [],
  probeError: "",
  selectedQuality: "max",
  selectedEpisodes: new Set(),
  mode: "files",
  directoryHandle: null,
  folderName: "",
  pendingFolderHandle: null,
  runDir: null,
  tempDir: null,
  jobs: [],
  running: false,
  cancelled: false,
  pause: null,
  abort: null,
  measured: null,
  logLines: [],
  pendingOrigins: new Set(),
};

const api = createYaniApi({
  fetchImpl: (url, init) => appFetch(url, init),
  onLog: (message) => log(message, "api"),
});

function log(message, tag = "") {
  const time = new Date().toLocaleTimeString("ru-RU");
  state.logLines.push(`[${time}] ${tag ? tag + ": " : ""}${message}`);
  if (state.logLines.length > 600) state.logLines.splice(0, state.logLines.length - 600);
  const node = $("logEl");
  if (node) {
    node.textContent = state.logLines.join("\n");
    node.scrollTop = node.scrollHeight;
  }
}

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text == null ? "" : String(text);
}

function setError(message) {
  const node = $("setupError");
  if (!node) return;
  node.textContent = message || "";
  if (message) log(message, "ошибка");
}

function posterUrl(poster) {
  if (!poster) return "";
  if (typeof poster === "string") return poster.startsWith("//") ? "https:" + poster : poster;
  const value = poster.medium || poster.big || poster.small || poster.fullsize || "";
  if (!value) return "";
  return String(value).startsWith("//") ? "https:" + value : String(value);
}

function animeUrl(anime) {
  const slug = anime && (anime.anime_url || anime.url);
  return slug ? "https://yummyani.me/anime/" + slug : "";
}

function originPattern(url) {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin + "/*";
  } catch {
    return "";
  }
}

async function hasHostPermission(url) {
  const pattern = originPattern(url);
  if (!pattern || !chrome.permissions || !chrome.permissions.contains) return true;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return true;
  }
}

async function appFetch(input, init) {
  try {
    return await fetch(input, init);
  } catch (error) {
    const url = String(input);
    const pattern = originPattern(url);
    if (pattern && !(await hasHostPermission(url))) {
      state.pendingOrigins.add(new URL(url, location.href).origin);
      showPermissionBar();
    }
    throw error;
  }
}

function showPermissionBar() {
  const host = [...state.pendingOrigins][0];
  setText("permText", `Нужен доступ к ${host}, чтобы скачать видео. Нажмите «Разрешить доступ» и запустите загрузку снова.`);
  const bar = $("permBar");
  if (bar) bar.hidden = false;
}

function episodeKey(episode) {
  const numeric = Number(String(episode.number).replace(/[^\d]/g, ""));
  return numeric > 0 ? numeric : episode.index + 1;
}

function currentGroup() {
  return state.groups.find((group) => group.dubbing === state.selectedDub) || null;
}

function episodesOfGroup() {
  const group = currentGroup();
  return group ? group.episodes : [];
}

function selectedEpisodeObjects() {
  return episodesOfGroup().filter((episode) => state.selectedEpisodes.has(episodeKey(episode)));
}

function qualityLabel(quality) {
  if (quality === "max" || !quality) {
    const best = state.qualities.length ? Math.max(...state.qualities) : 0;
    return best ? "максимум (" + best + "p)" : "максимум";
  }
  return quality + "p";
}

function qualityValue(quality = state.selectedQuality) {
  if (quality === "max" || !quality) {
    return state.qualities.length ? Math.max(...state.qualities) : 720;
  }
  return Number(quality) || 720;
}

function bytesPerSecond(quality = state.selectedQuality) {
  const value = qualityValue(quality);
  if (state.measured && state.measured.quality === value && state.measured.rate > 0) return state.measured.rate;
  return BITRATE[value] || BITRATE[720];
}

function episodeSeconds(episode) {
  const duration = Number(episode && episode.duration);
  return duration > 30 ? duration : DEFAULT_DURATION;
}

function estimateEpisodeBytes(episode, quality = state.selectedQuality) {
  return episodeSeconds(episode) * bytesPerSecond(quality);
}

function episodeLabel(episode) {
  const key = episodeKey(episode);
  const max = episodesOfGroup().reduce((acc, item) => Math.max(acc, episodeKey(item)), 0);
  return max >= 10 ? pad(key, 2) : String(key);
}

function templateVars(job = null) {
  const anime = state.anime || {};
  const group = currentGroup();
  return {
    title: anime.title || state.pretitle || "anime",
    title_en: anime.anime_url || "",
    year: anime.year || "",
    season: anime.season || "",
    dub: group ? group.dubbing : state.preDub || "",
    ep: job ? job.label : "01",
    epNum: job ? String(job.number) : "1",
    epTitle: job && job.ep ? job.ep.number : "",
    quality: job && job.quality ? job.quality + "p" : qualityLabel(),
  };
}

function fileNameFor(job) {
  const name = renderTemplate(state.settings.filenameTemplate, templateVars(job));
  let out = sanitizeFilename(name || "video.mp4", "video.mp4");
  if (!/\.[a-z0-9]{2,4}$/i.test(out)) out += ".mp4";
  return out;
}

function folderNameFor() {
  const name = sanitizeFilename(renderTemplate(state.settings.folderTemplate, templateVars(null)), "");
  return name && name !== "video" ? name : "";
}

function zipNameFor() {
  const base = folderNameFor() || sanitizeFilename(state.anime ? state.anime.title : "anime", "anime");
  return base + ".zip";
}

function estimateTotalBytes() {
  const episodes = selectedEpisodeObjects();
  return episodes.reduce((sum, episode) => sum + estimateEpisodeBytes(episode), 0);
}

function updateCandidatePoster(anime) {
  const url = posterUrl(anime && anime.poster) || state.prePoster;
  const node = $("posterImg");
  if (!node) return;
  if (url) {
    node.src = url;
    node.hidden = false;
    node.addEventListener("error", () => { node.hidden = true; }, { once: true });
  } else {
    node.hidden = true;
  }
}

function renderAnime() {
  const anime = state.anime;
  updateCandidatePoster(anime);
  if (!anime) {
    setText("animeTitle", state.pretitle || "Тайтл не выбран");
    setText("animeSub", "Введите название в поиске ниже, чтобы выбрать тайтл.");
    const linkRow = $("animeLinkRow");
    if (linkRow) linkRow.textContent = "";
    return;
  }
  setText("animeTitle", anime.title || state.pretitle || "Аниме");
  const episodes = anime.episodes || {};
  const parts = [];
  if (anime.year) parts.push(anime.year + " год");
  if (episodes.count) parts.push("серий: " + episodes.count + (episodes.aired ? " (вышло " + episodes.aired + ")" : ""));
  parts.push("озвучек: " + state.groups.length);
  setText("animeSub", parts.join(" · "));
  const linkRow = $("animeLinkRow");
  if (linkRow) {
    linkRow.textContent = "";
    const href = animeUrl(anime);
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Открыть страницу на yummyani.me";
      linkRow.appendChild(link);
    }
  }
}

function renderCandidates() {
  const box = $("candidateList");
  if (!box) return;
  box.textContent = "";
  if (!state.candidates.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = state.searched ? "Ничего не найдено" : "";
    box.appendChild(empty);
    return;
  }
  for (const candidate of state.candidates) {
    const card = document.createElement("div");
    card.className = "cand" + (state.anime && state.anime.anime_id === candidate.anime_id ? " active" : "");
    const img = document.createElement("img");
    img.alt = "";
    const url = posterUrl(candidate.poster);
    if (url) img.src = url;
    else img.hidden = true;
    const meta = document.createElement("div");
    meta.className = "cand-meta";
    const title = document.createElement("div");
    title.className = "cand-title";
    title.textContent = candidate.title || "Без названия";
    const sub = document.createElement("div");
    sub.className = "cand-sub";
    const bits = [];
    if (candidate.year) bits.push(candidate.year);
    if (candidate.score) bits.push("совпадение " + Math.round(candidate.score * 100) + "%");
    sub.textContent = bits.join(" · ") || "нажмите, чтобы выбрать";
    meta.append(title, sub);
    card.append(img, meta);
    card.addEventListener("click", () => selectAnime(candidate.anime_id));
    box.appendChild(card);
  }
}

function renderDubs() {
  const box = $("dubList");
  if (!box) return;
  box.textContent = "";
  const supported = state.groups.filter((group) => group.supported);
  setText("dubHint", state.groups.length ? `доступно озвучек: ${state.groups.length} (качабельных: ${supported.length})` : "");
  if (!state.groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Выберите тайтл, чтобы увидеть список озвучек.";
    box.appendChild(empty);
    return;
  }
  for (const group of state.groups) {
    const info = describeDub(group.dubbing);
    const card = document.createElement("div");
    card.className = "dub" + (group.dubbing === state.selectedDub ? " active" : "") + (group.supported ? "" : " disabled");
    const meta = document.createElement("div");
    meta.className = "dub-meta";
    const name = document.createElement("div");
    name.className = "dub-name";
    name.textContent = info.label || group.dubbing;
    const sub = document.createElement("div");
    sub.className = "dub-sub";
    const bits = [info.kind === "subs" ? "субтитры" : info.kind === "single" ? "одноголосая озвучка" : "озвучка"];
    bits.push("серий: " + group.episodeCount);
    if (group.supported) bits.push("плеер Kodik · " + episodeRangeLabel(group.episodes));
    else bits.push("только плеер Alloha — скачивание недоступно");
    sub.textContent = bits.join(" · ");
    meta.append(name, sub);
    card.appendChild(meta);
    if (group.supported) {
      card.addEventListener("click", () => selectDub(group.dubbing));
    }
    box.appendChild(card);
  }
}

function renderQualities() {
  const box = $("qualityChips");
  const hint = $("qualityHint");
  if (!box) return;
  box.textContent = "";
  const list = state.qualities.length ? state.qualities : [360, 480, 720];
  const options = [{ value: "max", label: state.qualities.length ? "максимум" : "максимум (проверим)" }];
  for (const quality of list) options.push({ value: String(quality), label: quality + "p" });
  const totalSeconds = selectedEpisodeObjects().reduce((sum, episode) => sum + episodeSeconds(episode), 0);
  for (const option of options) {
    const chip = document.createElement("span");
    chip.className = "chip" + (String(state.selectedQuality) === option.value ? " active" : "");
    const rate = bytesPerSecond(option.value);
    chip.textContent = option.label + (totalSeconds ? " · ~" + formatBytes(totalSeconds * rate) : "");
    chip.title = "примерный размер на выбранные серии, по реальному битрейту озвучки";
    chip.addEventListener("click", () => {
      state.selectedQuality = option.value;
      renderQualities();
      renderSummary();
    });
    box.appendChild(chip);
  }
  if (hint) {
    if (state.probeError) hint.textContent = "качество не определилось: " + state.probeError;
    else if (state.probeChecking) hint.textContent = "проверяем доступные качества…";
    else if (state.qualities.length) hint.textContent = "в потоке: " + state.qualities.join(", ") + "p";
    else hint.textContent = "";
  }
}

function renderEpisodes() {
  const grid = $("epGrid");
  if (!grid) return;
  grid.textContent = "";
  const episodes = episodesOfGroup();
  const group = currentGroup();
  setText(
    "episodeHint",
    episodes.length ? `${group.dubbing} · ${episodes.length} сер. (${episodeRangeLabel(episodes)})` : ""
  );
  if (!episodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Серии появятся после выбора озвучки.";
    grid.appendChild(empty);
    renderSummary();
    return;
  }
  for (const episode of episodes) {
    const key = episodeKey(episode);
    const cell = document.createElement("div");
    cell.className = "ep" + (state.selectedEpisodes.has(key) ? " active" : "");
    cell.textContent = String(key);
    cell.title = "Серия " + key + (episode.duration ? " · " + formatDuration(episode.duration) : "");
    cell.addEventListener("click", () => {
      if (state.selectedEpisodes.has(key)) state.selectedEpisodes.delete(key);
      else state.selectedEpisodes.add(key);
      renderEpisodes();
      renderSummary();
      renderQualities();
    });
    grid.appendChild(cell);
  }
  renderSummary();
}

function renderSummary() {
  const box = $("summary");
  if (!box) return;
  const episodes = selectedEpisodeObjects();
  box.textContent = "";
  if (!episodes.length) {
    box.textContent = "Серии не выбраны.";
    updateControls();
    return;
  }
  const numbers = episodes.map(episodeKey).sort((a, b) => a - b);
  const total = estimateTotalBytes();
  const rows = [
    ["Выбрано серий", episodes.length + " (" + numbers[0] + "–" + numbers[numbers.length - 1] + ")"],
    ["Качество", qualityLabel()],
    ["Примерный размер", "~" + formatBytes(total)],
    ["Как сохранить", state.mode === "zip" ? "один ZIP-архив" : "отдельные MP4-файлы"],
    ["Куда", state.directoryHandle ? "папка «" + state.folderName + "»" + (folderNameFor() ? " / " + folderNameFor() : "") : "загрузки браузера"],
  ];
  for (const [label, value] of rows) {
    const line = document.createElement("div");
    const strong = document.createElement("b");
    strong.textContent = value;
    line.append(label + ": ", strong);
    box.appendChild(line);
  }
  if (!state.directoryHandle && supportsFileSystemAccess()) {
    const warn = document.createElement("div");
    warn.style.color = "#f0b64f";
    warn.textContent = "Совет: выберите папку — файлы будут писаться сразу на диск, и большой сезон не упрётся в память браузера.";
    box.appendChild(warn);
  }
  updateControls();
}

function jobStatusLabel(job) {
  switch (job.status) {
    case "wait": return "в очереди";
    case "links": return "получаем ссылку";
    case "download": return "скачиваем";
    case "ready": return "ждёт упаковки";
    case "zip": return "упаковка";
    case "done": return "готово";
    case "skip": return "пропущено";
    case "error": return "ошибка";
    case "cancelled": return "отменено";
    default: return job.status;
  }
}

function jobBadgeClass(status) {
  if (status === "done" || status === "ready") return "done";
  if (status === "error" || status === "cancelled") return "error";
  if (status === "skip") return "skip";
  if (status === "wait") return "";
  return "active";
}

function jobFraction(job) {
  if (job.status === "done" || job.status === "skip" || job.status === "ready" || job.status === "zip") return 1;
  if (job.segmentsTotal) return clamp(job.segmentsDone / job.segmentsTotal, 0, 1);
  return 0;
}

function updateJobRow(job) {
  if (!job.rowEl) return;
  const { row, badge, fill, left, right, retry } = job.rowEl;
  row.className = "job" + (job.status === "download" || job.status === "links" || job.status === "zip" ? " active" : "") + (job.status === "done" ? " done" : "") + (job.status === "error" ? " error" : "");
  badge.textContent = jobStatusLabel(job) + (job.quality ? " " + job.quality + "p" : "");
  badge.className = "badge" + (jobBadgeClass(job.status) ? " " + jobBadgeClass(job.status) : "");
  fill.style.width = Math.round(jobFraction(job) * 100) + "%";
  const leftParts = [];
  if (job.segmentsTotal) leftParts.push(`${job.segmentsDone}/${job.segmentsTotal} сегм.`);
  if (job.bytes) leftParts.push(formatBytes(job.bytes));
  if (job.rate) leftParts.push(formatSpeed(job.rate));
  left.textContent = job.error ? job.error : (job.detail || leftParts.join(" · "));
  const rightParts = [];
  if (job.eta) rightParts.push("осталось ~" + formatDuration(job.eta));
  if (job.elapsed) rightParts.push(formatDuration(job.elapsed / 1000));
  right.textContent = rightParts.join(" · ");
  retry.hidden = !(job.status === "error" && !state.running);
}

function renderJobs() {
  const box = $("jobList");
  if (!box) return;
  box.textContent = "";
  if (!state.jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Пока ничего не скачивается";
    box.appendChild(empty);
    renderOverall();
    return;
  }
  for (const job of state.jobs) {
    const row = document.createElement("div");
    row.className = "job";
    const top = document.createElement("div");
    top.className = "job-top";
    const name = document.createElement("div");
    name.className = "job-name";
    name.textContent = "Серия " + job.number + (job.fileName ? " · " + job.fileName : "");
    const badge = document.createElement("span");
    badge.className = "badge";
    top.append(name, badge);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    bar.appendChild(fill);
    const sub = document.createElement("div");
    sub.className = "job-sub";
    const left = document.createElement("span");
    const right = document.createElement("span");
    right.className = "right";
    sub.append(left, right);
    const actions = document.createElement("div");
    actions.className = "job-actions";
    const retry = document.createElement("button");
    retry.className = "btn ghost small";
    retry.textContent = "Повторить серию";
    retry.hidden = true;
    retry.addEventListener("click", () => retryJob(job));
    actions.appendChild(retry);
    row.append(top, bar, sub, actions);
    job.rowEl = { row, badge, fill, left, right, retry };
    updateJobRow(job);
    box.appendChild(row);
  }
  renderOverall();
}

function renderOverall() {
  const fill = $("overallFill");
  const stats = $("overallStats");
  if (!fill || !stats) return;
  const jobs = state.jobs;
  if (!jobs.length) {
    fill.style.width = "0%";
    stats.textContent = "Ожидание";
    return;
  }
  const fraction = jobs.reduce((sum, job) => sum + jobFraction(job), 0) / jobs.length;
  fill.style.width = Math.round(fraction * 100) + "%";
  const done = jobs.filter((job) => job.status === "done" || job.status === "skip").length;
  const bytes = jobs.reduce((sum, job) => sum + (job.bytes || 0), 0);
  const estimate = jobs.reduce((sum, job) => sum + (job.estimateBytes || 0), 0);
  const rate = jobs.reduce((sum, job) => sum + (job.rate || 0), 0);
  const parts = [`${done} из ${jobs.length} серий`, formatBytes(bytes) + (estimate ? " из ~" + formatBytes(estimate) : "")];
  if (rate > 0) {
    parts.push(formatSpeed(rate));
    const remaining = Math.max(0, estimate - bytes);
    if (remaining > 0) parts.push("осталось ~" + formatDuration(remaining / rate));
  }
  const errors = jobs.filter((job) => job.status === "error").length;
  if (errors) parts.push("ошибок: " + errors);
  stats.textContent = parts.join(" · ");
  setText("queueHint", state.running ? (state.paused ? "пауза" : "идёт загрузка") : state.jobs.length ? "завершено" : "—");
}

function updateControls() {
  const running = state.running;
  const start = $("startBtn");
  const pause = $("pauseBtn");
  const cancel = $("cancelBtn");
  const clear = $("clearBtn");
  if (start) {
    start.disabled = running;
    start.textContent = running ? "Скачиваем…" : "Скачать";
  }
  if (pause) {
    pause.hidden = !running;
    pause.textContent = state.paused ? "Продолжить" : "Пауза";
  }
  if (cancel) cancel.hidden = !running;
  if (clear) clear.hidden = running || !state.jobs.length;
}

async function selectAnime(animeId) {
  if (!animeId) return;
  setError("");
  setText("animeSub", "загружаем данные…");
  try {
    const anime = await api.anime(animeId);
    state.anime = anime;
    state.preAnimeId = animeId;
    const videos = await api.videos(animeId);
    state.groups = groupVideos(videos);
    state.selectedEpisodes = new Set();
    renderAnime();
    renderCandidates();
    if (!state.groups.length) throw new Error("Для этого тайтла не нашлось серий");
    const supported = state.groups.filter((group) => group.supported);
    const pool = supported.length ? supported : state.groups;
    const names = pool.map((group) => group.dubbing);
    const wanted = state.preDub || pickPreferredDub(names, state.settings.preferredDubs) || names[0];
    state.selectedDub = pool.some((group) => group.dubbing === wanted) ? wanted : names[0];
    renderDubs();
    selectAllEpisodes(true);
    await probeQualities();
    await maybeAutorun();
  } catch (error) {
    setError(String((error && error.message) || error));
    setText("animeSub", "");
  }
}

function selectDub(dubbing) {
  if (dubbing === state.selectedDub) return;
  state.selectedDub = dubbing;
  renderDubs();
  selectAllEpisodes(true);
  probeQualities();
}

function selectAllEpisodes(reset = false) {
  const episodes = episodesOfGroup();
  const keys = episodes.map(episodeKey);
  if (reset) {
    state.selectedEpisodes = new Set(keys);
  } else {
    state.selectedEpisodes = new Set([...state.selectedEpisodes].filter((key) => keys.includes(key)));
  }
  applyEpisodeParam();
  renderEpisodes();
  renderQualities();
}

function applyEpisodeParam() {
  if (!state.preEpisodes) return;
  const keys = episodesOfGroup().map(episodeKey);
  const parsed = parseSelection(state.preEpisodes, keys);
  if (parsed) {
    state.selectedEpisodes = parsed;
    state.preEpisodes = "";
  }
}

function parseSelection(text, available) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "all" || value === "все") return new Set(available);
  const result = new Set();
  for (const part of value.replace(/\s+/g, "").split(",")) {
    if (!part) continue;
    if (part.includes("-")) {
      const [from, to] = part.split("-");
      const start = Number(from) || Math.min(...available);
      const end = Number(to) || Math.max(...available);
      for (let i = start; i <= end; i++) result.add(i);
    } else {
      const single = Number(part);
      if (Number.isFinite(single)) result.add(single);
    }
  }
  const keep = new Set([...result].filter((item) => available.includes(item)));
  return keep.size ? keep : null;
}

async function probeQualities() {
  const group = currentGroup();
  state.qualities = [];
  state.probeError = "";
  if (!group || !group.episodes.length) {
    renderQualities();
    return;
  }
  state.probeChecking = true;
  renderQualities();
  try {
    const links = await fetchKodikLinks(group.episodes[0].url, { fetchImpl: appFetch, retries: 1, onLog: (m) => log(m, "kodik") });
    state.qualities = links.available || [];
    state.defaultQuality = links.defaultQuality;
    if (state.qualities.length) log(`Доступные качества (${group.dubbing}): ${state.qualities.join(", ")}p`, "ok");
  } catch (error) {
    state.probeError = String((error && error.message) || error);
    log("Качество не определилось: " + state.probeError, "warn");
  } finally {
    state.probeChecking = false;
  }
  if (state.preQuality) {
    const numeric = Number(state.preQuality);
    if (state.preQuality === "max") state.selectedQuality = "max";
    else if (Number.isFinite(numeric) && state.qualities.includes(numeric)) state.selectedQuality = String(numeric);
    state.preQuality = "";
  } else if (state.settings.quality && state.settings.quality !== "max") {
    const numeric = Number(state.settings.quality);
    if (Number.isFinite(numeric) && state.qualities.includes(numeric)) state.selectedQuality = String(numeric);
    else state.selectedQuality = "max";
  }
  renderQualities();
  renderSummary();
}

async function searchAnime(query) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return;
  state.searched = true;
  setText("animeSub", "ищем…");
  try {
    const results = await api.search(cleaned);
    const ranked = pickBestMatch(results, state.pretitle || cleaned, state.anime ? state.anime.year : 0)
      .filter((entry) => entry.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((entry) => ({ ...entry.item, score: entry.score }));
    state.candidates = ranked;
    renderCandidates();
    if (!ranked.length) {
      setError("Ничего не нашлось. Попробуйте другое название.");
      setText("animeSub", "");
      return;
    }
    setText("animeSub", "нашли " + ranked.length + " вариант(ов) — нажмите, чтобы выбрать");
  } catch (error) {
    setError("Поиск не сработал: " + String((error && error.message) || error));
  }
}

async function resolveInitialTitle() {
  if (state.pretitle) return state.pretitle;
  if (!state.source) return "";
  setText("sourceHint", "читаем страницу yummyanime.tv…");
  try {
    const parsed = await fetchYummyTvAnime(state.source, { fetchImpl: appFetch });
    if (parsed.poster && !state.prePoster) state.prePoster = parsed.poster;
    state.parsedTitle = parsed.title;
    if (parsed.title) {
      setText("sourceHint", "со страницы yummyanime.tv");
      return parsed.title;
    }
  } catch (error) {
    log("Не удалось прочитать страницу: " + String((error && error.message) || error), "warn");
  }
  setText("sourceHint", "не удалось прочитать страницу — введите название вручную");
  return "";
}

async function maybeAutorun() {
  if (!state.autorun || state.autorunDone) return;
  state.autorunDone = true;
  await restoreFolder();
  if (!state.directoryHandle && supportsFileSystemAccess()) {
    setError("Папка не выбрана — нажмите «Выбрать папку» и «Скачать», чтобы начать.");
    log("Автозапуск остановлен: нужна папка для сохранения.", "warn");
    return;
  }
  log("Автозапуск: начинаем загрузку.", "ok");
  await startDownloads();
}

async function restoreFolder() {
  try {
    const handle = await idbGet(FOLDER_KEY);
    if (!handle) return;
    if (await ensurePermission(handle, "readwrite")) {
      state.directoryHandle = handle;
      state.folderName = handle.name || "папка";
      setText("folderName", state.folderName);
      const perm = $("folderPermBtn");
      if (perm) perm.hidden = true;
      log("Папка восстановлена: " + state.folderName, "ok");
    } else {
      state.pendingFolderHandle = handle;
      setText("folderName", (handle.name || "папка") + " — нужен доступ");
      const perm = $("folderPermBtn");
      if (perm) perm.hidden = false;
      log("Нужно подтвердить доступ к папке «" + (handle.name || "") + "».", "warn");
    }
  } catch (error) {
    log("Не удалось восстановить папку: " + String((error && error.message) || error), "warn");
  }
}

async function chooseFolder() {
  if (!supportsFileSystemAccess()) {
    setError("Этот браузер не умеет писать напрямую в папку — серии пойдут через «Загрузки» браузера.");
    return;
  }
  try {
    const handle = await pickDirectory({ id: "dav-anime", mode: "readwrite" });
    if (!handle) return;
    state.directoryHandle = handle;
    state.folderName = handle.name || "папка";
    state.runDir = null;
    setText("folderName", state.folderName);
    const perm = $("folderPermBtn");
    if (perm) perm.hidden = true;
    setError("");
    try {
      if (state.settings.rememberFolder) await idbSet(FOLDER_KEY, handle);
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    log("Папка сохранения: " + state.folderName, "ok");
    renderSummary();
  } catch (error) {
    if (!isAbortError(error)) setError("Не удалось выбрать папку: " + String((error && error.message) || error));
  }
}

async function grantFolderPermission() {
  if (!state.pendingFolderHandle) return;
  const granted = await ensurePermission(state.pendingFolderHandle, "readwrite");
  if (!granted) {
    setError("Доступ к папке не выдан.");
    return;
  }
  state.directoryHandle = state.pendingFolderHandle;
  state.pendingFolderHandle = null;
  state.folderName = state.directoryHandle.name || "папка";
  setText("folderName", state.folderName);
  const perm = $("folderPermBtn");
  if (perm) perm.hidden = true;
  log("Доступ к папке подтверждён: " + state.folderName, "ok");
  renderSummary();
}

async function ensureRunDir() {
  if (!state.directoryHandle) return null;
  if (state.runDir) return state.runDir;
  const name = folderNameFor();
  if (!name) {
    state.runDir = state.directoryHandle;
    return state.runDir;
  }
  state.runDir = await state.directoryHandle.getDirectoryHandle(name, { create: true });
  log("Подпапка сохранения: " + name);
  return state.runDir;
}

async function ensureTempDir() {
  if (state.tempDir) return state.tempDir;
  const root = await opfsRoot();
  state.tempDir = await root.getDirectoryHandle(TEMP_DIR, { create: true });
  return state.tempDir;
}

async function clearTempDir() {
  try {
    const root = await opfsRoot();
    await removeEntry(root, TEMP_DIR);
  } catch {
    /* нечего чистить */
  }
  state.tempDir = null;
}

function buildJobs() {
  const jobs = [];
  for (const episode of selectedEpisodeObjects()) {
    const number = episodeKey(episode);
    jobs.push({
      ep: episode,
      number,
      key: number,
      label: episodeLabel(episode),
      status: "wait",
      detail: "в очереди",
      bytes: 0,
      segmentsDone: 0,
      segmentsTotal: 0,
      estimateBytes: estimateEpisodeBytes(episode),
      fileName: null,
      rate: 0,
      eta: 0,
    });
  }
  if (jobs.length >= 10) {
    for (const job of jobs) job.label = pad(job.number, 2);
  }
  return jobs;
}

function watchProgress(job, started) {
  let lastTick = Date.now();
  let lastBytes = 0;
  return (progress) => {
    job.segmentsDone = progress.segmentsDone;
    job.segmentsTotal = progress.segmentsTotal;
    job.bytes = progress.writtenBytes || progress.downloadedBytes;
    job.duration = progress.duration;
    const now = Date.now();
    if (now - lastTick >= 800) {
      const rate = (progress.downloadedBytes - lastBytes) / ((now - lastTick) / 1000);
      if (rate > 0) {
        job.rate = rate;
        job.eta = rate > 0 ? Math.max(0, (job.estimateBytes - job.bytes) / rate) : 0;
        state.measured = { quality: qualityValue(job.quality || state.selectedQuality), rate };
      }
      lastTick = now;
      lastBytes = progress.downloadedBytes;
      updateJobRow(job);
      renderOverall();
    }
  };
}

async function runJob(job, context) {
  const { signal, pause } = context;
  job.startedAt = Date.now();
  job.status = "links";
  job.detail = "получаем ссылку на видео";
  job.error = "";
  updateJobRow(job);

  const links = await fetchKodikLinks(job.ep.url, {
    fetchImpl: appFetch,
    signal,
    retries: 2,
    onLog: (message) => log(message, "kodik"),
  });
  const quality = pickQuality(links.qualities, state.selectedQuality) || state.qualities[0];
  if (!quality) throw new Error("плеер не отдал ни одного качества");
  const playlistUrl = links.qualities[quality];
  job.quality = quality;
  job.fileName = fileNameFor(job);
  job.status = "download";
  job.detail = "скачиваем";
  updateJobRow(job);

  const onProgress = watchProgress(job, job.startedAt);
  const common = {
    playlistUrl,
    fetchImpl: appFetch,
    concurrency: state.settings.concurrency || 4,
    signal,
    pause,
    onProgress,
    onLog: (message) => log("серия " + job.number + ": " + message, "hls"),
  };

  if (context.mode === "zip") {
    const tempDir = await ensureTempDir();
    const stamp = Date.now().toString(36) + "-" + job.number;
    const handle = await tempDir.getFileHandle("ep-" + stamp + ".part", { create: true });
    job.tempName = handle.name;
    const writable = await handle.createWritable();
    const checksum = new Crc32();
    let written = 0;
    const sink = {
      async write(chunk) {
        const data = toUint8(chunk);
        if (!data.byteLength) return;
        checksum.update(data);
        written += data.byteLength;
        await writable.write(data);
      },
      async close() {
        await writable.close();
      },
      async abort() {
        try {
          await writable.abort();
        } catch {
          /* уже закрыт */
        }
      },
    };
    try {
      await downloadHls({ ...common, sink });
    } catch (error) {
      await sink.abort();
      await removeEntry(tempDir, job.tempName);
      job.tempName = null;
      throw error;
    }
    await sink.close();
    job.tempSize = written;
    job.crcValue = checksum.digest();
    job.bytes = written;
    job.status = "ready";
    job.detail = "готово к упаковке в ZIP";
  } else if (state.directoryHandle) {
    const dir = await ensureRunDir();
    const sink = await openFileSink(dir, job.fileName);
    try {
      const result = await downloadHls({ ...common, sink });
      await sink.close();
      job.bytes = result.writtenBytes || result.downloadedBytes;
    } catch (error) {
      await sink.abort();
      await removeEntry(dir, job.fileName);
      throw error;
    }
    job.status = "done";
    job.detail = "сохранено в " + (folderNameFor() || state.folderName);
  } else {
    const sink = new MemorySink();
    try {
      const result = await downloadHls({ ...common, sink });
      await sink.close();
      job.bytes = result.writtenBytes || result.downloadedBytes;
      downloadBlob(sink.toBlob("video/mp4"), job.fileName);
    } finally {
      sink.clear();
    }
    job.status = "done";
    job.detail = "отправлено в загрузки браузера";
  }

  job.elapsed = Date.now() - job.startedAt;
  job.rate = 0;
  job.eta = 0;
  log(`Серия ${job.number}: готово, ${formatBytes(job.bytes)} за ${formatDuration(job.elapsed / 1000)}`, "ok");
}

async function startDownloads() {
  if (state.running) return;
  const group = currentGroup();
  if (!group) {
    setError("Сначала выберите тайтл и озвучку.");
    return;
  }
  if (!group.supported) {
    setError("У этой озвучки видео только в плеере Alloha — скачивание не поддерживается. Выберите другую озвучку.");
    return;
  }
  const episodes = selectedEpisodeObjects();
  if (!episodes.length) {
    setError("Выберите хотя бы одну серию.");
    return;
  }
  if (supportsFileSystemAccess() && !state.directoryHandle) {
    setError("Выберите папку для сохранения — так файлы пишутся сразу на диск.");
    return;
  }
  setError("");
  const settings = await saveSettings({
    quality: state.selectedQuality,
    outputMode: state.mode,
    skipExisting: $("skipExisting") ? $("skipExisting").checked : state.settings.skipExisting,
  });
  state.settings = settings;

  state.running = true;
  state.cancelled = false;
  state.paused = false;
  state.pause = new PauseController();
  state.abort = new AbortController();
  state.runDir = null;
  state.jobs = buildJobs();
  renderJobs();
  updateControls();
  const tempDir = state.mode === "zip" ? await ensureTempDir() : null;
  if (tempDir) log("Временные файлы пишутся в хранилище браузера, готовые серии сразу удаляются.");
  log(
    `Старт: ${episodes.length} серий · озвучка «${group.dubbing}» · качество ${qualityLabel()} · ` +
      (state.mode === "zip" ? "один ZIP-архив" : "отдельные MP4-файлы"),
    "ok"
  );

  for (const job of state.jobs) {
    if (state.abort.signal.aborted) break;
    await state.pause.waitIfPaused();
    if (state.abort.signal.aborted) break;
    const skipCheck = state.mode === "files" && state.directoryHandle && state.settings.skipExisting;
    if (skipCheck) {
      try {
        const dir = await ensureRunDir();
        const size = await getFileSize(dir, fileNameFor(job));
        if (size > 0) {
          job.status = "skip";
          job.bytes = size;
          job.detail = "уже скачано";
          job.elapsed = 0;
          updateJobRow(job);
          renderOverall();
          continue;
        }
      } catch {
        /* просто пробуем скачать */
      }
    }
    try {
      await runJob(job, { mode: state.mode, signal: state.abort.signal, pause: state.pause });
    } catch (error) {
      if (isAbortError(error) || state.abort.signal.aborted) {
        job.status = "cancelled";
        job.detail = "отменено";
      } else {
        job.status = "error";
        job.error = String((error && error.message) || error);
        job.detail = job.error;
        log(`Серия ${job.number}: ошибка — ${job.error}`, "ошибка");
      }
    }
    updateJobRow(job);
    renderOverall();
    if (state.settings.politeDelay) await sleep(state.settings.politeDelay);
  }

  const aborted = state.abort.signal.aborted;
  if (state.mode === "zip" && !aborted) {
    try {
      await buildZip();
    } catch (error) {
      setError("Не удалось собрать ZIP: " + String((error && error.message) || error));
    }
  }
  await clearTempDir();
  state.running = false;
  state.abort = null;
  updateControls();
  renderOverall();
  const failed = state.jobs.filter((job) => job.status === "error").length;
  log(aborted ? "Загрузка остановлена." : failed ? `Готово, но ${failed} серий с ошибкой — нажмите «Повторить серию».` : "Все выбранные серии скачаны.", failed ? "warn" : "ok");
  setText("queueHint", aborted ? "остановлено" : failed ? "с ошибками" : "завершено");
}

async function buildZip() {
  const ready = state.jobs.filter((job) => job.tempName && job.status === "ready");
  if (!ready.length) return;
  const tempDir = await ensureTempDir();
  const zipName = zipNameFor();
  log(`Упаковываем ZIP: ${zipName} (${ready.length} серий)`, "ok");
  let sink;
  let direct = false;
  if (state.directoryHandle) {
    sink = await openFileSink(state.directoryHandle, zipName);
    direct = true;
  } else {
    sink = new MemorySink();
  }
  const writer = new ZipWriter({
    sink,
    onProgress: (count, bytes) => setText("queueHint", `упаковка: ${count}/${ready.length} · ${formatBytes(bytes)}`),
  });
  try {
    for (const job of ready) {
      job.status = "zip";
      job.detail = "добавляем в архив";
      job.bytes = 0;
      updateJobRow(job);
      await writer.addEntry({
        name: job.fileName,
        size: job.tempSize,
        crc: job.crcValue,
        chunks: readFileChunks(tempDir, job.tempName),
      });
      await removeEntry(tempDir, job.tempName);
      job.tempName = null;
      job.status = "done";
      job.detail = "в архиве " + zipName;
      job.bytes = job.tempSize || 0;
      updateJobRow(job);
      renderOverall();
    }
    await writer.close();
  } catch (error) {
    if (direct) await sink.abort();
    throw error;
  }
  await sink.close();
  if (!direct) {
    downloadBlob(sink.toBlob("application/zip"), zipName);
    sink.clear();
  }
  log(`ZIP готов: ${zipName}${direct ? " — в выбранной папке" : " — отправлен в загрузки браузера"}`, "ok");
}

async function retryJob(job) {
  if (state.running) return;
  state.running = true;
  state.pause = new PauseController();
  state.abort = new AbortController();
  updateControls();
  job.status = "wait";
  job.error = "";
  job.bytes = 0;
  job.segmentsDone = 0;
  job.rate = 0;
  job.eta = 0;
  updateJobRow(job);
  try {
    if (state.mode === "files" && state.directoryHandle && state.settings.skipExisting) {
      const dir = await ensureRunDir();
      const size = await getFileSize(dir, fileNameFor(job));
      if (size > 0) {
        job.status = "skip";
        job.bytes = size;
        job.detail = "уже скачано";
        updateJobRow(job);
        return;
      }
    }
    await runJob(job, { mode: state.mode, signal: state.abort.signal, pause: state.pause });
  } catch (error) {
    job.status = isAbortError(error) ? "cancelled" : "error";
    job.error = String((error && error.message) || error);
    job.detail = job.error;
  } finally {
    state.running = false;
    state.abort = null;
    updateJobRow(job);
    renderOverall();
    updateControls();
  }
}

function togglePause() {
  if (!state.running || !state.pause) return;
  if (state.paused) {
    state.pause.resume();
    state.paused = false;
    log("Продолжаем загрузку.", "ok");
  } else {
    state.pause.pause();
    state.paused = true;
    log("Пауза. Текущая серия допишется, следующие ждут.", "warn");
  }
  updateControls();
  renderOverall();
}

function cancelDownloads() {
  if (!state.running) return;
  state.cancelled = true;
  if (state.pause) state.pause.resume();
  if (state.abort) state.abort.abort();
  log("Отменяем загрузку…", "warn");
}

function wireUi() {
  const on = (id, event, handler) => {
    const node = $(id);
    if (node) node.addEventListener(event, handler);
  };
  on("folderBtn", "click", chooseFolder);
  on("folderPermBtn", "click", grantFolderPermission);
  on("startBtn", "click", startDownloads);
  on("pauseBtn", "click", togglePause);
  on("cancelBtn", "click", cancelDownloads);
  on("clearBtn", "click", () => {
    if (state.running) return;
    state.jobs = [];
    renderJobs();
    updateControls();
  });
  on("searchBtn", "click", () => searchAnime($("searchInput") ? $("searchInput").value : ""));
  on("searchInput", "keydown", (event) => {
    if (event.key === "Enter") searchAnime($("searchInput").value);
  });
  on("epApplyBtn", "click", () => {
    const keys = episodesOfGroup().map(episodeKey);
    const parsed = parseSelection($("epInput") ? $("epInput").value : "", keys);
    if (!parsed) {
      setError("Не понял выбор серий. Пример: 1-12,15");
      return;
    }
    setError("");
    state.selectedEpisodes = parsed;
    renderEpisodes();
    renderQualities();
  });
  on("skipExisting", "change", async () => {
    state.settings = await saveSettings({ skipExisting: $("skipExisting").checked });
  });
  on("copyLogBtn", "click", async () => {
    try {
      await navigator.clipboard.writeText(state.logLines.join("\n"));
      log("Журнал скопирован в буфер обмена.");
    } catch {
      log("Не удалось скопировать журнал.", "warn");
    }
  });
  on("permBtn", "click", async () => {
    const origins = [...state.pendingOrigins].map((origin) => origin + "/*");
    try {
      const granted = await chrome.permissions.request({ origins });
      if (granted) {
        state.pendingOrigins.clear();
        const bar = $("permBar");
        if (bar) bar.hidden = true;
        log("Доступ выдан — нажмите «Скачать» ещё раз.", "ok");
      } else {
        log("Доступ не выдан.", "warn");
      }
    } catch (error) {
      log("Не удалось запросить доступ: " + String((error && error.message) || error), "warn");
    }
  });

  for (const chip of document.querySelectorAll("#epChips .chip")) {
    chip.addEventListener("click", () => {
      const keys = episodesOfGroup().map(episodeKey);
      if (!keys.length) return;
      const sorted = [...keys].sort((a, b) => a - b);
      const range = chip.dataset.range;
      if (range === "all") state.selectedEpisodes = new Set(sorted);
      else if (range === "first6") state.selectedEpisodes = new Set(sorted.slice(0, 6));
      else if (range === "last6") state.selectedEpisodes = new Set(sorted.slice(-6));
      else if (range === "invert") {
        const current = new Set(state.selectedEpisodes);
        state.selectedEpisodes = new Set(sorted.filter((key) => !current.has(key)));
      } else if (range === "none") state.selectedEpisodes = new Set();
      renderEpisodes();
      renderQualities();
    });
  }

  for (const chip of document.querySelectorAll("#modeChips .chip")) {
    chip.addEventListener("click", async () => {
      if (state.running) return;
      state.mode = chip.dataset.mode;
      for (const other of document.querySelectorAll("#modeChips .chip")) other.classList.toggle("active", other === chip);
      state.settings = await saveSettings({ outputMode: state.mode });
      renderSummary();
    });
  }
}

async function init() {
  setText("versionEl", "v" + chrome.runtime.getManifest().version);
  state.settings = await loadSettings();
  const skip = $("skipExisting");
  if (skip) skip.checked = !!state.settings.skipExisting;
  if (state.preMode === "zip" || (!state.preMode && state.settings.outputMode === "zip")) {
    state.mode = "zip";
    for (const chip of document.querySelectorAll("#modeChips .chip")) {
      chip.classList.toggle("active", chip.dataset.mode === "zip");
    }
  }
  state.selectedQuality = state.preQuality || state.settings.quality || "max";
  wireUi();
  renderAnime();
  renderDubs();
  renderQualities();
  renderEpisodes();
  renderJobs();
  updateControls();
  if (state.prePoster) updateCandidatePoster(null);
  log("Download anime videos запущен. Только для личного офлайн-просмотра.", "ok");
  if (state.source) log("Источник: " + state.source);

  await restoreFolder();

  try {
    if (state.preAnimeId) {
      await selectAnime(state.preAnimeId);
    } else {
      const title = await resolveInitialTitle();
      if (title) {
        await searchAnime(title);
        if (state.candidates.length) {
          const best = state.candidates[0];
          if (best.score >= 0.55) await selectAnime(best.anime_id);
        }
      } else {
        renderAnime();
        setText("animeTitle", "Выберите тайтл вручную");
        const box = $("searchBox");
        if (box) box.open = true;
      }
    }
  } catch (error) {
    setError("Не удалось определить тайтл: " + String((error && error.message) || error));
  }
  renderSummary();
}

init();
