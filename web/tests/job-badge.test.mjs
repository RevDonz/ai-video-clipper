// The job badge in the shared header (components/JobBadge.jsx, lib/job-badge.mjs): what it says,
// what it announces to screen readers, and when it asks the server again.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BADGE_POLL,
  INITIAL_BADGE_STATE,
  JOBS_CHANGED_EVENT,
  badgeAnnouncement,
  badgeReducer,
  badgeStateView,
  jobBadgeView,
  nextBadgeRequest,
  notifyJobsChanged,
} from "../lib/job-badge.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

const ID = {
  a: "0b9e5a52-1f3c-4d6e-8a7b-1c2d3e4f5a60",
  b: "1c0f6b63-2a4d-4e7f-9b8c-2d3e4f5a6b71",
  c: "2d1a7c74-3b5e-4f80-8c9d-3e4f5a6b7c82",
};
const at = (minute) => `2026-10-21T08:${String(minute).padStart(2, "0")}:00.000Z`;
const job = (id, status, extra = {}) => ({
  id, status, progress: 0, createdAt: at(0), source: { type: "upload", name: `Podcast ${id.slice(0, 2)}.mp4` }, clips: [], ...extra,
});
const clips = (count) => Array.from({ length: count }, (_, index) => ({ index: index + 1 }));

// --- What the badge says ----------------------------------------------------------------------

test("no jobs, or only projects being deleted, show no badge", () => {
  assert.equal(jobBadgeView([]), null);
  assert.equal(jobBadgeView(null), null);
  assert.equal(jobBadgeView(undefined), null);
  assert.equal(jobBadgeView([job(ID.a, "deleting")]), null);
  assert.equal(jobBadgeView([{ status: "processing", progress: 10 }]), null, "a job without an id is ignored");
});

test("a running job reads '1 berjalan · 42%' and links to its project", () => {
  const view = jobBadgeView([job(ID.a, "processing", { progress: 42 })]);
  assert.equal(view.kind, "running");
  assert.equal(view.jobId, ID.a);
  assert.equal(view.text, "1 berjalan · 42%");
  assert.equal(view.short, "42%");
  assert.equal(view.href, `/projects/${ID.a}`);
  assert.equal(view.title, "Podcast 0b.mp4");
  assert.equal(view.tone, null);
});

test("the percentage is a whole number from 0 to 100", () => {
  const percent = (progress) => jobBadgeView([job(ID.a, "processing", { progress })]).short;
  assert.equal(percent(41.6), "42%");
  assert.equal(percent(150), "100%");
  assert.equal(percent(-3), "0%");
  assert.equal(percent("x"), "0%");
  assert.equal(percent(undefined), "0%");
});

test("with several active jobs the badge counts them all and follows the one the worker has", () => {
  const working = job(ID.a, "processing", { progress: 30, createdAt: at(1) });
  const waiting = job(ID.b, "queued", { createdAt: at(5) });
  const view = jobBadgeView([waiting, working, job(ID.c, "completed", { createdAt: at(9), clips: clips(4) })]);
  assert.equal(view.text, "2 berjalan · 30%");
  assert.equal(view.jobId, ID.a);

  // Two picked up at once: the oldest, the order the queue runs them in.
  const older = job(ID.b, "downloading", { progress: 5, createdAt: at(2) });
  const newer = job(ID.a, "processing", { progress: 80, createdAt: at(3) });
  assert.equal(jobBadgeView([newer, older]).jobId, ID.b);

  // Only queued jobs: the oldest one, at 0%.
  const queued = jobBadgeView([job(ID.a, "queued", { createdAt: at(4) }), job(ID.b, "queued", { createdAt: at(2) })]);
  assert.equal(queued.jobId, ID.b);
  assert.equal(queued.text, "2 berjalan · 0%");
});

test("counts are written the Indonesian way", () => {
  const many = Array.from({ length: 1234 }, (_, index) => job(`${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`, "queued"));
  assert.equal(jobBadgeView(many).text, "1.234 berjalan · 0%");
  const done = jobBadgeView([job(ID.a, "completed", { clips: clips(1234) })]);
  assert.equal(done.text, "Terakhir: 1.234 klip");
  assert.equal(done.short, "1.234 klip");
});

test("without a running job the newest finished one reads 'Terakhir: 8 klip'", () => {
  const view = jobBadgeView([
    job(ID.a, "completed", { createdAt: at(1), clips: clips(3) }),
    job(ID.b, "completed", { createdAt: at(7), clips: clips(8) }),
    job(ID.c, "deleting", { createdAt: at(9) }),
  ]);
  assert.equal(view.kind, "latest");
  assert.equal(view.jobId, ID.b);
  assert.equal(view.text, "Terakhir: 8 klip");
  assert.equal(view.short, "8 klip");
  assert.equal(view.href, `/projects/${ID.b}`);
  assert.equal(view.tone, null);
  assert.equal(jobBadgeView([job(ID.a, "completed", { clips: undefined })]).text, "Terakhir: 0 klip");
});

test("only clips that rendered are counted: a clip that failed has no file to post", () => {
  const withFailure = [...clips(4), { index: 5, status: "failed", errorCode: "render_failed" }];
  const view = jobBadgeView([job(ID.a, "completed", { clips: withFailure })]);
  assert.equal(view.text, "Terakhir: 4 klip");
  assert.equal(view.short, "4 klip");
  assert.equal(badgeAnnouncement([job(ID.a, "processing")], [job(ID.a, "completed", { clips: withFailure })]), "Proyek selesai: 4 klip");
});

test("a newest job that failed or was cancelled says so", () => {
  const failed = jobBadgeView([job(ID.a, "completed", { createdAt: at(1), clips: clips(5) }), job(ID.b, "failed", { createdAt: at(3) })]);
  assert.deepEqual([failed.jobId, failed.text, failed.short, failed.tone], [ID.b, "Terakhir: gagal", "Gagal", "danger"]);
  const cancelled = jobBadgeView([job(ID.c, "cancelled", { createdAt: at(4) })]);
  assert.deepEqual([cancelled.text, cancelled.short, cancelled.tone], ["Terakhir: dibatalkan", "Batal", null]);
});

test("a running job wins over a newer finished one", () => {
  const view = jobBadgeView([job(ID.b, "completed", { createdAt: at(9), clips: clips(2) }), job(ID.a, "preparing", { progress: 3, createdAt: at(1) })]);
  assert.equal(view.text, "1 berjalan · 3%");
});

test("the badge text carries no em dash, version wording or score words", () => {
  const views = [
    jobBadgeView([job(ID.a, "processing", { progress: 9 })]),
    jobBadgeView([job(ID.a, "completed", { clips: clips(2) })]),
    jobBadgeView([job(ID.a, "failed")]),
    jobBadgeView([job(ID.a, "cancelled")]),
  ];
  for (const view of views) {
    for (const text of [view.text, view.short]) {
      assert.doesNotMatch(text, /—|\bV[1-3]\b|versi|baru|hot|viral/i, text);
    }
  }
});

// --- What it announces ------------------------------------------------------------------------

test("the first load and a moving percentage announce nothing", () => {
  const running = [job(ID.a, "processing", { progress: 40 })];
  assert.equal(badgeAnnouncement(null, running), "");
  assert.equal(badgeAnnouncement(running, [job(ID.a, "processing", { progress: 41 })]), "");
  assert.equal(badgeAnnouncement([job(ID.a, "queued")], [job(ID.a, "downloading", { progress: 2 })]), "");
});

test("a job that finishes is announced with its outcome", () => {
  const running = [job(ID.a, "processing", { progress: 90 })];
  assert.equal(badgeAnnouncement(running, [job(ID.a, "completed", { clips: clips(8) })]), "Proyek selesai: 8 klip");
  assert.equal(badgeAnnouncement(running, [job(ID.a, "failed")]), "Proyek gagal");
  assert.equal(badgeAnnouncement(running, [job(ID.a, "cancelled")]), "Proyek dibatalkan");
  assert.equal(badgeAnnouncement(
    [job(ID.a, "processing"), job(ID.b, "queued")],
    [job(ID.a, "completed", { clips: clips(1) }), job(ID.b, "failed")],
  ), "Proyek selesai: 1 klip. Proyek gagal");
});

test("starting, staying finished and deleting are not announced", () => {
  const done = [job(ID.a, "completed", { clips: clips(2) })];
  assert.equal(badgeAnnouncement(done, [job(ID.b, "queued"), ...done]), "", "a new job is the user's own action");
  assert.equal(badgeAnnouncement(done, done), "");
  assert.equal(badgeAnnouncement([job(ID.a, "processing")], []), "", "deleted while running");
  assert.equal(badgeAnnouncement([job(ID.a, "processing")], [job(ID.a, "deleting")]), "");
  assert.equal(badgeAnnouncement([], [job(ID.a, "completed", { clips: clips(2) })]), "", "never seen running");
});

// --- When it asks again -----------------------------------------------------------------------

const loaded = (jobs, extra = {}) => ({ ...INITIAL_BADGE_STATE, jobs, listAt: 0, ...extra });
const visible = { visible: true, now: 1_000 };

test("polling stops while the tab is hidden or the session is gone", () => {
  const state = loaded([job(ID.a, "processing")]);
  assert.equal(nextBadgeRequest(state, { visible: false, now: 1_000 }), null);
  assert.equal(nextBadgeRequest({ ...state, signedOut: true }, visible), null);
});

test("while a job runs only that job is read every few seconds; the list once a minute", () => {
  assert.equal(BADGE_POLL.runningMs, 5_000);
  assert.equal(BADGE_POLL.idleMs, 60_000);
  const state = loaded([job(ID.b, "queued", { createdAt: at(5) }), job(ID.a, "processing", { createdAt: at(1) })]);
  assert.deepEqual(nextBadgeRequest(state, { visible: true, now: 10_000 }), { kind: "job", jobId: ID.a, delayMs: 5_000 });
  assert.deepEqual(nextBadgeRequest(state, { visible: true, now: 54_999 }), { kind: "job", jobId: ID.a, delayMs: 5_000 });
  assert.deepEqual(nextBadgeRequest(state, { visible: true, now: 55_000 }), { kind: "list", delayMs: 5_000 });
});

test("with nothing running the list is read once a minute", () => {
  assert.deepEqual(nextBadgeRequest(loaded([job(ID.a, "completed")]), visible), { kind: "list", delayMs: 60_000 });
  assert.deepEqual(nextBadgeRequest(loaded([]), visible), { kind: "list", delayMs: 60_000 });
  assert.deepEqual(nextBadgeRequest(INITIAL_BADGE_STATE, visible), { kind: "list", delayMs: 60_000 });
});

test("failed requests back off and re-read the whole list", () => {
  const running = [job(ID.a, "processing")];
  assert.deepEqual(nextBadgeRequest(loaded(running, { failures: 1 }), visible), { kind: "list", delayMs: 10_000 });
  assert.deepEqual(nextBadgeRequest(loaded(running, { failures: 2 }), visible), { kind: "list", delayMs: 20_000 });
  assert.deepEqual(nextBadgeRequest(loaded([], { failures: 3 }), visible), { kind: "list", delayMs: BADGE_POLL.maxBackoffMs });
  assert.equal(BADGE_POLL.maxBackoffMs, 300_000);
  assert.deepEqual(nextBadgeRequest(loaded([], { failures: 40 }), visible), { kind: "list", delayMs: 300_000 });
});

// --- State ------------------------------------------------------------------------------------

test("a list answer replaces the jobs and computes the announcement", () => {
  let state = badgeReducer(INITIAL_BADGE_STATE, { type: "list", jobs: [job(ID.a, "processing", { progress: 10 })], at: 500 });
  assert.equal(state.listAt, 500);
  assert.equal(state.announcement, "");
  assert.equal(badgeStateView(state).text, "1 berjalan · 10%");
  state = badgeReducer(state, { type: "list", jobs: [job(ID.a, "completed", { clips: clips(3) })], at: 900 });
  assert.equal(state.announcement, "Proyek selesai: 3 klip");
  assert.equal(badgeStateView(state).text, "Terakhir: 3 klip");
  state = badgeReducer(state, { type: "list", jobs: [job(ID.a, "completed", { clips: clips(3) })], at: 1_900 });
  assert.equal(state.announcement, "", "the next answer clears it, so the same text can be announced again");
});

test("a job answer updates that job only, and a finished job never comes back to life", () => {
  const start = badgeReducer(INITIAL_BADGE_STATE, {
    type: "list", at: 0, jobs: [job(ID.a, "processing", { progress: 10 }), job(ID.b, "completed", { createdAt: at(9), clips: clips(2) })],
  });
  const moved = badgeReducer(start, { type: "job", job: job(ID.a, "processing", { progress: 55 }) });
  assert.equal(moved.listAt, 0, "a job answer is not a list answer");
  assert.equal(badgeStateView(moved).text, "1 berjalan · 55%");
  assert.equal(moved.jobs.length, 2);

  const done = badgeReducer(moved, { type: "job", job: job(ID.a, "cancelled") });
  assert.equal(done.announcement, "Proyek dibatalkan");
  const stale = badgeReducer(done, { type: "job", job: job(ID.a, "processing", { progress: 60 }) });
  assert.equal(stale.jobs.find((item) => item.id === ID.a).status, "cancelled");

  const added = badgeReducer(INITIAL_BADGE_STATE, { type: "job", job: job(ID.c, "queued") });
  assert.deepEqual(added.jobs.map((item) => item.id), [ID.c]);
});

test("a job the server no longer has leaves the badge", () => {
  const start = badgeReducer(INITIAL_BADGE_STATE, { type: "list", at: 0, jobs: [job(ID.a, "processing")] });
  const gone = badgeReducer(start, { type: "missing", jobId: ID.a });
  assert.deepEqual(gone.jobs, []);
  assert.equal(badgeStateView(gone), null);
  assert.equal(gone.announcement, "");
});

test("malformed answers count as failures; three in a row hide the badge until an answer comes", () => {
  let state = badgeReducer(INITIAL_BADGE_STATE, { type: "list", at: 0, jobs: [job(ID.a, "processing", { progress: 20 })] });
  state = badgeReducer(state, { type: "list", at: 1, jobs: { not: "a list" } });
  assert.equal(state.failures, 1);
  state = badgeReducer(state, { type: "job", job: null });
  assert.equal(state.failures, 2);
  assert.equal(badgeStateView(state).text, "1 berjalan · 20%", "two failures keep the last state");
  state = badgeReducer(state, { type: "failed" });
  assert.equal(BADGE_POLL.hideAfterFailures, 3);
  assert.equal(badgeStateView(state), null, "an old state is not shown as current");
  state = badgeReducer(state, { type: "list", at: 2, jobs: [job(ID.a, "processing", { progress: 70 })] });
  assert.equal(state.failures, 0);
  assert.equal(badgeStateView(state).text, "1 berjalan · 70%");
});

test("a signed-out answer hides the badge and stops polling until a list answer comes", () => {
  const start = badgeReducer(INITIAL_BADGE_STATE, { type: "list", at: 0, jobs: [job(ID.a, "processing")] });
  const out = badgeReducer(start, { type: "signed-out" });
  assert.equal(badgeStateView(out), null);
  assert.equal(nextBadgeRequest(out, visible), null);
  const back = badgeReducer(out, { type: "list", at: 5, jobs: [] });
  assert.equal(back.signedOut, false);
});

test("pages tell the badge when they change a job", () => {
  const target = new EventTarget();
  let heard = 0;
  target.addEventListener(JOBS_CHANGED_EVENT, () => { heard += 1; });
  notifyJobsChanged(target);
  assert.equal(heard, 1);
  assert.doesNotThrow(() => notifyJobsChanged(undefined));
});

// --- The component and the pages that use it ----------------------------------------------------

test("the sidebar puts the badge right after the brand, before the menu", async () => {
  const shell = await read("components/AppShell.jsx");
  assert.match(shell, /import JobBadge from "\.\/JobBadge\.jsx";/);
  // The Menu button is HeroUI's Drawer trigger since Dashboard F1 (05 §4.2); the menu is NavList.
  assert.match(shell, /<div className="appBar">\s*<Brand \/>\s*<JobBadge \/>\s*<Drawer\b[^>]*>\s*<Drawer\.Trigger\b/);
  assert.ok(shell.indexOf("<JobBadge />") < shell.indexOf("<NavList "), "the badge comes before the menu");
});

test("the badge is a real link; only a separate polite region announces", async () => {
  const source = await read("components/JobBadge.jsx");
  assert.match(source, /^"use client";/);
  assert.match(source, /<a\b[^>]*className="jobBadge"[^>]*href=\{view\.href\}/s);
  assert.equal(source.match(/aria-live=/g)?.length, 1, "one live region");
  assert.match(source, /<span className="visuallyHidden" aria-live="polite" aria-atomic="true">\{state\.announcement\}<\/span>/);
  assert.doesNotMatch(source.match(/<a\b[^>]*>/s)[0], /aria-live/, "the link itself is not live");
  assert.match(source, /visibilitychange/);
  assert.match(source, /JOBS_CHANGED_EVENT/);
  assert.match(source, /nextBadgeRequest\(/);
  // Aborted requests show up as failed requests; an unmounted badge ignores its answer instead.
  assert.doesNotMatch(source, /AbortController|\.abort\(/);
});

test("the brand keeps its name in its own span, so the top bar can fold it", async () => {
  const brand = await read("components/Brand.jsx");
  assert.match(brand, /<span aria-hidden="true">P<\/span>\s*<span className="brandName">Potongin AI<\/span>/);
});

test("the pages that create, cancel or delete a job tell the badge", async () => {
  for (const file of ["app/dashboard/page.jsx", "components/CancelJob.jsx", "app/projects/page.jsx"]) {
    const source = await read(file);
    assert.match(source, /import \{[^}]*\bnotifyJobsChanged\b[^}]*\} from "(\.\.\/)+lib\/job-badge\.mjs";/, file);
    assert.match(source, /notifyJobsChanged\(\)/, file);
  }
});

function cssBlock(css, header) {
  const start = css.indexOf(header);
  assert.ok(start >= 0, header);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`unclosed ${header}`);
}

test("below 1024 px the badge is a 44 px target in the top bar; the name folds, then the text", async () => {
  const css = await read("app/globals.css");
  assert.doesNotMatch(css, /\.appHeader/, "the old header rules are gone");
  const fold = cssBlock(css, "@media (max-width: 1023px) {\n  .appFrame");
  assert.match(fold, /\.appBar \.jobBadge \{ min-height: 44px; \}/);
  const narrow = cssBlock(css, "@media (max-width: 479px) {");
  assert.match(narrow, /^\s*\.appBar:has\(\.jobBadge\) \.brandName \{/m, "only the app bar folds the name; the landing and login pages keep it");
  assert.doesNotMatch(css, /^\s*\.brandName \{/m, "no rule hides the brand name outside the app bar");
  const short = cssBlock(css, "@media (max-width: 383px) {");
  assert.match(short, /\.jobBadgeText \{[^}]*clip: rect\(0 0 0 0\)/);
  assert.match(short, /\.jobBadge::after \{ content: attr\(data-short\); content: attr\(data-short\) \/ ""; \}/);
  const badge = /\.jobBadge \{([^}]*)\}/.exec(css)[1];
  assert.match(badge, /min-width: 0/);
  assert.match(badge, /font-variant-numeric: tabular-nums/);
  assert.match(badge, /white-space: nowrap/);
  assert.match(badge, /animation: fade-in var\(--dur-2\)/);
  assert.match(css, /\.jobBadgeDot \{[^}]*background: var\(--accent\)/);
  assert.doesNotMatch(css, /\.jobBadgeDot \{[^}]*animation/, "the dot marks a state; it does not pulse");
});

// --- UI language ------------------------------------------------------------------------------

test("the badge and its announcement are shell.badge.* descriptors, so the UI language reads them", async () => {
  const running = jobBadgeView([job(ID.a, "processing", { progress: 42 }), job(ID.b, "queued")]);
  assert.deepEqual(running.message, { key: "shell.badge.running", values: { count: 2, percent: 42 } });
  assert.deepEqual(running.shortMessage, { key: "shell.badge.percent", values: { percent: 42 } });
  const done = jobBadgeView([job(ID.a, "completed", { clips: clips(3) })]);
  assert.deepEqual(done.message, { key: "shell.badge.latestClips", values: { count: 3 } });
  assert.deepEqual(done.shortMessage, { key: "shell.badge.clips", values: { count: 3 } });
  assert.deepEqual(jobBadgeView([job(ID.a, "failed")]).message, { key: "shell.badge.latestFailed" });
  assert.deepEqual(jobBadgeView([job(ID.a, "cancelled")]).shortMessage, { key: "shell.badge.cancelled" });

  let state = badgeReducer(INITIAL_BADGE_STATE, { type: "list", jobs: [job(ID.a, "processing"), job(ID.b, "processing")], at: 1 });
  assert.deepEqual(state.outcomes, []);
  state = badgeReducer(state, { type: "list", jobs: [job(ID.a, "completed", { clips: clips(2) }), job(ID.b, "failed")], at: 2 });
  assert.deepEqual(state.outcomes, [
    { key: "shell.badge.outcomeDone", values: { count: 2 } },
    { key: "shell.badge.outcomeFailed" },
  ]);

  const keys = async (locale) => Object.keys(JSON.parse(await read(`messages/${locale}/shell.json`)).badge || {}).sort();
  const expected = ["cancelled", "clips", "failed", "latestCancelled", "latestClips", "latestFailed", "outcomeCancelled", "outcomeDone", "outcomeFailed", "percent", "running"];
  assert.deepEqual(await keys("id"), expected);
  assert.deepEqual(await keys("en"), expected);
  const component = await read("components/JobBadge.jsx");
  assert.match(component, /msg\(t, view\.message\)/);
  assert.match(component, /outcomes\.map\(\(outcome\) => msg\(/);
  assert.doesNotMatch(component, /\{view\.text\}/);
});
