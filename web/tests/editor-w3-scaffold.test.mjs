// W3 scaffolding landed by the W2 integrator (plan §11.0 "Scaffolding before a wave", §11.2 T2.Z):
// the registries list every W3 panel, lane and gizmo, each entry has its placeholder file, the
// hook-suggestions slot exists, and the fakes cover uploads, AI hooks, Rapikan and cold-open
// suggestions (Appendix A.2 `uploadAsset`, §7.1–§7.3). W3 tasks replace these files, never the
// registries.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FAKE_CLIP_ID,
  FAKE_JOB_ID,
  createFakeApiClient,
  createFakeUploadClient,
  fakeWords,
} from "../components/editor/__dev__/fakes.mjs";
import { GIZMOS, gizmoById } from "../components/editor/gizmos/index.mjs";
import { PANELS } from "../components/editor/panels/index.mjs";
import { LANES } from "../components/editor/timeline/lanes.mjs";

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");

function placeholder(entry) {
  const file = path.join(editorDir, entry.file);
  assert.ok(existsSync(file), entry.file);
  const source = readFileSync(file, "utf8");
  assert.match(source, /^"use client";/, entry.file);
  assert.match(source, new RegExp(`export default function ${entry.component}\\(`), entry.file);
  assert.equal(typeof entry.load, "function", entry.file);
}

test("the panel registry lists the W3 panels after the W2 ones (Appendix C.1)", () => {
  assert.deepEqual(PANELS.map((panel) => [panel.id, panel.label, panel.wave, panel.owner]), [
    ["transcript", "Transkrip", "W2", "T2.7"],
    ["text", "Teks", "W2", "T2.7"],
    ["coldopen", "Cold open", "W2", "T2.7"],
    ["layout", "Tata letak", "W3", "T3.6"],
    ["logo", "Logo", "W3", "T3.2"],
    ["music", "Musik", "W3", "T3.3"],
  ]);
  for (const panel of PANELS.filter((entry) => entry.wave === "W3")) {
    assert.equal(panel.file, `panels/${panel.component}.jsx`);
    placeholder(panel);
  }
});

test("the lane registry lists the W3 lanes under the W2 ones (Appendix C.3)", () => {
  assert.deepEqual(LANES.map((lane) => [lane.id, lane.label, lane.wave, lane.owner]), [
    ["video", "Video", "W2", "T2.6"],
    ["captions", "Teks", "W2", "T2.6"],
    ["hook", "Hook", "W2", "T2.6"],
    ["audio", "Audio", "W3", "T3.7"],
    ["markers", "Penanda", "W3", "T3.7"],
    ["music", "Musik", "W3", "T3.3"],
  ]);
  for (const lane of LANES.filter((entry) => entry.wave === "W3")) {
    assert.equal(lane.file, `timeline/lanes/${lane.component}.jsx`);
    placeholder(lane);
  }
});

test("the Stage gizmo slot has a registry with the logo gizmo (T3.2)", () => {
  assert.deepEqual(GIZMOS.map((gizmo) => [gizmo.id, gizmo.wave, gizmo.owner, gizmo.component]), [["logo", "W3", "T3.2", "LogoGizmo"]]);
  assert.ok(Object.isFrozen(GIZMOS));
  assert.equal(gizmoById("logo").file, "gizmos/LogoGizmo.jsx");
  assert.equal(gizmoById("nope"), null);
  placeholder(gizmoById("logo"));
  const app = readFileSync(path.join(editorDir, "EditorApp.jsx"), "utf8");
  assert.match(app, /GIZMOS/, "EditorApp mounts the gizmo registry into the Stage slot");
});

test("the hook-suggestions slot exists (T3.4)", () => {
  placeholder({ file: "suggestions/index.jsx", component: "HookSuggestions", load: () => null });
});

test("the fake upload client follows Appendix A.2 uploadAsset", async () => {
  const client = createFakeUploadClient();
  const progress = [];
  const logo = await client.uploadAsset(FAKE_JOB_ID, { name: "logo.png", size: 2048, type: "image/png" }, "logo",
    { onProgress: (value) => progress.push(value) });
  assert.match(logo.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([logo.kind, logo.mime, logo.durationMs, logo.lufsC], ["logo", "image/png", null, null]);
  assert.ok(Number.isInteger(logo.w) && Number.isInteger(logo.h));
  assert.equal(progress.at(-1), 1);
  const music = await client.uploadAsset(FAKE_JOB_ID, { name: "lagu.m4a", size: 4096, type: "audio/mp4" }, "music");
  assert.deepEqual([music.kind, music.mime, music.w, music.h], ["music", "audio/mp4", null, null]);
  assert.ok(Number.isInteger(music.durationMs) && Number.isInteger(music.lufsC));
  assert.match(music.peaksUrl, /^\/api\/jobs\/[0-9a-f-]{36}\/assets\/[0-9a-f]{64}\?part=peaks$/);
  await assert.rejects(client.uploadAsset(FAKE_JOB_ID, { name: "x.gif", size: 10, type: "image/gif" }, "logo"),
    (error) => error.status === 415 && error.code === "asset_type_unsupported");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.uploadAsset(FAKE_JOB_ID, { name: "a.png", size: 10, type: "image/png" }, "logo", { signal: controller.signal }),
    (error) => error.name === "AbortError");
});

test("the fake API serves Rapikan items, cold-open candidates and AI hook suggestions", async () => {
  const api = createFakeApiClient();
  const ids = new Set(fakeWords().words.map((word) => word.id));
  const cleanup = await api.cleanup();
  assert.ok(cleanup.items.length >= 2);
  for (const item of cleanup.items) {
    assert.match(item.id, /^[a-z]{2,3}_[0-9a-z]{1,16}$/);
    if (item.kind === "gap_silent") {
      assert.ok(ids.has(item.afterWord) && Number.isInteger(item.inSf) && item.outSf > item.inSf);
    } else {
      assert.ok(["filler", "repeat"].includes(item.kind));
      assert.ok(item.wordIds.every((id) => ids.has(id)));
    }
  }
  const coldOpen = await api.coldOpenSuggestions();
  assert.ok(coldOpen.candidates.length >= 1);
  for (const candidate of coldOpen.candidates) assert.ok(ids.has(candidate.firstWord) && ids.has(candidate.lastWord));
  const hooks = await api.aiHooks({ clip_id: FAKE_CLIP_ID });
  assert.ok(hooks.heuristic.length >= 2);
  for (const suggestion of hooks.heuristic) assert.ok(typeof suggestion.text === "string" && ["ai_selection", "heuristic"].includes(suggestion.source));
  assert.deepEqual(hooks.llm, { state: "disabled" });
});
