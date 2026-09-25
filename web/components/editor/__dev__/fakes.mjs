// Fakes of the Appendix A.2 modules for W2 UI work (plan §11.0 "TDD protocol"), landed by the
// W1 integrator (T1.Z). Specs and components run against these until T2.Z wires the real
// store, player and clients. Read-only for W2 phase B: a missing fake is requested from T2.Z.
//
// Everything here is synthetic and deterministic (no network, no crypto, no DOM); the shapes
// follow plan §3 (document), §3.6 (words), §4.2 (routes) and §4.3 (plan DTO).

export const FAKE_JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
export const FAKE_CLIP_ID = "clip_9b2e41c07d3a5f18e6c2a0b4";
const FPS = [30000, 1001];
const SHA = (seed) => fakeSha256(`fake:${seed}`);

// Appendix B: every command name the real store knows (T2.5 implements them all).
export const COMMANDS = Object.freeze([
  "TrimStart", "TrimEnd", "RemoveWords", "RemoveGap", "RestoreRemoval", "ApplyCleanup",
  "SetColdOpen", "NudgeColdOpen", "EditWordText", "SetWordHidden", "SetWordEmphasis",
  "SetCaptionsEnabled", "SetCaptionPack", "SetCaptionOverride", "SetHookEnabled", "SetHookText",
  "SetHookDuration", "SetHookY", "SetLayout", "SetLogo", "RemoveLogo", "MoveLogo", "ResizeLogo",
  "SetLogoOpacity", "SnapLogo", "SetMusic", "RemoveMusic", "SetMusicGain", "SetMusicOffset",
  "SetMusicLoop", "SetMusicFades", "SetDuck", "SetSourceGain", "SetLoudness", "ResetToSeed",
]);

export class CommandRejected extends Error {
  constructor(code) {
    super(`command rejected: ${code}`);
    this.name = "CommandRejected";
    this.code = code;
  }
}

export class FakeApiError extends Error {
  constructor(status, code, body = {}) {
    super(`fake api ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A deterministic 64-hex digest (FNV-1a based; a stand-in for sha256 in fakes only). */
export function fakeSha256(text) {
  let out = "";
  for (let round = 0; round < 8; round += 1) {
    let hash = 0x811c9dc5 ^ round;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const WORDS = [
  ["Kenapa", 1241930, 1242210], ["sutradara", 1242260, 1242790], ["ditahan", 1242840, 1243300],
  ["di", 1243350, 1243450], ["film", 1243500, 1243800], ["sendiri?", 1243850, 1244400],
  ["Jadi", 1245320, 1245560], ["waktu", 1245610, 1245920], ["itu", 1245970, 1246150],
  ["kita", 1246200, 1246430], ["datang", 1246480, 1246850], ["subuh", 1246900, 1247400],
];

/** A words artifact (`potongin.words/1`, plan §3.6) of 12 words. */
export function fakeWords() {
  const words = WORDS.map(([t, s, e], index) => ({
    id: `w${String(48121 + index).padStart(6, "0")}`, s, e, t, p_pm: 900, u: index < 6 ? "S0011" : "S0012", z: false,
  }));
  const sf = (ms) => Math.floor((ms * FPS[0]) / (1000 * FPS[1]));
  const bounds = [{ after: null, before: words[0].id, sf: sf(words[0].s), tight: false, rms_cdb: null }];
  for (let i = 1; i < words.length; i += 1) {
    bounds.push({ after: words[i - 1].id, before: words[i].id, sf: sf((words[i - 1].e + words[i].s) / 2),
      tight: false, rms_cdb: -5200 });
  }
  bounds.push({ after: words.at(-1).id, before: null, sf: sf(words.at(-1).e) + 1, tight: false, rms_cdb: null });
  return {
    schema: "potongin.words/1", clip_id: FAKE_CLIP_ID, transcript_sha256: SHA("transcript"), fps: FPS,
    window_ms: [1181900, 1370900], words,
    units: [{ id: "S0011", s: 1241930, e: 1244400, q: true }, { id: "S0012", s: 1245320, e: 1247400, q: false }],
    bounds, gaps: [{ after: words[5].id, s: 1244400, e: 1245320, class: "voiced" }], events: [],
    silences: [], scene_cuts_ms: [], peaks: { file: `peaks.${SHA("peaks").slice(0, 16)}.bin`, per_sec: 100, start_ms: 1181900 },
    missing: ["sound_events"],
  };
}

/** A seed document (revision 0, plan §3.2/§3.5 shape): body + hook, karaoke, fit_blur. */
export function fakeDoc() {
  return {
    schema: "clip-edit-v2", schema_minor: 0, clip_id: FAKE_CLIP_ID, revision: 0, parent_sha256: null,
    base: {
      job_id: FAKE_JOB_ID,
      source: { content_sha256: SHA("source"), w: 1280, h: 720, fps_native: FPS, vfr: false, duration_ms: 3901120, has_audio: true },
      origin: { kind: "v3_clip", selection_artifact_sha256: SHA("selection"), selection_version: "selection-v3.0",
        rank_at_seed: 1, hook_unit_id: "S0011", selection_source: "llm" },
      window_ms: [1181900, 1370900], words: { sha256: SHA("words"), count: WORDS.length }, camera: { sha256: null },
      seed_sha256: SHA("seed"), engine: { compiler: "edit-v2/1", render_semantics: 1 },
    },
    output: { w: 720, h: 1280, fps: FPS, sample_rate: 48000, channels: 2 },
    main: { segments: [{ id: "seg_b1", role: "body", in_sf: 37215, out_sf: 37515 }], removals: [], joins: [], cut_fade_ms: 8 },
    captions: {
      enabled: true, pack: { id: "karaoke", v: 1 },
      overrides: { y_e5: 83000, size_pm: 1000, case: "asis", highlight: "#FFE14D", emphasis: "#FF5C8A" }, word_edits: {},
    },
    layout: { default: { mode: "fit_blur", no_face: "center" } },
    tracks: [{ id: "tr_hook", kind: "hook", items: [{
      id: "it_hook", type: "hook", start: { at: "out", f: 0 }, dur_f: 120, transform: { x_e5: 50000, y_e5: 13000 },
      payload: { text: "Kenapa sutradara ditahan di film sendiri?", design: { id: "legacy-bar", v: 1 } }, origin: "seed",
    }] }],
    audio: { source: { gain_cdb: 0 }, master: { mode: "off", target_clufs: -1400, tp_cdb: -100 } },
    assets: {},
    audit: { created_at_ms: 1790000000000, updated_at_ms: 1790000000000, editor: "pipeline/edit-v2/1", last_command: "Seed" },
  };
}

// The fake plan hash covers the content only (revision, parent and audit excluded), like R10.
function planShaOf(doc) {
  return fakeSha256(`plan:${JSON.stringify({ ...doc, revision: null, parent_sha256: null, audit: null })}`);
}

/** The plan DTO (plan §4.3) of a fake document: pieces without removals, 4-word cues. */
export function fakePlan(doc = fakeDoc()) {
  let outF0 = 0;
  const pieces = doc.main.segments.map((segment, i) => {
    const frames = segment.out_sf - segment.in_sf;
    const piece = { i, seg: segment.id, role: segment.role, inSf: segment.in_sf, outSf: segment.out_sf, outF0, frames };
    outF0 += frames;
    return piece;
  });
  const totalFrames = outF0;
  const words = fakeWords().words;
  const toFrame = (ms) => Math.max(0, Math.min(totalFrames,
    Math.round((ms * FPS[0]) / (1000 * FPS[1])) - pieces[0].inSf));
  const cues = [];
  if (doc.captions.enabled) {
    for (let i = 0; i < words.length; i += 4) {
      const group = words.slice(i, i + 4);
      const text = group.map((word) => doc.captions.word_edits[word.id]?.text ?? word.t).join(" ");
      cues.push({ f0: toFrame(group[0].s), f1: toFrame(group.at(-1).e), text: doc.captions.overrides.case === "upper" ? text.toUpperCase() : text,
        words: group.map((word) => word.id) });
    }
  }
  const hookItem = doc.tracks.find((track) => track.kind === "hook")?.items[0] ?? null;
  const docSha256 = fakeSha256(JSON.stringify(doc));
  const planSha256 = planShaOf(doc);
  const assSha256 = fakeSha256(`ass:${JSON.stringify([cues, hookItem?.payload.text ?? null])}`);
  const samples = Math.floor((totalFrames * 48000 * FPS[1]) / FPS[0]);
  return {
    planSha256, docSha256, compiler: "edit-v2/1", renderSemantics: 1, fps: FPS, totalFrames,
    output: { w: doc.output.w, h: doc.output.h }, pieces, cues,
    hook: hookItem ? { f0: 0, f1: Math.min(hookItem.dur_f, totalFrames), lines: [hookItem.payload.text], overflow: false } : null,
    text: { assSha256, ass: "[Script Info]\nScriptType: v4.00+\n", url: `/api/jobs/${FAKE_JOB_ID}/clips/${doc.clip_id}/media/ass/${assSha256.slice(0, 16)}.ass`, fonts: [] },
    plate: { plateKey: fakeSha256(`plate:${doc.layout.default.mode}`), cellFrames: 60, w: doc.output.w, h: doc.output.h, cells: [] },
    logo: null,
    audio: { mixSha256: fakeSha256("mix"), state: "ready", url: null, samples, musicGainPoints: [], speechSpans: [] },
    rev0: { planSha256: planShaOf(fakeDoc()), autoRenderUrl: null, exact: false },
    warnings: [], errors: [],
  };
}

/** `createApiClient` (Appendix A.2) over an in-memory clip; `calls` records every call. */
export function createFakeApiClient({ doc = fakeDoc(), words = fakeWords(), now = () => 1790000200000 } = {}) {
  const seed = clone(doc);
  const seedEtag = fakeSha256(JSON.stringify(seed));
  let current = clone(seed);
  let etag = seedEtag;
  const receipts = new Map();
  const renders = new Map();
  const calls = [];
  const record = (name, args) => { calls.push({ name, args }); };
  const clipDto = () => ({
    clipId: FAKE_CLIP_ID, index: 1, title: "Sutradara ditahan security", hookText: "Kenapa sutradara ditahan?",
    description: "Cerita dari lokasi syuting.", hashtags: ["#film"], durationMs: 10010, engine: "edit-v2/1",
    edit: { state: current.revision === 0 ? "seed" : "edited", revision: current.revision, etag, updatedAtMs: current.audit.updated_at_ms },
    latestRender: null, openable: true, reason: null,
  });
  return {
    calls,
    async clips() { record("clips", []); return { clips: [clipDto()] }; },
    async getEdit({ seed: wantSeed = false } = {}) {
      record("getEdit", [{ seed: wantSeed }]);
      const isSeed = wantSeed || current.revision === 0;
      return { doc: clone(isSeed ? seed : current), etag: isSeed ? seedEtag : etag, seed: isSeed,
        words: { sha256: doc.base.words.sha256, url: `/api/jobs/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/words` },
        readOnly: false, readOnlyReason: null };
    },
    async putEdit(next, { etag: expected, key }) {
      record("putEdit", [next, { etag: expected, key }]);
      if (receipts.has(key)) return clone(receipts.get(key));
      if (expected !== etag || next.revision !== current.revision + 1 || next.parent_sha256 !== etag) {
        throw new FakeApiError(409, "revision_conflict", { current: clone(current), etag });
      }
      current = { ...clone(next), audit: { ...next.audit, updated_at_ms: Math.max(now(), current.audit.updated_at_ms + 1) } };
      etag = fakeSha256(JSON.stringify(current));
      const result = { doc: clone(current), etag, warnings: [] };
      receipts.set(key, result);
      return clone(result);
    },
    async words(url) { record("words", [url]); return clone(words); },
    async prepare({ layout } = {}) {
      record("prepare", [{ layout }]);
      return { words: "ready", camera: layout === "camera" ? "ready" : "not_needed", plate: { state: "ready", ready: 1, total: 1 } };
    },
    async createRender({ editEtag }, key) {
      record("createRender", [{ editEtag }, key]);
      const renderId = `render-${renders.size + 1}`;
      const dto = { renderId, clipId: FAKE_CLIP_ID, state: "queued", stage: "antre", progressPm: 0,
        revision: current.revision, errorCode: null, resultUrl: null, srtUrl: null };
      renders.set(renderId, dto);
      return clone(dto);
    },
    async getRender(renderId) {
      record("getRender", [renderId]);
      if (!renders.has(renderId)) throw new FakeApiError(404, "not_found");
      return clone(renders.get(renderId));
    },
    async cancelRender(renderId) {
      record("cancelRender", [renderId]);
      if (!renders.has(renderId)) throw new FakeApiError(404, "not_found");
      renders.set(renderId, { ...renders.get(renderId), state: "cancelled" });
      return clone(renders.get(renderId));
    },
    async cleanup() { record("cleanup", []); return { items: [] }; },
    async coldOpenSuggestions() { record("coldOpenSuggestions", []); return { candidates: [] }; },
    async aiHooks(aiDoc) {
      record("aiHooks", [aiDoc]);
      return { taskId: "00000000-0000-4000-8000-000000000001", heuristic: [], llm: { state: "disabled" } };
    },
    async aiTask(taskId) { record("aiTask", [taskId]); return { state: "done", suggestions: [], error: null }; },
  };
}

/** `createPreviewClient` (Appendix A.2): plan DTOs and truth frames. */
export function createFakePreviewClient() {
  return {
    async plan(doc) { return fakePlan(doc); },
    async frame(_doc, f) {
      if (!Number.isInteger(f) || f < 0) throw new FakeApiError(422, "range_invalid");
      return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    },
  };
}

/** `createPlayer` (Appendix A.2): no pixels, just the state machine. */
export function createFakePlayer({ onState = () => {}, onFrame = () => {} } = {}) {
  let plan = null;
  let mode = "unsupported";
  let frame = 0;
  let playing = false;
  const current = { text: false, plate: false, audio: false, logo: false };
  const emit = () => onState({ mode, current: { ...current }, frame, playing });
  const clamp = (value) => (plan ? Math.max(0, Math.min(plan.totalFrames - 1, value)) : 0);
  return {
    load(dto) { plan = dto; mode = "live"; frame = clamp(frame); Object.assign(current, { text: true, plate: true, audio: true, logo: true }); emit(); },
    async play() { playing = true; emit(); },
    pause() { playing = false; emit(); },
    async seek(target) { frame = clamp(target); if (mode === "truth") mode = "live"; onFrame(frame); emit(); },
    async step(delta) { frame = clamp(frame + delta); onFrame(frame); emit(); },
    async showTruthFrame(target) { frame = clamp(target); mode = "truth"; emit(); },
    state() { return { mode, current: { ...current }, frame }; },
    destroy() { playing = false; plan = null; mode = "unsupported"; },
  };
}

const FAKE_REDUCERS = {
  SetCaptionsEnabled: (doc, { on }) => { doc.captions.enabled = Boolean(on); },
  SetCaptionPack: (doc, { id }) => { doc.captions.pack = { id, v: 1 }; },
  SetCaptionOverride: (doc, { key, value }) => { doc.captions.overrides[key] = value; },
  SetLayout: (doc, { mode }) => { doc.layout.default.mode = mode; },
  SetHookText: (doc, { text }) => { doc.tracks.find((track) => track.kind === "hook").items[0].payload.text = text; },
  SetSourceGain: (doc, { gain_cdb: gain }) => { doc.audio.source.gain_cdb = gain; },
};

/**
 * `createEditorStore` (Appendix A.2) over the fake API. Commands of Appendix B are accepted;
 * the ones in FAKE_REDUCERS change the document, the others only record the command. Unknown
 * names throw `CommandRejected("unknown_command")`. `ready` resolves once the clip is loaded.
 */
export function createFakeEditorStore({ jobId = FAKE_JOB_ID, clipId = FAKE_CLIP_ID, api = createFakeApiClient(),
  previewClient = createFakePreviewClient(), now = () => Date.now() } = {}) {
  const listeners = new Set();
  const past = [];
  const future = [];
  let state = { status: "loading", jobId, clipId, doc: null, seed: null, words: null, etag: null, save: "saved",
    savedAtMs: null, canUndo: false, canRedo: false, plan: null, pending: [], warnings: [], selection: null,
    commands: [] };
  const set = (patch) => {
    state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
    for (const listener of [...listeners]) listener(state);
  };
  const ready = (async () => {
    const edit = await api.getEdit({ seed: false });
    const words = await api.words(edit.words.url);
    set({ status: "ready", doc: edit.doc, seed: edit.seed ? clone(edit.doc) : null, words, etag: edit.etag,
      plan: await previewClient.plan(edit.doc), savedAtMs: now() });
  })();
  return {
    ready,
    getState: () => state,
    dispatch(type, args = {}, { mergeKey = null } = {}) {
      if (!COMMANDS.includes(type)) throw new CommandRejected("unknown_command");
      if (state.status !== "ready") throw new CommandRejected("not_ready");
      const next = clone(state.doc);
      FAKE_REDUCERS[type]?.(next, args);
      next.audit.last_command = type;
      past.push(state.doc);
      future.length = 0;
      set({ doc: next, save: "dirty", commands: [...state.commands, { type, args, mergeKey }] });
      return next;
    },
    undo() {
      if (!past.length) return;
      future.push(state.doc);
      set({ doc: past.pop(), save: "dirty" });
    },
    redo() {
      if (!future.length) return;
      past.push(state.doc);
      set({ doc: future.pop(), save: "dirty" });
    },
    async flush() {
      if (state.save !== "dirty") return;
      set({ save: "saving" });
      set({ save: "saved", savedAtMs: now(), plan: await previewClient.plan(state.doc) });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { listeners.clear(); },
  };
}
