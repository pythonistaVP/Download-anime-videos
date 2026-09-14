const SITE_PATTERN = /^https?:\/\/([^/]+\.)?yummyanime\.tv(\/|$)/i;
const ANIME_PATH = /(?:^|\/)(\d+)-[^/]*\.html(?:$|[?#])/;

const siteTitle = document.getElementById("siteTitle");
const siteSub = document.getElementById("siteSub");
const siteCard = document.getElementById("siteCard");
const openBtn = document.getElementById("openBtn");
const urlInput = document.getElementById("urlInput");
const parseBtn = document.getElementById("parseBtn");
const errorEl = document.getElementById("error");
const versionEl = document.getElementById("version");

versionEl.textContent = "v" + (chrome.runtime.getManifest().version || "1.0.0");

let activeTab = null;

function showError(message) {
  errorEl.textContent = message || "";
  errorEl.hidden = !message;
}

function openManager(params) {
  chrome.runtime.sendMessage({ type: "dav:openManager", params }, (response) => {
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      showError(lastError.message);
      return;
    }
    if (!response || !response.ok) {
      showError((response && response.error) || "Не удалось открыть менеджер");
      return;
    }
    window.close();
  });
}

function describeTab(tab) {
  if (!tab || !tab.url || !SITE_PATTERN.test(tab.url)) {
    siteCard.className = "card warn";
    siteTitle.textContent = "Откройте страницу аниме на yummyanime.tv";
    siteSub.textContent = "Расширение работает только на этом сайте. Можно вставить ссылку вручную ниже.";
    openBtn.disabled = true;
    return;
  }
  if (!ANIME_PATH.test(new URL(tab.url).pathname)) {
    siteCard.className = "card warn";
    siteTitle.textContent = tab.title || "Страница yummyanime.tv";
    siteSub.textContent = "Это не страница аниме — откройте нужный тайтл, или вставьте ссылку вручную.";
    openBtn.disabled = false;
    return;
  }
  siteCard.className = "card ok";
  siteTitle.textContent = tab.title || "Страница аниме";
  siteSub.textContent = "Страница аниме найдена — можно открывать менеджер";
  openBtn.disabled = false;
  chrome.tabs.sendMessage(tab.id, { type: "dav:context" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) return;
    const context = response.context || {};
    if (context.title) siteTitle.textContent = context.title;
    if (context.altTitle) siteSub.textContent = context.altTitle + " · страница аниме найдена";
  });
}

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs && tabs[0] ? tabs[0] : null;
  describeTab(activeTab);

  openBtn.addEventListener("click", () => {
    const params = { source: (activeTab && activeTab.url) || "", autorun: "1" };
    const title = siteTitle.textContent;
    if (title) params.title = title;
    openManager(params);
  });

  parseBtn.addEventListener("click", () => {
    showError("");
    const value = urlInput.value.trim();
    if (!value) {
      showError("Вставьте ссылку на страницу аниме");
      return;
    }
    let url = value;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const idMatch = url.match(ANIME_PATH);
    if (!idMatch) {
      showError("Не похоже на ссылку yummyanime.tv — нужна страница аниме");
      return;
    }
    openManager({ source: url.split("#")[0], autorun: "1" });
  });

  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") parseBtn.click();
  });
}

init();
