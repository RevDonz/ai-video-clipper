// Per-device UI preferences (05-ui-dashboard.md §3.9, the owner of this cookie). One so far:
// "Pintasan satu tombol", the single-key shortcuts of the app pages (N, /) and of the editor
// (K, I, O, ', ?), WCAG 2.1.4. A cookie and not localStorage so the editor page reads it on the
// server and renders the right state at once. Runs in the browser and on the server.

export const SHORTCUTS_COOKIE = "potongin_shortcuts";
export const SHORTCUTS_MAX_AGE = 365 * 24 * 60 * 60;

// "1"/"0" are what an earlier draft wrote; read them as on/off.
const VALUES = Object.freeze({ on: true, off: false, 1: true, 0: false });

/** The preference for one cookie value: on, unless it says off (or 0). */
export function shortcutPrefFromValue(value) {
  if (typeof value !== "string" || !Object.hasOwn(VALUES, value)) return true;
  return VALUES[value];
}

/** The preference in a Cookie header or document.cookie; on when the cookie is absent. */
export function readShortcutPref(cookieString) {
  if (typeof cookieString !== "string" || !cookieString) return true;
  for (const pair of cookieString.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0 || pair.slice(0, at).trim() !== SHORTCUTS_COOKIE) continue;
    let value;
    try {
      value = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      return true;
    }
    return shortcutPrefFromValue(value);
  }
  return true;
}

/** The Set-Cookie value for the preference: a year, the whole site, readable by the page. */
export function shortcutPrefCookie(on, { secure = false } = {}) {
  const parts = [`${SHORTCUTS_COOKIE}=${on === true ? "on" : "off"}`, "Path=/", `Max-Age=${SHORTCUTS_MAX_AGE}`, "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Writes the preference on this device (Secure on https) and returns it. */
export function writeShortcutPref(on, doc = globalThis.document) {
  const value = on === true;
  if (doc && typeof doc === "object") {
    doc.cookie = shortcutPrefCookie(value, { secure: doc.location?.protocol === "https:" });
  }
  return value;
}
