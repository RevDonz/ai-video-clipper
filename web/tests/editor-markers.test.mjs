// Timeline markers and the speech waveform (plan §11.3 T3.7, §3.6, §6.1 "Waveform and markers").
// The marker frames must equal the Python vectors (tests/fixtures/edit_v2/marker-vectors.json,
// checked there against a rational reference of the time map): 0 frames of difference.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { caseWords } from "../components/editor/timeline/lanes/__dev__/marker-cases.mjs";
import {
  KIND_ORDER, SILENCE_MIN_MS, buildMarkers, markerText, unavailableNote,
} from "../components/editor/timeline/lanes/markers.mjs";
import {
  decodePeaks, peaksUrl, waveformShapes,
} from "../components/editor/timeline/lanes/speech-waveform.mjs";
import { pieces as docPieces } from "../lib/editor/timemap.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repo, "tests", "fixtures", "edit_v2");
const vectors = JSON.parse(readFileSync(path.join(fixtureDir, "marker-vectors.json"), "utf8"));
const contextWords = (id) => JSON.parse(readFileSync(path.join(fixtureDir, "docs", "contexts", `${id}.words.json`), "utf8"));
const contextSeed = (id) => JSON.parse(readFileSync(path.join(fixtureDir, "docs", "contexts", `${id}.seed.json`), "utf8"));
const VECTOR_FIELDS = ["kind", "src", "seg", "s", "e", "f0", "f1"];
const pick = (marker) => Object.fromEntries(VECTOR_FIELDS.map((key) => [key, marker[key]]));

test("every marker of the vectors lands on its exact frame (0 frames of difference)", () => {
  let total = 0;
  for (const kase of vectors.cases) {
    const words = caseWords(contextWords(kase.context), kase);
    const { markers, unavailable } = buildMarkers(words, kase.doc);
    assert.deepEqual(markers.map(pick), kase.markers, kase.name);
    assert.deepEqual(unavailable, kase.unavailable, kase.name);
    total += markers.length;
  }
  assert.ok(total >= 700, `only ${total} markers checked`);
  assert.equal(vectors.silence_min_ms, SILENCE_MIN_MS);
  assert.deepEqual(KIND_ORDER, ["laughter", "silence", "camera_cut"]);
});

test("case words mirror the generator: the missing list names what is empty", () => {
  const words = contextWords("c30");
  const stripped = caseWords(words, { strip: ["audio_timeline", "sound_events"] });
  assert.deepEqual(stripped.missing, ["audio_timeline", "sound_events"]);
  assert.deepEqual([stripped.silences, stripped.scene_cuts_ms, stripped.gaps], [[], [], []]);
  assert.deepEqual([...new Set(stripped.events.map((event) => event.src))], ["transcript"]);
  assert.equal(caseWords(words, { strip: [], extra: null }), words);
  const dense = vectors.cases.find((kase) => kase.extra);
  const merged = caseWords(contextWords(dense.context), dense);
  assert.ok(merged.events.length > contextWords(dense.context).events.length);
  assert.deepEqual(merged.scene_cuts_ms, [...merged.scene_cuts_ms].sort((a, b) => a - b));
});

test("markers carry stable unique keys and a source-aware label with the output time", () => {
  const words = contextWords("c30");
  const doc = contextSeed("c30");
  const { markers } = buildMarkers(words, doc);
  assert.equal(new Set(markers.map((marker) => marker.key)).size, markers.length);
  const texts = markers.map((marker) => markerText(marker, { fps: doc.output.fps, words }));
  const tag = texts[markers.findIndex((marker) => marker.src === "yt-caption")];
  const token = texts[markers.findIndex((marker) => marker.src === "transcript")];
  const silence = texts[markers.findIndex((marker) => marker.kind === "silence")];
  const cut = texts[markers.findIndex((marker) => marker.kind === "camera_cut")];
  assert.match(tag.label, /^Tawa, dari tag caption YouTube, di \d\d:\d\d,\d$/);
  assert.match(token.label, /^Tawa, dari transkrip \(".+"\), di \d\d:\d\d,\d$/);
  assert.match(silence.label, /^Jeda \d+,\d dtk, di \d\d:\d\d,\d$/);
  assert.match(cut.label, /^Potongan kamera, di \d\d:\d\d,\d$/);
  for (const text of texts) {
    assert.ok(text.short.length > 0 && text.short.length <= 40, text.short);
    assert.doesNotMatch(`${text.label} ${text.short}`, /—|\bV[123]\b|versi|mesin/i);
  }
});

test("only laughter events become laughter markers, and short silences are not markers", () => {
  const words = structuredClone(contextWords("c24"));
  const doc = contextSeed("c24");
  const body = doc.main.segments.find((segment) => segment.role === "body");
  const midMs = Math.round(((body.in_sf + 200) * 1000 * doc.output.fps[1]) / doc.output.fps[0]);
  words.events.push({ kind: "applause", s: midMs, e: midMs, src: "yt-caption" });
  words.silences = [[midMs, midMs + SILENCE_MIN_MS - 1], [midMs + 2000, midMs + 2000 + SILENCE_MIN_MS]];
  const { markers } = buildMarkers(words, doc);
  assert.equal(markers.filter((marker) => marker.s === midMs && marker.kind === "laughter").length, 0);
  const silences = markers.filter((marker) => marker.kind === "silence");
  assert.deepEqual(silences.map((marker) => marker.e - marker.s), [SILENCE_MIN_MS]);
});

test("the unavailable note names what the job lacks, in plain words", () => {
  assert.equal(unavailableNote([]), null);
  assert.equal(unavailableNote(["laughter_tags"]),
    "Tag tawa dari caption tidak tersedia untuk job ini. Tawa di transkrip tetap ditandai.");
  assert.equal(unavailableNote(["camera_cut", "silence"]),
    "Jeda dan potongan kamera tidak tersedia untuk job ini.");
  assert.equal(unavailableNote(["camera_cut", "laughter_tags", "silence"]),
    "Jeda, potongan kamera, dan tag tawa dari caption tidak tersedia untuk job ini. Tawa di transkrip tetap ditandai.");
});

test("a words artifact without analysis fields still builds (nothing to mark, nothing crashes)", () => {
  const doc = contextSeed("c25");
  const words = { words: [], units: [], bounds: [], missing: [] };
  assert.deepEqual(buildMarkers(words, doc), { markers: [], unavailable: [] });
  assert.deepEqual(buildMarkers(null, doc), { markers: [], unavailable: [] });
  assert.deepEqual(buildMarkers(words, null), { markers: [], unavailable: [] });
});

// --- the speech waveform ----------------------------------------------------------------------

function syntheticPeaks(words, spikes = []) {
  const [a, b] = words.window_ms;
  const bins = Math.ceil(((b - a) * 100) / 1000);
  const bytes = new Int8Array(bins * 2);
  for (let i = 0; i < bins; i += 1) {
    bytes[2 * i] = -4;
    bytes[2 * i + 1] = 4;
  }
  for (const ms of spikes) {
    const bin = Math.floor((ms - a) / 10);
    bytes[2 * bin] = -120;
    bytes[2 * bin + 1] = 120;
  }
  return bytes;
}

function xs(d) {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((match) => Number(match[1]));
}

test("the waveform is laid out per piece: each piece spans exactly its output frames", () => {
  const words = contextWords("c30");
  const doc = vectors.cases.find((kase) => kase.name === "c30/cuts").doc;
  const pieces = docPieces(doc);
  assert.ok(pieces.length >= 4, "the cut document has several pieces");
  const peaks = syntheticPeaks(words);
  const { total, shapes } = waveformShapes({ peaks, peaksInfo: words.peaks, pieces, fps: doc.output.fps, pxPerFrame: 1 });
  assert.equal(total, pieces.at(-1).outF0 + pieces.at(-1).frames);
  assert.deepEqual(shapes.map((shape) => [shape.seg, shape.role, shape.f0, shape.f1]),
    pieces.map((piece) => [piece.seg, piece.role, piece.outF0, piece.outF0 + piece.frames]));
  for (const [index, shape] of shapes.entries()) {
    const x = xs(shape.d);
    assert.ok(x.length >= 4, `piece ${index} has a shape`);
    assert.equal(Math.min(...x), pieces[index].outF0);
    assert.equal(Math.max(...x), pieces[index].outF0 + pieces[index].frames);
  }
});

test("a loud moment of the source is drawn where the time map puts it after cuts", () => {
  const words = contextWords("c30");
  const doc = vectors.cases.find((kase) => kase.name === "c30/cuts").doc;
  const [num, den] = doc.output.fps;
  const pieces = docPieces(doc);
  const piece = pieces.find((item) => item.role === "body" && item.i > 1);
  const spikeMs = Math.round(((piece.inSf + 40) * 1000 * den) / num);
  const peaks = syntheticPeaks(words, [spikeMs]);
  const { shapes, amp } = waveformShapes({ peaks, peaksInfo: words.peaks, pieces, fps: doc.output.fps, pxPerFrame: 4 });
  assert.equal(amp, 120);
  const shape = shapes.find((item) => item.f0 === piece.outF0);
  const points = [...shape.d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
  const loud = points.filter(([, y]) => y <= -0.99);
  assert.ok(loud.length >= 1);
  const expected = piece.outF0 + ((spikeMs - (piece.inSf * 1000 * den) / num) * num) / (1000 * den);
  for (const [x] of loud) assert.ok(Math.abs(x - expected) <= 1, `${x} vs ${expected}`);
});

test("columns are merged when zoomed out, never finer than one bin", () => {
  const words = contextWords("c25");
  const doc = contextSeed("c25");
  const pieces = docPieces(doc);
  const peaks = syntheticPeaks(words);
  const near = waveformShapes({ peaks, peaksInfo: words.peaks, pieces, fps: doc.output.fps, pxPerFrame: 8 });
  const far = waveformShapes({ peaks, peaksInfo: words.peaks, pieces, fps: doc.output.fps, pxPerFrame: 0.05 });
  const count = (result) => result.shapes.reduce((sum, shape) => sum + xs(shape.d).length, 0);
  assert.ok(count(far) < count(near) / 4, `${count(far)} vs ${count(near)}`);
  const bins = Math.ceil(((pieces[0].frames * 1000 * doc.output.fps[1]) / doc.output.fps[0]) / 10);
  assert.ok(count(near) <= 2 * bins + 8);
});

test("peaks: the URL is built from checked ids and file name only; bytes decode as signed pairs", () => {
  const state = { jobId: "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", clipId: "clip_9b2e41c07d3a5f18e6c2a0b4",
    words: { peaks: { file: "peaks.0123456789abcdef.bin", per_sec: 100, start_ms: 0 } } };
  assert.equal(peaksUrl(state),
    "/api/jobs/8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55/clips/clip_9b2e41c07d3a5f18e6c2a0b4/media/peaks/peaks.0123456789abcdef.bin");
  assert.equal(peaksUrl({ ...state, jobId: "../x" }), null);
  assert.equal(peaksUrl({ ...state, clipId: "clip_x" }), null);
  assert.equal(peaksUrl({ ...state, words: { peaks: { file: "../../etc/passwd" } } }), null);
  assert.equal(peaksUrl({ ...state, words: { peaks: { file: "peaks.0123456789abcdef.bin", per_sec: 50 } } }), null);
  assert.equal(peaksUrl({ ...state, words: null }), null);
  const decoded = decodePeaks(new Uint8Array([0xff, 0x7f, 0x80, 0x00]).buffer);
  assert.deepEqual([...decoded], [-1, 127, -128, 0]);
  assert.throws(() => decodePeaks(new Uint8Array([1, 2, 3]).buffer), /peaks/);
});
