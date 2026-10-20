// A store-only ZIP (MP4 does not compress) streamed from open file descriptors, in the classic
// format: every size and offset fits 32 bits, so archives stay under 4 GiB and need no ZIP64.
// Each entry is read twice: once for its CRC-32 (the local header carries it, no data
// descriptor), then again while it is sent, checked against that CRC. Node built-ins only.
import { close, read } from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const readFd = promisify(read);
const closeFd = promisify(close);

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
// 1.0: stored entries without a data descriptor; "made by" 2.0 on MS-DOS (no Unix attributes).
const VERSION_NEEDED = 10;
const VERSION_MADE_BY = 20;
// 0xFFFF and 0xFFFFFFFF mean "see ZIP64" in these fields, so they stay below them.
const MAX_ENTRIES = 0xfffe;
export const ZIP32_MAX_BYTES = 0xfffffffe;
const ENTRY_NAME = /^(?!\.)[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_CHUNK = 256 * 1024;

export class ZipTooLargeError extends Error {}
export class ZipSourceChangedError extends Error {}

let table = null;

/** CRC-32 (IEEE, as zlib) of `data`, continuing from `value`; the table version. */
export function crc32Table(data, value = 0) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i += 1) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 from zlib (Node ≥ 20.15), else from the table. */
export function crc32(data, value = 0) {
  return typeof zlib.crc32 === "function" ? zlib.crc32(data, value) : crc32Table(data, value);
}

/** The MS-DOS time and date fields of `date` (UTC), clamped to the format's 1980–2107. */
export function dosDateTime(date) {
  const at = date instanceof Date && !Number.isNaN(date.valueOf()) ? date : new Date();
  const year = at.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const clamped = Math.min(year, 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((clamped - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * Offsets and the exact archive size for `entries` ({name, size, ...}): `{entries, centralOffset,
 * centralSize, total}`. Names are flat ASCII file names; anything a classic ZIP cannot hold
 * throws ZipTooLargeError.
 */
export function storedZipLayout(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  if (entries.length > MAX_ENTRIES) throw new ZipTooLargeError("too many entries");
  const names = new Set();
  let offset = 0;
  const placed = entries.map((entry) => {
    if (typeof entry?.name !== "string" || !ENTRY_NAME.test(entry.name) || names.has(entry.name)) {
      throw new TypeError("invalid or repeated entry name");
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError("invalid entry size");
    names.add(entry.name);
    const nameBytes = Buffer.from(entry.name, "ascii");
    const item = { ...entry, nameBytes, offset };
    offset += LOCAL_SIZE + nameBytes.length + entry.size;
    if (entry.size > ZIP32_MAX_BYTES || offset > ZIP32_MAX_BYTES) throw new ZipTooLargeError("entry beyond 4 GiB");
    return item;
  });
  const centralSize = placed.reduce((sum, item) => sum + CENTRAL_SIZE + item.nameBytes.length, 0);
  const total = offset + centralSize + END_SIZE;
  if (total > ZIP32_MAX_BYTES) throw new ZipTooLargeError("archive beyond 4 GiB");
  return { entries: placed, centralOffset: offset, centralSize, total };
}

function localHeader(item) {
  const header = Buffer.alloc(LOCAL_SIZE);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(item.dos.time, 10);
  header.writeUInt16LE(item.dos.date, 12);
  header.writeUInt32LE(item.crc, 14);
  header.writeUInt32LE(item.size, 18);
  header.writeUInt32LE(item.size, 22);
  header.writeUInt16LE(item.nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, item.nameBytes]);
}

function centralDirectory(layout) {
  const records = layout.entries.map((item) => {
    const record = Buffer.alloc(CENTRAL_SIZE);
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    record.writeUInt16LE(VERSION_MADE_BY, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(item.dos.time, 12);
    record.writeUInt16LE(item.dos.date, 14);
    record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.size, 20);
    record.writeUInt32LE(item.size, 24);
    record.writeUInt16LE(item.nameBytes.length, 28);
    // Extra field, comment, disk number, internal and external attributes: all empty.
    record.writeUInt32LE(item.offset, 42);
    return Buffer.concat([record, item.nameBytes]);
  });
  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(layout.entries.length, 8);
  end.writeUInt16LE(layout.entries.length, 10);
  end.writeUInt32LE(layout.centralSize, 12);
  end.writeUInt32LE(layout.centralOffset, 16);
  return Buffer.concat([...records, end]);
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * The archive of `entries` ({name, fd, size, modified?}) as a ReadableStream of chunks of at most
 * `chunkSize` bytes, pulled one at a time. The stream owns the descriptors: each closes after
 * its entry, and all of them on completion, error, cancel or `signal` abort. A file whose bytes
 * differ between the checksum pass and the copy, or that is shorter than `size`, errors the
 * stream with ZipSourceChangedError.
 */
export function storedZipStream(entries, { signal, chunkSize = DEFAULT_CHUNK, readImpl = readFd, closeImpl = closeFd } = {}) {
  const open = new Set(entries.map((entry) => entry.fd));
  let layout;
  try {
    layout = storedZipLayout(entries);
  } catch (error) {
    for (const fd of open) closeImpl(fd).catch(() => {});
    throw error;
  }
  let stopped = false;
  let pending = null;
  let cleanup = null;

  const closeAll = () => {
    cleanup ||= Promise.all([...open].map((fd) => closeImpl(fd).catch(() => {}))).then(() => open.clear());
    return cleanup;
  };
  const closeOne = async (fd) => {
    if (!open.delete(fd)) return;
    await closeImpl(fd).catch(() => {});
  };
  const onAbort = () => {
    stopped = true;
    if (!pending) void closeAll();
  };
  const check = () => {
    if (signal?.aborted || stopped) throw abortError();
  };

  async function readAt(fd, length, position) {
    check();
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await readImpl(fd, buffer, 0, length, position);
    if (!(bytesRead > 0)) throw new ZipSourceChangedError("file shorter than its recorded size");
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  }

  async function checksum(item) {
    let crc = 0;
    for (let position = 0; position < item.size;) {
      const chunk = await readAt(item.fd, Math.min(chunkSize, item.size - position), position);
      crc = crc32(chunk, crc);
      position += chunk.length;
    }
    return crc;
  }

  async function* chunks() {
    for (const item of layout.entries) {
      item.dos = dosDateTime(item.modified);
      item.crc = await checksum(item);
      yield localHeader(item);
      let crc = 0;
      for (let position = 0; position < item.size;) {
        const chunk = await readAt(item.fd, Math.min(chunkSize, item.size - position), position);
        crc = crc32(chunk, crc);
        position += chunk.length;
        if (position === item.size && crc !== item.crc) throw new ZipSourceChangedError("file changed while zipping");
        yield chunk;
      }
      await closeOne(item.fd);
    }
    yield centralDirectory(layout);
  }

  const iterator = chunks();
  if (signal?.aborted) stopped = true;
  else signal?.addEventListener("abort", onAbort, { once: true });

  // After a cancel the controller refuses enqueue, close and error; a late result is dropped.
  const settle = (action) => {
    try {
      action();
    } catch (error) {
      if (error?.code !== "ERR_INVALID_STATE") throw error;
    }
  };

  return new ReadableStream({
    async pull(controller) {
      let result;
      try {
        pending = iterator.next();
        result = await pending;
      } catch (error) {
        pending = null;
        signal?.removeEventListener("abort", onAbort);
        await closeAll();
        settle(() => controller.error(error));
        return;
      }
      pending = null;
      if (result.done) {
        signal?.removeEventListener("abort", onAbort);
        await closeAll();
        settle(() => controller.close());
        return;
      }
      settle(() => controller.enqueue(result.value));
    },
    async cancel() {
      stopped = true;
      signal?.removeEventListener("abort", onAbort);
      if (pending) await pending.catch(() => {});
      await iterator.return(undefined).catch(() => {});
      await closeAll();
    },
  }, { highWaterMark: 1 });
}
