// The Pengaturan "Teks watermark bawaan" card, DOM-free: the state from GET
// /api/settings/watermark, the form, its payload and the card's copy (web/lib/default-watermark.mjs
// is the server side).
import { cleanWatermarkText, watermarkPoints } from "../components/editor/panels/watermark-model.mjs";
import { DEFAULT_WATERMARK, LIMITS, WATERMARK_OPACITY_RANGE, WATERMARK_POSITIONS, WATERMARK_SIZE_RANGE } from "./editor/doc-model.mjs";

const inRange = (value, [low, high]) => Number.isSafeInteger(value) && value >= low && value <= high;

function validWatermark(value) {
  return Boolean(value) && typeof value === "object" && typeof value.text === "string" && value.text.length > 0
    && watermarkPoints(value.text) <= LIMITS.watermarkText && WATERMARK_POSITIONS.includes(value.pos)
    && inRange(value.size_pm, WATERMARK_SIZE_RANGE) && inRange(value.opacity_pm, WATERMARK_OPACITY_RANGE)
    && Number.isSafeInteger(value.updatedAtMs);
}

/** `{ watermark, autoClips }` from the GET/PUT/DELETE answer; anything malformed reads as none. */
export function defaultWatermarkState(payload) {
  return { watermark: validWatermark(payload?.watermark) ? payload.watermark : null, autoClips: payload?.autoClips === true };
}

/** The form a stored watermark (or none: the editor's defaults and no text) starts from. */
export function defaultWatermarkForm(watermark) {
  if (!watermark) return { text: "", ...DEFAULT_WATERMARK };
  return { text: watermark.text, pos: watermark.pos, size_pm: watermark.size_pm, opacity_pm: watermark.opacity_pm };
}

/** `{ payload }` for PUT, or `{ error }` when the text is empty or too long. */
export function defaultWatermarkPayload(form) {
  const text = cleanWatermarkText(form.text);
  if (!text) return { error: "Tulis teks watermark dulu." };
  if (watermarkPoints(text) > LIMITS.watermarkText) return { error: `Teks watermark maksimal ${LIMITS.watermarkText} karakter.` };
  return { payload: { text, pos: form.pos, size_pm: form.size_pm, opacity_pm: form.opacity_pm } };
}

/** Whether the form says what is stored (nothing to save). */
export function formMatches(form, watermark) {
  if (!watermark) return false;
  return cleanWatermarkText(form.text) === watermark.text && form.pos === watermark.pos
    && form.size_pm === watermark.size_pm && form.opacity_pm === watermark.opacity_pm;
}

/** The card's text. `autoClips`: the automatic clips render with the editor's engine. */
export function defaultWatermarkCopy({ autoClips = false } = {}) {
  return {
    where: "Satu baris teks, misalnya nama akun Anda, ditulis otomatis di setiap klip baru. Klip yang sudah ada tidak berubah.",
    reach: autoClips
      ? "Ikut di file klip otomatis dan saat klip dibuka di editor."
      : "Dipakai saat klip dibuka di editor dan ikut di hasil ekspornya. File klip otomatis tetap tanpa teks watermark.",
    perClip: "Per klip bisa diubah atau dihapus di panel Logo editor.",
  };
}
