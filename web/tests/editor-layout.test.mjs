// The layout panel's model (plan §11.3 T3.6, §5.7, §3.3 `layout.default.mode`, Appendix B
// `SetLayout`, Appendix C.6): the four layouts (layar terbagi, CONTRACTS §5.45) and their copy, the document variant a thumbnail
// is asked for, the switch steps (face-track needs its camera analysis first), the progress of
// that analysis, and the list of runs without a face with their jump-to frames.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  ANALYSIS_TEXT,
  CAMERA_SECONDS_PER_180S,
  LAYOUT_OPTIONS,
  NO_FACE_OPTIONS,
  analysisRangeMs,
  analysisView,
  cameraReadyFromState,
  contentKey,
  layoutNote,
  noFaceCommand,
  noFaceList,
  noFaceView,
  switchSteps,
  thumbnailFrame,
  thumbnailOrder,
  withLayout,
  ZOOM_OPTIONS_PM,
  zoomCommand,
  zoomPercent,
  zoomView,
} from "../components/editor/panels/layout-model.mjs";
import { COMMANDS, CommandRejected, applyCommand } from "../lib/editor/commands.mjs";
import { LAYOUT_MODES, NO_FACE_MODES, checkDoc, createContext, switchedLayout } from "../lib/editor/doc-model.mjs";

test("the layouts of plan §3.3 in the order of Appendix C.1, then layar terbagi, with Indonesian copy", () => {
  assert.deepEqual(LAYOUT_OPTIONS.map((option) => option.id), ["fit_blur", "camera", "fill_center", "split"]);
  assert.deepEqual([...LAYOUT_MODES].sort(), LAYOUT_OPTIONS.map((option) => option.id).sort());
  assert.deepEqual(LAYOUT_OPTIONS.map((option) => option.name), ["Latar blur", "Ikuti wajah", "Potong tengah", "Layar terbagi"]);
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
  // layar terbagi (CONTRACTS §5.45) is a layout; its bands come with it
  assert.equal(applyCommand(doc, "SetLayout", { mode: "split" }, ctx).doc.layout.split.top_pm, 300);
  assert.throws(() => applyCommand(doc, "SetLayout", { mode: "smart_speaker" }, ctx), CommandRejected);
  assert.throws(() => applyCommand(doc, "SetLayout", { mode: "branded" }, ctx), CommandRejected);
  assert.equal(applyCommand(next, "SetLayout", { mode: "camera" }, ctx).doc.layout.default.mode, "camera");
});

// CONTRACTS §5.40: face-track chosen in the editor shows the runs without a face with latar blur.
test("SetLayout into face-track turns the latar blur fallback on; every other switch keeps it", () => {
  const doc = fakeDoc();
  const ctx = createContext({ words: fakeWords(), seed: doc });
  assert.deepEqual(doc.layout.default, { mode: "fit_blur", no_face: "center" });
  const camera = applyCommand(doc, "SetLayout", { mode: "camera" }, ctx).doc;
  assert.deepEqual(camera.layout.default, { mode: "camera", no_face: "fit_blur" });
  const centred = applyCommand(camera, "SetNoFace", { mode: "center" }, ctx).doc;
  assert.deepEqual(centred.layout.default, { mode: "camera", no_face: "center" });
  // leaving face-track keeps the choice (it matters again only under face-track)
  const fill = applyCommand(centred, "SetLayout", { mode: "fill_center" }, ctx).doc;
  assert.deepEqual(fill.layout.default, { mode: "fill_center", no_face: "center" });
  // a face-track seed (the auto clip) keeps its own choice
  const seed = { ...doc, layout: { default: { mode: "camera", no_face: "center" } } };
  assert.deepEqual(switchedLayout(seed.layout.default, "camera"), { mode: "camera", no_face: "center" });
  assert.deepEqual(switchedLayout(doc.layout.default, "camera"), { mode: "camera", no_face: "fit_blur" });
  assert.deepEqual(switchedLayout(camera.layout.default, "fill_center"), { mode: "fill_center", no_face: "fit_blur" });
  for (const next of [camera, centred, fill]) assert.deepEqual(checkDoc(next, ctx), []);
});

test("SetNoFace changes only layout.default.no_face and refuses another value", () => {
  assert.ok(COMMANDS.includes("SetNoFace"));
  assert.deepEqual([...NO_FACE_MODES], ["center", "fit_blur"]);
  const doc = withLayout(fakeDoc(), "camera");
  const ctx = createContext({ words: fakeWords(), seed: fakeDoc() });
  const { doc: next, args } = applyCommand(doc, "SetNoFace", { mode: "center" }, ctx);
  assert.deepEqual(args, { mode: "center" });
  assert.deepEqual(next.layout.default, { mode: "camera", no_face: "center" });
  const { layout: _a, audit: _b, ...rest } = next;
  const { layout: _c, audit: _d, ...before } = doc;
  assert.deepEqual(rest, before);
  for (const mode of ["fail", "left", undefined]) {
    assert.throws(() => applyCommand(doc, "SetNoFace", { mode }, ctx),
      (error) => error instanceof CommandRejected && error.code === "value_out_of_range");
  }
  assert.deepEqual(noFaceCommand("center"), { type: "SetNoFace", args: { mode: "center" }, mergeKey: null });
  assert.throws(() => noFaceCommand("fail"), TypeError);
  const invalid = { ...doc, layout: { default: { mode: "camera", no_face: "fail" } } };
  assert.ok(checkDoc(invalid, ctx).some((issue) => issue.path === "/layout/default"));
});

test("a thumbnail asks for the document with only the layout changed", () => {
  const doc = fakeDoc();
  const camera = withLayout(doc, "camera");
  assert.equal(camera.layout.default.mode, "camera");
  assert.equal(camera.layout.default.no_face, "fit_blur"); // what SetLayout would make
  assert.equal(doc.layout.default.mode, "fit_blur");
  assert.notEqual(camera, doc);
  assert.equal(camera.main, doc.main); // shared, untouched
  assert.deepEqual({ ...camera, layout: doc.layout }, doc);
  assert.equal(withLayout(doc, "fit_blur"), doc);
  assert.throws(() => withLayout(doc, "smart_speaker"), TypeError);
  // layar terbagi (CONTRACTS §5.45): its thumbnail starts from the default bands, as SetLayout does
  const split = withLayout(doc, "split");
  assert.deepEqual(split.layout.split, { top_pm: 300, top: { x_e5: 50000, y_e5: 50000, zoom_pm: 1000 },
    bottom: { x_e5: 50000, y_e5: 50000, zoom_pm: 1000 } });
  assert.equal(withLayout(split, "split"), split);
  assert.ok(!Object.hasOwn(withLayout(split, "camera").layout, "split"));
  // manual framing (CONTRACTS §5.44): the crop layouts keep the keyframes, latar blur drops them
  const framed = { ...doc, layout: { default: { mode: "fill_center", no_face: "center" },
    keyframes: [{ sf: 37300, pan_e5: 20000, move: "cut" }] } };
  assert.equal(withLayout(framed, "camera").layout.keyframes, framed.layout.keyframes);
  assert.deepEqual(withLayout(framed, "fit_blur").layout, { default: { mode: "fit_blur", no_face: "center" } });
});

test("the thumbnail key ignores the layout, revision and audit and follows everything else", () => {
  const doc = fakeDoc();
  const key = contentKey(doc);
  assert.equal(contentKey(withLayout(doc, "camera")), key);
  assert.equal(contentKey({ ...doc, revision: 7, parent_sha256: "a".repeat(64), audit: { ...doc.audit, last_command: "X" } }), key);
  // the framing keyframes change the crop layouts' pixels, so they refresh the thumbnails
  const framed = { ...doc, layout: { ...doc.layout, keyframes: [{ sf: 37300, pan_e5: 20000, move: "cut" }] } };
  assert.notEqual(contentKey(framed), key);
  assert.equal(contentKey(withLayout(framed, "camera")), contentKey(framed));
  // so do the split's bands (CONTRACTS §5.45)
  const split = withLayout(doc, "split");
  const cropped = { ...split, layout: { ...split.layout, split: { ...split.layout.split, top_pm: 500 } } };
  assert.notEqual(contentKey(cropped), contentKey(split));
  const edited = structuredClone(doc);
  edited.captions.overrides.y_e5 = 70000;
  assert.notEqual(contentKey(edited), key);
  assert.equal(contentKey(null), null);
});

test("thumbnails come in the order current layout first, then the others", () => {
  assert.deepEqual(thumbnailOrder("fill_center"), ["fill_center", "fit_blur", "camera", "split"]);
  assert.deepEqual(thumbnailOrder("camera"), ["camera", "fit_blur", "fill_center", "split"]);
  assert.deepEqual(thumbnailOrder("split"), ["split", "fit_blur", "camera", "fill_center"]);
  assert.deepEqual(thumbnailOrder(null), ["fit_blur", "camera", "fill_center", "split"]);
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
  // layar terbagi needs no analysis (CONTRACTS §5.45)
  assert.equal(switchSteps({ target: "split", current: "camera", cameraReady: false }), "dispatch");
  assert.throws(() => switchSteps({ target: "smart_speaker", current: "fit_blur", cameraReady: true }), TypeError);
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
  assert.equal(early.seconds, 4); // the card shows the seconds alone
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
  // with the latar blur fallback the plan names them no_face_blur, at the same frames
  const blurred = { ...plan, warnings: plan.warnings.map((warning) => (warning.code === "no_face"
    ? { ...warning, code: "no_face_blur", path: "/layout/default/no_face" } : warning)) };
  assert.deepEqual(noFaceList(blurred), noFaceList(plan));
});

test("the runs without a face say what they show; the other choice is one click away", () => {
  const plan = { fps: [30000, 1001], totalFrames: 900, warnings: [
    { code: "no_face_blur", path: "/layout/default/no_face", f: 600 },
    { code: "no_face_blur", path: "/layout/default/no_face", f: 45 },
  ] };
  const blurred = withLayout(fakeDoc(), "camera");
  const view = noFaceView(blurred, plan);
  assert.equal(view.mode, "fit_blur");
  assert.deepEqual(view.runs.map((run) => run.f), [45, 600]);
  assert.equal(view.note, "Di bagian ini seluruh gambar tampil dengan latar blur.");
  const centred = { ...blurred, layout: { default: { mode: "camera", no_face: "center" } } };
  const back = noFaceView(centred, { ...plan, warnings: plan.warnings.map((w) => ({ ...w, code: "no_face" })) });
  assert.equal(back.mode, "center");
  assert.equal(back.note, "Di bagian ini video dipusatkan.");
  assert.deepEqual(back.runs, view.runs);
  // the choice: latar blur first (what face-track gets in the editor), each one SetNoFace
  assert.deepEqual(NO_FACE_OPTIONS.map((entry) => [entry.id, entry.label]), [["fit_blur", "Latar blur"], ["center", "Dipusatkan"]]);
  assert.deepEqual(NO_FACE_OPTIONS.map((entry) => entry.id), [...NO_FACE_MODES].reverse());
  for (const entry of NO_FACE_OPTIONS) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(noFaceCommand(entry.id), { type: "SetNoFace", args: { mode: entry.id }, mergeKey: null });
    assert.doesNotMatch(`${entry.label} ${entry.note}`, /[\u2013\u2014]|V[0-9]/);
  }
});

test("the face-track note says what this clip does where no face is found", () => {
  const camera = LAYOUT_OPTIONS.find((option) => option.id === "camera");
  assert.match(camera.note, /latar blur/); // choosing it turns the fallback on
  const blurred = withLayout(fakeDoc(), "camera");
  assert.equal(layoutNote(camera, blurred), camera.note);
  const centred = { ...blurred, layout: { default: { mode: "camera", no_face: "center" } } };
  assert.match(layoutNote(camera, centred), /dipusatkan\.$/);
  const fit = LAYOUT_OPTIONS.find((option) => option.id === "fit_blur");
  assert.equal(layoutNote(fit, centred), fit.note);
});

// --- zoom (CONTRACTS §5.47) ----------------------------------------------------------------------

test("the zoom section: 100 to 150 % in 5 % steps for every layout but the split, with the bars note", () => {
  const doc = fakeDoc();
  const plain = zoomView(doc);
  assert.deepEqual({ ...plain, text: undefined }, { available: true, zoom: 1000, percent: 100, min: 1000, max: 1500, step: 50,
    zoomed: false, bars: false, text: undefined });
  assert.match(plain.text, /150%/);
  assert.doesNotMatch(plain.text, /[–—]/);
  const zoomed = zoomView({ ...doc, layout: { ...doc.layout, zoom_pm: 1250 } });
  assert.equal(zoomed.percent, 125);
  assert.equal(zoomed.zoomed, true);
  const split = zoomView(withLayout(doc, "split"));
  assert.equal(split.available, false);
  const barred = structuredClone(doc);
  barred.base.source.content_rect = { x: 0, y: 90, w: doc.base.source.w, h: doc.base.source.h - 180 };
  assert.equal(zoomView(barred).bars, true);
  assert.equal(zoomPercent(1333), 133);
  assert.deepEqual(zoomCommand(1250), { type: "SetZoom", args: { zoom_pm: 1250 }, mergeKey: "layout:zoom" });
  assert.throws(() => zoomCommand(1600), TypeError);
  assert.throws(() => zoomCommand(1200.5), TypeError);
  assert.deepEqual(ZOOM_OPTIONS_PM, [1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350, 1400, 1450, 1500]);
  assert.ok(COMMANDS.includes("SetZoom"));
});

test("the zoom refreshes the thumbnails and stays with a layout switch", () => {
  const doc = fakeDoc();
  const zoomed = { ...doc, layout: { ...doc.layout, zoom_pm: 1200 } };
  assert.notEqual(contentKey(zoomed), contentKey(doc));
  assert.equal(contentKey(withLayout(zoomed, "fill_center")), contentKey(zoomed));
  assert.equal(withLayout(zoomed, "camera").layout.zoom_pm, 1200);
  assert.ok(!Object.hasOwn(withLayout(zoomed, "split").layout, "zoom_pm"));
});
