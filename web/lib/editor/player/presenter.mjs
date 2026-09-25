// The presenter barrier of the editor player (plan §6.2 "Clock and presentation", E7).
//
// * Frame n is presented only when all three layers for n are ready (plate frame, text bitmap,
//   logo); otherwise the previous frame stays up. Nothing partial is ever drawn.
// * During a playing run every output frame that is never presented is a drop. A drop at a cut
//   (the last frame before a join or the first after it) is counted apart: PF-PLAY allows none.
// * Paused presentation (seeks, steps) never counts drops, and a seek during playback starts a
//   new run.

const MAX_DROPPED_LISTED = 256;

export function layersReady(layers) {
  return Boolean(layers && layers.plate && layers.text && layers.logo);
}

export function createPresenter({ cuts = [] } = {}) {
  const cutSet = new Set();
  for (const cut of cuts) {
    cutSet.add(cut);
    cutSet.add(cut - 1);
  }
  let lastPresented = null;
  let presented = 0;
  let holds = 0;
  let run = null; // { next: the first frame not yet accounted for, presented }
  let drops = 0;
  let dropsAtCuts = 0;
  const dropped = [];

  function drop(from, to) {
    for (let frame = from; frame < to; frame += 1) {
      drops += 1;
      if (cutSet.has(frame)) dropsAtCuts += 1;
      if (dropped.length < MAX_DROPPED_LISTED) dropped.push(frame);
    }
  }

  return {
    /** "present" when every layer is ready, "same" when n is already on screen, else "hold". */
    decide(n, layers) {
      if (n === lastPresented) return "same";
      if (layersReady(layers)) return "present";
      holds += 1;
      return "hold";
    },
    presented(n) {
      if (run && n >= run.next) {
        drop(run.next, n);
        run.next = n + 1;
        run.presented += 1;
      }
      lastPresented = n;
      presented += 1;
    },
    /** A playing run from `first`; `shown` when `first` is already on screen. */
    startRun(first, { shown = false } = {}) {
      run = { next: shown ? first + 1 : first, presented: 0 };
      if (shown) lastPresented = first;
    },
    stopRun() {
      run = null;
    },
    /** Forget what is on screen (a truth frame or the <video> fallback replaced it). */
    invalidate() {
      lastPresented = null;
    },
    get lastPresented() {
      return lastPresented;
    },
    stats() {
      return {
        presented, holds, drops, dropsAtCuts, dropped: dropped.slice(), lastPresented,
        presentedInRun: run ? run.presented : 0,
      };
    },
    resetStats() {
      presented = 0;
      holds = 0;
      drops = 0;
      dropsAtCuts = 0;
      dropped.length = 0;
      if (run) run.presented = 0;
    },
  };
}
