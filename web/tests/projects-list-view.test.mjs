// Proyek (/projects, 05-ui-dashboard.md §6.8): the tab, status filter and search in the URL, the
// filter counts, the status pill, the clip count, the page of rows, the batch delete (at most 4
// requests at once) and its toast. Copy comes back as catalog descriptors; the Indonesian text is
// checked through the real catalog.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_PAGE_SIZE,
  deleteProjects,
  deleteToast,
  editableClipIndex,
  matchesStatusFilter,
  parseProjectsQuery,
  projectClipCount,
  projectCounts,
  projectStatusView,
  projectsHref,
  statusFilterOf,
} from "../lib/projects-list-view.mjs";
import { catalogT, textOf } from "./support/catalog-t.mjs";

const job = (status, extra = {}) => ({ id: `id-${status}-${Math.random()}`, status, clips: [], ...extra });

test("the tab, the status filter and the search come from the URL, in Indonesian words", () => {
  assert.deepEqual(parseProjectsQuery("?tab=klip&status=gagal&q=podcast"), { tab: "clips", status: "failed", q: "podcast" });
  assert.deepEqual(parseProjectsQuery(new URLSearchParams("tab=proyek&status=diproses")), { tab: "projects", status: "running", q: "" });
  assert.deepEqual(parseProjectsQuery("?status=selesai"), { tab: null, status: "done", q: "" });
  // Unknown values fall back: no tab (the remembered one is used), every status.
  assert.deepEqual(parseProjectsQuery("?tab=x&status=y"), { tab: null, status: "all", q: "" });
  assert.deepEqual(parseProjectsQuery(""), { tab: null, status: "all", q: "" });
  assert.equal(parseProjectsQuery(`?q=${"a".repeat(500)}`).q.length, 200);
});

test("the URL keeps only what differs from the default", () => {
  assert.equal(projectsHref({ tab: "projects", status: "all", q: "" }), "/projects");
  assert.equal(projectsHref({ tab: "clips", status: "all", q: "" }), "/projects?tab=klip");
  assert.equal(projectsHref({ tab: "projects", status: "failed", q: " ep 11 " }), "/projects?status=gagal&q=ep+11");
  // The status filter belongs to the project table; the clip tab does not carry it.
  assert.equal(projectsHref({ tab: "clips", status: "failed", q: "x" }), "/projects?tab=klip");
  for (const status of ["all", "running", "done", "failed"]) {
    assert.equal(parseProjectsQuery(projectsHref({ tab: "projects", status, q: "" }).slice("/projects".length)).status, status);
  }
});

test("each job falls under one status filter; cancelled ones only under Semua", () => {
  assert.equal(statusFilterOf(job("queued")), "running");
  assert.equal(statusFilterOf(job("downloading")), "running");
  assert.equal(statusFilterOf(job("processing")), "running");
  assert.equal(statusFilterOf(job("completed")), "done");
  assert.equal(statusFilterOf(job("failed")), "failed");
  assert.equal(statusFilterOf(job("cancelled")), null);
  assert.equal(statusFilterOf(job("deleting")), null);
  assert.equal(matchesStatusFilter(job("cancelled"), "all"), true);
  assert.equal(matchesStatusFilter(job("cancelled"), "done"), false);
  assert.equal(matchesStatusFilter(job("completed"), "done"), true);
  assert.equal(matchesStatusFilter(job("processing"), "failed"), false);
});

test("the filter counts add up per status", () => {
  const jobs = [job("completed"), job("completed"), job("processing"), job("queued"), job("failed"), job("cancelled")];
  assert.deepEqual(projectCounts(jobs), { all: 6, running: 2, done: 2, failed: 1 });
  assert.deepEqual(projectCounts(null), { all: 0, running: 0, done: 0, failed: 0 });
  const t = catalogT("id");
  assert.equal(t("projects.filter.all", { count: 12 }), "Semua 12");
  assert.equal(t("projects.filter.running", { count: 2 }), "Diproses 2");
  assert.equal(catalogT("en")("projects.filter.done", { count: 9 }), "Done 9");
});

test("the status pill names the process status from the status namespace, with the progress while running", () => {
  assert.deepEqual(projectStatusView(job("completed")), { label: { key: "status.process.completed" }, tone: "success", running: false });
  assert.deepEqual(projectStatusView(job("failed")), { label: { key: "status.process.failed" }, tone: "danger", running: false });
  assert.deepEqual(projectStatusView(job("queued")), { label: { key: "status.process.queued" }, tone: "default", running: true });
  assert.deepEqual(projectStatusView(job("processing", { progress: 41.6 })),
    { label: { key: "projects.status.progress", values: { status: { key: "status.process.running" }, percent: 42 } }, tone: "default", running: true });
  assert.equal(textOf(projectStatusView(job("downloading", { progress: 5 })).label), "Diproses · 5%");
  assert.equal(textOf(projectStatusView(job("cancelled")).label), "Dibatalkan");
  assert.equal(textOf(projectStatusView(job("deleting")).label), "Menghapus");
  assert.equal(textOf(projectStatusView(job("strange")).label), "Tidak dikenal");
  assert.equal(textOf(projectStatusView(job("completed")).label, "en"), "Done");
});

test("the clip count is the rendered clips of a finished project, else nothing", () => {
  assert.equal(projectClipCount(job("completed", { clips: [{ index: 1 }, { index: 2, status: "failed" }, { index: 3 }] })), 2);
  assert.equal(projectClipCount(job("completed")), 0);
  assert.equal(projectClipCount(job("processing", { clips: [{ index: 1 }] })), null);
});

test("Edit klip opens the first rendered clip of a finished project when the editor is on", () => {
  const done = job("completed", { options: { selectionMode: "v3" }, clips: [{ index: 1, status: "failed" }, { index: 2 }] });
  assert.equal(editableClipIndex(done, true), 2);
  assert.equal(editableClipIndex(done, false), null);
  assert.equal(editableClipIndex({ ...done, status: "failed" }, true), null);
  assert.equal(editableClipIndex({ ...done, options: { selectionMode: "v2" } }, true), null);
});

test("a batch delete runs at most 4 requests at once and reports each project", async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `job-${index}`);
  let running = 0;
  let peak = 0;
  const result = await deleteProjects(ids, async (id) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    if (id === "job-3") throw new TypeError("offline");
    if (id === "job-5") return { ok: false };
    return { ok: true, removed: id !== "job-7" };
  });
  assert.equal(peak, 4);
  assert.deepEqual(result.failed, ["job-3", "job-5"]);
  assert.deepEqual(result.removed, ["job-0", "job-1", "job-2", "job-4", "job-6", "job-8"]);
  assert.deepEqual(result.marked, ["job-7"]);
  assert.deepEqual(await deleteProjects([], async () => ({ ok: true })), { removed: [], marked: [], failed: [] });
});

test("the toast after a batch says how many went and how many did not", () => {
  assert.deepEqual(deleteToast({ removed: ["a", "b"], marked: [], failed: [] }), { variant: "success", title: { key: "projects.delete.done", values: { count: 2 } } });
  assert.deepEqual(deleteToast({ removed: ["a"], marked: [], failed: ["b"] }), { variant: "warning", title: { key: "projects.delete.partial", values: { ok: 1, failed: 1 } } });
  assert.deepEqual(deleteToast({ removed: [], marked: [], failed: ["a", "b"] }), { variant: "danger", title: { key: "projects.delete.failed", values: { count: 2 } } });
  assert.equal(textOf(deleteToast({ removed: ["a"], marked: ["c"], failed: ["b"] }).title), "2 dihapus, 1 gagal");
  assert.equal(textOf(deleteToast({ removed: ["a"], marked: [], failed: [] }).title), "1 dihapus");
  assert.equal(textOf(deleteToast({ removed: ["a"], marked: [], failed: [] }).title, "en"), "1 deleted");
});

test("the confirmation counts the projects in both languages", () => {
  assert.equal(catalogT("id")("projects.delete.confirm", { count: 1 }), "Hapus 1 proyek?");
  assert.equal(catalogT("id")("projects.delete.confirm", { count: 3 }), "Hapus 3 proyek?");
  assert.equal(catalogT("en")("projects.delete.confirm", { count: 1 }), "Delete 1 project?");
  assert.equal(catalogT("en")("projects.delete.confirm", { count: 3 }), "Delete 3 projects?");
  assert.ok(PROJECT_PAGE_SIZE >= 20);
});
