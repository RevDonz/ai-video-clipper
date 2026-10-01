// The words artifact of a marker-vector case (tests/fixtures/edit_v2/marker-vectors.json), the
// JS twin of `case_words` in scripts/editor/gen_t37_fixtures.py. Dev and test only.
//
// `strip` removes analysis the way a job without it has none (no audio timeline: no silences,
// scene cuts or gap classes; no sound events: no caption tags, transcript laughter stays) and
// records it in `missing`; `extra` (the dense cases) adds events, silences and scene cuts.
const byEvent = (a, b) => a.s - b.s || a.e - b.e || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
  || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0);

export function caseWords(words, { strip = [], extra = null } = {}) {
  if (!strip.length && !extra) return words;
  const out = structuredClone(words);
  if (strip.includes("audio_timeline")) {
    out.silences = [];
    out.scene_cuts_ms = [];
    out.gaps = [];
  }
  if (strip.includes("sound_events")) out.events = out.events.filter((event) => event.src !== "yt-caption");
  out.missing = [...new Set([...out.missing, ...strip])].sort();
  if (extra) {
    out.events = [...out.events, ...extra.events].sort(byEvent);
    out.silences = [...out.silences, ...extra.silences].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    out.scene_cuts_ms = [...out.scene_cuts_ms, ...extra.scene_cuts_ms].sort((a, b) => a - b);
  }
  return out;
}
