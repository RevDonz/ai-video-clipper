// The Musik panel's rules (plan §11.3 T3.3, §5.6, §9.2, Appendix B), kept out of the JSX so node
// tests can check them: which files may be uploaded, the Indonesian text of every value and every
// upload failure, the panel's view of the store state, and the Appendix B commands each control
// sends. Pure; no DOM.
import { DUCK_PRESETS, defaultMusicGain } from "../../../lib/editor/commands.mjs";
import { musicItem } from "../../../lib/editor/doc-model.mjs";

/** §9.2 music allowlist, in the order the server lists it. */
export const MUSIC_MIME = Object.freeze(["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"]);
export const MUSIC_MAX_BYTES = 50 * 1024 * 1024;
export const MUSIC_EXTENSIONS = Object.freeze({
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
});
export const MUSIC_ACCEPT = [...MUSIC_MIME, ...Object.keys(MUSIC_EXTENSIONS).map((ext) => `.${ext}`)].join(",");

// Browsers name the same formats differently (Chrome on Linux: audio/x-m4a, audio/x-wav, ...).
const TYPE_ALIASES = Object.freeze({
  "audio/mpeg": "audio/mpeg", "audio/mp3": "audio/mpeg", "audio/mpeg3": "audio/mpeg", "audio/x-mpeg-3": "audio/mpeg",
  "audio/mp4": "audio/mp4", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4",
  "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav",
  "audio/ogg": "audio/ogg", "audio/opus": "audio/ogg", "application/ogg": "audio/ogg",
  "audio/flac": "audio/flac", "audio/x-flac": "audio/flac",
});

/** The allowlisted Content-Type for a picked file, or null when it is not music we accept. */
export function musicFileType(file) {
  const declared = typeof file?.type === "string" ? file.type.split(";")[0].trim().toLowerCase() : "";
  if (declared && TYPE_ALIASES[declared]) return TYPE_ALIASES[declared];
  if (declared && !declared.startsWith("audio/") && declared !== "application/octet-stream") return null;
  const match = /\.([a-z0-9]{2,5})$/i.exec(typeof file?.name === "string" ? file.name : "");
  return match ? MUSIC_EXTENSIONS[match[1].toLowerCase()] ?? null : null;
}

/** "type" | "size" | "empty" | null: what the browser can tell before sending a byte. */
export function musicFileProblem(file) {
  if (!musicFileType(file)) return "type";
  if (!Number.isSafeInteger(file?.size) || file.size <= 0) return "empty";
  if (file.size > MUSIC_MAX_BYTES) return "size";
  return null;
}

export const FILE_PROBLEM_TEXT = Object.freeze({
  type: "Format ini tidak didukung. Pakai MP3, M4A, WAV, OGG atau FLAC.",
  size: "File musik terlalu besar (maksimal 50 MB).",
  empty: "File ini kosong.",
});

const UPLOAD_TEXT = Object.freeze({
  too_large: "File musik terlalu besar (maksimal 50 MB).",
  type: "Format ini tidak didukung. Pakai MP3, M4A, WAV, OGG atau FLAC.",
  too_long: "Musik paling panjang 15 menit. Potong lagunya lalu unggah lagi.",
  rejected: "File ini tidak bisa dibaca sebagai musik. Coba ekspor ulang ke MP3 atau M4A.",
  rate: "Terlalu banyak unggahan dalam semenit. Tunggu sebentar lalu coba lagi.",
  off: "Unggah file belum diaktifkan di server ini.",
  storage: "Penyimpanan server penuh, jadi file tidak bisa disimpan.",
  failed: "Unggahan gagal. Periksa koneksi lalu coba lagi.",
});

/** The Indonesian sentence for a failed upload; null for a cancel (the panel says so itself). */
export function uploadErrorText(error) {
  if (error?.name === "AbortError") return null;
  const status = Number(error?.status) || 0;
  const code = typeof error?.code === "string" ? error.code : "";
  if (/too_long|duration/.test(code)) return UPLOAD_TEXT.too_long;
  if (status === 413 || /too_large|payload_too_large/.test(code)) return UPLOAD_TEXT.too_large;
  if (status === 415 || /type/.test(code)) return UPLOAD_TEXT.type;
  if (status === 429 || code === "rate_limited") return UPLOAD_TEXT.rate;
  if (status === 404 || /disabled/.test(code)) return UPLOAD_TEXT.off;
  if (status === 507 || /storage/.test(code)) return UPLOAD_TEXT.storage;
  if (status === 400 || status === 422 || /rejected|invalid|unreadable/.test(code)) return UPLOAD_TEXT.rejected;
  return UPLOAD_TEXT.failed;
}

// --- numbers as the owner reads them --------------------------------------------------------------

const MINUS = "−";

function decimal(value, digits = 1) {
  return Math.abs(value).toFixed(digits).replace(".", ",");
}

/** centi-dB → "−10,0 dB", "+6,0 dB", "0,0 dB". */
export function formatDb(cdb) {
  const sign = cdb < 0 ? MINUS : cdb > 0 ? "+" : "";
  return `${sign}${decimal(cdb / 100)} dB`;
}

/** centi-LUFS → "−14,0 LUFS". */
export function formatLufs(clufs) {
  return `${clufs < 0 ? MINUS : ""}${decimal(clufs / 100)} LUFS`;
}

/** ms → "1:35" (m:ss, whole seconds, truncated). */
export function formatDuration(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** ms → "0:12,5" (m:ss,tenths, truncated). */
export function formatPosition(ms) {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")},${tenths % 10}`;
}

/** Output frames → "0,5 dtk" (rounded to the tenth). */
export function formatFrames(frames, fps) {
  const [num, den] = fps;
  return `${decimal((frames * den) / num)} dtk`;
}

/** ms → "30 ms" / "1,2 dtk" for the ducking detail sliders. */
export function formatMs(ms) {
  return ms < 1000 ? `${ms} ms` : `${decimal(ms / 1000)} dtk`;
}

/** The centi value after "<code>:" in a plan warning (`peak_reduced:-3.80 dB` → −380), else null. */
export function warningDetail(warnings, code) {
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    const text = typeof warning?.code === "string" ? warning.code : "";
    if (!text.startsWith(`${code}:`)) continue;
    const match = /^(-?)(\d+)\.(\d{2})\b/.exec(text.slice(code.length + 1).trim());
    if (match) return (match[1] ? -1 : 1) * (Number(match[2]) * 100 + Number(match[3]));
  }
  return null;
}

function hasWarning(warnings, code) {
  return (Array.isArray(warnings) ? warnings : []).some((warning) => warning?.code === code || warning?.code?.startsWith(`${code}:`));
}

// --- ducking presets --------------------------------------------------------------------------------

export const DUCK_PRESET_LIST = Object.freeze([
  Object.freeze({ id: "halus", name: "Halus", depthCdb: DUCK_PRESETS.halus }),
  Object.freeze({ id: "sedang", name: "Sedang", depthCdb: DUCK_PRESETS.sedang }),
  Object.freeze({ id: "kuat", name: "Kuat", depthCdb: DUCK_PRESETS.kuat }),
]);

export function duckPresetOf(depthCdb) {
  return DUCK_PRESET_LIST.find((preset) => preset.depthCdb === depthCdb)?.id ?? "custom";
}

/** §3.3 ranges and the slider steps the panel uses (integers in document units). */
export const RANGES = Object.freeze({
  gain_cdb: Object.freeze({ min: -4800, max: 600, step: 10 }),
  source_gain_cdb: Object.freeze({ min: -2400, max: 1200, step: 50 }),
  depth_cdb: Object.freeze({ min: 300, max: 2400, step: 50 }),
  attack_ms: Object.freeze({ min: 5, max: 500, step: 5 }),
  release_ms: Object.freeze({ min: 50, max: 2000, step: 50 }),
  hold_ms: Object.freeze({ min: 0, max: 1000, step: 50 }),
  offset_step_smp: 4800, // 0,1 dtk
});
const DUCK_KEYS = Object.freeze(["depth_cdb", "attack_ms", "release_ms", "hold_ms"]);
const DEFAULT_FADES = Object.freeze({ fade_in_f: 15, fade_out_f: 30 });
const DEFAULT_DUCK = Object.freeze({ on: true, depth_cdb: DUCK_PRESETS.sedang, attack_ms: 30, release_ms: 400, hold_ms: 250 });

function clampInt(value, { min, max }) {
  return Math.min(max, Math.max(min, Math.round(Number(value))));
}

// --- the panel's view of the store ------------------------------------------------------------------

/** Everything the Musik panel shows, derived from `store.getState()`. */
export function musicView(state) {
  const doc = state?.doc ?? null;
  if (!doc) return { loading: true, readOnly: true, hasMusic: false };
  const plan = state.plan ?? null;
  const fps = doc.output.fps;
  const warnings = plan?.warnings ?? [];
  const audioPending = (Array.isArray(state.pending) && state.pending.includes("audio"))
    || Boolean(plan?.audio && plan.audio.state !== "ready");
  const item = musicItem(doc);
  const master = doc.audio.master;
  const on = master.mode === "normalize";
  const clampedAt = audioPending ? null : warningDetail(warnings, "loudness_clamped");
  let achievedText = null;
  if (on) achievedText = audioPending ? "Mengukur…" : clampedAt !== null
    ? `Tercapai ${formatLufs(clampedAt)}: dibatasi agar tidak pecah` : `Tercapai ${formatLufs(master.target_clufs)}`;
  const peakReducedCdb = audioPending ? null : warningDetail(warnings, "peak_reduced");
  const view = {
    loading: false,
    readOnly: state.status !== "ready",
    hasMusic: item !== null,
    audioPending,
    sourceGainCdb: doc.audio.source.gain_cdb,
    sourceGainText: formatDb(doc.audio.source.gain_cdb),
    loudness: { on, targetText: formatLufs(master.target_clufs), measuring: on && audioPending, clamped: clampedAt !== null,
      achievedText, suggest: item !== null && !on },
    peakReducedCdb,
    peakText: peakReducedCdb === null ? null : `Volume diturunkan ${decimal(peakReducedCdb / 100)} dB agar tidak pecah`,
    shorter: hasWarning(warnings, "music_shorter_than_clip"),
  };
  if (!item) return view;
  const payload = item.payload;
  const meta = doc.assets[payload.asset] ?? null;
  const durationMs = meta?.duration_ms ?? 0;
  const fadeMaxF = Math.floor((10000 * fps[0]) / (1000 * fps[1]));
  return {
    ...view,
    item,
    assetId: payload.asset,
    durationMs,
    durationText: formatDuration(durationMs),
    lufsText: meta ? formatLufs(meta.lufs_c) : null,
    gainCdb: payload.gain_cdb,
    gainText: formatDb(payload.gain_cdb),
    defaultGainCdb: meta ? defaultMusicGain(meta.lufs_c) : payload.gain_cdb,
    offsetSmp: payload.src_in_smp,
    offsetText: formatPosition(Math.floor(payload.src_in_smp / 48)),
    maxOffsetSmp: Math.max(0, durationMs * 48 - 1),
    loop: payload.loop,
    fadeMaxF,
    fadeInF: payload.fade_in_f,
    fadeOutF: payload.fade_out_f,
    fadeInText: formatFrames(payload.fade_in_f, fps),
    fadeOutText: formatFrames(payload.fade_out_f, fps),
    duck: { ...payload.duck, preset: duckPresetOf(payload.duck.depth_cdb), depthText: formatDb(-payload.duck.depth_cdb) },
  };
}

// --- commands (Appendix B) ----------------------------------------------------------------------

let replaceSeq = 0;
const one = (type, args, mergeKey) => [{ type, args, mergeKey }];

/** Each control's Appendix B command list, with the merge keys that make a drag one undo step. */
export const musicCommands = Object.freeze({
  add(dto) {
    return one("SetMusic", { asset: dto.sha256, meta: dto }, null);
  },
  /** A new track keeps the user's loop, fades and ducking; its level and start are its own. */
  replace(doc, dto) {
    const previous = musicItem(doc)?.payload ?? null;
    const commands = [{ type: "SetMusic", args: { asset: dto.sha256, meta: dto } }];
    if (previous) {
      if (previous.loop !== true) commands.push({ type: "SetMusicLoop", args: { loop: previous.loop } });
      if (previous.fade_in_f !== DEFAULT_FADES.fade_in_f || previous.fade_out_f !== DEFAULT_FADES.fade_out_f) {
        commands.push({ type: "SetMusicFades", args: { fade_in_f: previous.fade_in_f, fade_out_f: previous.fade_out_f } });
      }
      const duck = previous.duck;
      if (Object.keys(DEFAULT_DUCK).some((key) => duck[key] !== DEFAULT_DUCK[key])) {
        commands.push({ type: "SetDuck", args: { on: duck.on, depth_cdb: duck.depth_cdb, attack_ms: duck.attack_ms,
          release_ms: duck.release_ms, hold_ms: duck.hold_ms } });
      }
    }
    if (commands.length === 1) return one("SetMusic", commands[0].args, null);
    replaceSeq += 1;
    const mergeKey = `tx:music-replace:${replaceSeq}`;
    return commands.map((command) => ({ ...command, mergeKey }));
  },
  remove() {
    return one("RemoveMusic", {}, null);
  },
  gain(cdb) {
    return one("SetMusicGain", { gain_cdb: clampInt(cdb, RANGES.gain_cdb) }, "music:gain");
  },
  offset(smp) {
    return one("SetMusicOffset", { src_in_smp: Math.max(0, Math.round(Number(smp))) }, "music:offset");
  },
  loop(on) {
    return one("SetMusicLoop", { loop: Boolean(on) }, "music:loop");
  },
  fadeIn(frames) {
    return one("SetMusicFades", { fade_in_f: Math.max(0, Math.round(Number(frames))) }, "music:fades");
  },
  fadeOut(frames) {
    return one("SetMusicFades", { fade_out_f: Math.max(0, Math.round(Number(frames))) }, "music:fades");
  },
  duckOn(on) {
    return one("SetDuck", { on: Boolean(on) }, "music:duck");
  },
  duckPreset(id) {
    if (!Object.hasOwn(DUCK_PRESETS, id)) throw new Error(`unknown duck preset: ${id}`);
    return one("SetDuck", { preset: id }, "music:duck");
  },
  duckParam(key, value) {
    if (!DUCK_KEYS.includes(key)) throw new Error(`not a duck setting: ${key}`);
    return one("SetDuck", { [key]: clampInt(value, RANGES[key]) }, "music:duck");
  },
  sourceGain(cdb) {
    return one("SetSourceGain", { gain_cdb: clampInt(cdb, RANGES.source_gain_cdb) }, "audio:source");
  },
  loudness(on) {
    return one("SetLoudness", { mode: on ? "normalize" : "off" }, "audio:master");
  },
});
