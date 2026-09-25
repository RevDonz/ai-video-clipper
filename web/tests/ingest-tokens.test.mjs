import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { INGEST_RATE_LIMITS, IngestRateLimiter } from "../lib/ingest-rate-limit.mjs";
import {
  INGEST_TOKEN_PATTERN,
  MAX_ACTIVE_TOKENS,
  createIngestToken,
  listIngestTokens,
  revokeIngestToken,
  verifyIngestToken,
} from "../lib/ingest-tokens.mjs";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingest-tokens-"));
  const dir = path.join(root, "settings");
  return { dir, file: path.join(dir, "ingest-tokens.json"), env: { JOBS_ROOT: path.join(root, "jobs"), POTONGIN_SETTINGS_DIR: dir } };
}

// --- Tokens ---------------------------------------------------------------------------------

test("a new token is ptk_ plus 43 base64url characters; only its SHA-256 is stored, in a 0600 file", async () => {
  const { dir, file, env } = await sandbox();
  const created = await createIngestToken("Hermes", { env, now: NOW });
  assert.match(created.token, /^ptk_[A-Za-z0-9_-]{43}$/);
  assert.match(created.token, INGEST_TOKEN_PATTERN);
  assert.deepEqual(Object.keys(created.record), ["id", "label", "prefix", "createdAt", "lastUsedAt", "revokedAt"]);
  assert.equal(created.record.label, "Hermes");
  assert.equal(created.record.prefix, created.token.slice(0, 10));
  assert.equal(created.record.createdAt, NOW.toISOString());
  assert.equal(created.record.lastUsedAt, null);
  assert.equal(created.record.revokedAt, null);

  const text = await readFile(file, "utf8");
  assert.ok(!text.includes(created.token), "the token value is never stored");
  assert.ok(!text.includes(created.token.slice(4)), "not even without its prefix");
  const document = JSON.parse(text);
  assert.deepEqual(Object.keys(document), ["version", "tokens"]);
  assert.deepEqual(document.tokens[0], {
    id: created.record.id, label: "Hermes", prefix: created.record.prefix, sha256: sha256(created.token),
    scopes: ["trends:write"], createdAt: NOW.toISOString(), lastUsedAt: null, revokedAt: null,
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), ["ingest-tokens.json"]);

  const second = await createIngestToken("Cadangan", { env, now: NOW });
  assert.notEqual(second.token, created.token);
  const listed = await listIngestTokens({ env });
  assert.deepEqual(listed, [created.record, second.record]);
  assert.doesNotMatch(JSON.stringify(listed), /sha256|ptk_[A-Za-z0-9_-]{43}/);
});

test("labels are 1..40 printable characters, unique among active tokens, and 'manual' is reserved", async () => {
  const { env } = await sandbox();
  for (const label of ["", " \u200b ", "x".repeat(41), "manual", " Manual ", 42, null]) {
    await assert.rejects(createIngestToken(label, { env, now: NOW }), { code: "invalid_label" }, JSON.stringify(label));
  }
  const first = await createIngestToken("  Hermes\u202e  Agent ", { env, now: NOW });
  assert.equal(first.record.label, "Hermes Agent");
  await assert.rejects(createIngestToken("hermes agent", { env, now: NOW }), { code: "label_taken" });
  await revokeIngestToken(first.record.id, { env, now: NOW });
  assert.equal((await createIngestToken("hermes agent", { env, now: NOW })).record.label, "hermes agent");
});

test("at most ten tokens are active at once", async () => {
  const { env } = await sandbox();
  const created = [];
  for (let index = 0; index < MAX_ACTIVE_TOKENS; index += 1) created.push(await createIngestToken(`Agen ${index}`, { env, now: NOW }));
  assert.equal(MAX_ACTIVE_TOKENS, 10);
  await assert.rejects(createIngestToken("Satu lagi", { env, now: NOW }), { code: "token_limit" });
  await revokeIngestToken(created[3].record.id, { env, now: NOW });
  assert.equal((await createIngestToken("Satu lagi", { env, now: NOW })).record.label, "Satu lagi");
});

test("revoking sets revokedAt once; unknown ids are reported as missing", async () => {
  const { env } = await sandbox();
  const { record } = await createIngestToken("Hermes", { env, now: NOW });
  const revoked = await revokeIngestToken(record.id, { env, now: at(1000) });
  assert.equal(revoked.revokedAt, at(1000).toISOString());
  assert.equal((await revokeIngestToken(record.id, { env, now: at(5000) })).revokedAt, at(1000).toISOString());
  assert.equal(await revokeIngestToken("5b0b8d1e-8a57-4c1f-9a53-3b2d2f7e0a11", { env, now: NOW }), null);
  assert.equal(await revokeIngestToken("../etc/passwd", { env, now: NOW }), null);
});

test("revoked tokens are kept as history, at most 50 of them", async () => {
  const { env } = await sandbox();
  for (let index = 0; index < 55; index += 1) {
    const { record } = await createIngestToken(`Agen ${index}`, { env, now: at(index * 1000) });
    await revokeIngestToken(record.id, { env, now: at(index * 1000 + 1) });
  }
  const listed = await listIngestTokens({ env });
  assert.equal(listed.length, 50);
  assert.equal(listed[0].label, "Agen 5", "the oldest revocations go first");
});

test("verification: missing, malformed, unknown, revoked and out-of-scope tokens fail with fixed codes", async () => {
  const { env } = await sandbox();
  const { token, record } = await createIngestToken("Hermes", { env, now: NOW });
  const unknown = `ptk_${crypto.randomBytes(32).toString("base64url")}`;
  const cases = [
    [null, 401, "missing_token"],
    ["", 401, "missing_token"],
    [`Basic ${Buffer.from("a:b").toString("base64")}`, 401, "invalid_token"],
    ["Bearer", 401, "invalid_token"],
    ["Bearer ptk_short", 401, "invalid_token"],
    [`Bearer ${token}x`, 401, "invalid_token"],
    [`Bearer ${token.slice(4)}`, 401, "invalid_token"],
    [`Bearer ${unknown}`, 401, "invalid_token"],
    [`Bearer  ${token} extra`, 401, "invalid_token"],
  ];
  for (const [header, status, code] of cases) {
    const result = await verifyIngestToken(header, { env, scope: "trends:write", now: NOW });
    assert.deepEqual(result, { ok: false, status, code }, String(header));
  }
  const ok = await verifyIngestToken(`Bearer ${token}`, { env, scope: "trends:write", now: NOW });
  assert.deepEqual(ok, { ok: true, token: { id: record.id, label: "Hermes", scopes: ["trends:write"] } });
  assert.equal((await verifyIngestToken(`bearer ${token}`, { env, scope: "trends:write", now: NOW })).ok, true);
  assert.deepEqual(await verifyIngestToken(`Bearer ${token}`, { env, scope: "admin:all", now: NOW }), { ok: false, status: 403, code: "insufficient_scope" });

  await revokeIngestToken(record.id, { env, now: NOW });
  assert.deepEqual(await verifyIngestToken(`Bearer ${token}`, { env, scope: "trends:write", now: NOW }), { ok: false, status: 401, code: "revoked_token" });
});

test("a read-only token may read but not write", async () => {
  const { file, env } = await sandbox();
  const { token } = await createIngestToken("Pembaca", { env, now: NOW });
  const document = JSON.parse(await readFile(file, "utf8"));
  document.tokens[0].scopes = ["trends:read"];
  await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  assert.equal((await verifyIngestToken(`Bearer ${token}`, { env, scope: "trends:read", now: NOW })).ok, true);
  assert.deepEqual(await verifyIngestToken(`Bearer ${token}`, { env, scope: "trends:write", now: NOW }), { ok: false, status: 403, code: "insufficient_scope" });
});

test("lastUsedAt is written at most once a minute", async () => {
  const { env } = await sandbox();
  const { token } = await createIngestToken("Hermes", { env, now: NOW });
  const header = `Bearer ${token}`;
  const lastUsed = async () => (await listIngestTokens({ env }))[0].lastUsedAt;
  await verifyIngestToken(header, { env, scope: "trends:write", now: NOW });
  assert.equal(await lastUsed(), NOW.toISOString());
  await verifyIngestToken(header, { env, scope: "trends:write", now: at(30_000) });
  assert.equal(await lastUsed(), NOW.toISOString());
  await verifyIngestToken(header, { env, scope: "trends:write", now: at(61_000) });
  assert.equal(await lastUsed(), at(61_000).toISOString());
});

test("an unreadable token file fails closed; the next token creation sets it aside", async () => {
  const { dir, file, env } = await sandbox();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, "{ rusak", { mode: 0o600 });
  const fake = `ptk_${crypto.randomBytes(32).toString("base64url")}`;
  assert.deepEqual(await verifyIngestToken(`Bearer ${fake}`, { env, scope: "trends:write", now: NOW }), { ok: false, status: 503, code: "storage_unavailable" });
  await assert.rejects(listIngestTokens({ env }), { code: "storage_unavailable" });
  const created = await createIngestToken("Hermes", { env, now: NOW });
  assert.equal((await listIngestTokens({ env })).length, 1);
  assert.ok((await readdir(dir)).some((name) => name.startsWith("ingest-tokens.json.corrupt-")));
  assert.equal((await verifyIngestToken(`Bearer ${created.token}`, { env, scope: "trends:write", now: NOW })).ok, true);

  const document = JSON.parse(await readFile(file, "utf8"));
  document.tokens[0].sha256 = "not-hex";
  await writeFile(file, JSON.stringify(document));
  assert.deepEqual(await verifyIngestToken(`Bearer ${created.token}`, { env, scope: "trends:write", now: NOW }), { ok: false, status: 503, code: "storage_unavailable" });
});

// --- Rate limit -----------------------------------------------------------------------------

test("the ingest limits are 60 requests a minute and 600 an hour per token", () => {
  assert.deepEqual(INGEST_RATE_LIMITS, { perMinute: 60, perHour: 600 });
  const limiter = new IngestRateLimiter();
  const start = NOW.getTime();
  for (let index = 0; index < 60; index += 1) assert.equal(limiter.consume("token-a", start + index).allowed, true);
  const denied = limiter.consume("token-a", start + 100);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 59 && denied.retryAfterSeconds <= 60, String(denied.retryAfterSeconds));
  assert.equal(limiter.consume("token-b", start + 100).allowed, true, "tokens are limited separately");
  assert.equal(limiter.consume("token-a", start + 60_000).allowed, true, "a new minute starts afresh");
});

test("the hourly limit holds across minutes and denied requests do not count", () => {
  const limiter = new IngestRateLimiter();
  const start = NOW.getTime();
  for (let minute = 0; minute < 10; minute += 1) {
    for (let index = 0; index < 60; index += 1) assert.equal(limiter.consume("token", start + minute * 60_000 + index).allowed, true);
    assert.equal(limiter.consume("token", start + minute * 60_000 + 500).allowed, false);
  }
  const denied = limiter.consume("token", start + 10 * 60_000);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds > 49 * 60 && denied.retryAfterSeconds <= 50 * 60, String(denied.retryAfterSeconds));
  assert.equal(limiter.consume("token", start + 3_600_000).allowed, true);
});

test("peek tells whether a key would be allowed without counting it", () => {
  const limiter = new IngestRateLimiter({ perMinute: 2, perHour: 10 });
  const start = NOW.getTime();
  assert.deepEqual(limiter.peek("client", start), { allowed: true, retryAfterSeconds: 0 });
  for (let index = 0; index < 5; index += 1) assert.equal(limiter.peek("client", start + index).allowed, true);
  limiter.consume("client", start);
  limiter.consume("client", start + 1);
  const blocked = limiter.peek("client", start + 2);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 59 && blocked.retryAfterSeconds <= 60, String(blocked.retryAfterSeconds));
  assert.equal(limiter.peek("client", start + 60_000).allowed, true, "the window ends");
  assert.throws(() => limiter.peek("", start));
});

test("the limiter validates its configuration and keys", () => {
  assert.throws(() => new IngestRateLimiter({ perMinute: 0 }));
  assert.throws(() => new IngestRateLimiter({ perHour: 1.5 }));
  const limiter = new IngestRateLimiter({ perMinute: 2, perHour: 3 });
  assert.throws(() => limiter.consume("", Date.now()));
  assert.equal(limiter.consume("k", 0).allowed, true);
  assert.equal(limiter.consume("k", 1).allowed, true);
  assert.equal(limiter.consume("k", 2).allowed, false);
  assert.equal(limiter.consume("k", 60_000).allowed, true);
  const hourly = limiter.consume("k", 60_001);
  assert.equal(hourly.allowed, false);
  assert.equal(hourly.retryAfterSeconds, 3540);
});
