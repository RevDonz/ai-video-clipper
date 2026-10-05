"use client";

// One audition at a time (plan §7.2, docs/plans/2026-10-02-transisi-cold-open.md §7.1): plays
// output frames `[f0, f1)` from the player, then pauses at the end. Moving the playhead elsewhere
// ends it without a pause. The Cold open panel and the Cold open card use it for "Putar" on a
// suggestion, on the cold open itself and for "Putar transisi".
import { useCallback, useEffect, useRef, useState } from "react";

/** `{ playing, start(id, { f0, f1 }), stop() }`; `playing` is the id of the running audition or null. */
export function useAudition(player, fps) {
  const [playing, setPlaying] = useState(null);
  const stopRef = useRef(() => {});
  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    setPlaying(null);
  }, []);
  useEffect(() => stop, [stop]);
  const start = useCallback(async (id, { f0, f1 }) => {
    stop();
    if (!player?.seek) return;
    setPlaying(id);
    await player.seek(f0);
    await player.play?.();
    const grace = Math.max(1, Math.round(fps[0] / fps[1]));
    let done = false;
    const finish = (pause) => {
      if (done) return;
      done = true;
      if (pause) player.pause?.();
      stopRef.current();
      stopRef.current = () => {};
      setPlaying((current) => (current === id ? null : current));
    };
    if (typeof player.subscribeFrame === "function") {
      const unsubscribe = player.subscribeFrame((frame) => {
        if (frame >= f1 - 1 && frame <= f1 + grace) finish(true);
        else if (frame < f0 - 1 || frame > f1 + grace) finish(false); // the user moved elsewhere
      });
      stopRef.current = unsubscribe;
    } else {
      const timer = setTimeout(() => finish(true), ((f1 - f0) * 1000 * fps[1]) / fps[0] + 100);
      stopRef.current = () => clearTimeout(timer);
    }
  }, [player, fps, stop]);
  return { playing, start, stop };
}

export default useAudition;
