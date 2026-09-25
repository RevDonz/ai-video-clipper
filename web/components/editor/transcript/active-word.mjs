// The active word follows playback outside React (plan Appendix C.2, §6.2): one
// requestAnimationFrame loop reads the player's frame, maps it to the word on screen through the
// local time map, and moves a `data-active` attribute between word spans. While playing, the
// active word is kept in view unless the user scrolled the transcript in the last 2 s.
import { activeWordAt } from "./model.mjs";

const USER_SCROLL_HOLD_MS = 2000;

function scrollParent(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

function keepInView(element) {
  const parent = scrollParent(element);
  if (!parent) return;
  const box = element.getBoundingClientRect();
  const view = parent.getBoundingClientRect();
  if (box.top < view.top + 48 || box.bottom > view.bottom - 24) element.scrollIntoView({ block: "center" });
}

/**
 * Start following `player` in `list` (the transcript word container). `getModel()` returns the
 * current transcript model. Returns a stop function.
 */
export function followActiveWord({ list, player, getModel }) {
  if (!list || !player || typeof player.state !== "function" || typeof requestAnimationFrame !== "function") return () => {};
  let raf = 0;
  let lastFrame = null;
  let lastModel = null;
  let lastElement = null;
  let lastMoveAt = -Infinity;
  let userScrollAt = -Infinity;
  const onWheel = () => { userScrollAt = performance.now(); };
  const scroller = scrollParent(list) ?? list;
  scroller.addEventListener("wheel", onWheel, { passive: true });

  function tick() {
    raf = requestAnimationFrame(tick);
    let state;
    try {
      state = player.state();
    } catch {
      return;
    }
    const frame = state?.frame;
    if (!Number.isInteger(frame)) return;
    const model = getModel();
    const now = performance.now();
    const moved = frame !== lastFrame;
    if (moved && lastFrame !== null) lastMoveAt = now;
    if (!moved && model === lastModel && (!lastElement || lastElement.isConnected)) return;
    lastFrame = frame;
    lastModel = model;
    const index = model ? activeWordAt(model, frame) : -1;
    const element = index >= 0 ? list.querySelector(`[data-w="${index}"]`) : null;
    if (element !== lastElement) {
      lastElement?.removeAttribute("data-active");
      lastElement = element;
    }
    if (element && !element.hasAttribute("data-active")) element.setAttribute("data-active", "");
    const playing = typeof state.playing === "boolean" ? state.playing : now - lastMoveAt < 250;
    if (element && moved && playing && now - userScrollAt > USER_SCROLL_HOLD_MS) keepInView(element);
  }

  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    scroller.removeEventListener("wheel", onWheel);
    lastElement?.removeAttribute("data-active");
  };
}
