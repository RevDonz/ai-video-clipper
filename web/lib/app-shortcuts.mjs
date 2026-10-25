// The single-key shortcuts of the app pages (05-ui-dashboard.md §3.9): N opens Buat klip, / puts
// the cursor in the page's search field. They work only while "Pintasan satu tombol" is on
// (lib/ui-prefs.mjs, WCAG 2.1.4), never from a field, never over an open dialog, menu or list,
// and never with a modifier. DOM-free rules, so they are tested in node; the shell
// (components/AppShell.jsx) feeds them the event, the preference and overlayOpenIn(document).

export const APP_SHORTCUTS = Object.freeze([
  Object.freeze({ id: "create", key: "N", href: "/dashboard" }),
  Object.freeze({ id: "search", key: "/" }),
]);

// An open overlay owns the keyboard: a dialog (Modal, Drawer, AlertDialog), a menu, a list box.
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

// The search field of the page itself, inside <main id="konten">, never one in the sidebar.
export const PAGE_SEARCH_SELECTOR = '#konten input[type="search"], #konten [role="searchbox"]';

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/** True for an element that takes typed text: any input, textarea, select, editable or textbox. */
export function isFieldTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (FIELD_TAGS.has(tag)) return true;
  const role = typeof target.getAttribute === "function" ? target.getAttribute("role") : null;
  return FIELD_ROLES.has(role);
}

/** Whether a dialog, menu or list box is open in `doc`. */
export function overlayOpenIn(doc) {
  return Boolean(doc?.querySelector?.(OVERLAY_SELECTOR));
}

/**
 * The shortcut of a keydown ("create", "search") or null. `enabled` is the preference and must be
 * exactly true; `overlayOpen` is overlayOpenIn(document) at the time of the key.
 */
export function appShortcut(event, { enabled = false, overlayOpen = false } = {}) {
  if (enabled !== true || overlayOpen) return null;
  if (!event || typeof event.key !== "string" || event.defaultPrevented || event.isComposing || event.repeat) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isFieldTarget(event.target)) return null;
  if (event.key === "/") return "search";
  // Shift+N is not N: only the plain letter (caps lock gives "N" without Shift).
  if (!event.shiftKey && (event.key === "n" || event.key === "N")) return "create";
  return null;
}
