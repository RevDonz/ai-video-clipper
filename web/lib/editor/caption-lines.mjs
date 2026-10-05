// Teks caption: the caption lines of Mode Cepat as rows of word ids (docs/plans/
// 2026-10-02-editor-mode-cepat.md §2). Rows follow the plan's cues, so the grouping is always the
// engine's; the document's hidden words leave a row at once, before the next plan arrives.
// A line edit becomes word edits (EditWordText, SetWordHidden): word ids and times come only from
// the words artifact, so timing never moves. Pure: no DOM, no store.
//
// Z0 lands `captionRows` and `linesSummary`; task C builds `lineEdit`, `checkCommands` and
// `focusAfterRegroup` (§2.3–§2.5) and owns this file from then on.

const keptCache = new WeakMap();

function editsOf(doc) {
  return doc?.captions?.word_edits ?? {};
}

/** The plan piece whose output range `[outF0, outF0 + frames)` holds frame `f`. */
function pieceAt(pieces, f) {
  let before = null;
  for (const piece of pieces) {
    if (piece.outF0 <= f && f < piece.outF0 + piece.frames) return piece;
    if (piece.outF0 <= f) before = piece;
  }
  return before ?? pieces[0] ?? null;
}

/** Word ids the cuts keep in segment `seg`, in word order (from the transcript model). */
function keptIds(model, seg) {
  if (!keptCache.has(model)) keptCache.set(model, new Map());
  const bySeg = keptCache.get(model);
  if (!bySeg.has(seg)) {
    let ids = [];
    if (seg !== null && seg === model.coldOpen?.id) ids = model.states.filter((state) => state.cold).map((state) => state.id);
    else if (seg !== null && seg === model.body?.id) {
      ids = model.states.filter((state) => state.zone === "body" && state.removal === null).map((state) => state.id);
    }
    bySeg.set(seg, ids);
  }
  return bySeg.get(seg);
}

// The caption-hidden words between the row's visible words and next to them, up to the
// neighbouring visible word on each side, among the words the segment keeps.
function hiddenNeighbours(model, seg, visible, isHidden) {
  if (!model || !Array.isArray(model.states)) return [];
  const kept = keptIds(model, seg);
  const position = new Map(kept.map((id, index) => [id, index]));
  const found = visible.map((id) => position.get(id)).filter((index) => index !== undefined);
  if (!found.length) return [];
  const lo = Math.min(...found);
  const hi = Math.max(...found);
  let first = lo;
  while (first > 0 && isHidden(kept[first - 1])) first -= 1;
  let last = hi;
  while (last < kept.length - 1 && isHidden(kept[last + 1])) last += 1;
  return kept.slice(first, last + 1).filter(isHidden);
}

/**
 * One row per `plan.cues` entry, in order (§2.1):
 * `{ key, seg, cold, f0, f1, wordIds, hiddenIds, text, edited }`.
 * `words` is the words artifact (`state.words`); `model` is `buildTranscriptModel(words, doc)`.
 * Without `model`, `hiddenIds` is empty: only the model knows which hidden words the cuts keep.
 */
export function captionRows({ plan, doc, words, model = null } = {}) {
  if (!plan || !Array.isArray(plan.cues) || !doc || !Array.isArray(words?.words)) return [];
  const asr = new Map(words.words.map((word) => [word.id, word.t]));
  const edits = editsOf(doc);
  const isHidden = (id) => edits[id]?.hidden === true;
  const textOf = (id) => (typeof edits[id]?.text === "string" ? edits[id].text : asr.get(id));
  const pieces = Array.isArray(plan.pieces) ? plan.pieces : [];
  const rows = [];
  for (const cue of plan.cues) {
    const ids = Array.isArray(cue.words) ? cue.words : [];
    const visible = ids.filter((id) => asr.has(id) && !isHidden(id));
    if (!visible.length) continue;
    const piece = pieceAt(pieces, cue.f0);
    const seg = piece?.seg ?? null;
    rows.push({
      key: `${seg}:${ids[0]}`,
      seg,
      cold: piece?.role === "cold_open",
      f0: cue.f0,
      f1: cue.f1,
      wordIds: visible,
      hiddenIds: hiddenNeighbours(model, seg, visible, isHidden),
      text: visible.map(textOf).join(" "),
      edited: visible.some((id) => textOf(id) !== asr.get(id)),
    });
  }
  return rows;
}

/** The Teks caption card's summary (§1.3): "12 baris", "12 baris · 2 diubah", "Caption mati" or "Menyiapkan…". */
export function linesSummary({ plan, doc, words } = {}) {
  if (doc?.captions?.enabled === false) return "Caption mati";
  if (!doc || !plan || !Array.isArray(words?.words)) return "Menyiapkan…";
  const rows = captionRows({ plan, doc, words });
  const edited = rows.filter((row) => row.edited).length;
  return edited ? `${rows.length} baris · ${edited} diubah` : `${rows.length} baris`;
}

function notBuilt() {
  throw new Error("not built");
}

/** §2.3: a row's draft → `{ ok: true, commands }` or `{ ok: false, code, message }` (task C). */
export function lineEdit() {
  return notBuilt();
}

/** §2.5: folds the commands over the document; the first refusal refuses them all (task C). */
export function checkCommands() {
  return notBuilt();
}

/** §2.5: the row to focus when the focused row's key is gone after regrouping (task C). */
export function focusAfterRegroup() {
  return notBuilt();
}
