// T3.3 music and ducking (plan §11.3, §5.6, Appendix B): the pure parts of the Musik panel
// (panels/music-model.mjs), the music lane (timeline/lanes/music-lane-model.mjs) and the upload
// seam (panels/music-upload.mjs). Every command the panel builds is run through the real
// applyCommand, so the panel can never send something the store rejects.
import assert from "node:assert/strict";
import test from "node:test";

import {
  FAKE_JOB_ID,
  createFakeUploadClient,
  fakeDoc,
  fakePlan,
  fakeWords,
} from "../components/editor/__dev__/fakes.mjs";
import {
  DUCK_PRESET_LIST,
  MUSIC_ACCEPT,
  MUSIC_MAX_BYTES,
  MUSIC_MIME,
  duckPresetOf,
  formatDb,
  formatDuration,
  formatLufs,
  musicCommands,
  musicFileProblem,
  musicFileType,
  musicView,
  uploadErrorText,
  warningDetail,
} from "../components/editor/panels/music-model.mjs";
import {
  UploadError,
  httpUploadAsset,
  resolveUploadAsset,
} from "../components/editor/panels/music-upload.mjs";
import {
  ENVELOPE_FLOOR_DB,
  decodePeaks,
  envelopePoints,
  envelopeRef,
  gainAt,
  gainToY,
  musicSourceMs,
  sampleToX,
  waveformColumns,
  waveformPath,
} from "../components/editor/timeline/lanes/music-lane-model.mjs";
import { DUCK_PRESETS, applyCommand } from "../lib/editor/commands.mjs";
import { createContext, musicItem } from "../lib/editor/doc-model.mjs";

const ctx = createContext({ words: fakeWords(), seed: fakeDoc() });

async function musicDto(name = "lagu.m4a") {
  return createFakeUploadClient().uploadAsset(FAKE_JOB_ID, { name, size: 4096, type: "audio/mp4" }, "music");
}

/** Runs the panel's command list through the real commands, as the store does. */
function run(doc, commands) {
  let current = doc;
  for (const command of commands) current = applyCommand(current, command.type, command.args, ctx).doc;
  return current;
}

async function docWithMusic() {
  return run(fakeDoc(), musicCommands.add(await musicDto()));
}

function stateOf(doc, extra = {}) {
  return { status: "ready", doc, seed: fakeDoc(), plan: fakePlan(doc), pending: [], warnings: [], ...extra };
}

// --- files and upload errors (plan §9.2) --------------------------------------------------------

test("the music allowlist is §9.2's, 50 MB, and the picker accepts the same files", () => {
  assert.deepEqual([...MUSIC_MIME], ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"]);
  assert.equal(MUSIC_MAX_BYTES, 50 * 1024 * 1024);
  for (const piece of ["audio/mpeg", ".mp3", ".m4a", ".wav", ".ogg", ".flac"]) assert.ok(MUSIC_ACCEPT.includes(piece), piece);
  assert.ok(!MUSIC_ACCEPT.includes("image/"));
});

test("browser file types are mapped onto the allowlist by alias, then by extension", () => {
  const file = (name, type) => ({ name, type, size: 10 });
  assert.equal(musicFileType(file("a.mp3", "audio/mpeg")), "audio/mpeg");
  assert.equal(musicFileType(file("a.m4a", "audio/x-m4a")), "audio/mp4");
  assert.equal(musicFileType(file("a.wav", "audio/x-wav")), "audio/wav");
  assert.equal(musicFileType(file("a.wav", "audio/wave")), "audio/wav");
  assert.equal(musicFileType(file("a.flac", "audio/x-flac")), "audio/flac");
  assert.equal(musicFileType(file("a.flac", "")), "audio/flac");
  assert.equal(musicFileType(file("A.OGG", "")), "audio/ogg");
  assert.equal(musicFileType(file("a.opus", "")), "audio/ogg");
  assert.equal(musicFileType(file("a.svg", "image/svg+xml")), null);
  assert.equal(musicFileType(file("a.mp3.exe", "")), null);
  assert.equal(musicFileType(file("clip.mp4", "video/mp4")), null, "a video file is not music");
});

test("a file is checked for type and size before any byte is sent", () => {
  assert.equal(musicFileProblem({ name: "a.mp3", type: "audio/mpeg", size: 1024 }), null);
  assert.equal(musicFileProblem({ name: "a.gif", type: "image/gif", size: 1024 }), "type");
  assert.equal(musicFileProblem({ name: "a.mp3", type: "audio/mpeg", size: MUSIC_MAX_BYTES + 1 }), "size");
  assert.equal(musicFileProblem({ name: "a.mp3", type: "audio/mpeg", size: MUSIC_MAX_BYTES }), null);
  assert.equal(musicFileProblem({ name: "a.mp3", type: "audio/mpeg", size: 0 }), "empty");
});

test("every upload failure has its own Indonesian sentence; a cancel has none", () => {
  const texts = new Set();
  const cases = [
    new UploadError(413, "asset_too_large"),
    new UploadError(415, "asset_type_unsupported"),
    new UploadError(422, "asset_rejected"),
    new UploadError(422, "asset_too_long"),
    new UploadError(429, "rate_limited"),
    new UploadError(404, "editor_disabled"),
    new UploadError(507, "storage_quota_exhausted"),
    new UploadError(0, "network"),
  ];
  for (const error of cases) {
    const text = uploadErrorText(error);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 10 && !/—/.test(text) && !/V[123]\b/.test(text), text);
    texts.add(text);
  }
  assert.equal(texts.size, cases.length, "no two failures share a sentence");
  assert.match(uploadErrorText(new UploadError(413, "asset_too_large")), /50 MB/);
  assert.match(uploadErrorText(new UploadError(415, "asset_type_unsupported")), /MP3/);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(uploadErrorText(abort), null);
  // The fake upload client's errors carry the same fields.
  assert.match(uploadErrorText({ status: 415, code: "asset_type_unsupported" }), /MP3/);
});

// --- formatting ---------------------------------------------------------------------------------

test("numbers are written the Indonesian way with a real minus sign", () => {
  assert.equal(formatDb(-1000), "−10,0 dB");
  assert.equal(formatDb(0), "0,0 dB");
  assert.equal(formatDb(600), "+6,0 dB");
  assert.equal(formatDb(-380), "−3,8 dB");
  assert.equal(formatLufs(-1400), "−14,0 LUFS");
  assert.equal(formatLufs(-1630), "−16,3 LUFS");
  assert.equal(formatDuration(95_000), "1:35");
  assert.equal(formatDuration(3_600_000), "60:00");
  assert.equal(warningDetail([{ code: "peak_reduced:-3.80 dB" }], "peak_reduced"), -380);
  assert.equal(warningDetail([{ code: "loudness_clamped:-16.30 LUFS" }], "loudness_clamped"), -1630);
  assert.equal(warningDetail([{ code: "tight_cut" }], "peak_reduced"), null);
});

// --- presets and commands (Appendix B) ----------------------------------------------------------

test("the three duck presets are Halus −6, Sedang −10, Kuat −16 dB, the store's own table", () => {
  assert.deepEqual(DUCK_PRESET_LIST.map((preset) => [preset.id, preset.name, preset.depthCdb]),
    [["halus", "Halus", 600], ["sedang", "Sedang", 1000], ["kuat", "Kuat", 1600]]);
  for (const preset of DUCK_PRESET_LIST) assert.equal(DUCK_PRESETS[preset.id], preset.depthCdb);
  assert.equal(duckPresetOf(600), "halus");
  assert.equal(duckPresetOf(1000), "sedang");
  assert.equal(duckPresetOf(1600), "kuat");
  assert.equal(duckPresetOf(1200), "custom");
});

test("adding music is one SetMusic with the upload DTO; the store's defaults follow (gain from LUFS, loop, fades, Sedang)", async () => {
  const dto = await musicDto();
  const commands = musicCommands.add(dto);
  assert.deepEqual(commands.map((command) => command.type), ["SetMusic"]);
  const doc = run(fakeDoc(), commands);
  const item = musicItem(doc);
  assert.equal(item.payload.asset, `sha256:${dto.sha256}`);
  assert.equal(item.payload.gain_cdb, -2600 - dto.lufsC);
  assert.deepEqual([item.payload.loop, item.payload.fade_in_f, item.payload.fade_out_f], [true, 15, 30]);
  assert.equal(item.payload.duck.depth_cdb, DUCK_PRESETS.sedang);
  assert.deepEqual(doc.assets[`sha256:${dto.sha256}`], { kind: "audio", mime: "audio/mp4", duration_ms: dto.durationMs, lufs_c: dto.lufsC });
});

test("every panel control builds commands the real store accepts, with the Appendix B merge keys", async () => {
  const base = await docWithMusic();
  const cases = [
    [musicCommands.gain(-1450), (doc) => musicItem(doc).payload.gain_cdb === -1450, "music:gain"],
    [musicCommands.offset(48_000 * 12), (doc) => musicItem(doc).payload.src_in_smp === 576_000, "music:offset"],
    [musicCommands.loop(false), (doc) => musicItem(doc).payload.loop === false, "music:loop"],
    [musicCommands.fadeIn(45), (doc) => musicItem(doc).payload.fade_in_f === 45, "music:fades"],
    [musicCommands.fadeOut(0), (doc) => musicItem(doc).payload.fade_out_f === 0, "music:fades"],
    [musicCommands.duckOn(false), (doc) => musicItem(doc).payload.duck.on === false, "music:duck"],
    [musicCommands.duckPreset("kuat"), (doc) => musicItem(doc).payload.duck.depth_cdb === 1600 && musicItem(doc).payload.duck.on, "music:duck"],
    [musicCommands.duckPreset("halus"), (doc) => musicItem(doc).payload.duck.depth_cdb === 600, "music:duck"],
    [musicCommands.duckParam("depth_cdb", 1250), (doc) => musicItem(doc).payload.duck.depth_cdb === 1250, "music:duck"],
    [musicCommands.duckParam("attack_ms", 120), (doc) => musicItem(doc).payload.duck.attack_ms === 120, "music:duck"],
    [musicCommands.duckParam("release_ms", 900), (doc) => musicItem(doc).payload.duck.release_ms === 900, "music:duck"],
    [musicCommands.duckParam("hold_ms", 0), (doc) => musicItem(doc).payload.duck.hold_ms === 0, "music:duck"],
    [musicCommands.sourceGain(-600), (doc) => doc.audio.source.gain_cdb === -600, "audio:source"],
    [musicCommands.sourceGain(1200), (doc) => doc.audio.source.gain_cdb === 1200, "audio:source"],
    [musicCommands.loudness(true), (doc) => doc.audio.master.mode === "normalize", "audio:master"],
    [musicCommands.loudness(false), (doc) => doc.audio.master.mode === "off", "audio:master"],
    [musicCommands.remove(), (doc) => musicItem(doc) === null && Object.keys(doc.assets).length === 0, null],
  ];
  for (const [commands, check, mergeKey] of cases) {
    assert.equal(commands.length, 1);
    assert.equal(commands[0].mergeKey, mergeKey, commands[0].type);
    assert.ok(check(run(base, commands)), `${commands[0].type} ${JSON.stringify(commands[0].args)}`);
  }
});

test("slider values outside the document's ranges are clamped before they reach the store", async () => {
  const base = await docWithMusic();
  assert.equal(musicItem(run(base, musicCommands.gain(-9999))).payload.gain_cdb, -4800);
  assert.equal(musicItem(run(base, musicCommands.gain(999))).payload.gain_cdb, 600);
  assert.equal(run(base, musicCommands.sourceGain(5000)).audio.source.gain_cdb, 1200);
  assert.equal(musicItem(run(base, musicCommands.duckParam("attack_ms", 1))).payload.duck.attack_ms, 5);
  assert.equal(musicItem(run(base, musicCommands.gain(-1033))).payload.gain_cdb, -1033, "whole cdB pass through");
  assert.throws(() => musicCommands.duckParam("detector", "x"), /duck/);
});

test("replacing the track keeps the user's loop, fades and ducking in one undo step; gain and start follow the new track", async () => {
  let doc = await docWithMusic();
  doc = run(doc, [...musicCommands.loop(false), ...musicCommands.fadeIn(0), ...musicCommands.duckPreset("kuat"),
    ...musicCommands.duckParam("hold_ms", 500), ...musicCommands.offset(48_000), ...musicCommands.gain(-2000)]);
  const next = { ...(await musicDto("lain.mp3")), lufsC: -900, durationMs: 200_000 };
  const commands = musicCommands.replace(doc, next);
  assert.equal(commands[0].type, "SetMusic");
  const keys = new Set(commands.map((command) => command.mergeKey));
  assert.equal(keys.size, 1, "one merge key: one undo step");
  assert.match([...keys][0], /^tx:music-replace:\d+$/);
  const after = run(doc, commands);
  const payload = musicItem(after).payload;
  assert.equal(payload.asset, `sha256:${next.sha256}`);
  assert.equal(payload.gain_cdb, -2600 + 900, "the new track's own level");
  assert.equal(payload.src_in_smp, 0);
  assert.equal(payload.loop, false);
  assert.deepEqual([payload.fade_in_f, payload.fade_out_f], [0, 30]);
  assert.deepEqual([payload.duck.on, payload.duck.depth_cdb, payload.duck.hold_ms], [true, 1600, 500]);
  assert.equal(Object.keys(after.assets).length, 1, "the old asset leaves the document");
  // Nothing to carry over: a plain SetMusic.
  assert.equal(musicCommands.replace(await docWithMusic(), next).length, 1);
});

// --- the panel's view ---------------------------------------------------------------------------

test("without music the view offers the upload and still shows the clip's own sound controls", () => {
  const view = musicView(stateOf(fakeDoc()));
  assert.equal(view.hasMusic, false);
  assert.equal(view.readOnly, false);
  assert.equal(view.sourceGainCdb, 0);
  assert.equal(view.loudness.on, false);
  assert.equal(view.loudness.suggest, false, "normalize is suggested only with music (K9)");
});

test("with music the view carries every control's value and its text", async () => {
  const doc = await docWithMusic();
  const view = musicView(stateOf(doc));
  assert.equal(view.hasMusic, true);
  assert.equal(view.gainText, "−9,8 dB");
  assert.equal(view.defaultGainCdb, -980);
  assert.equal(view.durationText, "1:35");
  assert.equal(view.offsetText, "0:00,0");
  assert.equal(view.maxOffsetSmp, 95_000 * 48 - 1);
  assert.equal(view.fadeMaxF, Math.floor((10_000 * 30000) / (1000 * 1001)));
  assert.equal(view.fadeInText, "0,5 dtk");
  assert.equal(view.fadeOutText, "1,0 dtk");
  assert.equal(view.duck.preset, "sedang");
  assert.equal(view.loudness.suggest, true);
  assert.equal(view.peakReducedCdb, null);
  assert.equal(view.shorter, false);
});

test("the view reads peak_reduced, loudness_clamped and music_shorter_than_clip from the plan", async () => {
  let doc = await docWithMusic();
  doc = run(doc, [...musicCommands.loudness(true)]);
  const plan = { ...fakePlan(doc), warnings: [{ code: "peak_reduced:-3.80 dB", path: "/audio" },
    { code: "loudness_clamped:-16.30 LUFS", path: "/audio/master" },
    { code: "music_shorter_than_clip", path: "/tracks/1/items/0" }] };
  const view = musicView(stateOf(doc, { plan }));
  assert.equal(view.peakReducedCdb, -380);
  assert.equal(view.peakText, "Volume diturunkan 3,8 dB agar tidak pecah");
  assert.equal(view.loudness.clamped, true);
  assert.equal(view.loudness.achievedText, "Tercapai −16,3 LUFS: dibatasi agar tidak pecah");
  assert.equal(view.shorter, true);
});

test("normalize shows the reached loudness once the mix is ready, and 'Mengukur…' before", async () => {
  const doc = run(await docWithMusic(), musicCommands.loudness(true));
  const ready = musicView(stateOf(doc));
  assert.equal(ready.loudness.on, true);
  assert.equal(ready.loudness.measuring, false);
  // Without loudness_clamped the master reached the target within 1 LU (the clamp warns only above
  // that, loudness.CLAMP_WARNING_CDB); the plan does not carry the exact value, so none is claimed.
  assert.equal(ready.loudness.achievedText, "Sesuai target −14,0 LUFS (±1 LU)");
  const plan = { ...fakePlan(doc), audio: { ...fakePlan(doc).audio, state: "queued" } };
  const pending = musicView(stateOf(doc, { plan, pending: ["audio"] }));
  assert.equal(pending.loudness.measuring, true);
  assert.equal(pending.loudness.achievedText, "Mengukur…");
  assert.equal(pending.audioPending, true);
  // A stale clamp from an older mix is not shown while the new one is measured.
  const stale = { ...plan, warnings: [{ code: "loudness_clamped:-16.30 LUFS" }] };
  assert.equal(musicView(stateOf(doc, { plan: stale, pending: ["audio"] })).loudness.achievedText, "Mengukur…");
});

test("a read-only or loading editor disables the panel", async () => {
  const doc = await docWithMusic();
  assert.equal(musicView(stateOf(doc, { status: "readOnly" })).readOnly, true);
  assert.equal(musicView({ status: "loading", doc: null, plan: null }).loading, true);
});

// --- the lane (§4.3 musicGainPoints) ------------------------------------------------------------

test("an output sample maps to the timeline x of its frame", () => {
  assert.equal(sampleToX(0, [30, 1], 2), 0);
  assert.equal(sampleToX(48_000, [30, 1], 2), 60);
  assert.ok(Math.abs(sampleToX(48_000, [30000, 1001], 1) - 30000 / 1001) < 1e-9);
});

test("the envelope drawing has one vertex per plan point, in order, on a dB scale under the item's gain", () => {
  const points = [[0, 0], [24_000, 316_228], [48_000, 316_228], [49_440, 100_000], [96_000, 100_000], [115_200, 316_228], [144_000, 0]];
  const ref = envelopeRef(points, -1000);
  assert.equal(ref, 316_228);
  const drawn = envelopePoints(points, { fps: [30, 1], pxPerFrame: 2, refE6: ref, height: 100 });
  assert.equal(drawn.length, points.length);
  drawn.forEach(([x, y], i) => {
    assert.ok(Math.abs(x - sampleToX(points[i][0], [30, 1], 2)) < 1e-9);
    assert.ok(Math.abs(y - gainToY(points[i][1], ref, 100)) < 1e-9);
  });
  assert.equal(gainToY(316_228, ref, 100), 0, "full level at the top");
  assert.equal(gainToY(0, ref, 100), 100, "silence at the bottom");
  assert.ok(Math.abs(gainToY(100_000, ref, 100) - (10 / -ENVELOPE_FLOOR_DB) * 100) < 0.01, "−10 dB under the gain");
  assert.equal(envelopeRef([[0, 2_000_000]], -1000), 2_000_000, "never below the loudest point");
  assert.deepEqual(envelopePoints([], { fps: [30, 1], pxPerFrame: 1, refE6: 1, height: 10 }), []);
});

test("the gain between breakpoints is linear, as expand_f32 renders it", () => {
  const points = [[0, 0], [100, 1_000_000], [200, 1_000_000]];
  assert.equal(gainAt(points, 0), 0);
  assert.equal(gainAt(points, 50), 500_000);
  assert.equal(gainAt(points, 150), 1_000_000);
  assert.equal(gainAt(points, 500), 1_000_000, "the last value holds");
  assert.equal(gainAt([], 10), 0);
});

test("the music position of an output sample follows the start offset and the loop", () => {
  const payload = { src_in_smp: 48_000 * 2, loop: true };
  assert.equal(musicSourceMs(0, payload, 10_000), 2000);
  assert.equal(musicSourceMs(48_000 * 8, payload, 10_000), 0, "wraps to the start of the file");
  assert.equal(musicSourceMs(48_000 * 9, payload, 10_000), 1000);
  assert.equal(musicSourceMs(48_000 * 8, { ...payload, loop: false }, 10_000), null, "past the end without the loop");
});

test("peaks decode as signed (min, max) byte pairs, 100 per second", () => {
  const bytes = new Int8Array([-10, 20, -128, 127, 0, 0]);
  const peaks = decodePeaks(bytes.buffer);
  assert.equal(peaks.bins, 3);
  assert.deepEqual([...peaks.min], [-10, -128, 0]);
  assert.deepEqual([...peaks.max], [20, 127, 0]);
  assert.equal(decodePeaks(new ArrayBuffer(3)).bins, 1, "an odd trailing byte is ignored");
});

test("the waveform follows the envelope: a ducked span draws smaller than an unducked one", () => {
  const bins = 1000; // 10 s of peaks at a steady level
  const buffer = new Int8Array(bins * 2);
  for (let i = 0; i < bins; i += 1) { buffer[2 * i] = -64; buffer[2 * i + 1] = 64; }
  const peaks = decodePeaks(buffer.buffer);
  const points = [[0, 316_228], [96_000, 316_228], [96_000 + 1, 100_000], [192_000, 100_000]];
  const columns = waveformColumns({ peaks, payload: { src_in_smp: 0, loop: true }, durationMs: 10_000, points,
    fps: [30, 1], pxPerFrame: 2, totalFrames: 120, refE6: 316_228, columnPx: 4 });
  assert.equal(columns.length, 60);
  const loud = columns[5].amp;
  const ducked = columns[50].amp;
  assert.ok(loud > 0.49 && loud <= 0.51, `unducked ${loud}`);
  assert.ok(Math.abs(ducked / loud - 100_000 / 316_228) < 0.01, `ducked ratio ${ducked / loud}`);
  const path = waveformPath(columns, 30);
  assert.match(path, /^M/);
  assert.equal((path.match(/M/g) || []).length, columns.filter((column) => column.amp > 0).length);
  // Past the end of a track without the loop there is nothing to draw.
  const once = waveformColumns({ peaks, payload: { src_in_smp: 0, loop: false }, durationMs: 1000, points,
    fps: [30, 1], pxPerFrame: 2, totalFrames: 120, refE6: 316_228, columnPx: 4 });
  assert.ok(once.slice(15).every((column) => column.amp === 0), "1 s of music ends at column 15");
  // Very wide timelines stay under the column cap.
  const wide = waveformColumns({ peaks, payload: { src_in_smp: 0, loop: true }, durationMs: 10_000, points,
    fps: [30, 1], pxPerFrame: 400, totalFrames: 9000, refE6: 316_228, columnPx: 2, maxColumns: 4000 });
  assert.ok(wide.length <= 4000);
});

// --- the upload seam (Appendix A.2 uploadAsset) -------------------------------------------------

function fakeXhr(script) {
  const sent = [];
  class Xhr {
    constructor() {
      this.headers = {};
      this.upload = { onprogress: null };
      this.status = 0;
      this.responseText = "";
      sent.push(this);
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    abort() { this.aborted = true; this.onabort?.(); }
    send(body) {
      this.body = body;
      queueMicrotask(() => script(this));
    }
  }
  return { Xhr, sent };
}

test("the HTTP upload sends the raw file with the §4.2 headers and reports progress", async () => {
  const dto = { sha256: "a".repeat(64), kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: 1000, lufsC: -1600,
    peaksUrl: `/api/jobs/${FAKE_JOB_ID}/assets/${"a".repeat(64)}?part=peaks` };
  const { Xhr, sent } = fakeXhr((xhr) => {
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    xhr.status = 201;
    xhr.responseText = JSON.stringify(dto);
    xhr.onload?.();
  });
  const progress = [];
  const file = { name: "lagu keren.m4a", type: "audio/x-m4a", size: 10 };
  const result = await httpUploadAsset(FAKE_JOB_ID, file, "music", { onProgress: (value) => progress.push(value), xhrFactory: () => new Xhr() });
  assert.deepEqual(result, dto);
  const [xhr] = sent;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, `/api/jobs/${FAKE_JOB_ID}/assets`);
  assert.equal(xhr.headers["Content-Type"], "audio/mp4");
  assert.equal(xhr.headers["X-Asset-Kind"], "music");
  assert.match(xhr.headers["Idempotency-Key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(xhr.headers["X-Asset-Name"], "lagu keren.m4a");
  assert.equal(xhr.body, file);
  assert.deepEqual(progress, [0.5, 1]);
});

test("a name that is not plain ASCII is not sent; errors keep status and code; abort is an AbortError", async () => {
  const failing = fakeXhr((xhr) => {
    xhr.status = 413;
    xhr.responseText = JSON.stringify({ error: { code: "asset_too_large", messageId: "edit.asset_too_large" } });
    xhr.onload?.();
  });
  const file = { name: "lagu ñ.mp3", type: "audio/mpeg", size: 10 };
  await assert.rejects(httpUploadAsset(FAKE_JOB_ID, file, "music", { xhrFactory: () => new failing.Xhr() }),
    (error) => error instanceof UploadError && error.status === 413 && error.code === "asset_too_large");
  assert.equal(failing.sent[0].headers["X-Asset-Name"], undefined);

  const broken = fakeXhr((xhr) => { xhr.onerror?.(); });
  await assert.rejects(httpUploadAsset(FAKE_JOB_ID, file, "music", { xhrFactory: () => new broken.Xhr() }),
    (error) => error instanceof UploadError && error.status === 0 && error.code === "network");

  const hanging = fakeXhr(() => {});
  const controller = new AbortController();
  const pending = httpUploadAsset(FAKE_JOB_ID, file, "music", { signal: controller.signal, xhrFactory: () => new hanging.Xhr() });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(hanging.sent[0].aborted, true);

  await assert.rejects(httpUploadAsset("../etc", file, "music", { xhrFactory: () => new hanging.Xhr() }), /job/);
  await assert.rejects(httpUploadAsset(FAKE_JOB_ID, file, "video", { xhrFactory: () => new hanging.Xhr() }), /kind/);
});

test("the fake editor runtime uploads through the fakes (no request leaves the page); a scenario may replace them", async () => {
  const fakeUpload = await resolveUploadAsset({ __potonginEditor: {} });
  const dto = await fakeUpload(FAKE_JOB_ID, { name: "a.mp3", type: "audio/mpeg", size: 100 }, "music", {});
  assert.equal(dto.kind, "music");
  const scripted = async () => ({ sha256: "b".repeat(64) });
  assert.equal(await resolveUploadAsset({ __potonginEditor: {}, __potonginEditorScenario: { uploadAsset: scripted } }), scripted);
  assert.equal(await resolveUploadAsset({}), httpUploadAsset, "the real editor uses the HTTP route");
  assert.equal(await resolveUploadAsset(undefined), httpUploadAsset);
});
