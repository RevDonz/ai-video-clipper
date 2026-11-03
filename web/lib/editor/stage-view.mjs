// What the stage of the one-layout editor shows (rombak 06 §5.2): the result (`output`), or the
// source picture with the crop's gizmo (`source`, "Lihat sumber"). The state lives in the shell,
// never in the document. Pure; EditorApp runs the machine and panels read the view.
import { framingAvailability } from "./framing.mjs";

export const STAGE_OUTPUT = "output";
export const STAGE_SOURCE = "source";

/**
 * Whether Lihat sumber can open for this document: the split's two crops, or the crop layouts the
 * frame can be moved in (framing.mjs says which: not latar blur, not an upright source). Shot ranges
 * hide it while keyframes and ranges may not mix (06 §5.2, 04 §A6).
 */
export function sourceAllowed(doc) {
  const layout = doc?.layout;
  if (!layout?.default) return false;
  if (Array.isArray(layout.ranges) && layout.ranges.length > 0) return false;
  return layout.default.mode === "split" || framingAvailability(doc).ok;
}

/** The next view after `event`: `show`, `back`, `escape`, `play`, `tab` ({tab}) or `doc` ({doc}). */
export function stageViewAfter(view, event) {
  switch (event?.type) {
    case "show":
      return view === STAGE_OUTPUT && sourceAllowed(event.doc) ? STAGE_SOURCE : view;
    case "back":
    case "escape":
    case "play":
      return STAGE_OUTPUT;
    case "tab":
      return event.tab === "layout" ? view : STAGE_OUTPUT;
    case "doc":
      return view === STAGE_SOURCE && !sourceAllowed(event.doc) ? STAGE_OUTPUT : view;
    default:
      return view;
  }
}
