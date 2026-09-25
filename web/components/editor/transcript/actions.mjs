// From a transcript selection (and a key) to Appendix B commands (plan Appendix C.2, C.4).
// Pure: the panels call `selectionActions` to enable their controls and `runCommands` to
// dispatch, so the toolbar, the keyboard and the Cold open panel always agree.
import { coldOpenCheck } from "./model.mjs";
import { selectionRange } from "./selection.mjs";

/** Indonesian messages for commands the store rejected (`CommandRejected.code`). */
export const REJECTION_MESSAGES = Object.freeze({
  duration_out_of_bounds: "Durasi klip harus antara 3 dtk dan 5 menit.",
  cold_open_invalid: "Cold open harus 0,5–8 dtk dan tidak boleh hanya mengulang awal klip.",
  outside_window: "Di luar jendela analisis klip (±60 dtk dari klip asli).",
  not_visible: "Kata ini tidak tampil di klip.",
  removal_outside_segment: "Potongan harus berada di dalam klip.",
  removal_overlap: "Potongan bertumpuk dengan potongan lain.",
  unknown_word: "Kata tidak dikenal di transkrip ini.",
  range_invalid: "Nilai ini tidak diterima.",
  not_nfc: "Teks memakai karakter yang tidak dinormalkan.",
  control_char: "Teks memuat karakter kontrol.",
  pack_unknown: "Gaya caption tidak dikenal.",
  not_found: "Bagian ini sudah tidak ada.",
  read_only: "Klip ini sedang dalam mode baca-saja.",
  not_ready: "Editor belum siap.",
});

export function rejectionMessage(error) {
  const code = error?.code ?? null;
  if (code && REJECTION_MESSAGES[code]) return REJECTION_MESSAGES[code];
  if (typeof error?.userMessage === "string" && error.userMessage) return error.userMessage;
  return code ? `Perintah ditolak (${code}).` : "Perintah gagal dijalankan.";
}

/**
 * Dispatch `commands` ([{type, args, mergeKey}]) in order. Returns `{ok: true}` or, at the first
 * rejection, `{ok: false, code, message}` (earlier commands of the same action stay applied; they
 * share a merge key, so one undo removes them all).
 */
export function runCommands(dispatch, commands) {
  for (const { type, args, mergeKey = null } of commands) {
    try {
      dispatch(type, args, { mergeKey });
    } catch (error) {
      return { ok: false, code: error?.code ?? null, message: rejectionMessage(error) };
    }
  }
  return { ok: true };
}

let actionSeq = 0;

/** A merge key shared by the commands of one user action (one undo step). */
export function actionKey(name) {
  actionSeq += 1;
  return `tx:${name}:${actionSeq}`;
}

const disabled = (reason) => ({ enabled: false, reason });

/**
 * What the selection allows: `{remove, restore, edit, hide, emphasis, trimStart, trimEnd, extend,
 * coldOpen}`, each with `enabled` and the data its command needs.
 */
export function selectionActions(model, selection, { readOnly = false } = {}) {
  const states = model.states;
  const range = selectionRange(selection);
  const none = "Pilih kata dulu";
  if (!range || range[0] >= states.length) {
    return {
      range: null, remove: { ...disabled(none), runs: [] }, restore: { ...disabled(none), removalIds: [] },
      edit: { ...disabled(none), index: -1 }, hide: { ...disabled(none), on: true, ids: [] },
      emphasis: { ...disabled(none), on: true, ids: [] }, trimStart: { ...disabled(none), gapWord: null, extend: false },
      trimEnd: { ...disabled(none), gapWord: null, extend: false }, extend: { ...disabled(none), command: null },
      coldOpen: { ...disabled(coldOpenCheck(model, -1, -1).reason), firstWord: null, lastWord: null, frames: 0 },
    };
  }
  const [first, last] = [range[0], Math.min(range[1], states.length - 1)];
  const lock = readOnly ? "Mode baca-saja" : null;
  const runs = [];
  const removalIds = [];
  const ids = [];
  let allHidden = true;
  let allEmphasis = true;
  for (let i = first; i <= last; i += 1) {
    const state = states[i];
    ids.push(state.id);
    allHidden &&= state.hidden;
    allEmphasis &&= state.emphasis;
    if (state.zone === "body" && state.removal === null) {
      const previous = runs.at(-1);
      if (previous && previous.last === i - 1) {
        previous.ids.push(state.id);
        previous.last = i;
      } else runs.push({ ids: [state.id], last: i });
    }
    for (const id of [state.removal, state.coRemoval]) {
      if (id !== null && id !== "sliver" && !removalIds.includes(id)) removalIds.push(id);
    }
  }
  const enable = (ok, reason) => (lock ? disabled(lock) : ok ? { enabled: true, reason: null } : disabled(reason));
  const firstState = states[first];
  const lastState = states[last];
  const extendCommand = firstState.zone === "before" ? { type: "TrimStart", args: { gapWord: firstState.id }, mergeKey: null }
    : lastState.zone === "after" ? { type: "TrimEnd", args: { gapWord: lastState.id }, mergeKey: null } : null;
  const check = coldOpenCheck(model, first, last);
  return {
    range: [first, last],
    remove: { ...enable(runs.length > 0, "Kata yang dipilih sudah dipotong atau di luar klip"), runs: runs.map((run) => run.ids) },
    restore: { ...enable(removalIds.length > 0, "Tidak ada potongan di pilihan ini"), removalIds },
    edit: { ...enable(true), index: first },
    hide: { ...enable(true), on: !allHidden, ids },
    emphasis: { ...enable(true), on: !allEmphasis, ids },
    trimStart: { ...enable(true), gapWord: firstState.id, extend: firstState.zone === "before" },
    trimEnd: { ...enable(true), gapWord: lastState.id, extend: lastState.zone === "after" },
    extend: { ...enable(extendCommand !== null, "Pilih kata di luar klip (redup) untuk memperpanjang"), command: extendCommand },
    coldOpen: { ...enable(check.ok, check.reason), firstWord: firstState.id, lastWord: lastState.id, frames: check.frames ?? 0 },
  };
}

/** The Appendix B commands of a transcript action, or null when the action is not a command. */
export function commandsFor(name, actions, key = actionKey(name)) {
  switch (name) {
    case "remove":
      return actions.remove.runs.map((wordIds) => ({ type: "RemoveWords", args: { wordIds, reason: "user", origin: "user" }, mergeKey: key }));
    case "restore":
      return actions.restore.removalIds.map((removalId) => ({ type: "RestoreRemoval", args: { removalId }, mergeKey: key }));
    case "hide":
      return actions.hide.ids.map((wordId) => ({ type: "SetWordHidden", args: { wordId, on: actions.hide.on }, mergeKey: key }));
    case "emphasis":
      return actions.emphasis.ids.map((wordId) => ({ type: "SetWordEmphasis", args: { wordId, on: actions.emphasis.on }, mergeKey: key }));
    case "trimStart":
      return [{ type: "TrimStart", args: { gapWord: actions.trimStart.gapWord }, mergeKey: null }];
    case "trimEnd":
      return [{ type: "TrimEnd", args: { gapWord: actions.trimEnd.gapWord }, mergeKey: null }];
    case "extend":
      return actions.extend.command ? [actions.extend.command] : [];
    case "coldOpen":
      return [{ type: "SetColdOpen", args: { firstWord: actions.coldOpen.firstWord, lastWord: actions.coldOpen.lastWord }, mergeKey: null }];
    default:
      return null;
  }
}

const ARROWS = { ArrowRight: "next", ArrowLeft: "prev", ArrowDown: "lineDown", ArrowUp: "lineUp" };
const EXTEND = { ArrowRight: "extendNext", ArrowLeft: "extendPrev", ArrowDown: "extendLineDown", ArrowUp: "extendLineUp" };

/** The transcript action of a keydown (Appendix C.2/C.4), or null (left to the editor shell). */
export function keyAction(event) {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const { shiftKey: shift, altKey: alt } = event;
  const key = event.key;
  if (alt) return null;
  const lower = typeof key === "string" && key.length === 1 ? key.toLowerCase() : key;
  if (mod) {
    if (shift && lower === "x") return "hide";
    if (shift && lower === "h") return "coldOpen";
    if (!shift && lower === "e") return "emphasis";
    return null;
  }
  if (key in ARROWS) return shift ? EXTEND[key] : ARROWS[key];
  if (shift) return lower === "i" ? "trimStart" : lower === "o" ? "trimEnd" : null;
  switch (lower) {
    case "Delete":
    case "Backspace":
      return "remove";
    case "Enter":
      return "edit";
    case "Escape":
      return "clear";
    case "i":
      return "trimStart";
    case "o":
      return "trimEnd";
    default:
      return null;
  }
}
