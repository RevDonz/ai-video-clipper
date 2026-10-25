// The click budget of every feature in the one-layout editor (rombak 06 §2.3, §10), one entry per
// row of the §10 table, read by editor-click-budget.spec.mjs and checked against the table by
// tests/editor-click-budget-table.test.mjs.
//
// Counting (06 §2.3): from the editor as it opens (tab Teks), every click, double click and
// option choice is one; an OS file dialog, replaced by setInputFiles, is one; typing is none.
// An entry's count is `steps.length + 1 + (extra ?? 0)`: the clicks that reveal the control, the
// click on the control itself (`target`, which the spec checks is visible and does not press, so
// a link or an upload does not leave the page) and the counted steps after it (`extra`: an OS
// dialog, a confirmation).
//
// A locator is data: `{ role, name, exact = true, within }` (`name` a RegExp source when `regex`),
// `{ testId, within }`, or `{ word, within: "transcript" }` (a transcript word by its index in the
// words artifact; words have no role of their own); `within` is "topBar", "clips", "stage",
// "transcript", "panel", "timeline", "menu" or "dialog". `scenario` sets up the fakes for a row
// (support/editor-shell.mjs openShell): neighbour clips, plan warnings, a read-only clip, a save
// conflict, a cut (`removal: [first, last]` word indexes) or sentences outside the clip (`context`).
// `scenario.doc` opens the clip with one part already set (support/shell-docs.mjs: music, a cold
// open, a text watermark, another layout). A locator with `first` takes the first match (a list).
// `docClicks` is the §10 cell as written; `budget` is its largest number unless `budgetNote`
// says why not. `pending` names the sub-phase that brings the control to its §10 place (06 §17,
// 08 Fase 10–11). Until then a control the one layout already mounts is walked where it sits
// today, within the same budget; one that cannot be walked yet says why (`gap`) and the spec
// lists it as fixme. `excluded` rows have no control to count (a waiting screen) or are exempt
// (Terbitkan, multi-field, 06 §2.3).
const tab = (name) => ({ role: "tab", name, within: "panel" });
const bar = (role, name, extra = {}) => ({ role, name, within: "topBar", ...extra });
const panel = (role, name, extra = {}) => ({ role, name, within: "panel", ...extra });
const stage = (role, name) => ({ role, name, within: "stage" });
const words = (role, name, extra = {}) => ({ role, name, within: "transcript", ...extra });
const word = (index) => ({ word: index, within: "transcript" });
// A body word of the fakes' clip ("film"): a click selects it and its toolbar shows.
const BODY_WORD = 4;
const MORE = words("button", "Lainnya");
const LAYOUT = tab("Tata letak");
const AUDIO = tab("Audio");
const LOGO = tab("Logo");
const COLD_OPEN = tab("Cold open");
const NO_LOGO = "needs a logo, and the fakes have no logo picture to show";

const WARNING = Object.freeze([{ code: "tight_cut", ref: "rm_01", f: 120 }]);

const entry = (fields) => Object.freeze(fields);

// The segment (F6) rows: the §10 cells as written, and their budgets.
const SEGMENT_CLICKS = { 33: "2", 34: "2", 35: "2 (atau 1 seret)", 36: "2", 37: "3" };
const SEGMENT_BUDGET = { 33: 2, 34: 2, 35: 2, 36: 2, 37: 3 };

export const CLICK_BUDGET = Object.freeze([
  entry({ row: 1, docClicks: "1", budget: 1, steps: [], target: bar("link", "← Proyek") }),
  entry({ row: 2, docClicks: "1", budget: 1, scenario: { clips: 3 }, steps: [], target: bar("button", "Klip berikutnya") }),
  entry({ row: 3, docClicks: "0–1", budget: 1, steps: [], target: { testId: "save-status", within: "topBar" } }),
  entry({ row: 4, docClicks: "1", budget: 1, steps: [], target: bar("button", "Urungkan") }),
  entry({ row: 5, docClicks: "1–2", budget: 2, scenario: { planWarnings: WARNING }, steps: [], target: bar("button", "^Perlu dicek 1$", { regex: true }) }),
  entry({ row: 6, docClicks: "3", budget: 3, steps: [bar("button", "Lainnya")], target: { role: "menuitem", name: "Kembali ke versi AI", within: "menu" }, extra: 1 }),
  entry({ row: 7, docClicks: "2 / 3", budget: 3, steps: [bar("button", "Lainnya"), { role: "menuitem", name: "^Pintasan keyboard", regex: true, within: "menu" }],
    target: { role: "switch", name: "Pintasan satu tombol", within: "dialog" } }),
  entry({ row: 8, docClicks: "—", excluded: "removed: Mode Cepat / Lengkap is gone" }),
  entry({ row: 9, docClicks: "0", excluded: "no control: the waiting screen while the clip is prepared" }),
  entry({ row: 10, docClicks: "1", budget: 1, scenario: { readOnly: true }, steps: [], target: stage("button", "Mulai dari versi AI") }),
  // The conflict dialog opens by itself; a part's choice and Terapkan pilihan are the two clicks.
  entry({ row: 11, docClicks: "2–3", budget: 3, scenario: { conflict: true }, steps: [],
    target: { role: "radio", name: "Pakai punyaku", within: "dialog" }, extra: 1 }),
  entry({ row: 12, docClicks: "1", budget: 1, steps: [], target: stage("button", "Putar") }),
  entry({ row: 13, docClicks: "1", budget: 1, steps: [], target: { role: "slider", name: "Posisi putar", within: "stage" } }),
  entry({ row: 14, docClicks: "0–1", budget: 1, steps: [], target: stage("button", "Apa artinya?") }),
  entry({ row: 15, docClicks: "1", budget: 1, steps: [], target: stage("button", "Frame akhir") }),
  entry({ row: 16, docClicks: "1", budget: 1, steps: [], target: stage("button", "Zona aman") }),
  // The caption box on the stage is the drag handle itself (one drag, counted as its click).
  entry({ row: 17, docClicks: "1 seret", budget: 1, pending: "F3", steps: [], target: stage("slider", "Caption di video") }),
  entry({ row: 18, docClicks: "2 (tab + seret)", budget: 2, pending: "F5", gap: `the logo gizmo ${NO_LOGO}` }),
  // Until F4a brings Lihat sumber, Atur bingkai and Atur potongan open the dialogs the drag happens in.
  entry({ row: 19, docClicks: "3 (tab + Lihat sumber + seret)", budget: 3, pending: "F4a", scenario: { doc: "fillCenter" },
    steps: [LAYOUT], target: panel("button", "Atur bingkai"), extra: 1 }),
  entry({ row: 20, docClicks: "3", budget: 3, pending: "F4a", scenario: { doc: "split" },
    steps: [LAYOUT], target: panel("button", "Atur potongan"), extra: 1 }),
  entry({ row: 21, docClicks: "1", budget: 1, steps: [], target: word(BODY_WORD) }),
  entry({ row: 22, docClicks: "2", budget: 2, steps: [word(BODY_WORD)], target: words("button", "Hapus") }),
  entry({ row: 23, docClicks: "2", budget: 2, steps: [word(BODY_WORD)], target: words("button", "Edit kata") }),
  // Baris is one click; typing in its line fields is not counted.
  entry({ row: 24, docClicks: "1 + ketik", budget: 1, steps: [], target: words("radio", "Baris") }),
  entry({ row: 25, docClicks: "2", budget: 2, steps: [word(BODY_WORD)], target: words("button", "Mulai di sini") }),
  // From the menu; Ctrl+click on a word is the one-click way (editor-transcript-shell.spec.mjs).
  entry({ row: 26, docClicks: "3 / 1", budget: 3, steps: [word(BODY_WORD), MORE],
    target: { role: "menuitemcheckbox", name: "^Kata kunci", regex: true, within: "menu" } }),
  entry({ row: 27, docClicks: "3", budget: 3, steps: [word(BODY_WORD), MORE],
    target: { role: "menuitemcheckbox", name: "^Sembunyikan dari caption", regex: true, within: "menu" } }),
  entry({ row: 28, docClicks: "3", budget: 3, steps: [word(BODY_WORD), MORE],
    target: { role: "menuitem", name: "^Jadikan cold open", regex: true, within: "menu" } }),
  entry({ row: 29, docClicks: "1", budget: 1, scenario: { removal: [6, 7] }, steps: [],
    target: words("button", "^Pulihkan potongan", { regex: true }) }),
  entry({ row: 30, docClicks: "1", budget: 1, scenario: { context: true }, steps: [],
    target: words("button", "^Tampilkan \\d+ kalimat sebelumnya", { regex: true }) }),
  // Rapikan n opens the drawer on its tab; Terapkan (n) applies (the third click checks an item).
  entry({ row: 31, docClicks: "3", budget: 3, steps: [words("button", "^Rapikan", { regex: true })],
    target: { role: "button", name: "^Terapkan \\(\\d+\\)$", regex: true, within: "dialog" } }),
  entry({ row: 32, docClicks: "3", budget: 3, steps: [words("button", "^Ejaan", { regex: true })],
    target: { role: "tab", name: "^Ejaan", regex: true, within: "dialog" } }),
  ...[33, 34, 35, 36, 37].map((row) => entry({ row, docClicks: SEGMENT_CLICKS[row], budget: SEGMENT_BUDGET[row], pending: "F6",
    gap: "new: the segment strip arrives with F6" })),
  entry({ row: 38, docClicks: "4", budget: 4, pending: "F7", gap: "new: merging clips arrives with F7" }),
  entry({ row: 39, docClicks: "2", budget: 2, pending: "F7", gap: "new: duplicating a clip arrives with F7" }),
  entry({ row: 40, docClicks: "3", budget: 3, pending: "F7", gap: "new: derived clips arrive with F7" }),
  entry({ row: 41, docClicks: "1", budget: 1, steps: [], target: panel("switch", "Tampilkan caption") }),
  // The packs and the layouts are still the panels' fieldsets (role group); F3 and F4a bring the
  // RadioGroup of 06 §8. A menu item's name ends with its shortcut, hence the anchored regexes.
  entry({ row: 42, docClicks: "1", budget: 1, steps: [], target: panel("group", "Gaya caption") }),
  // Teks shows every caption and hook control today; F3 folds the fine ones into Lanjutan.
  entry({ row: 43, docClicks: "1", budget: 1, pending: "F3", steps: [], target: panel("slider", "^Posisi caption", { regex: true }) }),
  entry({ row: 44, docClicks: "3", budget: 3, pending: "F3", steps: [], target: panel("slider", "^Ukuran caption", { regex: true }) }),
  entry({ row: 45, docClicks: "1", budget: 1, pending: "F3", gap: "shown only when the plan finds the caption over a face, which the fakes' plan never does" }),
  entry({ row: 46, docClicks: "1", budget: 1, pending: "F3", steps: [], target: panel("radiogroup", "Warna sorot") }),
  entry({ row: 47, docClicks: "2–3", budget: 3, pending: "F3", steps: [], target: panel("radiogroup", "Kata per baris") }),
  entry({ row: 48, docClicks: "1–2", budget: 2, steps: [], target: panel("switch", "Tampilkan hook") }),
  entry({ row: 49, docClicks: "2", budget: 2, pending: "F3", steps: [], target: panel("button", "^Pakai hook: ", { regex: true, first: true }) }),
  entry({ row: 50, docClicks: "3", budget: 3, pending: "F3", steps: [], target: panel("group", "Desain hook") }),
  // F3 adds the confirmation and its Urungkan toast; today the button applies at once.
  entry({ row: 51, docClicks: "2 (+1 kalau di tab lain)", budget: 3, budgetNote: "Tata letak and Logo add their tab's click", pending: "F3",
    scenario: { clips: 3 }, steps: [], target: panel("button", "Pakai caption di semua klip") }),
  entry({ row: 52, docClicks: "2", budget: 2, steps: [tab("Tata letak")], target: panel("group", "Pilih tata letak") }),
  entry({ row: 53, docClicks: "2", budget: 2, pending: "F4b", gap: "new: the Otomatis card arrives with F4b" }),
  entry({ row: 54, docClicks: "4 (tab + shot + Select + opsi); lanjutan ≤ 5", budget: 5, pending: "F4b", gap: "new: the shot strip arrives with F4b" }),
  entry({ row: 55, docClicks: "3", budget: 3, pending: "F4b", gap: "new: the shot popover arrives with F4b" }),
  entry({ row: 56, docClicks: "0–1", budget: 1, pending: "F4a", gap: "shown only while a face analysis runs or after it fails, which the fakes do not stage" }),
  entry({ row: 57, docClicks: "2", budget: 2, pending: "F4a", gap: "needs Ikuti wajah with a face analysis, which the fakes do not stage" }),
  entry({ row: 58, docClicks: "3", budget: 3, pending: "F4a", gap: "needs manual keyframes, which no shell doc sets yet" }),
  entry({ row: 59, docClicks: "3", budget: 3, pending: "F4a", steps: [LAYOUT], target: panel("slider", "Zoom") }),
  entry({ row: 60, docClicks: "2 / 3", budget: 3, pending: "F4a", scenario: { doc: "split" }, steps: [LAYOUT], target: panel("radiogroup", "Pembagian") }),
  // Tambah musik shows the one-time copyright notice; its Pilih file musik opens the OS dialog.
  entry({ row: 61, docClicks: "4 (tab + Tambah + pilih file OS + Setuju)", budget: 4, pending: "F5",
    steps: [AUDIO, panel("button", "Tambah musik")], target: panel("button", "Pilih file musik"), extra: 1 }),
  entry({ row: 62, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "music" }, steps: [AUDIO], target: panel("button", "Hapus musik") }),
  entry({ row: 63, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "music" }, steps: [AUDIO], target: panel("slider", "Volume musik") }),
  entry({ row: 64, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "music" }, steps: [AUDIO],
    target: panel("switch", "Kecilkan musik saat ada suara") }),
  entry({ row: 65, docClicks: "3–4", budget: 4, pending: "F5", scenario: { doc: "music" }, steps: [AUDIO], target: panel("slider", "Mulai dari") }),
  entry({ row: 66, docClicks: "2", budget: 2, pending: "F5", steps: [AUDIO], target: panel("slider", "Volume suara asli") }),
  entry({ row: 67, docClicks: "3 (tab + Tambah + file OS)", budget: 3, pending: "F5", steps: [LOGO], target: panel("button", "Unggah logo"), extra: 1 }),
  ...[68, 69].map((row) => entry({ row, docClicks: "2", budget: 2, pending: "F5", gap: NO_LOGO })),
  entry({ row: 70, docClicks: "3", budget: 3, pending: "F5", gap: NO_LOGO }),
  entry({ row: 71, docClicks: "2", budget: 2, pending: "F5", gap: NO_LOGO }),
  // Typing the text is not counted; its position, size and opacity show once it is set (row 89's doc).
  entry({ row: 72, docClicks: "2 / 3", budget: 3, pending: "F5", steps: [LOGO], target: panel("textbox", "Teks watermark") }),
  entry({ row: 73, docClicks: "2", budget: 2, steps: [tab("Cold open")], target: panel("switch", "Cold open aktif") }),
  entry({ row: 74, docClicks: "3", budget: 3, pending: "F5", gap: "needs cold-open candidates, which the shell scenario does not stage yet" }),
  entry({ row: 75, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "coldOpen" }, steps: [COLD_OPEN],
    target: panel("group", "Geser tepi cold open") }),
  entry({ row: 76, docClicks: "3", budget: 3, pending: "F5", scenario: { doc: "coldOpen" }, steps: [COLD_OPEN],
    target: panel("group", "Geser tepi cold open 0,1 detik") }),
  entry({ row: 77, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "coldOpen" }, steps: [COLD_OPEN], target: panel("group", "Efek gambar") }),
  entry({ row: 78, docClicks: "1 buka + aksi", budget: 1, steps: [], target: { role: "button", name: "Linimasa detail", within: "timeline" } }),
  entry({ row: 79, docClicks: "2", budget: 2, steps: [], target: bar("button", "Ekspor") }),
  entry({ row: 80, docClicks: "3", budget: 3, pending: "F8", gap: "new: the 720p size arrives with F8" }),
  entry({ row: 81, docClicks: "+1", budget: 1, pending: "F8", gap: "F8 changes the export checks to one Ekspor tetap (06 §15)" }),
  ...[82, 83].map((row) => entry({ row, docClicks: "1", budget: 1, pending: "F8",
    gap: "inside the export dialog once a render runs; walked when F8 moves the dialog onto the kit" })),
  entry({ row: 84, docClicks: "3", budget: 3, pending: "F8", gap: "inside the export dialog once a render runs; walked when F8 moves the dialog onto the kit" }),
  entry({ row: 85, docClicks: "1", budget: 1, pending: "F8", gap: "new: the export queue button arrives with F8" }),
  entry({ row: 86, docClicks: "3", budget: 3, pending: "F8", gap: "new: Ekspor semua arrives with F8" }),
  entry({ row: 87, docClicks: "≥ 5", excluded: "Terbitkan is multi-field and exempt (06 §2.3)" }),
  entry({ row: 88, docClicks: "0", excluded: "no control: the presence avatars only show" }),
  entry({ row: 89, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "watermark" }, steps: [LOGO], target: panel("button", "Hapus teks") }),
  entry({ row: 90, docClicks: "1", budget: 1, pending: "F5", gap: "shown only while an upload runs, which the fakes finish at once" }),
  entry({ row: 91, docClicks: "2", budget: 2, pending: "F5", scenario: { doc: "coldOpen" }, steps: [COLD_OPEN], target: panel("button", "Putar transisi") }),
  entry({ row: 92, docClicks: "0", excluded: "no control: the pause marks only show" }),
]);

/** The clicks an entry takes: the reveal steps, the control itself and the counted steps after. */
export function clickCount(item) {
  return (item.steps?.length ?? 0) + 1 + (item.extra ?? 0);
}
