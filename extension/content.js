(() => {
  "use strict";

  if (document.getElementById("dav-extension-root")) return;

  const SITE_URL = "https://github.com/pythonistaVP/Download-anime-videos";
  const DEV_URL = "https://github.com/pythonistaVP/";
  const BITRATE = { 360: 52 * 1024, 480: 74 * 1024, 720: 112 * 1024 };
  const FALLBACK_EPISODES = /(?:^|\/)(\d+)-[^/]*\.html(?:$|[?#])/;

  function isAnimePage() {
    if (!FALLBACK_EPISODES.test(location.pathname)) return false;
    return !!document.querySelector('.inner-page__player, [itemprop="name"]');
  }

  function readContext() {
    const pick = (selector, attribute) => {
      const node = document.querySelector(selector);
      if (!node) return "";
      if (attribute) return node.getAttribute(attribute) || "";
      return (node.textContent || "").trim();
    };
    const posterNode = document.querySelector('link[itemprop="url contentUrl"]');
    const h1 = pick('[itemprop="name"]') || pick(".inner-page__title h1") || document.title;
    const alt = pick('[itemprop="alternativeHeadline"]');
    return {
      source: location.href.split("#")[0],
      title: h1,
      altTitle: alt,
      poster: posterNode ? new URL(posterNode.getAttribute("href"), location.origin).href : "",
    };
  }

  function send(type, params) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, params }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || "Неизвестная ошибка расширения"));
          return;
        }
        resolve(response.result);
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "dav:context") return;
    const context = readContext();
    sendResponse({ ok: true, context: { ...context, animePage: isAnimePage() } });
    return true;
  });

  function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return "—";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index++;
    }
    return value.toFixed(value >= 100 ? 0 : 1) + " " + units[index];
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours) return hours + " ч " + minutes + " мин";
    return minutes + " мин";
  }

  function parseEpisodeSelection(text, numbers) {
    const value = String(text || "").trim().toLowerCase();
    if (!value || value === "all" || value === "все") return new Set(numbers);
    const result = new Set();
    for (const part of value.replace(/\s+/g, "").split(",")) {
      if (!part) continue;
      if (part.includes("-")) {
        const [from, to] = part.split("-");
        const start = Number(from) || Math.min(...numbers);
        const end = Number(to) || Math.max(...numbers);
        for (let i = start; i <= end; i++) result.add(i);
      } else {
        const single = Number(part);
        if (Number.isFinite(single)) result.add(single);
      }
    }
    const keep = new Set([...result].filter((n) => numbers.includes(n)));
    return keep.size ? keep : new Set(numbers);
  }

  const state = {
    context: readContext(),
    groups: [],
    anime: null,
    selectedDub: "",
    qualities: [],
    selectedQuality: "max",
    probeError: "",
    loading: false,
    error: "",
    estimate: "",
  };

  const host = document.createElement("div");
  host.id = "dav-extension-root";
  host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483000;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Segoe UI", Roboto, Arial, sans-serif; }
      .launcher {
        display: flex; align-items: center; gap: 8px;
        background: linear-gradient(135deg, #e0457b, #7b3fe4);
        color: #fff; border: none; border-radius: 999px; padding: 12px 18px;
        font-size: 14px; font-weight: 600; cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
      }
      .launcher:hover { filter: brightness(1.08); }
      .launcher .dot { width: 8px; height: 8px; border-radius: 50%; background: #7CFC9B; }
      .panel {
        position: absolute; right: 0; bottom: 58px; width: 372px; max-width: 92vw;
        background: #17181d; color: #e8e8ee; border: 1px solid #2c2e38;
        border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.55); overflow: hidden;
      }
      .panel[hidden] { display: none; }
      .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #262832; }
      .head b { font-size: 14px; letter-spacing: .2px; }
      .head .close { background: none; border: none; color: #9aa0b4; font-size: 18px; cursor: pointer; line-height: 1; }
      .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; max-height: 62vh; overflow: auto; }
      .notice { background: #2a2029; border: 1px solid #4a2c3c; color: #f0b6cd; font-size: 11.5px; line-height: 1.45; padding: 8px 10px; border-radius: 9px; }
      .row { display: flex; flex-direction: column; gap: 4px; }
      .row label { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #8d93a8; }
      select, input[type="text"] {
        width: 100%; background: #101116; color: #e8e8ee; border: 1px solid #2f313c;
        border-radius: 8px; padding: 8px 9px; font-size: 13px;
      }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip { background: #101116; border: 1px solid #2f313c; color: #c9cede; border-radius: 999px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
      .chip.active { background: #e0457b; border-color: #e0457b; color: #fff; }
      .info { font-size: 11.5px; color: #9aa0b4; line-height: 1.5; }
      .actions { display: flex; gap: 8px; }
      .btn { flex: 1; border: none; border-radius: 9px; padding: 10px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
      .btn.primary { background: linear-gradient(135deg, #e0457b, #7b3fe4); color: #fff; }
      .btn.ghost { background: #22242d; color: #d5d9e6; border: 1px solid #333643; }
      .btn[disabled] { opacity: .55; cursor: default; }
      .err { color: #ff9aa9; font-size: 12px; }
      .foot { padding: 10px 14px; border-top: 1px solid #262832; font-size: 11px; color: #7d8397; display: flex; justify-content: space-between; }
      .foot a { color: #9db9ff; text-decoration: none; }
      .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #565b70; border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <button class="launcher" id="dav-launcher"><span class="dot"></span>Скачать сезон</button>
    <div class="panel" id="dav-panel" hidden>
      <div class="head">
        <b>Download anime videos</b>
        <button class="close" id="dav-close" title="Закрыть">×</button>
      </div>
      <div class="body">
        <div class="notice">Расширение создано только для скачивания аниме себе в дорогу — для личного офлайн-просмотра. Пожалуйста, не выкладывайте скачанные файлы в открытый доступ.</div>
        <div class="row">
          <label>Озвучка / перевод</label>
          <select id="dav-dub"><option>Загрузка…</option></select>
        </div>
        <div class="row">
          <label>Качество</label>
          <div class="chips" id="dav-quality"></div>
        </div>
        <div class="row">
          <label>Серии</label>
          <input type="text" id="dav-episodes" value="все" />
          <div class="chips">
            <span class="chip" data-range="all">все серии</span>
            <span class="chip" data-range="first6">первые 6</span>
            <span class="chip" data-range="last6">последние 6</span>
          </div>
        </div>
        <div class="row">
          <label>Как сохранить</label>
          <div class="chips" id="dav-mode">
            <span class="chip active" data-mode="files">отдельными файлами</span>
            <span class="chip" data-mode="zip">одним ZIP</span>
          </div>
        </div>
        <div class="info" id="dav-info"></div>
        <div class="err" id="dav-error"></div>
        <div class="actions">
          <button class="btn primary" id="dav-download">Скачать</button>
          <button class="btn ghost" id="dav-open">Менеджер</button>
        </div>
      </div>
      <div class="foot">
        <span>Только для yummyanime.tv</span>
        <span><a href="${SITE_URL}" target="_blank" rel="noreferrer">GitHub</a></span>
      </div>
    </div>
  `;

  const el = (id) => shadow.getElementById(id);
  const launcher = el("dav-launcher");
  const panel = el("dav-panel");
  const dubSelect = el("dav-dub");
  const qualityBox = el("dav-quality");
  const episodesInput = el("dav-episodes");
  const modeBox = el("dav-mode");
  const infoEl = el("dav-info");
  const errorEl = el("dav-error");
  const downloadBtn = el("dav-download");
  const openBtn = el("dav-open");

  let mode = "files";

  function currentGroup() {
    return state.groups.find((group) => group.dubbing === state.selectedDub) || null;
  }

  function episodeNumbers() {
    const group = currentGroup();
    if (!group) return [];
    return group.episodes.map((episode) => Number(String(episode.number).replace(/[^\d]/g, "")) || episode.index + 1);
  }

  function selectedEpisodes() {
    const group = currentGroup();
    if (!group) return [];
    const numbers = episodeNumbers();
    const keep = parseEpisodeSelection(episodesInput.value, numbers);
    return group.episodes.filter((episode, index) => keep.has(numbers[index]));
  }

  function estimateSize(episodes) {
    const bitrate = BITRATE[state.selectedQuality] || BITRATE[720];
    const seconds = episodes.reduce((sum, episode) => sum + (Number(episode.duration) || 1440), 0);
    return seconds * bitrate;
  }

  function render() {
    const group = currentGroup();
    const episodes = selectedEpisodes();
    const numbers = episodeNumbers();
    dubSelect.innerHTML = "";
    for (const item of state.groups) {
      const option = document.createElement("option");
      option.value = item.dubbing;
      option.textContent = item.supported
        ? `${item.dubbing} — ${item.episodes.length} сер.`
        : `${item.dubbing} — только Alloha (недоступно)`;
      option.disabled = !item.supported;
      dubSelect.appendChild(option);
    }
    if (group) dubSelect.value = group.dubbing;

    qualityBox.innerHTML = "";
    const qualities = state.qualities.length ? state.qualities : [360, 480, 720];
    const options = [{ value: "max", label: "максимум" }, ...qualities.map((q) => ({ value: String(q), label: q + "p" }))];
    for (const option of options) {
      const chip = document.createElement("span");
      chip.className = "chip" + (String(state.selectedQuality) === option.value ? " active" : "");
      chip.textContent = option.label;
      chip.addEventListener("click", () => {
        state.selectedQuality = option.value;
        render();
      });
      qualityBox.appendChild(chip);
    }

    if (group) {
      const total = episodes.length;
      const size = estimateSize(episodes);
      const range = numbers.length ? `${Math.min(...numbers)}–${Math.max(...numbers)}` : "—";
      infoEl.innerHTML = `Серий в озвучке: <b>${group.episodes.length}</b> (${range})<br>
        Выбрано: <b>${total}</b> · примерно <b>${formatBytes(size)}</b><br>
        ${state.probeError ? "Качество: " + state.probeError : "Доступное качество: " + (state.qualities.length ? state.qualities.join(", ") + "p" : "неизвестно")}`;
    } else {
      infoEl.textContent = "";
    }
    errorEl.textContent = state.error || "";

    downloadBtn.disabled = state.loading || !group;
    openBtn.disabled = state.loading;
    downloadBtn.textContent = state.loading ? "Загрузка…" : "Скачать";
  }

  async function loadDubs() {
    state.loading = true;
    state.error = "";
    render();
    try {
      const resolved = await send("dav:resolve", { ...state.context });
      if (!resolved.anime) throw new Error("Не удалось найти это аниме в базе. Откройте менеджер и выберите тайтл вручную.");
      state.anime = resolved.anime;
      const data = await send("dav:dubs", { animeId: resolved.anime.anime_id });
      state.groups = (data.groups || []).filter((group) => group.supported);
      if (!state.groups.length) throw new Error("Для этого аниме нет озвучек в поддерживаемом плеере.");
      state.selectedDub = state.groups[0].dubbing;
      await loadQualities();
    } catch (error) {
      state.error = String((error && error.message) || error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadQualities() {
    state.qualities = [];
    state.probeError = "";
    const group = currentGroup();
    if (!group || !group.episodes.length) return;
    try {
      const probe = await send("dav:probe", { url: group.episodes[0].url });
      state.qualities = (probe && probe.available) || [];
    } catch (error) {
      state.probeError = "не удалось определить (" + String((error && error.message) || error) + ")";
    }
  }

  function collectParams(autorun) {
    const group = currentGroup();
    const episodes = selectedEpisodes();
    const numbers = episodes
      .map((episode) => Number(String(episode.number).replace(/[^\d]/g, "")) || episode.index + 1)
      .sort((a, b) => a - b);
    const all = numbers.length === group.episodes.length;
    return {
      source: state.context.source,
      title: state.anime ? state.anime.title : state.context.title,
      animeId: state.anime ? state.anime.anime_id : "",
      poster: state.anime ? state.anime.poster : state.context.poster,
      dub: group.dubbing,
      quality: String(state.selectedQuality),
      mode,
      episodes: all ? "all" : numbers.join(","),
      autorun: autorun ? "1" : "",
    };
  }

  launcher.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !state.groups.length && !state.loading) loadDubs();
  });

  el("dav-close").addEventListener("click", () => {
    panel.hidden = true;
  });

  dubSelect.addEventListener("change", async () => {
    state.selectedDub = dubSelect.value;
    await loadQualities();
    render();
  });

  episodesInput.addEventListener("input", render);

  for (const chip of shadow.querySelectorAll(".chip[data-range]")) {
    chip.addEventListener("click", () => {
      const numbers = episodeNumbers();
      if (!numbers.length) return;
      const sorted = [...numbers].sort((a, b) => a - b);
      const range = chip.dataset.range;
      if (range === "all") episodesInput.value = "все";
      else if (range === "first6") episodesInput.value = sorted.slice(0, 6).join(",");
      else episodesInput.value = sorted.slice(-6).join(",");
      render();
    });
  }

  for (const chip of shadow.querySelectorAll(".chip[data-mode]")) {
    chip.addEventListener("click", () => {
      mode = chip.dataset.mode;
      for (const other of shadow.querySelectorAll(".chip[data-mode]")) other.classList.toggle("active", other === chip);
    });
  }

  downloadBtn.addEventListener("click", async () => {
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    render();
    try {
      await send("dav:openManager", { params: collectParams(true) });
      panel.hidden = true;
    } catch (error) {
      state.error = String((error && error.message) || error);
    } finally {
      state.loading = false;
      render();
    }
  });

  openBtn.addEventListener("click", async () => {
    try {
      await send("dav:openManager", { params: collectParams(false) });
    } catch (error) {
      state.error = String((error && error.message) || error);
      render();
    }
  });

  if (!isAnimePage()) {
    host.remove();
    return;
  }

  render();
})();
