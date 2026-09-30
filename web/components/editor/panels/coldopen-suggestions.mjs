// The Cold open panel's suggestions (plan §7.2, §11.3 T3.7): the route's candidates, read
// defensively, and each one seen against the current document. A view says what to show (label,
// reason, text, length), whether "Pakai" can apply it now (the §3.4 rules of the transcript
// model: a trim can make a candidate repeat the opening), whether it already is the cold open,
// and the output frames where "Putar" plays it: the cold open itself, or the body where the clip
// shows those source frames. Pure, except `resolveEditorApi`, which picks the API client.
import { createApiClient } from "../../../lib/editor/api-client.mjs";
import { coldOpenCheck, coldOpenInfo, formatDuration } from "../transcript/model.mjs";

export const SOURCE_LABELS = Object.freeze({ selection: "Cold open awal", hook: "Kalimat hook", strong: "Kalimat kuat" });
const ID = /^[a-z]{2,3}_[0-9a-z]{1,16}$/;
const WORD = /^w[0-9]{6,7}$/;
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const indexCache = new WeakMap();

/** The candidates of a route answer (or of the fakes' shorter shape); malformed ones dropped. */
export function readCandidates(json) {
  const list = Array.isArray(json?.candidates) ? json.candidates : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item.id !== "string" || !ID.test(item.id)) continue;
    if (typeof item.firstWord !== "string" || !WORD.test(item.firstWord)) continue;
    if (typeof item.lastWord !== "string" || !WORD.test(item.lastWord)) continue;
    out.push({
      id: item.id, source: Object.hasOwn(SOURCE_LABELS, item.source) ? item.source : null,
      firstWord: item.firstWord, lastWord: item.lastWord, inSf: count(item.inSf), outSf: count(item.outSf),
      frames: count(item.frames), durMs: count(item.durMs),
      unitIds: Array.isArray(item.unitIds) ? item.unitIds.filter((unit) => typeof unit === "string") : [],
      text: typeof item.text === "string" ? item.text : null, question: item.question === true,
      laughTail: item.laughTail === true, reason: typeof item.reason === "string" ? item.reason : null,
    });
  }
  return out;
}

function wordIndex(words) {
  if (!indexCache.has(words)) indexCache.set(words, new Map(words.words.map((word, index) => [word.id, index])));
  return indexCache.get(words);
}

/** Output frames `[f0, f1)` where the body shows source frames `[inSf, outSf)`, or null. */
function bodyRange(pieces, inSf, outSf) {
  let f0 = null;
  let f1 = null;
  for (const piece of pieces) {
    const a = Math.max(inSf, piece.inSf);
    const b = Math.min(outSf, piece.outSf);
    if (a >= b) continue;
    f0 ??= piece.outF0 + (a - piece.inSf);
    f1 = piece.outF0 + (b - piece.inSf);
  }
  return f0 === null ? null : { f0, f1 };
}

/**
 * One view per candidate whose words this artifact knows, in the route's order. A candidate is
 * the current cold open when it has the same frames, or the same words: the seed's own cold open
 * was cut from the selection's times, not from word gaps, and still is that sentence.
 */
export function candidateViews({ candidates, model }) {
  const index = wordIndex(model.words);
  const info = coldOpenInfo(model);
  const views = [];
  for (const candidate of candidates) {
    const first = index.get(candidate.firstWord);
    const last = index.get(candidate.lastWord);
    if (first === undefined || last === undefined || last < first) continue;
    const check = coldOpenCheck(model, first, last);
    if (!Number.isInteger(check.inSf) || !Number.isInteger(check.outSf)) continue;
    const sameFrames = Boolean(model.coldOpen) && model.coldOpen.in_sf === check.inSf && model.coldOpen.out_sf === check.outSf;
    const current = sameFrames || (info !== null && info.firstIndex === first && info.lastIndex === last);
    const coFrames = model.coPieces.reduce((sum, piece) => sum + piece.frames, 0);
    const audition = current ? { f0: 0, f1: coFrames } : bodyRange(model.bodyPieces, check.inSf, check.outSf);
    views.push({
      id: candidate.id, number: views.length + 1, source: candidate.source,
      label: SOURCE_LABELS[candidate.source] ?? "Saran", reason: candidate.reason ?? "",
      text: model.states.slice(first, last + 1).map((state) => state.text).join(" "),
      frames: check.frames, duration: formatDuration(check.frames, model.fps),
      current, ok: check.ok && !current, blockReason: current ? "Sedang dipakai sebagai cold open" : check.ok ? null : check.reason,
      audition, auditionReason: audition ? null : "Bagian ini sudah dipotong dari klip",
      command: { type: "SetColdOpen", args: { firstWord: candidate.firstWord, lastWord: candidate.lastWord }, mergeKey: null },
    });
  }
  return views;
}

/**
 * The API client for the suggestions: the one the shell passes, else the fake runtime's (its
 * dev hook), else a client for the store's clip; null when the ids are not valid.
 */
export function resolveEditorApi({ api = null, state = null, global = globalThis } = {}) {
  if (api && typeof api.coldOpenSuggestions === "function") return api;
  const fake = global?.__potonginEditor?.api;
  if (fake && typeof fake.coldOpenSuggestions === "function") return fake;
  try {
    return createApiClient({ jobId: state?.jobId, clipId: state?.clipId });
  } catch {
    return null;
  }
}
