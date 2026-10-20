// Moving to the project's previous or next clip from the editor (the top bar's "Klip 3/8 ‹ ›"):
// the order and the neighbours come from the clips listing the editor already loads for the title,
// the neighbour opens in the same view, and the editor leaves only after its work is saved.
// Client-safe and DOM-free.
import { clipEntryView } from "../clip-entry-view.mjs";
import { isRevisionConflict } from "./autosave.mjs";
import { CARD_IDS, PANEL_IDS, VIEWS } from "./view-mode.mjs";

export const LEAVE_TEXT = Object.freeze({
  error: "Perubahan belum tersimpan, jadi Anda tetap di klip ini. Coba simpan lagi.",
  conflict: "Pilih versi yang dipakai dulu, lalu pindah klip.",
  export: "Tunggu ekspor terkirim, lalu pindah klip.",
});

// The export sends the document in these phases; leaving then could cut the request off.
const EXPORT_SENDING = new Set(["saving", "submitting"]);
// A save that merged with another tab, or work added while saving, gets a further round.
const SAVE_ROUNDS = 3;

function clipNumber(clip) {
  return Number.isInteger(clip.index) && clip.index >= 1 ? clip.index : Number.POSITIVE_INFINITY;
}

/**
 * `{ position, total, previous, next }` of clip `clipId` in the project's order (the clip number,
 * as on the project page): `previous` and `next` are `{ href, position }` of the nearest clip on
 * that side the editor can open (the project page's "Edit klip" rule), or null. Null when the
 * listing does not name the clip or has only one clip.
 */
export function clipNavigation({ jobId, clipId, clips }) {
  if (typeof clipId !== "string" || !Array.isArray(clips)) return null;
  const ordered = clips
    .map((clip, at) => ({ clip, at }))
    .filter(({ clip }) => clip && typeof clip === "object")
    .sort((a, b) => clipNumber(a.clip) - clipNumber(b.clip) || a.at - b.at)
    .map(({ clip }) => clip);
  const here = ordered.findIndex((clip) => clip.clipId === clipId);
  if (here < 0 || ordered.length < 2) return null;
  const nearest = (step) => {
    for (let at = here + step; at >= 0 && at < ordered.length; at += step) {
      const href = clipEntryView(jobId, ordered[at]).editHref;
      if (href) return { href, position: at + 1 };
    }
    return null;
  };
  return { position: here + 1, total: ordered.length, previous: nearest(-1), next: nearest(1) };
}

/** The neighbour's address in the current view, with Lengkap's panel or Cepat's open card. */
export function clipNavHref(href, { view = null, panel = null, card = null } = {}) {
  const url = new URL(href, "http://editor.invalid");
  url.search = "";
  if (VIEWS.includes(view)) url.searchParams.set("mode", view);
  if (view === "lengkap" && PANEL_IDS.includes(panel)) url.searchParams.set("panel", panel);
  if (view === "cepat" && CARD_IDS.includes(card)) url.searchParams.set("card", card);
  return `${url.pathname}${url.search}`;
}

/**
 * Saves the pending work before the editor leaves the clip: `{ ok: true }`, or `{ ok: false,
 * reason }` ("error", "conflict", "export") when it must stay. The store keeps showing its own
 * save error or conflict dialog; nothing is discarded.
 */
export async function saveBeforeLeaving({ flush, getState, exportPhase = null }) {
  if (EXPORT_SENDING.has(exportPhase)) return { ok: false, reason: "export" };
  for (let round = 0; round < SAVE_ROUNDS; round += 1) {
    if (getState()?.save === "conflict") return { ok: false, reason: "conflict" };
    let failure = null;
    try {
      await flush();
    } catch (error) {
      failure = error ?? new Error("flush failed");
    }
    const save = getState()?.save;
    if (save === "conflict") return { ok: false, reason: "conflict" };
    if (save === "error") return { ok: false, reason: "error" };
    if (!failure && save === "saved") return { ok: true };
    if (failure && !isRevisionConflict(failure)) return { ok: false, reason: "error" };
  }
  return { ok: false, reason: "error" };
}
