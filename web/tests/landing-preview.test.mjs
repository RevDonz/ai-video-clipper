// The landing's Sebelum/Sesudah clip (lib/landing-preview.mjs): it plays only while it is on
// screen and the tab is shown, "Jeda" holds it, and with prefers-reduced-motion it starts paused.
import assert from "node:assert/strict";
import test from "node:test";

import {
  attachPreview,
  initialPreviewState,
  previewButtonLabel,
  previewReducer,
  shouldPlay,
} from "../lib/landing-preview.mjs";

function fakeWindow({ reduced = false, observer = true, matchMedia = true } = {}) {
  const media = {
    matches: reduced,
    listeners: new Set(),
    addEventListener(type, listener) { if (type === "change") this.listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "change") this.listeners.delete(listener); },
    set(value) {
      this.matches = value;
      for (const listener of this.listeners) listener({ matches: value });
    },
  };
  const document = {
    visibilityState: "visible",
    listeners: new Set(),
    addEventListener(type, listener) { if (type === "visibilitychange") this.listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "visibilitychange") this.listeners.delete(listener); },
    show(state) {
      this.visibilityState = state;
      for (const listener of this.listeners) listener();
    },
  };
  const observers = [];
  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
    report(isIntersecting) { this.callback([{ target: this.targets[0], isIntersecting }]); }
  }
  const win = { document };
  if (matchMedia) win.matchMedia = (query) => { media.query = query; return media; };
  if (observer) win.IntersectionObserver = FakeObserver;
  return { win, media, document, observers };
}

function fakeVideo({ refuse = null } = {}) {
  return {
    paused: true,
    plays: 0,
    pauses: 0,
    play() {
      this.plays += 1;
      if (refuse) return Promise.reject(Object.assign(new Error("refused"), { name: refuse }));
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauses += 1;
      this.paused = true;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the clip plays only when the viewer has not paused it, it is on screen and the tab is shown", () => {
  const start = initialPreviewState({ reducedMotion: false });
  assert.deepEqual(start, { paused: false, visible: false, hidden: false });
  assert.equal(shouldPlay(start), false, "nothing plays before it is on screen");
  const onScreen = previewReducer(start, { type: "visible", value: true });
  assert.equal(shouldPlay(onScreen), true);
  assert.equal(shouldPlay(previewReducer(onScreen, { type: "tab", hidden: true })), false);
  assert.equal(shouldPlay(previewReducer(onScreen, { type: "toggle" })), false);
  assert.equal(shouldPlay(previewReducer(onScreen, { type: "visible", value: false })), false);
  // The reducer never changes the state it is given.
  assert.deepEqual(start, { paused: false, visible: false, hidden: false });
});

test("prefers-reduced-motion starts the clip paused; switching it on later pauses, off keeps the choice", () => {
  const start = initialPreviewState({ reducedMotion: true });
  assert.equal(start.paused, true);
  assert.equal(previewButtonLabel(start), "Putar");
  const played = previewReducer({ ...start, visible: true }, { type: "toggle" });
  assert.equal(shouldPlay(played), true, "the viewer can still play it");
  assert.equal(previewButtonLabel(played), "Jeda");
  assert.equal(previewReducer(played, { type: "reduced-motion", value: true }).paused, true);
  assert.equal(previewReducer(played, { type: "reduced-motion", value: false }).paused, false);
});

test("a refused play shows Putar; a play cut short by a pause does not", () => {
  const playing = { paused: false, visible: true, hidden: false };
  assert.equal(previewReducer(playing, { type: "play-refused", name: "NotAllowedError" }).paused, true);
  assert.equal(previewReducer(playing, { type: "play-refused", name: "NotSupportedError" }).paused, true);
  assert.equal(previewReducer(playing, { type: "play-refused", name: "AbortError" }).paused, false);
  assert.equal(previewReducer(playing, { type: "unknown" }), playing);
});

test("attached to a video it waits for the observer, then plays and pauses with the screen", () => {
  const { win, observers } = fakeWindow();
  const video = fakeVideo();
  const states = [];
  const preview = attachPreview(video, { window: win, onChange: (state) => states.push(state) });
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].targets, [video]);
  assert.equal(video.plays, 0, "no play before the clip is on screen");
  assert.equal(states.at(-1).paused, false);

  observers[0].report(true);
  assert.equal(video.plays, 1);
  assert.equal(video.paused, false);
  observers[0].report(false);
  assert.equal(video.paused, true);
  assert.equal(states.at(-1).visible, false);
  preview.destroy();
});

test("a hidden tab pauses the clip and showing it again resumes only what was playing", () => {
  const { win, document, observers } = fakeWindow();
  const video = fakeVideo();
  attachPreview(video, { window: win });
  observers[0].report(true);
  document.show("hidden");
  assert.equal(video.paused, true);
  document.show("visible");
  assert.equal(video.paused, false);

  observers[0].report(false);
  document.show("hidden");
  document.show("visible");
  assert.equal(video.paused, true, "off screen it stays paused");
});

test("Jeda holds the clip across scrolling and tab switches until Putar", () => {
  const { win, document, observers } = fakeWindow();
  const video = fakeVideo();
  const states = [];
  const preview = attachPreview(video, { window: win, onChange: (state) => states.push(state) });
  observers[0].report(true);
  preview.toggle();
  assert.equal(video.paused, true);
  assert.equal(previewButtonLabel(states.at(-1)), "Putar");
  observers[0].report(false);
  observers[0].report(true);
  document.show("hidden");
  document.show("visible");
  assert.equal(video.paused, true);
  preview.toggle();
  assert.equal(video.paused, false);
  assert.equal(previewButtonLabel(states.at(-1)), "Jeda");
});

test("with reduced motion the attached clip stays on its poster until the viewer plays it", () => {
  const { win, media, observers } = fakeWindow({ reduced: true });
  const video = fakeVideo();
  const preview = attachPreview(video, { window: win });
  assert.equal(media.query, "(prefers-reduced-motion: reduce)");
  observers[0].report(true);
  assert.equal(video.plays, 0);
  preview.toggle();
  assert.equal(video.paused, false);
  media.set(true);
  assert.equal(video.paused, true, "turning reduced motion on pauses it");
});

test("without IntersectionObserver or matchMedia the clip counts as on screen and motion as allowed", () => {
  const { win } = fakeWindow({ observer: false, matchMedia: false });
  const video = fakeVideo();
  attachPreview(video, { window: win });
  assert.equal(video.plays, 1);
  assert.equal(video.paused, false);
});

test("a refused autoplay leaves the clip paused with Putar on the button", async () => {
  const { win, observers } = fakeWindow();
  const video = fakeVideo({ refuse: "NotAllowedError" });
  const states = [];
  attachPreview(video, { window: win, onChange: (state) => states.push(state) });
  observers[0].report(true);
  await settle();
  assert.equal(states.at(-1).paused, true);
  assert.equal(previewButtonLabel(states.at(-1)), "Putar");
});

test("destroy disconnects the observer and stops listening", () => {
  const { win, media, document, observers } = fakeWindow();
  const video = fakeVideo();
  const states = [];
  const preview = attachPreview(video, { window: win, onChange: (state) => states.push(state) });
  preview.destroy();
  assert.equal(observers[0].disconnected, true);
  assert.equal(document.listeners.size, 0);
  assert.equal(media.listeners.size, 0);
  const count = states.length;
  document.show("hidden");
  assert.equal(states.length, count);
});
