import { toUint8 } from "./util.js";

export class StreamSink {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.onBytes = options.onBytes || null;
    this.bytes = 0;
    this.closed = false;
  }

  async write(chunk) {
    const data = toUint8(chunk);
    if (!data.byteLength) return;
    await this.stream.write(data);
    this.bytes += data.byteLength;
    if (this.onBytes) this.onBytes(data.byteLength);
  }

  async close() {
    if (this.closed) return this.bytes;
    this.closed = true;
    await this.stream.close();
    return this.bytes;
  }

  async abort(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.stream.abort(reason);
    } catch {
      return;
    }
  }
}

export class MemorySink {
  constructor(options = {}) {
    this.chunks = [];
    this.bytes = 0;
    this.onBytes = options.onBytes || null;
  }

  async write(chunk) {
    const data = toUint8(chunk);
    if (!data.byteLength) return;
    this.chunks.push(data);
    this.bytes += data.byteLength;
    if (this.onBytes) this.onBytes(data.byteLength);
  }

  async close() {
    return this.bytes;
  }

  async abort() {
    this.chunks = [];
    this.bytes = 0;
  }

  toBlob(type = "application/octet-stream") {
    return new Blob(this.chunks, { type });
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }
}

export function supportsFileSystemAccess() {
  return typeof globalThis.showDirectoryPicker === "function";
}

export async function pickDirectory(options = {}) {
  if (!supportsFileSystemAccess()) {
    throw new Error("Браузер не поддерживает выбор папки (нужен Chrome, Edge или Opera на компьютере)");
  }
  return globalThis.showDirectoryPicker({
    id: options.id || "anime-downloads",
    mode: options.mode || "readwrite",
    startIn: options.startIn || "downloads",
  });
}

export async function ensurePermission(handle, mode = "readwrite") {
  if (!handle) return false;
  if (typeof handle.queryPermission !== "function") return true;
  const options = { mode };
  if ((await handle.queryPermission(options)) === "granted") return true;
  if (typeof handle.requestPermission !== "function") return false;
  return (await handle.requestPermission(options)) === "granted";
}

export async function getDirectory(parent, name, options = {}) {
  const { create = true } = options;
  return parent.getDirectoryHandle(name, { create });
}

export async function openFileSink(directory, name, options = {}) {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const stream = await fileHandle.createWritable({ keepExistingData: !!options.keepExisting });
  return new StreamSink(stream, { onBytes: options.onBytes || null });
}

export async function* readFileChunks(directory, name, chunkSize = 4 * 1024 * 1024) {
  const fileHandle = await directory.getFileHandle(name);
  const file = await fileHandle.getFile();
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
    yield new Uint8Array(await slice.arrayBuffer());
    offset += chunkSize;
  }
}

export async function getFileSize(directory, name) {
  try {
    const fileHandle = await directory.getFileHandle(name);
    const file = await fileHandle.getFile();
    return file.size;
  } catch {
    return -1;
  }
}

export async function removeEntry(directory, name) {
  try {
    await directory.removeEntry(name, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function opfsRoot() {
  if (!globalThis.navigator || !navigator.storage || !navigator.storage.getDirectory) {
    throw new Error("Хранилище браузера недоступно");
  }
  return navigator.storage.getDirectory();
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
