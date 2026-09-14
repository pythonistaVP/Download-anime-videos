import { withRetry, abortError, toUint8 } from "./util.js";

export function parseAttributes(text) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match = null;
  while ((match = regex.exec(text))) {
    const key = match[1];
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[key] = value;
  }
  return attrs;
}

export function parsePlaylist(text, playlistUrl) {
  const base = new URL(playlistUrl);
  const lines = String(text || "").split(/\r?\n/);

  if (lines.some((line) => line.trim().startsWith("#EXT-X-STREAM-INF"))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
      const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
      const next = lines.slice(i + 1).find((candidate) => candidate.trim() && !candidate.trim().startsWith("#"));
      if (!next) continue;
      variants.push({
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION || "",
        height: Number((attrs.RESOLUTION || "").split("x")[1]) || 0,
        url: new URL(next.trim(), base).href,
      });
    }
    return { type: "master", variants };
  }

  const segments = [];
  let duration = 0;
  let pendingDuration = 0;
  let encrypted = false;
  let initSegment = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY")) {
      if (!/METHOD=NONE/i.test(line)) encrypted = true;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
      if (attrs.URI) initSegment = new URL(attrs.URI, base).href;
      continue;
    }
    if (line.startsWith("#")) continue;
    segments.push({ url: new URL(line, base).href, duration: pendingDuration });
    duration += pendingDuration;
    pendingDuration = 0;
  }

  return { type: "media", segments, duration, encrypted, initSegment };
}

export function pickVariant(variants, wantedHeight) {
  const sorted = [...variants].sort((a, b) => (a.height || 0) - (b.height || 0));
  if (!sorted.length) return null;
  const height = Number(wantedHeight) || 0;
  if (!height) return sorted[sorted.length - 1];
  const lower = sorted.filter((variant) => (variant.height || 0) <= height);
  return lower.length ? lower[lower.length - 1] : sorted[0];
}

export async function downloadHls(options) {
  const {
    playlistUrl,
    sink,
    fetchImpl = globalThis.fetch,
    muxjs = globalThis.muxjs,
    concurrency = 4,
    onProgress = () => {},
    onLog = () => {},
    signal = null,
    pause = null,
    retries = 3,
    maxHeight = 0,
    depth = 0,
  } = options;

  if (!sink || typeof sink.write !== "function") throw new Error("Не задан приёмник данных");

  const playlistText = await withRetry(
    async () => {
      const response = await fetchImpl(playlistUrl, { signal });
      if (!response.ok) throw new Error("Плейлист: HTTP " + response.status);
      return response.text();
    },
    { retries, baseDelay: 600, signal, onRetry: (e) => onLog("Плейлист: повтор (" + e.message + ")") }
  );

  const playlist = parsePlaylist(playlistText, playlistUrl);

  if (playlist.type === "master") {
    if (depth > 3) throw new Error("Слишком много уровней плейлиста");
    const variant = pickVariant(playlist.variants, maxHeight);
    if (!variant) throw new Error("В плейлисте нет видео-дорожек");
    return downloadHls({ ...options, playlistUrl: variant.url, depth: depth + 1 });
  }

  if (playlist.encrypted) throw new Error("Поток зашифрован (AES-128) — расширение не умеет его качать");
  if (!playlist.segments.length) throw new Error("Плейлист пуст — видео недоступно");

  const total = playlist.segments.length;
  let processed = 0;
  let downloadedBytes = 0;
  let writtenBytes = 0;
  const results = new Map();
  let nextIndex = 0;
  let failure = null;

  const useTransmuxer = !playlist.initSegment;
  if (useTransmuxer && !muxjs) throw new Error("Не загружен модуль сборки MP4 (mux.js)");

  const pendingParts = [];
  let initWritten = false;
  const transmuxer = useTransmuxer ? new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true }) : null;
  if (transmuxer) transmuxer.on("data", (part) => pendingParts.push(part));
  else {
    const initBuffer = await withRetry(
      async () => {
        const response = await fetchImpl(playlist.initSegment, { signal });
        if (!response.ok) throw new Error("Init-сегмент: HTTP " + response.status);
        return new Uint8Array(await response.arrayBuffer());
      },
      { retries, baseDelay: 600, signal }
    );
    await sink.write(initBuffer);
    writtenBytes += initBuffer.byteLength;
  }

  const fetchSegment = (index) =>
    withRetry(
      async () => {
        const response = await fetchImpl(playlist.segments[index].url, { signal });
        if (!response.ok) throw new Error("Сегмент " + (index + 1) + ": HTTP " + response.status);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (!buffer.byteLength) throw new Error("Сегмент " + (index + 1) + " пустой");
        return buffer;
      },
      {
        retries,
        baseDelay: 700,
        signal,
        onRetry: (error, attempt) =>
          onLog("Сегмент " + (index + 1) + " — повтор " + attempt + " (" + error.message + ")"),
      }
    );

  const emit = async (index, buffer) => {
    downloadedBytes += buffer.byteLength;
    if (transmuxer) {
      pendingParts.length = 0;
      transmuxer.push(buffer);
      transmuxer.flush();
      for (const part of pendingParts) {
        if (part.initSegment && !initWritten) {
          initWritten = true;
          const init = toUint8(part.initSegment);
          await sink.write(init);
          writtenBytes += init.byteLength;
        }
        if (part.data && part.data.byteLength) {
          const data = toUint8(part.data);
          await sink.write(data);
          writtenBytes += data.byteLength;
        }
      }
    } else {
      await sink.write(buffer);
      writtenBytes += buffer.byteLength;
    }
    processed++;
    onProgress({
      segmentsDone: processed,
      segmentsTotal: total,
      duration: playlist.duration,
      downloadedBytes,
      writtenBytes,
    });
  };

  const worker = async () => {
    while (true) {
      if (failure) return;
      if (signal && signal.aborted) throw abortError();
      if (pause) await pause.waitIfPaused();
      if (failure) return;
      if (signal && signal.aborted) throw abortError();
      const index = nextIndex++;
      if (index >= total) return;
      let buffer;
      try {
        buffer = await fetchSegment(index);
      } catch (error) {
        if (!failure) failure = error;
        return;
      }
      results.set(index, buffer);
      try {
        while (results.has(processed)) {
          const ready = results.get(processed);
          results.delete(processed);
          await emit(processed, ready);
        }
      } catch (error) {
        if (!failure) failure = error;
        return;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failure) throw failure;

  return {
    segments: total,
    duration: playlist.duration,
    downloadedBytes,
    writtenBytes,
    transmuxed: useTransmuxer,
  };
}
