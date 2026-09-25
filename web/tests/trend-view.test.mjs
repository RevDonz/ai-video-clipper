// Konteks Tren UI: pure view helpers (web/lib/trend-view.mjs), the browser
// API client (web/components/trends/trend-api.mjs) and the "Nyambung tren"
// chips on V3 clips (web/lib/selection-v3-view.mjs). Spec §3.2 and §5.
process.env.TZ = "Asia/Jakarta";

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTrendApi } from "../components/trends/trend-api.mjs";
import { clipTrendChips, selectionWarningLabel } from "../lib/selection-v3-view.mjs";
import {
  GUIDE_URL,
  SESSION_TEXT,
  TREND_KINDS,
  TREND_KIND_LABELS,
  TREND_LIMITS,
  TREND_PLATFORMS,
  TREND_PLATFORM_LABELS,
  activeTokenCount,
  apiErrorMessage,
  cleanLine,
  cleanMultiline,
  createdTokenFrom,
  curlExample,
  dateInputValue,
  draftFromTrendItem,
  emptyTrendDraft,
  expiryDateBounds,
  expiryFromDateInput,
  expiryView,
  filterTrendItems,
  groupTrendItems,
  ingestEndpoint,
  normalizeTokenList,
  normalizeTrendItem,
  normalizeTrendList,
  parseHashtags,
  parseKeywords,
  relativeTime,
  safeExampleUrl,
  shellQuote,
  sourceLabel,
  tokenView,
  trendCounts,
  trendCreatePayload,
  trendItemStatus,
  trendPatchPayload,
  validateTokenLabel,
} from "../lib/trend-view.mjs";

const NOW = Date.parse("2026-09-25T05:00:00Z"); // 12:00 in Jakarta (UTC+7)
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const TOKEN = `ptk_${"A".repeat(20)}-_${"b".repeat(21)}`;

function item(overrides = {}) {
  return normalizeTrendItem({
    id: "0b6f2c1e-1111-4222-8333-944444444444",
    externalId: "tiktok:tag:kabur-aja-dulu",
    kind: "topic",
    title: "Kabur Aja Dulu",
    summary: "Tagar ajakan merantau.",
    keywords: ["kabur aja dulu", "#KaburAjaDulu"],
    hashtags: ["#KaburAjaDulu"],
    platforms: ["tiktok", "x"],
    region: "ID",
    examples: [{ url: "https://www.tiktok.com/@a/video/1", note: "contoh" }],
    score: 72,
    sensitivity: "normal",
    firstSeenAt: "2026-09-24T08:00:00Z",
    expiresAt: "2026-10-05T00:00:00Z",
    source: "hermes",
    enabled: true,
    createdAt: "2026-09-24T08:00:01Z",
    updatedAt: "2026-09-24T08:00:01Z",
    ...overrides,
  });
}

// --- Labels and constants -------------------------------------------------------

test("every kind and platform of the spec has an Indonesian label", () => {
  assert.deepEqual(TREND_KINDS, ["topic", "person", "joke", "meme", "sound", "hashtag", "format", "event"]);
  assert.deepEqual(TREND_PLATFORMS, ["tiktok", "instagram", "youtube", "x", "facebook", "news", "other"]);
  for (const kind of TREND_KINDS) assert.ok(TREND_KIND_LABELS[kind], kind);
  for (const platform of TREND_PLATFORMS) assert.ok(TREND_PLATFORM_LABELS[platform], platform);
  assert.equal(TREND_KIND_LABELS.person, "Orang");
  assert.equal(TREND_PLATFORM_LABELS.news, "Berita");
  assert.equal(TREND_LIMITS.title, 80);
  assert.equal(TREND_LIMITS.maxActiveTokens, 10);
  assert.match(GUIDE_URL, /^https:\/\/github\.com\/.+\/docs\/integrations\/hermes-trends\/README\.md$/);
});

// --- Text cleaning ----------------------------------------------------------------

test("single-line text drops control, bidi and zero-width characters and newlines", () => {
  assert.equal(cleanLine("  Ka\u200Bbur\u202E aja\n\tdulu \u2066x\u2069\u0000 "), "Kabur aja dulu x");
  assert.equal(cleanLine("Cafe\u0301"), "Café", "NFC");
  assert.equal(cleanLine(`Kucing\ufe0f oren${String.fromCodePoint(0xe0041, 0xe0100)}\u00ad\u3164`), "Kucing oren", "like the server");
  assert.equal(cleanLine(42), "");
  assert.equal(cleanLine(null), "");
});

test("multi-line text keeps at most blank-line-separated newlines, normalized to \\n", () => {
  assert.equal(cleanMultiline(" satu\r\ndua \u202A\r\n\r\n\r\n\r\ntiga\u0007 "), "satu\ndua\n\ntiga");
  assert.equal(cleanMultiline(undefined), "");
});

// --- Item normalization -------------------------------------------------------------

test("a server item is normalized for display without trusting its shape", () => {
  const view = item();
  assert.equal(view.id, "0b6f2c1e-1111-4222-8333-944444444444");
  assert.equal(view.kind, "topic");
  assert.deepEqual(view.platforms, ["tiktok", "x"]);
  assert.equal(view.score, 72);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.examples, [{ url: "https://www.tiktok.com/@a/video/1", note: "contoh", host: "www.tiktok.com" }]);

  const hostile = normalizeTrendItem({
    id: "x1",
    kind: "<script>",
    title: "<img src=x onerror=alert(1)>\u202E",
    summary: 12,
    keywords: ["ok", 5, null, "  "],
    hashtags: ["#Valid", "not a tag", "#bad-tag"],
    platforms: ["tiktok", "myspace"],
    examples: [
      { url: "javascript:alert(1)", note: "x" },
      { url: "data:text/html,hi" },
      { url: "https://user:pw@evil.example/" },
      { url: "http://ok.example/a", note: "n".repeat(300) },
      "https://string.example/",
    ],
    score: 1e9,
    sensitivity: "SENSITIVE",
    enabled: "false",
    expiresAt: "not a date",
  });
  assert.equal(hostile.kind, "other");
  assert.equal(hostile.title, "<img src=x onerror=alert(1)>", "text stays text; React escapes it");
  assert.equal(hostile.summary, "");
  assert.deepEqual(hostile.keywords, ["ok"]);
  assert.deepEqual(hostile.hashtags, ["#Valid"]);
  assert.deepEqual(hostile.platforms, ["tiktok"]);
  assert.deepEqual(hostile.examples.map((example) => example.url), ["http://ok.example/a"]);
  assert.equal(Array.from(hostile.examples[0].note).length, TREND_LIMITS.exampleNote);
  assert.equal(hostile.score, null);
  assert.equal(hostile.sensitivity, "normal");
  assert.equal(hostile.enabled, true, "only an explicit false disables");
  assert.equal(hostile.expiresAt, null);

  const repeated = normalizeTrendItem({
    id: "x", title: "Ulang", examples: [{ url: "https://a.example/v/1" }, { url: "https://a.example/v/1", note: "lagi" }],
  });
  assert.deepEqual(repeated.examples.map((example) => example.url), ["https://a.example/v/1"], "one list key per url");
  assert.equal(normalizeTrendItem({ title: "no id" }), null);
  assert.equal(normalizeTrendItem(null), null);
  assert.equal(normalizeTrendItem({ id: "a", enabled: false }).enabled, false);
  assert.equal(normalizeTrendItem({ id: "a" }).title, "(tanpa judul)");
});

test("example links are http(s) only, without credentials, at most 500 characters", () => {
  assert.equal(safeExampleUrl("https://www.youtube.com/shorts/abc"), "https://www.youtube.com/shorts/abc");
  assert.equal(safeExampleUrl("http://example.com/x?y=1"), "http://example.com/x?y=1");
  for (const bad of [
    "javascript:alert(1)", " javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x",
    "/relative", "//evil.example/", "mailto:a@b.c", "ftp://x.example/", "https://a:b@x.example/",
    `https://x.example/${"a".repeat(500)}`, "", null, 7, "https://", "https://exa mple.com/",
  ]) assert.equal(safeExampleUrl(bad), null, String(bad));
});

test("the list payload is normalized; broken items are skipped, not fatal", () => {
  const list = normalizeTrendList({
    enabled: false,
    lastIngestAt: "2026-09-25T01:00:00Z",
    items: [{ id: "a", title: "A", kind: "person" }, null, { title: "no id" }, { id: "b", title: "B" }],
  });
  assert.equal(list.enabled, false);
  assert.equal(list.lastIngestAt, "2026-09-25T01:00:00.000Z");
  assert.deepEqual(list.items.map((entry) => entry.id), ["a", "b"]);
  assert.equal(normalizeTrendList({ items: [] }).enabled, true, "enabled defaults to true");
  assert.equal(normalizeTrendList({ items: [] }).lastIngestAt, null);
  assert.equal(normalizeTrendList({ enabled: true }), null, "items must be an array");
  assert.equal(normalizeTrendList(null), null);
});

// --- Status, relative time, grouping, filtering --------------------------------------

test("an item is expired, disabled or active; expired wins", () => {
  assert.equal(trendItemStatus(item(), NOW), "active");
  assert.equal(trendItemStatus(item({ enabled: false }), NOW), "disabled");
  assert.equal(trendItemStatus(item({ expiresAt: iso(NOW - 1000) }), NOW), "expired");
  assert.equal(trendItemStatus(item({ expiresAt: iso(NOW - 1000), enabled: false }), NOW), "expired");
  assert.equal(trendItemStatus(item({ expiresAt: iso(NOW) }), NOW), "expired");
  assert.equal(trendItemStatus(item({ expiresAt: null }), NOW), "active");
});

test("relative time reads naturally in Indonesian", () => {
  assert.equal(relativeTime(iso(NOW + 20_000), NOW), "kurang dari 1 menit lagi");
  assert.equal(relativeTime(iso(NOW - 20_000), NOW), "baru saja");
  assert.equal(relativeTime(iso(NOW + 5 * 60_000), NOW), "dalam 5 menit");
  assert.equal(relativeTime(iso(NOW - 59 * 60_000), NOW), "59 menit lalu");
  assert.equal(relativeTime(iso(NOW + 3 * HOUR), NOW), "dalam 3 jam");
  assert.equal(relativeTime(iso(NOW - 23 * HOUR), NOW), "23 jam lalu");
  assert.equal(relativeTime(iso(NOW + 23.8 * HOUR), NOW), "dalam 1 hari");
  assert.equal(relativeTime(iso(NOW + 9.6 * DAY), NOW), "dalam 10 hari");
  assert.equal(relativeTime(iso(NOW - 2 * DAY), NOW), "2 hari lalu");
  assert.equal(relativeTime("nope", NOW), null);
});

test("expiry is shown relative with a tone", () => {
  assert.deepEqual(
    { text: expiryView(item({ expiresAt: iso(NOW + 3 * DAY) }), NOW).text, tone: expiryView(item({ expiresAt: iso(NOW + 3 * DAY) }), NOW).tone },
    { text: "Berakhir dalam 3 hari", tone: "ok" },
  );
  const soon = expiryView(item({ expiresAt: iso(NOW + 5 * HOUR) }), NOW);
  assert.equal(soon.text, "Berakhir dalam 5 jam");
  assert.equal(soon.tone, "soon");
  const gone = expiryView(item({ expiresAt: iso(NOW - 2 * DAY) }), NOW);
  assert.equal(gone.text, "Kedaluwarsa 2 hari lalu");
  assert.equal(gone.tone, "expired");
  assert.ok(gone.absolute, "absolute date for the title attribute");
  assert.deepEqual(expiryView(item({ expiresAt: null }), NOW), { text: "Tanpa tanggal kedaluwarsa", tone: "ok", absolute: null });
});

test("items are grouped per kind in spec order; active, then score, then newest", () => {
  const items = [
    item({ id: "t-low", title: "Topik rendah", score: 10 }),
    item({ id: "p", kind: "person", title: "Orang", score: 50 }),
    item({ id: "t-expired", title: "Topik lama", score: 99, expiresAt: iso(NOW - DAY) }),
    item({ id: "t-high", title: "Topik tinggi", score: 90 }),
    item({ id: "t-off", title: "Topik mati", score: 95, enabled: false }),
    item({ id: "m", kind: "meme", title: "Meme", score: null }),
    item({ id: "t-new", title: "Topik baru", score: 90, updatedAt: "2026-09-25T00:00:00Z" }),
    normalizeTrendItem({ id: "u", kind: "mystery", title: "Aneh" }),
  ];
  const groups = groupTrendItems(items, NOW);
  assert.deepEqual(groups.map((group) => [group.kind, group.label, group.items.length]), [
    ["topic", "Topik", 5], ["person", "Orang", 1], ["meme", "Meme", 1], ["other", "Lainnya", 1],
  ]);
  assert.deepEqual(groups[0].items.map((entry) => entry.id), ["t-new", "t-high", "t-low", "t-off", "t-expired"]);
  assert.deepEqual(groupTrendItems([], NOW), []);
});

test("search folds case and accents and looks at title, summary, keywords and hashtags", () => {
  const items = [
    item({ id: "a", title: "Kafé Viral", keywords: ["kafe"], hashtags: [] }),
    item({ id: "b", title: "Lain", summary: "soal SEMBAKO naik", keywords: ["harga"], hashtags: [] }),
    item({ id: "c", title: "Tagar", keywords: ["xx"], hashtags: ["#KaburAjaDulu"] }),
    item({ id: "d", kind: "person", title: "Orang", keywords: ["orang"], hashtags: [], enabled: false }),
    item({ id: "e", kind: "person", title: "Lama", keywords: ["lama"], hashtags: [], expiresAt: iso(NOW - DAY) }),
  ];
  const ids = (filters) => filterTrendItems(items, filters, NOW).map((entry) => entry.id);
  assert.deepEqual(ids({}), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids({ query: "  KAFE " }), ["a"]);
  assert.deepEqual(ids({ query: "sembako" }), ["b"]);
  assert.deepEqual(ids({ query: "kaburajadulu" }), ["c"]);
  assert.deepEqual(ids({ kind: "person" }), ["d", "e"]);
  assert.deepEqual(ids({ status: "active" }), ["a", "b", "c"]);
  assert.deepEqual(ids({ status: "disabled" }), ["d"]);
  assert.deepEqual(ids({ status: "expired" }), ["e"]);
  assert.deepEqual(ids({ kind: "person", status: "active" }), []);

  const counts = trendCounts(items, NOW);
  assert.equal(counts.all, 5);
  assert.equal(counts.active, 3);
  assert.equal(counts.disabled, 1);
  assert.equal(counts.expired, 1);
  assert.equal(counts.byKind.person, 2);
  assert.equal(counts.byKind.topic, 3);
  assert.equal(trendCounts([item({ sensitivity: "sensitive" })], NOW).sensitive, 1);
});

test("source labels tell manual items from agent items", () => {
  assert.equal(sourceLabel("manual"), "Manual");
  assert.equal(sourceLabel("hermes"), "Agen: hermes");
  assert.equal(sourceLabel(""), "Tidak diketahui");
});

// --- Draft parsing and validation ------------------------------------------------------

test("keywords split on commas or new lines; hashtags on spaces or commas, with #", () => {
  assert.deepEqual(parseKeywords("kabur aja dulu, #KaburAjaDulu\n Kabur Aja Dulu ,, x"), ["kabur aja dulu", "#KaburAjaDulu", "x"]);
  assert.deepEqual(parseHashtags("KaburAjaDulu #fyp, ##viral  #FYP"), ["#KaburAjaDulu", "#fyp", "#viral"]);
  assert.deepEqual(parseKeywords(""), []);
});

test("a manual item validates like the server and builds the create payload", () => {
  const draft = {
    ...emptyTrendDraft(),
    kind: "person",
    title: "  Nama \u202EOrang ",
    summary: "Baris satu\nBaris dua",
    keywordsText: "nama orang, orang itu",
    hashtagsText: "NamaOrang",
    platforms: ["tiktok", "youtube"],
    score: "80",
    sensitivity: "sensitive",
    expiresDate: "2026-10-01",
  };
  const { payload, errors } = trendCreatePayload(draft, NOW);
  assert.deepEqual(errors, {});
  assert.deepEqual(payload, {
    kind: "person",
    title: "Nama Orang",
    summary: "Baris satu\nBaris dua",
    keywords: ["nama orang", "orang itu"],
    hashtags: ["#NamaOrang"],
    platforms: ["tiktok", "youtube"],
    score: 80,
    sensitivity: "sensitive",
    expiresAt: new Date(2026, 9, 1, 23, 59, 0, 0).toISOString(),
  });
  assert.ok(!("source" in payload) && !("id" in payload) && !("enabled" in payload));

  const minimal = trendCreatePayload({ ...emptyTrendDraft(), title: "Judul", keywordsText: "judul" }, NOW);
  assert.deepEqual(minimal.errors, {});
  assert.deepEqual(minimal.payload, { kind: "topic", title: "Judul", keywords: ["judul"], sensitivity: "normal" });
});

test("invalid manual drafts name the field with an Indonesian message", () => {
  const { errors } = trendCreatePayload({
    ...emptyTrendDraft(),
    kind: "rumor",
    title: "x".repeat(81),
    summary: "a\nb\nc\nd\ne\nf",
    keywordsText: "a, ok",
    hashtagsText: "#bad-tag",
    platforms: ["myspace"],
    score: "101",
    expiresDate: "2026-09-24",
  }, NOW);
  assert.match(errors.kind, /jenis/i);
  assert.match(errors.title, /80 karakter/);
  assert.match(errors.summary, /5 baris/);
  assert.match(errors.keywords, /“a”.*2–40/);
  assert.match(errors.hashtags, /#bad-tag/);
  assert.match(errors.platforms, /platform/i);
  assert.match(errors.score, /0–100/);
  assert.match(errors.expiresAt, /hari ini/);

  const empty = trendCreatePayload(emptyTrendDraft(), NOW).errors;
  assert.match(empty.title, /wajib/);
  assert.match(empty.keywords, /minimal satu/);
  assert.deepEqual(Object.keys(empty).sort(), ["keywords", "title"]);

  const many = trendCreatePayload({
    ...emptyTrendDraft(), title: "t",
    keywordsText: Array.from({ length: 13 }, (_, n) => `kata${n}`).join(","),
    hashtagsText: Array.from({ length: 11 }, (_, n) => `#t${n}`).join(" "),
    summary: "s".repeat(501), score: "1.5",
  }, NOW).errors;
  assert.match(many.keywords, /12/);
  assert.match(many.hashtags, /10/);
  assert.match(many.summary, /500/);
  assert.match(many.score, /bulat/);
});

test("expiry dates stay within today .. 60 days and become an end-of-day ISO time", () => {
  assert.deepEqual(expiryDateBounds(NOW), { min: "2026-09-25", max: "2026-11-24" });
  assert.equal(dateInputValue("2026-10-05T00:00:00Z"), "2026-10-05");
  assert.equal(dateInputValue("2026-10-04T18:00:00Z"), "2026-10-05", "local (Jakarta) calendar day");
  assert.equal(dateInputValue(null), "");
  assert.equal(expiryFromDateInput("2026-09-25", NOW).iso, new Date(2026, 8, 25, 23, 59, 0, 0).toISOString());
  const last = expiryFromDateInput("2026-11-24", NOW);
  assert.equal(last.error, undefined);
  assert.ok(Date.parse(last.iso) <= NOW + 60 * DAY, "clamped under the 60-day server limit");
  assert.match(expiryFromDateInput("2026-11-25", NOW).error, /60 hari/);
  assert.match(expiryFromDateInput("2026-09-24", NOW).error, /hari ini/);
  assert.match(expiryFromDateInput("2026-02-31", NOW).error, /tidak valid/);
  assert.match(expiryFromDateInput("25/09/2026", NOW).error, /tidak valid/);
});

test("inline edit sends only the fields that changed, and only editable ones", () => {
  const original = item({ expiresAt: "2026-10-05T00:00:00Z" });
  const draft = draftFromTrendItem(original);
  assert.deepEqual(draft, {
    title: "Kabur Aja Dulu",
    summary: "Tagar ajakan merantau.",
    keywordsText: "kabur aja dulu, #KaburAjaDulu",
    hashtagsText: "#KaburAjaDulu",
    sensitivity: "normal",
    expiresDate: "2026-10-05",
    enabled: true,
  });
  assert.deepEqual(trendPatchPayload(original, draft, NOW), { payload: {}, errors: {}, changed: false });

  const edited = trendPatchPayload(original, {
    ...draft,
    title: "Kabur Aja Dulu ",
    keywordsText: "kabur aja dulu, #KaburAjaDulu, merantau",
    sensitivity: "sensitive",
    enabled: false,
    expiresDate: "2026-10-10",
  }, NOW);
  assert.deepEqual(edited.errors, {});
  assert.equal(edited.changed, true);
  assert.deepEqual(edited.payload, {
    keywords: ["kabur aja dulu", "#KaburAjaDulu", "merantau"],
    sensitivity: "sensitive",
    expiresAt: new Date(2026, 9, 10, 23, 59, 0, 0).toISOString(),
    enabled: false,
  });

  const cleared = trendPatchPayload(original, { ...draft, summary: "", hashtagsText: "" }, NOW);
  assert.deepEqual(cleared.payload, { summary: "", hashtags: [] });

  const bad = trendPatchPayload(original, { ...draft, title: " ", expiresDate: "" }, NOW);
  assert.match(bad.errors.title, /wajib/);
  assert.match(bad.errors.expiresAt, /wajib/);

  // An item that already expired keeps its past date unless the owner changes it.
  const expired = item({ expiresAt: iso(NOW - 3 * DAY) });
  assert.deepEqual(trendPatchPayload(expired, { ...draftFromTrendItem(expired), title: "Baru" }, NOW).payload, { title: "Baru" });
});

// --- Tokens and the agent section ------------------------------------------------------------

test("token labels are 1..40 visible characters", () => {
  assert.deepEqual(validateTokenLabel("  Hermes VPS \u200B"), { label: "Hermes VPS", error: null });
  assert.match(validateTokenLabel("   ").error, /wajib/);
  assert.match(validateTokenLabel("x".repeat(41)).error, /40/);
});

test("token lists never carry hashes or values; active tokens come first", () => {
  const tokens = normalizeTokenList({ tokens: [
    { id: "old", label: "Lama", prefix: "ptk_Ab12", createdAt: "2026-09-01T00:00:00Z", lastUsedAt: null, revokedAt: "2026-09-10T00:00:00Z", sha256: "f".repeat(64) },
    { id: "new", label: "Hermes", prefix: "ptk_Cd34", createdAt: "2026-09-20T00:00:00Z", lastUsedAt: "2026-09-25T04:00:00Z", revokedAt: null, token: TOKEN, hash: "x" },
    { label: "no id" },
  ] });
  assert.deepEqual(tokens.map((token) => token.id), ["new", "old"]);
  for (const token of tokens) {
    assert.deepEqual(Object.keys(token).sort(), ["createdAt", "id", "label", "lastUsedAt", "prefix", "revokedAt"]);
  }
  assert.equal(JSON.stringify(tokens).includes(TOKEN), false);
  assert.equal(activeTokenCount(tokens), 1);
  assert.equal(normalizeTokenList({}), null);

  const active = tokenView(tokens[0], NOW);
  assert.equal(active.status, "active");
  assert.equal(active.statusLabel, "Aktif");
  assert.equal(active.prefixText, "ptk_Cd34…");
  assert.equal(active.lastUsedText, "1 jam lalu");
  const revoked = tokenView(tokens[1], NOW);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.lastUsedText, "Belum pernah dipakai");
  assert.match(revoked.statusLabel, /^Dicabut/);
});

test("a created token is accepted only in the documented ptk_ format", () => {
  const created = createdTokenFrom({ token: TOKEN, id: "t1", label: "Hermes", prefix: "ptk_AAAA", createdAt: "2026-09-25T05:00:00Z", lastUsedAt: null, revokedAt: null });
  assert.equal(created.token, TOKEN);
  assert.deepEqual(created.record, { id: "t1", label: "Hermes", prefix: "ptk_AAAA", createdAt: "2026-09-25T05:00:00.000Z", lastUsedAt: null, revokedAt: null });
  assert.equal(createdTokenFrom({ token: `${TOKEN}x` }), null);
  assert.equal(createdTokenFrom({ token: "sk-something" }), null);
  assert.equal(createdTokenFrom({}), null);
  const nested = createdTokenFrom({ token: TOKEN, item: { id: "t2", label: "L", prefix: "ptk_AAAA", createdAt: "2026-09-25T05:00:00Z" } });
  assert.equal(nested.record.id, "t2");
});

test("the endpoint and curl example use the page origin and never a fixed host", () => {
  assert.equal(ingestEndpoint("https://potongin.example"), "https://potongin.example/api/ingest/trends");
  assert.equal(ingestEndpoint("http://127.0.0.1:3100"), "http://127.0.0.1:3100/api/ingest/trends");
  assert.equal(ingestEndpoint("javascript:alert(1)"), null);
  assert.equal(ingestEndpoint("null"), null);
  assert.equal(ingestEndpoint(undefined), null);

  // Like the Hermes kit: the token is typed into a hidden prompt, never written into a command
  // (shell history), and the agent lists the active items before it posts. The header reaches
  // curl on stdin from the printf builtin, so the token is never in a process's argv (ps).
  const withToken = curlExample({ origin: "https://potongin.example", token: TOKEN });
  const lines = withToken.split("\n");
  const header = `printf 'Authorization: Bearer %s\\n' "$POTONGIN_INGEST_TOKEN" |`;
  assert.equal(lines[0], "read -rs POTONGIN_INGEST_TOKEN && export POTONGIN_INGEST_TOKEN");
  assert.equal(lines[1], `${header} curl -sS -H @- 'https://potongin.example/api/ingest/trends'`);
  assert.equal(lines[2], `${header} curl -sS -X POST 'https://potongin.example/api/ingest/trends' \\`);
  assert.equal(lines[3], "  -H @- \\");
  for (const line of lines) assert.doesNotMatch(line, /curl.*Authorization/, "never a token header in curl's arguments");
  assert.match(withToken, /-H 'Content-Type: application\/json'/);
  assert.doesNotMatch(withToken, /curl[^\n]* -v\b|--verbose/);
  const body = /--data '(.*)'$/m.exec(withToken)[1];
  const parsed = JSON.parse(body);
  assert.equal(parsed.items.length, 1);
  assert.equal(typeof parsed.items[0].externalId, "string");
  assert.ok(TREND_KINDS.includes(parsed.items[0].kind));
  assert.ok(parsed.items[0].keywords.length >= 1);
  assert.equal(withToken.includes(TOKEN), false, "the token value is never part of the example");
  assert.equal(curlExample({ origin: "https://potongin.example" }), withToken);
  assert.match(curlExample({ origin: "bogus" }), /'\/api\/ingest\/trends'/);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("API errors become short Indonesian messages without server internals", () => {
  assert.equal(apiErrorMessage({ status: 401, payload: null }, "x"), SESSION_TEXT);
  assert.match(apiErrorMessage({ status: 0, payload: null }, "x"), /tidak bisa dihubungi/);
  assert.match(apiErrorMessage({ status: 429, payload: { error: "" } }, "x"), /Terlalu banyak/);
  assert.equal(apiErrorMessage({ status: 400, payload: { error: "Judul wajib diisi.", code: "invalid_body" } }, "x"), "Judul wajib diisi.");
  assert.equal(apiErrorMessage({ status: 500, payload: { error: "Boom\u202E\nline" } }, "Gagal."), "Boom line");
  assert.equal(apiErrorMessage({ status: 500, payload: "<html>" }, "Gagal."), "Gagal.");
  assert.match(apiErrorMessage({ status: 404, payload: null }, "x"), /tidak ditemukan/);
  assert.match(apiErrorMessage({ status: 503, payload: null }, "x"), /tidak tersedia/);
  assert.match(apiErrorMessage({ status: 403, payload: null }, "x"), /ditolak/);
});

// --- API client (mocked fetch) -----------------------------------------------------------------

function mockFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body } = next || {};
    const call = calls.at(-1);
    call.bodyRead = false;
    const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        call.bodyRead = true;
        if (!raw) throw new SyntaxError("Unexpected end of JSON input");
        return JSON.parse(raw);
      },
      text: async () => {
        call.bodyRead = true;
        return raw;
      },
    };
  };
  return { calls, fetchImpl };
}

test("the client reads every response body, 204 included (Chromium reports an unread 204 as aborted)", async () => {
  const { calls, fetchImpl } = mockFetch([{ status: 204 }, { status: 204 }, { status: 200, body: { token: { id: "t1" } } }, { status: 404, body: "not json" }]);
  const api = createTrendApi(fetchImpl);
  assert.equal((await api.deleteTrend("a")).ok, true);
  assert.equal((await api.deleteTrend("b")).ok, true);
  assert.equal((await api.revokeToken("t1")).ok, true);
  const missing = await api.deleteTrend("c");
  assert.equal(missing.status, 404);
  assert.deepEqual(calls.map((call) => call.bodyRead), [true, true, true, true]);
});

test("the client calls the spec §3.2 routes with the right methods and bodies", async () => {
  const { calls, fetchImpl } = mockFetch([
    { body: { enabled: true, lastIngestAt: null, items: [{ id: "a", title: "A" }] } },
    { status: 201, body: { item: { id: "n", title: "Baru", kind: "topic", source: "manual" } } },
    { body: { item: { id: "a/b", title: "Ubah" } } },
    { status: 204 },
    { body: { enabled: false } },
    { body: { tokens: [] } },
    { status: 201, body: { token: TOKEN, id: "t1", label: "Hermes", prefix: "ptk_AAAA", createdAt: "2026-09-25T05:00:00Z" } },
    { body: { id: "t1", label: "Hermes", prefix: "ptk_AAAA", createdAt: "2026-09-25T05:00:00Z", revokedAt: "2026-09-25T06:00:00Z" } },
  ]);
  const api = createTrendApi(fetchImpl);

  const list = await api.loadTrends();
  assert.equal(list.ok, true);
  assert.deepEqual(list.data.items.map((entry) => entry.id), ["a"]);
  const created = await api.createTrend({ kind: "topic", title: "Baru", keywords: ["baru"] });
  assert.equal(created.data.id, "n");
  const updated = await api.updateTrend("a/b", { title: "Ubah" });
  assert.equal(updated.data.title, "Ubah");
  assert.equal((await api.deleteTrend("a/b")).ok, true);
  assert.equal((await api.setEnabled(false)).data.enabled, false);
  assert.deepEqual((await api.loadTokens()).data, []);
  const token = await api.createToken("Hermes");
  assert.equal(token.data.token, TOKEN);
  assert.equal(token.data.record.id, "t1");
  assert.equal((await api.revokeToken("t1")).ok, true);

  assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
    ["GET", "/api/context/trends"],
    ["POST", "/api/context/trends"],
    ["PATCH", "/api/context/trends/a%2Fb"],
    ["DELETE", "/api/context/trends/a%2Fb"],
    ["PUT", "/api/context/trends/settings"],
    ["GET", "/api/context/tokens"],
    ["POST", "/api/context/tokens"],
    ["DELETE", "/api/context/tokens/t1"],
  ]);
  for (const { init } of calls) {
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "same-origin");
  }
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), { kind: "topic", title: "Baru", keywords: ["baru"] });
  assert.deepEqual(JSON.parse(calls[2].init.body), { title: "Ubah" });
  assert.deepEqual(JSON.parse(calls[4].init.body), { enabled: false });
  assert.deepEqual(JSON.parse(calls[6].init.body), { label: "Hermes" });
});

test("the client reports failures as messages and tolerates odd bodies", async () => {
  const { fetchImpl } = mockFetch([
    { status: 401, body: { error: "Sesi login diperlukan" } },
    new TypeError("Failed to fetch"),
    { status: 200, body: "{\"nope\":true}" },
    { status: 400, body: { error: "Kata kunci wajib diisi.", code: "invalid_body", field: "keywords" } },
    { status: 201, body: { token: "not-a-token" } },
    { status: 201 },
    { status: 409, body: { error: "Maksimal 10 token aktif.", code: "too_many_tokens" } },
  ]);
  const api = createTrendApi(fetchImpl);
  const unauthorized = await api.loadTrends();
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.error, SESSION_TEXT);
  const offline = await api.loadTokens();
  assert.equal(offline.status, 0);
  assert.match(offline.error, /tidak bisa dihubungi/);
  const odd = await api.loadTrends();
  assert.equal(odd.ok, false);
  assert.match(odd.error, /tidak dikenali/);
  const invalid = await api.createTrend({});
  assert.equal(invalid.error, "Kata kunci wajib diisi.");
  assert.equal(invalid.field, "keywords");
  const badToken = await api.createToken("x");
  assert.equal(badToken.ok, false);
  assert.match(badToken.error, /token/i);
  const createdWithoutBody = await api.createTrend({ title: "x" });
  assert.equal(createdWithoutBody.ok, true);
  assert.equal(createdWithoutBody.data, null, "the page reloads the list when the body is missing");
  assert.equal((await api.createToken("x")).error, "Maksimal 10 token aktif.");

  const aborted = createTrendApi(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  await assert.rejects(aborted.loadTrends(), { name: "AbortError" });
});

test("the client marks the field named by the server's 422 issues and token label errors", async () => {
  const { fetchImpl } = mockFetch([
    { status: 422, body: { error: "Item tren belum valid.", code: "invalid_item", issues: [{ field: "keywords[1]", code: "invalid_length" }, { field: "title", code: "missing_field" }] } },
    { status: 422, body: { error: "Item tren belum valid.", code: "invalid_item", issues: [{ field: "examples[0].url", code: "invalid_value" }, { field: "hashtags[2]", code: "invalid_value" }] } },
    { status: 422, body: { error: "Item tren belum valid.", code: "invalid_item", issues: [{ field: null, code: "invalid_item" }] } },
    { status: 422, body: { error: "Label token wajib diisi.", code: "invalid_label" } },
    { status: 409, body: { error: "Label ini sudah dipakai token aktif lain.", code: "label_taken" } },
  ]);
  const api = createTrendApi(fetchImpl);
  assert.equal((await api.createTrend({})).field, "keywords");
  assert.equal((await api.updateTrend("a", {})).field, "hashtags", "the first issue on a field the form shows");
  assert.equal((await api.createTrend({})).field, null);
  assert.equal((await api.createToken("")).field, "label");
  const taken = await api.createToken("Hermes");
  assert.equal(taken.field, "label");
  assert.equal(taken.error, "Label ini sudah dipakai token aktif lain.");
});

// --- "Nyambung tren" chips on V3 clips ------------------------------------------------------

test("clips without trends get no chips (nothing changes for them)", () => {
  for (const clip of [{}, { trends: [] }, { trends: null }, { trends: "x" }, { trends: {} }, null, undefined]) {
    assert.deepEqual(clipTrendChips(clip), [], JSON.stringify(clip));
  }
});

test("grounded trends become 'Nyambung tren: <judul>' chips, sanitized and bounded", () => {
  const chips = clipTrendChips({ trends: [
    { id: "T1", title: "Kabur Aja Dulu", kind: "topic" },
    { id: "T2", title: " <b>Nama\u202E Orang</b>\n", kind: "person" },
    { id: "T1", title: "Kabur Aja Dulu", kind: "topic" },
    { id: "T3", title: "", kind: "meme" },
    { title: 5 },
    "T4",
    { id: "T5", title: "x".repeat(200), kind: "weird" },
    { id: "T6", title: "Enam", kind: "sound" },
    { id: "T7", title: "Tujuh", kind: "sound" },
    { id: "T8", title: "Delapan", kind: "sound" },
  ] });
  assert.deepEqual(chips.slice(0, 2), [
    { key: "T1", title: "Kabur Aja Dulu", label: "Nyambung tren: Kabur Aja Dulu", kindLabel: "Topik" },
    { key: "T2", title: "<b>Nama Orang</b>", label: "Nyambung tren: <b>Nama Orang</b>", kindLabel: "Orang" },
  ]);
  assert.equal(chips[2].key, "T5");
  assert.equal(Array.from(chips[2].title).length, 80);
  assert.equal(chips[2].kindLabel, null);
  assert.deepEqual(chips.map((chip) => chip.key), ["T1", "T2", "T5", "T6", "T7"], "at most five chips per clip");
});

test("the trend warning codes of a V3 summary get an Indonesian explanation", () => {
  assert.equal(selectionWarningLabel("trend_context_invalid"), "File konteks tren job rusak atau hilang; job jalan tanpa tren.");
  assert.equal(selectionWarningLabel("trend_items_skipped:3"), "3 item tren rusak dilewati.");
  assert.equal(selectionWarningLabel("trend_ref_ungrounded:2"), "2 tren yang disebut AI dibuang karena tidak disebut di transkrip klipnya.");
  assert.equal(
    selectionWarningLabel("trend_packaging_ungrounded:1"),
    "1 klip AI menyebut tren yang tidak ada di transkripnya; judul, hook atau deskripsinya diganti dari klip itu sendiri.",
  );
  assert.equal(
    selectionWarningLabel("trend_sensitive_humor:2"),
    "2 klip lucu menyinggung tren sensitif; periksa judul dan hook-nya sebelum diunggah.",
  );
  for (const code of ["llm_disabled", "trend_items_skipped", "trend_items_skipped:x", "trend_ref_ungrounded:0x", "suspect_segments:4", "", null, 7]) {
    assert.equal(selectionWarningLabel(code), null, String(code));
  }
});

// --- Source guards -------------------------------------------------------------------------

const WEB = fileURLToPath(new URL("..", import.meta.url));

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(path.join(WEB, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(relative));
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push([relative, await readFile(path.join(WEB, relative), "utf8")]);
  }
  return out;
}

test("the trends UI never renders HTML, never uses browser dialogs, and hardens external links", async () => {
  const files = [...await sources("app/trends"), ...await sources("components/trends")];
  assert.ok(files.some(([name]) => name === path.join("app", "trends", "page.jsx")));
  for (const [name, text] of files) {
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML/, name);
    assert.doesNotMatch(text, /window\.(confirm|alert|prompt)\s*\(|\b(confirm|alert|prompt)\s*\(/, name);
    assert.doesNotMatch(text, /console\.(log|info|debug)\s*\(/, name);
    assert.doesNotMatch(text, /localStorage|sessionStorage/, name);
    for (const anchor of text.match(/<a\b[^>]*target="_blank"[^>]*>/g) || []) {
      assert.match(anchor, /rel="noopener noreferrer( nofollow)?"/, `${name}: ${anchor}`);
    }
  }
  const examples = files.map(([, text]) => text).join("\n").match(/<a\b[^>]*href=\{example\.url\}[^>]*>/g) || [];
  assert.ok(examples.length > 0, "example links are rendered");
  for (const anchor of examples) assert.match(anchor, /rel="noopener noreferrer nofollow"/);
});

test("the dashboard header links to Konteks Tren", async () => {
  const dashboard = await readFile(path.join(WEB, "app", "dashboard", "page.jsx"), "utf8");
  assert.match(dashboard, /<a href="\/trends">Konteks Tren<\/a>/);
});
