// The Transisi section of the Cold open panel (docs/plans/2026-10-02-transisi-cold-open.md §7.1):
// what it shows for a document and the commands its controls send. Pure, so the panel stays thin
// and the node tests cover it. J (the join frame) comes from the time map, so it needs no DTO.
import { JOIN_STYLES, JOIN_STYLE_NAMES, coldOpen } from "../../../lib/editor/doc-model.mjs";
import { pieces, totalFrames } from "../../../lib/editor/timemap.mjs";

export const TRANSITION_NOTE = "Efek di sambungan cold open ke awal klip. Durasi klip tetap.";
export const TRANSITION_REASONS = Object.freeze({
  coldOpenOff: "Aktifkan cold open dulu.",
  readOnly: "Klip ini sedang dalam mode baca-saja",
});

// The fill lasts about 0.2 s (Kilat putih) or 0.3 s (Gelap sebentar) around the join (§2.2).
const DETAILS = Object.freeze({ cut: "Tanpa efek", flash_white: "0,2 dtk", dip_black: "0,3 dtk" });

/** The three choices in panel order: `{ id, name, detail }`. */
export const TRANSITION_STYLES = Object.freeze(JOIN_STYLES.map((id) => Object.freeze({ id, name: JOIN_STYLE_NAMES[id], detail: DETAILS[id] })));

/**
 * `{ enabled, reason, style, sfxOn, joinFrame, audition }` of `doc`: `reason` says why the
 * controls are off (read-only first, then no cold open); `joinFrame` is J, the sum of the cold
 * open's piece frames; `audition` is the `[f0, f1)` "Putar transisi" plays, one second (⌈fps⌉
 * frames) on each side of J inside the clip. Without a cold open: style null, J and audition null.
 */
export function transitionView(doc, { readOnly = false } = {}) {
  const co = doc ? coldOpen(doc) : null;
  const join = co ? doc.main.joins[0] ?? null : null;
  const reason = readOnly ? TRANSITION_REASONS.readOnly : join ? null : TRANSITION_REASONS.coldOpenOff;
  let joinFrame = null;
  let audition = null;
  if (join) {
    const list = pieces(doc);
    joinFrame = list.filter((piece) => piece.seg === co.id).reduce((sum, piece) => sum + piece.frames, 0);
    const [num, den] = doc.output.fps;
    const second = Math.ceil(num / den);
    audition = { f0: Math.max(0, joinFrame - second), f1: Math.min(totalFrames(list), joinFrame + second) };
  }
  return { enabled: reason === null, reason, style: join?.style ?? null, sfxOn: Boolean(join?.sfx), joinFrame, audition };
}

/** The Appendix B commands of the controls (each choice is its own undo step). */
export const transitionCommands = Object.freeze({
  style: (style) => ({ type: "SetJoinStyle", args: { style }, mergeKey: null }),
  sfx: (on) => ({ type: "SetJoinSfx", args: { on }, mergeKey: null }),
});

export function styleStatus(style) {
  return `Transisi: ${JOIN_STYLE_NAMES[style] ?? style}.`;
}

export function sfxStatus(on) {
  return on ? "Whoosh aktif." : "Whoosh mati.";
}

/**
 * The status line after the user's last choice (`{ kind: "style" | "sfx", value }`), only while
 * the document still shows it: an undo or the other tab's change clears it instead of leaving a
 * line that contradicts the controls.
 */
export function transitionStatus(last, view) {
  if (!last || view.style === null) return "";
  if (last.kind === "style") return view.style === last.value ? styleStatus(last.value) : "";
  if (last.kind === "sfx") return view.sfxOn === last.value ? sfxStatus(last.value) : "";
  return "";
}
