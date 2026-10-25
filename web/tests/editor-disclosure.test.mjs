// The "Lanjutan" fold of every panel group (rombak 06 §2.1 T2, §2.2 rule 3-4): its title sums up
// the fine values that differ from the AI version, as data ({key, values}, at most three, in a
// fixed order per group; the component turns them into text), and it is closed until the viewer
// opens it, remembered per viewer in localStorage when the browser allows it.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc } from "../components/editor/__dev__/fakes.mjs";
import {
  ADVANCED_GROUPS, DISCLOSURE_KEY, MAX_SUMMARY_ITEMS, advancedSummary, readDisclosure, writeDisclosure,
} from "../lib/editor/disclosure.mjs";

const seed = fakeDoc();
const keys = (summary) => summary.items.map((item) => item.key);
const edit = (change) => {
  const doc = structuredClone(seed);
  change(doc);
  return doc;
};
const hook = (doc) => doc.tracks.find((track) => track.kind === "hook").items[0];
const MUSIC = {
  id: "tr_music", kind: "audio", role: "music",
  items: [{ id: "it_music", type: "audio", start: { at: "clip_start" }, end: { at: "clip_end" },
    payload: { asset: "a_1", src_in_smp: 0, loop: true, gain_cdb: -1800, fade_in_f: 15, fade_out_f: 30,
      duck: { on: true, depth_cdb: 1000, attack_ms: 30, release_ms: 400, hold_ms: 250, detector: "words" } }, origin: "user" }],
};
const LOGO = {
  id: "tr_logo", kind: "visual", band: "over_text", role: "overlay",
  items: [{ id: "it_logo", type: "image", start: { at: "clip_start" }, end: { at: "clip_end" },
    transform: { x_e5: 80000, y_e5: 10000, w_e5: 16000, opacity_pm: 850 }, payload: { asset: "i_1", mode: "free" }, origin: "user" }],
};

test("the groups with a Lanjutan fold, and at most three summary items", () => {
  assert.deepEqual(ADVANCED_GROUPS, ["caption", "hook", "camera", "split", "music", "logo", "watermark"]);
  assert.equal(MAX_SUMMARY_ITEMS, 3);
});

test("the AI version itself sums up to no items in every group (the title then says Bawaan)", () => {
  for (const group of ADVANCED_GROUPS) assert.deepEqual(advancedSummary(group, seed, seed), { items: [] }, group);
  assert.deepEqual(advancedSummary("caption", structuredClone(seed), seed), { items: [] }, "a copy is equal too");
});

test("caption: entrance, words per line, fine size, fine position, case, keyword colour, in that order", () => {
  const doc = edit((d) => {
    d.captions.overrides = { ...d.captions.overrides, entrance: "pop", words_max: 2 };
  });
  assert.deepEqual(advancedSummary("caption", doc, seed), {
    items: [{ key: "entrance", values: { entrance: "pop" } }, { key: "wordsMax", values: { count: 2 } }],
  });
  const all = edit((d) => {
    d.captions.overrides = { ...d.captions.overrides, entrance: "fade", words_max: 1, size_pm: 1200, y_e5: 70000, case: "upper", emphasis: "#FFFFFF" };
  });
  const summary = advancedSummary("caption", all, seed);
  assert.deepEqual(keys(summary), ["entrance", "wordsMax", "size"], "three, the first ones in the group's order");
  assert.deepEqual(summary.items[2].values, { percent: 120 });
  const later = edit((d) => { d.captions.overrides = { ...d.captions.overrides, y_e5: 70000, case: "upper", emphasis: "#FFFFFF" }; });
  assert.deepEqual(advancedSummary("caption", later, seed).items, [
    { key: "position", values: { percent: 70 } }, { key: "case", values: { case: "upper" } }, { key: "emphasis", values: { color: "#FFFFFF" } },
  ]);
});

test("caption: the basic controls (on/off, pack, highlight) never show in the fold's summary", () => {
  const doc = edit((d) => {
    d.captions.enabled = false;
    d.captions.pack = { id: "bold", v: 1 };
    d.captions.overrides = { ...d.captions.overrides, highlight: "#FFFFFF" };
  });
  assert.deepEqual(advancedSummary("caption", doc, seed), { items: [] });
});

test("hook: design, duration in seconds, position; nothing while there is no hook", () => {
  const doc = edit((d) => {
    hook(d).payload.design = { id: "kicker", v: 1 };
    hook(d).dur_f = 90;
  });
  assert.deepEqual(advancedSummary("hook", doc, seed), {
    items: [{ key: "design", values: { design: "kicker" } }, { key: "duration", values: { seconds: 3 } }],
  });
  const moved = edit((d) => { hook(d).transform.y_e5 = 30000; });
  assert.deepEqual(advancedSummary("hook", moved, seed).items, [{ key: "position", values: { percent: 30 } }]);
  const none = edit((d) => { d.tracks = d.tracks.filter((track) => track.kind !== "hook"); });
  assert.deepEqual(advancedSummary("hook", none, seed), { items: [] });
});

test("camera (Ikuti wajah): framing points and zoom; split: both bands' zoom as one item", () => {
  const framed = edit((d) => {
    d.layout = { default: { mode: "camera", no_face: "center" }, keyframes: [{ sf: 37300, pan_e5: 20000, move: "cut" }, { sf: 37400, pan_e5: 70000, move: "slide" }], zoom_pm: 1100 };
  });
  assert.deepEqual(advancedSummary("camera", framed, seed), {
    items: [{ key: "keyframes", values: { count: 2 } }, { key: "zoom", values: { percent: 110 } }],
  });
  const split = edit((d) => {
    d.layout = { default: { mode: "split", no_face: "center" },
      split: { top_pm: 300, top: { x_e5: 50000, y_e5: 50000, zoom_pm: 1200 }, bottom: { x_e5: 50000, y_e5: 50000, zoom_pm: 1000 } } };
  });
  assert.deepEqual(advancedSummary("split", split, seed), { items: [{ key: "zoom", values: { top: 120, bottom: 100 } }] });
  const fresh = edit((d) => {
    d.layout = { default: { mode: "split", no_face: "center" },
      split: { top_pm: 500, top: { x_e5: 10000, y_e5: 50000, zoom_pm: 1000 }, bottom: { x_e5: 50000, y_e5: 50000, zoom_pm: 1000 } } };
  });
  assert.deepEqual(advancedSummary("split", fresh, seed), { items: [] }, "the ratio and the crop position are not the fold's");
});

test("music: loop, fades, start offset, ducking details, against the AI version or a new track's defaults", () => {
  const added = edit((d) => { d.tracks.push(structuredClone(MUSIC)); });
  assert.deepEqual(advancedSummary("music", added, seed), { items: [] }, "a new track at its defaults");
  const changed = edit((d) => {
    const music = structuredClone(MUSIC);
    Object.assign(music.items[0].payload, { loop: false, fade_in_f: 30, src_in_smp: 96000 });
    music.items[0].payload.duck = { ...music.items[0].payload.duck, attack_ms: 60, hold_ms: 0 };
    d.tracks.push(music);
  });
  const summary = advancedSummary("music", changed, seed);
  assert.deepEqual(summary.items, [
    { key: "loop", values: { on: false } },
    { key: "fade", values: { inSeconds: 1, outSeconds: 1 } },
    { key: "offset", values: { seconds: 2 } },
  ]);
  const duck = edit((d) => {
    const music = structuredClone(MUSIC);
    music.items[0].payload.duck = { ...music.items[0].payload.duck, depth_cdb: 2000, release_ms: 900 };
    d.tracks.push(music);
  });
  assert.deepEqual(advancedSummary("music", duck, seed).items, [{ key: "duck", values: { count: 1 } }],
    "the strength preset (depth) is a basic control; only attack, release and hold count");
  const gain = edit((d) => {
    const music = structuredClone(MUSIC);
    music.items[0].payload.gain_cdb = -600;
    d.tracks.push(music);
  });
  assert.deepEqual(advancedSummary("music", gain, seed), { items: [] }, "volume is a basic control");
});

test("logo: size and opacity; watermark: place, size, opacity, against DEFAULT_WATERMARK when the AI version has none", () => {
  const logo = edit((d) => {
    const track = structuredClone(LOGO);
    track.items[0].transform.w_e5 = 12000;
    track.items[0].transform.opacity_pm = 900;
    d.tracks.push(track);
  });
  assert.deepEqual(advancedSummary("logo", logo, seed).items, [
    { key: "size", values: { percent: 12 } }, { key: "opacity", values: { percent: 90 } },
  ]);
  const moved = edit((d) => {
    const track = structuredClone(LOGO);
    track.items[0].transform.x_e5 = 20000;
    d.tracks.push(track);
  });
  assert.deepEqual(advancedSummary("logo", moved, seed), { items: [] }, "the corner is a basic control");
  const plain = edit((d) => { d.watermark = { text: "@potongin", pos: "top_center", size_pm: 1000, opacity_pm: 850 }; });
  assert.deepEqual(advancedSummary("watermark", plain, seed), { items: [] });
  const placed = edit((d) => { d.watermark = { text: "@potongin", pos: "bottom_right", size_pm: 1500, opacity_pm: 500 }; });
  assert.deepEqual(advancedSummary("watermark", placed, seed).items, [
    { key: "position", values: { pos: "bottom_right" } }, { key: "size", values: { percent: 150 } }, { key: "opacity", values: { percent: 50 } },
  ]);
});

test("the summary changes after an edit and goes back to no items when the edit is undone", () => {
  const before = advancedSummary("caption", seed, seed);
  const doc = edit((d) => { d.captions.overrides = { ...d.captions.overrides, entrance: "blur" }; });
  const after = advancedSummary("caption", doc, seed);
  assert.notDeepEqual(after, before);
  assert.deepEqual(keys(after), ["entrance"]);
  assert.deepEqual(advancedSummary("caption", edit((d) => { d.captions.overrides = { ...seed.captions.overrides }; }), seed), before);
});

test("an unknown group, a missing document or a missing seed sums up to nothing and never throws", () => {
  assert.deepEqual(advancedSummary("nope", seed, seed), { items: [] });
  for (const group of ADVANCED_GROUPS) {
    assert.deepEqual(advancedSummary(group, null, seed), { items: [] }, group);
    assert.doesNotThrow(() => advancedSummary(group, seed, null), group);
  }
});

test("the fold is closed by default, remembered per group, and blocked storage only means closed", () => {
  assert.equal(DISCLOSURE_KEY, "potongin-editor-disclosure");
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  for (const group of ADVANCED_GROUPS) assert.equal(readDisclosure(storage, group), false, group);
  assert.equal(writeDisclosure(storage, "caption", true), true);
  assert.equal(readDisclosure(storage, "caption"), true);
  assert.equal(readDisclosure(storage, "hook"), false, "one group's state is its own");
  assert.equal(writeDisclosure(storage, "caption", false), true);
  assert.equal(readDisclosure(storage, "caption"), false);
  assert.deepEqual(JSON.parse(store.get(DISCLOSURE_KEY)), { caption: false });
  store.set(DISCLOSURE_KEY, "{not json");
  assert.equal(readDisclosure(storage, "caption"), false);
  assert.equal(writeDisclosure(storage, "hook", true), true, "a broken value is replaced");
  assert.equal(readDisclosure(storage, "hook"), true);
  store.set(DISCLOSURE_KEY, JSON.stringify({ caption: "yes" }));
  assert.equal(readDisclosure(storage, "caption"), false, "only a real true opens it");
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  assert.equal(readDisclosure(throwing, "caption"), false);
  assert.equal(writeDisclosure(throwing, "caption", true), false);
  assert.equal(readDisclosure(null, "caption"), false);
  assert.equal(writeDisclosure(storage, "nope", true), false, "an unknown group is not stored");
});
