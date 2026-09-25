// W2 scaffolding landed by the W1 integrator (plan §11.0 "Scaffolding before a wave", §11.1
// T1.Z): the panel and lane registries list every W2 entry, each entry has its placeholder file,
// the fakes follow Appendix A.2, and editor.module.css holds design tokens only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FAKE_CLIP_ID,
  FAKE_JOB_ID,
  createFakeApiClient,
  createFakeEditorStore,
  createFakePlayer,
  createFakePreviewClient,
  fakeDoc,
  fakePlan,
  fakeWords,
} from "../components/editor/__dev__/fakes.mjs";
import { PANELS, panelById } from "../components/editor/panels/index.mjs";
import { LANES, laneById } from "../components/editor/timeline/lanes.mjs";

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");

test("the panel registry lists the W2 panels in tab order", () => {
  assert.deepEqual(PANELS.map((panel) => [panel.id, panel.label, panel.wave, panel.owner]), [
    ["transcript", "Transkrip", "W2", "T2.7"],
    ["text", "Teks", "W2", "T2.7"],
    ["coldopen", "Cold open", "W2", "T2.7"],
  ]);
  assert.ok(Object.isFrozen(PANELS));
  assert.equal(panelById("text").file, "panels/TextPanel.jsx");
  assert.equal(panelById("nope"), null);
});

test("the lane registry lists the W2 lanes top to bottom", () => {
  assert.deepEqual(LANES.map((lane) => [lane.id, lane.label, lane.wave, lane.owner]), [
    ["video", "Video", "W2", "T2.6"],
    ["captions", "Teks", "W2", "T2.6"],
    ["hook", "Hook", "W2", "T2.6"],
  ]);
  assert.ok(Object.isFrozen(LANES));
  assert.equal(laneById("hook").file, "timeline/HookLane.jsx");
  assert.equal(laneById("nope"), null);
});

test("every registry entry has its placeholder component file", () => {
  for (const entry of [...PANELS, ...LANES]) {
    const file = path.join(editorDir, entry.file);
    assert.ok(existsSync(file), entry.file);
    const source = readFileSync(file, "utf8");
    assert.match(source, /^"use client";/, entry.file);
    assert.match(source, new RegExp(`export default function ${entry.component}\\(`), entry.file);
    assert.equal(typeof entry.load, "function");
  }
  for (const file of ["EditorApp.jsx", "editor.module.css"]) assert.ok(existsSync(path.join(editorDir, file)), file);
});

test("editor.module.css holds design tokens only", () => {
  const css = readFileSync(path.join(editorDir, "editor.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = css.match(/[^{};]+:[^{};]+;/g) || [];
  assert.ok(declarations.length >= 20);
  for (const declaration of declarations) assert.match(declaration.trim(), /^--ed-[a-z0-9-]+:\s*\S/, declaration);
  const selectors = css.match(/([^{}]+)\{/g).map((selector) => selector.replace("{", "").trim());
  assert.deepEqual(selectors.filter((selector) => !selector.startsWith("@media")), [".tokens", ".tokens"]);
});

test("the fake API client has every Appendix A.2 method and serves the fixture", async () => {
  const api = createFakeApiClient();
  for (const name of ["clips", "getEdit", "putEdit", "words", "prepare", "createRender", "getRender",
    "cancelRender", "cleanup", "coldOpenSuggestions", "aiHooks", "aiTask"]) {
    assert.equal(typeof api[name], "function", name);
  }
  const clips = await api.clips();
  assert.equal(clips.clips[0].clipId, FAKE_CLIP_ID);
  const edit = await api.getEdit({ seed: false });
  assert.equal(edit.doc.clip_id, FAKE_CLIP_ID);
  assert.equal(edit.seed, true);
  const saved = await api.putEdit({ ...edit.doc, revision: 1, parent_sha256: edit.etag }, { etag: edit.etag, key: "k1" });
  assert.equal(saved.doc.revision, 1);
  assert.notEqual(saved.etag, edit.etag);
  await assert.rejects(api.putEdit({ ...edit.doc, revision: 1 }, { etag: edit.etag, key: "k2" }),
    (error) => error.status === 409 && error.code === "revision_conflict");
  const render = await api.createRender({ editEtag: saved.etag }, "k3");
  assert.equal((await api.getRender(render.renderId)).renderId, render.renderId);
  assert.equal((await api.cancelRender(render.renderId)).state, "cancelled");
  assert.deepEqual(api.calls.map((call) => call.name).slice(0, 3), ["clips", "getEdit", "putEdit"]);
  assert.equal(FAKE_JOB_ID.length, 36);
});

test("the fake preview client returns plan DTOs (plan §4.3) and truth frames", async () => {
  const preview = createFakePreviewClient();
  const plan = await preview.plan(fakeDoc());
  for (const key of ["planSha256", "docSha256", "compiler", "renderSemantics", "fps", "totalFrames", "output",
    "pieces", "cues", "hook", "text", "plate", "logo", "audio", "rev0", "warnings", "errors"]) {
    assert.ok(key in plan, key);
  }
  assert.equal(plan.pieces.reduce((sum, piece) => sum + piece.frames, 0), plan.totalFrames);
  assert.deepEqual(fakePlan().pieces, plan.pieces);
  const frame = await preview.frame(fakeDoc(), 3);
  assert.equal(frame.type, "image/png");
  assert.ok(fakeWords().words.length > 0);
});

test("the fake player follows the createPlayer contract", async () => {
  const states = [];
  const player = createFakePlayer({ onState: (state) => states.push(state) });
  assert.equal(player.state().mode, "unsupported");
  player.load(fakePlan());
  assert.equal(player.state().mode, "live");
  await player.seek(10);
  await player.step(2);
  assert.equal(player.state().frame, 12);
  await player.play();
  player.pause();
  await player.showTruthFrame(5);
  assert.equal(player.state().mode, "truth");
  await player.step(-100);
  assert.equal(player.state().frame, 0);
  player.destroy();
  assert.ok(states.length >= 4);
});

test("the fake store follows the createEditorStore contract", async () => {
  const store = createFakeEditorStore({ jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID });
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.save));
  await store.ready;
  const state = store.getState();
  for (const key of ["status", "doc", "seed", "words", "etag", "save", "savedAtMs", "canUndo", "canRedo",
    "plan", "pending", "warnings", "selection"]) {
    assert.ok(key in state, key);
  }
  assert.equal(state.status, "ready");
  store.dispatch("SetCaptionsEnabled", { on: false });
  assert.equal(store.getState().doc.captions.enabled, false);
  assert.equal(store.getState().save, "dirty");
  assert.equal(store.getState().canUndo, true);
  store.undo();
  assert.equal(store.getState().doc.captions.enabled, true);
  store.redo();
  assert.equal(store.getState().doc.captions.enabled, false);
  assert.throws(() => store.dispatch("NoSuchCommand", {}), (error) => error.code === "unknown_command");
  await store.flush();
  assert.equal(store.getState().save, "saved");
  unsubscribe();
  store.destroy();
  assert.ok(seen.includes("dirty") && seen.includes("saved"));
});
