import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TREND_KINDS,
  TREND_LIMITS,
  TREND_PLATFORMS,
  TrendContextError,
  buildTrendSnapshot,
  createManualTrend,
  deleteTrendByExternalId,
  deleteTrendItem,
  ingestTrendItems,
  listActiveTrendSummaries,
  normalizeTrendLine,
  normalizeTrendSummary,
  parseTrendInput,
  readTrendContext,
  readTrendContextView,
  setTrendContextEnabled,
  trendMatchKey,
  updateTrendItem,
  writeTrendSnapshot,
} from "../lib/trend-context.mjs";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const iso = (offsetMs = 0) => at(offsetMs).toISOString();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trend-store-"));
  const dir = path.join(root, "settings");
  return { root, dir, file: path.join(dir, "trend-context.json"), env: { JOBS_ROOT: path.join(root, "jobs"), POTONGIN_SETTINGS_DIR: dir } };
}

function item(extra = {}) {
  return {
    kind: "topic", title: "Kabur Aja Dulu", summary: "Tagar ajakan merantau ke luar negeri.",
    keywords: ["kabur aja dulu", "#KaburAjaDulu"], hashtags: ["#KaburAjaDulu"], platforms: ["tiktok", "x"],
    ...extra,
  };
}

function numbered(count, extra = (index) => ({})) {
  return Array.from({ length: count }, (_, index) => item({ title: `Tren nomor ${index}`, keywords: [`tren nomor ${index}`], hashtags: [], ...extra(index) }));
}

async function ingestAll(items, options) {
  const totals = { accepted: 0, created: 0, updated: 0, rejected: [] };
  for (let start = 0; start < items.length; start += TREND_LIMITS.maxBatchItems) {
    const result = await ingestTrendItems(items.slice(start, start + TREND_LIMITS.maxBatchItems), options);
    totals.accepted += result.accepted;
    totals.created += result.created;
    totals.updated += result.updated;
    totals.rejected.push(...result.rejected.map((entry) => ({ ...entry, index: entry.index + start })));
  }
  return totals;
}

// --- Text rules -----------------------------------------------------------------------------

test("single-line text is NFC with control, bidi and zero-width characters and newlines removed", () => {
  assert.equal(normalizeTrendLine("  Kábur‮ aja​\n\tdulu\u0000⁦!⁩ "), "Kábur aja dulu!");
  assert.equal(normalizeTrendLine("a‍b﻿c­d"), "abcd");
  assert.equal(normalizeTrendLine("\u0000​"), "");
  assert.equal(normalizeTrendLine(normalizeTrendLine("x‪y")), "xy");
  assert.equal(normalizeTrendLine(42), null);
});

test("summaries keep at most five lines, normalised to \\n", () => {
  assert.equal(normalizeTrendSummary("satu\r\ndua\n\n\ntiga empat\rlima\nenam\ntujuh"), "satu\ndua\ntiga\nempat\nlima enam tujuh");
  assert.equal(normalizeTrendSummary("  baris‮  satu \n​\n"), "baris satu");
  assert.equal(normalizeTrendSummary(""), "");
});

test("the match key folds case, accents and spacing", () => {
  assert.equal(trendMatchKey("person", "  PAK   Búdi "), trendMatchKey("person", "pak budi"));
  assert.notEqual(trendMatchKey("topic", "pak budi"), trendMatchKey("person", "pak budi"));
});

test("the public constants follow the spec", () => {
  assert.deepEqual(TREND_KINDS, ["topic", "person", "joke", "meme", "sound", "hashtag", "format", "event"]);
  assert.deepEqual(TREND_PLATFORMS, ["tiktok", "instagram", "youtube", "x", "facebook", "news", "other"]);
  assert.equal(TREND_LIMITS.maxItems, 1000);
  assert.equal(TREND_LIMITS.maxBatchItems, 100);
  assert.equal(TREND_LIMITS.maxIngestBytes, 256 * 1024);
  assert.equal(TREND_LIMITS.snapshotItems, 300);
});

// --- Item validation ------------------------------------------------------------------------

test("a minimal item gets the documented defaults", () => {
  const parsed = parseTrendInput({ kind: "joke", title: "Lho kok gitu", keywords: ["lho kok gitu"] }, { now: NOW });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    externalId: null, kind: "joke", title: "Lho kok gitu", summary: "", keywords: ["lho kok gitu"], hashtags: [],
    platforms: [], region: "ID", examples: [], score: 50, sensitivity: "normal",
    firstSeenAt: iso(), expiresAt: iso(10 * DAY),
  });
});

test("every field is normalised and de-duplicated", () => {
  const parsed = parseTrendInput(item({
    externalId: "tiktok:tag:kabur-aja-dulu", title: " Kabur​  Aja Dulu ", keywords: ["kabur aja dulu", "KABUR AJA DULU", "#KaburAjaDulu"],
    hashtags: ["#KaburAjaDulu", "#kaburajadulu"], platforms: ["tiktok", "tiktok", "x"], region: "id", score: 72.456,
    examples: [{ url: "https://www.tiktok.com/@a/video/1", note: " contoh‮ " }, { url: "http://example.com" }],
    sensitivity: "sensitive", firstSeenAt: "2026-09-24T08:00:00Z", expiresAt: "2026-10-05",
    id: "ignored", source: "ignored", createdAt: "ignored", updatedAt: "ignored", enabled: false,
  }), { now: NOW });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.value, {
    externalId: "tiktok:tag:kabur-aja-dulu", kind: "topic", title: "Kabur Aja Dulu", summary: "Tagar ajakan merantau ke luar negeri.",
    keywords: ["kabur aja dulu", "#KaburAjaDulu"], hashtags: ["#KaburAjaDulu"], platforms: ["tiktok", "x"], region: "ID",
    examples: [{ url: "https://www.tiktok.com/@a/video/1", note: "contoh" }, { url: "http://example.com/", note: "" }],
    score: 72.46, sensitivity: "sensitive", firstSeenAt: "2026-09-24T08:00:00.000Z", expiresAt: "2026-10-05T00:00:00.000Z",
  });
});

test("invalid items are rejected with a stable code and field, never with the value", () => {
  const long = (count) => "x".repeat(count);
  const cases = [
    [null, "invalid_item", null],
    [[item()], "invalid_item", null],
    ["item", "invalid_item", null],
    [item({ color: "merah" }), "unknown_field", "color"],
    [{ ...item(), title: undefined }, "missing_field", "title"],
    [{ ...item(), kind: undefined }, "missing_field", "kind"],
    [{ ...item(), keywords: undefined }, "missing_field", "keywords"],
    [item({ kind: "rumor" }), "invalid_value", "kind"],
    [item({ title: 42 }), "invalid_type", "title"],
    [item({ title: "​\u0000" }), "invalid_length", "title"],
    [item({ title: long(81) }), "invalid_length", "title"],
    [item({ summary: long(501) }), "invalid_length", "summary"],
    [item({ summary: ["a"] }), "invalid_type", "summary"],
    [item({ keywords: [] }), "invalid_length", "keywords"],
    [item({ keywords: "kabur" }), "invalid_type", "keywords"],
    [item({ keywords: ["a"] }), "invalid_length", "keywords[0]"],
    [item({ keywords: ["ok ok", long(41)] }), "invalid_length", "keywords[1]"],
    [item({ keywords: Array.from({ length: 13 }, (_, index) => `kata ${index}`) }), "invalid_length", "keywords"],
    [item({ keywords: ["ok ok", 7] }), "invalid_type", "keywords[1]"],
    [item({ hashtags: ["KaburAjaDulu"] }), "invalid_value", "hashtags[0]"],
    [item({ hashtags: ["#Kabur Aja"] }), "invalid_value", "hashtags[0]"],
    [item({ hashtags: [`#${long(51)}`] }), "invalid_value", "hashtags[0]"],
    [item({ hashtags: Array.from({ length: 11 }, (_, index) => `#tag${index}`) }), "invalid_length", "hashtags"],
    [item({ platforms: ["myspace"] }), "invalid_value", "platforms[0]"],
    [item({ platforms: "tiktok" }), "invalid_type", "platforms"],
    [item({ region: "IDN" }), "invalid_value", "region"],
    [item({ examples: [{ url: "javascript:alert(1)" }] }), "invalid_value", "examples[0].url"],
    [item({ examples: [{ url: "ftp://example.com/a" }] }), "invalid_value", "examples[0].url"],
    [item({ examples: [{ url: "https://user:pw@example.com/" }] }), "invalid_value", "examples[0].url"],
    [item({ examples: [{ url: "not a url" }] }), "invalid_value", "examples[0].url"],
    [item({ examples: [{ url: `https://example.com/${long(500)}` }] }), "invalid_length", "examples[0].url"],
    [item({ examples: [{ url: "https://example.com", note: long(121) }] }), "invalid_length", "examples[0].note"],
    [item({ examples: [{ url: "https://example.com", views: 1 }] }), "unknown_field", "examples[0].views"],
    [item({ examples: ["https://example.com"] }), "invalid_type", "examples[0]"],
    [item({ examples: Array.from({ length: 6 }, () => ({ url: "https://example.com" })) }), "invalid_length", "examples"],
    [item({ score: 101 }), "invalid_value", "score"],
    [item({ score: -1 }), "invalid_value", "score"],
    [item({ score: "50" }), "invalid_type", "score"],
    [item({ sensitivity: "high" }), "invalid_value", "sensitivity"],
    [item({ firstSeenAt: "yesterday" }), "invalid_value", "firstSeenAt"],
    [item({ firstSeenAt: iso(2 * DAY) }), "invalid_value", "firstSeenAt"],
    [item({ expiresAt: 1760000000 }), "invalid_type", "expiresAt"],
    [item({ expiresAt: iso(-HOUR) }), "expired", "expiresAt"],
    [item({ firstSeenAt: iso(-11 * DAY) }), "expired", "expiresAt"],
    [item({ externalId: "ada spasi" }), "invalid_value", "externalId"],
    [item({ externalId: long(121) }), "invalid_length", "externalId"],
    [item({ externalId: 5 }), "invalid_type", "externalId"],
  ];
  for (const [input, code, field] of cases) {
    const parsed = parseTrendInput(input, { now: NOW });
    assert.equal(parsed.ok, false, JSON.stringify(input)?.slice(0, 120));
    assert.deepEqual({ code: parsed.code, field: parsed.field }, { code, field }, JSON.stringify(input)?.slice(0, 120));
    assert.deepEqual(Object.keys(parsed).sort(), ["code", "field", "ok"]);
  }
});

test("expiry is capped at 60 days and a slightly early clock is forgiven", () => {
  const far = parseTrendInput(item({ expiresAt: iso(90 * DAY) }), { now: NOW });
  assert.equal(far.value.expiresAt, iso(60 * DAY));
  const early = parseTrendInput(item({ firstSeenAt: iso(10 * 60_000) }), { now: NOW });
  assert.equal(early.value.firstSeenAt, iso());
  assert.equal(early.value.expiresAt, iso(10 * DAY));
});

// --- Ingest ---------------------------------------------------------------------------------

test("ingest creates items, then upserts them by externalId or by kind and normalised title", async () => {
  const { env } = await sandbox();
  const first = await ingestTrendItems([
    item({ externalId: "tiktok:tag:kabur-aja-dulu" }),
    { kind: "person", title: "Pak Budi", keywords: ["pak budi"] },
  ], { env, source: "hermes", now: NOW });
  assert.deepEqual(first, { accepted: 2, created: 2, updated: 0, rejected: [] });
  const { document } = await readTrendContext({ env });
  assert.equal(document.items.length, 2);
  const [kabur, budi] = document.items;
  assert.match(kabur.id, UUID_V4);
  assert.deepEqual(Object.keys(kabur), [
    "id", "externalId", "kind", "title", "summary", "keywords", "hashtags", "platforms", "region", "examples",
    "score", "sensitivity", "firstSeenAt", "expiresAt", "source", "enabled", "createdAt", "updatedAt",
  ]);
  assert.equal(kabur.source, "hermes");
  assert.equal(kabur.enabled, true);
  assert.equal(kabur.createdAt, iso());
  assert.equal(document.lastIngestAt, iso());

  const second = await ingestTrendItems([
    item({ externalId: "tiktok:tag:kabur-aja-dulu", title: "Kabur Aja Dulu!", score: 91 }),
    { kind: "person", title: "  PAK   BÚDI ", keywords: ["pak budi", "budi"] },
    { kind: "topic", title: "Pak Budi", keywords: ["pak budi"] },
  ], { env, source: "hermes", now: at(HOUR) });
  assert.deepEqual(second, { accepted: 3, created: 1, updated: 2, rejected: [] });
  const after = (await readTrendContext({ env })).document;
  assert.equal(after.items.length, 3);
  const updatedKabur = after.items.find((entry) => entry.id === kabur.id);
  assert.equal(updatedKabur.title, "Kabur Aja Dulu!");
  assert.equal(updatedKabur.score, 91);
  assert.equal(updatedKabur.createdAt, iso());
  assert.equal(updatedKabur.updatedAt, iso(HOUR));
  const updatedBudi = after.items.find((entry) => entry.id === budi.id);
  assert.equal(updatedBudi.title, "PAK BÚDI");
  assert.deepEqual(updatedBudi.keywords, ["pak budi", "budi"]);
  assert.equal(after.lastIngestAt, iso(HOUR));
});

test("an item first sent without externalId adopts one sent later", async () => {
  const { env } = await sandbox();
  await ingestTrendItems([item()], { env, source: "hermes", now: NOW });
  const result = await ingestTrendItems([item({ externalId: "x:trend:kabur" })], { env, source: "hermes", now: NOW });
  assert.deepEqual(result, { accepted: 1, created: 0, updated: 1, rejected: [] });
  const { document } = await readTrendContext({ env });
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0].externalId, "x:trend:kabur");
});

test("an agent update keeps the owner's choices: enabled, sensitive, source and first sighting", async () => {
  const { env } = await sandbox();
  await ingestTrendItems([item({ externalId: "k1", firstSeenAt: iso(-2 * DAY) })], { env, source: "hermes", now: NOW });
  const [stored] = (await readTrendContext({ env })).document.items;
  await updateTrendItem(stored.id, { enabled: false, sensitivity: "sensitive" }, { env, now: NOW });
  await ingestTrendItems([item({ externalId: "k1", sensitivity: "normal", firstSeenAt: iso(-HOUR), enabled: true })], { env, source: "other-agent", now: at(HOUR) });
  const [after] = (await readTrendContext({ env })).document.items;
  assert.equal(after.enabled, false);
  assert.equal(after.sensitivity, "sensitive");
  assert.equal(after.source, "hermes");
  assert.equal(after.firstSeenAt, iso(-2 * DAY));
  assert.equal(after.expiresAt, iso(-HOUR + 10 * DAY));
});

test("one bad item never blocks the others and rejections carry index, code and field only", async () => {
  const { env } = await sandbox();
  const secret = "https://attacker.example/secret-value";
  const result = await ingestTrendItems([
    item({ title: "Satu", keywords: ["satu satu"] }),
    item({ title: "Dua", examples: [{ url: `javascript:${secret}` }] }),
    { id: "x" },
    item({ title: "Tiga", keywords: ["tiga tiga"], kind: "meme" }),
  ], { env, source: "hermes", now: NOW });
  assert.deepEqual(result, {
    accepted: 2, created: 2, updated: 0,
    rejected: [{ index: 1, code: "invalid_value", field: "examples[0].url" }, { index: 2, code: "missing_field", field: "kind" }],
  });
  assert.doesNotMatch(JSON.stringify(result), /attacker|secret/);
});

test("the store keeps at most 1000 items: expired history goes first, then the lowest score and oldest", async () => {
  const { env } = await sandbox();
  const batch = numbered(1000, (index) => ({
    score: index < 10 ? 99 : 20 + (index % 50),
    expiresAt: index < 10 ? iso(DAY) : iso(20 * DAY),
    firstSeenAt: iso(-index * 60_000),
  }));
  const loaded = await ingestAll(batch, { env, source: "hermes", now: NOW });
  assert.equal(loaded.created, 1000);

  // Two days later the first ten items have expired: they are trimmed before any active one.
  const later = at(2 * DAY);
  const fresh = numbered(5, (index) => ({ title: `Baru ${index}`, keywords: [`baru ${index}`], score: 60 }));
  const first = await ingestTrendItems(fresh, { env, source: "hermes", now: later });
  assert.equal(first.created, 5);
  let items = (await readTrendContext({ env })).document.items;
  assert.equal(items.length, 1000);
  assert.equal(items.filter((entry) => entry.title.startsWith("Tren nomor ") && Number(entry.title.slice(11)) < 10).length, 5);

  // Ten more: the five remaining expired items go, then the five lowest-scored (oldest first) active ones.
  const more = numbered(10, (index) => ({ title: `Lagi ${index}`, keywords: [`lagi ${index}`], score: 60 }));
  const second = await ingestTrendItems(more, { env, source: "hermes", now: later });
  assert.equal(second.created, 10);
  items = (await readTrendContext({ env })).document.items;
  assert.equal(items.length, 1000);
  const survivors = new Set(items.map((entry) => entry.title));
  for (let index = 0; index < 10; index += 1) assert.equal(survivors.has(`Tren nomor ${index}`), false, `expired ${index}`);
  // Score 20 belongs to indexes 50, 100, 150, ...; the oldest sightings (largest index) go first.
  for (const index of [950, 900, 850, 800, 750]) assert.equal(survivors.has(`Tren nomor ${index}`), false, `low ${index}`);
  for (const index of [700, 50]) assert.equal(survivors.has(`Tren nomor ${index}`), true, `kept ${index}`);

  // Items created by a request but trimmed straight away are reported, not counted.
  const weak = numbered(3, (index) => ({ title: `Lemah ${index}`, keywords: [`lemah ${index}`], score: 0 }));
  const third = await ingestTrendItems(weak, { env, source: "hermes", now: later });
  assert.deepEqual(third, {
    accepted: 0, created: 0, updated: 0,
    rejected: [0, 1, 2].map((index) => ({ index, code: "store_full", field: null })),
  });
  assert.equal((await readTrendContext({ env })).document.items.length, 1000);
});

test("expired items are kept for seven days of history, then removed on the next write", async () => {
  const { env } = await sandbox();
  await ingestTrendItems([item({ title: "Lama", keywords: ["lama lama"], expiresAt: iso(DAY) })], { env, source: "hermes", now: NOW });
  await ingestTrendItems([item({ title: "Lain", keywords: ["lain lain"] })], { env, source: "hermes", now: at(7 * DAY) });
  assert.deepEqual((await readTrendContext({ env })).document.items.map((entry) => entry.title), ["Lama", "Lain"]);
  await ingestTrendItems([item({ title: "Baru", keywords: ["baru baru"] })], { env, source: "hermes", now: at(8 * DAY + 1) });
  assert.deepEqual((await readTrendContext({ env })).document.items.map((entry) => entry.title), ["Lain", "Baru"]);
});

// --- Storage --------------------------------------------------------------------------------

test("writes are atomic 0600 files in a 0700 directory and parallel writers lose nothing", async () => {
  const { dir, file, env } = await sandbox();
  await Promise.all(Array.from({ length: 10 }, (_, writer) => ingestTrendItems(
    numbered(5, (index) => ({ title: `Penulis ${writer} item ${index}`, keywords: [`penulis ${writer} ${index}`] })),
    { env, source: "hermes", now: NOW },
  )));
  assert.equal((await readTrendContext({ env })).document.items.length, 50);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(dir)).sort(), ["trend-context.json"]);
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(document), ["version", "enabled", "updatedAt", "lastIngestAt", "items"]);
  assert.equal(document.version, 1);
});

test("a lock held by another process delays the write; a stale one is reclaimed", async () => {
  const { dir, env } = await sandbox();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, ".trend-context.json.lock");
  await mkdir(lock);
  let finished = false;
  const pending = ingestTrendItems([item()], { env, source: "hermes", now: NOW }).then((result) => { finished = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(finished, false, "the write waits for the lock");
  const { rm } = await import("node:fs/promises");
  await rm(lock, { recursive: true });
  assert.equal((await pending).created, 1);

  await mkdir(lock);
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  assert.equal((await ingestTrendItems([item({ title: "Lain", keywords: ["lain lain"] })], { env, source: "hermes", now: NOW })).created, 1);
  await assert.rejects(lstat(lock), { code: "ENOENT" });
});

test("a corrupt store is reported on read and set aside, not lost, on the next write", async () => {
  const { dir, file, env } = await sandbox();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, "{ bukan json", { mode: 0o600 });
  await assert.rejects(readTrendContext({ env }), (error) => error instanceof TrendContextError && error.code === "storage_unavailable");
  await assert.rejects(readTrendContextView({ env, now: NOW }), (error) => error instanceof TrendContextError && error.code === "storage_unavailable");

  const result = await ingestTrendItems([item()], { env, source: "hermes", now: NOW });
  assert.equal(result.created, 1);
  const names = await readdir(dir);
  const backup = names.find((name) => name.startsWith("trend-context.json.corrupt-"));
  assert.ok(backup, names.join(","));
  assert.equal(await readFile(path.join(dir, backup), "utf8"), "{ bukan json");
  assert.equal((await stat(path.join(dir, backup))).mode & 0o777, 0o600);
  assert.equal((await readTrendContext({ env })).document.items.length, 1);

  // A structurally valid file with an invalid item is corrupt too.
  const document = JSON.parse(await readFile(file, "utf8"));
  document.items[0].title = "";
  await writeFile(file, JSON.stringify(document));
  await assert.rejects(readTrendContext({ env }), { code: "storage_unavailable" });
});

test("the store refuses to follow a symlink", async () => {
  const { dir, file, root, env } = await sandbox();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const elsewhere = path.join(root, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify({ version: 1, enabled: true, updatedAt: iso(), lastIngestAt: null, items: [] }));
  await symlink(elsewhere, file);
  await assert.rejects(readTrendContext({ env }), { code: "storage_unavailable" });
});

test("the settings directory must be absolute and outside JOBS_ROOT", async () => {
  const { root } = await sandbox();
  for (const env of [
    { JOBS_ROOT: path.join(root, "jobs"), POTONGIN_SETTINGS_DIR: "relative/settings" },
    { JOBS_ROOT: path.join(root, "jobs"), POTONGIN_SETTINGS_DIR: path.join(root, "jobs", "settings") },
  ]) {
    await assert.rejects(ingestTrendItems([item()], { env, source: "hermes", now: NOW }), { code: "storage_unavailable" });
    await assert.rejects(readTrendContext({ env }), { code: "storage_unavailable" });
  }
});

// --- Views and manual edits -----------------------------------------------------------------

test("without a file the view is empty and switched on", async () => {
  const { env } = await sandbox();
  assert.deepEqual(await readTrendContextView({ env, now: NOW }), {
    enabled: true, updatedAt: null, lastIngestAt: null, items: [], counts: { active: 0, expired: 0 },
  });
  const read = await readTrendContext({ env });
  assert.equal(read.exists, false);
});

test("the view lists active items and recent history with the global switch", async () => {
  const { env } = await sandbox();
  await ingestTrendItems([item({ title: "Segera habis", keywords: ["segera habis"], expiresAt: iso(DAY) })], { env, source: "hermes", now: NOW });
  const manual = await createManualTrend(item(), { env, now: at(HOUR) });
  const view = await readTrendContextView({ env, now: at(2 * DAY) });
  assert.equal(view.enabled, true);
  assert.equal(view.lastIngestAt, iso(), "manual items do not count as an agent ingest");
  assert.equal(view.updatedAt, iso(HOUR));
  assert.deepEqual(view.counts, { active: 1, expired: 1 });
  assert.deepEqual(view.items.map((entry) => [entry.title, entry.expired, entry.source]), [
    ["Kabur Aja Dulu", false, "manual"],
    ["Segera habis", true, "hermes"],
  ]);
  assert.equal(view.items[0].id, manual.id);

  assert.deepEqual(await setTrendContextEnabled(false, { env, now: at(3 * HOUR) }), { enabled: false, updatedAt: iso(3 * HOUR) });
  assert.equal((await readTrendContextView({ env, now: at(2 * DAY) })).enabled, false);
  await assert.rejects(setTrendContextEnabled("no", { env, now: NOW }), { code: "invalid_body" });
});

test("manual items: created as manual, duplicates refused, only editable fields patched, deleted by id", async () => {
  const { env } = await sandbox();
  const created = await createManualTrend(item({ enabled: false }), { env, now: NOW });
  assert.equal(created.source, "manual");
  assert.equal(created.enabled, false);
  await assert.rejects(createManualTrend(item({ title: "kabur  AJA dulu" }), { env, now: NOW }), { code: "duplicate" });
  await assert.rejects(createManualTrend(item({ title: "" }), { env, now: NOW }), (error) => (
    error.code === "invalid_item" && error.issues.length === 1 && error.issues[0].field === "title" && error.issues[0].code === "invalid_length"
  ));
  const other = await createManualTrend(item({ title: "Lain", keywords: ["lain lain"] }), { env, now: NOW });

  const patched = await updateTrendItem(created.id, {
    title: "Kabur Dulu", summary: "baris\nkedua", keywords: ["kabur dulu"], hashtags: [], sensitivity: "sensitive", expiresAt: iso(-HOUR), enabled: true,
  }, { env, now: at(HOUR) });
  assert.equal(patched.title, "Kabur Dulu");
  assert.equal(patched.summary, "baris\nkedua");
  assert.equal(patched.sensitivity, "sensitive");
  assert.equal(patched.expiresAt, iso(-HOUR), "the owner may expire an item right away");
  assert.equal(patched.enabled, true);
  assert.equal(patched.updatedAt, iso(HOUR));
  assert.equal((await updateTrendItem(created.id, { expiresAt: iso(200 * DAY) }, { env, now: NOW })).expiresAt, iso(60 * DAY));

  for (const patch of [{ kind: "meme" }, { source: "hermes" }, { platforms: ["x"] }, { title: "" }, { keywords: [] }, { enabled: "ya" }, [], null]) {
    await assert.rejects(updateTrendItem(created.id, patch, { env, now: NOW }), { code: "invalid_item" }, JSON.stringify(patch));
  }
  await assert.rejects(updateTrendItem(created.id, { title: "LAIN" }, { env, now: NOW }), { code: "duplicate" });
  await assert.rejects(updateTrendItem("5b0b8d1e-8a57-4c1f-9a53-3b2d2f7e0a11", { title: "x y" }, { env, now: NOW }), { code: "not_found" });
  await assert.rejects(updateTrendItem("../../etc", { title: "x y" }, { env, now: NOW }), { code: "not_found" });

  assert.equal(await deleteTrendItem(other.id, { env, now: NOW }), true);
  assert.equal(await deleteTrendItem(other.id, { env, now: NOW }), false);
  assert.deepEqual((await readTrendContext({ env })).document.items.map((entry) => entry.id), [created.id]);
});

test("the agent listing shows active items only; an agent deletes only its own items", async () => {
  const { env } = await sandbox();
  await ingestTrendItems([
    item({ externalId: "k1" }),
    item({ externalId: "k2", title: "Habis", keywords: ["habis habis"], expiresAt: iso(HOUR) }),
  ], { env, source: "hermes", now: NOW });
  await createManualTrend(item({ title: "Manual", keywords: ["manual manual"], externalId: "k3" }), { env, now: NOW });
  const listed = await listActiveTrendSummaries({ env, now: at(2 * HOUR) });
  assert.deepEqual(listed.map((entry) => entry.externalId), ["k1", "k3"]);
  assert.deepEqual(Object.keys(listed[0]), ["id", "externalId", "kind", "title", "expiresAt", "updatedAt"]);

  assert.equal(await deleteTrendByExternalId("k1", { env, source: "other-agent", now: NOW }), false);
  assert.equal(await deleteTrendByExternalId("k3", { env, source: "hermes", now: NOW }), false, "manual items are not the agent's");
  assert.equal(await deleteTrendByExternalId("k1", { env, source: "hermes", now: NOW }), true);
  assert.equal(await deleteTrendByExternalId("k1", { env, source: "hermes", now: NOW }), false);
});

// --- Snapshot -------------------------------------------------------------------------------

test("the snapshot holds enabled active items only, top 300 by score then newest, without source data", async () => {
  const { env } = await sandbox();
  const items = numbered(305, (index) => ({ score: index % 100, externalId: index % 2 ? `ext:${index}` : undefined }));
  await ingestAll(items, { env, source: "hermes-secret-label", now: NOW });
  const later = numbered(1, () => ({ title: "Tren nomor 99", keywords: ["tren nomor 99"], score: 99 }));
  await ingestTrendItems(later, { env, source: "hermes-secret-label", now: at(HOUR) });
  const { document } = await readTrendContext({ env });

  const snapshot = buildTrendSnapshot(document, { now: at(2 * HOUR) });
  assert.deepEqual(Object.keys(snapshot), ["version", "generatedAt", "items"]);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.generatedAt, iso(2 * HOUR));
  assert.equal(snapshot.items.length, 300);
  const scores = snapshot.items.map((entry) => entry.score);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));
  assert.equal(snapshot.items[0].title, "Tren nomor 99", "the most recently updated of equal scores first");
  const withExternal = snapshot.items.find((entry) => entry.externalId);
  assert.deepEqual(Object.keys(withExternal), [
    "id", "externalId", "kind", "title", "summary", "keywords", "hashtags", "platforms", "region",
    "score", "sensitivity", "firstSeenAt", "expiresAt", "enabled",
  ]);
  assert.equal(snapshot.items.find((entry) => !entry.externalId).externalId, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /hermes-secret-label|examples|createdAt|updatedAt|source/);

  assert.equal(buildTrendSnapshot({ ...document, enabled: false }, { now: NOW }), null);
  assert.equal(buildTrendSnapshot({ ...document, items: document.items.map((entry) => ({ ...entry, enabled: false })) }, { now: NOW }), null);
  assert.equal(buildTrendSnapshot(document, { now: at(30 * DAY) }), null, "everything expired");
  assert.equal(buildTrendSnapshot({ ...document, items: [] }, { now: NOW }), null);
});

test("writeTrendSnapshot writes analysis/trend-context.json (0600) only when there is something to write", async () => {
  const { env, root } = await sandbox();
  const attempt = path.join(root, "attempt");
  assert.equal(await writeTrendSnapshot(attempt, { env, now: NOW }), null);
  await assert.rejects(lstat(path.join(attempt, "analysis")), { code: "ENOENT" });

  await ingestTrendItems([item()], { env, source: "hermes", now: NOW });
  await setTrendContextEnabled(false, { env, now: NOW });
  assert.equal(await writeTrendSnapshot(attempt, { env, now: NOW }), null);
  await setTrendContextEnabled(true, { env, now: NOW });

  const written = await writeTrendSnapshot(attempt, { env, now: NOW });
  assert.equal(written, path.join(attempt, "analysis", "trend-context.json"));
  assert.equal((await stat(written)).mode & 0o777, 0o600);
  const snapshot = JSON.parse(await readFile(written, "utf8"));
  assert.deepEqual(snapshot, buildTrendSnapshot((await readTrendContext({ env })).document, { now: NOW }));
  assert.equal(snapshot.items[0].title, "Kabur Aja Dulu");
});
