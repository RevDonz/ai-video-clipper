// The learning half of the help page (/bantuan): how Potongin is used, one topic per page or
// part of the product, in the order a new user meets them, then the keyboard shortcuts. The
// error reference is help-catalog.mjs. The words are help.guide.topics.<id> and help.shortcuts
// in every locale's catalog; the limits and presets they quote come from the lists the pages
// use (guideValues), and tests/help-guide.test.mjs holds the names to the pages' own lists.
// Client-safe: no Node built-ins.

import { APP_SHORTCUTS } from "./app-shortcuts.mjs";
import { CLIP_LIMITS } from "./clip-limits.mjs";
import { CAPTION_STYLE_CHOICES, DURATION_PRESETS } from "./dashboard-choices.mjs";
import { SHORTCUTS } from "./editor/shortcuts.mjs";

const topic = (id, action = null) => Object.freeze({ id, action });

// `action` links the topic to its page; the label is help.actions.<key>.
export const GUIDE_TOPICS = Object.freeze([
  topic("mulai", Object.freeze({ href: "/dashboard", key: "create" })),
  topic("pilihan"),
  topic("riwayat", Object.freeze({ href: "/projects", key: "projects" })),
  topic("editor"),
  topic("tren", Object.freeze({ href: "/trends", key: "trends" })),
  topic("pengaturan", Object.freeze({ href: "/settings", key: "settings" })),
]);

// The anchor of the shortcut table, next to the topics' and the error entries' anchors.
export const SHORTCUTS_ANCHOR = "pintasan";

const preset = (id) => DURATION_PRESETS.find((entry) => entry.id === id);

/** The numbers the topics quote, as the message arguments of help.guide.topics. */
export function guideValues() {
  const values = {
    countMin: CLIP_LIMITS.count.min,
    countMax: CLIP_LIMITS.count.max,
    secondsMin: CLIP_LIMITS.seconds.min,
    secondsMax: CLIP_LIMITS.seconds.max,
    styles: CAPTION_STYLE_CHOICES.length,
  };
  for (const id of ["auto", "short", "medium", "long"]) {
    values[`${id}Min`] = preset(id).min;
    values[`${id}Max`] = preset(id).max;
  }
  return values;
}

// The app pages' single-key shortcuts (lib/app-shortcuts.mjs); the text is help.shortcuts.appKeys.<id>.
export const GUIDE_APP_SHORTCUTS = Object.freeze(APP_SHORTCUTS.map(({ id, key }) => Object.freeze({ id, keys: Object.freeze([key]) })));

// The editor keys worth learning first, as the editor's own map writes them ("?" lists them all);
// the text is help.shortcuts.editorKeys.<id>, the same words as the map's description.
const FIRST_KEYS = ["playPause", "frameBack", "frameForward", "undo", "redo", "trimStart", "trimEnd", "export", "help"];
export const GUIDE_SHORTCUTS = Object.freeze(FIRST_KEYS.map((id) => {
  const { keys, description } = SHORTCUTS.find((entry) => entry.id === id);
  return Object.freeze({ id, keys, description });
}));

// Key names the editor's map writes in Indonesian; the label is help.shortcuts.<name>.
export const KEY_NAMES = Object.freeze({ Spasi: "space" });
