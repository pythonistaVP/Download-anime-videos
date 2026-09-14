import { toUint8 } from "./util.js";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UTF8_FLAG = 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const dateValue = ((year - 1980) << 9) | (month << 5) | day;
  return { time: time & 0xffff, date: dateValue & 0xffff };
}

export class ZipWriter {
  constructor(options = {}) {
    const { sink, onProgress = null } = options;
    if (!sink || typeof sink.write !== "function") throw new Error("ZipWriter: нужен приёмник данных");
    this.sink = sink;
    this.onProgress = onProgress;
    this.offset = 0;
    this.entries = [];
  }

  async _write(bytes) {
    const data = toUint8(bytes);
    if (!data.byteLength) return;
    await this.sink.write(data);
    this.offset += data.byteLength;
  }

  async addEntry(entry) {
    const { name, size, crc, chunks } = entry;
    const nameBytes = new TextEncoder().encode(name);
    const headerOffset = this.offset;
    const needsZip64 = size >= MAX32 || headerOffset >= MAX32;
    const stamp = entry.date || new Date();
    const dos = dosDateTime(stamp);

    const extra = new Uint8Array(needsZip64 ? 20 : 0);
    if (needsZip64) {
      const extraView = new DataView(extra.buffer);
      extraView.setUint16(0, ZIP64_EXTRA, true);
      extraView.setUint16(2, 16, true);
      extraView.setBigUint64(4, BigInt(size), true);
      extraView.setBigUint64(12, BigInt(size), true);
    }

    const header = new Uint8Array(30 + nameBytes.length + extra.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_FILE_HEADER, true);
    view.setUint16(4, needsZip64 ? 45 : 20, true);
    view.setUint16(6, UTF8_FLAG, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, dos.time, true);
    view.setUint16(12, dos.date, true);
    view.setUint32(14, crc >>> 0, true);
    view.setUint32(18, needsZip64 ? MAX32 : size >>> 0, true);
    view.setUint32(22, needsZip64 ? MAX32 : size >>> 0, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, extra.length, true);
    header.set(nameBytes, 30);
    header.set(extra, 30 + nameBytes.length);

    await this._write(header);

    let written = 0;
    for await (const chunk of chunks) {
      const data = toUint8(chunk);
      if (!data.byteLength) continue;
      await this._write(data);
      written += data.byteLength;
    }

    if (written !== size) throw new Error("ZipWriter: размер файла «" + name + "» не совпал (" + written + " != " + size + ")");

    this.entries.push({
      nameBytes,
      size,
      crc: crc >>> 0,
      offset: headerOffset,
      dos,
      needsZip64,
    });

    if (this.onProgress) this.onProgress(this.entries.length, written);
  }

  async close() {
    const directoryStart = this.offset;

    for (const entry of this.entries) {
      let sizeField = entry.size;
      let offsetField = entry.offset;
      const zip64 = entry.needsZip64 || entry.size >= MAX32 || entry.offset >= MAX32;
      if (zip64) {
        sizeField = MAX32;
        offsetField = MAX32;
      }

      let extra = new Uint8Array(0);
      if (zip64) {
        extra = new Uint8Array(4 + 8 + 8 + 8);
        const extraView = new DataView(extra.buffer);
        extraView.setUint16(0, ZIP64_EXTRA, true);
        extraView.setUint16(2, 24, true);
        extraView.setBigUint64(4, BigInt(entry.size), true);
        extraView.setBigUint64(12, BigInt(entry.size), true);
        extraView.setBigUint64(20, BigInt(entry.offset), true);
      }

      const record = new Uint8Array(46 + entry.nameBytes.length + extra.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, CENTRAL_DIRECTORY, true);
      view.setUint16(4, zip64 ? 45 : 20, true);
      view.setUint16(6, zip64 ? 45 : 20, true);
      view.setUint16(8, UTF8_FLAG, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, entry.dos.time, true);
      view.setUint16(14, entry.dos.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, sizeField === MAX32 ? MAX32 : entry.size >>> 0, true);
      view.setUint32(24, sizeField === MAX32 ? MAX32 : entry.size >>> 0, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, extra.length, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0x81a40000, true);
      view.setUint32(42, offsetField === MAX32 ? MAX32 : entry.offset >>> 0, true);
      record.set(entry.nameBytes, 46);
      record.set(extra, 46 + entry.nameBytes.length);
      await this._write(record);
    }

    const directorySize = this.offset - directoryStart;
    const count = this.entries.length;
    const needsZip64End = count > MAX16 || directorySize >= MAX32 || directoryStart >= MAX32;

    if (needsZip64End) {
      const end = new Uint8Array(56);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY, true);
      endView.setBigUint64(4, BigInt(44), true);
      endView.setUint16(12, 45, true);
      endView.setUint16(14, 45, true);
      endView.setUint32(16, 0, true);
      endView.setUint32(20, 0, true);
      endView.setBigUint64(24, BigInt(count), true);
      endView.setBigUint64(32, BigInt(count), true);
      endView.setBigUint64(40, BigInt(directorySize), true);
      endView.setBigUint64(48, BigInt(directoryStart), true);
      await this._write(end);

      const locator = new Uint8Array(20);
      const locatorView = new DataView(locator.buffer);
      locatorView.setUint32(0, ZIP64_LOCATOR, true);
      locatorView.setUint32(4, 0, true);
      locatorView.setBigUint64(8, BigInt(this.offset - 56), true);
      locatorView.setUint32(16, 1, true);
      await this._write(locator);
    }

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, needsZip64End ? MAX16 : count, true);
    eocdView.setUint16(10, needsZip64End ? MAX16 : count, true);
    eocdView.setUint32(12, needsZip64End ? MAX32 : directorySize >>> 0, true);
    eocdView.setUint32(16, needsZip64End ? MAX32 : directoryStart >>> 0, true);
    eocdView.setUint16(20, 0, true);
    await this._write(eocd);

    return { entries: count, size: this.offset };
  }
}
