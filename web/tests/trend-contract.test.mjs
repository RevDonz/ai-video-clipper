// Konteks Tren contract between the web app and the engine: the per-job snapshot the worker
// writes is the exact file tests/test_trend_contract.py reads with the engine, and the clip
// trends the engine writes into the manifest pass the job API sanitizer unchanged.
// Regenerate the shared fixture with UPDATE_TREND_FIXTURE=1 npm test (ids are random).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sanitizeManifestClipFields } from "../lib/jobs.mjs";
import { ingestTrendItems, readTrendContext, updateTrendItem, writeTrendSnapshot } from "../lib/trend-context.mjs";

const FIXTURE = new URL("../../tests/fixtures/trend-context-snapshot.v1.json", import.meta.url);
const INGEST_AT = new Date("2026-09-24T08:00:00.000Z");
const SNAPSHOT_AT = new Date("2026-09-25T06:00:00.000Z");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const AGENT_ITEMS = [
  {
    externalId: "tiktok:tag:kabur-aja-dulu", kind: "topic", title: "Kabur Aja Dulu",
    summary: "Tagar ajakan merantau ke luar negeri.\r\n\r\nRamai di TikTok dan X.",
    keywords: ["kabur aja dulu", "#KaburAjaDulu"], hashtags: ["#KaburAjaDulu"], platforms: ["tiktok", "x"],
    score: 72, firstSeenAt: "2026-09-24T08:00:00Z", expiresAt: "2026-10-05T00:00:00Z",
  },
  // Spacing, a zero-width space, accents and a lowercase region: the server cleans them.
  { kind: "meme", title: "Café  Gaul​", keywords: ["café gaul"], hashtags: ["#CaféGaul"], region: "id", score: 64 },
  { kind: "person", title: "Tokoh Bencana", keywords: ["tokoh bencana"], sensitivity: "sensitive" },
  // Left out of the snapshot: disabled by the owner, and expired by the time the job starts.
  { externalId: "yt:sound:nonaktif", kind: "sound", title: "Lagu Nonaktif", keywords: ["lagu nonaktif"], score: 99 },
  { externalId: "news:kemarin", kind: "event", title: "Acara Kemarin", keywords: ["acara kemarin"], score: 90, expiresAt: "2026-09-25T00:00:00Z" },
];

async function workerSnapshot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trend-contract-"));
  try {
    const env = { JOBS_ROOT: path.join(root, "jobs"), POTONGIN_SETTINGS_DIR: path.join(root, "settings") };
    const result = await ingestTrendItems(AGENT_ITEMS, { env, source: "hermes", now: INGEST_AT });
    assert.equal(result.accepted, AGENT_ITEMS.length);
    const { document } = await readTrendContext({ env });
    const disabled = document.items.find((item) => item.externalId === "yt:sound:nonaktif");
    await updateTrendItem(disabled.id, { enabled: false }, { env, now: INGEST_AT });
    const target = await writeTrendSnapshot(path.join(root, "attempt"), { env, now: SNAPSHOT_AT });
    assert.equal(target, path.join(root, "attempt", "analysis", "trend-context.json"));
    return await readFile(target, "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the worker snapshot is byte for byte the fixture the engine test reads (ids aside)", async () => {
  const text = await workerSnapshot();
  if (process.env.UPDATE_TREND_FIXTURE === "1") await writeFile(FIXTURE, text);
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const snapshot = JSON.parse(text);
  assert.equal(snapshot.items.length, fixture.items.length);
  snapshot.items.forEach((item, index) => {
    assert.match(item.id, UUID_V4);
    assert.match(fixture.items[index].id, UUID_V4);
    item.id = fixture.items[index].id;
  });
  assert.equal(`${JSON.stringify(snapshot, null, 2)}\n`, await readFile(FIXTURE, "utf8"));
  assert.deepEqual(snapshot.items.map((item) => item.title), ["Kabur Aja Dulu", "Café Gaul", "Tokoh Bencana"]);
});

test("clip trends as the engine writes them reach the job API unchanged", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const trends = fixture.items.map(({ id, title, kind }) => ({ id, title, kind }));
  assert.deepEqual(sanitizeManifestClipFields({ title: "Klip", trends }).trends, trends);
});
