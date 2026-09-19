export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function formatBytes(bytes, decimals = 1) {
  if (bytes === null || bytes === undefined || !isFinite(bytes)) return "—";
  if (bytes < 1024) return bytes + " Б";
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(value >= 100 ? 0 : decimals) + " " + units[unit];
}

export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return formatBytes(bytesPerSecond) + "/с";
}

export function sanitizeFilename(name, fallback = "video") {
  let out = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out || fallback;
}

export function renderTemplate(template, vars) {
  return String(template || "").replace(/\{(\w+)(?::(\d+))?\}/g, (match, key, width) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const value = vars[key] == null ? "" : String(vars[key]);
    if (width && /^\d+$/.test(value)) return value.padStart(Number(width), "0");
    return value;
  });
}

export function normalizeText(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenList(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

export function tokenOverlap(a, b) {
  const setA = new Set(tokenList(a));
  const setB = new Set(tokenList(b));
  if (!setA.size || !setB.size) return 0;
  let hits = 0;
  for (const token of setA) if (setB.has(token)) hits++;
  const coverage = hits / Math.min(setA.size, setB.size);
  const balance = hits / Math.max(setA.size, setB.size);
  return 0.65 * coverage + 0.35 * balance;
}

export function toUint8(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk);
}

export function concatChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function hashString(input) {
  const text = String(input == null ? "" : input);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function abortError(message = "Операция отменена") {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
  }
}

export function isAbortError(error) {
  return !!error && (error.name === "AbortError" || /aborted|отмен/i.test(String(error.message)));
}

export function isRateLimitError(error) {
  if (!error) return false;
  if (error.status === 429 || error.status === 403 || error.status === 503) return true;
  return /HTTP (429|403|503)\b/.test(String(error.message || ""));
}

export class PauseController {
  constructor() {
    this.paused = false;
    this.waiters = [];
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const resolve of waiters) resolve();
  }

  async waitIfPaused() {
    if (!this.paused) return;
    await new Promise((resolve) => this.waiters.push(resolve));
  }
}

export async function withRetry(fn, options = {}) {
  const { retries = 3, baseDelay = 700, maxDelay = 8000, onRetry = null, signal = null, isFatal = null } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) throw error;
      if (isFatal && isFatal(error)) throw error;
      if (attempt >= retries) break;
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      if (onRetry) onRetry(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

const CRC_TABLES = (() => {
  const tables = [];
  for (let n = 0; n < 8; n++) tables.push(new Uint32Array(256));
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[0][i] = c >>> 0;
  }
  for (let n = 1; n < 8; n++) {
    for (let i = 0; i < 256; i++) {
      const prev = tables[n - 1][i];
      tables[n][i] = (tables[0][prev & 0xff] ^ (prev >>> 8)) >>> 0;
    }
  }
  return tables;
})();

export class Crc32 {
  constructor() {
    this.value = 0xffffffff;
  }

  update(data) {
    const bytes = toUint8(data);
    const len = bytes.length;
    let crc = this.value;
    let i = 0;
    for (; i + 8 <= len; i += 8) {
      crc ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
      crc =
        (CRC_TABLES[7][crc & 0xff] ^
          CRC_TABLES[6][(crc >>> 8) & 0xff] ^
          CRC_TABLES[5][(crc >>> 16) & 0xff] ^
          CRC_TABLES[4][(crc >>> 24) & 0xff] ^
          CRC_TABLES[3][bytes[i + 4]] ^
          CRC_TABLES[2][bytes[i + 5]] ^
          CRC_TABLES[1][bytes[i + 6]] ^
          CRC_TABLES[0][bytes[i + 7]]) >>>
        0;
    }
    for (; i < len; i++) crc = (CRC_TABLES[0][(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    this.value = crc >>> 0;
    return this;
  }

  digest() {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

export function crc32(data) {
  return new Crc32().update(data).digest();
}

export function createLimiter(concurrency) {
  let limit = Math.max(1, Number(concurrency) || 1);
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  const limiter = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  limiter.setLimit = (value) => {
    const parsed = Math.max(1, Number(value) || 1);
    if (parsed === limit) return;
    limit = parsed;
    next();
  };
  limiter.getLimit = () => limit;
  limiter.active = () => active;
  limiter.pending = () => queue.length;
  return limiter;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
