// The text watermark section of the Logo panel (CONTRACTS §5.40): the text as stored, the
// commands of its field, place grid and sliders, and its view of the store state. Pure; no DOM.
import {
  LIMITS,
  WATERMARK_POSITIONS,
  WATERMARK_POSITION_NAMES,
  watermarkOf,
} from "../../../lib/editor/doc-model.mjs";

export const WATERMARK_MAX = LIMITS.watermarkText;

/** The nine places in the grid's order (row by row), each with its name. */
export const WATERMARK_PLACES = Object.freeze(WATERMARK_POSITIONS.map((id) => Object.freeze({ id, name: WATERMARK_POSITION_NAMES[id] })));

/** The text as the store keeps it: NFC, control characters as spaces, trimmed. */
export function cleanWatermarkText(text) {
  return String(text ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

/** Code points, the unit of the 40 limit (an emoji counts once). */
export function watermarkPoints(text) {
  return [...String(text ?? "")].length;
}

/** "85%", "125,5%" from per-mille. */
export function percentLabel(pm) {
  const whole = Math.trunc(pm / 10);
  const rest = pm % 10;
  return rest ? `${whole},${rest}%` : `${whole}%`;
}

/**
 * Typing `value`: adds the watermark (its first text) or changes its text, merged into one undo
 * step (`wm:text`); null when the text is empty, over the limit or unchanged. An emptied field
 * sends nothing: "Hapus teks" removes the watermark.
 */
export function watermarkTextCommand(doc, value) {
  const text = cleanWatermarkText(value);
  if (!text || watermarkPoints(text) > WATERMARK_MAX || text === watermarkOf(doc)?.text) return null;
  return { type: "SetWatermarkText", args: { text }, mergeKey: "wm:text" };
}

/** What the field shows when it loses focus: the stored text instead of an emptied field. */
export function watermarkDraftOnBlur(doc, draft) {
  const stored = watermarkOf(doc)?.text;
  return stored && !cleanWatermarkText(draft) ? stored : draft;
}

export function watermarkPlaceCommand(doc, pos) {
  if (!WATERMARK_POSITIONS.includes(pos)) throw new TypeError(`unknown watermark place: ${pos}`);
  const mark = watermarkOf(doc);
  if (!mark || mark.pos === pos) return null;
  return { type: "SetWatermarkPosition", args: { pos }, mergeKey: null };
}

export function watermarkSizeCommand(doc, sizePm) {
  const mark = watermarkOf(doc);
  if (!mark || mark.size_pm === sizePm) return null;
  return { type: "SetWatermarkSize", args: { size_pm: sizePm }, mergeKey: "wm:size" };
}

export function watermarkOpacityCommand(doc, opacityPm) {
  const mark = watermarkOf(doc);
  if (!mark || mark.opacity_pm === opacityPm) return null;
  return { type: "SetWatermarkOpacity", args: { opacity_pm: opacityPm }, mergeKey: "wm:opacity" };
}

export function watermarkRemoveCommand(doc) {
  return watermarkOf(doc) ? { type: "RemoveWatermark", args: {}, mergeKey: null } : null;
}

/** The plan's `glyph_unsupported:U+XXXX` warnings for the watermark, as "₿ (U+20BF)". */
function missingGlyphs(plan) {
  return (Array.isArray(plan?.warnings) ? plan.warnings : [])
    .filter((warning) => warning?.path === "/watermark/text" && typeof warning.code === "string"
      && warning.code.startsWith("glyph_unsupported:"))
    .map((warning) => warning.code.slice("glyph_unsupported:".length))
    .filter((code, index, all) => /^U\+[0-9A-F]{4,6}$/.test(code) && all.indexOf(code) === index)
    .map((code) => `${String.fromCodePoint(Number.parseInt(code.slice(2), 16))} (${code})`);
}

/** `{ ready, readOnly, watermark, place, sizeText, opacityText, missingGlyphs }` of the store state. */
export function watermarkView(state) {
  const status = state?.status ?? "loading";
  const readOnly = status === "readOnly";
  const ready = (status === "ready" || readOnly) && Boolean(state?.doc);
  const mark = ready ? watermarkOf(state.doc) : null;
  return {
    ready,
    readOnly,
    watermark: mark,
    place: mark ? { id: mark.pos, name: WATERMARK_POSITION_NAMES[mark.pos] ?? mark.pos } : null,
    sizeText: mark ? percentLabel(mark.size_pm) : null,
    opacityText: mark ? percentLabel(mark.opacity_pm) : null,
    missingGlyphs: mark ? missingGlyphs(state.plan) : [],
  };
}
