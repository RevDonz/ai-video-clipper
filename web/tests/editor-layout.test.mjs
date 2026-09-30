// The layout panel's model (plan §11.3 T3.6, §5.7, §3.3 `layout.default.mode`, Appendix B
// `SetLayout`, Appendix C.6): the three layouts and their copy, the document variant a thumbnail
// is asked for, the switch steps (face-track needs its camera analysis first), the progress of
// that analysis, and the list of runs without a face with their jump-to frames.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  ANALYSIS_TEXT,
  CAMERA_SECONDS_PER_180S,
  LAYOUT_OPTIONS,
  analysisRangeMs,
  analysisView,
  cameraReadyFromState,
  contentKey,
  noFaceList,
  switchSteps,
  thumbnailFrame,
  thumbnailOrder,
  withLayout,
} from "../components/editor/panels/layout-model.mjs";
import { COMMANDS, CommandRejected, applyCommand } from "../lib/editor/commands.mjs";
import { LAYOUT_MODES, createContext } from "../lib/editor/doc-model.mjs";

test("the three layouts of plan §3.3, in the order of Appendix C.1, with Indonesian copy", () => {
  assert.deepEqual(LAYOUT_OPTIONS.map((option) => option.id), ["fit_blur", "camera", "fill_center"]);
  assert.deepEqual([...LAYOUT_MODES].sort(), LAYOUT_OPTIONS.map((option) => option.id).sort());
  assert.deepEqual(LAYOUT_OPTIONS.map((option) => option.name), ["Latar blur", "Ikuti wajah", "Potong tengah"]);
  for (const option of LAYOUT_OPTIONS) {
    assert.ok(Object.isFrozen(option));
    assert.match(option.note, /\S/);
    assert.doesNotMatch(`${option.name} ${option.note}`, /[\u2013\u2014]|V[0-9]/); // no dashes, no version labels
  }
  assert.match(LAYOUT_OPTIONS[1].note, /analisis wajah/);
  assert.ok(Object.isFrozen(LAYOUT_OPTIONS));
});

test("SetLayout changes only layout.default.mode and refuses an unknown mode", () => {
  assert.ok(COMMANDS.includes("SetLayout"));
  const doc = fakeDoc();
  const ctx = createContext({ words: fakeWords(), seed: doc });
  const { doc: next } = applyCommand(doc, "SetLayout", { mode: "fill_center" }, ctx);
  assert.equal(next.layout.default.mode, "fill_center");
  assert.equal(next.layout.default.no_face, "center");
  assert.equal(doc.layout.default.mode, "fit_blur"); // pure
  const { layout: _a, audit: _b, ...rest } = next;
  const { layout: _c, audit: _d, ...before } = doc;
  assert.deepEqual(rest, before);
  assert.throws(() => applyCommand(doc, "SetLayout", { mode: "split" }, ctx), CommandRejected);
  assert.throws(() => applyCommand(doc, "SetLayout", { mode: "smart_speaker" }, ctx), CommandRejected);
  assert.equal(applyCommand(next, "SetLayout", { mode: "camera" }, ctx).doc.layout.default.mode, "camera");
});

test("a thumbnail asks for the document with only the layout changed", () => {
  const doc = fakeDoc();
  const camera = withLayout(doc, "camera");
  assert.equal(camera.layout.default.mode, "camera");
  assert.equal(doc.layout.default.mode, "fit_blur");
  assert.notEqual(camera, doc);
  assert.equal(camera.main, doc.main); // shared, untouched
  assert.deepEqual({ ...camera, layout: doc.layout }, doc);
  assert.equal(withLayout(doc, "fit_blur"), doc);
  assert.throws(() => withLayout(doc, "split"), TypeError);
});

test("the thumbnail key ignores the layout, revision and audit and follows everything else", () => {
  const doc = fakeDoc();
  const key = contentKey(doc);
  assert.equal(contentKey(withLayout(doc, "camera")), key);
  assert.equal(contentKey({ ...doc, revision: 7, parent_sha256: "a".repeat(64), audit: { ...doc.audit, last_command: "X" } }), key);
  const edited = structuredClone(doc);
  edited.captions.overrides.y_e5 = 70000;
  assert.notEqual(contentKey(edited), key);
  assert.equal(contentKey(null), null);
});

test("thumbnails come in the order current layout first, then the others", () => {
  assert.deepEqual(thumbnailOrder("fill_center"), ["fill_center", "fit_blur", "camera"]);
  assert.deepEqual(thumbnailOrder("camera"), ["camera", "fit_blur", "fill_center"]);
  assert.deepEqual(thumbnailOrder(null), ["fit_blur", "camera", "fill_center"]);
});

test("the thumbnail frame is the playhead, kept inside the clip", () => {
  const plan = fakePlan();
  assert.equal(thumbnailFrame(12, plan), 12);
  assert.equal(thumbnailFrame(-3, plan), 0);
  assert.equal(thumbnailFrame(plan.totalFrames + 40, plan), plan.totalFrames - 1);
  assert.equal(thumbnailFrame(Number.NaN, plan), 0);
  assert.equal(thumbnailFrame(5, null), null);
  assert.equal(thumbnailFrame(5, { ...plan, totalFrames: 0 }), null);
});

test("the switch steps: nothing, a command, or the camera analysis before the command", () => {
  assert.equal(switchSteps({ target: "fit_blur", current: "fit_blur", cameraReady: false }), "none");
  assert.equal(switchSteps({ target: "fill_center", current: "fit_blur", cameraReady: false }), "dispatch");
  assert.equal(switchSteps({ target: "camera", current: "fit_blur", cameraReady: true }), "dispatch");
  assert.equal(switchSteps({ target: "camera", current: "fit_blur", cameraReady: false }), "analyze");
  assert.equal(switchSteps({ target: "camera", current: "camera", cameraReady: false }), "none");
  assert.throws(() => switchSteps({ target: "split", current: "fit_blur", cameraReady: true }), TypeError);
});

test("the camera plan is known to exist when the seed names one (a face-track seed)", () => {
  const doc = fakeDoc();
  assert.equal(cameraReadyFromState({ doc, seed: doc, plan: fakePlan(doc) }), false);
  // switched to face-track in the editor: unknown until prepare answers (instant when it exists)
  assert.equal(cameraReadyFromState({ doc: withLayout(doc, "camera"), seed: doc }), false);
  const seed = { ...doc, base: { ...doc.base, camera: { sha256: "c".repeat(64) } } };
  assert.equal(cameraReadyFromState({ doc: withLayout(seed, "fit_blur"), seed }), true);
  assert.equal(cameraReadyFromState({ doc: seed, seed: null }), true);
  assert.equal(cameraReadyFromState({ seed: { base: { camera: { sha256: "not-a-sha" } } } }), false);
  assert.equal(cameraReadyFromState({}), false);
  assert.equal(cameraReadyFromState(null), false);
});

test("the usual analysis time is the measured range, scaled by the window length", () => {
  // T3.6-camera-plan.json: 180 s windows of the five real sources took 4.6-13.4 s at 4 CPUs
  assert.deepEqual([...CAMERA_SECONDS_PER_180S], [4.6, 13.4]);
  const doc = fakeDoc(); // a 189 s window
  assert.deepEqual(analysisRangeMs(doc), { minMs: 5000, maxMs: 15000 });
  const short = structuredClone(doc);
  short.base.window_ms = [1181900, 1271900]; // 90 s
  assert.deepEqual(analysisRangeMs(short), { minMs: 2000, maxMs: 7000 });
  const tiny = structuredClone(doc);
  tiny.base.window_ms = [1181900, 1183900];
  assert.deepEqual(analysisRangeMs(tiny), { minMs: 1000, maxMs: 1000 });
  assert.equal(analysisRangeMs(null), null);
  assert.equal(analysisRangeMs({ base: { window_ms: "x" } }), null);
});

test("the analysis view: a percentage with server progress, the seconds and the usual range otherwise", () => {
  assert.equal(analysisView(null, 0), null);
  assert.equal(analysisView({ state: "idle" }, 0), null);
  const running = { state: "running", startedAt: 1000, range: { minMs: 5000, maxMs: 15000 } };
  const early = analysisView(running, 1000 + 4_200);
  assert.equal(early.determinate, false);
  assert.equal(early.value, null);
  assert.equal(early.text, `${ANALYSIS_TEXT.running} 4 dtk (biasanya 5-15 dtk)`);
  const withProgress = analysisView({ ...running, done: 60, total: 240 }, 3000);
  assert.deepEqual([withProgress.determinate, withProgress.value, withProgress.max], [true, 60, 240]);
  assert.equal(withProgress.text, `${ANALYSIS_TEXT.running} 25%`);
  assert.equal(withProgress.percent, 25);
  const late = analysisView(running, 1000 + 31_000);
  assert.equal(late.text, `${ANALYSIS_TEXT.running} 31 dtk (lebih lama dari biasanya)`);
  assert.equal(analysisView({ state: "running", startedAt: 0 }, 2_000).text, `${ANALYSIS_TEXT.running} 2 dtk`);
  const failed = analysisView({ state: "failed", code: "backend_unavailable" }, 0);
  assert.equal(failed.tone, "danger");
  assert.match(failed.text, /^Analisis wajah gagal: /);
  assert.equal(analysisView({ state: "done" }, 0), null);
  // no dash but a plain hyphen in the range (R-02)
  assert.doesNotMatch(early.text, /[\u2013\u2014]/);
});

test("runs without a face: one entry per warning frame, sorted, with its clock", () => {
  const plan = { fps: [30000, 1001], totalFrames: 900, warnings: [
    { code: "no_face", path: "/layout/default/mode", f: 600 },
    { code: "tight_cut", path: "/main/removals/0", ref: "rm_1", f: 30 },
    { code: "no_face", path: "/layout/default/mode", f: 45 },
    { code: "no_face", path: "/layout/default/mode", f: 45 },
    { code: "no_face", path: "/layout/default/mode" },
    { code: "no_face", path: "/layout/default/mode", f: 950 },
  ] };
  assert.deepEqual(noFaceList(plan), [
    { f: 45, time: "00:01,5" },
    { f: 600, time: "00:20,0" },
  ]);
  assert.deepEqual(noFaceList(null), []);
  assert.deepEqual(noFaceList({ fps: [30, 1], totalFrames: 10, warnings: null }), []);
});
