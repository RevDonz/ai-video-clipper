// Icons of the app sidebar (components/AppIcon.jsx), drawn on the editor's grid (24 px, stroke 2,
// round caps; components/editor/ui/icon-paths.mjs) so the app and the editor share one look.
// Each glyph shows its page: a 9:16 frame with a plus for a new clip, two stacked 9:16 frames for
// Proyek (a project is a set of clips), an arrow leaving a tray for Sosial, bars for Analitik, a
// rising line for Tren, sliders for Pengaturan, a shield for Admin, a question mark for Bantuan.
const part = (d, fill = false) => Object.freeze({ d, fill });

export const APP_ICONS = Object.freeze({
  create: Object.freeze([
    part("M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"),
    part("M12 9v6M9 12h6"),
  ]),
  projects: Object.freeze([
    part("M10 6h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"),
    part("M5 17V5a2 2 0 0 1 2-2h7"),
  ]),
  social: Object.freeze([
    part("M12 15V4M8 8l4-4 4 4"),
    part("M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"),
  ]),
  analytics: Object.freeze([part("M5 20V12M12 20V5M19 20v-6"), part("M3 20h18")]),
  trends: Object.freeze([part("M3 17l6-6 4 4 8-8"), part("M15 7h6v6")]),
  admin: Object.freeze([
    part("M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"),
    part("M9 12l2 2 4-4"),
  ]),
  account: Object.freeze([
    part("M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"),
    part("M4 21a8 8 0 0 1 16 0"),
  ]),
  chevron: Object.freeze([part("M6 15l6-6 6 6")]),
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
