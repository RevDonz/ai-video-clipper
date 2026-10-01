// Editor V3 keyboard map (plan Appendix C.4). Client-safe and DOM-free: events are read through
// their `key`, modifier flags and `target`, so the rules are unit-testable in node.
//
// Scope "global" keys are handled by the shell (EditorApp); scope "transcript" keys act on the
// transcript selection and belong to the transcript panel (T2.7), which handles them while it
// has focus. Every action also has a visible control (Appendix C.4, last line).

const entry = (fields) => Object.freeze({ ...fields, keys: Object.freeze(fields.keys) });

export const SHORTCUTS = Object.freeze([
  entry({ id: "playPause", keys: ["Spasi", "K"], description: "Putar / jeda", scope: "global" }),
  entry({ id: "frameBack", keys: ["←"], description: "Mundur satu frame", scope: "global" }),
  entry({ id: "frameForward", keys: ["→"], description: "Maju satu frame", scope: "global" }),
  entry({ id: "secondBack", keys: ["Shift+←"], description: "Mundur 1 detik", scope: "global" }),
  entry({ id: "secondForward", keys: ["Shift+→"], description: "Maju 1 detik", scope: "global" }),
  entry({ id: "undo", keys: ["Ctrl+Z"], description: "Urungkan", scope: "global" }),
  entry({ id: "redo", keys: ["Ctrl+Shift+Z", "Ctrl+Y"], description: "Ulangi", scope: "global" }),
  entry({ id: "removeWords", keys: ["Delete", "Backspace"], description: "Hapus kata terpilih (jump cut)", scope: "transcript" }),
  entry({ id: "editWord", keys: ["Enter"], description: "Edit kata", scope: "transcript" }),
  entry({ id: "trimStart", keys: ["I"], description: "Mulai klip di pilihan atau playhead", scope: "global" }),
  entry({ id: "trimEnd", keys: ["O"], description: "Akhiri klip di pilihan atau playhead", scope: "global" }),
  entry({ id: "coldOpen", keys: ["Ctrl+Shift+H"], description: "Jadikan pilihan cold open", scope: "transcript" }),
  entry({ id: "emphasis", keys: ["Ctrl+E"], description: "Warna kata kunci", scope: "transcript" }),
  entry({ id: "hideWord", keys: ["Ctrl+Shift+X"], description: "Sembunyikan dari caption", scope: "transcript" }),
  entry({ id: "safeZone", keys: ["'"], description: "Tampilkan zona aman", scope: "global" }),
  entry({ id: "truthFrame", keys: ["Ctrl+Shift+R"], description: "Frame akhir (piksel persis)", scope: "global" }),
  entry({ id: "export", keys: ["Ctrl+Shift+E"], description: "Ekspor", scope: "global" }),
  entry({ id: "help", keys: ["?"], description: "Bantuan pintasan", scope: "global" }),
]);

const SCOPE = new Map(SHORTCUTS.map((item) => [item.id, item.scope]));

// Roles whose own keyboard behaviour must win: Space activates, arrows move within the widget.
const ACTIVATES_ON_SPACE = new Set(["BUTTON", "A", "SUMMARY"]);
const SPACE_ROLES = new Set(["button", "link", "tab", "slider", "checkbox", "radio", "switch", "menuitem", "option"]);
const ARROW_ROLES = new Set(["slider", "tab", "radio", "option", "menuitem", "spinbutton", "scrollbar"]);
const ARROW_CONTAINERS = '[role="tablist"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="slider"]';

function lower(key) {
  return typeof key === "string" ? key.toLowerCase() : "";
}

/** The action of a key event, whatever has focus, or null. */
export function shortcutFor(event) {
  if (!event || typeof event.key !== "string") return null;
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);
  const key = event.key;
  const name = lower(key);

  if (alt) return null;
  if (mod) {
    if (name === "z") return shift ? "redo" : "undo";
    if (name === "y" && !shift) return "redo";
    if (name === "h" && shift) return "coldOpen";
    if (name === "e") return shift ? "export" : "emphasis";
    if (name === "x" && shift) return "hideWord";
    if (name === "r" && shift) return "truthFrame";
    return null;
  }
  if (key === "?") return "help";
  if (key === "ArrowLeft") return shift ? "secondBack" : "frameBack";
  if (key === "ArrowRight") return shift ? "secondForward" : "frameForward";
  if (shift) return null;
  if (key === " " || event.code === "Space" || name === "k") return "playPause";
  if (key === "Delete" || key === "Backspace") return "removeWords";
  if (key === "Enter") return "editWord";
  if (name === "i") return "trimStart";
  if (name === "o") return "trimEnd";
  if (key === "'") return "safeZone";
  return null;
}

/** True for a text field or any other element that takes typed input. */
export function isEditableTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function role(target) {
  return typeof target?.getAttribute === "function" ? target.getAttribute("role") : null;
}

function insideArrowWidget(target) {
  return typeof target?.closest === "function" && Boolean(target.closest(ARROW_CONTAINERS));
}

/**
 * The shell's action for a keydown on the page, or null when the event belongs to someone else:
 * a text field, the transcript panel (transcript-scope keys), a focused control whose own
 * Space/arrow behaviour wins, an IME composition, or a handler that already called
 * preventDefault().
 */
export function globalShortcut(event) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  const target = event.target ?? null;
  if (isEditableTarget(target)) return null;
  const id = shortcutFor(event);
  if (!id || SCOPE.get(id) !== "global") return null;
  const tag = typeof target?.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (id === "playPause" && (event.key === " " || event.code === "Space")
    && (ACTIVATES_ON_SPACE.has(tag) || SPACE_ROLES.has(role(target)))) return null;
  if (["frameBack", "frameForward", "secondBack", "secondForward"].includes(id)
    && (ARROW_ROLES.has(role(target)) || insideArrowWidget(target))) return null;
  return id;
}
