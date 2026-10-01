// The transcript's selection model (plan Appendix C.2): a contiguous range of word indices
// (into `words.words`), kept as an anchor and a focus so Shift+click and Shift+arrows extend from
// where the selection started. Pure functions plus a tiny shared store: the selection outlives the
// Transkrip tab, so the Cold open panel ("Jadikan cold open dari pilihan") and the editor shell's
// shortcuts can read it with `selectionStoreFor(clipId)`.

/** No selection. */
export const NO_SELECTION = Object.freeze({ anchor: -1, focus: -1 });

const make = (anchor, focus) => Object.freeze({ anchor, focus });
const clamp = (value, count) => Math.max(0, Math.min(count - 1, value));

export function isEmpty(selection) {
  return !selection || selection.anchor < 0 || selection.focus < 0;
}

/** A click: exactly one word. */
export function selectOne(index) {
  return index < 0 ? NO_SELECTION : make(index, index);
}

/** Shift+click or drag: from the anchor to `index` (a click when nothing is selected). */
export function extendTo(selection, index) {
  if (index < 0) return NO_SELECTION;
  return isEmpty(selection) ? selectOne(index) : make(selection.anchor, index);
}

/** The word range `[first, last]` (inclusive), or null. */
export function selectionRange(selection) {
  if (isEmpty(selection)) return null;
  return selection.anchor <= selection.focus ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor];
}

/** Explicit range `[first, last]` with the anchor at `first`. */
export function selectRange(first, last) {
  return make(first, last);
}

export function includes(selection, index) {
  const range = selectionRange(selection);
  return range !== null && range[0] <= index && index <= range[1];
}

/** An arrow key: collapse to the focus and move it by `delta` (clamped). */
export function moveFocus(selection, delta, count) {
  if (count <= 0) return NO_SELECTION;
  if (isEmpty(selection)) return selectOne(delta >= 0 ? 0 : count - 1);
  return selectOne(clamp(selection.focus + delta, count));
}

/** Shift+arrow: move the focus by `delta`, keeping the anchor. */
export function extendFocus(selection, delta, count) {
  if (count <= 0) return NO_SELECTION;
  if (isEmpty(selection)) return selectOne(delta >= 0 ? 0 : count - 1);
  return make(selection.anchor, clamp(selection.focus + delta, count));
}

/** The selection after the word list changed to `count` words (unchanged object when still valid). */
export function clampSelection(selection, count) {
  if (isEmpty(selection)) return NO_SELECTION;
  if (selection.anchor < count && selection.focus < count) return selection;
  const [first, last] = selectionRange(selection);
  if (first >= count) return NO_SELECTION;
  return make(first, Math.min(last, count - 1));
}

function same(a, b) {
  return a === b || (a.anchor === b.anchor && a.focus === b.focus);
}

/** `{get, set, subscribe}`; listeners run only when the range actually changes. */
export function createSelectionStore(initial = NO_SELECTION) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      const normalised = isEmpty(next) ? NO_SELECTION : next;
      if (same(normalised, value)) return;
      value = normalised;
      for (const listener of [...listeners]) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const stores = new Map();

/** The selection store shared by every panel of one clip. */
export function selectionStoreFor(key) {
  const id = String(key ?? "");
  if (!stores.has(id)) stores.set(id, createSelectionStore());
  return stores.get(id);
}
