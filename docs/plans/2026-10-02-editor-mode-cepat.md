# Editor Mode Cepat and Mode Lengkap: build spec

Date: 2026-10-02. Status: ready to build after the cold-open transition merges (§10). Branch of
this spec: `mode-cepat-spec`.

On 2026-10-02 the owner approved the "Mode Cepat" mockup ("oke sih ini mode cepat"). The mockup has
two boards:
- `Main.dc.html`, Mode Cepat, the default view;
- `Lengkap.dc.html`, Mode Lengkap, today's full editor with an icon rail and a word toolbar.

Both boards live in the session scratchpad (`editor-mockup/project/`), not in the repo. This spec
records what they show, so the builders do not need them.

The owner's rules still apply: `AGENTS.md` (latest only, Indonesian copy, tests first, no heavy
local runs) and `DESIGN.md` (dark, DM Sans, one lime accent, dial ENERGY 1 / RHYTHM 1 / MOTION 2).
Every builder announces `antislop active: during (project setting).` before the first edit. They
follow the antislop core skill plus the ui, copywriting and human skills.

Everything below was checked against `origin/main` `8996a1b` and the transition branches
`origin/transisi-{spec,t1,t2,t3}` as of 2026-10-02. The first-frame fix
(`fix/editor-first-frame`) is not on origin yet, and its local branch has no commits beyond
`main`. §10 says how to absorb it when it lands.

## 0. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| What the two modes are | Two **views** of one editor: one document, one store, one undo history, one autosave, one two-tab merge, one player | Nothing forks. Mode Lengkap is not an old editor kept alive, so the latest-only rule holds (§5.4) |
| Default view | Mode Cepat, unless the viewer last picked Lengkap or a deep link says otherwise (§4) | Owner decision |
| Where the preference lives | `localStorage["potongin-editor-view"]`, per viewer, every access in `try/catch` | A per-viewer convenience. Losing it only means opening in Cepat |
| Which Cepat card is open on load | **Caption** (as in the mockup); `?card=` overrides. It is not remembered | Opening the Hook card mounts the hook suggestions, which ask the free LLM. An open Hook card on every load would spend the daily quota (§11 R1) |
| Caption line edits | A line edit becomes word edits (`EditWordText`, `SetWordHidden`) on the cue's word ids. Timing never moves. Inserted words ride on a neighbour word (§2) | Word ids and times come only from the words artifact. There is no "new word" in the model |
| One commit = one undo step | All commands of one line commit share one `actionKey()` merge key and are dry-run first (all or nothing) | Same pattern as Rapikan and the transcript toolbar |
| Caption vs hook clash | New server warning `caption_hook_overlap`, computed from the geometry the ASS uses and pixel-checked by a gate (§3) | The mockup's "Pilih Tengah atau Bawah" must be true for every pack, size and hook length. A client guess would not be |
| Caption size and position in Cepat | Three presets each. Bawah = 83000, today's seed spot (K5) | An unchanged clip still exports its auto file (R10) |
| Transition copy in the Cold open card | The transition PR's strings (`JOIN_STYLE_NAMES`, "Suara whoosh", "Putar transisi"), not the mockup's shorter ones | Both views must read the same; the strings already ship with T3 (§11 Q2) |
| The 5-lane timeline in Cepat | Replaced by one scrubber with laugh, pause, cold-open and transition marks | Mockup |
| Timeline in Lengkap | Unchanged: no file under `web/components/editor/timeline/**` changes | Owner brief |
| Lengkap tabs | An 84 px icon rail that keeps `role="tab"` and the tab names | The text tabs wrap onto two rows today. Keeping the role and the names leaves every `getByRole("tab", …)` spec working |
| Transcript actions | A contextual toolbar above the selected words replaces the 9 permanent chips | Mockup |
| Technical texts | The legacy notice and the legacy badge leave the screen. What a viewer still needs moves into the preview's status help and the export dialog (§5.3) | Owner brief plus latest only |
| Lime | On the editor screen only **Ekspor** and transient progress fills use `--accent`. A dialog keeps one lime primary action | `DESIGN.md`, and the mockup's "only Ekspor in lime" |
| Focus ring | The existing `--focus` token through `--ed-focus-ring`, not the mockup's lime outline | Lime is reserved for Ekspor. `--focus` is already AA on every surface |

## 1. Information architecture

### 1.1 Screen regions

```
Mode Cepat (≥ 1024 px)
┌ top bar 64 px ─ ← Proyek │ title · Tersimpan │ [Cepat|Lengkap] │ ↶ ↷ │ Perlu dicek (n) │ ⋯ │ Ekspor ┐
├ preview (1fr) ─────────────────────────────┬ cards  clamp(360px, 32vw, 460px) ──────────────────┤
│  status pill (top left)   Zona aman (top right)  │ HOOK · CAPTION · TEKS CAPTION · COLD OPEN ·       │
│            9:16 stage, centred           │ TATA LETAK · LOGO & MUSIK (accordion, one open)  │
├ bottom 96 px ─ ▶ 00:02,2 / 01:00,6 ─ scrubber + legend ─ Potong per kata di Mode Lengkap → ──────┤

Mode Lengkap
┌ top bar 64 px (the same component) ──────────────────────────────────────────────────────────────┐
├ rail 84 px ┬ panel var(--ed-panel-width) ─┬ preview (1fr), same overlays ──────────────────────┤
├ transport 56 px ─ ▶ ◀| |▶ 00:02,2 / 01:00,6 ─────────────────────────────────────────────────────┤
├ Timeline (unchanged component, var(--ed-timeline-height)) ─────────────────────────────────────┤
```

- One CSS grid with named areas per view: `top`, `side`, `stage` and `bottom`, plus `rail` in
  Lengkap. The shell renders its children in a fixed order: `TopBar`, side region, `StageRegion`,
  bottom region. Only the side and bottom children change with the view.
- **`StageRegion` keeps the same element, parent and key in both views.** A view switch must
  never remount the canvas, the player, the frame bus, the export flow or the store. The page
  stays at least 1024 px wide; below that the existing "Editor butuh layar minimal 1024 px" page
  is unchanged.
- At 1366×768 the preview area is 608 px tall (768 − 64 − 96), so the stage is about 324×576.

### 1.2 Which code powers each Mode Cepat card

Every card gets the same props bundle as a panel today (`state`, `dispatch`, `player`, `api`,
`previewClient`, `uploadAsset`, `uploadsEnabled`, `notify`, `readOnly`), plus `frameBus` and
`showLengkap(panelId)`. The shell builds the bundle once and spreads it onto `<Panel>` and
`<QuickPanel>` alike (§9.5 updates the W2 seams test).

| Card (label · id) | Existing code it reuses | Commands | New |
|---|---|---|---|
| HOOK · `hook` | `TextPanel` hook rules (`clean`, 90-point limit, fit badge from `plan.hook.overflow`), `suggestions/model.mjs` (`suggestionsFor`, `aiView`, `applyCommand`, `COPY`) | `SetHookEnabled`, `SetHookText` (merge key `hook:text`, as today), suggestion `SetHookText` with origin `suggestion:<id>` | A compact suggestion list: one 44 px button per suggestion, `aria-pressed` on the current one, no source label. The shared suggestions hook is pulled out of `suggestions/index.jsx` |
| CAPTION · `caption` | `TextPanel` caption rules, `pack-thumbs/*.png`, `CAPTION_SWATCHES` | `SetCaptionsEnabled`, `SetCaptionPack`, `SetCaptionOverride` (`size_pm`, `y_e5`, `highlight`) with merge key `null`, so each pick is one undo step | Size and position presets (§1.4), the clash note (§3), the K5 note at Bawah |
| TEKS CAPTION · `lines` | `plan.cues` (the caption lines the viewer sees), `state.words`, `doc.captions.word_edits` | `EditWordText`, `SetWordHidden` | The whole line editor (§2) |
| COLD OPEN · `coldopen` | `transcript/model.mjs` (`buildTranscriptModel`, `coldOpenInfo`), `panels/coldopen-suggestions.mjs`, `panels/coldopen-transition.mjs` (from T3), the panel's `useAudition` | `SetColdOpen` (a suggestion, or `null` to remove), `SetJoinStyle`, `SetJoinSfx` | The card layout. The suggestion list and `useAudition` move out of `ColdOpenPanel.jsx` into `panels/ColdOpenSuggestions.jsx` and `panels/use-audition.js`, used by both views |
| TATA LETAK · `layout` | `panels/layout-model.mjs` (`LAYOUT_OPTIONS` names, `switchSteps`, `cameraReadyFromState`) and the face-analysis flow of `LayoutPanel.jsx` | `SetLayout` (after `prepare {layout:"camera"}` when needed) | A three-pill group. The analysis flow moves into a shared hook `panels/use-layout-switch.js` |
| LOGO & MUSIK · `extras` | `gizmos/logo-upload.mjs` (`logoUploader`), `panels/logo-model.mjs`, `panels/music-upload.mjs`, `panels/music-model.mjs` (`DUCK_PRESET_LIST`, `musicCommands`), MusicPanel's one-time copyright notice (same `localStorage` key, so it is shown once across both views) | `SetLogo`, `SnapLogo`, `RemoveLogo`, `SetMusic`, `SetDuck`, `RemoveMusic` | A compact card. "Atur detail di Mode Lengkap" opens the full panel |

The stage's logo gizmo (drag and resize on the preview) works in both views, because it lives in
`StageRegion`.

### 1.3 Card behaviour

- Accordion: one card open at a time. Clicking the open card's header closes it, so none is open.
- Load state: Caption is open. `?card=<id>` opens that card instead. The open card is not
  remembered (R1).
- Each header is a `<h2>` holding a full-width `<button aria-expanded aria-controls>`, 56 px tall.
  It shows the uppercase label, a one-line summary (ellipsis) and a chevron. The body is a region
  with `aria-labelledby` pointing at the header.
- Bodies load lazily. A card's code and its data requests start only when it first opens: the
  hook suggestions, the cold-open candidates and the camera status. The first paint does not wait
  for any card (PF-OPEN, §9.4).
- Summaries come from the pure module `quick/quick-model.mjs`:

| Card | Summary |
|---|---|
| Hook | the hook text, or "Mati" |
| Caption | "Karaoke · Sedang · Bawah"; a size or position set off-preset in Lengkap shows its percent ("· 92%", "· posisi 72%"); "Mati" when captions are off |
| Teks caption | `linesSummary()` from `lib/editor/caption-lines.mjs`: "12 baris", "12 baris · 2 diubah", "Caption mati" or "Menyiapkan…" |
| Cold open | `JOIN_STYLE_NAMES[style]` plus " + whoosh" when on, or "Mati" |
| Tata letak | the layout option name |
| Logo & Musik | "Belum ada", "Logo", "Musik" or "Logo dan musik" |

- In read-only mode every card body is a disabled `fieldset`. Playing ("Putar", "Putar transisi")
  still works, as in the panels today.

### 1.4 Card contents

**Hook.** A "Tampilkan hook" switch, then "Teks di awal klip": an input with a 90-point limit, a
counter and the fit badge "Muat", "Akan terpotong" or "Memeriksa…". Below them, "Saran": a 44 px
button per suggestion; a click applies it. While the AI part runs, one muted line shows the
existing `COPY` loading text. Duration and position stay in Lengkap.

**Caption.**
- A "Tampilkan caption" switch, then the four pack tiles (the existing FFmpeg thumbnails, radio
  semantics, 2×2).
- "Warna sorot": the six `CAPTION_SWATCHES`, each a 44 px target around a 28 px dot. The row is
  disabled for Klasik and Box with the note "Hanya untuk Karaoke dan Bold."
- "Ukuran": Kecil 850, Sedang 1000 (the seed), Besar 1200 (`size_pm`).
- "Posisi" (`y_e5`, the bottom of the caption block): Atas 38000, Tengah 60000, Bawah 83000 (the
  seed spot, K5).
- A value off the presets presses no pill.
- At Bawah, when the plan has the caption `unsafe_zone` warning, the K5 note reads "Dekat tombol
  TikTok. Kalau tertutup, pilih Tengah."
- When the plan has `caption_hook_overlap` (§3), the card shows "Caption menimpa teks hook. Pilih
  posisi lain." (text role, not `alert`; the same warning is in "Perlu dicek").

**Teks caption.** §2.

**Cold open.**
- With a cold open, a quote box: "“text”" and "1,8 dtk · diputar paling awal" (from
  `coldOpenInfo`). Below it, "Putar" and "Ganti kalimat".
- "Ganti kalimat" expands `ColdOpenSuggestions` inside the card: each candidate has "Putar" and
  "Pakai".
- Then the Transisi group: legend "Transisi", the three `TRANSITION_STYLES` as pills, a "Suara
  whoosh" switch and "Putar transisi" ("Hentikan" while playing).
- At the bottom, a quiet "Hapus cold open" button (`SetColdOpen(null)`).
- Without a cold open, the card says "Belum ada cold open." with a "Pilih kalimat" button, which
  opens the same suggestion list.

**Tata letak.** Three pills: Latar blur, Potong tengah, Ikuti wajah. Ikuti wajah without a camera
plan runs the existing analysis, with its progress, through the shared hook. The no-face note
stays as in the panel.

**Logo & Musik.**
- Logo. None: a dashed "Tambah logo" button (file picker). With a logo: its corner pills (Kiri
  atas, Kanan atas, Kiri bawah, Kanan bawah via `SnapLogo`), "Ganti" and "Hapus".
- Musik. None: "Tambah musik", which shows the copyright notice the first time. With music: the
  file name, "Saat ada suara" pills Halus, Sedang and Kuat (`SetDuck`), "Ganti" and "Hapus".
- When `uploadsEnabled` is false, the add buttons are disabled with the existing reason.
- "Atur detail di Mode Lengkap" calls `showLengkap("logo")` or `showLengkap("music")`.

### 1.5 What stays only in Mode Lengkap

- The transcript: cuts, trims, "Perpanjang ke sini", Rapikan, keyword marking, hiding single
  words, editing words in place.
- Hook duration and position. Caption size and position sliders, upper case, keyword colour.
- Cold-open word nudges.
- Logo size and opacity. Music gain, start, loop, fades and duck detail.
- Clip volume and loudness.
- The timeline lanes and the frame-step buttons.

Global shortcuts work in both views (§4.5). The Cepat bottom bar links to Lengkap: "Potong per
kata di Mode Lengkap →" calls `showLengkap("transcript")`.

## 2. Teks caption: line edits as word edits

### 2.1 Rows

`captionRows({ plan, doc, words })` in the new pure module `web/lib/editor/caption-lines.mjs`
gives one row per `plan.cues` entry, in order:

```js
{ key: cue.words[0], f0, f1, cold, wordIds: cue.words, text, edited }
```

- `cold` is `f0 < J`, where J is the sum of the cold open's piece frames (`pieces(doc)`).
- `text` is the cue's words joined by one space. Each word's text is `word_edits[id].text ??`
  the ASR text, as stored: no upper-case transform, punctuation kept.
- `edited` is true when any word of the row has a text edit.
- Cues come from the plan, so the rows show exactly the lines the viewer sees: hidden words are
  absent, and the Box pack's width splits are present.
- The text comes from the current document, so a commit updates its row at once, before the next
  plan arrives.
- A cold-open line appears twice (once in the cold open, once in the body), because those are the
  same spoken words. Editing either row changes both. Cold-open rows carry a "Cold open" tag in
  `--cold-open`.
- Captions off: the card says "Caption mati. Nyalakan di kartu Caption." No plan yet: "Menyiapkan
  baris caption…".

Each row shows the time label (`formatClock(frameToMs(f0, fps))` from `shell-model.mjs`, for example "00:01,9") as the input's
`<label>`, then a text input (44 px tall, `maxLength` 160, `spellCheck` off). Focusing a row while
paused seeks the player to `f0`, so the preview shows that line. During playback, the row under the
playhead gets the `--text` border; the frame bus drives it, outside React. That row scrolls into
view (nearest) unless an input in the card has focus or the pointer is over the card. The help
line above the rows reads: "Ketik langsung untuk membetulkan kata. Waktunya tetap pas."

### 2.2 Editing

- The draft is local to the row. It is committed on Enter, on blur and on Tab (Tab then moves to
  the next row's input). Esc restores the row's text and keeps focus.
- A draft equal to the row's text (after the normalisation below) commits nothing.
- Commit = `lineEdit()` (§2.3) → dry run (§2.5) → dispatch. On a refusal the row keeps the draft,
  gets `aria-invalid="true"`, and a message under it (`role="alert"`) says why.
- An empty draft hides every word of the row (a deletion of the whole line). The status line
  under the card says "Baris disembunyikan dari caption." Urungkan brings it back.

### 2.3 The diff

`lineEdit({ row, draft, doc, words })` → `{ ok: true, commands }` or `{ ok: false, code, message }`.

1. `old` = the row's words as `[{ id, text }]`, with the current text.
   `new` = `draft.normalize("NFC").trim().split(/\s+/u)`, filtering out empty strings.
2. If `new` is empty: one `SetWordHidden {wordId, on: true}` per old word. Stop.
3. Anchors = the longest common subsequence of `old[i].text` and `new[j]`, by exact string
   equality (case and punctuation count). Ties go to the earliest pairing, so the result is
   deterministic.
4. Walk the hunks between anchors. Hunk `h` holds `k` old words `O` and `m` new tokens `N`:
   - for `t < min(k, m)`: the final text of `O[t]` is `N[t]` (a change);
   - if `k > m`: `O[m..k)` are deletions;
   - if `m > k`: the extra tokens `N[k..m)` are **insertions**, attached to a host word:
     - when `k > 0`, the host is `O[k−1]`: append `" " + extras.join(" ")` to its final text;
     - when `k = 0` and an anchor precedes the hunk, the host is that anchor: append;
     - when `k = 0` at the start of the row, the host is the first anchor after the hunk:
       prepend `extras.join(" ") + " "`.

     A host may receive both a prepend and an append. The algorithm accumulates one final text
     per word id.
5. Emit the commands in row order:
   - one `EditWordText {wordId, text}` per word whose final text differs from its current text
     (`EditWordText` already drops the edit when the text equals the ASR text, so typing the
     original back restores the seed's content);
   - one `SetWordHidden {wordId, on: true}` per deletion.

Examples. The row is `mulai aja dulu dari` (`w1 w2 w3 w4`):

| Draft | Commands |
|---|---|
| `mulai aja dulu ya dari` | `EditWordText w3 "dulu ya"` |
| `mulai dulu dari` | `SetWordHidden w2 on` |
| `mulai aja duluan dari` | `EditWordText w3 "duluan"` |
| `Yuk mulai aja dulu dari` | `EditWordText w1 "Yuk mulai"` |
| `mulai saja deh dari` | `EditWordText w2 "saja"`, `EditWordText w3 "deh"` |
| `` (empty) | `SetWordHidden` w1, w2, w3, w4 |

What the viewer gets:
- An inserted word shares its host's timing: Karaoke and Bold light it up together with the host.
- A word hidden here leaves its row. Urungkan brings it back, or "Sembunyikan" in Mode
  Lengkap's transcript. Audio never changes: a line edit cuts nothing.

### 2.4 Limits and messages

| Rule | Refusal (code → message) |
|---|---|
| More than 40 tokens in a draft | `too_many_tokens` → "Terlalu banyak kata dalam satu baris." |
| A final word text over 40 code points (`LIMITS.wordText`) | `text_too_long` → "Kata terlalu panjang (maks. 40 huruf). Pisahkan di baris lain." |
| Control or lone-surrogate characters | `text_invalid` → `COMMAND_MESSAGES.text_invalid` |
| Over 6000 word edits in the document | `too_many_word_edits` → `COMMAND_MESSAGES.too_many_word_edits` |
| Read-only clip | the inputs are `readOnly`; nothing commits |

The two new codes are messages of `caption-lines.mjs`. They are not command codes, so
`commands.mjs` does not change.

### 2.5 Atomic commit, undo, merge, autosave

- **Dry run.** Before dispatching, `checkCommands(doc, ctx, commands)` folds `applyCommand`
  (`commands.mjs`) over `state.doc` with
  `ctx = createContext({ words: state.words, seed: state.seed })`, memoised per words and seed,
  as `TranscriptPanel` already builds it. The first `CommandRejected` refuses the whole commit
  and dispatches nothing.
- **One undo step.** All commands go through `runCommands(dispatch, commands)` with one merge
  key from `actionKey("captionLine")`. They run synchronously, inside the history's 500 ms merge
  window, so they form one entry. If the store still refuses one after a passing dry run (it
  cannot without a concurrent change), the earlier ones are in that same entry and one Urungkan
  removes them.
- **Two tabs.** The merge parts are per word (`word:<id>.text`, `word:<id>.hidden`), so line
  edits merge like transcript word edits today. No rebase change is needed.
- **Autosave and drafts** need nothing new: these are ordinary commands.
- **Focus across regrouping.** A text change can split or join Box rows, because `fit_cues`
  measures width. Rows are keyed by their first word id. When the plan arrives and the focused
  row's key is gone, focus moves to the row that now contains the focused row's first word.

### 2.6 Fakes

`fakePlan` in `web/components/editor/__dev__/fakes.mjs` builds cues from all words today. It
changes to:
- skip hidden words;
- with the `box` pack, split cues whose text is over 24 characters, so the e2e can exercise
  regrouping;
- emit `caption_hook_overlap` when a hook exists and `y_e5 ≤ 45000`. This is a dev-only
  approximation, commented as such. The real rule is §3.

## 3. Caption vs hook clash: `caption_hook_overlap`

- **Where.** `src/ai_clipper/edit_v2/captions.py` `caption_track`, next to the existing
  `unsafe_zone` checks. It uses the numbers `build_ass_v2` writes:
  - **hook box:** from `layout_hook` (`top`, `padding`, `font_size`, `lines`) as the legacy-bar
    design draws it;
  - **caption block:** bottom = `height − margin_v`; top = bottom − the cue's line count × the
    pack's line height. The line count comes from the pack font's `hmtx` width against the usable
    width, the measure `fit_cues._fits` uses; a helper shares it.
- **When.** The vertical ranges overlap during any frame where the hook item `[f0, f1)` and a cue
  `[f0, f1)` are both visible.
- **Issue.** `Issue("caption_hook_overlap", "/captions/overrides/y_e5", <hook item id>, <first
  overlapping frame>)`, once per document.
- **Code.** In `errors.WARNING_CODES` (export asks for a tick in "Perlu dicek"). Message in
  `errors._MESSAGES`: "Caption menimpa teks hook". The integrator mirrors it in `shell-model.mjs`
  `MESSAGES` (§10, Z), because `editor-shell-model.test.mjs` requires every JS message to equal
  its Python twin.
- **Seeds and R10.** Unchanged. Seeds put the hook top at 13 % and the caption bottom at 83 %, so
  no seed has the warning. Test: every fixture seed and every golden plan sha is unchanged. The
  warning only appears in plans whose documents clash.
- **Gate G-CLASH** (CI image, `suite=command`):
  - Cases: every combination of 4 packs × 3 sizes × 3 positions × hooks of 1, 2 and 3 lines × hook
    `y_e5` 13000 and 30000, which is 216 cases.
  - For each case, render one frame where both are visible with the hook only and with the
    captions only (libass, the truth-frame path).
  - Take the alpha bounding boxes. The warning must be raised exactly when the boxes intersect
    vertically.
  - Threshold: **0 mismatches**.
  - Evidence: `docs/editor/evidence/MC/C-G-CLASH.json`.

## 4. Mode switching

### 4.1 One editor, two views

| Shared, never forked | Per view |
|---|---|
| The store (document, history, autosave, IndexedDB draft, BroadcastChannel and two-tab merge), the player and frame bus, the export flow, the conflict dialog, "Perlu dicek", the toast, the transcript selection (`store.setSelection`), the hook-suggestion and cold-open-candidate clients (kept per clip, so switching never asks the server again) | The side region (cards or rail + panel), the bottom region (scrubber or transport + timeline), the open card, the open panel |

Test: switching 10 times keeps the same canvas element (`===`), never calls `createPlayer`
again, and loses no undo entry.

A text field commits on blur, so a click on the switch commits it first. The `M` shortcut never
fires inside a text field (§4.5).

### 4.2 Preference

New pure module `web/lib/editor/view-mode.mjs`:

```js
export const VIEWS = ["cepat", "lengkap"];
export const VIEW_KEY = "potongin-editor-view";
export function readStoredView(storage)            // "cepat" | "lengkap" | null; null on any throw or unknown value
export function writeStoredView(storage, view)     // boolean; never throws
export function viewFromUrl(search)                // { view, panel, card }; unknown values are null
export function resolveView({ url, stored })       // url.view ?? (url.panel ? "lengkap" : url.card ? "cepat" : null) ?? stored ?? "cepat"
export function urlWithView(href, view)            // sets ?mode=<view>; drops panel and card
```

- `storage` is passed in (`window.localStorage` in the app, a fake in the tests). Every access is
  in `try/catch`; in a private window or with blocked storage the editor opens in Cepat and
  switching still works for the page's lifetime.
- The preference is written only when the viewer uses the switch or `M`. A deep link never
  writes it.
- `EditorApp` resolves the view before `EditorShell` mounts. The shell renders only after the
  async runtime is ready, so there is no flash of the wrong view and no hydration mismatch. The
  server render never reads storage.

### 4.3 Default

The order is: the URL (`mode`, else implied by `panel` or `card`), then the stored preference,
then **Cepat**.

### 4.4 Deep links

| URL | Opens |
|---|---|
| `/projects/:id/clips/:clip/edit` | the resolved view |
| `…/edit?mode=lengkap` / `?mode=cepat` | that view |
| `…/edit?panel=transcript` (`text`, `coldopen`, `layout`, `logo`, `music`) | Lengkap with that panel (the `PANELS` ids) |
| `…/edit?card=lines` (`hook`, `caption`, `coldopen`, `layout`, `extras`) | Cepat with that card open |

- A switch replaces the URL with `urlWithView(location.href, view)` through `history.replaceState`,
  so a reload stays in the view.
- The prepare flow's `replaceState` to `editorHref(...)` must keep `location.search` (today it
  drops it).
- `page.jsx` does not change: the client reads the URL.

### 4.5 Keyboard

- New global shortcut **M**: "Ganti tampilan Cepat/Lengkap" (`shortcuts.mjs`: id `toggleView`,
  scope `global`; `shortcutFor` maps a plain `m`). It is free today. `globalShortcut` already
  ignores text fields, IME composition and handled events.
- After a switch by keyboard, focus moves to the new side's main control: the selected rail tab,
  or the open card's header (the first header when none is open). A visually hidden polite live
  region says "Tampilan Cepat" or "Tampilan Lengkap".
- Every global shortcut keeps working in both views. Transcript-scope shortcuts (Delete, Enter,
  Ctrl+E, Ctrl+Shift+X, Ctrl+Shift+H) exist only where the transcript is, in Lengkap.
- The scrubber has its own keys when focused (§7). The shortcut help dialog lists M and the
  scrubber keys.

## 5. Top bar, stage and the removed texts

### 5.1 Top bar (both views, `TopBar.jsx`)

Left to right:
1. "← Proyek" (44 px tall).
2. The title (`h1`, 16/700, ellipsis), the save status with its dot ("Tersimpan", "Menyimpan…",
   …, unchanged rules), and the warning chip "Terbuka di tab lain" while `state.otherTab`.
3. The segmented "Cepat | Lengkap" switch: `role="radiogroup"`, `aria-label="Tampilan editor"`,
   two native radios styled as one segmented pill, each 44 px tall. Checked: `--text` fill with
   `--bg` text.
4. Urungkan and Ulangi as 44×44 icon buttons, with `aria-label`, `aria-keyshortcuts` and a
   `title` holding the shortcut.
5. "Perlu dicek (n)", only when n > 0, with a `--warning` border. At 0 it is not rendered.
6. "Lainnya": a 44×44 ⋯ menu button (`ui/Menu.jsx`) with "Kembali ke versi AI" and "Pintasan
   keyboard (?)".
7. **Ekspor**, the only lime control (`--accent` / `--accent-ink`).

### 5.2 Stage overlays (both views)

- **Zona aman.** A pill at the preview's top right, `aria-pressed`, shortcut `'`. It moves out of
  the controls row.
- **Status pill.** At the top left, replacing `StageBadge`'s badge, detail and "Apa artinya?"
  button. It is a button that opens a help popover (`role="dialog"`, Esc closes and returns
  focus). Its text comes from `badgeView`:

| Tone | Pill | Popover |
|---|---|---|
| `exact` | "Sesuai hasil akhir" (muted, no dot) | `BADGE_HELP` + a "Lihat frame akhir" button |
| `pending` | the pending text ("Menyiapkan video (3/10)…", …) | the pending help + "Lihat frame akhir" |
| `truth` | "Frame akhir" | the truth help + "Kembali ke pratinjau" |
| `unsupported` | "Pratinjau terbatas" | the full unsupported text (`SHELL_TEXT.unsupported_browser`) |
| `legacy` (unchanged clip of a legacy auto render) | **not shown** | reachable from a small "?" icon button in the same spot; text below |
| `loading` | "Membuka klip…" | the loading help |

- "Frame akhir" stays a visible control, inside the popover, and keeps Ctrl+Shift+R. It leaves
  the controls row.
- In Lengkap the transport row keeps play, frame back, frame forward and the time. Cepat's bottom
  bar has play, the time and the scrubber.

### 5.3 Removed texts and where the information goes

| Text on screen today | Where | After | Where the information goes |
|---|---|---|---|
| "Klip otomatis ini dibuat sebelum editor dibuka; setelah klip diubah, tampilan teks hasil ekspor bisa sedikit berbeda" | `noticesView` `legacy_engine`, above the stage | removed | Engine provenance stays in the document (`base.engine.compiler`) and the logs. What a viewer can notice (an unchanged legacy clip exports its old file, which may look slightly different) goes into the legacy help text below. |
| "● Belum diubah: ekspor = klip otomatis" + detail "Ubah apa saja agar ekspor sama persis dengan pratinjau ini" | `badgeView` tone `legacy` | no pill | The "?" button opens: "Klip ini belum diubah, jadi ekspor memakai file klip otomatis apa adanya. Setelah ada perubahan, hasil ekspor sama dengan pratinjau ini." The export dialog keeps its line "Tanpa perubahan: file klip otomatis dipakai langsung". |
| "Apa artinya?" and the badge detail | `StageBadge` | removed | The status pill's popover |
| "● " prefixes | badge texts | removed | none needed |
| "Klip ini terbuka di tab lain" | notice above the stage | moved | The top-bar chip "Terbuka di tab lain" |

Kept, because they are not technical: the read-only banner ("Transkrip berubah sejak klip
diedit" + "Mulai dari versi AI", restyled neutral), every "Perlu dicek" item, the toasts, and the
transcript help line.

`MESSAGES.legacy_engine` stays in the JS mirror. It no longer renders, and the drift test still
lists it.

### 5.4 Latest-only check

- **Cepat and Lengkap are views of the same newest editor.** They share one document, one engine
  and one export. Lengkap is not the previous editor, has no "lama" in its name, and gets the
  same improvements (rail, toolbar, shared pills). No mode is a legacy fallback. That matches
  `AGENTS.md`: "no legacy mode choices".
- The removed texts were technical provenance (which engine rendered the auto clip). The rule
  says provenance "stays in artifacts and logs", and it does.
- The version guard gains two patterns, `/editor (?:lama|baru)/i` and
  `/tampilan (?:lama|baru)/i`, in `web/tests/support/ui-guards.mjs` `VERSION_WORDING`. Each is
  shown to catch a planted string first. No source matches them today (checked 2026-10-02).

## 6. Mode Lengkap changes

### 6.1 Icon rail (`rail/Rail.jsx`)

- A vertical `role="tablist"` (`aria-orientation="vertical"`, `aria-label="Panel editor"`), 84 px
  wide, one button per live `PANELS` entry.
- Each button is 64 px tall: a 20 px icon (`ui/icons.jsx`, mapped by panel id inside `Rail.jsx`,
  so `panels/index.mjs` is not edited) above a label (12/600, never smaller).
- Selected: `--surface-3` background and `--text`. Others: `--text-muted`.
- The ids are unchanged (`editor-tab-<id>`, `aria-controls="editor-panel"`), and so are the names.
  ↑/↓ move and select, Home/End go to the ends, and the selected tab is the only tab stop (roving
  `tabIndex`).

### 6.2 Contextual word toolbar (`transcript/WordToolbar.jsx` + `transcript/word-toolbar.mjs`)

- **Replaces** the 9 chips (`Hapus`, `Pulihkan`, `Edit kata`, `Sembunyikan`, `Kata kunci`,
  `Mulai di sini`, `Akhiri di sini`, `Perpanjang ke sini`, `Jadikan cold open`).
- The transcript header keeps the "TRANSKRIP" label, "Rapikan · n", the status line ("3 kata
  dipilih · 1,2 dtk" or "Klik kata untuk memilih; Shift+klik untuk rentang.") and the cold-open
  note.
- **When it shows:** while the selection is non-empty, not during a drag (it appears on
  mouseup), and not while a word is being edited.
- **Position:** absolute, inside the words list's scroll container.
  - It sits 8 px above the line box of the first selected word, its left edge on that word's
    left, clamped inside the panel.
  - It flips below the selection's last line when less than 56 px is free above.
  - It recomputes on scroll, resize and selection change (one rAF).
  - It never covers the selected words.
- **Buttons** (`role="toolbar"`, `aria-label="Aksi kata terpilih"`, each 44 px tall):
  1. **Primary, contextual** (the order of checks in `word-toolbar.mjs` `primaryAction(actions)`):
     - "Perpanjang ke sini" when `actions.extend.enabled`;
     - else "Pulihkan" when `actions.restore.enabled && !actions.remove.enabled`;
     - else "Hapus".

     Inverted style: `--text` fill with `--bg` text.
  2. "Jadikan cold open" (disabled with its reason when `actions.coldOpen` is off).
  3. "Kata kunci" (`aria-pressed` as today).
  4. "Lainnya ▾": a `ui/Menu` with, in a fixed order, Edit kata (Enter), Sembunyikan dari caption
     (Ctrl+Shift+X, `menuitemcheckbox`), Mulai di sini (I), Akhiri di sini (O), and the two of
     Hapus, Pulihkan and Perpanjang ke sini that are not primary. Unavailable items stay in place
     with `aria-disabled` and their reason as the description.
- **Keyboard:**
  - With a selection, **Tab** from the words list moves into the toolbar (first button).
  - ←/→ move between buttons, Home/End go to the ends.
  - **Esc** returns to the words list and keeps the selection. Shift+Tab goes back to the list.
  - On "Lainnya", ↓, Enter or Space opens the menu. In the menu ↑/↓ move, Enter runs, and Esc
    closes back to the button.
  - The list's shortcuts are unchanged.
  - The hidden help text gains "Tab membuka aksi kata terpilih."
- Every action calls the existing `commandsFor(name, actions)` and `perform`. No command or rule
  changes, so the toolbar and the keyboard always agree.

### 6.3 Timeline and bottom area

The Timeline component and its lanes do not change. Above them, the shell's transport row (56 px)
holds play, the frame step buttons and the time. Zona aman, the badge and "Frame akhir" moved to
the stage (§5.2).

## 7. The scrubber (`scrubber/Scrubber.jsx` + `scrubber/scrubber-model.mjs`)

- **Data.** `scrubberMarks({ doc, words })` is pure:
  - laughs (`kind: "laughter"`) and pauses (`kind: "silence"`) from `buildMarkers(words, doc)`
    (`timeline/lanes/markers.mjs`, imported, not changed). Camera cuts are left out;
  - the cold-open range `[0, J)` from `pieces(doc)`;
  - the join mark at J from `transitionView(doc)`, only when `style !== "cut"` or the whoosh is
    on.

  Labels come from `markerText`. The scale is `plan.totalFrames`, as `MarkerLane` uses it.
  `frameAtPx`, `pxAtFrame`, `nearestMark(f, px)` and `nextMark(f, ±1)` are pure as well.
- **Drawing**, one row with a 44 px hit area:
  - a 4 px track in `--border`, and the cold-open bar in `--cold-open`;
  - laugh dots (8 px, `--warning`) and pause ticks (3×10 px, `--text-muted`);
  - the join mark: a 10 px diamond, filled `--text` for Kilat putih, `--bg` with a `--text`
    border for Gelap sebentar, outline only for Potong langsung with whoosh;
  - the playhead (2 px, `--text`), moved by the frame bus outside React;
  - marks closer than 6 px merge into one;
  - below the track, the legend (12 px, muted): Tawa, Jeda, Cold open, and Transisi when a join
    mark exists.
- **Pointer.** Pointer down seeks; dragging seeks once per animation frame, the same behaviour
  as clicking the ruler today. A press within 6 px of a mark snaps to it. Hovering a mark shows
  its `markerText` label.
- **Keyboard and screen readers.**
  - `role="slider"`, `aria-label="Posisi putar"`, `aria-valuemin=0`,
    `aria-valuemax=totalFrames−1`, and `aria-valuetext` "00:02,2 dari 01:00,6".
  - While playing, `aria-valuenow` updates at most 4 times a second.
  - ←/→ step one frame, Shift+←/→ one second, Home/End jump to the ends, PageUp/PageDown jump to
    the previous or next mark (cold-open edges included).
  - `globalShortcut` already leaves arrows to a focused slider.

## 8. Visual system

### 8.1 Tokens

- Colours come only from `web/app/globals.css` and `docs/design/TOKENS.md`. **No new colour
  token.**
- **Neutral selected state** (pressed pill, checked segment, primary contextual action):
  `--text` background, `--bg` text, 18.28:1.
- **Card:** `--surface` on `--bg`, 1 px `--border`, `--radius-l`.
- **Inputs:** `--surface-2` with a `--border-strong` edge (control edge 3:1).
- **Marks:** laughter `--warning`, pause `--text-muted`, cold open `--cold-open`.
- **Lime:** `--accent` only on Ekspor and on transient progress fills (`TOKENS.md`: "isi
  progres"). On today's screen, three more controls use it: "Unggah logo" (`LogoPanel`),
  "Jadikan cold open" (`ColdOpenPanel`) and "Mulai dari versi AI" (`ReadOnlyBanner`). All three
  become neutral. Dialogs keep one lime primary each: Mulai ekspor, Unduh MP4, Coba lagi,
  Terapkan pilihan.
- **Size tokens:** new ones go in `editor.module.css`. Z0 adds `--ed-target: 44px`,
  `--ed-topbar-height: 64px`, `--ed-bottom-height: 96px`, `--ed-rail-width: 84px`,
  `--ed-side-width: clamp(360px, 32vw, 460px)`, `--ed-font-size-note: 13px`,
  `--ed-label-tracking: 0.08em`.

### 8.2 Shared components (`web/components/editor/ui/`, written once, never copied per panel)

| Component | API | Semantics |
|---|---|---|
| `PillGroup` | `{ legend, name, options: [{ id, label, detail?, disabled?, title? }], value, onChange, disabled, describedBy, columns }` | `fieldset` + `legend` + native radios in pill labels (the `cover` pattern of `panels.module.css`); arrows move, as native radios do |
| `PillToggle` | `{ pressed, onPressedChange, children, ...button }` | `button aria-pressed` (Zona aman) |
| `PillButton` | `{ variant: "default" \| "strong" \| "quiet", ...button }` | an action pill (Putar, Ganti kalimat, Hapus cold open) |
| `AccordionCard` | `{ id, label, summary, open, onToggle, children, headingLevel = 2 }` | h2 > button with `aria-expanded`/`aria-controls`; region with `aria-labelledby` |
| `Switch` | `{ label, checked, onChange, disabled, describedBy }` | `input type=checkbox role=switch`, visible label |
| `Swatches` | `{ legend, name, value, options, onChange, disabled, note }` | radios, 44 px targets around 28 px dots |
| `MenuButton` | `{ label, icon?, items: [{ id, label, shortcut?, disabled?, reason?, checked?, onSelect }], align }` | WAI-ARIA menu button pattern; Esc returns focus |
| `icons.jsx` | `Icon({ name, size = 20 })`; names `back undo redo more play pause chevron transcript text coldopen layout logo music safezone help` | `aria-hidden`, stroke 2, from the mockup's paths |
| `ui.module.css` | the classes of the above | tokens only |

Lengkap panels adopt them where they offer the same control:
- the pack and duck presets, the transition styles, the layout options and the logo corners
  become `PillGroup`;
- the switches become `Switch`;
- the swatches become `Swatches`.

The roles and accessible names stay the same, so the panel e2e selectors keep working. This is
presentational and comes last in task B.

### 8.3 Type scale

| Role | Size / weight | Notes |
|---|---|---|
| Clip title (`h1`) | 16 / 700 | ellipsis |
| Card label, section legend in Cepat | 12 / 700, uppercase, tracking 0.08em, `--text-muted` | the label column is at least 7.5rem so "TEKS CAPTION" fits |
| Card summary, pill text, button text | 14 / 600 | |
| Body, inputs | 14 / 500 (row inputs and the hook input 15 / 600 as in the mockup) | |
| Help, notes, legends | 13 / 400, `--text-muted` | |
| Rail label, scrubber legend | 12 / 600 | never below 12 px |
| Time | 14 / 600, `font-variant-numeric: tabular-nums` | |

DM Sans throughout (`--font`).

### 8.4 Targets, focus, motion, contrast

- **44 px:** every control in the top bar, the cards, the bottom bar, the rail, the word toolbar
  and its menu, and the stage overlays is at least 44×44 CSS px. Text inputs are at least 44 px
  tall. Swatches are 44 px targets.
- **Focus:** `:focus-visible { outline: none; box-shadow: var(--ed-focus-ring); }`. Radio pills
  show the ring on their label through `:has(input:focus-visible)`. A popover or menu returns
  focus to its button when it closes.
- **Motion:**
  - accordion height `grid-template-rows: 0fr → 1fr` over `var(--dur-2) var(--ease-out)`;
  - chevron and pill colour over `var(--dur-1)`;
  - toolbar fade-in over `var(--dur-1)`;
  - no other animation.

  Under `prefers-reduced-motion: reduce` the tokens are already `0ms`. The new CSS uses **only**
  `var(--dur-*)` and `var(--ed-duration-*)`, never a literal duration.
- **Contrast:** every text and background pair the new CSS uses must pass
  `web/tests/ui-guards.test.mjs` (AA 4.5:1). When a background comes from a parent, the rule
  carries `/* on: --token */`. Control edges use `--border-strong` (3:1). Disabled controls use
  `opacity: .55`, which WCAG exempts.

## 9. Acceptance criteria and tests

### 9.1 Acceptance per item

| # | Item | Accepted when |
|---|---|---|
| AC1 | Default view | A fresh profile opens Cepat with the Caption card open. After a switch to Lengkap and a reload, it opens Lengkap. With storage throwing, it opens Cepat and the switch works |
| AC2 | One editor | 10 switches keep the same canvas node and undo depth; an edit in one view undoes in the other; autosave and the two-tab merge behave as before (the fakes' conflict spec in `editor-shell.spec.mjs` passes in both views) |
| AC3 | Deep links | `?mode`, `?panel`, `?card` open as in §4.4. Unknown values fall back. The prepare flow keeps the query |
| AC4 | `M` | It toggles the view, does nothing while typing, and moves focus as §4.5 says |
| AC5 | Cards | Exactly one card open. Summaries as §1.3. Every control dispatches the same command and arguments as the matching Lengkap control (shared model functions; a unit test compares them) |
| AC6 | Teks caption | Every row of `plan.cues`. The §2.3 table holds. A refused commit dispatches nothing. One commit is one Urungkan. Box regrouping keeps focus. Times never change (`plan.cues` f0/f1 equal before and after a text-only edit, except Box splits) |
| AC7 | Clash | G-CLASH 0 mismatches. The card note and the "Perlu dicek" item appear at Atas with a two-line hook and leave at Bawah |
| AC8 | Scrubber | Marks at `buildMarkers` frames (±0). Seek by pointer, by keyboard and to marks (PageUp/PageDown). `aria-valuetext` as §7 |
| AC9 | Rail | One column at 1366×768 and 1920×1080 (today's tabs wrap onto two rows). Vertical arrow keys. `getByRole("tab", {name})` finds every panel |
| AC10 | Word toolbar | Appears above the selection and never covers it. Primary action as §6.2. Every one of the 9 former chips is reachable by mouse and keyboard. No chip row in the header |
| AC11 | Removed texts | Neither legacy string is visible in any state. The "?" help shows the legacy text only in the legacy state. The export dialog line is unchanged |
| AC12 | Lime | On the editor screen, `--accent` renders only on Ekspor and on progress fills |
| AC13 | Targets, focus, motion | Every control listed in §8.4 measures ≥ 44 px. axe: 0 critical, 0 serious. With reduced motion, the accordion's computed `transition-duration` is `0s` |
| AC14 | Latest only | The version guard passes with the two new patterns |
| AC15 | No regressions | Every existing unit test and every e2e spec on the fakes passes, the transition specs included. PF-OPEN first visit p95 ≤ 3.0 s and repeat ≤ 2.0 s still hold on the CI fakes. Its "interactive" moment (`editor-shell.spec.mjs`, today "transcript panel shown") becomes "the side region of the resolved view shown" (A) |

### 9.2 Unit tests (node, run locally only for the files a task changes)

- `editor-view-mode.test.mjs` (A, new):
  - `resolveView` truth table;
  - storage that throws on get and on set;
  - unknown values;
  - `urlWithView` keeps other params and drops `panel`/`card`;
  - `viewFromUrl` rejects ids outside `PANELS` and the cards.
- `editor-shortcuts.test.mjs` (A): `m` → `toggleView`; not with Ctrl/Alt/Shift; not in an input.
- `editor-shell-model.test.mjs` (A):
  - `noticesView` never returns `legacy_engine`;
  - `badgeView` tone `legacy` maps to "no pill" in a new `statusPillView`;
  - the pill texts;
  - the legacy help text.
- `editor-w2-seams.test.mjs` (A): the shared props bundle reaches both `<Panel>` and
  `<QuickPanel>`.
- `editor-quick-model.test.mjs` (B, new):
  - the presets in both directions (value → pressed pill; off-preset → none);
  - every summary;
  - Cepat and Lengkap build identical command lists for the same choice (hook text, pack, size,
    position, highlight, layout, transition, duck, corner).
- `editor-ui-kit.test.mjs` (B, new; reads CSS only, never renders):
  - no literal durations in `ui/`, `quick/`, `rail/`, `scrubber/` and `transcript/WordToolbar*`
    CSS;
  - `--accent` only in the allow-listed selectors of `ui/`, `quick/`, `panels/`, `suggestions/`;
  - `min-height`/`min-width` ≥ `var(--ed-target)` on the kit's control classes.
- `editor-caption-lines.test.mjs` (C, new):
  - `captionRows` on fake cues, with a cold-open double, hidden words and Box splits;
  - every row of the §2.3 table;
  - property test: for 2 000 random drafts over random rows, applying the commands then
    rebuilding the row's text from the document gives the draft's token sequence. Hidden words
    are gone, and every inserted token is in its host's text;
  - limits and messages;
  - `checkCommands` refuses atomically;
  - one merge key per commit.
- `editor-word-toolbar.test.mjs` (D, new): `primaryAction` over the `selectionActions` states;
  menu items and reasons; the position math (above, flip, clamp) on fake rects.
- `editor-scrubber.test.mjs` (D, new): `scrubberMarks` against `buildMarkers` on the marker
  fixtures; the join mark per style and sfx; `nextMark` order; px↔frame round trips.
- `ui-guards.test.mjs` + `support/ui-guards.mjs` (A): the two new version patterns, each first
  shown to catch a planted string.

### 9.3 Python tests (C)

- `tests/test_edit_v2_captions.py`:
  - `caption_hook_overlap` raised and not raised on hand-built boundary cases (touching edges do
    not overlap);
  - only frames where both are visible count;
  - one issue per document.
- `tests/test_edit_v2_contracts.py`: the code is in `WARNING_CODES` and has a message.
- `tests/test_edit_v2_plan.py` and the seed tests: every fixture seed is free of the warning;
  every existing plan sha and golden is unchanged.
- `scripts/parity/clash_gate.py` (new): G-CLASH (§3), run in the image.

### 9.4 Browser specs on the fakes (CI: `editor-gates.yml -f suite=e2e`)

| Spec | Owner | Covers |
|---|---|---|
| `e2e/editor-views.spec.mjs` (new) | A | AC1–AC4, AC11, AC12; the top bar (switch, ⋯ menu, Perlu dicek hidden at 0); the status pill and its popover; QG-A11Y on Cepat with each card open, at 1366×768 and 1920×1080; 44 px measurement of the top bar, overlays and bottom bar |
| `e2e/editor-quick.spec.mjs` (new) | B | AC5, AC7 (fakes rule), AC13 for the cards; each card's controls change the preview's plan as the panel would; U3, U4, U5 scripted in Cepat |
| `e2e/editor-quick-lines.spec.mjs` (new) | C | AC6 end to end: edit, insert, delete, empty line, Esc, a refusal, Urungkan, Box regrouping focus, two tabs editing different words of one row merge |
| `e2e/editor-lengkap.spec.mjs` (new) | D | AC9, AC10; the toolbar by keyboard only; U1, U2 scripted through the toolbar |
| `e2e/editor-scrubber.spec.mjs` (new) | D | AC8 by pointer and keyboard |
| `e2e/editor-shell.spec.mjs` | A | updated for §5 (badge → pill, Frame akhir in the popover, controls row, other-tab chip) |
| `e2e/editor-transcript.spec.mjs`, `editor-cleanup.spec.mjs` | D | the chips → toolbar |
| `e2e/editor-{ai,layout,logo,music,transition}.spec.mjs` | B | only if the pill adoption changes a selector |
| `e2e/read-only.spec.mjs` | A | the restyled banner |

The fakes cannot test the real hook suggestions, the camera analysis or the real-stack timings.
Those stay with the owner's stopwatch (§9.6).

### 9.5 Keeping existing specs green while the default flips

- **Z0** sets every existing spec's editor URL constant to `?mode=lengkap`. It also moves every
  UI action the build will move into per-owner helper files:
  - `e2e/support/editor-topbar.mjs` (A): `resetToAi`, `openChecks`, `openShortcutHelp`,
    `switchView`, `toggleTruthFrame`, `safeZone`;
  - `e2e/support/editor-words.mjs` (D): `wordAction(page, name)` for the nine actions;
  - `e2e/support/editor-cards.mjs` (B): `openCard`.

  Z0 implements them against today's UI, so the specs pass unchanged at the base.
- Each builder then edits only its own helper.
- `editor-flow.spec.mjs` and `editor-acceptance.spec.mjs` (real stack) belong to the integrator.

### 9.6 UJI-PENERIMAAN impact (owner's stopwatch; limits unchanged)

| Test | Before | After | Expected effect |
|---|---|---|---|
| Start of every task | "Kembali ke versi AI" in the top bar | ⋯ Lainnya → Kembali ke versi AI | +1 click before the stopwatch |
| U1 clipped first word (20 s) | Transkrip tab | Lengkap (switch, or "Potong per kata di Mode Lengkap →") → select the dimmed word → toolbar "Perpanjang ke sini" (or I) | +1 click if the clip opened in Cepat; the toolbar puts the action next to the word |
| U2 remove ~5 s (20 s) | select + Delete | unchanged keys; the toolbar's "Hapus" is next to the selection | ≈ same |
| U3 cold open (45 s) | Cold open tab or Ctrl+Shift+H | Cepat: Cold open card → Ganti kalimat → Putar → Pakai (or the toolbar in Lengkap) | faster: no tab hunt |
| U4 hook + pack (30 s) | Teks tab, Pakai, a pack | Cepat: Hook card → a suggestion; Caption card (open on load) → a pack | faster: the pack is visible on load |
| U5 logo + music (60 s) | Logo tab, Musik tab | Cepat: Logo & Musik card (both in one card) | faster. **The stop condition changes**: the Musik lane is not in Cepat. It becomes "logo on the preview, the card shows the music with the chosen strength, Tersimpan". The lane check moves to tour item 9 (Lengkap) |
| U6 export (clip + 30 s) | Ekspor | unchanged | same |
| U7 reload + reset (20 s) | top-bar button | part 1 in Cepat (Hook + Caption cards); part 2 via ⋯ Lainnya | +1 click |
| **U8 new: fix one caption word (20 s)** | none | Cepat: Teks caption card → the row → fix the word → Enter | Stops when the preview shows the word and "Tersimpan" shows. Scripted in `editor-quick-lines.spec` |

Tour (§5 of the protocol) gains item 14, "Dua tampilan": switch views with the switch and with M,
reload, and confirm that nothing is lost and the view is remembered.

### 9.7 Docs (integrator)

- **`docs/editor/PANDUAN-EDITOR.md`:**
  - the intro and §1 gain the two views, the default and the switch;
  - §2 is split into "Mode Cepat" (one paragraph per card, Teks caption with the insertion rule)
    and "Mode Lengkap" (rail; the transcript toolbar with Tab and Esc);
  - §3 becomes "Status di atas pratinjau" (the pill, "?", Frame akhir in the popover). The legacy
    row and "Apa artinya?" are removed;
  - §5 adds M, the scrubber keys and the toolbar keys;
  - §6 adds "Tidak menemukan transkrip → Mode Lengkap".
- **`docs/editor/UJI-PENERIMAAN.md`:** §9.6, U8 in the result sheet, tour item 14.
- **`docs/editor/CONTRACTS.md`:**
  - the §3.7 row for `caption_hook_overlap`;
  - a new §5.27 "Editor views": the preference key, the URL params, the line-edit diff rule and
    its limits, the shared props bundle.
- **`docs/editor/GATES.md`:** a new section "Mode Cepat" with the suites, G-CLASH, QG-A11Y and the
  scripted U-tests.
- **`docs/HANDOFF.md`:** status.

Evidence goes to `docs/editor/evidence/MC/<task>-*.json`.

## 10. Task split

### Order

0. **Prerequisite.** The cold-open transition PR (T1–T3) is merged into `main`. Then, if
   `fix/editor-first-frame` has reached origin, either it merges first or the integrator rebases
   onto it. It is expected to touch the player and the stage; A owns `Stage.jsx`, so A resolves
   any conflict there.
1. **Z0 scaffold** on `mode-cepat-base` (from `main`). No visible change. It lands:
   - the stubs with the APIs fixed in this spec: `ui/*` (full `icons.jsx`; `PillGroup`,
     `AccordionCard`, `Switch`, `MenuButton` as minimal working versions), `quick/cards.mjs` with
     placeholder bodies, `quick/QuickPanel.jsx`, `rail/Rail.jsx` (today's text tabs moved
     inside), `scrubber/Scrubber.jsx` (a plain range input), `lib/editor/caption-lines.mjs`
     (exports that throw "not built");
   - a minimal `?mode=cepat` branch in `EditorApp` that mounts the placeholders (default stays
     Lengkap);
   - the size tokens (§8.1);
   - the e2e helper files and the `?mode=lengkap` constants (§9.5).

   CI: `suite=full` and `suite=e2e` over every editor spec, all green.
2. **A, B, C, D** branch from `mode-cepat-base` (`mode-cepat-a-shell`, `-b-cards`, `-c-lines`,
   `-d-lengkap`) and build in parallel. Each pushes its branch and runs its CI (§10, per task).
3. **Merge into `mode-cepat-integrasi`** in this order:
   1. **C** (model and engine, no UI dependency);
   2. **B** (its summaries use C's `linesSummary`);
   3. **D**;
   4. **A** last (it flips the default to Cepat and changes the shell the others mount into).

   Ownership is disjoint, so these merges have no conflicts.
4. **Z integration:**
   - the `caption_hook_overlap` line in `shell-model.mjs` `MESSAGES`;
   - the real-stack specs (`editor-flow`, `editor-acceptance`);
   - the docs (§9.7) and the evidence;
   - CI: `suite=full`, `suite=image`, `suite=e2e` (every spec), and `suite=command` for G-CLASH;
   - one PR to `main`. Agents never push to `main`, never force-push, and never merge.
5. The owner runs U1–U8 at 1366×768 and 1920×1080, then merges.

### A — shell, view switch, top bar, removed texts (owns)

- `web/components/editor/{EditorApp.jsx, TopBar.jsx, StageControls.jsx, StageBadge.jsx, Stage.jsx, ReadOnlyBanner.jsx, shell-model.mjs, shell.module.css, editor.module.css}`
  and the new `ViewSwitch.jsx`.
- `web/lib/editor/{view-mode.mjs (new), shortcuts.mjs}`.
- `web/tests/{editor-view-mode (new), editor-shortcuts, editor-shell-model, editor-w2-seams, ui-guards}.test.mjs`,
  `web/tests/support/ui-guards.mjs`.
- `web/e2e/{editor-views.spec.mjs (new), editor-shell.spec.mjs, read-only.spec.mjs, support/editor-topbar.mjs}`.
- `docs/editor/evidence/MC/A-*.json`.
- Does not change the timeline classes in `shell.module.css` (the timeline is unchanged).

### B — Mode Cepat cards and the shared kit (owns)

- `web/components/editor/ui/**`.
- `web/components/editor/quick/**`, except `CaptionLinesCard.jsx` and its CSS.
- `web/components/editor/panels/**`: the extractions `ColdOpenSuggestions.jsx`,
  `use-audition.js` and `use-layout-switch.js`; the kit adopted in `TextPanel`, `LayoutPanel`, `LogoPanel`,
  `MusicPanel` and `ColdOpenPanel`; the lime clean-up. `panels/index.mjs` itself is not edited.
- `web/components/editor/suggestions/**` (the shared hook and the compact list).
- `web/tests/{editor-quick-model (new), editor-ui-kit (new)}.test.mjs`, plus the existing panel
  unit tests only where an extraction moves code (`editor-layout`, `editor-logo`,
  `editor-music`, `coldopen-suggestions`, `editor-coldopen-transition`, `editor-ai`).
- `web/e2e/{editor-quick.spec.mjs (new), support/editor-cards.mjs, editor-ai, editor-layout, editor-logo, editor-music, editor-transition}.spec.mjs`.
- `docs/editor/evidence/MC/B-*.json`.

### C — Teks caption line editing and the clash warning (owns)

- `web/lib/editor/caption-lines.mjs`.
- `web/components/editor/quick/{CaptionLinesCard.jsx, CaptionLinesCard.module.css}`.
- `web/components/editor/__dev__/fakes.mjs`.
- `src/ai_clipper/edit_v2/{captions.py, errors.py}`, `src/ai_clipper/captions_ass.py` (only a
  shared geometry helper).
- `tests/{test_edit_v2_captions.py, test_edit_v2_contracts.py, test_edit_v2_plan.py}` (additions
  only); the seed tests only to assert "no warning"; `scripts/parity/clash_gate.py` (new).
- `web/tests/editor-caption-lines.test.mjs` (new), `web/e2e/editor-quick-lines.spec.mjs` (new).
- `docs/editor/evidence/MC/C-*.json`, and `.gitleaks.toml` if a digest in the evidence trips it.

### D — Mode Lengkap rail, word toolbar, scrubber (owns)

- `web/components/editor/rail/**`, `web/components/editor/scrubber/**`.
- `web/components/editor/transcript/**`: `TranscriptPanel.jsx`, the new `WordToolbar.jsx` and
  `word-toolbar.mjs`, `transcript.module.css`.
- `web/tests/{editor-word-toolbar, editor-scrubber}.test.mjs` (new); `editor-transcript.test.mjs`
  only if it touches moved code.
- `web/e2e/{editor-lengkap.spec.mjs, editor-scrubber.spec.mjs (new), editor-transcript.spec.mjs, editor-cleanup.spec.mjs, support/editor-words.mjs}`.
- `docs/editor/evidence/MC/D-*.json`.

### Z — integrator (owns)

- The one `MESSAGES` line in `shell-model.mjs`, after A has merged.
- `web/e2e/{editor-flow, editor-acceptance}.spec.mjs`.
- `docs/editor/{PANDUAN-EDITOR, UJI-PENERIMAAN, CONTRACTS, GATES}.md`, `docs/HANDOFF.md`.
- `docs/editor/evidence/MC/Z-*.json`.

### Files nobody touches

- `web/lib/editor/{commands,doc-model,rebase,history,store,autosave,draft-store,timemap,api-client,preview-client,upload-client,open-clip,flags,content-colours}.mjs`
  and `web/lib/editor/player/**`.
- `web/components/editor/timeline/**` (the scrubber imports `lanes/markers.mjs` without changing
  it), `gizmos/**`, `{ExportDialog,ConflictDialog,ChecksPanel}.jsx`, `export-flow.mjs`,
  `runtime.mjs`.
- `web/app/**` (the edit page, `globals.css`).
- `src/ai_clipper/edit_v2/*` other than C's two files.
- `compose.yaml`, `Dockerfile`, `.github/workflows/*`.

A task that finds it must change one of these stops and reports instead.

### Per-task CI (never on the owner's PC beyond targeted node tests)

```
cd web && node --test tests/<the task's test files>          # local, targeted only
gh workflow run editor-gates.yml -f ref=<branch> -f suite=full
gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command='e2e/<the task's specs>'
gh workflow run editor-gates.yml -f ref=<branch> -f suite=command -f command='<G-CLASH>'   # C only
gh run watch <id> --exit-status ; gh run view <id> --log-failed ; gh run download <id>
```

Before every push, scan with main's gitleaks config (a worktree mounts the main repo's `.git`).
Commits end with the `Co-Authored-By` trailer the session gives.

### Shapes fixed here so the tasks can build in parallel

| Shape | Producer | Consumers | Section |
|---|---|---|---|
| Card registry entry `{ id, label, owner, file, load }`; ids `hook caption lines coldopen layout extras` | Z0 → B | A (deep links), C | §1.2, §4.4 |
| Card props = the panel props bundle + `frameBus`, `showLengkap(panelId)` | A | B, C | §1.2 |
| `ui/*` APIs and icon names | Z0 → B | A, C, D | §8.2 |
| `captionRows`, `linesSummary`, `lineEdit`, `checkCommands` | C | B (summary), C | §2 |
| Warning `caption_hook_overlap` (path `/captions/overrides/y_e5`, ref = hook item id) | C | B (card note), Z (`MESSAGES`), "Perlu dicek" | §3 |
| `Rail({ panels, value, onChange })`, `Scrubber({ plan, state, player, frameBus, disabled })` | D | A | §6.1, §7 |
| `view-mode.mjs` API, URL params, storage key | A | Z (docs) | §4 |
| e2e helpers per owner | Z0 → A, B, D | every spec | §9.5 |

## 11. Risks and open questions

### Risks

- **R1. LLM quota.**
  - **Risk:** the hook suggestions ask the free LLM when their component mounts (`ensure(doc)`,
    one POST per clip and page). An open Hook card on every load would make one request per
    editor open.
  - **Mitigation:** Caption is open on load. Hook suggestions start only when the Hook card
    opens, which is today's cost of opening the Teks tab. The clients are kept per clip, so a
    view switch never asks again. A test asserts that no `/ai` request is made on load in Cepat.
- **R2. Insertions share a neighbour's timing.**
  - **Risk:** a typed new word lights up together with its host in Karaoke and Bold. A truly
    separate word needs new word timings, which the model does not have.
  - **Mitigation:** the help line, and PANDUAN explains it.
- **R3. Box rows regroup after an edit.**
  - **Risk:** focus could jump.
  - **Mitigation:** the focus rule of §2.5 and its e2e.
- **R4. New export check.**
  - **Risk:** a saved document whose caption already sits on its hook gains a "Perlu dicek"
    item after release. Seeds cannot, so R10 is safe.
  - **Mitigation:** none needed. The check reports a real defect.
- **R5. Spec churn.**
  - **Risk:** flipping the default would break every editor spec.
  - **Mitigation:** Z0's `?mode=lengkap` constants and the per-owner helpers (§9.5) keep the
    specs green, and A flips the default last.
- **R6. Two homes for some controls** (hook text, pack, transition).
  - **Risk:** the two views drift apart.
  - **Mitigation:** one model function per control, and the B unit test that both views build
    identical commands.

### Open questions for the owner (the build can start with the proposed answer)

1. **"Kembali ke versi AI" and "Pintasan keyboard" move into the ⋯ Lainnya menu.** They are not
   on the mockup's top bar. U7 and the start of every U-test then take one more click. Proposed:
   yes.
2. **Cold open card wording.** Proposed: use the transition PR's words in both views ("Potong
   langsung / Kilat putih / Gelap sebentar", "Suara whoosh", "Putar transisi"). The mockup has
   "Potong", "Whoosh" and "Putar sambungan". Or take the mockup's shorter words, in both views.
3. **Caption position presets**: Atas 38 %, Tengah 60 %, Bawah 83 % (the bottom edge of the
   caption; Bawah = today's spot near the TikTok buttons, K5). Proposed: yes. The fine slider
   stays in Lengkap.
4. **Inserted words ride on the neighbour word's timing (R2).** Proposed: accept for now.
