// Synthetic words artifacts and seed documents for the transcript e2e harness (T2.7).
// Dev and test only: nothing in the app imports this file. Everything is deterministic.
//
// - "demo": a hand-written Indonesian conversation of 8 sentence units, with a context sentence
//   before and after the clip body, a ~5 s ramble (QG-UX U2) and a seed cold open (U3).
// - "long1500": 1,500 generated words (a 420 s window: 60 s of context, a 300 s body, the rest
//   after), the size of the performance gate "a command on a 1,500-word window ≤ 16 ms".
import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeSha256 } from "../../__dev__/fakes.mjs";

export const FPS = Object.freeze([30000, 1001]);

const DEMO_UNITS = [
  { id: "S0001", text: "Oke jadi kita lanjut ke cerita berikutnya ya.", q: false },
  { id: "S0002", text: "Kenapa sutradara ditahan di film sendiri?", q: true },
  { id: "S0003", text: "Jadi waktu itu kita datang subuh ke lokasi syuting.", q: false },
  { id: "S0004", text: "Eh maksud saya bukan subuh sih tapi ya pokoknya pagi banget lah gitu kan kita semua masih ngantuk.", q: false },
  { id: "S0005", text: "Security-nya nggak kenal saya sama sekali.", q: false },
  { id: "S0006", text: "Dia bilang mas mau kemana, ini lokasi tertutup.", q: false },
  { id: "S0007", text: "Saya bilang saya sutradaranya, dia ketawa aja.", q: false },
  { id: "S0008", text: "Terus habis itu kita lanjut syuting lagi.", q: false },
];

/** Demo units by role, for the specs (indices into DEMO_UNITS). */
export const DEMO = Object.freeze({
  contextBefore: 0, bodyFirst: 1, ramble: 3, seedColdOpen: 4, newColdOpen: 5, bodyLast: 6, contextAfter: 7,
});

const sfFloor = (ms) => Math.floor((ms * FPS[0]) / (1000 * FPS[1]));

// A small LCG so generated data is identical on every run.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function artifact(list, units, { windowMs }) {
  const bounds = [{ after: null, before: list[0].id, sf: sfFloor(list[0].s), tight: false, rms_cdb: null }];
  for (let i = 1; i < list.length; i += 1) {
    const mid = Math.floor((list[i - 1].e + list[i].s) / 2);
    bounds.push({ after: list[i - 1].id, before: list[i].id, sf: sfFloor(mid), tight: false, rms_cdb: -5200 });
  }
  bounds.push({ after: list.at(-1).id, before: null, sf: sfFloor(list.at(-1).e) + 1, tight: false, rms_cdb: null });
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].s - list[i - 1].e > 600) gaps.push({ after: list[i - 1].id, s: list[i - 1].e, e: list[i].s, class: "voiced" });
  }
  return {
    schema: "potongin.words/1", clip_id: FAKE_CLIP_ID, transcript_sha256: fakeSha256(`transcript:${list.length}`),
    fps: [...FPS], window_ms: windowMs, words: list, units, bounds, gaps, events: [], silences: [], scene_cuts_ms: [],
    peaks: { file: `peaks.${fakeSha256("peaks").slice(0, 16)}.bin`, per_sec: 100, start_ms: windowMs[0] },
    missing: ["sound_events"],
  };
}

/** The demo words artifact (about 70 words, 8 sentence units). */
export function demoWords() {
  const list = [];
  const units = [];
  let t = 1_000_000;
  let index = 48_000;
  for (const unit of DEMO_UNITS) {
    const first = list.length;
    for (const token of unit.text.split(" ")) {
      const duration = Math.min(560, 110 + 28 * token.length);
      list.push({ id: `w${String(index).padStart(6, "0")}`, s: t, e: t + duration, t: token,
        p_pm: token === "Security-nya" ? 410 : 920, u: unit.id, z: false });
      index += 1;
      t += duration + 40;
    }
    units.push({ id: unit.id, s: list[first].s, e: list.at(-1).e, q: unit.q });
    t += 520;
  }
  return artifact(list, units, { windowMs: [list[0].s - 30_000, list.at(-1).e + 30_000] });
}

const VOCAB = ("jadi kita itu yang dan ini ada saya kamu dia mereka sudah belum kalau karena terus "
  + "waktu film cerita lokasi syuting pagi malam orang teman kerja rumah jalan besar kecil baru lama "
  + "banget sekali memang bisa harus mau pernah selalu kadang tiba-tiba akhirnya ternyata katanya").split(" ");

/** 1,500 generated words: 60 s before the body, a 300 s body and the rest after it. */
export function longWords(count = 1500) {
  const random = lcg(20260925);
  const list = [];
  const units = [];
  let t = 2_000_000;
  let unitIndex = 0;
  while (list.length < count) {
    const size = Math.min(count - list.length, 6 + Math.floor(random() * 9));
    const first = list.length;
    const id = `S${String(unitIndex).padStart(4, "0")}`;
    for (let k = 0; k < size; k += 1) {
      const token = VOCAB[Math.floor(random() * VOCAB.length)];
      const duration = 170 + Math.floor(random() * 90);
      list.push({ id: `w${String(100_000 + list.length).padStart(6, "0")}`, s: t, e: t + duration,
        t: k === 0 ? token[0].toUpperCase() + token.slice(1) : token, p_pm: 800 + Math.floor(random() * 200), u: id, z: false });
      t += duration + 20 + Math.floor(random() * 20);
    }
    units.push({ id, s: list[first].s, e: list.at(-1).e, q: false });
    unitIndex += 1;
    t += 200;
  }
  return artifact(list, units, { windowMs: [list[0].s - 1000, list.at(-1).e + 1000] });
}

function unitRange(words, unitIndex) {
  const id = words.units[unitIndex].id;
  const first = words.words.findIndex((word) => word.u === id);
  let last = first;
  while (last + 1 < words.words.length && words.words[last + 1].u === id) last += 1;
  return [first, last];
}

/** Word indices [first, last] of a sentence unit. */
export function unitWords(words, unitIndex) {
  return unitRange(words, unitIndex);
}

function boundBefore(words, index) {
  return words.bounds.find((entry) => entry.before === words.words[index].id).sf;
}

function boundAfter(words, index) {
  return words.bounds.find((entry) => entry.after === words.words[index].id).sf;
}

/**
 * A seed document (revision 0, the fakes' shape) over `words`: the body on word indices
 * [bodyFirst, bodyLast], an optional cold open on [coFirst, coLast], the hook text.
 */
export function harnessDoc(words, { bodyFirst, bodyLast, coldOpen = null, hookText = "Kenapa sutradara ditahan di film sendiri?", pack = "karaoke" }) {
  const doc = fakeDoc();
  doc.base.window_ms = [...words.window_ms];
  doc.base.words = { sha256: fakeSha256(`words:${words.words.length}`), count: words.words.length };
  doc.base.origin.hook_unit_id = words.units[0].id;
  doc.main.segments = [{ id: "seg_b1", role: "body", in_sf: boundBefore(words, bodyFirst), out_sf: boundAfter(words, bodyLast) }];
  if (coldOpen) {
    doc.main.segments.unshift({ id: "seg_co", role: "cold_open", in_sf: boundBefore(words, coldOpen[0]), out_sf: boundAfter(words, coldOpen[1]) });
    doc.main.joins = [{ after: "seg_co", style: "cut", audio_fade_ms: 30 }];
  }
  doc.captions.pack = { id: pack, v: 1 };
  doc.captions.overrides.case = pack === "bold" ? "upper" : "asis";
  if (hookText === null) doc.tracks = [];
  else doc.tracks[0].items[0].payload.text = hookText;
  doc.base.job_id = FAKE_JOB_ID;
  return doc;
}

/** The dataset named by the harness config: `{ words, doc }`. */
export function dataset(name) {
  if (name === "long1500") {
    const words = longWords();
    const fromMs = words.words[0].s + 60_000;
    const bodyFirst = words.words.findIndex((word) => word.s >= fromMs);
    let bodyLast = bodyFirst;
    while (bodyLast + 1 < words.words.length && words.words[bodyLast + 1].e - words.words[bodyFirst].s <= 299_000) bodyLast += 1;
    return { words, doc: harnessDoc(words, { bodyFirst, bodyLast }) };
  }
  const words = demoWords();
  const [bodyFirst] = unitRange(words, DEMO.bodyFirst);
  const [, bodyLast] = unitRange(words, DEMO.bodyLast);
  return { words, doc: harnessDoc(words, { bodyFirst, bodyLast, coldOpen: unitRange(words, DEMO.seedColdOpen) }) };
}
