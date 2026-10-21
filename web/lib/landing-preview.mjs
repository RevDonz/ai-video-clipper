// The landing's Sebelum/Sesudah clip: it plays only while it is on screen and the tab is shown,
// "Jeda" holds it until "Putar", and with prefers-reduced-motion it starts paused. The state is
// plain data so the rules are tested without a browser; attachPreview wires it to a <video>.

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** The state before the observer reports: paused only when the viewer asks for less motion. */
export function initialPreviewState({ reducedMotion = false } = {}) {
  return { paused: Boolean(reducedMotion), visible: false, hidden: false };
}

/** The next state after one event; the given state is never changed. */
export function previewReducer(state, event) {
  switch (event?.type) {
    case "visible": return { ...state, visible: Boolean(event.value) };
    case "tab": return { ...state, hidden: Boolean(event.hidden) };
    case "toggle": return { ...state, paused: !state.paused };
    // Turning reduced motion on pauses; turning it off keeps whatever the viewer chose.
    case "reduced-motion": return event.value ? { ...state, paused: true } : state;
    // A browser that refuses to play shows the Putar button instead of a frozen Jeda. An
    // AbortError only means a pause interrupted the play request, which is not a refusal.
    case "play-refused": return event.name === "AbortError" ? state : { ...state, paused: true };
    default: return state;
  }
}

export function shouldPlay(state) {
  return !state.paused && state.visible && !state.hidden;
}

export function previewButtonLabel(state) {
  return state.paused ? "Putar" : "Jeda";
}

/**
 * Drives `video` by the rules above. `onChange` receives every new state (for the button).
 * Without IntersectionObserver the clip counts as on screen; without matchMedia, motion is
 * allowed. Returns { toggle, destroy }.
 */
export function attachPreview(video, { window: win = globalThis.window, onChange = () => {} } = {}) {
  const media = typeof win?.matchMedia === "function" ? win.matchMedia(REDUCED_MOTION) : null;
  const doc = win?.document;
  let state = initialPreviewState({ reducedMotion: Boolean(media?.matches) });
  let active = true;

  const apply = () => {
    if (shouldPlay(state)) {
      if (!video.paused) return;
      const attempt = video.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch((error) => {
          if (active) dispatch({ type: "play-refused", name: error?.name });
        });
      }
    } else if (!video.paused) {
      video.pause();
    }
  };
  function dispatch(event) {
    state = previewReducer(state, event);
    apply();
    onChange(state);
  }

  const onTab = () => dispatch({ type: "tab", hidden: doc.visibilityState === "hidden" });
  const onMotion = (event) => dispatch({ type: "reduced-motion", value: Boolean(event.matches) });
  doc?.addEventListener("visibilitychange", onTab);
  media?.addEventListener?.("change", onMotion);

  let observer = null;
  state = { ...state, hidden: doc?.visibilityState === "hidden" };
  if (typeof win?.IntersectionObserver === "function") {
    observer = new win.IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) dispatch({ type: "visible", value: entry.isIntersecting });
    }, { threshold: 0 });
    observer.observe(video);
    onChange(state);
  } else {
    dispatch({ type: "visible", value: true });
  }

  return {
    toggle: () => dispatch({ type: "toggle" }),
    destroy() {
      active = false;
      observer?.disconnect();
      doc?.removeEventListener("visibilitychange", onTab);
      media?.removeEventListener?.("change", onMotion);
    },
  };
}
