// The editor player's clock (plan §6.2 "Clock and presentation", "Audio"; §5.6 step 6).
//
// * The clock is an AudioContext playing the server's mix (FLAC s16, 48 kHz stereo). The context
//   is created with sampleRate 48000, so decodeAudioData never resamples: the samples played are
//   the server's samples (P-AUD, browser half). A decoded buffer at another rate or with another
//   length than the plan's `audio.samples` is refused.
// * Playback from output frame n starts the buffer at smp(n) = ⌊n·48000·den/num⌋ samples.
// * position() is the output time (s) of the sample being heard now: getOutputTimestamp() gives
//   the context time of the sample at the output at a performance time, which corrects for the
//   output latency; without it, currentTime minus the reported latencies.
// * Swap rules: a new mix is swapped in while paused; an edit (a new document) during playback
//   pauses playback. A new plan DTO of the same document (more cells ready) changes nothing.
// * createWallClock is the "Putar tanpa suara" clock (performance time), used only when the user
//   plays before the mix is ready.

import { smp } from "./frame-map.mjs";

export const MIX_SAMPLE_RATE = 48_000;
const START_LEAD_S = 0.05; // schedule the start slightly ahead so it is sample-exact

/**
 * What a new plan DTO does to playback and to the loaded mix.
 * current: { docSha256, mixSha256 (the mix actually loaded, or null) } | null
 * next: { docSha256, mixSha256 }
 */
export function planChangeDecision({ playing, current, next }) {
  const edited = Boolean(current) && current.docSha256 !== next.docSha256;
  const swapAudio = !current || current.mixSha256 !== next.mixSha256;
  return { pause: Boolean(playing) && edited, swapAudio };
}

function defaultNow() {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}

export function createAudioClock({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  AudioContextImpl = globalThis.AudioContext,
  now = defaultNow,
} = {}) {
  let context = null;
  let buffer = null;
  let mixSha256 = null;
  let loading = null; // { sha, promise }
  let source = null;
  let startWhen = 0;
  let startOffset = 0;
  let destroyed = false;

  function ensureContext() {
    if (!context) {
      if (typeof AudioContextImpl !== "function") throw new Error("audio_unsupported");
      context = new AudioContextImpl({ sampleRate: MIX_SAMPLE_RATE, latencyHint: "interactive" });
    }
    return context;
  }

  async function decode(dto) {
    const response = await fetchImpl(dto.url);
    if (!response.ok) throw new Error(`audio_fetch_failed:${response.status}`);
    const bytes = await response.arrayBuffer();
    const ctx = ensureContext();
    const decoded = await ctx.decodeAudioData(bytes);
    if (decoded.sampleRate !== MIX_SAMPLE_RATE || ctx.sampleRate !== MIX_SAMPLE_RATE) {
      throw new Error(`audio_resampled: the mix must decode at ${MIX_SAMPLE_RATE} Hz (got ${decoded.sampleRate})`);
    }
    if (Number.isInteger(dto.samples) && decoded.length !== dto.samples) {
      throw new Error(`audio_length: ${decoded.length} samples, the plan has ${dto.samples}`);
    }
    return decoded;
  }

  const clock = {
    get ready() {
      return buffer !== null;
    },
    get mixSha256() {
      return mixSha256;
    },
    get buffer() {
      return buffer;
    },
    get context() {
      return context;
    },
    get startInfo() {
      return source ? { when: startWhen, offset: startOffset } : null;
    },
    /** Loads (fetch + decode) the plan's mix; a mix that is not ready leaves the clock silent. */
    async load(dto) {
      if (destroyed) throw new Error("audio clock destroyed");
      if (!dto || dto.state !== "ready" || !dto.url) {
        clock.stop();
        buffer = null;
        mixSha256 = null;
        return;
      }
      if (dto.mixSha256 === mixSha256 && buffer) return;
      if (loading && loading.sha === dto.mixSha256) {
        await loading.promise;
        return;
      }
      const promise = decode(dto);
      loading = { sha: dto.mixSha256, promise };
      try {
        const decoded = await promise;
        if (loading?.promise !== promise || destroyed) return;
        clock.stop();
        buffer = decoded;
        mixSha256 = dto.mixSha256;
      } catch (error) {
        if (loading?.promise === promise) {
          buffer = null;
          mixSha256 = null;
        }
        throw error;
      } finally {
        if (loading?.promise === promise) loading = null;
      }
    },
    /** Plays the mix from output frame `frame`; resolves once the start is scheduled. */
    async start(frame, fps) {
      if (!buffer) throw new Error("audio_not_ready");
      const ctx = ensureContext();
      clock.stop();
      if (ctx.state === "suspended" && typeof ctx.resume === "function") await ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      startOffset = smp(frame, fps, MIX_SAMPLE_RATE) / MIX_SAMPLE_RATE;
      startWhen = ctx.currentTime + START_LEAD_S;
      node.start(startWhen, startOffset);
      source = node;
    },
    stop() {
      if (!source) return;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect?.();
      } catch {
        // not connected
      }
      source = null;
    },
    /** The output time (s) being heard now, or null when not playing. */
    position() {
      if (!source || !context) return null;
      let heard = null;
      const stamp = typeof context.getOutputTimestamp === "function" ? context.getOutputTimestamp() : null;
      if (stamp && stamp.performanceTime > 0) {
        heard = stamp.contextTime + (now() - stamp.performanceTime) / 1000;
      } else {
        heard = context.currentTime - (context.outputLatency || 0) - (context.baseLatency || 0);
      }
      return startOffset + Math.max(0, heard - startWhen);
    },
    async destroy() {
      destroyed = true;
      clock.stop();
      buffer = null;
      mixSha256 = null;
      if (context && typeof context.close === "function") {
        try {
          await context.close();
        } catch {
          // already closed
        }
      }
      context = null;
    },
  };
  return clock;
}

export function createWallClock({ now = defaultNow } = {}) {
  let start = null;
  return {
    start(frame, fps) {
      const [num, den] = fps;
      start = { perf: now(), offset: (frame * den) / num };
    },
    stop() {
      start = null;
    },
    position() {
      return start ? start.offset + (now() - start.perf) / 1000 : null;
    },
  };
}
