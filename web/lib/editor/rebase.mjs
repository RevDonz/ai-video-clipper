// Rebase on 409 (plan §4.5): replay the pending semantic commands onto the server's current
// document, re-checking every precondition; auto-merge when every step holds, otherwise a
// per-part dialog ("Teks hook", "Potongan 00:12", "Caption kata 'Ijal'") with "Pakai punyaku" /
// "Pakai yang tersimpan". The draft is never discarded and the editor never locks.
//
// A document is seen as a set of *parts* (the conflict units): the body trim, the cold open, the
// removals of each segment, each word edit field, each caption setting, the hook fields, layout,
// logo, music and audio fields. A step conflicts when it changes a part the other tab changed
// too (removal lists excepted: removals merge semantically, and a replayed removal re-checks
// that it still fits), or when its preconditions fail on the new document. A conflict is shown
// only when the two final values really differ. Parts are grouped for the dialog (`partGroup`).
//
// Steps are `{ type, args, parts, entryId }` (a command) or `{ type: "__parts", values, parts }`
// (part values set as a whole: an undo past the last save, or a conflict resolution).
import { CommandRejected, applyCommand } from "./commands.mjs";
import {
  JOIN_STYLE_NAMES,
  TRACKS,
  body,
  checkDoc,
  coldOpen,
  coldOpenJoin,
  contentJson,
  deepEqual,
  documentIds,
  formatFrameTime,
  joinTemplate,
  nextId,
  segmentOf,
  trackOf,
} from "./doc-model.mjs";
import { pieces, srcToOut } from "./timemap.mjs";

const OVERRIDE_KEYS = ["y_e5", "size_pm", "case", "highlight", "emphasis"];
const WORD_FIELDS = ["text", "hidden", "emphasis"];

/**
 * Every fixed part, in the order parts are applied (word parts come after the captions). The
 * cold-open transition (join.style, join.sfx) comes right after the cold open it belongs to.
 */
export const PARTS = Object.freeze([
  "base", "coldopen", "join.style", "join.sfx", "trim", "removals:cold_open", "removals:body", "cut_fade",
  "captions.enabled", "captions.pack", ...OVERRIDE_KEYS.map((key) => `captions.override.${key}`),
  "hook.on", "hook.text", "hook.dur", "hook.y", "layout",
  "logo.asset", "logo.transform", "logo.opacity",
  "music.asset", "music.gain", "music.offset", "music.loop", "music.fades", "music.duck",
  "audio.source", "audio.master",
]);
const ORDER = new Map(PARTS.map((part, index) => [part, index]));
const WORD_ORDER = ORDER.get("captions.override.emphasis") + 0.5;

/** Dialog labels per group (plan §4.5). */
export const GROUP_LABELS = Object.freeze({
  base: "Versi klip",
  trim: "Awal/akhir klip",
  coldopen: "Cold open",
  join: "Transisi cold open",
  "removals:cold_open": "Potongan di cold open",
  "removals:body": "Potongan",
  cuts: "Fade potongan",
  captions: "Gaya caption",
  hook: "Teks hook",
  layout: "Tata letak",
  logo: "Logo",
  music: "Musik",
  audio: "Volume suara",
});

/** Parts that only make sense with another one: an item's fields need the item. */
const PREREQUISITES = Object.freeze({
  "hook.text": "hook.on", "hook.dur": "hook.on", "hook.y": "hook.on",
  "logo.transform": "logo.asset", "logo.opacity": "logo.asset",
  "music.gain": "music.asset", "music.offset": "music.asset", "music.loop": "music.asset",
  "music.fades": "music.asset", "music.duck": "music.asset",
  "removals:cold_open": "coldopen", "join.style": "coldopen", "join.sfx": "coldopen",
});
const JOIN_PARTS = Object.freeze(["join.style", "join.sfx"]);

/** The dialog group of a part: "hook.text" → "hook", "word:w048121.text" → "word:w048121". */
export function partGroup(part) {
  if (part.startsWith("word:")) return part.slice(0, part.lastIndexOf("."));
  if (part.startsWith("removals:")) return part;
  if (part === "cut_fade") return "cuts";
  if (part.startsWith("captions.")) return "captions";
  return part.split(".")[0];
}

function orderOf(part) {
  return part.startsWith("word:") ? WORD_ORDER : ORDER.get(part) ?? 99;
}

function item(doc, kind) {
  return trackOf(doc, kind)?.items[0] ?? null;
}

function withoutItems(track) {
  const { items: _items, ...rest } = track;
  return rest;
}

/** The value compared to detect a change of `part` (identity only for the whole-item parts). */
function identity(doc, part) {
  switch (part) {
    case "hook.on": {
      const track = trackOf(doc, "hook");
      if (!track) return null;
      const hook = track.items[0];
      return { track: withoutItems(track), id: hook?.id ?? null, type: hook?.type, start: hook?.start, x: hook?.transform?.x_e5,
        design: hook?.payload?.design };
    }
    case "logo.asset":
    case "music.asset": {
      const kind = part === "logo.asset" ? "visual" : "audio";
      const track = trackOf(doc, kind);
      if (!track) return null;
      const entry = track.items[0];
      const asset = entry?.payload?.asset ?? null;
      return { track: withoutItems(track), id: entry?.id ?? null, type: entry?.type, start: entry?.start, end: entry?.end,
        origin: entry?.origin, asset, mode: entry?.payload?.mode, meta: doc.assets[asset] ?? null };
    }
    // "No whoosh" and "no cold open" are both null as values; as a change they differ, so a
    // cold open added or removed always lists join.sfx and is rebuilt with its own sound.
    case "join.sfx": {
      const join = coldOpen(doc) ? doc.main.joins[0] : null;
      return join ? { sfx: join.sfx ?? null } : null;
    }
    default:
      return partValue(doc, part);
  }
}

/** The value of `part` in `doc` (JSON; `null` when the part does not exist). */
export function partValue(doc, part) {
  if (part.startsWith("word:")) {
    const dot = part.lastIndexOf(".");
    const edit = doc.captions.word_edits[part.slice(5, dot)];
    return edit?.[part.slice(dot + 1)] ?? null;
  }
  if (part.startsWith("removals:")) {
    const segment = segmentOf(doc, part.slice(9));
    return segment ? doc.main.removals.filter((removal) => removal.seg === segment.id) : [];
  }
  if (part.startsWith("captions.override.")) return doc.captions.overrides[part.slice(18)] ?? null;
  const hook = item(doc, "hook");
  const logo = item(doc, "visual");
  const music = item(doc, "audio");
  switch (part) {
    case "base": return { base: doc.base, output: doc.output, clip_id: doc.clip_id };
    case "trim": {
      const segment = body(doc);
      return segment ? { id: segment.id, in_sf: segment.in_sf, out_sf: segment.out_sf } : null;
    }
    case "coldopen": {
      const segment = coldOpen(doc);
      return segment ? { id: segment.id, in_sf: segment.in_sf, out_sf: segment.out_sf, fade: doc.main.joins[0]?.audio_fade_ms ?? 30 } : null;
    }
    case "join.style": return doc.main.joins[0]?.style ?? null;
    case "join.sfx": return doc.main.joins[0]?.sfx ?? null;
    case "cut_fade": return doc.main.cut_fade_ms;
    case "captions.enabled": return doc.captions.enabled;
    case "captions.pack": return doc.captions.pack;
    case "hook.on": return trackOf(doc, "hook");
    case "hook.text": return hook ? { text: hook.payload.text, origin: hook.origin } : null;
    case "hook.dur": return hook ? hook.dur_f : null;
    case "hook.y": return hook ? hook.transform.y_e5 : null;
    case "layout": return doc.layout.default;
    case "logo.asset":
    case "music.asset": {
      const track = trackOf(doc, part === "logo.asset" ? "visual" : "audio");
      const asset = track?.items[0]?.payload?.asset;
      return track ? { track, meta: doc.assets[asset] ?? null } : null;
    }
    case "logo.transform": return logo ? { x_e5: logo.transform.x_e5, y_e5: logo.transform.y_e5, w_e5: logo.transform.w_e5 } : null;
    case "logo.opacity": return logo ? logo.transform.opacity_pm : null;
    case "music.gain": return music ? music.payload.gain_cdb : null;
    case "music.offset": return music ? music.payload.src_in_smp : null;
    case "music.loop": return music ? music.payload.loop : null;
    case "music.fades": return music ? { fade_in_f: music.payload.fade_in_f, fade_out_f: music.payload.fade_out_f } : null;
    case "music.duck": return music ? music.payload.duck : null;
    case "audio.source": return doc.audio.source.gain_cdb;
    case "audio.master": return doc.audio.master;
    default: throw new TypeError(`unknown part ${part}`);
  }
}

/** `{ part: value }` for a list of parts. */
export function partValues(doc, parts) {
  return Object.fromEntries(parts.map((part) => [part, partValue(doc, part)]));
}

/** The parts whose value differs between two documents of the same clip, in apply order. */
export function diffParts(a, b) {
  const changed = [];
  for (const part of PARTS) {
    if (!deepEqual(identity(a, part), identity(b, part))) changed.push(part);
  }
  const editsA = a.captions.word_edits;
  const editsB = b.captions.word_edits;
  if (editsA !== editsB) {
    const ids = new Set([...Object.keys(editsA), ...Object.keys(editsB)]);
    for (const id of [...ids].sort()) {
      if (editsA[id] === editsB[id]) continue;
      for (const field of WORD_FIELDS) {
        if (!deepEqual(editsA[id]?.[field] ?? null, editsB[id]?.[field] ?? null)) changed.push(`word:${id}.${field}`);
      }
    }
  }
  return changed.sort((x, y) => orderOf(x) - orderOf(y));
}

// --- setting parts -------------------------------------------------------------------------

function reject(code) {
  throw new CommandRejected(code);
}

function putTrack(doc, track) {
  const tracks = doc.tracks.filter((entry) => entry.kind !== track.kind);
  const at = tracks.findIndex((entry) => (TRACKS[entry.kind]?.order ?? 9) > TRACKS[track.kind].order);
  tracks.splice(at < 0 ? tracks.length : at, 0, track);
  return { ...doc, tracks };
}

function dropTrack(doc, kind) {
  return { ...doc, tracks: doc.tracks.filter((track) => track.kind !== kind) };
}

function setItem(doc, kind, patch, missing) {
  const track = trackOf(doc, kind);
  if (!track?.items.length) reject(missing);
  const next = { ...track, items: [{ ...track.items[0], ...patch(track.items[0]) }] };
  return { ...doc, tracks: doc.tracks.map((entry) => (entry === track ? next : entry)) };
}

function setJoin(doc, join) {
  return { ...doc, main: { ...doc.main, joins: [join] } };
}

function setPart(doc, part, value, assets, ctx) {
  if (part.startsWith("word:")) {
    const dot = part.lastIndexOf(".");
    const id = part.slice(5, dot);
    const field = part.slice(dot + 1);
    const next = { ...(doc.captions.word_edits[id] ?? {}) };
    if (value === null) delete next[field];
    else next[field] = value;
    const edits = { ...doc.captions.word_edits };
    if (Object.keys(next).length) edits[id] = next;
    else delete edits[id];
    return { ...doc, captions: { ...doc.captions, word_edits: edits } };
  }
  if (part.startsWith("captions.override.")) {
    return { ...doc, captions: { ...doc.captions, overrides: { ...doc.captions.overrides, [part.slice(18)]: value } } };
  }
  switch (part) {
    case "base": return { ...doc, base: value.base, output: value.output, clip_id: value.clip_id };
    case "trim": {
      const segment = body(doc);
      if (!segment || !value) return reject("range_invalid");
      const next = { ...segment, in_sf: value.in_sf, out_sf: value.out_sf };
      return { ...doc, main: { ...doc.main, segments: doc.main.segments.map((entry) => (entry === segment ? next : entry)) } };
    }
    case "coldopen": {
      const current = coldOpen(doc);
      if (!value) {
        if (!current) return doc;
        return { ...doc, main: { ...doc.main, segments: doc.main.segments.filter((entry) => entry !== current),
          removals: doc.main.removals.filter((removal) => removal.seg !== current.id), joins: [] } };
      }
      const used = documentIds(doc);
      if (current) used.delete(current.id);
      const id = used.has(value.id) ? nextId(used, "seg") : value.id;
      const segment = { id, role: "cold_open", in_sf: value.in_sf, out_sf: value.out_sf };
      const removals = current && current.id !== id
        ? doc.main.removals.map((removal) => (removal.seg === current.id ? { ...removal, seg: id } : removal)) : doc.main.removals;
      // The current join keeps its transition; a new cold open gets SetColdOpen's template.
      const join = coldOpenJoin(id, value.fade, joinTemplate(doc, ctx?.seed ?? null));
      return { ...doc, main: { ...doc.main, segments: [segment, ...doc.main.segments.filter((entry) => entry.role !== "cold_open")],
        removals, joins: [join] } };
    }
    case "join.style": {
      if (value === null) return doc;
      if (!coldOpen(doc)) return reject("cold_open_missing");
      return setJoin(doc, { ...doc.main.joins[0], style: value });
    }
    case "join.sfx": {
      const join = coldOpen(doc) ? doc.main.joins[0] : null;
      if (value === null) {
        if (!join || !Object.hasOwn(join, "sfx")) return doc;
        const { sfx: _sfx, ...rest } = join;
        return setJoin(doc, rest);
      }
      if (!join) return reject("cold_open_missing");
      return setJoin(doc, { ...join, sfx: { ...value } });
    }
    case "cut_fade": return { ...doc, main: { ...doc.main, cut_fade_ms: value } };
    case "captions.enabled": return { ...doc, captions: { ...doc.captions, enabled: value } };
    case "captions.pack": return { ...doc, captions: { ...doc.captions, pack: value } };
    case "hook.on": return value ? putTrack(doc, value) : dropTrack(doc, "hook");
    case "hook.text": return value === null ? doc : setItem(doc, "hook", (hook) => ({ payload: { ...hook.payload, text: value.text }, origin: value.origin }), "hook_missing");
    case "hook.dur": return value === null ? doc : setItem(doc, "hook", () => ({ dur_f: value }), "hook_missing");
    case "hook.y": return value === null ? doc : setItem(doc, "hook", (hook) => ({ transform: { ...hook.transform, y_e5: value } }), "hook_missing");
    case "layout": return { ...doc, layout: { ...doc.layout, default: value } };
    case "logo.asset":
    case "music.asset": {
      const kind = part === "logo.asset" ? "visual" : "audio";
      if (!value) return dropTrack(doc, kind);
      const asset = value.track.items[0]?.payload?.asset;
      if (asset && value.meta) assets[asset] = value.meta;
      return putTrack(doc, value.track);
    }
    case "logo.transform": return value === null ? doc : setItem(doc, "visual", (logo) => ({ transform: { ...logo.transform, ...value } }), "logo_missing");
    case "logo.opacity": return value === null ? doc : setItem(doc, "visual", (logo) => ({ transform: { ...logo.transform, opacity_pm: value } }), "logo_missing");
    case "music.gain": return musicField(doc, value, { gain_cdb: value });
    case "music.offset": return musicField(doc, value, { src_in_smp: value });
    case "music.loop": return musicField(doc, value, { loop: value });
    case "music.fades": return musicField(doc, value, value);
    case "music.duck": return musicField(doc, value, { duck: value });
    case "audio.source": return { ...doc, audio: { ...doc.audio, source: { ...doc.audio.source, gain_cdb: value } } };
    case "audio.master": return { ...doc, audio: { ...doc.audio, master: value } };
    default: throw new TypeError(`unknown part ${part}`);
  }
}

function musicField(doc, value, patch) {
  if (value === null) return doc;
  return setItem(doc, "audio", (music) => ({ payload: { ...music.payload, ...patch } }), "music_missing");
}

/** Clamps removals to their segments, drops orphans, sorts them and syncs `assets`. */
function normalize(doc, assets) {
  const order = new Map(doc.main.segments.map((segment, index) => [segment.id, index]));
  const bySegment = new Map(doc.main.segments.map((segment) => [segment.id, segment]));
  const removals = [];
  for (const removal of doc.main.removals) {
    const segment = bySegment.get(removal.seg);
    if (!segment) continue;
    const inSf = Math.max(removal.in_sf, segment.in_sf);
    const outSf = Math.min(removal.out_sf, segment.out_sf);
    if (inSf >= outSf) continue;
    removals.push(inSf === removal.in_sf && outSf === removal.out_sf ? removal : { ...removal, in_sf: inSf, out_sf: outSf });
  }
  removals.sort((a, b) => order.get(a.seg) - order.get(b.seg) || a.in_sf - b.in_sf);
  const merged = [];
  for (const removal of removals) {
    const last = merged.at(-1);
    if (last && last.seg === removal.seg && removal.in_sf < last.out_sf) reject("removal_overlap");
    merged.push(removal);
  }
  const referenced = {};
  for (const track of doc.tracks) {
    for (const entry of track.items) {
      const asset = entry.payload?.asset;
      if (typeof asset === "string") referenced[asset] = assets[asset] ?? doc.assets[asset] ?? reject("asset_missing");
    }
  }
  const sameRemovals = merged.length === doc.main.removals.length && merged.every((removal, index) => removal === doc.main.removals[index]);
  const next = sameRemovals ? doc : { ...doc, main: { ...doc.main, removals: merged } };
  return deepEqual(referenced, doc.assets) ? next : { ...next, assets: referenced };
}

/**
 * Replaces the removal lists of whole segments (`{ role: removals }`) at once, so an id is only
 * renamed when it collides with something that stays (never with a list being replaced).
 */
function setRemovalLists(doc, lists) {
  const replaced = new Map();
  for (const [role, value] of Object.entries(lists)) {
    const segment = segmentOf(doc, role);
    if (!segment) {
      if (value.length) reject("removal_outside_segment");
      continue;
    }
    replaced.set(segment.id, value);
  }
  if (!replaced.size) return doc;
  const kept = doc.main.removals.filter((removal) => !replaced.has(removal.seg));
  const used = documentIds({ ...doc, main: { ...doc.main, removals: kept } });
  const added = [];
  for (const [segId, value] of replaced) {
    for (const removal of value) {
      const id = used.has(removal.id) ? nextId(used, "rm") : removal.id;
      used.add(id);
      added.push({ ...removal, id, seg: segId });
    }
  }
  return { ...doc, main: { ...doc.main, removals: [...kept, ...added] } };
}

/**
 * Sets whole part values (a "__parts" step), then fixes removals and assets and checks the
 * document rules; throws CommandRejected when the result would be invalid.
 */
export function applyParts(doc, values, ctx) {
  const assets = {};
  const lists = {};
  let next = doc;
  for (const part of Object.keys(values).sort((a, b) => orderOf(a) - orderOf(b))) {
    if (part.startsWith("removals:")) lists[part.slice(9)] = values[part];
    else next = setPart(next, part, values[part], assets, ctx);
  }
  next = setRemovalLists(next, lists);
  next = normalize(next, assets);
  const issues = checkDoc(next, ctx);
  if (issues.length) throw new CommandRejected(issues[0].code, { path: issues[0].path });
  return next;
}

function applyStep(doc, step, ctx, idMap = null) {
  if (step.type === "__parts") return { doc: applyParts(doc, step.values, ctx), args: step.args };
  const args = idMap ? remapArgs(step, idMap) : step.args;
  const result = applyCommand(doc, step.type, args, ctx);
  if (idMap) recordIds(step.args, result.args, idMap);
  return result;
}

/** Replays steps onto `doc`; throws CommandRejected (detail.step) when one no longer applies. */
export function replaySteps(doc, steps, ctx) {
  let current = doc;
  const replayed = [];
  steps.forEach((step, index) => {
    try {
      const result = applyStep(current, step, ctx);
      current = result.doc;
      replayed.push(step.type === "__parts" ? step : { ...step, args: result.args });
    } catch (error) {
      if (error instanceof CommandRejected) throw new CommandRejected(error.code, { ...error.detail, step: index });
      throw error;
    }
  });
  return { doc: current, steps: replayed };
}

function remapArgs(step, idMap) {
  const map = (id) => idMap.get(id) ?? id;
  const args = step.args;
  if (!args || typeof args !== "object") return args;
  if (step.type === "RestoreRemoval") return { ...args, removalId: map(args.removalId) };
  if (step.type === "ApplyCleanup") return { ...args, items: args.items.map((entry) => ({ ...entry, removalId: map(entry.removalId) })) };
  if (args.id !== undefined) return { ...args, id: map(args.id) };
  return args;
}

function recordIds(before, after, idMap) {
  if (!before || !after) return;
  if (before.id !== undefined && after.id !== undefined && before.id !== after.id) idMap.set(before.id, after.id);
  if (Array.isArray(before.items) && Array.isArray(after.items)) {
    before.items.forEach((entry, index) => {
      const next = after.items[index]?.removalId;
      if (entry.removalId !== undefined && next !== undefined && entry.removalId !== next) idMap.set(entry.removalId, next);
    });
  }
}

// --- rebase ----------------------------------------------------------------------------------

function strictParts(step) {
  const whole = step.type === "__parts" || step.type === "ResetToSeed";
  return (step.parts ?? []).filter((part) => whole || !part.startsWith("removals:"));
}

function removalLabel(mine, theirs, role, fps) {
  const segment = segmentOf(mine, role);
  if (!segment) return GROUP_LABELS[`removals:${role}`];
  const ours = partValue(mine, `removals:${role}`);
  const saved = partValue(theirs, `removals:${role}`);
  const first = ours.find((removal) => !saved.some((other) => deepEqual(other, removal)))
    ?? saved.find((removal) => !ours.some((other) => deepEqual(other, removal)));
  if (!first || role !== "body") return GROUP_LABELS[`removals:${role}`];
  const list = pieces(mine).filter((piece) => piece.seg === segment.id);
  const frame = srcToOut(first.out_sf, list) ?? srcToOut(first.in_sf - 1, list) ?? 0;
  return `Potongan ${formatFrameTime(frame, fps)}`;
}

function describe(doc, group, ctx) {
  const fps = ctx.fps;
  if (group.startsWith("word:")) {
    const id = group.slice(5);
    const edit = doc.captions.word_edits[id] ?? {};
    const text = edit.text ?? ctx.word(id)?.t ?? id;
    return `${text}${edit.hidden ? " (disembunyikan)" : ""}${edit.emphasis ? " (kata kunci)" : ""}`;
  }
  if (group.startsWith("removals:")) {
    const list = partValue(doc, group);
    return list.length ? `${list.length} potongan` : "Tanpa potongan";
  }
  switch (group) {
    case "trim": {
      const segment = body(doc);
      return `${formatFrameTime(segment.in_sf, fps)}–${formatFrameTime(segment.out_sf, fps)} sumber`;
    }
    case "coldopen": {
      const segment = coldOpen(doc);
      return segment ? `${formatFrameTime(segment.out_sf - segment.in_sf, fps)} dari ${formatFrameTime(segment.in_sf, fps)}` : "Tanpa cold open";
    }
    case "join": {
      const join = coldOpen(doc) ? doc.main.joins[0] : null;
      if (!join) return "Tanpa cold open";
      return `${JOIN_STYLE_NAMES[join.style] ?? join.style}${join.sfx ? " + whoosh" : ""}`;
    }
    case "captions": return `${doc.captions.enabled ? doc.captions.pack.id : "caption mati"}`;
    case "hook": return item(doc, "hook")?.payload.text ?? "Hook mati";
    case "layout": return doc.layout.default.mode;
    case "logo": return item(doc, "visual") ? "Dengan logo" : "Tanpa logo";
    case "music": return item(doc, "audio") ? "Dengan musik" : "Tanpa musik";
    case "audio": return `Suara ${doc.audio.source.gain_cdb / 100} dB, ${doc.audio.master.mode}`;
    case "cuts": return `${doc.main.cut_fade_ms} ms`;
    default: return "";
  }
}

function groupLabel(group, mine, theirs, ctx) {
  if (group.startsWith("word:")) {
    const id = group.slice(5);
    const text = mine.captions.word_edits[id]?.text ?? theirs.captions.word_edits[id]?.text ?? ctx.word(id)?.t ?? id;
    return `Caption kata '${text}'`;
  }
  if (group.startsWith("removals:")) return removalLabel(mine, theirs, group.slice(9), ctx.fps);
  return GROUP_LABELS[group] ?? group;
}

/**
 * Replays `steps` (the pending log from `base` to `mine`) onto `theirs`, the server's current
 * document. Returns `{ status: "merged", doc, steps }` or `{ status: "conflict", doc, steps,
 * conflicts, resolve(choices) }` where `doc`/`steps` hold every step that still applies,
 * `conflicts` is `[{ id, label, parts, mine, theirs }]` and `resolve({ [id]: "mine" | "theirs" })`
 * (default "mine") returns `{ doc, steps }` or throws CommandRejected when the combination is
 * invalid (choosing "theirs" everywhere never throws).
 */
export function rebase({ base, mine, theirs, steps, ctx }) {
  if (contentJson(theirs) === contentJson(mine)) return { status: "merged", doc: theirs, steps: [], conflicts: [] };
  const theirsChanged = new Set(diffParts(base, theirs));
  const conflictParts = new Set();
  const idMap = new Map();
  let doc = theirs;
  const replayed = [];
  for (const step of steps) {
    if (strictParts(step).some((part) => theirsChanged.has(part))) {
      for (const part of step.parts ?? []) conflictParts.add(part);
      continue;
    }
    // ResetToSeed is replayed as the parts it changed (a whole reset would undo the other tab's
    // edits) and logged that way, so that a later replay of the rebased log gives the same result.
    const asParts = step.type === "ResetToSeed" ? { type: "__parts", values: partValues(ctx.seed, step.parts ?? []) } : null;
    let result;
    try {
      result = asParts ? { doc: applyParts(doc, asParts.values, ctx) } : applyStep(doc, step, ctx, idMap);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      for (const part of step.parts ?? []) conflictParts.add(part);
      continue;
    }
    const touched = diffParts(doc, result.doc);
    const sideEffects = touched.filter((part) => !(step.parts ?? []).includes(part) && !part.startsWith("removals:") && theirsChanged.has(part));
    if (sideEffects.length) {
      for (const part of [...(step.parts ?? []), ...sideEffects]) conflictParts.add(part);
      continue;
    }
    doc = result.doc;
    if (!touched.length) continue;
    if (asParts) replayed.push({ ...asParts, parts: touched, entryId: step.entryId });
    else replayed.push({ ...step, args: result.args, parts: touched });
  }
  const differs = (part) => !deepEqual(partValue(doc, part), partValue(mine, part));
  const remaining = [...conflictParts].filter(differs).sort((a, b) => orderOf(a) - orderOf(b));
  if (!remaining.length) return { status: "merged", doc, steps: replayed, conflicts: [] };
  const groups = new Map();
  const add = (group, part) => {
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(part);
  };
  for (const part of remaining) {
    // "Pakai punyaku" must be able to apply: a field needs its item, a cold-open cut its cold open.
    const needs = PREREQUISITES[part];
    if (needs && (partValue(doc, needs) === null) !== (partValue(mine, needs) === null)) {
      const group = partGroup(needs);
      add(group, needs);
      add(group, part);
    } else add(partGroup(part), part);
  }
  // A cold open that one side has and the other does not: "Pakai punyaku" brings back mine with
  // its own transition (not the template's), "Pakai yang tersimpan" keeps theirs.
  if (groups.has("coldopen") && (partValue(doc, "coldopen") === null) !== (partValue(mine, "coldopen") === null)) {
    for (const part of JOIN_PARTS) if (differs(part)) add("coldopen", part);
  }
  for (const [group, parts] of groups) groups.set(group, [...parts].sort((a, b) => orderOf(a) - orderOf(b)));
  const conflicts = [...groups.entries()].map(([id, parts]) => ({
    id, label: groupLabel(id, mine, theirs, ctx), parts,
    mine: describe(mine, id, ctx), theirs: describe(doc, id, ctx),
  }));
  const merged = doc;
  return {
    status: "conflict", doc, steps: replayed, conflicts,
    resolve(choices = {}) {
      const values = {};
      for (const group of conflicts) {
        const choice = choices[group.id] ?? "mine";
        if (choice !== "mine" && choice !== "theirs") throw new CommandRejected("invalid_args", { group: group.id });
        if (choice === "mine") for (const part of group.parts) values[part] = partValue(mine, part);
      }
      if (!Object.keys(values).length) return { doc: merged, steps: replayed };
      const resolved = applyParts(merged, values, ctx);
      const parts = [...new Set([...Object.keys(values), ...diffParts(merged, resolved)])].sort((a, b) => orderOf(a) - orderOf(b));
      return { doc: resolved, steps: [...replayed, { type: "__parts", values, parts, resolve: true }] };
    },
  };
}
