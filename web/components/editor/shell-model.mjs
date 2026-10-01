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
  other_tab: "Klip ini terbuka di tab lain",
  unsupported_browser: "Pratinjau langsung butuh Chrome/Edge desktop. Anda tetap bisa mengedit dan mengekspor.",
  command_rejected: "Perubahan ini tidak bisa diterapkan",
});

/** The Indonesian message of a code; a detail after ":" is appended in parentheses. */
export function messageFor(code) {
  if (typeof code !== "string" || !code) return "Terjadi kesalahan";
  const separator = code.indexOf(":");
  const base = separator < 0 ? code : code.slice(0, separator);
  const detail = separator < 0 ? "" : code.slice(separator + 1);
  const text = MESSAGES[base] ?? SHELL_TEXT[base];
  if (!text) return `Terjadi kesalahan (${code})`;
  return detail ? `${text} (${detail})` : text;
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

export const EXACT_TEXT = "● Sesuai hasil akhir";
export const LEGACY_UNCHANGED_TEXT = "● Belum diubah: ekspor = klip otomatis";

/**
 * The stage badge (plan §6.1): "● Sesuai hasil akhir" only when every layer is current (or the
 * exact auto render plays); otherwise it names what is pending. Never an approximate claim.
 */
export function badgeView({ status, plan, storePending = [], player = null }) {
  if (status === "loading" || !plan) return { tone: "loading", text: "Membuka klip…", detail: null };
  const mode = player?.mode ?? null;
  if (mode === "unsupported") return { tone: "unsupported", text: SHELL_TEXT.unsupported_browser, detail: null };
  if (mode === "truth") return { tone: "truth", text: "● Frame akhir", detail: "Piksel persis hasil render akhir" };
  if (mode === "auto_render") {
    if (plan.rev0?.exact === true) return { tone: "exact", text: EXACT_TEXT, detail: "Memutar klip otomatis (identik)" };
    return { tone: "pending", text: plateProgress(plan), detail: null };
  }
  if (!mode) return { tone: "pending", text: "Menyiapkan pratinjau…", detail: null };
  const pending = pendingLayers({ plan, storePending, playerCurrent: player?.current });
  // Every layer is current, but the paused player has not drawn the playhead frame yet (its
  // `exact` is false: a seek still decoding): no claim until it is on screen (T2.4, §6.1).
  if (!pending.length && player?.exact === false && !player?.playing) {
    return { tone: "pending", text: "Menyiapkan frame…", detail: null };
  }
  // An unchanged clip exports its auto file itself (R10). When that file is not the new
  // engine's (rev0.exact false: a legacy-engine clip), the stage shows the new engine and the
  // export is the old file, so the badge says so instead of claiming exactness (T2.Z).
  if (!pending.length && plan.rev0 && plan.rev0.exact === false && plan.rev0.autoRenderUrl
    && plan.rev0.planSha256 === plan.planSha256) {
    return { tone: "legacy", text: LEGACY_UNCHANGED_TEXT, detail: "Ubah apa saja agar ekspor sama persis dengan pratinjau ini" };
  }
  if (!pending.length) return { tone: "exact", text: EXACT_TEXT, detail: null };
  return { tone: "pending", text: pending.map((layer) => PENDING_TEXT[layer](plan)).join(" · "), detail: null };
}

/** The badge help popover (plan §6.1 "What 'sesuai' cannot mean"), verbatim. */
export const BADGE_HELP = "Frame, teks, logo dan audio sama dengan hasil akhir. File MP4 akhir dikompresi (H.264, warna 4:2:0), "
  + "jadi tepi teks berwarna sedikit lebih lembut. Tekan 'Frame akhir' untuk melihat piksel persisnya.";

const BADGE_HELP_BY_TONE = Object.freeze({
  exact: BADGE_HELP,
  pending: "Pratinjau belum selesai disiapkan: bagian yang disebut di lencana belum sama dengan hasil akhir. "
    + "Setelah semuanya siap, lencana berubah menjadi '● Sesuai hasil akhir'. Tekan 'Frame akhir' untuk melihat "
    + "piksel persis hasil akhir sekarang juga.",
  legacy: "Klip ini belum diubah, jadi ekspor memakai file klip otomatis apa adanya. File itu dibuat sebelum editor "
    + "dibuka, jadi bisa sedikit berbeda dari pratinjau ini (misalnya posisi video, warna teks). Setelah Anda "
    + "mengubah apa saja, hasil ekspor sama dengan pratinjau ini.",
  truth: "Ini 'Frame akhir': piksel persis hasil render di posisi ini, termasuk kompresi H.264 dan warna 4:2:0. "
    + "Putar atau geser playhead untuk kembali ke pratinjau.",
  unsupported: "Browser ini tidak bisa menampilkan pratinjau langsung, jadi tidak ada yang bisa dibandingkan dengan "
    + "hasil akhir di sini. Anda tetap bisa mengedit dan mengekspor; hasil ekspor tidak terpengaruh.",
  loading: "Klip sedang dibuka. Lencana ini memberi tahu kapan pratinjau sama dengan hasil akhir.",
});

/** The help popover of a badge (§6.1): "sama dengan hasil akhir" only for the exact badge. */
export function badgeHelp(view) {
  return BADGE_HELP_BY_TONE[view?.tone] ?? BADGE_HELP_BY_TONE.loading;
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
 * frame (items without a frame last); plan errors come first as blocking items.
 */
export function checksView({ warnings = [], plan = null } = {}) {
  const fps = plan?.fps;
  const seen = new Set();
  const items = [];
  const add = (issue, severity) => {
    if (!issue || typeof issue.code !== "string") return;
    const f = Number.isInteger(issue.f) ? issue.f : null;
    const key = `${severity}|${issue.code}|${issue.ref ?? ""}|${f ?? ""}|${f === null ? issue.path ?? "" : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, severity, code: issue.code, ref: issue.ref ?? null, f, message: messageFor(issue.code),
      timeText: f === null ? null : formatClock(frameToMs(f, fps)) });
  };
  for (const issue of Array.isArray(plan?.errors) ? plan.errors : []) add(issue, "error");
  for (const issue of Array.isArray(warnings) ? warnings : []) add(issue, "warning");
  for (const issue of Array.isArray(plan?.warnings) ? plan.warnings : []) add(issue, "warning");
  const rank = (item) => (item.severity === "error" ? 0 : 1);
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

/** Informational notices above the stage (Appendix C.6). */
export function noticesView({ doc, playerMode, otherTab }) {
  const notices = [];
  if (doc?.base?.engine?.compiler === "legacy") notices.push({ code: "legacy_engine", text: MESSAGES.legacy_engine, tone: "info" });
  if (otherTab) notices.push({ code: "other_tab", text: SHELL_TEXT.other_tab, tone: "warn" });
  if (playerMode === "unsupported") notices.push({ code: "unsupported_browser", text: SHELL_TEXT.unsupported_browser, tone: "info" });
  return notices;
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
