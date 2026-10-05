// The editor's two views, Cepat and Lengkap (docs/plans/2026-10-02-editor-mode-cepat.md §4): the
// per-viewer preference, the URL params and the order that resolves them. Pure and DOM-free: the
// storage is passed in (window.localStorage in the app, a fake in the tests), and every access is
// guarded, so blocked storage only means opening in Cepat.
import { PANELS } from "../../components/editor/panels/index.mjs";
import { CARDS } from "../../components/editor/quick/cards.mjs";

export const VIEWS = Object.freeze(["cepat", "lengkap"]);
export const VIEW_KEY = "potongin-editor-view";

/** The ids `?panel=` accepts (the Lengkap tabs) and the ids `?card=` accepts (the Cepat cards). */
export const PANEL_IDS = Object.freeze(PANELS.map((entry) => entry.id));
export const CARD_IDS = Object.freeze(CARDS.map((entry) => entry.id));

const known = (list, value) => (typeof value === "string" && list.includes(value) ? value : null);

/** "cepat" | "lengkap" | null; null on any throw or unknown value. */
export function readStoredView(storage) {
  try {
    return known(VIEWS, storage?.getItem(VIEW_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Stores the view; false when the view is unknown or the storage refuses. Never throws. */
export function writeStoredView(storage, view) {
  if (!known(VIEWS, view) || !storage) return false;
  try {
    storage.setItem(VIEW_KEY, view);
    return true;
  } catch {
    return false;
  }
}

function params(search) {
  if (search instanceof URLSearchParams) return search;
  try {
    return new URLSearchParams(typeof search === "string" ? search : "");
  } catch {
    return new URLSearchParams();
  }
}

/** `{ view, panel, card }` from a query string; values outside VIEWS, PANEL_IDS and CARD_IDS are null. */
export function viewFromUrl(search) {
  const query = params(search);
  return {
    view: known(VIEWS, query.get("mode")),
    panel: known(PANEL_IDS, query.get("panel")),
    card: known(CARD_IDS, query.get("card")),
  };
}

/** The view to open: the URL (`mode`, else implied by `panel` or `card`), the stored preference, then Cepat. */
export function resolveView({ url = null, stored = null } = {}) {
  const fromUrl = url?.view ?? (url?.panel ? "lengkap" : url?.card ? "cepat" : null);
  return fromUrl ?? known(VIEWS, stored) ?? "cepat";
}

/**
 * The same-origin path of `href` with `?mode=<view>`, its other params and hash kept and `panel`
 * and `card` dropped (they chose the opening panel or card, not the view the viewer switched to).
 */
export function urlWithView(href, view) {
  if (!known(VIEWS, view)) throw new Error(`unknown view: ${view}`);
  const url = new URL(href, "http://editor.invalid");
  url.searchParams.delete("panel");
  url.searchParams.delete("card");
  url.searchParams.set("mode", view);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** window.localStorage, or null where reading it throws (blocked site data, some private windows). */
export function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
