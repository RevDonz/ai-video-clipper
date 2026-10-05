# Editor Mode Cepat and Mode Lengkap: build spec

Date: 2026-10-02, revised the same day after review (§12). Status: approved by the owner; both
prerequisites merged (§10); building from `mode-cepat-base`. Branch of this spec: `mode-cepat-spec`.

On 2026-10-02 the owner approved the "Mode Cepat" mockup ("oke sih ini mode cepat"). The mockup has
two boards:
- `Main.dc.html`, Mode Cepat, the default view;
- `Lengkap.dc.html`, Mode Lengkap, today's full editor with an icon rail and a word toolbar.

Both boards live in the session scratchpad (`editor-mockup/project/`), not in the repo. This spec
records what they show, so the builders do not need them.

The owner's rules still apply: `AGENTS.md` (latest only, Indonesian copy, tests first, never weaken
a test, no heavy local runs) and `DESIGN.md` (dark, DM Sans, one lime accent, dial ENERGY 1 /
RHYTHM 1 / MOTION 2). Every builder announces `antislop active: during (project setting).` before
the first edit. They follow the antislop core skill plus the ui, copywriting and human skills.

Everything below was checked on 2026-10-02 against `origin/main` `8996a1b`, the transition branches
`origin/transisi-spec` `8f39873`, `-t1` `27ac46d`, `-t2` `2884cf8`, `-t3` `ce24721`, and the
first-frame fix `origin/fix/editor-first-frame` `c1e8383`. §10 says how both land first.

Both prerequisites are on `main` now: the cold-open transition as PR #23 (`53d6656`) and the
first-frame fix as PR #24 (`3faf2f9`, which replaces `c1e8383` everywhere this spec names it).
Z0 branched `mode-cepat-base` from `3faf2f9`.

**Owner decisions (2026-10-02).** The mockup is approved ("oke sih ini mode cepat"), and the owner
accepted every proposed answer of §11 as written: "Kembali ke versi AI" and "Pintasan keyboard" go
into the ⋯ Lainnya menu (Q1); the Cold open card uses T3's Transisi wording in both views (Q2); the
caption positions are Atas 38 %, Tengah 60 %, Bawah 83 % (Q3); an inserted word shares its
neighbour's timing for now (Q4); U5 keeps its stop condition (Q5); the exact caption-vs-hook pixel
check (Q6) and an off switch for single-key shortcuts (Q7) are later, separate tasks, not part of
this build.

## 0. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| What the two modes are | Two **views** of one editor: one document, one store, one undo history, one autosave, one two-tab merge, one player | Nothing forks. Mode Lengkap is not an old editor kept alive, so the latest-only rule holds (§5.4) |
| Default view | Mode Cepat, unless the viewer last picked Lengkap or a deep link says otherwise (§4) | Owner decision |
| Where the preference lives | `localStorage["potongin-editor-view"]`, per viewer, every access in `try/catch` | A per-viewer convenience. Losing it only means opening in Cepat |
| Which Cepat card is open on load | **Caption** (as in the mockup); `?card=` overrides. It is not remembered | Opening the Hook card mounts the hook suggestions, which ask the free LLM. An open Hook card on every load would spend the daily quota (§11 R1) |
| Caption line edits | A line edit becomes word edits (`EditWordText`, `SetWordHidden` on and off) on the row's word ids. Timing never moves. Retyping a hidden word unhides it; a truly new word rides on a neighbour word (§2) | Word ids and times come only from the words artifact. There is no "new word" in the model |
| One commit = one undo step | All commands of one line commit share one `actionKey()` merge key and are dry-run first (all or nothing) | Same pattern as Rapikan and the transcript toolbar |
| Caption near the hook | A **hint**, not a check: one shared client function shows "Caption dekat teks hook. Kalau bertumpuk di pratinjau, turunkan caption." in both views. No engine warning, no "Perlu dicek" item, no export tick (§3) | The preview is exact, so the viewer sees a real overlap. An exact check needs libass geometry the server does not compute (§11 Q6) |
| Caption size and position in Cepat | Three presets each. Bawah = 83000, today's seed spot (K5) | An unchanged clip still exports its auto file (R10) |
| Transition controls in the Cold open card | T3's whole Transisi section, extracted once and rendered by both views | Both views read the same by construction (§11 Q2) |
| The 5-lane timeline in Cepat | Replaced by one scrubber with laugh, pause, cold-open and transition marks | Mockup |
| Timeline in Lengkap | Unchanged: no file under `web/components/editor/timeline/**` changes | Owner brief |
| Lengkap tabs | An 84 px icon rail that keeps `role="tab"` and the tab names; rows 44 to 64 px tall | The text tabs wrap onto two rows today. Keeping the role and the names leaves every `getByRole("tab", …)` spec working |
| Transcript actions | A contextual toolbar above the selected words replaces the 9 permanent chips | Mockup |
| Technical texts | The legacy notice and the legacy badge text leave the screen. The stage status (today's badge, otherwise unchanged) and "Frame akhir" move onto the preview (§5) | The owner's brief names exactly those two legacy texts |
| Work that outlives a card | Face analysis and music upload move into per-clip stores, like `logoUploads` and `suggestionsFor` today, so closing a card or switching views never drops them (§4.1) | Today both live in the panel's component state |
| Keyboard | No new single-key shortcut. Global shortcuts ignore only text-entry fields, so clicking a pill or a switch keeps Ctrl+Z, ', ? and K working (§4.5) | WCAG 2.1.4; today an `<input>` of any type turns every global shortcut off |
| Lime | On the editor screen only **Ekspor** (at rest and on hover) and transient progress fills use `--accent*`. A dialog keeps one lime primary action | `DESIGN.md`, and the mockup's "only Ekspor in lime" |
| Focus ring | Today's shell rule: a 2 px `--focus` outline plus `--ed-focus-ring`. Not the mockup's lime outline | Lime is reserved for Ekspor. The outline survives forced-colours mode |

## 1. Information architecture

### 1.1 Screen regions

```
Mode Cepat (≥ 1024 px wide)
┌ top bar 64 px ─ ← Proyek │ title · Tersimpan │ [Cepat|Lengkap] │ ↶ ↷ │ Perlu dicek (n) │ ⋯ │ Ekspor ┐
├ preview (1fr) ──────────────────────────────────────┬ cards clamp(360px, 32vw, 460px), scrolls ─┤
│ status · ? (top left)  Frame akhir · Zona aman (top right) │ HOOK · CAPTION · TEKS CAPTION ·     │
│               9:16 stage, centred                   │ COLD OPEN · TATA LETAK · LOGO & MUSIK     │
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
- **Real heights.** A 1366×768 screen gives a browser viewport of about 1366×650 (tabs, address
  bar, taskbar).
  - Cepat: the preview is 490 px tall (650 − 64 − 96), so the stage is about 276×490.
  - Lengkap: the main row is 330 px tall (650 − 64 − 56 − 200). Six rail rows of 55 px fit. The
    rail scrolls (`overflow-y: auto`) only when six rows of 44 px do not fit.
  - The cards column scrolls inside itself (`overflow-y: auto`, `overscroll-behavior: contain`).
    The page itself never scrolls.
  - New specs measure at viewports 1366×650 and 1920×960. The existing 1366×768 and 1920×1080
    layout cases stay.

### 1.2 Which code powers each Mode Cepat card

Every card gets the same props bundle as a panel today (`state`, `dispatch`, `player`, `api`,
`previewClient`, `uploadAsset`, `uploadsEnabled`, `notify`, `readOnly`), plus `frameBus` and
`showLengkap(panelId)`. The shell builds the bundle once and spreads it onto `<Panel>` and
`<QuickPanel>` alike (§9.5 updates the W2 seams test).

| Card (label · id) | Existing code it reuses | Commands | New |
|---|---|---|---|
| HOOK · `hook` | `TextPanel` hook rules (`clean`, 90-point limit, fit badge from `plan.hook.overflow`), `suggestions/model.mjs` (`suggestionsFor`, `aiView`, `applyCommand`, `COPY`) | `SetHookEnabled`, `SetHookText` (merge key `hook:text`, as today), suggestion `SetHookText` with origin `suggestion:<id>` | `suggestions/use-hook-suggestions.js` (the controller and view state pulled out of `suggestions/index.jsx`) and `suggestions/CompactSuggestions.jsx`: the panel's states and copy, with each suggestion as one 44 px button |
| CAPTION · `caption` | `TextPanel` caption rules, `pack-thumbs/*.png`, `CAPTION_SWATCHES` | `SetCaptionsEnabled`, `SetCaptionPack`, `SetCaptionOverride` (`size_pm`, `y_e5`, `highlight`) | `panels/caption-model.mjs`, shared with `TextPanel`: `captionCommand`, `highlightNote`, `captionZoneNote`, `hookNearNote` (§1.4, §3). Size and position presets |
| TEKS CAPTION · `lines` | `plan.cues` and `plan.pieces`, `state.words`, `doc.captions.word_edits`, `buildTranscriptModel` (hidden and cut words) | `EditWordText`, `SetWordHidden` (on and off) | The whole line editor (§2) |
| COLD OPEN · `coldopen` | `transcript/model.mjs` (`buildTranscriptModel`, `coldOpenInfo`), `panels/coldopen-suggestions.mjs`, `panels/coldopen-transition.mjs` (from T3), and the panel's `useAudition`, `Suggestions` and `Transition` | `SetColdOpen` (a suggestion, or `null` to remove), `SetJoinStyle`, `SetJoinSfx` | The card layout. `ColdOpenPanel.jsx`'s parts move into `panels/ColdOpenSuggestions.jsx`, `panels/TransitionSection.jsx` (T3's `Transition`, markup and copy unchanged) and `panels/use-audition.js`. Both views render them |
| TATA LETAK · `layout` | `panels/layout-model.mjs` (`LAYOUT_OPTIONS` names, `switchSteps`, `cameraReadyFromState`) and the face-analysis flow of `LayoutPanel.jsx` | `SetLayout` (after `prepare {layout:"camera"}` when needed) | A three-pill group. The analysis flow moves into the per-clip store `panels/layout-analysis.mjs` (§4.1), read by the card and by `LayoutPanel` |
| LOGO & MUSIK · `extras` | `gizmos/logo-upload.mjs` (`logoUploader`, `logoUploads`), `panels/logo-model.mjs`, `panels/music-upload.mjs`, `panels/music-model.mjs` (`DUCK_PRESET_LIST`, `musicCommands`), MusicPanel's one-time copyright notice (same `localStorage` key, so it is shown once across both views) | `SetLogo`, `RemoveLogo`, `SetMusic`, `SetDuck`, `RemoveMusic` | A compact card. The music upload state moves into a per-clip store in `panels/music-upload.mjs` (§4.1). "Atur detail di Mode Lengkap" opens the full panel |

The stage's logo gizmo (drag and resize on the preview) works in both views, because it lives in
`StageRegion`.

### 1.3 Card behaviour

- Accordion: one card open at a time. Clicking the open card's header closes it, so none is open.
- Load state: Caption is open. `?card=<id>` opens that card instead. The open card is not
  remembered (R1).
- Each header is a `<h2>` holding a full-width `<button aria-expanded aria-controls>`, 56 px tall.
  It shows the uppercase label, a one-line summary (ellipsis) and a chevron. The body is a region
  with `aria-labelledby` pointing at the header.
- **Mounting.**
  - A body mounts when its card first opens: its code and its data requests (the hook
    suggestions, the cold-open candidates, the camera status) start then. The first paint does
    not wait for any card (PF-OPEN, §9.4).
  - Once mounted, a body stays mounted while Cepat is shown, so a closed card keeps its state.
  - A closed body has `inert` and, when its height transition ends, `visibility: hidden`. It is
    out of the tab order, the accessibility tree and find-in-page.
  - A view switch unmounts every card. Work that must survive lives outside them (§4.1).
- Summaries come from the pure module `quick/quick-model.mjs`:

| Card | Summary |
|---|---|
| Hook | the hook text, or "Mati" |
| Caption | "Karaoke · Sedang · Bawah"; a size or position set off-preset in Lengkap shows its percent ("· 92%", "· posisi 72%"); "Mati" when captions are off |
| Teks caption | `linesSummary()` from `lib/editor/caption-lines.mjs`: "12 baris", "12 baris · 2 diubah", "Caption mati" or "Menyiapkan…" |
| Cold open | `JOIN_STYLE_NAMES[style]` plus " + whoosh" when on, or "Mati" |
| Tata letak | the layout option name, plus " · menganalisis…" while the face analysis runs |
| Logo & Musik | "Belum ada", "Logo", "Musik" or "Logo dan musik" |

- In read-only mode every editing control is disabled one by one, as the panels do it. Playing
  ("Putar", "Putar transisi"), the rows' seek-on-focus and the scrubber still work. The spec does
  not wrap a whole body in a disabled `fieldset`, because that would disable "Putar" too.

### 1.4 Card contents

**Hook.**
- A "Tampilkan hook" switch, then "Teks di awal klip": an input with a 90-point limit, a counter
  and the fit badge "Muat", "Akan terpotong" or "Memeriksa…".
- Below them, "Saran" (`CompactSuggestions`): the panel's two lists ("Saran otomatis", "Saran
  AI"), each suggestion a 44 px button with `aria-pressed` on the current one; a click applies it.
- It shows every state of the panel's list, with the same `COPY` and `aiView` texts:
  - the loading line;
  - the error with "Coba lagi";
  - "Klip sudah diubah sejak saran ini dibuat." with "Perbarui saran";
  - the AI notices (pending, failed with "Coba lagi", rate-limited, none);
  - **the privacy line** `COPY.privacy` ("Teks transkrip klip ini dikirim ke penyedia AI yang aktif
    di Pengaturan. Layanan gratis bisa memakai data yang dikirim."), under the panel's rule:
    whenever the AI part is visible and is not a notice.
- Duration and position stay in Lengkap.

**Caption.**
- A "Tampilkan caption" switch, then the four pack tiles (the existing FFmpeg thumbnails, radio
  semantics, 2×2).
- "Warna sorot": the six `CAPTION_SWATCHES`, each a 44 px target around a 28 px dot. Enabled for
  every pack, as in Lengkap, with the note `highlightNote(pack)`: "Kata yang sedang diucapkan."
  for Karaoke and Bold, "Dipakai oleh Karaoke dan Bold; tidak tampak di gaya ini." for the others
  (today's TextPanel strings, moved into the shared model).
- "Ukuran": Kecil 850, Sedang 1000 (the seed), Besar 1200 (`size_pm`).
- "Posisi" (`y_e5`, the bottom of the caption block): Atas 38000, Tengah 60000, Bawah 83000 (the
  seed spot, K5).
- A value off the presets presses no pill.
- Commands come from `captionCommand(key, value, { drag })`: a preset pick has merge key `null`
  (one undo step per pick); a Lengkap slider drag has `cap:<key>`, as today.
- Zone notes, `captionZoneNote(doc, seed, plan)`, the two texts TextPanel shows today, in both
  views:
  - at the seed spot: "Posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser caption ke
    atas.";
  - elsewhere in the zone: "Caption masuk area tombol TikTok/Reels; geser ke atas bila
    tertutup.".
- The hook hint `hookNearNote(doc)` (§3), as plain text under Posisi.

**Teks caption.** §2.

**Cold open.**
- With a cold open, a quote box: "“text”" and "1,8 dtk · diputar paling awal" (from
  `coldOpenInfo`). Below it, "Putar" and "Ganti kalimat".
- "Ganti kalimat" expands `ColdOpenSuggestions` inside the card: each candidate has "Putar" and
  "Pakai".
- Then `TransitionSection`, exactly as in Lengkap: the heading "Transisi", its note, the legend
  "Efek gambar" with the three `TRANSITION_STYLES`, the "Suara whoosh" switch, "Putar transisi"
  ("Hentikan" while playing) and the status line.
- At the bottom, a quiet "Hapus cold open" button (`SetColdOpen(null)`).
- Without a cold open, the card says "Belum ada cold open." with a "Pilih kalimat" button, which
  opens the same suggestion list.

**Tata letak.** Three pills: Latar blur, Potong tengah, Ikuti wajah. Ikuti wajah without a camera
plan starts the existing analysis through `layoutAnalysisFor(clipId)` (§4.1). Its progress shows in
the card and in `LayoutPanel`, whichever is on screen. The no-face note stays as in the panel.

**Logo & Musik.** The mockup shows the empty state; with content, the card keeps only what U5 needs.
- Logo:
  - none: a dashed "Tambah logo" button (file picker);
  - with a logo: its thumbnail and "Hapus". The logo is placed by dragging it on the preview.
- Musik:
  - none: "Tambah musik", which shows the copyright notice the first time;
  - with music: the file name, "Saat ada suara" with the pills Halus, Sedang and Kuat (`SetDuck`;
    U5 asks for the strength), and "Hapus".
- Upload progress comes from `logoUploads` and the music store, so it survives a card close and a
  view switch.
- When `uploadsEnabled` is false, the add buttons are disabled with the existing reason.
- "Atur detail di Mode Lengkap" calls `showLengkap("logo")` or `showLengkap("music")`.

### 1.5 What stays only in Mode Lengkap

- The transcript: cuts, trims, "Perpanjang ke sini", Rapikan, keyword marking, hiding single
  words, editing words in place.
- Hook duration and position. Caption size and position sliders, upper case, keyword colour.
- Cold-open word nudges.
- Logo corners, size and opacity. Replacing a music file, music gain, start, loop, fades and duck
  detail.
- Clip volume and loudness.
- The timeline lanes and the frame-step buttons.

Global shortcuts work in both views (§4.5). The Cepat bottom bar links to Lengkap: "Potong per
kata di Mode Lengkap →" calls `showLengkap("transcript")`.

## 2. Teks caption: line edits as word edits

### 2.1 Rows

`captionRows({ plan, doc, words, model })` in the new pure module `web/lib/editor/caption-lines.mjs`
gives one row per `plan.cues` entry, in order (`model` is `buildTranscriptModel(words, doc)`):

```js
{ key: `${seg}:${cue.words[0]}`, seg, cold, f0, f1, wordIds, hiddenIds, text, edited }
```

- **Segment.** `seg` is the `seg` of the plan piece whose `[outF0, outF0 + frames)` holds
  `cue.f0`. `cold` is that piece's `role === "cold_open"`. Both come from the same plan as the
  cues, so they never disagree with them.
- **Unique keys.** A cold open repeats body words, and the engine captions such a word in both
  segments (`subtitles.build_frame_cues`). Within one segment a word is captioned at most once.
  So `seg:firstWordId` is unique, even for a cold-open line and its body twin.
- **Visible words.** `wordIds` is the cue's words minus the ones the current document hides
  (`word_edits[id].hidden`). A row whose words are all hidden is dropped at once, before the next
  plan, so a quick second edit cannot target a hidden word.
- **Hidden neighbours.** `hiddenIds` lists the caption-hidden words next to or between the row's
  visible words: in `state.words` order, kept by the cuts (per `model`), with
  `word_edits[id].hidden === true`, up to the neighbouring visible word on each side. Retyping
  one of them unhides it (§2.3).
- **Text.** `text` is the visible words joined by one space. Each word's text is
  `word_edits[id].text ??` the ASR text, as stored, punctuation kept. When the caption case is
  `upper` (Bold's default, or Lengkap's toggle), the input shows it with
  `text-transform: uppercase`, as the preview shows it. The stored value does not change.
- `edited` is true when any visible word of the row has a text edit.
- **Grouping is the engine's.** Rows follow the plan's cues: at most 4 words, a break after a
  sentence end (`.?!…`) and on a long gap, and Box's width split. So, in any pack:
  - typing or removing a "." or "?" can split or join rows;
  - hiding or unhiding a word shifts the 4-word groups after it in that segment;
  - Box also splits by width.
- A cold-open line appears twice (once in the cold open, once in the body), because those are the
  same spoken words. Editing either row changes both. Cold-open rows carry a "Cold open" tag in
  `--cold-open`.
- Captions off: the card says "Caption mati. Nyalakan di kartu Caption." No plan yet: "Menyiapkan
  baris caption…".

Each row:
- The time label (`formatClock(frameToMs(f0, fps))` from `shell-model.mjs`, for example
  "00:01,9") is the input's `<label>`.
- A text input: 44 px tall, `maxLength` 160, `spellCheck` off.
- Focusing a row while paused seeks the player to `f0`, so the preview shows that line.
- During playback, the row under the playhead gets the `--text` border; the frame bus drives it,
  outside React. That row scrolls into view (nearest) unless an input in the card has focus or
  the pointer is over the card.

The help line above the rows reads: "Ketik langsung untuk membetulkan kata. Waktunya tetap pas."

### 2.2 Editing

- The draft is local to the row (keyed by the row key). It is committed on Enter, on blur and on
  Tab (Tab then moves to the next row's input). Esc restores the row's text and keeps focus.
- A draft equal to the row's text (after the normalisation below, and the case rule under
  `upper`) commits nothing.
- Commit = `lineEdit()` (§2.3) → dry run (§2.5) → dispatch. On a refusal the row keeps the draft,
  gets `aria-invalid="true"`, and a message under it (`role="alert"`) says why.
- An empty draft hides every visible word of the row (a deletion of the whole line). The status
  line under the card says "Baris disembunyikan dari caption." Urungkan brings it back.

### 2.3 The diff

`lineEdit({ row, draft, doc, words, upper })` → `{ ok: true, commands }` or
`{ ok: false, code, message }`.

1. `old` = the row's sequence in word order: its visible words and its `hiddenIds`, each
   `{ id, text, hidden }` with the current text. `new` =
   `draft.normalize("NFC").trim().split(/\s+/u)`, filtering out empty strings.
2. If `new` is empty: one `SetWordHidden {wordId, on: true}` per visible old word. Stop.
3. `same(a, b)` is `a === b`. When `upper` is true it is
   `a.toLocaleUpperCase("id") === b.toLocaleUpperCase("id")`, because the viewer sees and retypes
   upper case.
4. Anchors = a longest common subsequence of `old` and `new` under `same`. Among the longest,
   take the one that matches the fewest hidden words, then the earliest pairing, so the result is
   deterministic. A hidden word that is an anchor is **unhidden**. A hidden word that is not an
   anchor stays hidden and plays no further part.
5. Walk the hunks between anchors. Hunk `h` holds the `k` unmatched visible old words `O` and the
   `m` new tokens `N`:
   - for `t < min(k, m)`: the final text of `O[t]` is `N[t]` (a change);
   - if `k > m`: `O[m..k)` are deletions;
   - if `m > k`: the extra tokens `N[k..m)` are **insertions**, attached to a host word. A host
     is a visible old word or an unhidden anchor:
     - when `k > 0`, the host is `O[k−1]`: append `" " + extras.join(" ")` to its final text;
     - when `k = 0` and an anchor precedes the hunk, the host is that anchor: append;
     - when `k = 0` at the start of the row, the host is the first anchor after the hunk:
       prepend `extras.join(" ") + " "`.

     A host may receive both a prepend and an append. The algorithm accumulates one final text
     per word id.
6. Emit the commands in word order:
   - one `SetWordHidden {wordId, on: false}` per unhidden word;
   - one `EditWordText {wordId, text}` per word whose final text differs from its current text
     under `same`. A case-only difference under `upper` keeps the stored text. `EditWordText`
     already drops the edit when the text equals the ASR text, so typing the original back
     restores the seed's content. A changed or new word is stored as typed;
   - one `SetWordHidden {wordId, on: true}` per deletion.

Examples. The row is `mulai aja dulu dari` (`w1 w2 w3 w4`), Karaoke unless noted:

| Row state and draft | Commands |
|---|---|
| `mulai aja dulu ya dari` | `EditWordText w3 "dulu ya"` |
| `mulai dulu dari` | `SetWordHidden w2 on` |
| then, with w2 hidden (the row shows `mulai dulu dari`), `mulai aja dulu dari` | `SetWordHidden w2 off` |
| `mulai aja duluan dari` | `EditWordText w3 "duluan"` |
| `Yuk mulai aja dulu dari` | `EditWordText w1 "Yuk mulai"` |
| `mulai saja deh dari` | `EditWordText w2 "saja"`, `EditWordText w3 "deh"` |
| Bold (`upper`, the input shows `MULAI AJA DULU DARI`), `MULAI AJA DULU DARI` | nothing |
| `` (empty) | `SetWordHidden` w1, w2, w3, w4 |

What the viewer gets:
- Deleting a word and typing it back restores that word with its own timing, so Karaoke and Bold
  light it at the right time. Urungkan also brings it back, as does "Sembunyikan" in Mode
  Lengkap's transcript.
- A truly new word shares its host's timing: Karaoke and Bold light it up together with the host.
- Audio never changes: a line edit cuts nothing.

### 2.4 Limits and messages

| Rule | Refusal (code → message) |
|---|---|
| More than 40 tokens in a draft | `too_many_tokens` → "Terlalu banyak kata dalam satu baris." |
| A final word text over 40 code points (`LIMITS.wordText`), for example several new words in one gap | `text_too_long` → "Teks baru di satu tempat terlalu panjang (maks. 40 huruf). Persingkat tambahannya." |
| Control or lone-surrogate characters | `text_invalid` → `COMMAND_MESSAGES.text_invalid` |
| Over 6000 word edits in the document | `too_many_word_edits` → `COMMAND_MESSAGES.too_many_word_edits` |
| Read-only clip | the inputs are `readOnly`; nothing commits |

The two new codes are messages of `caption-lines.mjs`. They are not command codes, so
`commands.mjs` does not change.

### 2.5 Atomic commit, undo, merge, autosave, focus

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
- **Focus across regrouping.** A commit happens before any regrouping (on Enter, blur or Tab), so
  no draft is lost. When the rows change and the focused row's key is gone, the pure
  `focusAfterRegroup(oldRows, newRows, focusedKey)` picks the new focus, in the same segment:
  1. the row that now holds the focused row's first visible word;
  2. if that word is now hidden, the first row at or after the old `f0`;
  3. else the previous row;
  4. else the card's status line (`tabIndex=-1`).

### 2.6 Fakes

`fakePlan` in `web/components/editor/__dev__/fakes.mjs` builds cues from all words in groups of 4
today. It changes to build them like the engine, in small:
- per segment, in piece order: a word whose midpoint lies in a piece's source span is captioned
  in that piece's segment, at `outF0 + (frame − inSf)`, so a cold-open word appears in the cold
  open and in the body;
- skip hidden words;
- break after 4 words and after a word ending in `.?!…` (trailing closers ignored);
- with the `box` pack, split cues whose text is over 24 characters. This is a dev-only stand-in
  for the font measure, commented as such.

## 3. Caption near the hook: a hint

- `hookNearNote(doc)` in `panels/caption-model.mjs` (B) is pure. It returns the note, or `null`:
  - `null` unless captions are on and the hook is on (the test TextPanel's "Tampilkan hook"
    switch uses);
  - `top` = the hook item's `transform.y_e5` (the hook's top, as `layout_hook` places it);
    `bottom` = `captions.overrides.y_e5` (the bottom of the caption block);
  - the note when `bottom < top + 35000`: "Caption dekat teks hook. Kalau bertumpuk di pratinjau,
    turunkan caption."
- The band is deliberately wide. The copy says "kalau" because the preview, which is exact, is the
  judge. With the seed hook (top 13000) the hint shows at Atas (38000) and not at Tengah (60000)
  or Bawah (83000): the mockup's case.
- It shows in the Caption card under Posisi and in Lengkap's TextPanel under the position slider,
  as a plain note (not `alert`).
- No engine change, no warning code, no "Perlu dicek" item and no export tick come from it. Seeds,
  plan shas and goldens are untouched (R10).

## 4. Mode switching

### 4.1 One editor, two views

| Shared, never forked | Per view |
|---|---|
| The store (document, history, autosave, IndexedDB draft, BroadcastChannel and two-tab merge), the player and frame bus, the export flow, the conflict dialog, "Perlu dicek", the toast, the transcript selection (`selectionStoreFor(doc.clip_id)` in `transcript/selection.mjs`), the hook-suggestion and cold-open-candidate clients (`suggestionsFor`, kept per clip), the face analysis (`layoutAnalysisFor`), the logo and music uploads (`logoUploads`, `musicUploadFor`) | The side region (cards or rail + panel), the bottom region (scrubber or transport + timeline), the open card, the open panel |

- **The transcript selection** is `selectionStoreFor(doc.clip_id)`, as `TranscriptPanel` and
  `ColdOpenPanel` read it today. The store's `setSelection` and `state.selection` are not used by
  the UI: `state.selection` is always null. EditorApp's I and O path reads `state.selection`
  today, so with the focus outside the words list it ignores the selection. A changes it to read
  the selection from `selectionStoreFor(clipId)`, so the toolbar's "Mulai di sini (I)" and
  "Akhiri di sini (O)" act on the selection from the keyboard too.
- **Work that outlives a card.** Today `LayoutPanel` keeps the face analysis per mount: unmounting
  bumps its token, and a run that finishes after that returns without `SetLayout`. MusicPanel
  keeps its upload progress per mount. B moves both into per-clip stores, in the pattern of
  `logoUploads` (`gizmos/logo-upload.mjs`) and `suggestionsFor`:
  - `panels/layout-analysis.mjs`: `layoutAnalysisFor(clipId)` with `subscribe`, `get` and
    `start({ api, dispatch, getState, switchAfter })`. Its state is
    `{ phase, startedAt, done, total, target, message }`. When a run finishes it applies
    `SetLayout` through the `dispatch` it was started with, unless a newer run or choice has
    superseded it. Whether a card or a panel is mounted does not matter.
  - `panels/music-upload.mjs` gains `musicUploadFor(clipId)` with the same shape, for the upload
    phase, name, progress and message. The finished upload applies `SetMusic` as MusicPanel does
    today (to the document as it is when the file arrives).
  - The card and the panel both read them with `useSyncExternalStore`. Lengkap shows an analysis
    started in Cepat, and the reverse.

Test: switching 10 times keeps the same canvas element (`===`), never calls `createPlayer`
again, and loses no undo entry. A face analysis started in Cepat applies `SetLayout` once after a
switch to Lengkap, and its progress shows there.

A text field commits on blur, so a click on the switch commits it first.

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
- The preference is written only when the viewer uses the switch. A deep link never writes it.
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
- **Login drops the query.** `page.jsx` builds the login `next` from `editorHref` without the
  query, and `web/app/**` is out of scope. A logged-out viewer who follows a deep link lands, after
  login, in the resolved view (stored, else Cepat) with no panel or card chosen. Deep links are
  made inside the editor (the switch, "Atur detail di Mode Lengkap"), where the viewer is logged
  in. AC3 covers logged-in viewers.

### 4.5 Keyboard

- **No new single-key shortcut.** The view switch has no shortcut of its own (WCAG 2.1.4 asks that
  single-character shortcuts can be turned off; this build adds none).
- **The switch** is a native radio group in the top bar. Tab reaches the checked radio, ←/→ switch
  the view (selection follows focus, as native radios do), and focus stays on the switch. A
  visually hidden polite live region says "Tampilan Cepat" or "Tampilan Lengkap".
- **Native inputs and global shortcuts** (A, `lib/editor/shortcuts.mjs`). Today
  `isEditableTarget` is true for every `INPUT`, so focusing a radio pill or a switch turns every
  global shortcut off, in Lengkap too. The new rules:
  - `isEditableTarget` is true for content-editable elements, `TEXTAREA`, `SELECT` and
    text-entry `INPUT`s only: `type` text, search, email, url, tel, password, number, the date
    and time types, and a missing or unknown type. A checkbox, radio, range, button, submit,
    reset, colour or file input is not a text field.
  - Space belongs to a focused checkbox, radio, range or button-type input (it toggles or presses
    it), as it already belongs to buttons and to the `SPACE_ROLES` roles.
  - Arrows belong to a focused radio or range input: native radios move inside their group.
  - Everything else stays global. After a click on a pack pill or the whoosh switch, Ctrl+Z
    undoes, ' toggles Zona aman, ? opens the help and K plays or pauses.
- Every global shortcut works in both views. Transcript-scope shortcuts (Delete, Enter, Ctrl+E,
  Ctrl+Shift+X, Ctrl+Shift+H) exist only where the transcript is, in Lengkap.
- The scrubber has its own keys when focused (§7). The shortcut help dialog lists them.

## 5. Top bar, stage and the removed texts

### 5.1 Top bar (both views, `TopBar.jsx`)

The bar is 64 px tall: A changes the existing `--ed-topbar-height` from 56 to 64 px; the grid and
the popovers' offsets follow it. Left to right:
1. "← Proyek" (44 px tall).
2. The title (`h1`, 16/700, ellipsis), the save status with its dot ("Tersimpan", "Menyimpan…",
   …, unchanged rules), and the warning chip "Terbuka di tab lain" while `state.otherTab`.
3. The segmented "Cepat | Lengkap" switch: `role="radiogroup"`, `aria-label="Tampilan editor"`,
   two native radios styled as one segmented pill, each 44 px tall. Checked: `--text` fill with
   `--bg` text.
4. Urungkan and Ulangi as 44×44 icon buttons, with `aria-label`, `aria-keyshortcuts` and a
   `title` holding the shortcut.
5. "Perlu dicek (n)", **always rendered**, as today. Its "Catatan" list holds notes such as the
   K5 caption-spot note, and closing the list returns focus to this button. Neutral at 0; a
   `--warning` border when n > 0.
6. "Lainnya": a 44×44 ⋯ menu button (`ui/MenuButton.jsx`) with "Kembali ke versi AI" and "Pintasan
   keyboard (?)".
7. **Ekspor**, the only lime control (`--accent` / `--accent-ink`).

### 5.2 Stage overlays (both views)

The overlays sit in the preview area beside the 9:16 stage, never over the video.

- **Top right**, two `PillToggle`s, 44 px tall, which leave the controls row:
  - **Frame akhir**: `aria-pressed`, Ctrl+Shift+R, disabled under today's rule. A visible
    control in every state, as today.
  - **Zona aman**: `aria-pressed`, shortcut `'`.
- **Top left**, today's `StageBadge`, moved and trimmed:
  - The status text keeps its element, with `role="status" aria-live="polite"` and
    `data-testid="stage-badge"`, so every change is still announced. The "● " prefixes go.
  - The detail line stays for the tones that have one.
  - "Apa artinya?" becomes a 44×44 "?" icon button with the same accessible name. It opens
    today's help (`badgeHelp`, `role="note"`); Esc closes it and returns focus.
  - The tones are today's, including the first-frame fix's `failed` ("Frame gagal dimuat").
  - Tone `legacy` (an unchanged clip whose auto file came from the old engine): the status text
    is empty and there is no detail. The "?" button stays and opens today's legacy help,
    unchanged: "Klip ini belum diubah, jadi ekspor memakai file klip otomatis apa adanya. File itu
    dibuat sebelum editor dibuka, jadi bisa sedikit berbeda dari pratinjau ini (misalnya posisi
    video, warna teks). Setelah Anda mengubah apa saja, hasil ekspor sama dengan pratinjau ini."
- In Lengkap the transport row keeps play, frame back, frame forward and the time. Cepat's bottom
  bar has play, the time and the scrubber.

### 5.3 Removed texts and where the information goes

| Text on screen today | Where | After | Where the information goes |
|---|---|---|---|
| "Klip otomatis ini dibuat sebelum editor dibuka; setelah klip diubah, tampilan teks hasil ekspor bisa sedikit berbeda" | `noticesView` `legacy_engine`, above the stage | removed | The "?" legacy help already says it, unchanged. Engine provenance stays in the document (`base.engine.compiler`) and the logs |
| "● Belum diubah: ekspor = klip otomatis" + detail "Ubah apa saja agar ekspor sama persis dengan pratinjau ini" | `badgeView` tone `legacy` | removed (empty status) | The "?" legacy help. The export dialog keeps its line "Tanpa perubahan: file klip otomatis dipakai langsung" |
| "● " prefixes | badge texts | removed | none needed |
| "Klip ini terbuka di tab lain" | notice above the stage | moved | The top-bar chip "Terbuka di tab lain" |

Kept, because they are not technical: the stage status, the read-only banner ("Transkrip berubah
sejak klip diedit" + "Mulai dari versi AI", restyled neutral), every "Perlu dicek" item, the
toasts, and the transcript help line.

`MESSAGES.legacy_engine` stays in the JS mirror. It no longer renders, and the drift test still
lists it.

`CAPTION_SPOT_NOTE` (the K5 note in "Perlu dicek") says "geser ke atas di tab Teks" today, which
names a tab Cepat does not have. A changes it to "Caption di posisi bawaan, dekat tombol TikTok.
Kalau tertutup, geser caption ke atas." and updates its two assertions.

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
  wide, one button per live `PANELS` entry (six today).
- Rows are `minmax(var(--ed-target), 64px)`: 64 px when there is room, never under 44 px. Each
  button holds a 20 px icon (`ui/icons.jsx`, mapped by panel id inside `Rail.jsx`, so
  `panels/index.mjs` is not edited) above a label (12/600, never smaller). The rail scrolls only
  when six 44 px rows do not fit.
- Selected: `--surface-3` background and `--text`. Others: `--text-muted`.
- The ids are unchanged (`editor-tab-<id>`, `aria-controls="editor-panel"`), and so are the names.
  ↑/↓ move and select, Home/End go to the ends, and the selected tab is the only tab stop (roving
  `tabIndex`).

### 6.2 Contextual word toolbar (`transcript/WordToolbar.jsx` + `transcript/word-toolbar.mjs`)

- **Replaces** the 9 chips (`Hapus`, `Pulihkan`, `Edit kata`, `Sembunyikan`, `Kata kunci`,
  `Mulai di sini`, `Akhiri di sini`, `Perpanjang ke sini`, `Jadikan cold open`).
- It reads the selection from `selectionStoreFor(doc.clip_id)`, as `TranscriptPanel` does.
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
  4. "Lainnya ▾": a `ui/MenuButton` with, in a fixed order, Edit kata (Enter), Sembunyikan dari
     caption (Ctrl+Shift+X, `menuitemcheckbox`), Mulai di sini (I), Akhiri di sini (O), and the
     two of Hapus, Pulihkan and Perpanjang ke sini that are not primary. Unavailable items stay in
     place with `aria-disabled` and their reason as the description.
- **Keyboard:**
  - With a selection, **Tab** from the words list moves into the toolbar (first button).
  - ←/→ move between buttons, Home/End go to the ends.
  - **Esc** returns to the words list and keeps the selection. Shift+Tab goes back to the list.
  - On "Lainnya", ↓, Enter or Space opens the menu. In the menu ↑/↓ move, Enter runs, and Esc
    closes back to the button.
  - The list's shortcuts are unchanged. I and O act on the selection from the toolbar too (§4.1).
  - The hidden help text gains "Tab membuka aksi kata terpilih."
- Every action calls the existing `commandsFor(name, actions)` and `perform`. No command or rule
  changes, so the toolbar and the keyboard always agree.

### 6.3 Timeline and bottom area

The Timeline component and its lanes do not change. Above them, the shell's transport row (56 px)
holds play, the frame step buttons and the time. Zona aman, the status and "Frame akhir" moved to
the stage (§5.2).

## 7. The scrubber (`scrubber/Scrubber.jsx` + `scrubber/scrubber-model.mjs`)

- **Data.** `scrubberMarks({ doc, words })` is pure:
  - laughs (`kind: "laughter"`) and pauses (`kind: "silence"`) from `buildMarkers(words, doc)`
    (`timeline/lanes/markers.mjs`, imported, not changed). Camera cuts are left out;
  - the cold-open range `[0, J)` from `pieces(doc)`;
  - the join mark at J from `transitionView(doc)`, only when `style !== "cut"` or the whoosh is
    on;
  - `unavailable` from `buildMarkers`, passed through.

  Labels come from `markerText`. The scale is `plan.totalFrames`, as `MarkerLane` uses it.
  `frameAtPx`, `pxAtFrame`, `nearestMark(f, px)`, `nextMark(f, ±1)` and
  `drawGroups(marks, pxPerFrame)` are pure as well.
- **Drawing**, one row with a 44 px hit area:
  - a 4 px track in `--border`, and the cold-open bar in `--cold-open`;
  - laugh dots (8 px, `--warning`) and pause ticks (3×10 px, `--text-muted`);
  - the join mark: a 10 px diamond, filled `--text` for Kilat putih, `--bg` with a `--text`
    border for Gelap sebentar, outline only for Potong langsung with whoosh;
  - the playhead (2 px, `--text`), moved by the frame bus outside React;
  - `drawGroups` merges marks closer than 6 px into one dot at the group's earliest frame. Its
    label names every mark of the group ("Tawa, Jeda · 00:12,3"). The model keeps every mark at
    its own frame;
  - below the track, the legend (12 px, muted): Tawa, Jeda, Cold open, and Transisi when a join
    mark exists;
  - under the legend, `unavailableNote(unavailable)` when it is not null, as `MarkerLane` shows
    it (12/400, `--text-muted`).
- **Pointer.** Pointer down seeks; dragging seeks once per animation frame, the same behaviour
  as clicking the ruler today. A press within 6 px of a mark snaps to it. Hovering a mark shows
  its label.
- **Keyboard and screen readers.**
  - `role="slider"`, `aria-label="Posisi putar"`, `aria-valuemin=0`,
    `aria-valuemax=totalFrames−1`, and `aria-valuetext` "00:02,2 dari 01:00,6".
  - While playing, `aria-valuenow` updates at most 4 times a second.
  - ←/→ step one frame, Shift+←/→ one second, Home/End jump to the ends, PageUp/PageDown jump to
    the previous or next model mark (cold-open edges included).
  - **Space and K play or pause.** `globalShortcut` leaves Space to a focused slider, so the
    scrubber handles Space and K itself and calls `preventDefault`. A pointer press that focuses
    the scrubber therefore never takes Space away from playback.
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
- **Lime** (`--accent`, `--accent-hover`, `--accent-ink`). Allowed only on Ekspor (rest and hover)
  and on transient progress fills (`TOKENS.md`: "isi progres"). Today's facts:
  - at rest, only `shell.module.css` `.primary` is lime: Ekspor, ReadOnlyBanner's "Mulai dari
    versi AI", and the dialogs' primaries;
  - `panels.module.css` and `logo.module.css` `.primary` ("Jadikan cold open", "Unggah logo") are
    neutral at rest but turn lime on hover (`.primary:hover` → `--accent-hover`);
  - the progress fills are `suggestions.module.css` `.fill`, `layout.module.css` `.cardFill` and
    `logo.module.css` `.bar`.

  Changes:
  - the two panel `.primary:hover` rules become neutral (`--text-muted` fill, `--bg` text) (B);
  - ReadOnlyBanner's button gets a neutral class instead of the shell `.primary` (A);
  - dialogs keep one lime primary each: Mulai ekspor, Unduh MP4, Coba lagi, Terapkan pilihan.
- **Size tokens** in `editor.module.css`:
  - Z0 adds only new names, so nothing moves at the base: `--ed-target: 44px`,
    `--ed-bottom-height: 96px`, `--ed-rail-width: 84px`,
    `--ed-side-width: clamp(360px, 32vw, 460px)`, `--ed-font-size-note: 13px`,
    `--ed-label-tracking: 0.08em`;
  - A changes the existing `--ed-topbar-height` from 56 to 64 px (§5.1) and keeps the existing
    layout cases green with it.

### 8.2 Shared components (`web/components/editor/ui/`, written once, never copied per panel)

| Component | API | Semantics |
|---|---|---|
| `PillGroup` | `{ legend, name, options: [{ id, label, detail?, disabled?, title? }], value, onChange, disabled, describedBy, columns }` | `fieldset` + `legend` + native radios in pill labels (the `cover` pattern of `panels.module.css`); arrows move, as native radios do. The shortcut filter (§4.5) leaves Space and arrows to them and keeps every other global shortcut |
| `PillToggle` | `{ pressed, onPressedChange, children, ...button }` | `button aria-pressed` (Frame akhir, Zona aman) |
| `PillButton` | `{ variant: "default" \| "strong" \| "quiet", ...button }` | an action pill (Putar, Ganti kalimat, Hapus cold open) |
| `AccordionCard` | `{ id, label, summary, open, onToggle, children, headingLevel = 2 }` | h2 > button with `aria-expanded`/`aria-controls`; region with `aria-labelledby`; a closed body is `inert` (§1.3) |
| `Switch` | `{ label, checked, onChange, disabled, describedBy }` | `input type=checkbox role=switch`, visible label |
| `Swatches` | `{ legend, name, value, options, onChange, disabled, note }` | radios, 44 px targets around 28 px dots |
| `MenuButton` (`ui/MenuButton.jsx`) | `{ label, icon?, items: [{ id, label, shortcut?, disabled?, reason?, checked?, onSelect }], align }` | WAI-ARIA menu button pattern; Esc returns focus |
| `icons.jsx` | `Icon({ name, size = 20 })`; names `back undo redo more play pause chevron transcript text coldopen layout logo music safezone help` | `aria-hidden`, stroke 2, from the mockup's paths |
| `ui.module.css` | the classes of the above | tokens only |

Lengkap panels adopt them where they offer the same control:
- the pack and duck presets, the layout options and the logo corners become `PillGroup`;
- the switches become `Switch`;
- the swatches become `Swatches`;
- `TransitionSection` keeps T3's markup (its e2e checks it).

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
- **Focus:** the shell's rule, unchanged:
  `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; box-shadow: var(--ed-focus-ring); }`.
  The outline stays visible under `forced-colors: active`, where box-shadow is dropped. Radio
  pills show the same outline and ring on their label through `:has(input:focus-visible)`. A
  popover or menu returns focus to its button when it closes.
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
| AC3 | Deep links | For a logged-in viewer, `?mode`, `?panel`, `?card` open as in §4.4. Unknown values fall back. The prepare flow keeps the query |
| AC4 | Keyboard | The view switch works by Tab and ←/→, keeps focus, and the live region names the view. After a click on a pack pill, a swatch, a transition style and the whoosh switch, Ctrl+Z undoes, ' toggles Zona aman, ? opens the help and K plays; Space and arrows act on the focused control. While a text field has focus, none of the global shortcuts fire |
| AC5 | Cards and parity | Exactly one card open; closed bodies are `inert`. Summaries as §1.3. For every shared control (hook text, suggestion, pack, size, position, highlight, layout, transition style and whoosh, duck), both views build the same `{ type, args }` from the same model function; the merge key is `null` for a pick and `cap:<key>` for a slider drag. For the same document both views show the same highlight note, zone notes, hook hint and Transisi section |
| AC6 | Teks caption | Every row of `plan.cues`, with unique keys (a cold-open line and its body twin included). The §2.3 table holds. Deleting a word and retyping it gives `SetWordHidden off` and no `EditWordText`. Under Bold, retyping the shown upper-case text commits nothing. A refused commit dispatches nothing. One commit is one Urungkan. Focus follows §2.5 when rows regroup: a "." typed in Karaoke, a word hidden, a Box split. A line edit never changes `plan.pieces` or `totalFrames`, and every cue whose first word also started a cue before keeps its `f0` |
| AC7 | Hook hint | With the seed hook, the hint shows at Atas and leaves at Tengah, at Bawah and with the hook off. Lengkap shows the same text under the position slider for the same document. No warning code, "Perlu dicek" item or export tick comes from it |
| AC8 | Scrubber | `scrubberMarks` has a mark at every `buildMarkers` laugh and pause frame (±0). Drawn marks closer than 6 px merge into one dot at the earliest frame, labelled with all of them. Seek by pointer, by keyboard and to marks (PageUp/PageDown). With the scrubber focused, Space and K play and pause. `aria-valuetext` as §7. The unavailable note shows when `buildMarkers` reports missing analysis |
| AC9 | Rail | One column at viewports 1366×650 and 1920×960, and at the existing 1366×768 and 1920×1080 (today's tabs wrap onto two rows); at 1366×650 all six tabs show without scrolling. Vertical arrow keys. `getByRole("tab", {name})` finds every panel |
| AC10 | Word toolbar | Appears above the selection and never covers it. Primary action as §6.2. Every one of the 9 former chips is reachable by mouse and keyboard. No chip row in the header. I and O pressed with focus on the toolbar act on the selection |
| AC11 | Removed texts | Neither legacy string is visible in any state. In the legacy state the status text is empty and the "?" help shows today's legacy help text. Every other tone's text is announced through the same live region. The export dialog line is unchanged |
| AC12 | Lime | A computed-style sweep in both views (each card open, each panel open, every button at rest and hovered, dialogs closed) finds the `--accent`, `--accent-hover` and `--accent-ink` colours only on Ekspor and on progress fills |
| AC13 | Targets, focus, motion | Every control listed in §8.4 measures ≥ 44 px. axe: 0 critical, 0 serious. With reduced motion, the accordion's computed `transition-duration` is `0s`. Under forced-colours emulation, a focused pill, card header and rail tab have an `outline-style` other than `none` |
| AC14 | Latest only | The version guard passes with the two new patterns |
| AC15 | No regressions | Every existing unit test and every e2e spec on the fakes passes, the transition and first-frame specs included. PF-OPEN (first visit p95 ≤ 3.0 s, repeat ≤ 2.0 s) holds in CI for both views: Lengkap's interactive moment stays `[data-panel="transcript"]` shown; Cepat's is the Caption card's body shown. It runs with `-f gates=true` (§10, Z0) |
| AC16 | Work survives | A face analysis started from the Tata letak card keeps running when the card closes or the view switches, shows its progress in `LayoutPanel`, and applies `SetLayout` once. A music upload started in the card finishes and applies after the card closes or the view switches |
| AC17 | Hook suggestions | In Cepat the Hook card shows the privacy line whenever the AI part is visible, as Lengkap does, and the stale, error, failed, rate-limited and none states with their buttons. Opening the editor in Cepat sends no `/ai` request (R1) |

### 9.2 Unit tests (node, run locally only for the files a task changes)

- `editor-view-mode.test.mjs` (A, new):
  - `resolveView` truth table;
  - storage that throws on get and on set;
  - unknown values;
  - `urlWithView` keeps other params and drops `panel`/`card`;
  - `viewFromUrl` rejects ids outside `PANELS` and the cards.
- `editor-shortcuts.test.mjs` (A):
  - `isEditableTarget` per input type (text types true; checkbox, radio, range, button, file
    false);
  - Space on a checkbox, radio, range or button input → null; arrows on a radio or range input →
    null;
  - Ctrl+Z, ', ?, K on a radio or checkbox input → their ids;
  - no shortcut maps a plain `m`.
- `editor-shell-model.test.mjs` (A):
  - `noticesView` never returns `legacy_engine`;
  - `badgeView` tone `legacy` has an empty text and no detail;
  - no badge text starts with "● ";
  - the first-frame fix's `failed` tone is kept;
  - the new `CAPTION_SPOT_NOTE` text.
- `editor-w2-seams.test.mjs` (A): the shared props bundle reaches both `<Panel>` and
  `<QuickPanel>`.
- `editor-quick-model.test.mjs` (B, new):
  - the presets in both directions (value → pressed pill; off-preset → none);
  - every summary;
  - `captionCommand`: both views' `{ type, args }` are equal for the same choice, and the merge
    key is `null` for a pick and `cap:<key>` for a drag;
  - the same equality for hook text, suggestion, layout, transition, duck;
  - `highlightNote`, `captionZoneNote` and `hookNearNote` truth tables (`bottom = top + 35000`
    gives no hint).
- `editor-layout-analysis.test.mjs` (B, new): a run that finishes with no subscriber applies
  `SetLayout` once; a newer run or choice supersedes it; a failure sets the message and no
  command. The same for `musicUploadFor`: progress, finish applies `SetMusic` once, cancel.
- `editor-ui-kit.test.mjs` (B, new; reads CSS only, never renders):
  - no literal durations in `ui/`, `quick/`, `rail/`, `scrubber/` and `transcript/WordToolbar*`
    CSS;
  - `--accent*` only in the allow-listed selectors: `suggestions .fill`, `layout .cardFill`,
    `logo .bar` (B's directories), and none in `ui/`, `quick/`, `rail/`, `scrubber/`;
  - no `.primary:hover` with `--accent*` in `panels/`;
  - `min-height`/`min-width` ≥ `var(--ed-target)` on the kit's control classes.
- `editor-caption-lines.test.mjs` (C, new):
  - `captionRows` on fake cues: unique keys with a cold-open double, `seg` and `cold` from the
    plan pieces, hidden words dropped before the plan, `hiddenIds`, upper case;
  - every row of the §2.3 table, including unhide on retype and the Bold case rule;
  - property test: for 2 000 random drafts over random rows (with hidden neighbours), applying
    the commands then rebuilding the row's text from the document gives the draft's token
    sequence (case-insensitively under `upper`). Deleted words are hidden, and every inserted
    token is in its host's text;
  - `focusAfterRegroup` on splits, joins and a hidden first word;
  - limits and messages;
  - `checkCommands` refuses atomically;
  - one merge key per commit.
- `editor-word-toolbar.test.mjs` (D, new): `primaryAction` over the `selectionActions` states;
  menu items and reasons; the position math (above, flip, clamp) on fake rects.
- `editor-scrubber.test.mjs` (D, new): `scrubberMarks` against `buildMarkers` on the marker
  fixtures; the join mark per style and sfx; `drawGroups` merging and labels; `nextMark` order;
  px↔frame round trips.
- `ui-guards.test.mjs` + `support/ui-guards.mjs` (A): the two new version patterns, each first
  shown to catch a planted string.

### 9.3 Python

This build changes no Python and no engine output. `src/**` and `tests/**/*.py` are untouched;
`suite=full` still runs them, and every plan sha and golden stays the same.

### 9.4 Browser specs on the fakes (CI: `editor-gates.yml -f suite=e2e`)

| Spec | Owner | Covers |
|---|---|---|
| `e2e/editor-views.spec.mjs` (new) | A | AC1–AC4, AC11, AC12 (the sweep); the top bar (switch, ⋯ menu, Perlu dicek at 0 and above); the stage status, "?" and Frame akhir; QG-A11Y on Cepat with each card open, at 1366×650 and 1920×960; 44 px measurement of the top bar, overlays and bottom bar; forced-colours focus (AC13) |
| `e2e/editor-quick.spec.mjs` (new) | B | AC5, AC7, AC13 for the cards, AC16, AC17; each card's controls change the preview's plan as the panel would; U3, U4, U5 scripted in Cepat (U5 with its unchanged stop condition, §9.6) |
| `e2e/editor-quick-lines.spec.mjs` (new) | C | AC6 end to end: edit, insert, delete, delete-then-retype, empty line, Esc, a refusal, Urungkan, regrouping focus in Karaoke and Box, a cold-open line and its twin, two tabs editing different words of one row merge |
| `e2e/editor-lengkap.spec.mjs` (new) | D | AC9, AC10; the toolbar by keyboard only; U1, U2 scripted through the toolbar |
| `e2e/editor-scrubber.spec.mjs` (new) | D | AC8 by pointer and keyboard |
| `e2e/editor-shell.spec.mjs` | A | updated for §5 (status moved, Frame akhir and Zona aman on the stage, controls row, other-tab chip, the new K5 note); PF-OPEN for both views (AC15) |
| `e2e/editor-first-frame.spec.mjs` | A | only if the badge move changes a selector (`data-testid="stage-badge"` stays) |
| `e2e/editor-transcript.spec.mjs`, `editor-cleanup.spec.mjs` | D | the chips → toolbar |
| `e2e/editor-{ai,layout,logo,music,transition}.spec.mjs` | B | only if the kit adoption or the moved stores change a selector. "Perlu dicek (0)" stays, so `editor-logo`'s checks hold |
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
  "Perlu dicek" stays rendered at 0, so their `Perlu dicek (0)` assertions hold.

### 9.6 UJI-PENERIMAAN impact (owner's stopwatch; limits and stop conditions unchanged)

| Test | Before | After | Expected effect |
|---|---|---|---|
| Start of every task | "Kembali ke versi AI" in the top bar | ⋯ Lainnya → Kembali ke versi AI | +1 click before the stopwatch |
| U1 clipped first word (20 s) | Transkrip tab | Lengkap (switch, or "Potong per kata di Mode Lengkap →") → select the dimmed word → toolbar "Perpanjang ke sini" (or I) | +1 click if the clip opened in Cepat; the toolbar puts the action next to the word. The start cue "tanda di bawah pratinjau sudah tampil" names the same badge in its new place: "status di kiri atas pratinjau sudah tampil". After U1's setup the clip is changed, so the status is never the empty legacy one |
| U2 remove ~5 s (20 s) | select + Delete | unchanged keys; the toolbar's "Hapus" is next to the selection | ≈ same |
| U3 cold open (45 s) | Cold open tab or Ctrl+Shift+H | Cepat: Cold open card → Ganti kalimat → Putar → Pakai (or the toolbar in Lengkap) | faster: no tab hunt |
| U4 hook + pack (30 s) | Teks tab, Pakai, a pack | Cepat: Hook card → a suggestion; Caption card (open on load) → a pack | faster: the pack is visible on load |
| U5 logo + music (60 s) | Logo tab, Musik tab | Cepat: Logo & Musik card (Tambah logo, Tambah musik, the strength) | **The stop condition does not change**: "lajur Musik di timeline menunjukkan garis volume yang turun". The lane is only in Lengkap, so the tester switches to Lengkap to check it, inside the 60 s. Changing it is the owner's call (§11 Q5) |
| U6 export (clip + 30 s) | Ekspor | unchanged | same |
| U7 reload + reset (20 s) | top-bar button | part 1 in Cepat (Hook + Caption cards); part 2 via ⋯ Lainnya | +1 click |
| **U8 new: fix one caption word (20 s)** | none | Cepat: Teks caption card → the row → fix the word → Enter | Stops when the preview shows the word and "Tersimpan" shows. Scripted in `editor-quick-lines.spec` |

Tour (§5 of the protocol) gains item 14, "Dua tampilan": switch views with the mouse and with the
keyboard (Tab, ←/→), reload, and confirm that nothing is lost and the view is remembered.

### 9.7 Docs (integrator)

- **`docs/editor/PANDUAN-EDITOR.md`:**
  - the intro and §1 gain the two views, the default and the switch;
  - §2 is split into "Mode Cepat" (one paragraph per card; Teks caption with the unhide and
    insertion rules) and "Mode Lengkap" (rail; the transcript toolbar with Tab and Esc);
  - §3 becomes "Status di atas pratinjau" (the status, "?", Frame akhir, Zona aman). The legacy
    row is removed;
  - §5 adds the scrubber keys and the toolbar keys, and that shortcuts keep working after a pill
    click;
  - §6 adds "Tidak menemukan transkrip → Mode Lengkap".
- **`docs/editor/UJI-PENERIMAAN.md`:** §9.6 (the U1 start cue's new place, U5 unchanged, U8 in the
  result sheet), tour item 14.
- **`docs/editor/CONTRACTS.md`:** a new §5.27 "Editor views": the preference key, the URL params
  and the login limit, the line-edit diff rule (unhide, case, insertions) and its limits, the
  props bundle, the per-clip stores, the shortcut filter.
- **`docs/editor/GATES.md`:** a new section "Mode Cepat" with the suites, QG-A11Y, PF-OPEN for both
  views and the scripted U-tests.
- **`docs/HANDOFF.md`:** status.

Evidence goes to `docs/editor/evidence/MC/<task>-*.json`.

## 10. Task split

### Order

0. **Prerequisites.** Both merge into `main` first:
   - the cold-open transition PR (T1–T3);
   - the first-frame fix (`fix/editor-first-frame`, `c1e8383`, on origin now). It touches
     `EditorApp.jsx`, `shell-model.mjs` (`playerView`, the badge tone `failed`),
     `shell.module.css`, `lib/editor/player/**` and `editor-gates.yml` (a `suite=player`).

   T3 also edits `editor-gates.yml` (`suite=e2e`); whichever of the two merges second resolves
   that file. Z0 branches from `main` after both.

   Done: the transition merged as PR #23 (`53d6656`) and the first-frame fix as PR #24
   (`3faf2f9`). `editor-gates.yml` on `main` has `suite=full|image|command|e2e|player`.
1. **Z0 scaffold** on `mode-cepat-base` (from `main`). No visible change at the default URL. It
   lands:
   - every `ui/*` component of §8.2 as a minimal working version (`PillGroup`, `PillToggle`,
     `PillButton`, `AccordionCard`, `Switch`, `Swatches`, `ui/MenuButton.jsx`), and the full
     `icons.jsx`;
   - `quick/cards.mjs` with placeholder bodies, `quick/QuickPanel.jsx`, `rail/Rail.jsx` (today's
     text tabs moved inside), `scrubber/Scrubber.jsx` (a plain range input);
   - `lib/editor/caption-lines.mjs` with working `captionRows` (keys, `seg`, `cold`, hidden
     filtering) and `linesSummary`; `lineEdit` and `checkCommands` throw "not built". C owns the
     file from then on;
   - a minimal `?mode=cepat` branch in `EditorApp` that mounts the placeholders (default stays
     Lengkap);
   - the new size tokens only (§8.1); `--ed-topbar-height` stays 56 px;
   - a `gates` input in `editor-gates.yml`: boolean, default false, which sets `EDITOR_GATES=1`
     in the e2e step's env and does nothing else;
   - the e2e helper files and the `?mode=lengkap` constants (§9.5).

   CI: `suite=full` and `suite=e2e` over every editor spec, all green.
2. **A, B, C, D** branch from `mode-cepat-base` (`mode-cepat-a-shell`, `-b-cards`, `-c-lines`,
   `-d-lengkap`) and build in parallel. Each branch goes green on its own:
   - B's card summaries use Z0's working `linesSummary`;
   - the hook hint needs nothing from C or Z;
   - A's `PillToggle` comes from Z0.

   Each pushes its branch and runs its CI (§10, per task).
3. **Merge into `mode-cepat-integrasi`** in this order:
   1. **C** (the line model, no UI dependency beyond its card);
   2. **B**;
   3. **D**;
   4. **A** last (it flips the default to Cepat and changes the shell the others mount into).

   Ownership is disjoint, so these merges have no conflicts.
4. **Z integration:**
   - the real-stack specs (`editor-flow`, `editor-acceptance`);
   - the docs (§9.7) and the evidence;
   - CI: `suite=full`, `suite=image`, `suite=e2e` (every spec), and `suite=e2e -f gates=true` for
     PF-OPEN;
   - one PR to `main`. Agents never push to `main`, never force-push, and never merge.
5. The owner runs U1–U8 at 1366×768 and 1920×1080, then merges.

### A — shell, view switch, top bar, stage overlays, shortcuts (owns)

- `web/components/editor/{EditorApp.jsx, TopBar.jsx, StageControls.jsx, StageBadge.jsx, Stage.jsx, ReadOnlyBanner.jsx, shell-model.mjs, shell.module.css, editor.module.css}`
  and the new `ViewSwitch.jsx`.
- `web/lib/editor/{view-mode.mjs (new), shortcuts.mjs}`.
- `web/tests/{editor-view-mode (new), editor-shortcuts, editor-shell-model, editor-w2-seams, ui-guards}.test.mjs`,
  `web/tests/support/ui-guards.mjs`.
- `web/e2e/{editor-views.spec.mjs (new), editor-shell.spec.mjs, editor-first-frame.spec.mjs, read-only.spec.mjs, support/editor-topbar.mjs}`.
- `docs/editor/evidence/MC/A-*.json`.
- Does not change the timeline classes in `shell.module.css` (the timeline is unchanged).

### B — Mode Cepat cards and the shared kit (owns)

- `web/components/editor/ui/**`.
- `web/components/editor/quick/**`, except `CaptionLinesCard.jsx` and its CSS.
- `web/components/editor/panels/**`:
  - the new `caption-model.mjs` and `layout-analysis.mjs`, and `musicUploadFor` in
    `music-upload.mjs`;
  - the extractions `ColdOpenSuggestions.jsx`, `TransitionSection.jsx` and `use-audition.js`;
  - `TextPanel` on the shared caption model (the hint under the slider, the shared notes);
  - `LayoutPanel` and `MusicPanel` on the per-clip stores;
  - the kit adopted in `TextPanel`, `LayoutPanel`, `LogoPanel`, `MusicPanel` and `ColdOpenPanel`;
  - the lime clean-up of the two `.primary:hover` rules.

  `panels/index.mjs` itself is not edited.
- `web/components/editor/suggestions/**` (the shared hook and the compact list).
- `web/tests/{editor-quick-model (new), editor-layout-analysis (new), editor-ui-kit (new)}.test.mjs`,
  plus the existing panel unit tests only where an extraction moves code (`editor-layout`,
  `editor-logo`, `editor-music`, `coldopen-suggestions`, `editor-coldopen-transition`,
  `editor-ai`).
- `web/e2e/{editor-quick.spec.mjs (new), support/editor-cards.mjs, editor-ai, editor-layout, editor-logo, editor-music, editor-transition}.spec.mjs`.
- `docs/editor/evidence/MC/B-*.json`.

### C — Teks caption line editing (owns)

- `web/lib/editor/caption-lines.mjs` (after Z0).
- `web/components/editor/quick/{CaptionLinesCard.jsx, CaptionLinesCard.module.css}`.
- `web/components/editor/__dev__/fakes.mjs`.
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

- `web/e2e/{editor-flow, editor-acceptance}.spec.mjs`.
- `docs/editor/{PANDUAN-EDITOR, UJI-PENERIMAAN, CONTRACTS, GATES}.md`, `docs/HANDOFF.md`.
- `docs/editor/evidence/MC/Z-*.json`.
- In Z0 only: the scaffold files listed above and the `gates` input of `editor-gates.yml`.

### Files nobody touches

- `web/lib/editor/{commands,doc-model,rebase,history,store,autosave,draft-store,timemap,api-client,preview-client,upload-client,open-clip,flags,content-colours}.mjs`
  and `web/lib/editor/player/**`.
- `web/components/editor/timeline/**` (the scrubber imports `lanes/markers.mjs` without changing
  it), `gizmos/**`, `{ExportDialog,ConflictDialog,ChecksPanel}.jsx`, `export-flow.mjs`,
  `runtime.mjs`.
- `web/app/**` (the edit page, `globals.css`).
- `src/**` and `tests/**/*.py`.
- `compose.yaml`, `Dockerfile`, and `.github/workflows/*` except Z0's `gates` input.

A task that finds it must change one of these stops and reports instead.

### Per-task CI (never on the owner's PC beyond targeted node tests)

```
cd web && node --test tests/<the task's test files>          # local, targeted only
gh workflow run editor-gates.yml -f ref=<branch> -f suite=full
gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command='e2e/<the task's specs>'
gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f gates=true -f command='e2e/editor-shell.spec.mjs --grep PF-OPEN'   # A and Z
gh run watch <id> --exit-status ; gh run view <id> --log-failed ; gh run download <id>
```

Before every push, scan with main's gitleaks config (a worktree mounts the main repo's `.git`).
Commits end with the `Co-Authored-By` trailer the session gives.

### Shapes fixed here so the tasks can build in parallel

| Shape | Producer | Consumers | Section |
|---|---|---|---|
| Card registry entry `{ id, label, owner, file, load }`; ids `hook caption lines coldopen layout extras` | Z0 → B | A (deep links), C | §1.2, §4.4 |
| Card props = the panel props bundle + `frameBus`, `showLengkap(panelId)` | A | B, C | §1.2 |
| `ui/*` APIs and icon names (`ui/MenuButton.jsx`) | Z0 → B | A, C, D | §8.2 |
| `captionRows`, `linesSummary` (working in Z0), `lineEdit`, `checkCommands`, `focusAfterRegroup` | Z0 → C | B (summary), C | §2 |
| `captionCommand`, `highlightNote`, `captionZoneNote`, `hookNearNote` | B | B (card and TextPanel) | §1.4, §3 |
| `layoutAnalysisFor(clipId)`, `musicUploadFor(clipId)` | B | B (card and panels) | §4.1 |
| `Rail({ panels, value, onChange })`, `Scrubber({ plan, state, player, frameBus, disabled })` | D | A | §6.1, §7 |
| `view-mode.mjs` API, URL params, storage key | A | Z (docs) | §4 |
| The shortcut filter (`isEditableTarget` and the Space and arrow owners) | A | every view | §4.5 |
| e2e helpers per owner | Z0 → A, B, D | every spec | §9.5 |

## 11. Risks and open questions

### Risks

- **R1. LLM quota and disclosure.**
  - **Risk:** the hook suggestions ask the free LLM when their component mounts (`ensure(doc)`,
    one POST per clip and page). An open Hook card on every load would make one request per
    editor open.
  - **Mitigation:** Caption is open on load. Hook suggestions start only when the Hook card
    opens, which is today's cost of opening the Teks tab. The clients are kept per clip, so a
    view switch never asks again. The privacy line shows in the card as in the panel (AC17). A
    test asserts that no `/ai` request is made on load in Cepat.
- **R2. New words share a neighbour's timing.**
  - **Risk:** a typed new word lights up together with its host in Karaoke and Bold. A truly
    separate word needs new word timings, which the model does not have. Retyping a hidden word
    is not affected: it unhides the original.
  - **Mitigation:** the help line, and PANDUAN explains it.
- **R3. Rows regroup after an edit, in every pack.**
  - **Risk:** focus could jump, and the row count changes under the viewer.
  - **Mitigation:** the focus rule of §2.5 and its e2e in Karaoke and Box.
- **R4. The hook hint is approximate.**
  - **Risk:** it can show when nothing overlaps, or stay quiet for an unusual hook size.
  - **Mitigation:** the copy is conditional, and the preview is exact. An exact check is §11 Q6.
- **R5. Spec churn.**
  - **Risk:** flipping the default would break every editor spec.
  - **Mitigation:** Z0's `?mode=lengkap` constants and the per-owner helpers (§9.5) keep the
    specs green, and A flips the default last.
- **R6. Two homes for some controls** (hook text, pack, transition).
  - **Risk:** the two views drift apart.
  - **Mitigation:** one model function per control, shared components (`TransitionSection`,
    the suggestions hook), and the AC5 tests on commands and texts.
- **R7. The shortcut filter changes Lengkap too.**
  - **Risk:** keys that did nothing on a focused radio or checkbox now act (Ctrl+Z, ', ?, K, I,
    O), as they already do on a focused button.
  - **Mitigation:** Space and arrows stay with the control; the unit tests cover each input type;
    every panel e2e stays green.

### Open questions for the owner (the build can start with the proposed answer)

**Answered 2026-10-02:** the owner accepted every proposed answer below as written. Q1 to Q5 are
built as proposed; Q6 and Q7 are later, separate tasks and are not part of this build.

1. **"Kembali ke versi AI" and "Pintasan keyboard" move into the ⋯ Lainnya menu.** They are not
   on the mockup's top bar. U7 and the start of every U-test then take one more click. Proposed:
   yes.
2. **Cold open card wording.** Proposed: T3's section verbatim in both views (heading "Transisi",
   legend "Efek gambar", "Potong langsung / Kilat putih / Gelap sebentar", "Suara whoosh", "Putar
   transisi"). The mockup has "Sambungan ke klip", "Potong", "Whoosh" and "Putar sambungan";
   taking them would change T3's panel and its e2e too.
3. **Caption position presets**: Atas 38 %, Tengah 60 %, Bawah 83 % (the bottom edge of the
   caption; Bawah = today's spot near the TikTok buttons, K5). Proposed: yes. The fine slider
   stays in Lengkap.
4. **New words ride on the neighbour word's timing (R2).** Proposed: accept for now.
5. **U5's stop condition in Cepat.** It stays "lajur Musik di timeline menunjukkan garis volume
   yang turun", so the tester switches to Lengkap to check it. The alternative is "the card shows
   the music with the chosen strength". Proposed: keep it as it is.
6. **An exact caption-vs-hook check**: an engine warning from libass geometry with a pixel gate,
   as a separate task. Proposed: not now; the hint and the exact preview cover it.
7. **Single-key shortcuts** (K, I, O, ', ?) cannot be turned off today (WCAG 2.1.4). This build
   adds none. Proposed: a later, separate task adds an off switch in the shortcut help dialog.

## 12. Review notes (2026-10-02)

The first draft (`6edfd83`) was reviewed in 23 points. Each was checked against the code.

| # | Point | Outcome |
|---|---|---|
| 1 | Duplicate row keys for a cold-open line and its twin | Fixed: key `seg:firstWordId` from the plan pieces; focus rule per segment (§2.1, §2.5) |
| 2 | Rows regroup in every pack; AC6 false; fakes model only Box | Fixed: §2.1 and §2.5 say any pack; AC6 restated on pieces and word starts; fakes break on sentence ends and skip hidden words (§2.6) |
| 3 | Delete-then-retype corrupts timing; just-hidden words reappear | Fixed: `hiddenIds` and unhide in the diff (§2.3); rows drop hidden words before the plan (§2.1) |
| 4 | Cepat drops the privacy notice and the error states | Fixed: `CompactSuggestions` keeps every state and the privacy line (§1.4, AC17) |
| 5 | Face analysis and music upload lost on card close or view switch; closed bodies unspecified | Fixed: per-clip stores (§4.1, AC16); bodies stay mounted and closed ones are `inert` (§1.3) |
| 6 | Native radio and checkbox pills turn global shortcuts off | Fixed: the shortcut filter (§4.5, AC4); the switch keeps focus. Partly rejected: Space on a focused pill stays with the pill, as on buttons today; K plays from there |
| 7 | "Frame akhir" unreachable in the legacy state; status not announced; legacy help text cut | Fixed: Frame akhir is a visible stage toggle; the badge keeps its live region; the legacy help is today's text, unchanged (§5.2) |
| 8 | PF-OPEN cannot run in CI; the redefinition drops the transcript gate | Fixed: Z0's `gates` input; PF-OPEN runs per view and keeps `[data-panel="transcript"]` for Lengkap (AC15) |
| 9 | The clash rule cannot match libass at 0 mismatches; R4 scope; the exact-set test | Fixed by removal: the engine warning and G-CLASH are gone; a client hint replaces them (§3); the exact check is §11 Q6 |
| 10 | Hiding "Perlu dicek" at 0 breaks notes, focus and other tasks' specs | Fixed: always rendered (§5.1) |
| 11 | Parallel branches cannot go green alone; Menu named twice | Fixed: Z0 ships every `ui/*` stub and a working `linesSummary`; the hint needs no other task; one name, `ui/MenuButton.jsx` (§10) |
| 12 | Z0 resizes the top bar | Fixed: Z0 adds only new tokens; A changes `--ed-topbar-height` (§8.1) |
| 13 | U5 stop condition weakened; U1 start cue stale | Fixed: U5 unchanged and a question to the owner (Q5); U1's cue names the badge's new place (§9.6) |
| 14 | Scope beyond the mockup | Partly fixed: the engine warning is gone; the Logo & Musik card drops the corners and "Ganti". Rejected in part: the stage status stays, because it is today's badge moved, not a new feature, and the owner's brief removes only the two legacy texts; the duck pills and "Hapus" stay because U5 asks for the strength and a card that can only add is a dead end |
| 15 | Lime facts wrong; AC12 ambiguous | Fixed: facts per selector, the hover rules, a computed-style sweep (§8.1, AC12) |
| 16 | Focus ring lost in forced colours | Fixed: the outline stays (§8.4, AC13) |
| 17 | Selection store misnamed | Fixed: `selectionStoreFor(clipId)`; A also points I and O at it (§4.1) |
| 18 | Scrubber: Space when focused, AC8 vs merging, no unavailable note | Fixed (§7, AC8) |
| 19 | Views differ: highlight, merge keys, legend, the K5 note's "tab Teks" | Fixed: shared caption model and notes, merge key by input kind, `TransitionSection`, new `CAPTION_SPOT_NOTE` (§1.4, §5.3, AC5) |
| 20 | Bold rows disagree with the preview; retyping makes upper-case edits | Fixed: uppercase display and the case-insensitive match under `upper` (§2.1, §2.3) |
| 21 | Layout math assumes a 768 px viewport | Fixed: 1366×650 numbers, rail rows 44–64 px, scrolling rules, new spec viewports (§1.1, §6.1, AC9) |
| 22 | Deep links lost across login | Fixed by scope: §4.4 states the limit and AC3 covers logged-in viewers. Rejected: changing `page.jsx`, because `web/app/**` stays out of this build and deep links are made inside the editor |
| 23 | "Pisahkan di baris lain" cannot be followed; M is another single-key shortcut | Fixed: a followable message (§2.4); M dropped (§4.5). The existing single-key shortcuts are out of scope: §11 Q7 |

## 13. Decisions during build (Z0)

Z0 built the scaffold of §10 step 1 on `mode-cepat-base`. Where the spec was silent:

1. **Seeded test files.** Z0 starts three files that belong to other tasks, with only the checks
   that already hold at the base; each owner extends or replaces its file, as C does with
   `caption-lines.mjs`:
   - `web/tests/editor-caption-lines.test.mjs` (C): `captionRows` and `linesSummary`;
   - `web/tests/editor-ui-kit.test.mjs` (B): the icon names, the menu keys, the accordion ids, and
     the kit's CSS rules of §9.2 (duration tokens only, no lime, 44 px);
   - `web/e2e/editor-views.spec.mjs` (A): the default URL is today's Lengkap; `?mode=cepat`
     mounts the cards (Caption open, one at a time, closed bodies inert), the scrubber seeks, a
     card's way to Lengkap keeps the canvas and the undo history; axe on the Cepat scaffold.
     A replaces the default-URL check when it flips the default.

   Z0's own structural test is `web/tests/editor-mode-cepat-scaffold.test.mjs` (Z). It checks
   only the shapes of §10, so A to D never need to edit it.
2. **Testable kit.** The icon paths live in `ui/icon-paths.mjs` and the menu and accordion rules
   in `ui/kit-model.mjs` (`menuMove`, `menuItemRole`, `accordionIds`), so node tests read them;
   `Icon` also takes an optional `className`. `more` (three dots) and `help` (a circled ?) are
   not in the mockup and are drawn in its style.
3. **Kit details.** A closed accordion body hides with `visibility var(--dur-2)` in the same
   transition as its rows (visibility is discrete, so no literal `0s` is needed); the 56 px header
   is `calc(var(--ed-target) + 12px)`. Legends inside cards are 13/400 `--text-muted`, as in the
   mockup and the "Help, notes, legends" row of §8.3. A `MenuButton` item that is unavailable
   shows its reason under its label as well as in its description; a checked
   `menuitemcheckbox` shows ✓ before its label.
4. **Card registry.** Entries also carry `component` (as `PANELS` do) and `panel`, the Lengkap
   panel that does the same work. Each placeholder body says "Kartu ini belum tersedia di Mode
   Cepat." with "Atur di Mode Lengkap", which calls `showLengkap(panel)`. In Z0,
   `showLengkap` switches the view in place (no URL change); A adds `urlWithView` and the
   preference. QuickPanel summarises only Teks caption; B moves every summary to
   `quick/quick-model.mjs`.
5. **Line model.** `captionRows` without `model` gives empty `hiddenIds`: only the transcript
   model knows which hidden words the cuts keep. `linesSummary` takes the same
   `{ plan, doc, words }` and says "Caption mati" whenever captions are off, even before a plan.
   `focusAfterRegroup` throws "not built" too, so the whole API of §2 is importable.
6. **The Cepat frame** for `?mode=cepat` is in `shell.module.css`, scoped to
   `.shell[data-editor-view="cepat"]` (`.quickSide`, `.quickBottom`); the root carries
   `data-editor-view`. The stage keeps its element, so a switch never remounts the canvas.
   StageControls stay in the stage region in both views until A moves them. A replaces all of
   this with the named areas of §1.1. The scrubber is a native range input, so while it has focus
   today's `isEditableTarget` turns the global shortcuts off; A's filter (§4.5) fixes that.
7. **e2e helpers.** Only actions moved into the helpers; checks on a control's state stay in the
   owner's spec. `openChecks(page, count?)` returns the button (focus comes back to it);
   `safeZone(page)` returns the toggle, to click or to check `aria-pressed`; `switchView`
   reloads with `?mode=` until A's switch exists; `wordAction` matches today's chip names as the
   specs did.
8. **URL constants.** Every `EDITOR` and `editorUrl` constant of `e2e/editor-*.spec.mjs`
   (the real-stack flow and acceptance specs included) and the logo spec's real-stack capture URL
   end in `?mode=lengkap`. The `klip-<n>` prepare URLs are unchanged: A makes the prepare flow
   keep the query (§4.4).
9. **For A:** the logo harness (`gizmos/__dev__/logo-harness-entry.jsx`) mounts `EditorApp` at a
   URL without a query and passes `initialPanel`. When the default flips, an `initialPanel` prop
   should resolve as `?panel=` does (Lengkap), or `editor-logo.spec.mjs` lands in Cepat.

## Decisions during build (D)

D built the rail, the word toolbar and the scrubber on `mode-cepat-d-lengkap`. Where the spec was
silent or the base differed:

1. **The rail before A's grid.** Z0 mounts `Rail` as the first child of the panels aside, which
   stacks its children. One rule in `rail/rail.module.css`, `[data-slot="panels"]:has(> .rail)`,
   lays that aside out as a row, so the rail sits beside the panel on D's branch alone. It stops
   matching once A gives the rail its own grid area (§1.1), and any rule of A's on the aside wins
   over it. Until then the panel is 84 px narrower. The `.tabs` and `.tab` rules of
   `shell.module.css` are no longer used (A's file).
2. **Rail keys and look.** ↑/↓ move and select as §6.1 says; ←/→ still do, as the text tabs did
   (Z0's views spec checks them), and a key with a modifier is left to the editor. The rail is on
   `--bg` with a `--border` edge (the mockup); under forced colours the selected tab's label is
   underlined, since its surface is dropped there.
3. **Toolbar surface.** The toolbar is the menus' popover surface (`--surface-2`, a
   `--border-strong` edge, the popover shadow, because it floats over the words it acts on). The
   mockup's light toolbar would leave §8.1's inverted primary (`--text` fill, `--bg` text)
   indistinguishable from it, so the spec's colours win. "Kata kunci" pressed is `--bg` with a
   `--text-muted` inset ring.
4. **Unavailable actions** stay focusable: `aria-disabled`, the reason as the description and in
   the `title` with the shortcut. A click on one shows its reason in the panel's message line, as
   the chips' reason did. `toBeDisabled()` in the specs reads `aria-disabled`.
5. **Flip rule.** The toolbar flips below when the room above the first line is under
   `max(56, its own height + 8)`. A narrow panel wraps it onto two rows; 56 px is the one-row case
   of §6.2. The first line's box is the word span's box grown to the list's line-height. The room
   is measured from the visible top: the scroll container's top or the sticky header's bottom,
   whichever is lower.
6. **The menu** opens toward the side of the panel with more room (`menuAlign`): a 240 px menu
   opened leftward from a button near the panel's left edge would be clipped by the scroll
   container. The "▾" of "Lainnya ▾" is drawn in CSS, so the button's name stays "Lainnya".
7. **Keys on the toolbar.** I, O and the selection's modifier shortcuts (Ctrl+E, Ctrl+Shift+X,
   Ctrl+Shift+H) act on the selection from the toolbar; Delete and Enter stay the words list's
   (Enter presses the focused button). After an action from the toolbar or its menu, focus goes
   back to the words, as after a chip; "Edit kata" focuses the word editor. A Tab pressed right
   after a click places the toolbar at once instead of waiting for the next frame; when no
   selected word is on screen, Tab moves on as usual.
8. **The header** keeps a visible "TRANSKRIP" label (`aria-hidden`: the shell's `h2` names the
   panel) and "Rapikan · n" (44 px tall) on one row, the status line under them.
9. **The scrubber's control** is a native range input laid transparent over the drawing. Its
   role, `aria-valuenow`, `min`/`max` and the screen reader's own adjustments stay the browser's,
   and Z0's views spec (`fill`) keeps working. The scrubber takes the pointer (snapping) and its
   §7 keys itself; the track draws the focus ring (`:has(.input:focus-visible)`). The drawn
   playhead moves on every frame; while playing, the value and `aria-valuetext` move at most
   every 250 ms, with a trailing update.
10. **Play or pause from the scrubber** asks the player's `state().playing`; a player that does
    not report it (the fakes' `createFakePlayer`) is followed by the scrubber's own Space and K.
11. **Scrubber labels and stops.** One mark shows the marker lane's text and time ("Jeda 0,8 dtk ·
    00:12,3"); a merged dot names its kinds with counts ("Tawa (2), Jeda · 00:12,3"); the join
    reads "Transisi: Kilat putih + whoosh · 00:03,6". A key that lands on a mark shows the same
    label. Merging anchors to a group's first mark, so every merged mark is under 6 px from the
    drawn dot; the join diamond never merges. PageUp/PageDown stop at every mark, the cold-open
    edges (0 and J) and the join; with no stop that way they stay. A press snaps to the marks and
    the join, not to the cold-open edges. A hidden description gives screen readers the keys:
    "PageUp dan PageDown pindah ke penanda; Spasi atau K memutar."
12. **Specs.** `editor-scrubber.spec.mjs` runs the real Scrubber in a harness page over the marker
    fixtures (`scrubber/__dev__/scrubber-harness-entry.jsx`) and in the editor at `?mode=cepat`.
    `editor-lengkap.spec.mjs` runs in the editor on its fakes, whose store records commands
    without applying the transcript ones, so its checks read the commands sent; the transcript
    harness spec replays the real ones. The fakes' clip is about 5 s, so scripted U2 cuts its 2 s
    second sentence there; U2's 5 s ramble stays in the transcript harness spec.
13. **For A:** the shortcut help dialog (EditorApp) should list the scrubber's keys (§4.5). Until
    A's shortcut filter lands, a focused scrubber turns the other global shortcuts off, as Z0
    noted; the scrubber's own keys work either way.
