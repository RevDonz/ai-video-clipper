const CONTROL_OR_SURROGATE = /[\p{Cc}\p{Cs}]/u;
const COLOR = /^#[0-9A-F]{6}$/;
const ETAG = /^"([0-9a-f]{64})"$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CANDIDATE_ID = /^cand_[0-9a-f]{64}$/;
const CUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FONTS = new Set(["Inter", "Noto Sans", "DejaVu Sans", "sans-serif"]);
const PRESETS = new Set(["clean", "bold-keyword", "karaoke", "podcast", "minimal"]);
const POSITIONS = new Set(["top", "center", "bottom"]);

function scalarText(value, maximum, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.length > 0)
    && Array.from(value).length <= maximum && value.normalize("NFC") === value
    && !CONTROL_OR_SURROGATE.test(value);
}

function boundedNumber(value, low, high) {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function integer(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high;
}

export function validateEditorDraft(draft) {
  const errors = {};
  const visual = draft?.visual || {};
  const style = draft?.caption_style || {};
  const audio = draft?.audio || {};
  if (!new Set(["fit-blur", "center-crop"]).has(visual.render_mode)) errors["visual.render_mode"] = "Pilih mode preview yang didukung.";
  if (visual.render_mode === "center-crop") {
    if (!boundedNumber(visual.focal_x, 0, 1) || !boundedNumber(visual.focal_y, 0, 1)) errors["visual.focal"] = "Titik fokus harus berada di dalam frame.";
  } else if (visual.focal_x !== null || visual.focal_y !== null) errors["visual.focal"] = "Fit-blur tidak memakai titik fokus.";
  const safe = visual.safe_area || {};
  for (const edge of ["top", "right", "bottom", "left"]) if (!boundedNumber(safe[edge], 0, .25)) errors[`visual.safe_area.${edge}`] = "Margin aman harus 0–25%.";

  if (!PRESETS.has(style.preset)) errors["caption_style.preset"] = "Preset caption tidak didukung.";
  if (!POSITIONS.has(style.position)) errors["caption_style.position"] = "Posisi caption tidak didukung.";
  if (!FONTS.has(style.font_family)) errors["caption_style.font_family"] = "Font tidak tersedia di renderer.";
  if (!integer(style.font_size, 18, 96)) errors["caption_style.font_size"] = "Ukuran font harus 18–96.";
  for (const key of ["color", "keyword_color", "background_color"]) if (!COLOR.test(style[key] || "")) errors[`caption_style.${key}`] = "Gunakan warna #RRGGBB huruf besar.";
  if (!boundedNumber(style.background_opacity, 0, 1)) errors["caption_style.background_opacity"] = "Opasitas harus 0–1.";
  if (!integer(style.max_chars_per_line, 8, 80)) errors["caption_style.max_chars_per_line"] = "Panjang baris harus 8–80 karakter.";
  if (!integer(style.max_lines, 1, 3)) errors["caption_style.max_lines"] = "Jumlah baris harus 1–3.";
  if (style.emphasis !== "none") errors["caption_style.emphasis"] = "Penekanan kata kunci belum didukung editor ini.";

  if (!Array.isArray(draft?.captions) || draft.captions.length > 1000) errors.captions = "Daftar caption tidak valid.";
  else draft.captions.forEach((cue, index) => {
    if (!scalarText(cue?.text, 500)) errors[`captions.${index}.text`] = "Caption wajib 1–500 karakter Unicode tanpa karakter kontrol.";
  });

  if (!boundedNumber(audio.gain_db, -24, 12)) errors["audio.gain_db"] = "Gain audio harus -24 sampai +12 dB.";
  if (typeof audio.normalize !== "boolean") errors["audio.normalize"] = "Normalisasi audio tidak valid.";

  const overlays = Array.isArray(draft?.overlays) ? draft.overlays : [];
  const title = overlays.find((item) => item?.kind === "title");
  if (title && !scalarText(title.text, 100)) errors["title.text"] = "Judul wajib 1–100 karakter Unicode tanpa karakter kontrol.";
  if (title && (!boundedNumber(title.x, safe.left, 1 - safe.right)
    || !boundedNumber(title.y, safe.top, 1 - safe.bottom)
    || !boundedNumber(title.max_width, .1, 1)
    || title.x - title.max_width / 2 < safe.left
    || title.x + title.max_width / 2 > 1 - safe.right)) errors["title.position"] = "Judul dan lebarnya harus berada di dalam margin aman.";
  const logo = overlays.find((item) => item?.kind === "logo");
  if (logo) {
    const verticalHalf = Number(logo.scale) * 720 / 1280 / 2;
    if (!/^assets\/[0-9a-f]{64}\.(?:png|jpg|jpeg|webp)$/.test(logo.asset || "")
      || !boundedNumber(logo.opacity, 0, 1) || !boundedNumber(logo.scale, .01, .5)
      || logo.x - logo.scale / 2 < safe.left || logo.x + logo.scale / 2 > 1 - safe.right
      || logo.y - verticalHalf < safe.top || logo.y + verticalHalf > 1 - safe.bottom) errors.logo = "Logo tersimpan harus tetap berada di dalam margin aman.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

function exactObject(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function addCanonicalError(errors, key, valid, message = "Respons dokumen tidak mengikuti kontrak kanonis.") {
  if (!valid) errors[key] = message;
}

/** Strictly validates the complete canonical document used on GET and PUT. */
export function validateEditorDocument(document) {
  const editable = validateEditorDraft(document);
  const errors = { ...editable.errors };
  addCanonicalError(errors, "document", exactObject(document, ["edit_manifest_version", "identity", "revision", "parent_revision_sha256", "timeline", "visual", "caption_style", "captions", "overlays", "audio", "audit"]));
  addCanonicalError(errors, "edit_manifest_version", document?.edit_manifest_version === "clip-edit-v1.0");
  const identity = document?.identity;
  addCanonicalError(errors, "identity", exactObject(identity, ["selection_version", "candidate_id", "candidate_artifact_sha256", "source_sha256", "candidate_start", "candidate_end", "profile"]));
  addCanonicalError(errors, "identity.selection_version", scalarText(identity?.selection_version, 64));
  addCanonicalError(errors, "identity.candidate_id", CANDIDATE_ID.test(identity?.candidate_id || ""));
  addCanonicalError(errors, "identity.candidate_artifact_sha256", SHA256.test(identity?.candidate_artifact_sha256 || ""));
  addCanonicalError(errors, "identity.source_sha256", SHA256.test(identity?.source_sha256 || ""));
  addCanonicalError(errors, "identity.window", boundedNumber(identity?.candidate_start, 0, Infinity) && boundedNumber(identity?.candidate_end, 0, Infinity) && identity.candidate_end > identity.candidate_start);
  addCanonicalError(errors, "identity.profile", new Set(["viral-short", "standard", "deep-dive"]).has(identity?.profile));
  const timeline = document?.timeline;
  addCanonicalError(errors, "timeline", exactObject(timeline, ["start", "end"]) && timeline.start === identity?.candidate_start && timeline.end === identity?.candidate_end);
  addCanonicalError(errors, "revision", Number.isInteger(document?.revision) && document.revision >= 1 && ((document.revision === 1 && document.parent_revision_sha256 === null) || (document.revision > 1 && SHA256.test(document.parent_revision_sha256 || ""))));
  addCanonicalError(errors, "visual", exactObject(document?.visual, ["canvas_width", "canvas_height", "render_mode", "safe_area", "focal_x", "focal_y"]) && document.visual.canvas_width === 720 && document.visual.canvas_height === 1280);
  addCanonicalError(errors, "visual.safe_area", exactObject(document?.visual?.safe_area, ["top", "right", "bottom", "left"]));
  addCanonicalError(errors, "caption_style", exactObject(document?.caption_style, ["preset", "position", "font_family", "font_size", "color", "keyword_color", "background_color", "background_opacity", "max_chars_per_line", "max_lines", "emphasis"]));
  addCanonicalError(errors, "audio", exactObject(document?.audio, ["gain_db", "normalize"]));
  if (Array.isArray(document?.captions)) {
    const seen = new Set(); let previousEnd = null;
    document.captions.forEach((cue, index) => {
      const prefix = `captions.${index}`;
      addCanonicalError(errors, prefix, exactObject(cue, ["cue_id", "index", "start", "end", "text", "original_text_sha256"]));
      addCanonicalError(errors, `${prefix}.identity`, CUE_ID.test(cue?.cue_id || "") && cue?.index === index && !seen.has(cue?.cue_id));
      addCanonicalError(errors, `${prefix}.timing`, boundedNumber(cue?.start, timeline?.start, timeline?.end) && boundedNumber(cue?.end, timeline?.start, timeline?.end) && cue.end > cue.start && (previousEnd === null || cue.start >= previousEnd));
      addCanonicalError(errors, `${prefix}.original_text_sha256`, SHA256.test(cue?.original_text_sha256 || ""));
      seen.add(cue?.cue_id); previousEnd = cue?.end;
    });
  }
  if (Array.isArray(document?.overlays)) {
    const kinds = new Set(); addCanonicalError(errors, "overlays", document.overlays.length <= 2);
    document.overlays.forEach((overlay, index) => {
      const fields = overlay?.kind === "title" ? ["kind", "text", "x", "y", "max_width"] : overlay?.kind === "logo" ? ["kind", "asset", "x", "y", "opacity", "scale"] : [];
      addCanonicalError(errors, `overlays.${index}`, fields.length > 0 && exactObject(overlay, fields) && !kinds.has(overlay?.kind));
      kinds.add(overlay?.kind);
    });
  } else addCanonicalError(errors, "overlays", false);
  const audit = document?.audit;
  addCanonicalError(errors, "audit", exactObject(audit, ["created_at", "updated_at", "editor_schema"]) && TIMESTAMP.test(audit?.created_at || "") && TIMESTAMP.test(audit?.updated_at || "") && audit.updated_at >= audit.created_at && CUE_ID.test(audit?.editor_schema || ""));
  return { valid: Object.keys(errors).length === 0, errors };
}

function semanticDeepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => semanticDeepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && semanticDeepEqual(left[key], right[key]));
}

export function validateSavedEditorResponse(payload, quotedEtag, submitted) {
  const result = validateEditorDocument(payload);
  const errors = { ...result.errors };
  addCanonicalError(errors, "response.etag", ETAG.test(quotedEtag || ""), "ETag respons harus SHA-256 lowercase yang dikutip tepat.");
  addCanonicalError(errors, "response.document", semanticDeepEqual(payload, submitted), "Respons simpan tidak sama dengan dokumen lengkap yang dikirim.");
  return { valid: Object.keys(errors).length === 0, errors };
}

export function shouldWarnUnsaved(dirty, saveInFlight) { return dirty === true || saveInFlight === true; }

export function buildNextRevision(snapshot, draft, quotedEtag, updatedAt) {
  const match = ETAG.exec(quotedEtag || "");
  if (!match) throw new Error("ETag dokumen edit tidak valid.");
  const next = structuredClone(draft);
  next.edit_manifest_version = snapshot.edit_manifest_version;
  next.identity = structuredClone(snapshot.identity);
  next.timeline = structuredClone(snapshot.timeline);
  next.revision = snapshot.revision + 1;
  next.parent_revision_sha256 = match[1];
  next.audit = { ...structuredClone(snapshot.audit), updated_at: updatedAt };
  return next;
}

function stableBody(body) { return JSON.stringify(body); }
function retrySignature(body) {
  const comparable = structuredClone(body);
  if (comparable?.audit) comparable.audit.updated_at = null;
  return stableBody(comparable);
}

export function createEditorSaveAttempt(previous, manifest, etag, createUuid = () => crypto.randomUUID()) {
  const serialized = stableBody(manifest);
  const reuse = previous?.retryable === true && previous.etag === etag
    && retrySignature(previous.manifest) === retrySignature(manifest);
  return reuse
    ? { manifest: previous.manifest, etag, serialized: previous.serialized, idempotencyKey: previous.idempotencyKey }
    : { manifest, etag, serialized, idempotencyKey: createUuid() };
}

export function currentCaptionCue(cues, playbackRelativeSeconds, sourceStart) {
  const sourceTime = sourceStart + Math.max(0, Number.isFinite(playbackRelativeSeconds) ? playbackRelativeSeconds : 0);
  return (Array.isArray(cues) ? cues : []).find((cue) => sourceTime >= cue.start && sourceTime < cue.end) || null;
}

export function classifyEditorSaveFailure(status, payload = {}) {
  const conflict = status === 409 && ["revision_conflict", "selection_changed"].includes(payload.code);
  if (conflict) return {
    lock: true, retryable: false, kind: "conflict",
    message: payload.code === "selection_changed"
      ? "Pilihan kandidat berubah. Editor dikunci; muat ulang sebelum menerapkan kembali perubahan Anda."
      : "Dokumen berubah di tempat lain. Editor dikunci; muat ulang lalu terapkan kembali perubahan Anda.",
  };
  if (status === 409 && payload.code === "idempotency_conflict") return { lock: true, retryable: false, kind: "conflict", message: "ID penyimpanan sudah dipakai untuk isi berbeda. Muat ulang editor sebelum melanjutkan." };
  if (status === 0 || status === 503 || status >= 500) return { lock: false, retryable: true, kind: "retry", message: "Penyimpanan belum dipastikan berhasil. Coba lagi; ID permintaan yang sama akan digunakan." };
  return { lock: false, retryable: false, kind: "error", message: payload.error || "Perubahan tidak dapat disimpan. Periksa isian lalu coba lagi." };
}

async function json(response) { try { return await response.json(); } catch { return {}; } }

export class EditorLoadError extends Error {
  constructor(message, kind = "request") { super(message); this.name = "EditorLoadError"; this.kind = kind; }
}

export class EditorSelectionChanged extends EditorLoadError {
  constructor() {
    super("Pilihan kandidat berubah saat editor dimuat. Muat ulang untuk mengambil satu versi yang konsisten.", "selection-changed");
    this.name = "EditorSelectionChanged";
  }
}

export async function loadEditorWorkspace(id, candidateId, { fetchImpl = fetch, signal } = {}) {
  const jobId = encodeURIComponent(id);
  const selectedId = encodeURIComponent(candidateId);
  const options = { cache: "no-store", signal };
  const urls = [
    `/api/jobs/${jobId}`,
    `/api/jobs/${jobId}/candidates`,
    `/api/jobs/${jobId}/candidates/${selectedId}/caption-cues`,
    `/api/jobs/${jobId}/candidates/${selectedId}/edit`,
  ];
  const settled = await Promise.allSettled(urls.map((url) => fetchImpl(url, options)));
  const responses = settled.map((result) => result.status === "fulfilled" ? result.value : null);
  const nextPath = `/projects/${jobId}/candidates/${selectedId}/edit`;
  if (responses.some((response) => response?.status === 401)) return { type: "redirect", location: `/login?next=${encodeURIComponent(nextPath)}` };
  const rejectedAbort = settled.find((result) => result.status === "rejected" && result.reason?.name === "AbortError");
  if (rejectedAbort) throw rejectedAbort.reason;
  if (settled.some((result) => result.status === "rejected")) throw new EditorLoadError("Terjadi gangguan jaringan saat memuat editor.", "network");
  if (responses.some((response) => response.status === 404)) throw new EditorLoadError("Proyek atau kandidat tidak ditemukan.", "not-found");
  const payloads = await Promise.all(responses.map(json));
  const failedIndex = responses.findIndex((response) => !response.ok);
  if (failedIndex >= 0) throw new EditorLoadError(payloads[failedIndex]?.error || "Data editor tidak dapat dimuat.");
  const candidate = payloads[1]?.candidates?.find((item) => item?.id === candidateId);
  if (!candidate) throw new EditorLoadError("Kandidat tidak ditemukan dalam versi pilihan saat ini.", "not-found");
  const etag = responses[3].headers.get("etag");
  if (!ETAG.test(etag || "")) throw new EditorLoadError("Versi dokumen edit tidak valid.");
  const manifestValidation = validateEditorDocument(payloads[3]);
  if (!manifestValidation.valid) throw new EditorLoadError("Dokumen edit dari server tidak mengikuti kontrak kanonis.", "invalid-document");
  const identity = payloads[3].identity;
  const timeline = payloads[3].timeline;
  const cues = payloads[2];
  // Manifest captions are authoritative. Caption-cues is only an optional import
  // source, so its cue IDs/times/hashes may differ from a fallback manifest.
  // Its generation binding must still match before displaying the workspace.
  if (candidate.id !== identity.candidate_id || candidate.start !== identity.candidate_start
    || candidate.end !== identity.candidate_end || candidate.profile !== identity.profile
    || timeline.start !== identity.candidate_start || timeline.end !== identity.candidate_end
    || payloads[1]?.selectionVersion !== identity.selection_version
    || cues?.candidateId !== identity.candidate_id
    || cues?.candidateArtifactSha256 !== identity.candidate_artifact_sha256
    || cues?.selectionVersion !== identity.selection_version) throw new EditorSelectionChanged();
  return { type: "loaded", job: payloads[0].job, candidate, cues: cues.cues, manifest: payloads[3], etag };
}

export const loadEditorView = loadEditorWorkspace;
