// The editor's icons (spec §8.2): 24 px grid, stroke 2, round caps, from the approved mockup's
// paths; `more` and `help` are drawn here in the same style. `fill: true` marks a solid shape.
// Kept apart from icons.jsx so node tests can read the set.
const part = (d, fill = false) => Object.freeze({ d, fill });

export const ICONS = Object.freeze({
  back: Object.freeze([part("M15 18l-6-6 6-6")]),
  undo: Object.freeze([part("M9 14L4 9l5-5"), part("M4 9h10a6 6 0 0 1 0 12h-3")]),
  redo: Object.freeze([part("M15 14l5-5-5-5"), part("M20 9H10a6 6 0 0 0 0 12h3")]),
  more: Object.freeze([
    part("M3.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM10.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM17.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0z", true),
  ]),
  play: Object.freeze([part("M8 5v14l11-7z", true)]),
  pause: Object.freeze([
    part("M7 5h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM15 5h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", true),
  ]),
  chevron: Object.freeze([part("M6 9l6 6 6-6")]),
  transcript: Object.freeze([part("M4 6h16M4 12h16M4 18h10")]),
  text: Object.freeze([part("M5 6h14M12 6v13M9 19h6")]),
  coldopen: Object.freeze([part("M7 4v16l13-8z")]),
  layout: Object.freeze([part("M4 4h16v16H4zM10 4v16")]),
  logo: Object.freeze([part("M4 18l5-6 4 4 3-3 4 5zM15 8a1 1 0 1 0 0.01 0")]),
  music: Object.freeze([part("M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z")]),
  safezone: Object.freeze([part("M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"), part("M15 8v9M9 17h6")]),
  help: Object.freeze([
    part("M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z"),
    part("M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8"),
    part("M12 17h.01"),
  ]),
});

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
