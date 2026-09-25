// A player for the T2.7 e2e harness: the Appendix A.2 `createPlayer` surface without pixels.
// Unlike the shared fake (fakes.mjs), frames advance in real time while playing, so "the active
// word follows playback" can be observed. `seeks` records every seek target. Dev and test only.
export function createHarnessPlayer({ fps = [30000, 1001], now = () => performance.now() } = {}) {
  let plan = null;
  let frame = 0;
  let playing = false;
  let startedAt = 0;
  let startFrame = 0;
  let timer = null;
  const seeks = [];
  const total = () => plan?.totalFrames ?? 0;
  const clamp = (value) => Math.max(0, Math.min(Math.max(0, total() - 1), value));

  function tick() {
    if (!playing) return;
    const elapsed = now() - startedAt;
    const next = startFrame + Math.floor((elapsed * fps[0]) / (1000 * fps[1]));
    if (next >= total() - 1) {
      frame = clamp(next);
      playing = false;
      clearInterval(timer);
      return;
    }
    frame = next;
  }

  return {
    seeks,
    load(dto) { plan = dto; frame = clamp(frame); },
    async play() {
      if (playing) return;
      playing = true;
      startedAt = now();
      startFrame = frame;
      clearInterval(timer);
      timer = setInterval(tick, 8);
    },
    pause() {
      tick();
      playing = false;
      clearInterval(timer);
    },
    async seek(target) {
      seeks.push(target);
      frame = clamp(target);
      startedAt = now();
      startFrame = frame;
    },
    async step(delta) { frame = clamp(frame + delta); },
    async showTruthFrame(target) { frame = clamp(target); },
    state() {
      tick();
      return { mode: "live", current: { text: true, plate: true, audio: true, logo: true }, frame, playing };
    },
    destroy() {
      playing = false;
      clearInterval(timer);
    },
  };
}
