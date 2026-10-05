// Presentation rules of the Editor V3 shell (T2.6): the stage badge of plan §6.1, the save state
// and the copy of Appendix C.1/C.6, the "Perlu dicek" list (§3.7 warnings), content identity for
// R10 and the page gate. Pure functions, no DOM; client- and server-safe.

// The Indonesian messages the shell shows, copied from src/ai_clipper/edit_v2/errors.py
// (`_MESSAGES`); web/tests/editor-shell-model.test.mjs fails if one drifts.
export const MESSAGES = Object.freeze({
  // Semantic errors (a plan that carries errors blocks export).
  outside_window: "Potongan berada di luar jendela analisis klip (±60 detik)",
  range_invalid: "Ada nilai yang tidak valid atau di luar rentang yang diizinkan",
  cold_open_invalid: "Cold open tidak valid: harus 0,5–8 detik, di urutan pertama, dan tidak mengulang pembuka klip",
  duration_out_of_bounds: "Durasi klip harus antara 3 detik dan 5 menit",
  removal_outside_segment: "Bagian yang dihapus berada di luar potongannya",
  removal_overlap: "Bagian yang dihapus saling tumpang tindih",
  unknown_word: "Kata yang dirujuk tidak ada di transkrip klip",
  asset_missing: "File logo atau musik tidak ditemukan; unggah ulang",
  pack_unknown: "Gaya caption tidak dikenal",
  op_disabled: "Fitur ini belum tersedia di editor",
  item_out_of_frame: "Logo keluar dari bingkai video",
  // Warnings ("Perlu dicek").
  tight_cut: "Potongan sangat rapat dengan kata di sebelahnya; dengarkan hasilnya",
  laughter_cut: "Potongan memotong tawa",
  hook_overflow: "Teks hook terlalu panjang dan akan dipendekkan dengan \"…\"",
  glyph_unsupported: "Ada karakter yang tidak tersedia di font caption dan tidak akan tampil",
  no_face: "Tidak ada wajah terdeteksi di bagian ini; video dipusatkan",
  unsafe_zone: "Caption, hook, atau logo masuk ke area tombol TikTok",
  loudness_clamped: "Target kenyaringan tidak tercapai tanpa pecah; volume dibatasi",
  peak_reduced: "Volume diturunkan agar audio tidak pecah",
  music_shorter_than_clip: "Musik lebih pendek dari klip dan tidak diulang",
  // Protocol.
  schema_too_new: "Dokumen ini dibuat versi editor yang lebih baru; muat ulang editor",
  revision_conflict: "Klip ini diubah di tab lain",
  not_found: "Data tidak ditemukan",
  analysis_missing: "Analisis klip belum siap",
  internal_error: "Terjadi kesalahan di server",
  // Render and verification.
  render_failed: "Render gagal",
  render_timeout: "Render melebihi batas waktu",
  render_stalled: "Render berhenti merespons",
  verification_failed: "Hasil render tidak lolos pemeriksaan mutu",
  cancelled: "Render dibatalkan",
  auto_file_unavailable: "File klip otomatis tidak tersedia; klip dirender ulang",
  engine_fallback: "Klip dirender dengan cara cadangan",
  // Answered by the Node routes (errors.ROUTE_CODES; T2.Z).
  invalid_request: "Permintaan tidak valid",
  csrf_rejected: "Permintaan ditolak karena tidak berasal dari halaman ini; muat ulang halaman",
  rate_limited: "Terlalu banyak permintaan; tunggu sebentar lalu coba lagi",
  backend_unavailable: "Layanan editor sedang tidak tersedia; coba lagi sebentar lagi",
  superseded: "Permintaan ini digantikan oleh perubahan yang lebih baru",
  editor_disabled: "Editor belum diaktifkan",
  precondition_required: "Versi dokumen tidak disertakan; muat ulang editor",
  payload_too_large: "Permintaan terlalu besar",
  storage_quota_exhausted: "Penyimpanan server tidak cukup",
  storage_free_space_low: "Penyimpanan server tidak cukup",
  storage_admission_unavailable: "Pemeriksaan penyimpanan tidak tersedia",
  render_finished: "Render sudah selesai sehingga tidak bisa dibatalkan",
  not_cancellable: "Render ini tidak bisa dibatalkan",
  // Clip reasons (Appendix C.6).
  needs_prepare: "Klip perlu disiapkan dulu",
  source_missing: "Video sumber sudah tidak ada",
  source_unreadable: "Video sumber tidak bisa dibaca; proses ulang videonya",
  selection_unreadable: "Hasil seleksi tidak terbaca",
  transcript_missing: "Transkrip tidak ditemukan",
  analysis_incomplete: "Analisis job belum selesai",
  not_v3: "Klip dari job ini tidak bisa diedit; proses ulang videonya",
  // Read-only reason and notices.
  transcript_changed: "Transkrip berubah sejak klip diedit",
  legacy_engine: "Klip otomatis ini dibuat sebelum editor dibuka; setelah klip diubah, tampilan teks hasil ekspor bisa sedikit berbeda",
  markers_unavailable: "Penanda tawa/jeda tidak tersedia untuk job ini",
});

// Shell-only copy (no Python code carries these).
const SHELL_TEXT = Object.freeze({
  other_tab: "Terbuka di tab lain",
  unsupported_browser: "Pratinjau langsung butuh Chrome/Edge desktop. Anda tetap bisa mengedit dan mengekspor.",
  command_rejected: "Perubahan ini tidak bisa diterapkan",
});

/** The top bar's chip while the clip is open in another tab (Mode Cepat spec §5.1, §5.3). */
export const OTHER_TAB_TEXT = SHELL_TEXT.other_tab;

// A measured value in a code's detail ("-3.80 dB", "-16.30 LUFS"): sign, number, unit.
const MEASURE = /^([+-]?)(\d+(?:\.\d+)?)(?: ([A-Za-z]+))?$/;

/** "-3.80 dB" → "−3,8 dB" (one decimal, comma, true minus), as the Musik panel writes it. */
function localDetail(detail) {
  const match = MEASURE.exec(detail);
  if (!match) return detail;
  const [, sign, number, unit] = match;
  const digits = number.includes(".") ? Number(number).toFixed(1).replace(".", ",") : number;
  return `${sign === "-" ? "−" : sign}${digits}${unit ? ` ${unit}` : ""}`;
}

/** The Indonesian message of a code; a detail after ":" is appended in parentheses. */
export function messageFor(code) {
  if (typeof code !== "string" || !code) return "Terjadi kesalahan";
  const separator = code.indexOf(":");
  const base = separator < 0 ? code : code.slice(0, separator);
  const detail = separator < 0 ? "" : code.slice(separator + 1);
  const text = MESSAGES[base] ?? SHELL_TEXT[base];
  if (!text) return `Terjadi kesalahan (${code})`;
  return detail ? `${text} (${localDetail(detail)})` : text;
}

// unsafe_zone names what is in the TikTok zone, from the warning's JSON pointer (plan §5.9 G5).
const ZONE_TEXT = Object.freeze([
  [/^\/captions\//, "Caption masuk ke area tombol TikTok"],
  [/^\/tracks\/\d+\/items\/\d+\/transform\/y_e5$/, "Hook masuk ke area tombol TikTok"],
  [/^\/tracks\/\d+\/items\/\d+\/transform$/, "Logo masuk ke area tombol TikTok"],
]);

function checkMessage(issue) {
  if (issue.code === "unsafe_zone" && typeof issue.path === "string") {
    const found = ZONE_TEXT.find(([pattern]) => pattern.test(issue.path));
    if (found) return found[1];
  }
  return messageFor(issue.code);
}

// Owner decision K5 (kept in W4): the seed keeps the auto clip's caption spot (83 % down, inside
// the zone that starts at 78 %), so an unchanged clip exports the auto file (R10). At that spot the
// zone warning is a note: it informs, and export does not ask for a tick. It names no tab: Mode
// Cepat has none (Mode Cepat spec §5.3).
export const CAPTION_SPOT_NOTE = "Caption di posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser caption ke atas.";

/** Whether the caption sits where the auto clip put it (the seed's bottom anchor). */
export function captionAtSeedSpot(doc, seed) {
  const at = doc?.captions?.overrides?.y_e5;
  return Number.isInteger(at) && at === seed?.captions?.overrides?.y_e5;
}

function isCaptionZone(issue) {
  return issue.code === "unsafe_zone" && typeof issue.path === "string" && issue.path.startsWith("/captions/");
}

/** The checks that need the user: errors and warnings, not notes. */
export function actionableChecks(checks) {
  return (Array.isArray(checks) ? checks : []).filter((check) => check.severity !== "info");
}

/**
 * The toast text of a command rejected by the store (Appendix B: `CommandRejected(code)` carries
 * a user message): its `userMessage`, else the message of its code, else a generic line.
 */
export function rejectionText(error) {
  if (typeof error?.userMessage === "string" && error.userMessage.trim()) return error.userMessage;
  const code = typeof error?.code === "string" ? error.code.split(":")[0] : "";
  return MESSAGES[code] ?? SHELL_TEXT.command_rejected;
}

function fpsParts(fps) {
  const [num, den] = Array.isArray(fps) ? fps : [30, 1];
  return [Number(num) || 30, Number(den) || 1];
}

/** Start time of output frame n in whole milliseconds: ⌊n·1000·den/num⌋. */
export function frameToMs(frame, fps) {
  const [num, den] = fpsParts(fps);
  return Math.floor((Math.max(0, Math.trunc(frame)) * 1000 * den) / num);
}

/** Source-grid frame → ms of its start (same rule as output frames). */
export const sfToMs = frameToMs;

/** "00:12,3" (mm:ss,tenths; "h:mm:ss,t" from one hour), truncating to the tenth. */
export function formatClock(ms) {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const seconds = Math.floor(tenths / 10);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${pad(minutes)}:${pad(seconds % 60)},${tenths % 10}`;
  return hours ? `${hours}:${clock}` : clock;
}

/** "1,4 dtk" (tenths, truncated). */
export function formatSeconds(ms) {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  return `${Math.floor(tenths / 10)},${tenths % 10} dtk`;
}

/** The top bar's save state (Appendix C.1, C.6). */
export function saveStatusView({ save, savedAtMs = null } = {}, nowMs = Date.now()) {
  switch (save) {
    case "saving": return { text: "Menyimpan…", tone: "busy", retry: false };
    case "dirty": return { text: "Belum tersimpan", tone: "warn", retry: false };
    case "conflict": return { text: "Konflik", tone: "danger", retry: false };
    case "error": return { text: "Gagal menyimpan; perubahan aman di browser ini", tone: "danger", retry: true };
    default: {
      if (!Number.isFinite(savedAtMs)) return { text: "Tersimpan", tone: "ok", retry: false };
      const seconds = Math.max(0, Math.floor((nowMs - savedAtMs) / 1000));
      let ago = "baru saja";
      if (seconds >= 3600) ago = `${Math.floor(seconds / 3600)} jam lalu`;
      else if (seconds >= 60) ago = `${Math.floor(seconds / 60)} mnt lalu`;
      else if (seconds >= 2) ago = `${seconds} dtk lalu`;
      return { text: `Tersimpan · ${ago}`, tone: "ok", retry: false };
    }
  }
}

export const LAYERS = Object.freeze(["text", "plate", "audio", "logo"]);

/** Layers that are not current: pending in the store, or reported stale by the player. */
export function pendingLayers({ plan, storePending = [], playerCurrent = {} }) {
  return LAYERS.filter((layer) => {
    if (layer === "logo" && !plan?.logo) return false;
    return storePending.includes(layer) || playerCurrent?.[layer] === false;
  });
}

function plateProgress(plan) {
  const cells = Array.isArray(plan?.plate?.cells) ? plan.plate.cells : [];
  const ready = cells.filter((cell) => cell?.state === "ready").length;
  return cells.length ? `Menyiapkan video (${ready}/${cells.length})…` : "Menyiapkan video…";
}

const PENDING_TEXT = {
  text: () => "Memperbarui teks…",
  audio: () => "Menyiapkan audio…",
  plate: plateProgress,
  logo: () => "Memperbarui logo…",
};

export const EXACT_TEXT = "Sesuai hasil akhir";

/**
 * The stage status (plan §6.1; at the stage's top left since Mode Cepat, spec §5.2): "Sesuai
 * hasil akhir" only when every layer is current (or the exact auto render plays); otherwise it
 * names what is pending. Never an approximate claim.
 */
export function badgeView({ status, plan, storePending = [], player = null }) {
  if (status === "loading" || !plan) return { tone: "loading", text: "Membuka klip…", detail: null };
  const mode = player?.mode ?? null;
  if (mode === "unsupported") return { tone: "unsupported", text: SHELL_TEXT.unsupported_browser, detail: null };
  if (mode === "truth") return { tone: "truth", text: "Frame akhir", detail: "Piksel persis hasil render akhir" };
  if (mode === "auto_render") {
    if (plan.rev0?.exact === true) return { tone: "exact", text: EXACT_TEXT, detail: "Memutar klip otomatis (identik)" };
    return { tone: "pending", text: plateProgress(plan), detail: null };
  }
  if (!mode) return { tone: "pending", text: "Menyiapkan pratinjau…", detail: null };
  const pending = pendingLayers({ plan, storePending, playerCurrent: player?.current });
  // Every layer is current, but the paused player has not drawn the playhead frame yet (its
  // `exact` is false: a seek still decoding): no claim until it is on screen (T2.4, §6.1). Once
  // the player gave up on that frame (every attempt failed or ran out of time), the badge says so.
  if (!pending.length && player?.exact === false && !player?.playing) {
    if (player?.frameError) {
      return { tone: "failed", text: "Frame gagal dimuat", detail: "Putar atau geser playhead untuk mencoba lagi" };
    }
    return { tone: "pending", text: "Menyiapkan frame…", detail: null };
  }
  // An unchanged clip exports its auto file itself (R10). When that file is not the new
  // engine's (rev0.exact false: a legacy-engine clip), the stage shows the new engine and the
  // export is the old file, so no exactness is claimed (T2.Z). The status stays empty: the "?"
  // help explains it (Mode Cepat spec §5.3, the owner's brief removed the on-screen line).
  if (!pending.length && plan.rev0 && plan.rev0.exact === false && plan.rev0.autoRenderUrl
    && plan.rev0.planSha256 === plan.planSha256) {
    return { tone: "legacy", text: "", detail: null };
  }
  if (!pending.length) return { tone: "exact", text: EXACT_TEXT, detail: null };
  return { tone: "pending", text: pending.map((layer) => PENDING_TEXT[layer](plan)).join(" · "), detail: null };
}

/** The badge help popover (plan §6.1 "What 'sesuai' cannot mean"), verbatim. */
export const BADGE_HELP = "Frame, teks, logo dan audio sama dengan hasil akhir. File MP4 akhir dikompresi (H.264, warna 4:2:0), "
  + "jadi tepi teks berwarna sedikit lebih lembut. Tekan 'Frame akhir' untuk melihat piksel persisnya.";

const BADGE_HELP_BY_TONE = Object.freeze({
  exact: BADGE_HELP,
  pending: "Pratinjau belum selesai disiapkan: bagian yang disebut di status belum sama dengan hasil akhir. "
    + "Setelah semuanya siap, status berubah menjadi 'Sesuai hasil akhir'. Tekan 'Frame akhir' untuk melihat "
    + "piksel persis hasil akhir sekarang juga.",
  legacy: "Klip ini belum diubah, jadi ekspor memakai file klip otomatis apa adanya. File itu dibuat sebelum editor "
    + "dibuka, jadi bisa sedikit berbeda dari pratinjau ini (misalnya posisi video, warna teks). Setelah Anda "
    + "mengubah apa saja, hasil ekspor sama dengan pratinjau ini.",
  truth: "Ini 'Frame akhir': piksel persis hasil render di posisi ini, termasuk kompresi H.264 dan warna 4:2:0. "
    + "Putar atau geser playhead untuk kembali ke pratinjau.",
  unsupported: "Browser ini tidak bisa menampilkan pratinjau langsung, jadi tidak ada yang bisa dibandingkan dengan "
    + "hasil akhir di sini. Anda tetap bisa mengedit dan mengekspor; hasil ekspor tidak terpengaruh.",
  loading: "Klip sedang dibuka. Status ini memberi tahu kapan pratinjau sama dengan hasil akhir.",
  failed: "Frame di posisi playhead belum tampil, juga setelah dicoba ulang: browser gagal menyiapkan gambar atau "
    + "teksnya, atau prosesnya terlalu lama. Kalau akhirnya selesai, frame langsung tampil. Putar atau geser "
    + "playhead untuk mencoba lagi, atau tekan 'Frame akhir' untuk melihat piksel persis hasil akhir dari server.",
});

/** The help popover of a badge (§6.1): "sama dengan hasil akhir" only for the exact badge. */
export function badgeHelp(view) {
  return BADGE_HELP_BY_TONE[view?.tone] ?? BADGE_HELP_BY_TONE.loading;
}

/**
 * What the shell keeps of a player state (EditorApp's onState): mode, layers, playing, exact and
 * whether the player gave up on the playhead frame (a plate error, or any error that names the
 * paused frame: its text). An unchanged view keeps its identity, so a new frame alone does not
 * re-render the shell.
 */
export function playerView(previous, next) {
  const view = {
    mode: next.mode ?? null,
    current: { ...(next.current ?? {}) },
    playing: typeof next.playing === "boolean" ? next.playing : previous?.playing ?? false,
    exact: typeof next.exact === "boolean" ? next.exact : undefined,
    frameError: next.error?.layer === "plate" || Number.isInteger(next.error?.frame),
  };
  return previous && previous.mode === view.mode && previous.playing === view.playing
    && previous.exact === view.exact && previous.frameError === view.frameError
    && JSON.stringify(previous.current) === JSON.stringify(view.current) ? previous : view;
}

/**
 * The revision an export is made from: the store's last saved revision (`state.revision`); the
 * store's `doc` keeps the revision it was loaded at (T2.5), so it is only the fallback.
 */
export function exportRevision(state) {
  if (Number.isInteger(state?.revision)) return state.revision;
  return Number.isInteger(state?.doc?.revision) ? state.doc.revision : 0;
}

/**
 * The waves whose panels and lanes the app shows. The registries list the next wave's entries
 * with placeholder files before it lands (plan §11.0); the owner's beta hides them until the
 * wave's integrator adds its name here. The fakes (e2e specs, W3 development) show every entry.
 */
export const LIVE_WAVES = Object.freeze(["W1", "W2", "W3"]);

export function liveEntries(entries, runtimeKind, liveWaves = LIVE_WAVES) {
  if (runtimeKind === "fake") return entries;
  return entries.filter((entry) => liveWaves.includes(entry.wave));
}

/**
 * "Perlu dicek": store warnings (save results) and plan warnings, deduplicated, sorted by
 * frame (items without a frame last); plan errors come first as blocking items, notes last.
 * With the document and its seed, the caption's zone warning at the auto clip's spot is a note
 * (severity "info", K5).
 */
export function checksView({ warnings = [], plan = null, doc = null, seed = null } = {}) {
  const fps = plan?.fps;
  const seen = new Set();
  const items = [];
  const captionNote = captionAtSeedSpot(doc, seed);
  const add = (issue, given) => {
    if (!issue || typeof issue.code !== "string") return;
    const note = given === "warning" && captionNote && isCaptionZone(issue);
    const severity = note ? "info" : given;
    const f = Number.isInteger(issue.f) ? issue.f : null;
    const key = `${severity}|${issue.code}|${issue.ref ?? ""}|${f ?? ""}|${f === null ? issue.path ?? "" : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, severity, code: issue.code, ref: issue.ref ?? null, f, message: note ? CAPTION_SPOT_NOTE : checkMessage(issue),
      timeText: f === null ? null : formatClock(frameToMs(f, fps)) });
  };
  for (const issue of Array.isArray(plan?.errors) ? plan.errors : []) add(issue, "error");
  for (const issue of Array.isArray(warnings) ? warnings : []) add(issue, "warning");
  for (const issue of Array.isArray(plan?.warnings) ? plan.warnings : []) add(issue, "warning");
  const rank = (item) => ({ error: 0, warning: 1 })[item.severity] ?? 2;
  return items.sort((a, b) => rank(a) - rank(b) || (a.f ?? Infinity) - (b.f ?? Infinity));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function content(doc) {
  const { revision: _revision, parent_sha256: _parent, audit: _audit, ...rest } = doc;
  return canonical(rest);
}

/** R10 content identity: equal canonical bytes without revision, parent_sha256 and audit. */
export function contentEqualsSeed(doc, seed) {
  if (!doc || !seed || typeof doc !== "object" || typeof seed !== "object") return false;
  return content(doc) === content(seed);
}

/** Whether an export of this document returns the auto clip's own file (R10). */
export function exportMatchesSeed({ plan, doc, seed }) {
  if (doc && seed) return contentEqualsSeed(doc, seed);
  return Boolean(plan?.planSha256) && plan.planSha256 === plan?.rev0?.planSha256;
}

/**
 * The parts of the per-part conflict dialog, `[{id, label}]`, from the store's
 * `state.conflict`: the real store's `{groups: [{id, label, parts, mine, theirs}], error}` (T2.5)
 * or the older `{parts: [{id, label}]}` shape of the T2.6 specs.
 */
export function conflictParts(conflict) {
  const list = Array.isArray(conflict?.groups) ? conflict.groups : Array.isArray(conflict?.parts) ? conflict.parts : [];
  return list.filter((part) => part && typeof part.id === "string" && typeof part.label === "string")
    .map(({ id, label }) => ({ id, label }));
}

/**
 * Informational notices above the stage (Appendix C.6). Since Mode Cepat (spec §5.3) the legacy
 * engine has none (its "?" help says it; provenance stays in the document and the logs), and the
 * other tab is the top bar's chip (OTHER_TAB_TEXT). The arguments stay for the codes still here.
 */
export function noticesView({ playerMode } = {}) {
  const notices = [];
  if (playerMode === "unsupported") notices.push({ code: "unsupported_browser", text: SHELL_TEXT.unsupported_browser, tone: "info" });
  return notices;
}

/**
 * The word I or O trims to from the transcript's selection (`selectionStoreFor(clipId)`, a range
 * of indices into `words.words`): its first word for "start", its last for "end", as the toolbar's
 * "Mulai di sini" and "Akhiri di sini" do; null without a selection (the shell then uses the
 * word under the playhead).
 */
export function selectionTrimWord({ selection, words, edge }) {
  const list = Array.isArray(words?.words) ? words.words : [];
  if (!selection || !(selection.anchor >= 0) || !(selection.focus >= 0) || !list.length) return null;
  const first = Math.min(selection.anchor, selection.focus);
  if (first >= list.length) return null;
  const last = Math.min(Math.max(selection.anchor, selection.focus), list.length - 1);
  const word = list[edge === "start" ? first : last];
  return typeof word?.id === "string" ? word.id : null;
}

/**
 * The editor page gate: "off" (404) unless POTONGIN_EDITOR_V3=on; "fake" when the dev/CI flag
 * POTONGIN_EDITOR_FAKES=1 is also set (the T1.Z fakes, for the e2e specs); otherwise "real".
 *
 * POTONGIN_EDITOR_FAKES is a CI/development switch only (docs/editor/CONTRACTS.md §5.18): the
 * shell specs run it on a production build (`next start`), so it is not tied to NODE_ENV, and
 * compose.yaml never passes it to the app container. The fake runtime makes no API call: a
 * misconfigured server would show the fake clip, never a job's data.
 */
export function editorPageMode(env = {}) {
  if (env.POTONGIN_EDITOR_V3 !== "on") return "off";
  return env.POTONGIN_EDITOR_FAKES === "1" ? "fake" : "real";
}

/**
 * A URL from a DTO (auto render, export result, SRT) used as a link or media source: only a
 * same-origin API path is accepted, so a bad value can never become a scheme or another host.
 */
export function safeApiHref(value) {
  if (typeof value !== "string" || !value.startsWith("/api/") || value.includes("\\")
    || /[\u0000-\u001f\u007f\s]/.test(value)) return null;
  return value;
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIP_ID = /^clip_[0-9a-f]{24}$/;

/** The job id (UUID) and clip id (plan §3.1) of the editor route, checked before anything runs. */
export function validEditorIds(jobId, clipId) {
  return typeof jobId === "string" && typeof clipId === "string" && JOB_ID.test(jobId) && CLIP_ID.test(clipId);
}

export function isClipId(value) {
  return typeof value === "string" && CLIP_ID.test(value);
}
