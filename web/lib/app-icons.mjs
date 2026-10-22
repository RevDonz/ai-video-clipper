// Icons of the app sidebar (components/AppIcon.jsx), drawn on the editor's grid (24 px, stroke 2,
// round caps; components/editor/ui/icon-paths.mjs) so the app and the editor share one look.
// Each glyph shows its page: a 9:16 frame with a plus for a new clip, a clock turning back for
// Riwayat, a rising line for Konteks Tren, sliders for Pengaturan, a question mark for Bantuan.
const part = (d, fill = false) => Object.freeze({ d, fill });

export const APP_ICONS = Object.freeze({
  create: Object.freeze([
    part("M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"),
    part("M12 9v6M9 12h6"),
  ]),
  history: Object.freeze([
    part("M3.5 12a8.5 8.5 0 1 0 2.5-6"),
    part("M3 4v4h4"),
    part("M12 8v4l3 2"),
  ]),
  trends: Object.freeze([part("M3 17l6-6 4 4 8-8"), part("M15 7h6v6")]),
  settings: Object.freeze([
    part("M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"),
    part("M15 4v4M9 10v4M17 16v4"),
  ]),
  help: Object.freeze([
    part("M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z"),
    part("M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8"),
    part("M12 17h.01"),
  ]),
  logout: Object.freeze([
    part("M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"),
    part("M9 16l-4-4 4-4M5 12h10"),
  ]),
  menu: Object.freeze([part("M4 7h16M4 12h16M4 17h16")]),
  close: Object.freeze([part("M6 6l12 12M18 6L6 18")]),
});

export const APP_ICON_NAMES = Object.freeze(Object.keys(APP_ICONS));
