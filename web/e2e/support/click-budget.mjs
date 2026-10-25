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
// or `{ testId, within }`; `within` is "topBar", "clips", "stage", "panel", "menu" or "dialog".
// `docClicks` is the §10 cell as written; `budget` is its largest number unless `budgetNote`
// says why not. `pending` names the sub-phase that brings the control to its §10 place (06 §17,
// 08 Fase 10–11); the spec lists those as fixme until then. `excluded` rows have no control to
// count (a waiting screen) or are exempt (Terbitkan, multi-field, 06 §2.3).
const tab = (name) => ({ role: "tab", name, within: "panel" });
const bar = (role, name, extra = {}) => ({ role, name, within: "topBar", ...extra });
const panel = (role, name, extra = {}) => ({ role, name, within: "panel", ...extra });
const stage = (role, name) => ({ role, name, within: "stage" });

const WARNING = Object.freeze([{ code: "tight_cut", ref: "rm_01", f: 120 }]);

const entry = (fields) => Object.freeze(fields);

// The transcript (F2) and segment (F6) rows: the §10 cells as written, and their budgets.
const TRANSCRIPT_CLICKS = { 21: "1", 22: "2", 23: "2", 24: "1 + ketik", 25: "2", 26: "3 / 1", 27: "3", 28: "3", 29: "1", 30: "1", 31: "3", 32: "3" };
const TRANSCRIPT_BUDGET = { 21: 1, 22: 2, 23: 2, 24: 1, 25: 2, 26: 3, 27: 3, 28: 3, 29: 1, 30: 1, 31: 3, 32: 3 };
const SEGMENT_CLICKS = { 33: "2", 34: "2", 35: "2 (atau 1 seret)", 36: "2", 37: "3" };
const SEGMENT_BUDGET = { 33: 2, 34: 2, 35: 2, 36: 2, 37: 3 };

export const CLICK_BUDGET = Object.freeze([
  entry({ row: 1, docClicks: "1", budget: 1, steps: [], target: bar("link", "← Proyek") }),
  entry({ row: 2, docClicks: "1", budget: 1, scenario: { clips: 3 }, steps: [], target: bar("button", "Klip berikutnya") }),
  entry({ row: 3, docClicks: "0–1", budget: 1, steps: [], target: { testId: "save-status", within: "topBar" } }),
  entry({ row: 4, docClicks: "1", budget: 1, steps: [], target: bar("button", "Urungkan") }),
  entry({ row: 5, docClicks: "1–2", budget: 2, scenario: { planWarnings: WARNING }, steps: [], target: bar("button", "^Perlu dicek 1$", { regex: true }) }),
  entry({ row: 6, docClicks: "3", budget: 3, steps: [bar("button", "Lainnya")], target: { role: "menuitem", name: "Kembali ke versi AI", within: "menu" }, extra: 1 }),
  entry({ row: 7, docClicks: "2 / 3", budget: 3, steps: [bar("button", "Lainnya"), { role: "menuitem", name: "Pintasan keyboard", within: "menu" }],
    target: { role: "switch", name: "Pintasan satu tombol", within: "dialog" } }),
  entry({ row: 8, docClicks: "—", excluded: "removed: Mode Cepat / Lengkap is gone" }),
  entry({ row: 9, docClicks: "0", excluded: "no control: the waiting screen while the clip is prepared" }),
  entry({ row: 10, docClicks: "1", budget: 1, pending: "F2", note: "read-only scenario; read-only.spec.mjs covers it in the old shell" }),
  entry({ row: 11, docClicks: "2–3", budget: 3, pending: "F2", note: "conflict scenario" }),
  entry({ row: 12, docClicks: "1", budget: 1, steps: [], target: stage("button", "Putar") }),
  entry({ row: 13, docClicks: "1", budget: 1, steps: [], target: { role: "slider", name: "Posisi putar", within: "stage" } }),
  entry({ row: 14, docClicks: "0–1", budget: 1, steps: [], target: stage("button", "Apa artinya?") }),
  entry({ row: 15, docClicks: "1", budget: 1, steps: [], target: stage("button", "Frame akhir") }),
  entry({ row: 16, docClicks: "1", budget: 1, steps: [], target: stage("button", "Zona aman") }),
  entry({ row: 17, docClicks: "1 seret", budget: 1, pending: "F3" }),
  entry({ row: 18, docClicks: "2 (tab + seret)", budget: 2, pending: "F5" }),
  entry({ row: 19, docClicks: "3 (tab + Lihat sumber + seret)", budget: 3, pending: "F4a" }),
  entry({ row: 20, docClicks: "3", budget: 3, pending: "F4a" }),
  ...[21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].map((row) => entry({ row, docClicks: TRANSCRIPT_CLICKS[row], budget: TRANSCRIPT_BUDGET[row], pending: "F2" })),
  ...[33, 34, 35, 36, 37].map((row) => entry({ row, docClicks: SEGMENT_CLICKS[row], budget: SEGMENT_BUDGET[row], pending: "F6" })),
  entry({ row: 38, docClicks: "4", budget: 4, pending: "F7" }),
  entry({ row: 39, docClicks: "2", budget: 2, pending: "F7" }),
  entry({ row: 40, docClicks: "3", budget: 3, pending: "F7" }),
  entry({ row: 41, docClicks: "1", budget: 1, steps: [], target: panel("switch", "Tampilkan caption") }),
  entry({ row: 42, docClicks: "1", budget: 1, steps: [], target: panel("radiogroup", "Gaya caption") }),
  entry({ row: 43, docClicks: "1", budget: 1, pending: "F3" }),
  entry({ row: 44, docClicks: "3", budget: 3, pending: "F3" }),
  entry({ row: 45, docClicks: "1", budget: 1, pending: "F3" }),
  entry({ row: 46, docClicks: "1", budget: 1, pending: "F3" }),
  entry({ row: 47, docClicks: "2–3", budget: 3, pending: "F3" }),
  entry({ row: 48, docClicks: "1–2", budget: 2, steps: [], target: panel("switch", "Tampilkan hook") }),
  entry({ row: 49, docClicks: "2", budget: 2, pending: "F3" }),
  entry({ row: 50, docClicks: "3", budget: 3, pending: "F3" }),
  entry({ row: 51, docClicks: "2 (+1 kalau di tab lain)", budget: 3, budgetNote: "Tata letak and Logo add their tab's click", pending: "F3" }),
  entry({ row: 52, docClicks: "2", budget: 2, steps: [tab("Tata letak")], target: panel("radiogroup", "Pilih tata letak") }),
  entry({ row: 53, docClicks: "2", budget: 2, pending: "F4b" }),
  entry({ row: 54, docClicks: "4 (tab + shot + Select + opsi); lanjutan ≤ 5", budget: 5, pending: "F4b" }),
  entry({ row: 55, docClicks: "3", budget: 3, pending: "F4b" }),
  entry({ row: 56, docClicks: "0–1", budget: 1, pending: "F4a" }),
  entry({ row: 57, docClicks: "2", budget: 2, pending: "F4a" }),
  entry({ row: 58, docClicks: "3", budget: 3, pending: "F4a" }),
  entry({ row: 59, docClicks: "3", budget: 3, pending: "F4a" }),
  entry({ row: 60, docClicks: "2 / 3", budget: 3, pending: "F4a" }),
  entry({ row: 61, docClicks: "4 (tab + Tambah + pilih file OS + Setuju)", budget: 4, pending: "F5" }),
  ...[62, 63, 64].map((row) => entry({ row, docClicks: "2", budget: 2, pending: "F5" })),
  entry({ row: 65, docClicks: "3–4", budget: 4, pending: "F5" }),
  entry({ row: 66, docClicks: "2", budget: 2, pending: "F5" }),
  entry({ row: 67, docClicks: "3 (tab + Tambah + file OS)", budget: 3, pending: "F5" }),
  ...[68, 69].map((row) => entry({ row, docClicks: "2", budget: 2, pending: "F5" })),
  entry({ row: 70, docClicks: "3", budget: 3, pending: "F5" }),
  entry({ row: 71, docClicks: "2", budget: 2, pending: "F5" }),
  entry({ row: 72, docClicks: "2 / 3", budget: 3, pending: "F5" }),
  entry({ row: 73, docClicks: "2", budget: 2, steps: [tab("Cold open")], target: panel("switch", "Cold open aktif") }),
  entry({ row: 74, docClicks: "3", budget: 3, pending: "F5" }),
  entry({ row: 75, docClicks: "2", budget: 2, pending: "F5" }),
  entry({ row: 76, docClicks: "3", budget: 3, pending: "F5" }),
  entry({ row: 77, docClicks: "2", budget: 2, pending: "F5" }),
  entry({ row: 78, docClicks: "1 buka + aksi", budget: 1, pending: "F2" }),
  entry({ row: 79, docClicks: "2", budget: 2, steps: [], target: bar("button", "Ekspor") }),
  entry({ row: 80, docClicks: "3", budget: 3, pending: "F8" }),
  entry({ row: 81, docClicks: "+1", budget: 1, pending: "F8" }),
  entry({ row: 82, docClicks: "1", budget: 1, pending: "F8" }),
  entry({ row: 83, docClicks: "1", budget: 1, pending: "F8" }),
  entry({ row: 84, docClicks: "3", budget: 3, pending: "F8" }),
  entry({ row: 85, docClicks: "1", budget: 1, pending: "F8" }),
  entry({ row: 86, docClicks: "3", budget: 3, pending: "F8" }),
  entry({ row: 87, docClicks: "≥ 5", excluded: "Terbitkan is multi-field and exempt (06 §2.3)" }),
  entry({ row: 88, docClicks: "0", excluded: "no control: the presence avatars only show" }),
  entry({ row: 89, docClicks: "2", budget: 2, pending: "F5" }),
  entry({ row: 90, docClicks: "1", budget: 1, pending: "F5" }),
  entry({ row: 91, docClicks: "2", budget: 2, pending: "F5" }),
  entry({ row: 92, docClicks: "0", excluded: "no control: the pause marks only show" }),
]);

/** The clicks an entry takes: the reveal steps, the control itself and the counted steps after. */
export function clickCount(item) {
  return (item.steps?.length ?? 0) + 1 + (item.extra ?? 0);
}
