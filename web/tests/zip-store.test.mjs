// The store-only ZIP writer behind "Unduh semua" / "Unduh (n)": classic (non-ZIP64) archives
// streamed from open file descriptors, readable by Python's zipfile, CRC-32 from zlib.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fstat, open, read } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

import {
  ZipSourceChangedError,
  ZipTooLargeError,
  crc32,
  crc32Table,
  dosDateTime,
  storedZipLayout,
  storedZipStream,
} from "../lib/zip-store.mjs";
import { readZip } from "./support/read-zip.mjs";

const openFd = promisify(open);
const readFd = promisify(read);
const statFd = promisify(fstat);
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "potongin-zip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function sources(dir, files) {
  const entries = [];
  for (const [name, data] of files) {
    const file = path.join(dir, `src-${entries.length}`);
    await writeFile(file, data);
    const fd = await openFd(file, "r");
    entries.push({ name, fd, size: data.length, modified: new Date("2026-10-20T08:30:14Z") });
  }
  return entries;
}

async function isClosed(fd) {
  try {
    await statFd(fd);
    return false;
  } catch (error) {
    return error.code === "EBADF";
  }
}

async function collect(stream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

test("CRC-32 is the standard one, from zlib or from the table when zlib has none", () => {
  const check = Buffer.from("123456789");
  assert.equal(crc32(check), 0xcbf43926);
  assert.equal(crc32Table(check), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const data = randomBytes(70_001);
  const whole = crc32Table(data);
  assert.equal(crc32Table(data.subarray(30_000), crc32Table(data.subarray(0, 30_000))), whole, "chained");
  if (typeof zlib.crc32 === "function") assert.equal(zlib.crc32(data), whole);
});

test("DOS time keeps two-second steps and clamps to the format's years", () => {
  assert.deepEqual(dosDateTime(new Date("2026-10-20T08:30:15Z")), { time: (8 << 11) | (30 << 5) | 7, date: (46 << 9) | (10 << 5) | 20 });
  assert.deepEqual(dosDateTime(new Date("1970-01-01T00:00:00Z")), { time: 0, date: (1 << 5) | 1 });
  const now = dosDateTime(new Date("bukan tanggal"));
  assert.ok(now.date > 0);
});

test("the layout gives every entry its offset and the archive its exact size", () => {
  const layout = storedZipLayout([{ name: "01-a.mp4", size: 10 }, { name: "02-bb.mp4", size: 0 }]);
  assert.deepEqual(layout.entries.map((entry) => entry.offset), [0, 30 + 8 + 10]);
  assert.equal(layout.centralOffset, 30 + 8 + 10 + 30 + 9);
  assert.equal(layout.centralSize, 46 + 8 + 46 + 9);
  assert.equal(layout.total, layout.centralOffset + layout.centralSize + 22);
  for (const bad of [
    [{ name: "../x.mp4", size: 1 }], [{ name: "a/b.mp4", size: 1 }], [{ name: "", size: 1 }], [{ name: "a b.mp4", size: 1 }],
    [{ name: "x.mp4", size: -1 }], [{ name: "x.mp4", size: 1.5 }], [{ name: "x.mp4", size: 1 }, { name: "x.mp4", size: 2 }],
    [{ name: "ü.mp4", size: 1 }],
  ]) assert.throws(() => storedZipLayout(bad), TypeError, JSON.stringify(bad));
  // A classic ZIP stores sizes and offsets in 32 bits: anything that would need ZIP64 is refused.
  assert.throws(() => storedZipLayout([{ name: "big.mp4", size: 0xffffffff }]), ZipTooLargeError);
  assert.throws(() => storedZipLayout([{ name: "a.mp4", size: 0xffff0000 }, { name: "b.mp4", size: 0xffff }]), ZipTooLargeError);
  assert.throws(() => storedZipLayout(Array.from({ length: 0xffff }, (_, index) => ({ name: `${index}.mp4`, size: 0 }))), ZipTooLargeError);
});

test("the stream is a valid store-only archive: names, sizes, CRCs and bytes as Python reads them", async (t) => {
  const dir = await temp(t);
  const files = [
    ["01-rahasia-hook.mp4", randomBytes(600_123)],
    ["02-kosong.mp4", Buffer.alloc(0)],
    ["03-jangan-menyerah.mp4", randomBytes(5)],
  ];
  const entries = await sources(dir, files);
  const layout = storedZipLayout(entries);
  const bytes = await collect(storedZipStream(entries, { chunkSize: 64 * 1024 }));
  assert.equal(bytes.length, layout.total);
  const archive = path.join(dir, "klip.zip");
  await writeFile(archive, bytes);
  const read = readZip(archive);
  assert.equal(read.bad, null);
  assert.deepEqual(read.entries.map((entry) => entry.name), files.map(([name]) => name));
  for (const [position, [, data]] of files.entries()) {
    const entry = read.entries[position];
    assert.equal(entry.method, 0, "stored, not deflated");
    assert.equal(entry.size, data.length);
    assert.equal(entry.stored, data.length);
    assert.equal(entry.crc, crc32(data));
    assert.equal(entry.sha, sha(data));
    assert.deepEqual(entry.date, [2026, 10, 20, 8, 30, 14]);
  }
  for (const entry of entries) assert.equal(await isClosed(entry.fd), true, "every descriptor is closed at the end");
});

test("a file that changes while it is zipped fails the stream instead of shipping a broken entry", async (t) => {
  const dir = await temp(t);
  const entries = await sources(dir, [["01-a.mp4", Buffer.from("a".repeat(1000))], ["02-b.mp4", Buffer.from("b".repeat(10))]]);
  let reads = 0;
  // The checksum pass reads the first file as it is; the copy pass then sees other bytes.
  const readImpl = async (fd, buffer, offset, length, position) => {
    reads += 1;
    const result = await readFd(fd, buffer, offset, length, position);
    if (reads > 1 && fd === entries[0].fd) buffer.fill(0x7a, offset, offset + result.bytesRead);
    return result;
  };
  await assert.rejects(collect(storedZipStream(entries, { readImpl })), ZipSourceChangedError);
  for (const entry of entries) assert.equal(await isClosed(entry.fd), true);
});

test("a file shorter than its recorded size fails the stream", async (t) => {
  const dir = await temp(t);
  const [entry] = await sources(dir, [["01-a.mp4", Buffer.from("abc")]]);
  await assert.rejects(collect(storedZipStream([{ ...entry, size: 10 }])), ZipSourceChangedError);
  assert.equal(await isClosed(entry.fd), true);
});

test("cancelling the download or aborting the request closes every descriptor", async (t) => {
  const dir = await temp(t);
  const big = randomBytes(300_000);
  const entries = await sources(dir, [["01-a.mp4", big], ["02-b.mp4", big]]);
  const stream = storedZipStream(entries, { chunkSize: 16 * 1024 });
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  for (const entry of entries) assert.equal(await isClosed(entry.fd), true, "cancel");

  const more = await sources(dir, [["01-a.mp4", big], ["02-b.mp4", big]]);
  const controller = new AbortController();
  const aborted = storedZipStream(more, { chunkSize: 16 * 1024, signal: controller.signal }).getReader();
  await aborted.read();
  controller.abort();
  await assert.rejects(async () => { for (;;) if ((await aborted.read()).done) break; }, (error) => error.name === "AbortError");
  for (const entry of more) assert.equal(await isClosed(entry.fd), true, "abort");

  const early = await sources(dir, [["01-a.mp4", big]]);
  const before = new AbortController();
  before.abort();
  await assert.rejects(collect(storedZipStream(early, { signal: before.signal })), (error) => error.name === "AbortError");
  assert.equal(await isClosed(early[0].fd), true, "aborted before the first read");
});

test("the writer holds one chunk at a time, never a whole file", async (t) => {
  const dir = await temp(t);
  const entries = await sources(dir, [["01-a.mp4", randomBytes(1_000_000)]]);
  const sizes = [];
  const reader = storedZipStream(entries, { chunkSize: 32 * 1024 }).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sizes.push(value.length);
  }
  assert.ok(Math.max(...sizes) <= 32 * 1024, `largest chunk ${Math.max(...sizes)}`);
  assert.equal(await isClosed(entries[0].fd), true);
});
