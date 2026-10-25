// The one-layout editor's address (rombak 06 §3.6): `?panel=<tab>` opens one of the five tabs.
// Links of the two-view editor still work: `?mode=` is dropped, `?card=` and the old panel ids
// (`transcript`, `music`) land on the tab that does the same work, and the address is rewritten
// to keep only `?panel` (history.replaceState in the shell). Pure and DOM-free, except
// forgetLegacyView, which takes the storage as an argument.

/** The five tabs, in the panel's order (components/editor/panels/index.mjs SHELL_TABS). */
export const TAB_IDS = Object.freeze(["text", "layout", "audio", "logo", "coldopen"]);
export const DEFAULT_TAB = "text";
/** The two-view editor's remembered view (lib/editor/view-mode.mjs VIEW_KEY), dropped on open. */
export const LEGACY_VIEW_KEY = "potongin-editor-view";

// The old ids: the transcript is always on screen now, and Musik is Audio.
const OLD_PANELS = Object.freeze({ transcript: "text", music: "audio" });
// Mode Cepat's cards and the tab that does their work.
const OLD_CARDS = Object.freeze({ hook: "text", caption: "text", lines: "text", coldopen: "coldopen", layout: "layout", extras: "logo" });

function params(search) {
  if (search instanceof URLSearchParams) return new URLSearchParams(search);
  try {
    return new URLSearchParams(typeof search === "string" ? search : "");
  } catch {
    return new URLSearchParams();
  }
}

/** The tab an old or new panel id names, or null. */
function tabOf(id) {
  if (typeof id !== "string") return null;
  if (TAB_IDS.includes(id)) return id;
  return Object.hasOwn(OLD_PANELS, id) ? OLD_PANELS[id] : null;
}

/**
 * `{ panel, transcript, search, changed }` for a query string: the tab to open (`?panel`, else
 * `?card`, else `fallback`, else Teks), the transcript view the old Caption lines card asked for
 * ("lines", else "words"), the query the address should carry (`?panel` only when the address
 * named a tab, the other params kept in order) and whether that differs from `search`.
 */
export function resolveUrlState(search, { fallback = null } = {}) {
  const raw = typeof search === "string" ? search : search instanceof URLSearchParams ? `?${search}` : "";
  const query = params(search);
  const card = query.get("card");
  const fromPanel = tabOf(query.get("panel"));
  const fromCard = typeof card === "string" && Object.hasOwn(OLD_CARDS, card) ? OLD_CARDS[card] : null;
  const named = fromPanel ?? fromCard;
  const panel = named ?? tabOf(fallback) ?? DEFAULT_TAB;
  const transcript = card === "lines" && !fromPanel ? "lines" : "words";
  // `?panel` takes the place of the first panel or card param; the others keep their order.
  const next = new URLSearchParams();
  let placed = false;
  for (const [key, value] of query) {
    if (key === "card" || key === "panel") {
      if (named && !placed) next.append("panel", named);
      placed = true;
      continue;
    }
    if (key !== "mode") next.append(key, value);
  }
  const text = next.toString();
  const normalized = text ? `?${text}` : "";
  const given = raw === "?" ? "" : raw;
  return { panel, transcript, search: normalized, changed: normalized !== given };
}

/** The same-origin path of `href` with `?panel=<tab>`; its other params and hash are kept. */
export function urlWithPanel(href, panel) {
  if (!TAB_IDS.includes(panel)) throw new Error(`unknown tab: ${panel}`);
  const url = new URL(href, "http://editor.invalid");
  url.searchParams.set("panel", panel);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A neighbour clip's address on the same tab: its path and `?panel` only (the Klip list, ‹ ›). */
export function panelHref(href, panel) {
  const url = new URL(href, "http://editor.invalid");
  url.search = "";
  url.hash = "";
  if (TAB_IDS.includes(panel)) url.searchParams.set("panel", panel);
  return `${url.pathname}${url.search}`;
}

/** Removes the two-view editor's stored view; false when the storage refuses or is missing. */
export function forgetLegacyView(storage) {
  if (!storage) return false;
  try {
    storage.removeItem(LEGACY_VIEW_KEY);
    return true;
  } catch {
    return false;
  }
}
