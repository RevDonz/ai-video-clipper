import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TIMELINE_SCRUB_INTERVAL_MS,
  layoutCueBlocks,
  scrubFraction,
  shouldCommitScrub,
  timelineOffsetFraction,
  timelineTimeAt,
} from "../lib/editor-timeline.mjs";

const timeline = { start: 12.5, end: 52.5 };

test("pointer position maps to a fraction clamped inside the track", () => {
  const rect = { left: 100, width: 400 };
  assert.equal(scrubFraction(100, rect), 0);
  assert.equal(scrubFraction(300, rect), .5);
  assert.equal(scrubFraction(500, rect), 1);
  assert.equal(scrubFraction(20, rect), 0, "drag past the left edge stays at the clip start");
  assert.equal(scrubFraction(900, rect), 1, "drag past the right edge stays at the clip end");
});

test("degenerate track geometry never produces NaN offsets", () => {
  for (const rect of [{ left: 0, width: 0 }, { left: 0, width: -10 }, { left: Number.NaN, width: 400 }]) {
    assert.equal(scrubFraction(50, rect), 0);
  }
});

test("fractions convert to source time inside the immutable clip bounds", () => {
  assert.equal(timelineTimeAt(0, timeline), 12.5);
  assert.equal(timelineTimeAt(1, timeline), 52.5);
  assert.equal(timelineTimeAt(.25, timeline), 22.5);
  assert.equal(timelineTimeAt(2, timeline), 52.5, "out of range fractions clamp to the clip end");
  assert.equal(timelineTimeAt(-1, timeline), 12.5, "out of range fractions clamp to the clip start");
});

test("source time converts back to a track offset", () => {
  assert.equal(timelineOffsetFraction(12.5, timeline), 0);
  assert.equal(timelineOffsetFraction(32.5, timeline), .5);
  assert.equal(timelineOffsetFraction(52.5, timeline), 1);
  assert.equal(timelineOffsetFraction(0, timeline), 0, "playback before the clip pins to the start");
  assert.equal(timelineOffsetFraction(999, timeline), 1, "playback past the clip pins to the end");
  assert.equal(timelineOffsetFraction(Number.NaN, timeline), 0);
});

test("empty or inverted clip bounds degrade to the clip start", () => {
  for (const bounds of [{ start: 30, end: 30 }, { start: 30, end: 10 }, { start: 0, end: Number.NaN }]) {
    assert.equal(timelineTimeAt(.5, bounds), bounds.start);
    assert.equal(timelineOffsetFraction(20, bounds), 0);
  }
});

test("scrubbing seeks the decoder on release, and at most ten times a second while dragging", () => {
  // The whole point of the timeline: dragging moves a CSS playhead, it does not
  // hand the media pipeline a new seek for every pointer event.
  assert.equal(shouldCommitScrub({ phase: "move", lastSeekAt: 10_000, now: 10_000 }), false);
  assert.equal(shouldCommitScrub({ phase: "move", lastSeekAt: 10_000, now: 10_000 + TIMELINE_SCRUB_INTERVAL_MS - 1 }), false);
  assert.equal(shouldCommitScrub({ phase: "move", lastSeekAt: 10_000, now: 10_000 + TIMELINE_SCRUB_INTERVAL_MS }), true);
  assert.equal(shouldCommitScrub({ phase: "end", lastSeekAt: 10_000, now: 10_000 }), true, "release always commits");
  assert.equal(shouldCommitScrub({ phase: "start", lastSeekAt: 10_000, now: 10_000 }), true, "a tap commits immediately");
});

test("caption cues lay out as blocks measured against the clip window", () => {
  const cues = [
    { cue_id: "a", start: 12.5, end: 22.5, text: "pertama" },
    { cue_id: "b", start: 32.5, end: 52.5, text: "kedua" },
  ];
  assert.deepEqual(layoutCueBlocks(cues, timeline), [
    { cueId: "a", text: "pertama", leftPercent: 0, widthPercent: 25 },
    { cueId: "b", text: "kedua", leftPercent: 50, widthPercent: 50 },
  ]);
});

test("cue blocks clip to the clip window and drop cues outside it", () => {
  const cues = [
    { cue_id: "before", start: 0, end: 5, text: "di luar" },
    { cue_id: "straddle", start: 8, end: 22.5, text: "terpotong" },
    { cue_id: "after", start: 60, end: 70, text: "di luar" },
    { cue_id: "malformed", start: 30, end: 20, text: "terbalik" },
  ];
  assert.deepEqual(layoutCueBlocks(cues, timeline), [
    { cueId: "straddle", text: "terpotong", leftPercent: 0, widthPercent: 25 },
  ]);
});

test("cue layout tolerates missing or non-array input", () => {
  assert.deepEqual(layoutCueBlocks(undefined, timeline), []);
  assert.deepEqual(layoutCueBlocks([{ cue_id: "x" }], timeline), []);
  assert.deepEqual(layoutCueBlocks([{ cue_id: "a", start: 12.5, end: 22.5, text: "t" }], { start: 30, end: 30 }), []);
});

test("editor page drives the timeline instead of a native scrubber", async () => {
  const source = await readFile(new URL("../app/projects/[id]/candidates/[candidateId]/edit/page.jsx", import.meta.url), "utf8");
  assert.match(source, /layoutCueBlocks/);
  assert.match(source, /shouldCommitScrub/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /setPointerCapture/);
  const previewTag = /<video ref=\{mainVideo\}[^>]*>/.exec(source);
  assert.ok(previewTag, "the preview video element should still exist");
  assert.doesNotMatch(previewTag[0], /\scontrols\b/, "the native scrubber on the blurred stage is what froze the page");
  // The rendered result player keeps native controls: it is a short rendered
  // clip with no blurred backdrop behind it.
  assert.match(source, /<video controls preload="metadata" src=\{renderState\.data\.resultUrl\}/);
  assert.match(source, /classList\.add\("scrubbing"\)/);
  assert.match(source, /classList\.remove\("scrubbing"\)/);
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.editorStage\.scrubbing \.previewBackdrop\{visibility:hidden\}/);
});
