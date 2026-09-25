// Undo/redo history and the edit session (plan §4.5).
//
// `createHistory` keeps up to 200 entries `{ before, after, steps }` over immutable documents
// (structural sharing: an entry costs only the parts its commands changed). Commands with the
// same mergeKey within 500 ms of the previous one (drags, sliders, typing in one word) grow the
// last entry instead of adding one; `seal()` stops that (the store seals when a save starts, so
// a saved entry never grows).
//
// `createEditSession` applies commands to the current document and keeps the **pending log**:
// the steps that turn the last saved document (the base) into the current one. Autosave sends
// the current document, the IndexedDB draft stores the log, and a 409 replays it onto the
// server's document (rebase.mjs). Undo of an unsaved entry pops its steps; undo past the last
// save appends a `__parts` step that restores the entry's parts (redo pops it again). Invariant:
// `replaySteps(base, session.pending).doc` has the content of `session.doc`.
import { applyCommand, defaultMergeKey } from "./commands.mjs";
import { applyParts, diffParts, partValues } from "./rebase.mjs";

export const HISTORY_LIMIT = 200;
export const MERGE_WINDOW_MS = 500;

export function createHistory({ limit = HISTORY_LIMIT, mergeWindowMs = MERGE_WINDOW_MS } = {}) {
  let entries = [];
  let position = 0;
  let nextEntryId = 1;
  return {
    get entries() {
      return entries.slice();
    },
    get size() {
      return entries.length;
    },
    get position() {
      return position;
    },
    get canUndo() {
      return position > 0;
    },
    get canRedo() {
      return position < entries.length;
    },
    /** Adds (or merges into the last entry) one applied command. Returns `{ entry, merged }`. */
    record({ type, args, mergeKey = null, at, before, after, parts = [] }) {
      const last = position > 0 && position === entries.length ? entries[position - 1] : null;
      if (last && mergeKey !== null && mergeKey !== undefined && last.mergeKey === mergeKey && !last.sealed
        && at - last.lastAt <= mergeWindowMs) {
        last.after = after;
        last.lastAt = at;
        last.steps.push({ type, args, at, parts });
        last.parts = [...new Set([...last.parts, ...parts])];
        return { entry: last, merged: true };
      }
      entries.length = position;
      const entry = { id: nextEntryId++, mergeKey: mergeKey ?? null, firstAt: at, lastAt: at, before, after,
        steps: [{ type, args, at, parts }], parts: [...parts], sealed: false };
      entries.push(entry);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      position = entries.length;
      return { entry, merged: false };
    },
    /** Steps back; returns the undone entry (its `before` is the new document) or null. */
    undo() {
      if (!position) return null;
      position -= 1;
      entries[position].sealed = true;
      return entries[position];
    },
    /** Steps forward; returns the redone entry (its `after` is the new document) or null. */
    redo() {
      if (position >= entries.length) return null;
      const entry = entries[position];
      entry.sealed = true;
      position += 1;
      return entry;
    },
    /** The last applied entry no longer merges (called when a save starts). */
    seal() {
      if (position > 0) entries[position - 1].sealed = true;
    },
    clear() {
      entries = [];
      position = 0;
    },
  };
}

export function createEditSession({ doc, ctx, now = () => Date.now(), limit = HISTORY_LIMIT, mergeWindowMs = MERGE_WINDOW_MS }) {
  let current = doc;
  let history = createHistory({ limit, mergeWindowMs });
  let pending = [];

  return {
    get doc() {
      return current;
    },
    get history() {
      return history;
    },
    get canUndo() {
      return history.canUndo;
    },
    get canRedo() {
      return history.canRedo;
    },
    /** A copy of the pending log (steps since the base). */
    get pending() {
      return pending.slice();
    },

    /**
     * Applies an Appendix B command. Returns `{ doc, changed, merged, entry, args, parts }`;
     * a command that changes nothing adds no history entry. Throws CommandRejected.
     */
    dispatch(type, args = {}, options = {}) {
      const before = current;
      const result = applyCommand(before, type, args, ctx);
      const parts = diffParts(before, result.doc);
      if (!parts.length) return { doc: current, changed: false, merged: false, entry: null, args: result.args, parts };
      const mergeKey = options.mergeKey === undefined ? defaultMergeKey(type, result.args) : options.mergeKey;
      const { entry, merged } = history.record({ type, args: result.args, mergeKey, at: now(), before, after: result.doc, parts });
      pending.push({ type, args: result.args, parts, entryId: entry.id });
      current = result.doc;
      return { doc: current, changed: true, merged, entry, args: result.args, parts };
    },

    undo() {
      const entry = history.undo();
      if (!entry) return false;
      let tail = 0;
      while (tail < pending.length) {
        const step = pending[pending.length - 1 - tail];
        if (step.entryId !== entry.id || step.undo) break;
        tail += 1;
      }
      pending.splice(pending.length - tail, tail);
      if (tail < entry.steps.length) {
        pending.push({ type: "__parts", values: partValues(entry.before, entry.parts), parts: [...entry.parts], entryId: entry.id, undo: true });
      }
      current = entry.before;
      return true;
    },

    redo() {
      const entry = history.redo();
      if (!entry) return false;
      const last = pending.at(-1);
      if (last && last.undo && last.entryId === entry.id) pending.pop();
      else for (const step of entry.steps) pending.push({ type: step.type, args: step.args, parts: step.parts, entryId: entry.id });
      current = entry.after;
      return true;
    },

    /** The last entry stops merging (a save of the current document has started). */
    seal() {
      history.seal();
    },

    /** The first `count` pending steps are now part of the saved base. */
    saved(count) {
      pending.splice(0, count);
    },

    /**
     * Starts over from `base` with `steps` (after a rebase or a draft restore): the steps are
     * replayed, each original entry becomes one (sealed) history entry, older history is gone.
     * Throws CommandRejected when a step no longer applies.
     */
    reset({ base, steps = [] }) {
      history = createHistory({ limit, mergeWindowMs });
      pending = [];
      current = base;
      let lastKey = null;
      for (const step of steps) {
        const before = current;
        const result = step.type === "__parts"
          ? { doc: applyParts(before, step.values, ctx), args: step.args }
          : applyCommand(before, step.type, step.args, ctx);
        const parts = diffParts(before, result.doc);
        if (!parts.length) continue;
        const key = `__replay:${step.entryId ?? pending.length}`;
        if (key !== lastKey) history.seal();
        const { entry } = history.record({ type: step.type, args: result.args, mergeKey: key, at: 0, before, after: result.doc, parts });
        lastKey = key;
        pending.push(step.type === "__parts" ? { ...step, parts, entryId: entry.id } : { type: step.type, args: result.args, parts, entryId: entry.id });
        current = result.doc;
      }
      history.seal();
    },
  };
}
