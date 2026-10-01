// The audio clock (plan §6.2 "Clock and presentation", "Audio"; §5.6 step 6): the server mix
// (FLAC, 48 kHz) is decoded into an AudioContext({sampleRate: 48000}) so decodeAudioData never
// resamples; the clock is the context's output position (getOutputTimestamp corrects for output
// latency); playback from frame n starts the buffer at smp(n). A new mix is swapped in while
// paused, and an edit (a new document) during playback pauses playback.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MIX_LENGTH_DELTA,
  MIX_SAMPLE_RATE,
  createAudioClock,
  createWallClock,
  planChangeDecision,
} from "../lib/editor/player/audio-clock.mjs";

test("the mix sample rate is 48 kHz", () => {
  assert.equal(MIX_SAMPLE_RATE, 48000);
});

test("an edit during playback pauses; a new mix is swapped in only while paused", () => {
  const current = { docSha256: "a".repeat(64), mixSha256: "m1" };
  // Same document, same mix (e.g. more plate cells ready): nothing happens to playback.
  assert.deepEqual(planChangeDecision({ playing: true, current, next: { ...current } }),
    { pause: false, swapAudio: false });
  // A new document while playing: pause, then swap the mix.
  assert.deepEqual(planChangeDecision({ playing: true, current, next: { docSha256: "b".repeat(64), mixSha256: "m2" } }),
    { pause: true, swapAudio: true });
  // A new document with the same mix still pauses (the edit changed the picture or text).
  assert.deepEqual(planChangeDecision({ playing: true, current, next: { docSha256: "b".repeat(64), mixSha256: "m1" } }),
    { pause: true, swapAudio: false });
  // Paused: swap at once when the mix changed.
  assert.deepEqual(planChangeDecision({ playing: false, current, next: { docSha256: "b".repeat(64), mixSha256: "m2" } }),
    { pause: false, swapAudio: true });
  // The first plan: nothing to pause, load the mix.
  assert.deepEqual(planChangeDecision({ playing: false, current: null, next: current }),
    { pause: false, swapAudio: true });
});

function fakeAudioContext({ sampleRate = 48000, decodedRate = 48000, decodedLength = 4800, channels = 2 } = {}) {
  const created = [];
  class FakeAudioContext {
    constructor(options) {
      this.options = options;
      this.sampleRate = options?.sampleRate ?? 44100;
      this.state = "suspended";
      this.currentTime = 0;
      this.baseLatency = 0.01;
      this.outputLatency = 0.02;
      this.destination = { kind: "destination" };
      this.output = { contextTime: 0, performanceTime: 0 };
      this.sources = [];
      created.push(this);
    }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
    getOutputTimestamp() { return { ...this.output }; }
    async decodeAudioData(buffer) {
      assert.ok(buffer instanceof ArrayBuffer);
      return { sampleRate: decodedRate, length: decodedLength, numberOfChannels: channels, duration: decodedLength / decodedRate };
    }
    createBufferSource() {
      const node = {
        buffer: null, connected: null, started: null, stopped: false, onended: null,
        connect(target) { this.connected = target; },
        start(when, offset) { this.started = { when, offset }; },
        stop() { this.stopped = true; },
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }
  }
  FakeAudioContext.created = created;
  void sampleRate;
  return FakeAudioContext;
}

function fetchBytes(calls) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) };
  };
}

test("the mix is decoded in a 48 kHz context and checked against the plan's sample count", async () => {
  const Ctx = fakeAudioContext({ decodedLength: 4800 });
  const calls = [];
  const clock = createAudioClock({ fetchImpl: fetchBytes(calls), AudioContextImpl: Ctx });
  await clock.load({ mixSha256: "m1", state: "ready", url: "/mix.flac", samples: 4800 });
  assert.equal(Ctx.created.length, 1);
  assert.deepEqual(Ctx.created[0].options, { sampleRate: 48000, latencyHint: "interactive" });
  assert.equal(clock.ready, true);
  assert.equal(clock.mixSha256, "m1");
  assert.deepEqual(calls, ["/mix.flac"]);
  // Loading the same mix again does not fetch it again.
  await clock.load({ mixSha256: "m1", state: "ready", url: "/mix.flac", samples: 4800 });
  assert.deepEqual(calls, ["/mix.flac"]);
});

test("a mix that would be resampled or is far from the plan's length is refused", async () => {
  const resampled = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: fakeAudioContext({ decodedRate: 44100 }) });
  await assert.rejects(resampled.load({ mixSha256: "m1", state: "ready", url: "/a.flac", samples: 4800 }), /48000/);
  assert.equal(resampled.ready, false);
  const short = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: fakeAudioContext({ decodedLength: 4800 }) });
  await assert.rejects(short.load({ mixSha256: "m1", state: "ready", url: "/a.flac", samples: 4800 + MAX_MIX_LENGTH_DELTA + 1 }), /samples/);
  assert.equal(short.ready, false);
});

test("a mix within G2's tolerance of the plan's length plays, and the delta is reported", async () => {
  assert.equal(MAX_MIX_LENGTH_DELTA, 1024);
  const clock = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: fakeAudioContext({ decodedLength: 975_992 }) });
  await clock.load({ mixSha256: "m1", state: "ready", url: "/a.flac", samples: 976_000 });
  assert.equal(clock.ready, true);
  assert.equal(clock.lengthDelta, -8);
});

test("a mix that is not ready yet leaves the clock without audio", async () => {
  const calls = [];
  const clock = createAudioClock({ fetchImpl: fetchBytes(calls), AudioContextImpl: fakeAudioContext() });
  await clock.load({ mixSha256: "m2", state: "queued", url: null, samples: 4800 });
  assert.equal(clock.ready, false);
  assert.equal(clock.mixSha256, null);
  assert.deepEqual(calls, []);
});

test("playback from frame n starts the buffer at smp(n) and the clock follows the output", async () => {
  const Ctx = fakeAudioContext({ decodedLength: 48000 * 20 });
  let perf = 1000;
  const clock = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: Ctx, now: () => perf });
  await clock.load({ mixSha256: "m1", state: "ready", url: "/mix.flac", samples: 48000 * 20 });
  const ctx = Ctx.created[0];
  ctx.currentTime = 2.0;
  const fps = [30000, 1001];
  await clock.start(301, fps);
  assert.equal(ctx.state, "running");
  const source = ctx.sources.at(-1);
  // smp(301) = ⌊301·48000·1001/30000⌋ = 482081 samples → offset in seconds.
  assert.equal(source.started.offset, 482081 / 48000);
  const when = source.started.when;
  assert.ok(when >= 2.0);
  // Before the output reaches `when` the clock holds at the start frame.
  ctx.output = { contextTime: when - 0.05, performanceTime: 1000 };
  assert.equal(clock.position(), 482081 / 48000);
  // Output timestamp: context time `when + 0.5` was heard at performance time 1500; 100 ms later
  // the clock is 0.6 s into the run.
  ctx.output = { contextTime: when + 0.5, performanceTime: 1500 };
  perf = 1600;
  assert.ok(Math.abs(clock.position() - (482081 / 48000 + 0.6)) < 1e-9);
  clock.stop();
  assert.equal(source.stopped, true);
  assert.equal(clock.position(), null);
});

test("without output timestamps the clock subtracts the output latency", async () => {
  const Ctx = fakeAudioContext({ decodedLength: 48000 * 5 });
  const clock = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: Ctx, now: () => 0 });
  await clock.load({ mixSha256: "m1", state: "ready", url: "/mix.flac", samples: 48000 * 5 });
  const ctx = Ctx.created[0];
  ctx.getOutputTimestamp = undefined;
  await clock.start(0, [25, 1]);
  const when = ctx.sources.at(-1).started.when;
  ctx.currentTime = when + 1.03;
  assert.ok(Math.abs(clock.position() - 1.0) < 1e-9); // 1.03 − 0.02 − 0.01
});

test("starting again stops the previous source first; destroy closes the context", async () => {
  const Ctx = fakeAudioContext({ decodedLength: 48000 * 5 });
  const clock = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: Ctx, now: () => 0 });
  await clock.load({ mixSha256: "m1", state: "ready", url: "/mix.flac", samples: 48000 * 5 });
  await clock.start(0, [25, 1]);
  await clock.start(25, [25, 1]);
  const ctx = Ctx.created[0];
  assert.equal(ctx.sources.length, 2);
  assert.equal(ctx.sources[0].stopped, true);
  assert.equal(ctx.sources[1].started.offset, 1);
  await clock.destroy();
  assert.equal(ctx.state, "closed");
});

test("a start without a ready mix is refused", async () => {
  const clock = createAudioClock({ fetchImpl: fetchBytes([]), AudioContextImpl: fakeAudioContext() });
  await assert.rejects(clock.start(0, [25, 1]), /audio_not_ready/);
});

test("the wall clock (play without sound) counts from the start frame", () => {
  let perf = 500;
  const clock = createWallClock({ now: () => perf });
  assert.equal(clock.position(), null);
  clock.start(50, [25, 1]);
  assert.equal(clock.position(), 2);
  perf = 1500;
  assert.equal(clock.position(), 3);
  clock.stop();
  assert.equal(clock.position(), null);
});
