const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\u00ab",
  raquo: "\u00bb",
  hellip: "\u2026",
  deg: "\u00b0",
  times: "\u00d7",
  middot: "\u00b7",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function fromCode(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function decodeEntities(text) {
  return String(text == null ? "" : text)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, dec) => fromCode(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const key = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
    });
}

export function stripTags(html) {
  return decodeEntities(String(html == null ? "" : html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function attr(tag, name) {
  const match = String(tag || "").match(
    new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>\"']+))", "i")
  );
  if (!match) return null;
  return decodeEntities(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
}

export function metaMap(html) {
  const out = {};
  const regex = /<meta\b[^>]*>/gi;
  let match = null;
  while ((match = regex.exec(html))) {
    const tag = match[0];
    const key = attr(tag, "name") || attr(tag, "property") || attr(tag, "itemprop");
    const content = attr(tag, "content");
    if (!key || content == null) continue;
    if (out[key] === undefined) out[key] = content;
    const lower = key.toLowerCase();
    if (out[lower] === undefined) out[lower] = content;
  }
  return out;
}

function matchText(html, regexes) {
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match) {
      const text = stripTags(match[1]);
      if (text) return text;
    }
  }
  return "";
}

function absolute(url, base) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return "https:" + text;
  try {
    return new URL(text, base || undefined).href;
  } catch {
    return text;
  }
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/\s*[—|-]\s*смотреть[\s\S]*$/i, "")
    .replace(/\s*смотреть\s+аниме[\s\S]*$/i, "")
    .replace(/\s*на\s+YummyAnime[\s\S]*$/i, "")
    .trim();
}

function yearFrom(html, meta, fallbacks = []) {
  const published = meta.datePublished || meta["article:published_time"] || "";
  const publishedYear = String(published).match(/(19|20)\d{2}/);
  if (publishedYear) return Number(publishedYear[0]);
  for (const regex of fallbacks) {
    const match = html.match(regex);
    if (match) {
      const year = Number(match[1]);
      if (year > 1900 && year < 2200) return year;
    }
  }
  const generic = html.match(/Год\s*выхода[\s\S]{0,240}?((?:19|20)\d{2})/i);
  return generic ? Number(generic[1]) : 0;
}

const YEAR_REGEXES = [
  /Год\s*выхода[\s\S]{0,240}?((?:19|20)\d{2})/i,
  /Год:\s*<\/span>[\s\S]{0,120}?((?:19|20)\d{2})/i,
];

export function parseTvPage(html, url) {
  const meta = metaMap(html);
  const title =
    matchText(html, [
      /<h1[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i,
      /<div[^>]*class=["'][^"']*inner-page__title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ||
    cleanTitle(meta["og:title"]) ||
    cleanTitle(meta.title) ||
    stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const altTitle =
    matchText(html, [
      /<[^>]*itemprop=["']alternativeHeadline["'][^>]*>([\s\S]*?)<\//i,
      /<div[^>]*class=["'][^"']*inner-page__subtitle[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ]) || "";
  const posterLink = (html.match(/<link\b[^>]*itemprop=["']url contentUrl["'][^>]*>/i) || [])[0];
  const poster = absolute(attr(posterLink || "", "href") || meta["og:image"] || "", url);
  return {
    siteId: "yummyanime.tv",
    siteLabel: "YummyAnime.TV",
    title,
    altTitle,
    poster,
    year: yearFrom(html, meta, YEAR_REGEXES),
    animeId: 0,
    animeAlias: "",
  };
}

export function parseYaniPage(html, url) {
  const meta = metaMap(html);
  const animeId = Number(meta.page_id || meta["page_id"] || 0) || 0;
  const alias = String(meta.anime_alias || "").trim();
  const title =
    matchText(html, [
      /<h1[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i,
      /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ||
    cleanTitle(meta["og:title"]) ||
    cleanTitle(stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""));
  const altList = html.match(/<ul[^>]*class=["'][^"']*alt-names-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  let altTitle = "";
  if (altList) {
    const first = altList[1].match(/<li[^>]*>([\s\S]*?)<\/li>/i);
    if (first && !/more-alt-names/.test(first[0])) altTitle = stripTags(first[1]);
  }
  return {
    siteId: "yummyani.me",
    siteLabel: "YummyAni (старый дизайн)",
    title,
    altTitle,
    poster: absolute(meta["og:image"], url),
    year: yearFrom(html, meta, YEAR_REGEXES),
    animeId,
    animeAlias: alias,
  };
}

export function parseGenericPage(html, url) {
  const meta = metaMap(html);
  const title =
    cleanTitle(meta["og:title"]) ||
    matchText(html, [/<h1[^>]*>([\s\S]*?)<\/h1>/i]) ||
    cleanTitle(stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""));
  return {
    siteId: "generic",
    siteLabel: url ? safeHost(url) : "другой сайт",
    title,
    altTitle: "",
    poster: absolute(meta["og:image"] || meta["twitter:image"], url),
    year: yearFrom(html, meta, YEAR_REGEXES),
    animeId: 0,
    animeAlias: "",
  };
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "другой сайт";
  }
}

export const SITES = [
  {
    id: "yummyanime.tv",
    label: "YummyAnime.TV",
    host: /^https?:\/\/(?:[^/]+\.)?yummyanime\.tv(?:\/|$)/i,
    animePage: /(?:^|\/)(?:\d+-[^/?#]+\.html|anime\/[\w-]{2,}(?:\.html)?)(?:$|[?#])/i,
    idIsApiId: false,
    animeIdFromUrl: () => 0,
    parse: parseTvPage,
  },
  {
    id: "yummyani.me",
    label: "YummyAni (старый дизайн)",
    host: /^https?:\/\/(?:[^/]+\.)?(?:yummyani\.me|yani\.tv)(?:\/|$)/i,
    animePage: /(?:^|\/)(?:catalog\/item\/[^/?#]+|anime\/[\w-]{2,}|a\d+)(?:$|[?#/])/i,
    idIsApiId: true,
    animeIdFromUrl: (url) => {
      const match = String(url || "").match(/\/a(\d+)(?:$|[?#/])/);
      return match ? Number(match[1]) : 0;
    },
    parse: parseYaniPage,
  },
];

export function detectSite(url) {
  const text = String(url || "");
  return SITES.find((site) => site.host.test(text)) || null;
}

export function isKnownSite(url) {
  return !!detectSite(url);
}

export function isAnimePageUrl(url) {
  const site = detectSite(url);
  if (!site) return false;
  return site.animePage.test(String(url || ""));
}

export function parsePage(html, url) {
  const site = detectSite(url);
  const parsed = site ? site.parse(html, url) : parseGenericPage(html, url);
  if (!parsed.title && site) {
    const generic = parseGenericPage(html, url);
    if (generic.title) parsed.title = generic.title;
    if (!parsed.poster) parsed.poster = generic.poster;
  }
  return parsed;
}

export function pageAnimeId(url, parsed) {
  const site = detectSite(url);
  if (!site) return 0;
  if (site.idIsApiId) {
    const fromUrl = site.animeIdFromUrl(url);
    if (fromUrl) return fromUrl;
    if (parsed && parsed.animeId) return parsed.animeId;
  }
  return 0;
}

export const PLAYER_KINDS = [
  { kind: "kodik", label: "Kodik", re: /kodik/i, href: /kodik/i },
  { kind: "alloha", label: "Alloha", re: /alloha|apbugall/i, href: /alloha|apbugall/i },
  { kind: "aniboom", label: "AniBoom", re: /aniboom|aniliberty|anilibria/i, href: /aniboom/i },
  { kind: "sibnet", label: "Sibnet", re: /sibnet/i, href: /sibnet/i },
  { kind: "vk", label: "VK Видео", re: /vk\.com\/video_ext|vkvideo\.ru\/video_ext/i, href: /vk\.com\/video_ext|vkvideo\.ru\/video_ext/i },
  { kind: "videocdn", label: "VideoCDN", re: /videocdn|vcdns/i, href: /videocdn/i },
  { kind: "dzen", label: "Дзен", re: /dzen\.ru\/video/i, href: /dzen\.ru/i },
  { kind: "ok", label: "Одноклассники", re: /ok\.ru\/video/i, href: /ok\.ru\/video/i },
];

export function playerKind(url) {
  const text = String(url || "");
  return PLAYER_KINDS.find((entry) => entry.href.test(text)) || null;
}

export function describePlayer(url) {
  const entry = playerKind(url);
  return entry ? entry.label : "встроенный плеер";
}

export function playerDownloadable(url) {
  const entry = playerKind(url);
  return !!entry && entry.kind === "kodik";
}
