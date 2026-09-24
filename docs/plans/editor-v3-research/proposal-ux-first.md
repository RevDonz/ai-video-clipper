# Potongin Studio: UX-first architecture proposal for the clip editor

Date: 2026-09-24. Branch context: `feat/selection-v3-llm`. Status: proposal for review. The repo
was only read; nothing in it was changed.

Inputs: the three research reports in this folder (`r1-existing-editor.md`,
`r2-feature-inventory.md`, `r3-tech.md`) and new measurements taken for this proposal. The new
measurements are in `editor-design/ux/` and summarized in Appendix A. Evidence tags used below:

| Tag | Meaning |
|---|---|
| `[R1]` `[R2]` `[R3]` | Finding from that research report (measured there unless stated) |
| `[UX-M1..M6]` | Measured for this proposal (Appendix A) |
| `[LC-bin]` | LokaClip binary strings (`lokaclip/strings.txt`) |
| `[REPO]` | Current Potongin code |

Method: this proposal starts from what an Indonesian clipper does with a clip, sets a time and
latency budget for each of those interactions, and only then derives the data model, the preview
engine, the FFmpeg compiler, the API and the delivery plan. Where the research reports already
decided a technical question (for example R3's "one document, two compilers"), this proposal
adopts the decision and says which interaction depends on it.

---

## 0. Summary

**The product.** A web editor, "Potongin Studio", that opens any Selection V3 clip. It has two
densities of the same editor:

- **Mode Cepat** (fast mode) follows the LokaClip interaction model: transcript on the left,
  9:16 preview in the centre, inspector on the right, and five fixed lanes at the bottom.
- **Mode Pro** follows CapCut: a multi-track timeline with track headers, keyframe lanes,
  transitions and effects.

Both modes edit one document. Switching mode never converts or loses anything.

**The interaction spine is the transcript, not the timeline.** Clippers fix a boundary, tighten
the talk, fix misheard words and pick a hook, and all four are text actions. Seven decisions
follow from that:

1. **Everything tied to speech is stored in source time and anchored to word IDs.** This covers
   cuts, captions, cold open, keyword marks, word-anchored stickers and camera keyframes. Output
   time is always derived through a shared, frame-quantized **time map**. This is why deleting a
   sentence never breaks captions, stickers or the hook.
2. **Deletions are records, not destruction.** A removal is a source span scoped to one segment,
   with a reason. The transcript shows it as a restorable chip ("⋯ 2,4 dtk"). Jump cuts,
   filler/gap tightening and AI "Padatkan" all produce removals.
3. **Captions are derived, never frozen.** Words plus overrides (display text, hidden, emphasis,
   emoji, forced breaks) plus a versioned style pack are compiled into ASS on both sides. This
   replaces V2's immutable cue bindings `[R1 D6]`.
4. **The seed is the auto render.** Stage 0 routes the V3 auto render itself through the new
   compiler (`seed → compile → render`). The seed is revision 0, a virtual document; revision 1
   is the first save. An unedited clip therefore re-renders bit-identically, by construction.
5. **What you see is what you export** (R3's option (e), adopted):
   - live preview: a WebGL2 compositor over a short-GOP proxy decoded with WebCodecs, WebAudio as
     the clock, and **JASSUB (libass in WASM) drawing the same ASS bytes** the server burns in;
   - paused: a server-rendered exact frame of the current (even unsaved) document;
   - UI ops are exposed only once their golden parity tests pass.
6. **AI proposes, the user decides, nothing blocks.**
   - A deterministic suggestion appears within 300 ms.
   - LLM suggestions from the free-first `llm.py` chain arrive as "ghost" items within about 3–15
     s (measured `[UX-M6]`).
   - Accepting a suggestion is one undoable command.
7. **No silent downgrade.** A missing face, font, emoji image or asset is shown before export
   with an Indonesian message. Nothing falls back quietly.

**Measured facts that shaped the design** (new, Appendix A):

| # | Finding | Design consequence |
|---|---|---|
| UX-M1 | On 48 gold moments (median 69 s, 160 words), **transcript fillers are almost absent**: Whisper has about 1 per 1,000 words and YouTube captions 7–12 per 1,000 (about 2 per median clip). | Filler removal from transcript tokens alone would do almost nothing. Tightening must be audio-aware. |
| UX-M2 | Of the 414 word gaps over 600 ms, **only 22% are silent**. 66% contain voiced audio (untranscribed "eee", crosstalk, breath) and 12% contain laughter. Descript-style "shorten all gaps" would save a median 6.5 s (11%) with 8 cuts, but cut real audio in 78% of cases. Restricted to silence and away from laughter, it saves 1.2 s (1.9%) with 2 cuts. | "Rapikan" becomes a **review list** with classes (silent gaps pre-checked; voiced gaps and laughter unchecked, with audition). The real time savings come from **sentence deletion** and the AI "Padatkan ke N detik" suggestion. |
| UX-M3 | A 21-range jump-cut clip (88 s → 67.8 s) at 1080×1920 renders in **22.2–22.7 s in the production image on 4 CPUs (3.0× realtime)**. Per-range inputs, split/trim and select/aselect cost the same, but select/aselect drifts A/V by 53 ms and cannot fade. Unquantized ranges add 77 ms of frame rounding. | Keep per-range inputs with 8 ms micro-fades. Quantize every kept range to whole output frames in the time map. The number of jump cuts does not drive render cost; resolution and encode do. |
| UX-M4 | JASSUB at 1080×1920 with 520 per-word events: scrub render **p50 14.4 ms, p95 29 ms**. Replacing the whole track after an edit and re-rendering: **p50 14.4 ms, p95 23.9 ms**. | Caption typing can update the preview in under 50 ms with a full ASS rebuild, so no incremental event patching is needed. |
| UX-M5 | Ducking as an explicit gain envelope: FFmpeg 5.1.9 `amultiply` equals the reference math bit-exactly. Chrome 147 WebAudio `linearRampToValueAtTime` matches FFmpeg within **3.0e-7 (−153 dB)**. | Music ducking has exact preview parity. `sidechaincompress` is not used. |
| UX-M6 | Free LLM (ollama-cloud `gpt-oss:120b`, from the job's LLM cache): 4–5k-token prompts take **3.3–14.7 s**, 27k-token prompts take 19–28 s, and reasoning output uses 1.0–7.8k tokens. | Editor AI tasks use short prompts (at most 3k tokens) and are async with a heuristic first. |

**Delivery** (details in §8), each stage behind feature flags, each with hard gates:

| Stage | Name | Contents |
|---|---|---|
| 0 | Satu mesin (one engine) | New document, compiler, fonts, JS ASS port, proxies. The auto render moves onto the new engine. No new UI. |
| 1A | Poles cepat (fast polish) | Editor shell, preview engine, transcript editing, trim, cold open, captions and 8 packs, 9 hook designs, AI hooks, undo and history, export. |
| 1B | Dandani (dress up) | Text, sticker, emoji, logo and credit; layouts (face-track editing, split, branded frame); B-roll; music with ducking; templates and batch. |
| 2 | Mode Pro | The CapCut core. |
| 3 | COULD features | Later. |

---

## 1. The interaction model

### 1.1 Who, where, and the north-star metric

- **User.** An Indonesian clipper, solo or in a small agency, who posts 10–30 clips per episode to
  TikTok, Reels and Shorts. They have CapCut muscle memory (Ctrl+B, Q/W, J/K/L), and many have
  used LokaClip. The UI is in Bahasa Indonesia with informal wording ("Rapikan", "Padatkan",
  "Jadikan cold open").
- **Reference device.** Define it and test on it:
  - a 4-core laptop (Core i5-1135G7 or Ryzen 5 5500U class), 8 GB RAM, integrated GPU;
  - Chrome or Edge stable;
  - a **1366×768** screen (still common) and a 1920×1080 screen;
  - 20 Mbps down.

  Phones get review and export only (§10).
- **North star.** The median **time from opening an AI clip to "siap ekspor"** is:
  - **≤ 3 min** for the standard polish task T-POLISH (§8.6);
  - **≤ 30 s** for "terima hasil AI + terapkan template" (accept the AI result and apply a
    template).

  A clip is ready to export only when it passes every quality gate. Speed never excuses a worse
  result.
- **What "polish" means, measured on the 48 gold moments `[UX-M1]`.** A clip has:
  - a median length of 69 s (p90 88 s);
  - a median of 160 words (p90 223);
  - a median of 14 protected particles (sih, dong, kok, …) that must never be auto-removed;
  - a median of 5 voiced gaps of 0.6 s or more;
  - a median of 3 immediate word repeats (max 9), offered as suggestions only.

### 1.2 UX principles and their architectural consequences

| # | Principle | Consequence (section) |
|---|---|---|
| U1 | **Ucapan adalah tulang punggung** (speech is the spine). The transcript is the main navigation and editing surface. | Source-time model with word IDs; derived time map (§2.2) |
| U2 | **Semua bisa dipulihkan** (everything is restorable). Deleting hides; nothing is destroyed. Undo covers every action. | Removals as records; command and patch history; the document stays small because words live outside it (§2.3, §2.9) |
| U3 | **Yang dilihat = yang diekspor** (what you see is what you export) | One document, two compilers; JASSUB; truth frames; op gating (§4) |
| U4 | **AI menyarankan, kamu memutuskan** (AI suggests, you decide) | Suggestions store, ghost items, heuristic first, async LLM (§7) |
| U5 | **Cepat dulu, dalam kalau perlu** (fast first, deep when needed) | Two UI densities over one schema (§1.3) |
| U6 | **Tidak ada penurunan diam-diam** (no silent downgrade) | Validation with blocking warnings before export (§2.10, QG-11) |
| U7 | **Pikirkan batch** (think in batches) | Versioned style, design and template references; "apply to all clips" (§2.8) |
| U8 | **Keyboard dulu** (keyboard first) | Custom selection model instead of contenteditable; CapCut-compatible shortcuts (§1.5) |

### 1.3 Screen anatomy

Mode Cepat at 1920×1080. At 1366×768 the side panels shrink to 300/280 px and the preview is
304×540.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Proyek │ ◀ Klip 3/12 ▶  "Iqbaal menyamar jadi Ijal…"  │ Tersimpan • 2 dtk │ ↶ ↷ │ Cepat|Pro │ Ekspor ▸ │
├────────────────────┬──────────────────────────────────────┬─────────────────────────────────┤
│ [Transkrip][Hook]  │                                      │ Inspector (context-sensitive):  │
│ [Subtitle][Media]  │        ┌──────────────┐              │  • selected word/cue/item props │
│ [Audio][Template]  │        │   9:16 stage  │ Exact ●     │  • or panel-specific controls   │
│                    │        │  (canvases)   │              │  • warnings "Perlu dicek (2)"  │
│  Transcript panel  │        │  safe zones ' │              │                                 │
│  (§1.4.3)          │        └──────────────┘              │                                 │
│                    │  ◀◀ ▶ ▶▶  00:12.07 / 00:58.20  1080p │                                 │
├────────────────────┴──────────────────────────────────────┴─────────────────────────────────┤
│ Video   [CO|  Body ░cut░      ░cut░                 ]  ← word-snapped handles, filmstrip   │
│ Hook    [Hook 0–4 dtk ]                                                                    │
│ Subtitle[c][c][c][c][c][c][c][c][c][c][c][c][c]                                           │
│ Overlay     [😂]   [logo ──────────────────────────────]  [B-roll]                          │
│ Audio   ∿∿∿∿∿😂∿∿∿⏸∿∿∿∿∿∿∿∿  Musik [──── duck ▁▁▔▔▁▁ ────]                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Mode Pro changes only the bottom panel:
- the panel grows through a splitter;
- tracks get headers (lock, hide, mute, and height);
- tracks can be added;
- items can move between tracks of the same kind;
- keyframe diamonds, transition handles at joins, and an effects lane appear.

The left tabs collapse to icons.

### 1.4 Core flows and their interaction specs

Every action below is a **command** (§2.9). The command's name is given as `Cmd:`.

#### 1.4.1 F1: open a clip

- **Entry.** The project page (V3 clip card), or the clip switcher in the top bar (Ctrl+[ and
  Ctrl+] move to the previous and next clip).
- **Card badge:** "Hasil AI" (AI result), "Diedit • rev 7" (edited, revision 7), "Diedit • belum
  dirender" (edited, not yet rendered) or "Render usang" (stale render: the engine or document
  changed).
- **Open sequence.** Steps a–d happen in parallel. The budget is interactive in ≤ 1.5 s p95 on a
  repeat visit and ≤ 3 s on the first visit.
  - a. `GET …/edit`. This returns the document, or the **seed** (revision 0) when the clip was
    never edited.
  - b. `GET …/words` (about 6 KB gzipped).
  - c. The proxy's `moov` box and first GOP, plus JASSUB and the fonts the document uses. These
    are content-hashed and cached as immutable.
  - d. The waveform peaks and filmstrip for the window.
- **If the window proxy is not built yet** (the job predates Stage 0, or its build failed):
  - the stage plays the auto-rendered `clip-NN.mp4` in a plain `<video>`, which is exactly
    the seed, with the banner "Menyiapkan pratinjau edit… (±8 dtk)" ("preparing the edit
    preview");
  - the transcript is already editable, and edits queue up;
  - once the proxy is ready, the live engine takes over.

  The user is never blocked.

#### 1.4.2 F2: fix the boundaries (word-snapped trim)

- **In the timeline**, drag the body's in or out handle. The handle **snaps to word edges**; the
  algorithm is in §2.11. Controls:
  - Alt turns snapping off;
  - `,` and `.` nudge by one word;
  - Shift+`,` and Shift+`.` nudge by one frame;
  - the tooltip shows the edge word ("…gitu loh |") and the new duration.
- **In the transcript**, use Alt+[ ("Mulai di sini", start here) and Alt+] ("Akhiri di sini", end
  here) on the word under the caret. The ±60 s context before and after is shown greyed and can be
  expanded.
- **Laughter help.** When a laughter event starts within 1.5 s after the out point, a chip "Sampai
  tawa selesai (+1,8 dtk)" (until the laughter ends) appears on the handle and in the inspector.
- `Cmd: SetSegmentBounds{segment, src_in_ms?, src_out_ms?}`.
- **Accept:**
  - the handle drag runs at 60 fps, and preview seeks are throttled to 10 Hz (the existing
    `TIMELINE_SCRUB_INTERVAL_MS=100` `[REPO]`);
  - a snapped boundary never falls inside a word;
  - the duration shown equals the exported duration to the frame.

#### 1.4.3 F3: tighten the talk (the transcript panel)

The transcript panel is a custom-rendered word list with its own selection model. **It is not
contenteditable**: there are about 1,000 spans with custom semantics, and contenteditable breaks
IME, undo and selection in exactly this case.

```
 ┌ Cold open (4,5 dtk) ───────────────────────────────── [Ganti] [Hapus] ┐
 │  "gue ditahan security di lokasi syuting gue sendiri"                  │
 └────────────────────────────────────────────────────────────────────────┘
 ⋮ 60 dtk sebelumnya (tampilkan)
 [Mulai] Terus lu pernah nyamar gitu? · Pernah. ⏸1,2 · Jadi waktu itu gue
 ⋯ 2,4 dtk ⋯  pake baju  ̲ ̲i̲j̲a̲l̲  ✎ terus masuk ke set 😂 tawa 1,8 dtk · security-nya
 ngeliat gue, "mas mau kemana?" ~~eh~~ gue bilang gue Iqbaal … [Akhir]
```

Legend:
- `⋯ n dtk ⋯` is a removed span; click it to expand and "Pulihkan" (restore);
- `✎` marks an edited word (hover shows the ASR original);
- a dotted underline marks a word hidden from captions;
- **bold** marks keyword emphasis;
- a wavy underline marks a low-confidence word (p < 0.5);
- inline pills mark laughter 😂, silence ⏸ and camera cuts │.

| Action | Input | Command |
|---|---|---|
| Seek to a word | click | UI only |
| Select | drag, Shift+click, double-click (word), triple-click (sentence unit from `words.units`) | UI only |
| Delete from video and audio | Delete / Backspace | `AddRemoval{segment, src_in_ms, src_out_ms, reason:"user"}` (cut points placed by §2.11) |
| Restore | click the chip → Pulihkan, or Ctrl+Z | `RemoveRemoval{id}` |
| Hide from captions only ("Sembunyikan di subtitle", KlipAja-style) | Ctrl+Shift+X | `SetWordFlags{words, hidden:true}` |
| Correct a word | double-click → inline input; Enter commits, Tab goes to the next word, Esc cancels | `EditWordText{word, text}` |
| Mark a keyword | Ctrl+E | `SetWordFlags{emphasis}` |
| Add an emoji after a word | `:` then search, or the context menu | `SetWordFlags{emoji_after}` |
| Force a caption break | Enter with the caret between words (not editing) | `SetCueBreak{before_word, kind:"cue"\|"line"\|"none"}` |
| Make the selection the cold open | Ctrl+Shift+H | `SetColdOpen{src_in_ms, src_out_ms}` |
| Find and replace | Ctrl+H; scope "klip ini" or "semua klip proyek" (this clip / all clips) | `FindReplace` (one transaction per clip) |

**"Rapikan" review panel** (tidy up; opened from the transcript toolbar). It is a review list,
not a blind button, because 78% of long word gaps are not silent `[UX-M2]`.

| Class | Detection | Default | UI |
|---|---|---|---|
| Jeda hening (silent pause) | word gap ∩ `audio_timeline.silences`, span > X ms (slider, default 600) shortened to Y ms (default 200), not within 0.5 s of laughter | checked | row: "⏸ 1,4 → 0,2 dtk", audition ▶ (plays ±1 s with the cut applied) |
| Suara tanpa teks (sound without text) | word gap > 600 ms whose audio is not silent (voiced) | **unchecked** | row: "🔊 0,9 dtk (mungkin 'eee' / nafas)" ("maybe 'eee' or breath"), audition before and after |
| Tawa (laughter) | a gap overlapping a laughter event | **locked off**; unlock per row | row: "😂 1,8 dtk (dilindungi)" (protected) |
| Kata pengisi di transkrip (filler words in the transcript) | tokens `eh, em, emm, ehm, hmm, hm, mm, uh, um, ee, eee`; `ah` and `anu` only when isolated (gap ≥ 150 ms on both sides) | checked | row with the word |
| Kata diulang (repeated word) | immediate repeats, not protected particles, not numbers | unchecked | "oke oke oke → oke" |
| Protected particles | `sih, dong, kok, lho, loh, deh, kan, ya, nih, tuh, gitu, kayak, yah, lah` | never listed | none |

The footer reads "Hemat 3,1 dtk • 5 potongan • [Terapkan]" (save 3.1 s, 5 cuts, apply). Applying
is one transaction producing `AddRemoval×n` with `reason` set to `gap_silent`, `gap_voiced`,
`filler` or `repeat`, so it is undone in one step.

**"Padatkan ke … dtk" (AI, §7.4)** (condense to N seconds): the user picks a target (for
example 45 s). The AI proposes whole sentences to drop and shows them as ghost strike-throughs.
Each can be accepted, and all can be accepted at once.

**Accept:**
- playback across every cut is seamless: no black frame, and no click above −40 dBFS (QG-08);
- restoring returns a bit-identical render (QG-01);
- protected particles are never pre-selected (unit test on the lexicon);
- the Rapikan list for a 90 s clip computes in ≤ 50 ms client-side.

#### 1.4.4 F4: the hook (cold open, on-screen hook text, design)

Hook tab:

```
 Cold open  [■ aktif]  4,5 dtk  "gue ditahan security di lokasi syuting…"  [Ganti ▾]
            Saran: ① (AI) "…" 5,1 dtk  ② (heuristik) "…" 3,8 dtk      Sambungan: [Potong|Flash|Whoosh]
            Tahan intro [□] 0,5 dtk
 Teks hook  [ Dia ditahan security di film-nya sendiri 😂        ]  43/60   [✨ Saran AI]
            Nada: (Santai)(Serius)(Lucu)(Clickbait halus)
            Saran: [Pertanyaan] [Klaim] [Penasaran] [Angka] [Kutipan] [Lucu]  ← ghost cards
 Desain     [Bar][Marker][Note][Gradient][Stiker][Punchline][Komik][Kartu kutipan][Banner]
            Label stiker: [LUCU ▾]   Tampil: (0–4 dtk) (Selama cold open) (Sepanjang klip)
```

- **Cold-open rules from V3** `[REPO render.py]`:
  - 0.5–8.0 s long;
  - `|cold_open.start − body.start| ≥ 0.01 s`;
  - inside the source.

  UI rules on top of those. The cold open normally repeats later inside the body, which is the
  point. But it must not be heard twice back to back:
  - blocking: at least 80% of the cold open's source span lies in
    `[body.start, body.start + len(cold open) + 2 s]`;
  - a warning appears at 50%.
- **Join styles:**
  - stage 1: hard cut, 3-frame white flash, whoosh (an SFX item placed at the join);
  - stage 2: "rewind".
- **Intro hold** freezes the first output frame for 0.3–2.0 s with silent audio, which is
  LokaClip's `tpad=start_mode=clone` + `adelay` `[LC-bin 15838]`.
- **Hook text limit** depends on the design (60 by default, 90 at most, the V3 limit). A live
  counter shows it, and the auto-fit result ("akan mengecil ke 3 baris", will shrink to 3 lines)
  shows before overflow. Emptying the text removes the hook.
- **Commands:**
  - `SetColdOpen`, `SetJoinStyle`, `SetIntroHold`;
  - `SetHookText`, `SetHookDesign{id, version}`, `SetHookParams`, `SetHookTiming{mode}`;
  - `ApplySuggestion{suggestion_id, choice}`.
- **Accept:**
  - the design gallery tiles render the **current hook text** through JASSUB, using the clip's
    own words;
  - switching design takes ≤ 150 ms;
  - every design passes QG-03 and QG-10 at 10, 40 and 90 characters, with and without emoji.

#### 1.4.5 F5: captions (style packs and editing)

- **Subtitle tab.** It shows a gallery of the 8 stage-1 packs `[R2 §7.1]`:

  | Pack | Look |
  |---|---|
  | Kuning Pop | yellow pop |
  | Kuning-Merah | yellow with a red keyword |
  | Kotak Hitam | black word box |
  | Stabilo Kuning | yellow highlighter |
  | Satu Kata | one word at a time |
  | Karaoke Sweep | colour sweep |
  | Santai Ketik | lowercase typewriter |
  | TikTok Box | native boxed caption |

  The tiles animate on hover and use the clip's words. The "Kustom" drawer exposes the pack
  fields `[R2 §7.2]`. There is also:
  - "Simpan sebagai gaya saya" (save as my style);
  - "Terapkan ke semua klip" (apply to all clips);
  - "Geser waktu" (shift timing, −300..+300 ms);
  - "AI tandai kata kunci" (AI marks keywords).
- **On the canvas**, click a caption to select that cue. The cue can be dragged vertically. It
  snaps to pack positions and to the safe-zone edge and shows the percentage of the frame height.
  Horizontal position is fixed in stage 1.
- **Editing happens in the transcript**, where the transcript is the caption editor. Casing is a
  pack property and never rewrites the text.
- **Commands:** `SetCaptionPack{id,version}`, `SetCaptionOverride{field, value}`,
  `SetCaptionOffset`, and `ApplyToAllClips{what}`. The last one runs as a server batch (§6.2).
- **Accept:**
  - packs pass QG-03;
  - the cap height at 1080×1920 is within ±3% of the pack specification;
  - active-word onset is within ±1 frame of `word.start + offset`;
  - non-active words move ≤ 1 px between frames (the jitter test `[R2 M7]`).

#### 1.4.6 F6 to F10: dress up (stage 1B)

| Flow | Interaction highlights | Commands |
|---|---|---|
| F6 Layout | A **Layout** lane you can split at the playhead, a picker with animated mini-previews, "Auto" (camera plan), speaker chips "Pembicara A/B" (force a speaker for the selection), double-click the stage for manual reframe (a 9:16 box over the source frame; dragging creates a keyframe at the playhead), split-screen seats, fit-blur or fit-black, branded frame | `SetLayoutDefault`, `AddLayoutRange`, `SetCameraKeyframe`, `ForceSpeaker` |
| F7 Text, sticker, emoji | Ctrl+T adds text at the playhead for 3 s. Emoji search takes Indonesian and English keywords. Label pills. Anything dropped **during speech anchors to the word under the playhead** by default, so it moves with that word; a toggle pins it to time instead. On-canvas drag, scale and rotate, with snapping guides to centre and safe area; arrows nudge 1 px, Shift+arrows 10 px. | `AddItem`, `UpdateItem`, `SetItemAnchor`, `DeleteItem` |
| F8 Logo and credit | The brand kit holds the logo, its position preset (4 corners) and its opacity (85% by default). The "Kredit sumber" toggle fills `Source YT : {channel}` from the source metadata. | `ApplyBrandKit`, `AddItem` |
| F9 B-roll | Drag media onto the B-roll lane. Modes: cutaway (keeps the audio), PiP, split top or bottom. Source in/out, fades, Ken Burns for stills. | `AddItem{type:"video"\|"image"}` |
| F10 Music and SFX | A library with licence badges, plus uploads with a Content ID warning. A2 lane; volume in dB; "Ducking otomatis" (on, 10 dB, attack 30 ms, release 400 ms); fades; loop; clip mute and volume; "Samakan loudness" (match loudness, on, −14 LUFS); an SFX pack (whoosh, pop, ding, boom). | `AddItem{type:"audio"}`, `SetDuck`, `SetGain` |

#### 1.4.7 F11 to F13: export, templates, history

- **Export dialog.** Options:
  - resolution: 1080×1920 (recommended) or the seed's job resolution;
  - fps 30;
  - quality: Standar is x264 veryfast crf 21, the current setting, measured at SSIM 0.995 against
    lossless `[R3]`; Tinggi is medium crf 18;
  - an SRT sidecar;
  - a cover frame (exports `cover.jpg` too);
  - the V3 title, description and hashtags with copy buttons, editable;
  - "Buat ulang judul setelah edit" (regenerate the title after editing, AI §7.7).

  Progress stages: Siapkan aset → Analisis audio → Render (percentage from `-progress`) → Cek
  kualitas → Selesai. There is a batch export queue for the selected clips.
- **Templates.** "Simpan sebagai template" captures the pack, hook design, layout default, brand
  kit items, music defaults and export preset. "Terapkan ke semua klip" shows a diff ("12 klip
  akan berubah; 2 punya ubahan manual → [Lewati|Timpa]", 12 clips will change; 2 have manual
  changes, skip or overwrite).
- **History ("Riwayat").**
  - autosaved revisions grouped by session;
  - named checkpoints (Ctrl+Shift+S);
  - "Kembali ke versi AI" (back to the AI version), which writes the seed's content as a new
    revision (a restore; `RevertToSeed`);
  - A/B compare of two revisions with a wipe on the stage.

### 1.5 Keyboard map

It is CapCut-compatible `[R2 §8]`, with three context rules:

1. Text-entry focus captures only editing keys.
2. **Transcript focus:**
   - Delete means remove words;
   - Ctrl+E means emphasis;
   - Enter means a cue break.
3. **Timeline focus:**
   - Delete means ripple-delete the selected range (it becomes a removal);
   - Ctrl+E is reserved for effects in stage 2;
   - Ctrl+B splits the segment.

The help overlay is `?`, and every tooltip shows its shortcut ("Potong (Ctrl+B)").

### 1.6 Interaction latency budgets

These are p95 on the reference device. They are CI gates (QG-13) and are measured with Playwright
traces.

| Interaction | Budget | Basis |
|---|---|---|
| Scrub → preview frame shown | ≤ 50 ms | proxy seek 3.7 ms p50 / 8.6 ms p90 `[R3]`; JASSUB render p95 29 ms at 1080×1920 `[UX-M4]` |
| Keystroke in a caption word → preview updated | ≤ 100 ms | JS ASS compile (target ≤ 15 ms for 260 words) + `setTrack` + render p95 23.9 ms `[UX-M4]` |
| Trim or item drag | 60 fps handle; preview seeks at 10 Hz | current editor's approach `[R1]` |
| Playback across a cut | 0 dropped frames at 30 fps; next range pre-decoded ≥ 500 ms ahead | `[R3 §5.3]` |
| Style pack or hook design switch | ≤ 150 ms | full ASS rebuild |
| Undo / redo | ≤ 16 ms | Immer patch undo 82 µs on a 600 KB document `[R3]` |
| Autosave after the last edit | ≤ 2 s (debounce 1.5 s); PUT ≤ 150 ms | CLI spawn 70–90 ms `[R1]` |
| Exact frame after a pause | ≤ 600 ms at 1080×1920 (debounce 250 ms) | 0.43 s per frame with ASS at 1080×1920 `[R2]`; 0.16–0.20 s at 720×1280 `[R3]` |
| AI heuristic suggestions | ≤ 300 ms | deterministic |
| AI LLM suggestions | ≤ 15 s p50, 45 s hard deadline (then show heuristic only, with a notice) | 3.3–14.7 s for 4–5k-token prompts `[UX-M6]` |
| Final render, 60 s clip at 1080×1920 (stage-1 document, production image, 4 CPUs) | ≤ 30 s (≤ 0.5× clip duration) | 22.2–22.7 s for 67.8 s with 21 cuts `[UX-M3]`; animated captions add 14% `[R2]`; the plate blur costs about the same as no blur `[R3]` |
| Editor open (repeat / first visit) | ≤ 1.5 s / ≤ 3 s | §1.4.1 |

---

## 2. From interactions to data: the edit document

### 2.1 What each interaction forces on the architecture

| Interaction (flow) | What would break with a naive timeline model | Decision |
|---|---|---|
| Delete a sentence, restore it later (F3) | A CapCut-style split-and-delete loses the deleted media reference, so captions and stickers after the cut shift wrongly | **Removals** are source spans scoped to a segment; output time is derived (§2.2) |
| Captions follow every cut and trim (F2, F3, F5) | V2's frozen cues cannot change after revision 1 `[R1 D6]` | Captions are **derived** from words plus overrides at compile time (§2.6) |
| An emoji "on the punchline" (F7) | An absolute-time sticker drifts when an earlier sentence is removed | **Word anchors** for items (`{"at":"word"}`), with explicit resolution rules (§2.11.4) |
| Manual reframe keyframes (F6) | Output-time keyframes point at the wrong face after a trim | Camera keyframes live in **source time** (§2.5) |
| The cold open reuses a line that also appears in the body (F4) | A removal in the body would also remove it from the cold open | Removals carry a `segment` scope |
| Caption typing is instant (F3, F5) | A server round trip per keystroke is 80–90 ms plus render | JS port of the ASS compiler with byte-identical vectors; JASSUB `setTrack` (§4.3) |
| Undo everything, autosave every 2 s (U2) | Inlining 160–400 words × fields makes every PUT large | Words live in an immutable, content-addressed **words artifact**. The document holds only edits keyed by word ID. |
| Apply a look to 12 clips (U7) | Copying style values into each clip means packs cannot be updated or kept stable | Documents reference `{id, version, sha256}` of packs, designs and templates (§2.8) |
| Revision 1 must look exactly like the AI clip (F1) | Two engines drift apart (there are two ASS builders today `[R1]`) | The auto render **is** the compiled seed (§3.2) |
| Music ducks under speech, and the preview matches (F10) | `sidechaincompress` cannot be reproduced in WebAudio `[R3]` | An explicit gain envelope, measured exact on both sides `[UX-M5]` (§5.4) |

### 2.2 Time model

Three time domains exist. Every field says which one it uses in its name:

| Domain | Unit | Field suffix | Used for |
|---|---|---|---|
| Source | integer milliseconds | `_ms` | words, segments, removals, camera keyframes, B-roll source in/out |
| Output | integer frames at `output.fps` | `_f` | overlay placement, durations, keyframes on items, transitions, intro hold |
| Anchor | a reference that resolves to output frames | `start`/`end` objects | items that follow speech |

`output.fps` is an integer in {24, 25, 30, 50, 60}. The default is 30, as in LokaClip `[LC-bin
15843]`. Output is always CFR.

**Time map.** The algorithm below is implemented twice: in `src/ai_clipper/edit_v2/timemap.py`
and in `web/lib/edit-v2/timemap.mjs`. Both are tested against the shared vectors in
`tests/fixtures/edit-v2/vectors/timemap/*.json` (at least 100 cases).

```
input:  segments[] (ordered; role cold_open|body|insert; src_in_ms, src_out_ms)
        removals[] (segment-scoped source spans), joins[] (between segments), intro_hold_f, fps
1. For each segment s: pieces(s) = [s.src_in_ms, s.src_out_ms] minus the union of removals whose
   segment == s.id. Drop pieces shorter than 2 output frames; their time joins the adjacent cut.
2. Quantize each piece p: n_p = round_half_up((p.out_ms - p.in_ms) * fps / 1000) frames.
   The piece renders EXACTLY n_p frames. Video frame k shows the source frame selected for
   t = p.in_ms/1000 + k/fps by FFmpeg's `fps=round=near` rule. The JS decoder replicates the
   rule, and golden tests on 23.976, 25 and 29.97 fps sources pin the tie cases. Audio is the source audio
   [p.in_ms/1000, p.in_ms/1000 + n_p/fps), so audio and video lengths are equal by
   construction. (Unquantized, 21 ranges measured +77 ms `[UX-M3]`.)
3. Lay the pieces out consecutively: out_start_f(p) = the sum of the preceding n. Joins between
   segments with a transition of d frames overlap the adjacent pieces by d: the later piece
   starts d frames earlier and the total shrinks by d. Jump cuts inside a segment never overlap.
4. Intro hold: prepend intro_hold_f frames (a freeze of output frame 0; silent audio).
output: pieces[] {id, seg_id, in_ms, n_f, out_start_f}, total_f
functions: src_to_out(seg_id, ms) -> f | REMOVED(cut_f); out_to_src(f) -> (piece, ms)
```

Rounding rule: Python `round()` rounds half to even, and JS `Math.round` rounds half up. Both
modules use an explicit `round_half_up(x) = floor(x + 0.5)` on integers or on values
pre-multiplied to integer milliseconds. This is the trap R3 warns about `[R3 §4]`.

### 2.3 The document: `potongin.edit/2.0`

Canonical JSON (sorted keys, no whitespace, NFC, no NaN), **≤ 1 MiB**, SHA-256 ETag. These
rules are inherited unchanged from `edit_manifest.py` `[R1 §3]`. Unknown keys are rejected at
every level. The example below is a seed plus a few edits, abridged only where marked.

```json
{
  "schema": "potongin.edit/2.0",
  "clip_id": "clip_9b2e…(64 hex)",
  "revision": 7,
  "parent_sha256": "4c1d…",
  "base": {
    "job_id": "j_20260924_…",
    "source": {"content_sha256": "e3b0…", "duration_ms": 4127180, "width": 640, "height": 360,
               "fps_num": 25, "fps_den": 1, "has_audio": true},
    "selection": {"artifact_sha256": "…", "selection_version": "selection-v3.0",
                  "rank_at_seed": 3, "hook_unit_id": "S0412"},
    "words": {"sha256": "7f0a…", "count": 512},
    "analysis": {"audio_timeline_sha256": "…", "sound_events_sha256": "…",
                 "camera_plan_sha256": "…"},
    "seed_sha256": "…",
    "migrated_from": null
  },
  "output": {"width": 1080, "height": 1920, "fps": 30, "safe_zone": "tiktok"},
  "main": {
    "segments": [
      {"id": "seg_co", "role": "cold_open", "src_in_ms": 1275400, "src_out_ms": 1279900},
      {"id": "seg_1",  "role": "body",      "src_in_ms": 1241900, "src_out_ms": 1310900}
    ],
    "removals": [
      {"id": "rm_01", "segment": "seg_1", "src_in_ms": 1250120, "src_out_ms": 1252560,
       "reason": "user", "origin": "user"},
      {"id": "rm_02", "segment": "seg_1", "src_in_ms": 1261330, "src_out_ms": 1262490,
       "reason": "gap_silent", "origin": "suggestion:sg_5"}
    ],
    "joins": [{"after": "seg_co", "style": "flash_white", "dur_f": 3}],
    "intro_hold_f": 0,
    "join_fade_ms": 8
  },
  "captions": {
    "enabled": true,
    "pack": {"id": "kotak-hitam", "version": 3, "sha256": "…"},
    "overrides": {"position_y": 0.66},
    "offset_ms": 0,
    "word_edits": {
      "w048121": {"text": "Ijal"},
      "w048140": {"emphasis": true},
      "w048151": {"hidden": true},
      "w048166": {"emoji_after": "1f602"}
    },
    "breaks": {"w048130": "cue", "w048177": "line"}
  },
  "tracks": [
    {"id": "t_broll", "kind": "visual", "band": "under_text", "z": 10, "locked": false, "hidden": false},
    {"id": "t_hook",  "kind": "text",   "role": "hook", "z": 40, "locked": false, "hidden": false},
    {"id": "t_text",  "kind": "text",   "z": 30, "locked": false, "hidden": false},
    {"id": "t_stk",   "kind": "visual", "band": "over_text", "z": 50, "locked": false, "hidden": false},
    {"id": "t_music", "kind": "audio",  "role": "music", "muted": false},
    {"id": "t_sfx",   "kind": "audio",  "role": "sfx", "muted": false}
  ],
  "items": [
    {"id": "it_hook", "track": "t_hook", "type": "hook",
     "start": {"at": "out", "f": 0}, "dur_f": 120,
     "payload": {"text": "Dia ditahan security di film-nya sendiri 😂",
                 "design": {"id": "sticker-label", "version": 2, "sha256": "…"},
                 "params": {"label": "LUCU", "tilt_deg": -4},
                 "emphasis": [[4, 20]]},
     "origin": "suggestion:sg_2"},
    {"id": "it_emoji1", "track": "t_stk", "type": "emoji",
     "start": {"at": "word", "word": "w048166", "edge": "end", "offset_f": 0}, "dur_f": 36,
     "transform": {"x": 0.78, "y": 0.58, "scale": 0.12, "rot": 0, "opacity": 1},
     "anim": {"in": "pop", "out": "fade"},
     "payload": {"emoji": "1f602"}, "origin": "user"},
    {"id": "it_logo", "track": "t_stk", "type": "image",
     "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
     "transform": {"x": 0.9, "y": 0.08, "scale": 0.14, "rot": 0, "opacity": 0.85},
     "payload": {"asset": "a_5c1f…"}, "origin": "template:tpl_brand"},
    {"id": "it_music", "track": "t_music", "type": "audio",
     "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
     "payload": {"asset": "a_91aa…", "src_in_ms": 0, "loop": true, "gain_db": -14,
                 "fade_in_f": 15, "fade_out_f": 30,
                 "duck": {"enabled": true, "depth_db": 10, "attack_ms": 30, "release_ms": 400}},
     "origin": "user"}
  ],
  "layout": {
    "default": {"mode": "face_track", "params": {}},
    "ranges": [
      {"id": "lr_1", "start": {"at": "word", "word": "w048200", "edge": "start", "offset_f": 0},
       "end": {"at": "word", "word": "w048231", "edge": "end", "offset_f": 0},
       "mode": "split", "params": {"top": "A", "bottom": "B", "divider": "line"}}
    ],
    "camera": {
      "manual_keyframes": [{"src_ms": 1255000, "cx": 0.62, "cy": 0.5, "ease": "ease_in_out"}],
      "forced_speaker": [{"segment": "seg_1", "src_in_ms": 1264000, "src_out_ms": 1269500, "seat": "B"}]
    }
  },
  "audio": {
    "source": {"gain_db": 0, "mute": []},
    "loudness": {"normalize": true, "target_lufs": -14, "true_peak_db": -1.0}
  },
  "assets": {
    "a_5c1f…": {"sha256": "5c1f…", "scope": "workspace", "kind": "image", "mime": "image/png",
               "w": 512, "h": 512, "license": {"owner": "user"}, "name": "logo-channel.png"},
    "a_91aa…": {"sha256": "91aa…", "scope": "library", "kind": "audio", "mime": "audio/mp4",
               "dur_ms": 142000, "lufs": -16.2,
               "license": {"owner": "library", "id": "musik:santai-01",
                           "attribution": "…", "url": "…"}}
  },
  "packaging": {"title": "…", "description": "…", "hashtags": ["#podcastindonesia"],
                "cover_f": 42, "credit": {"channel": "…", "url": "…"}},
  "export": {"quality": "standard", "srt": true, "cover_jpg": true},
  "template_ref": {"id": "tpl_brand", "version": 4, "overridden": ["captions.overrides.position_y"]},
  "audit": {"created_at": "2026-09-24T10:00:00.000Z", "updated_at": "2026-09-24T10:12:03.117Z",
            "editor_build": "studio-1a.3", "last_command": "AddRemoval"}
}
```

Field rules that are not obvious from the example:

| Path | Rule |
|---|---|
| `main.segments` | 1–200 segments. At most one `cold_open`, and it must come first and last 0.5–8.0 s. At least one `body`. `insert` is stage 2 (reordered ranges). Each segment lies inside `[0, source.duration_ms]`. Total output is 3 s–180 s (profile max). |
| `main.removals` | ≤ 2,000. Each lies inside its segment. Removals may overlap; the union is applied. `reason` ∈ `user\|gap_silent\|gap_voiced\|filler\|repeat\|ai_condense\|timeline`. `origin` ∈ `user\|seed\|template:<id>\|suggestion:<id>`. |
| `main.joins[].style` | Stage 1: `cut\|flash_white\|dip_black`. Stage 2 adds `xfade:<name>` from the deterministic xfade subset `[R3 §5.2]`. `dur_f` is 0–30. |
| `captions.word_edits` | Keys are word IDs from the words artifact. `text` is 1–40 chars, NFC, and passes `ass_escape` rules. `retime` `{s_ms, e_ms}` is stage 2 (the wordbar). |
| `captions.breaks` | `cue` forces a new cue before the word, `line` forces a line break, `none` forbids the automatic break before the word. |
| `items[]` | ≤ 500. `type` ∈ `hook\|text\|image\|emoji\|sticker\|video\|audio` in stage 1, plus `effect\|adjust` in stage 2. `track` must match its kind. At most one `hook` item. `anim` in/out presets (`fade`, `pop`, `slide_up`) are allowed on text and visual items from stage 1B; they compile to per-frame pre-sampled alpha/scale values, the same mechanism stage 2 keyframes use. |
| `items[].start/end` | An anchor (§2.11.4). Either `end` or `dur_f` must be present. |
| `items[].transform` | `x`, `y` are the centre as a fraction of W/H. `scale` is width as a fraction of W (for text: font scale relative to the style). `rot` is in degrees in (−180, 180]. `opacity` is 0–1. |
| `items[].keyframes` | Stage 2. `{"x":[{"f":0,"v":0.5,"ease":"linear\|ease_in\|ease_out\|ease_in_out\|hold"}]}`, with `f` relative to the item start, ≤ 5,000 in total. |
| `tracks[].band` | `under_text` (z < 20) or `over_text` (z ≥ 50). Text tracks sit between the two bands. Arbitrary interleaving of text and images is **not** supported (§10); it mirrors R3's three-band rule. |
| `layout.ranges` | Must not overlap. Mode ∈ `face_track\|smart_speaker\|fit_blur\|fit_black\|center_crop\|split\|branded_frame`. |
| `assets` | Only assets referenced by the document are listed; the IDs are content-addressed. |

**Size in practice.** A median 69 s clip with 20 removals, 10 word edits and 8 items comes to
about 8–12 KB. The words live outside the document: a median of 7.2 KB per moment and a maximum
of 17.9 KB, without context `[UX-M1]`.

### 2.4 Words artifact: `potongin.words/1` (immutable, per clip)

Path: `analysis/edits/<clip_id>/words.<sha256>.json`. It is served with `Cache-Control:
immutable`.

```json
{"schema": "potongin.words/1", "clip_id": "clip_…", "transcript_sha256": "…",
 "source_content_sha256": "…", "range_ms": [1181900, 1370900],
 "words": [{"id": "w048121", "s": 1241930, "e": 1242210, "t": "Ijai", "p": 0.41, "u": "S0412"}],
 "units": [{"id": "S0412", "s": 1241930, "e": 1245880, "q": true}],
 "gaps": [{"s": 1244100, "e": 1245320, "class": "voiced", "rms_db": -31.5}],
 "events": [{"kind": "laughter", "s": 1256800, "e": 1258600, "src": "yt-caption"}],
 "scene_cuts_ms": [1263040]}
```

| Field | Rule |
|---|---|
| Word ID | `w` + the zero-padded global word index in the transcript. It is stable for a given `transcript_sha256`. |
| `range_ms` | The clip ±60 s, so the context can be expanded and the cold open picked nearby. A whole-source search uses a separate paginated endpoint. |
| Zero-length words | YouTube-caption word timing produces up to 4.7% zero-length words in a moment (p90 1.2%) `[UX-M1]`. They are given `e = min(s + 80, next.s)` for snapping and are flagged `"z": true` (timing approximate). |
| `events` | Laughter events have points today `[REPO sound_events.py]`. They get an end at the first 100 ms frame after the point where `rms_db` falls below the silence floor + 6 dB, capped at 4 s (a stage 0 heuristic). Stage 1 gate: span precision ≥ 0.8 on 30 labelled events; until then, spans are shown as points. |
| **Re-anchoring** | When the transcript changes (a new sha), each old word ID is mapped to a new one. A match needs ≥ 50% time overlap and equal normalized text; otherwise the nearest word within 300 ms with equal text. Unmatched edits are **kept** and listed in "Perlu dicek" (needs checking). They are never dropped. |

### 2.5 Camera plan: `potongin.camera-plan/1` (analysis artifact)

Face tracking is computed today **inside the render** `[R3 §2]`, so it can be neither previewed
nor edited. It moves to the analysis stage and becomes data:

```json
{"schema": "potongin.camera-plan/1", "source_content_sha256": "…",
 "detector": "haar-v1|yunet-2023mar", "analysis_fps": 5,
 "seats": [{"id": "A", "cx": 0.31, "cy": 0.42}, {"id": "B", "cx": 0.72, "cy": 0.44}],
 "samples": {"t_ms": [...], "faces": [[[0.28, 0.35, 0.09, 0.16, 0.93, "A"]], ...],
             "speaking": ["A", null, ...]},
 "shots": [{"src_in_ms": 1241900, "src_out_ms": 1255000, "mode": "single", "seat": "A",
            "keyframes": [{"ms": 1241900, "cx": 0.31, "cy": 0.5}]}],
 "scene_cuts_ms": [...]}
```

- **Built by** `camera_plan.py`, running after selection for the ±60 s windows of the selected
  clips only (a CPU budget).
- **Stage 0 port** of the current `face_tracking.detect_face_track` and `smooth_face_track`, with
  unchanged behaviour. The current `build_crop_expression` output becomes the `keyframes`.
- **Stage 1B** swaps in YuNet (OpenCV Zoo; licence to be confirmed as MIT at integration) plus
  speaking-seat estimation (mouth-region motion correlated with the `rms_db` envelope). This is
  gated by the accuracy test in §8.4.
- **Compiler sampling.** The compiler samples, at every output frame n:

  ```
  cx(n) = manual keyframe interpolation if any manual keyframe lies within the shot,
          else shot keyframes;
          forced_speaker overrides the seat
  ```

  A fixed-size crop is applied through `sendcmd` on `crop@cam` x/y (LokaClip's method
  `[LC-bin 15841]`). The browser uses the same sampled values (QG-02).
- **Constraints enforced at plan build:**
  - pan velocity ≤ 6% of W per 100 ms;
  - no seat switch within 1.0 s of the previous one `[R2 M11]`.
- **A crop size that changes mid-piece is impossible** in FFmpeg (`Error reinitializing filters`
  `[R2]`). So `single → wide` switches are layout-range boundaries, and the compiler splits pieces
  there (§5.2).

### 2.6 Captions: derivation and layout

Shared modules: `edit_v2/captions/{derive,layout,ass}.py` and `web/lib/edit-v2/captions/*.mjs`.
They are Python-canonical. The JS output is **byte-identical** to Python's, checked with vectors.

1. **Visible words:**

   ```
   visible = [w for w in words
              if w's midpoint maps to an output frame (not removed)
              and not word_edits[w].hidden]
   ```

   The midpoint rule matches V3 `[REPO plan §Render]`. Display text is `word_edits.text` or the
   ASR text. Casing is applied at layout time from the pack.
2. **Timing.** `s_f = src_to_out(w.s + offset_ms)` and `e_f` likewise, clamped inside the word's
   piece. A word never spans a cut.
3. **Chunking into cues.** Pack rules: `words_per_chunk`, `max_lines`, `wrap_width`, a break on a
   gap > 600 ms, on a sentence end, **on every piece boundary** (so captions never straddle a jump
   cut or the cold-open join, as V3 does today), and on `breaks` overrides. A cue is shown for at
   least 0.3 s. `cue.end = min(next.start, last.e_f + hold_f)`. Everything is in integer frames.
4. **Layout (per-word absolute positions).**
   - Measure each word's advance from the **build-time metrics table** of the pack font:
     - the table is `resources/fonts/metrics/<font_sha>.json`, generated with fontTools 4.66
       (MIT) from the exact TTF;
     - it holds advances plus GPOS/kern pairs for Latin-1, Latin Extended-A, digits and
       punctuation;
     - unknown glyphs fall back to 0.85 em, the conservative width `captions_ass.py` already
       uses.
   - Emoji are measured as 1.0 em placeholders.
   - Greedy wrap to `wrap_width × W`. If the cue has more than `max_lines` lines, shrink in 5%
     steps down to `min_scale` (85%). If it still does not fit, raise the warning `caption_overflow`
     with the cue ID (shown in "Perlu dicek"). No silent ellipsis.
   - Each word gets `(x_center, y_baseline)` in output pixels using `round_half_up`.

   **Metrics tables replace run-time shaping** on both sides. Parity is not at risk from metric
   error, because libass draws the glyphs on both sides at the same `\pos`. Only spacing
   aesthetics depend on metric quality, and that is tested by the golden cap-height and word-gap
   checks.
5. **Emission to ASS** (reveal modes from `[R2 M7]`):
   - `segment_static`: one event per line with explicit `\pos` and `\q2`.
   - `chunk_karaoke`, `cumulative`, `per_word`: **one event per word, positioned with
     `\an5\pos`**. This stops the pop reflow, where neighbouring words moved 56 px `[R2]`.
     - The **base** event for a word is split around its active window: `[cue.s, w.s)` and
       `[w.e, cue.e)`. The active event covers `[w.s, w.e)` on layer 1 with the highlight style
       and the animation tags.
     - Without the split, the base and active glyphs double-draw; the `[UX-M4]` test frame shows
       it.
     - A box highlight is a layer-0 vector rectangle (`{\p1}`) at the word bbox plus padding.
   - `karaoke_sweep`: `\kf` on a single line event. This is the current V3 karaoke `[REPO
     captions_ass._karaoke_text]`, retained as legacy pack `v3-karaoke`.
   - Inline emoji become **derived image overlays** in the over-text band at the placeholder
     position and time. libass cannot draw colour emoji; they came out as tofu in production
     `[R2]`.
   - Escaping uses `captions_ass.ass_escape` (backslash + U+2060) `[R1 D2]`.
   - Event budget: fewer than 3,000 events for a 90 s clip `[R2 M7]`. JASSUB handles 520 events at
     a p95 of 29 ms `[UX-M4]`.
6. **The header** keeps `YCbCr Matrix: None` and `ScaledBorderAndShadow: yes`. `PlayResX/Y` equal
   the output resolution.

### 2.7 Hook designs: all pure ASS in stage 1

| Design | Technique | Why pure ASS matters |
|---|---|---|
| Bar | BorderStyle 3, one event per line (the current `captions_ass` Hook, legacy design `v3-bar`) | It is reproduced exactly for the seed round trip (QG-06) |
| Marker | `\p1` skewed rectangles behind each line, animated with `\clip` over 200 ms | |
| Note | `\p1` rounded rectangle, `\frz` −2°, and a shadow rectangle at 40% alpha offset | |
| Gradient | **16 stacked `\p1` bands** with stepped alpha (0→70%) over 28% of H | libass has no gradient fill. Stepped bands are indistinguishable at a 16-level step, and there is no PNG and no server round trip per keystroke. |
| Sticker label | A `\p1` pill with deterministic seeded "roughness" jitter, plus a label event, `\frz` tilt; emoji as a derived overlay | |
| Punchline | Two-tone fill via **N = 8 `\clip` horizontal bands** of the same text event, with an inner stroke and an outer stroke as two layered events | It gives a gradient-text look with parity |
| Comic | `\p1` jagged burst polygon (deterministic vertices) + Bangers or Lilita One | |
| Quote card | `\p1` rounded card, a badge circle, three dots, and two text events | |
| Top banner | A full-width `\p1` band + 2 lines | |

Auto-fit generalizes `captions_ass._hook_layout` to the design's font metrics and box padding.
Tilted designs are checked with a rotated bounding box against the safe zone (QG-10). Each design
file is `resources/hook-designs/<id>/v<N>.json`: parameter schema, defaults, `max_chars`, fonts,
and the event template program (a small declarative list, not code).

### 2.8 Versioned resources (packs, designs, templates, fonts, emoji)

| Resource | Path (in the image) | Schema | Versioning |
|---|---|---|---|
| Style pack | `resources/style-packs/<id>/v<N>.json` | `potongin.stylepack/1` (fields `[R2 §7.2]`) | Immutable per version. Documents pin `{id, version, sha256}`. Old versions ship forever. "Perbarui gaya" (update the style) is an explicit command. |
| Legacy packs | `v3-classic/v1`, `v3-karaoke/v1`, hook design `v3-bar/v1` | same | Reproduce `captions_ass.py` byte for byte (DejaVu, 17% bottom margin, and so on) |
| Hook design | `resources/hook-designs/<id>/v<N>.json` | `potongin.hookdesign/1` | as above |
| User style pack | `JOBS_ROOT/_workspace/style-packs/user-<uuid>/v<N>.json` | `potongin.stylepack/1` | Validated. It may reference only bundled fonts. |
| Template | `JOBS_ROOT/_workspace/templates/<id>/v<N>.json` | `potongin.template/1`: a partial document with `captions`, the hook design and params, `layout.default`, items anchored at `clip_start` or `clip_end` (logo, credit), music defaults, `export` | Applying records `template_ref` plus an `overridden[]` path list |
| Brand kit | `JOBS_ROOT/_workspace/brand-kit.json` | `potongin.brandkit/1` | Logo asset, corner, opacity, credit format |
| Fonts | `resources/fonts/<family>-<weight>.ttf` + `OFL-<family>.txt` + `metrics/<sha>.json` + `fonts.json` (family, weight, sha256, licence) | none | Pinned by sha. The same bytes are served to the browser (never WOFF2 conversions `[R2 §7.4]`). |
| Emoji | `resources/emoji/noto/<codepoint>.png` (136 px and 512 px) | none | Noto Emoji images, Apache-2.0 |

### 2.9 Commands, history and suggestions

- **Store.** zustand 5.0.15 (MIT) holds `{doc, derived, ui}`. `derived` holds the time map,
  resolved anchors, cues, ASS text and warnings. It is recomputed by memoized selectors, and a
  deferred worker is used when a derivation takes more than 8 ms.
- **Commands.** Each command lives in `web/lib/edit-v2/commands/*.mjs`. It is a pure function
  `(doc, args) → doc'` run through Immer 11.1.18 `produceWithPatches`. Each command:
  - validates its preconditions and throws a typed `CommandRejected{code, message_id}` (in
    Indonesian);
  - declares a `label` in Indonesian for the history view, and a `mergeKey` so that a drag or
    slider session becomes one entry.

  Undo keeps the inverse patches, with a limit of 200. The measured costs are 15 µs for a trim,
  88 µs for a cue edit, 487 µs for deleting 12 words and 82 µs for an undo `[R3]`.
- **Transactions.** Multi-command actions (Rapikan apply, template apply, find and replace, accept
  all suggestions) are one history entry.
- **Command catalogue (stage 1):**
  - Main: `SetSegmentBounds`, `SetColdOpen`, `ClearColdOpen`, `SetJoinStyle`, `SetIntroHold`,
    `AddRemoval`, `RemoveRemoval`.
  - Captions: `EditWordText`, `SetWordFlags`, `SetCueBreak`, `FindReplace`, `SetCaptionPack`,
    `SetCaptionOverride`, `SetCaptionOffset`.
  - Hook: `SetHookText`, `SetHookDesign`, `SetHookParams`, `SetHookTiming`.
  - Items: `AddItem`, `UpdateItem`, `SetItemAnchor`, `DeleteItem`, `ReorderItem`.
  - Layout: `SetLayoutDefault`, `AddLayoutRange`, `UpdateLayoutRange`, `DeleteLayoutRange`,
    `SetCameraKeyframe`, `DeleteCameraKeyframe`, `ForceSpeaker`.
  - Audio: `SetGain`, `SetDuck`, `SetLoudness`.
  - Assets: `AddAsset` (reference only).
  - Packaging and templates: `SetPackaging`, `ApplyTemplate`, `ApplyBrandKit`.
  - Suggestions and history: `ApplySuggestion`, `RevertToSeed`.
  - Stage 2 adds keyframes, transitions, effects, speed and inserts.
- **Suggestions are not part of the document.** They are stored in
  `analysis/edits/<clip_id>/suggestions/<id>.json` (§7) and rendered as ghost UI. Accepting runs
  normal commands with `origin: "suggestion:<id>"`, and the suggestion file records `accepted`.
- **The server never replays commands.** It validates whole documents. Commands exist for undo,
  labels and conflict rebase (§6.3).

### 2.10 Validation, warnings and "Perlu dicek"

Validation has three levels. Each is implemented Python-canonical, with a JS mirror checked by
vectors.

1. **Schema.** JSON Schema 2020-12 generated from the Python dataclasses (§3.1). Failure means
   HTTP 422 with `[{path, code}]`.
2. **Semantic errors (blocking save).**
   - a segment is outside the source;
   - a cold open breaks its rules;
   - a removal is outside its segment;
   - an unknown word ID;
   - an unknown asset, pack or design version;
   - a font not in the pack;
   - total output is outside 3–180 s;
   - more than one hook item.
3. **Warnings (saving allowed, export blocked unless acknowledged).** Each warning has a stable
   code, an Indonesian message and a jump-to target:

   | Code | Condition |
   |---|---|
   | `caption_overflow` | cue text does not fit after shrinking |
   | `hook_overflow` | hook text does not fit |
   | `anchor_removed` | the word an item is anchored to was cut |
   | `item_out_of_range` | an item falls outside the clip |
   | `no_face` | the camera plan has no face for a range under `face_track` or `smart_speaker`; the user must choose fit-blur or reframe manually |
   | `unsafe_zone` | text or a sticker sits outside the safe zone; ignoring requires an explicit "Abaikan" |
   | `laughter_cut` | a removal intersects a laughter span |
   | `tight_cut` | a cut point has energy > −30 dBFS |
   | `low_res_source` | the crop area of the source is less than 0.5× the output height; a 640×360 source gives a 202×360 crop for 1080×1920 |
   | `reanchor_unmatched` | a word edit could not be re-anchored |
   | `emoji_missing` | an emoji has no bundled image |
   | `asset_missing` | a referenced asset file is absent or failed re-verification |
   | `music_license_missing` | a music asset has no licence metadata |

The warning list is the "Perlu dicek (n)" (needs checking) button in the inspector. Export shows
the remaining warnings and requires a click-through for each non-blocking one. No fallback is
silent (QG-11).

### 2.11 Interaction algorithms

#### 2.11.1 Word snapping for trim handles

```
targets(t, zoom_px_per_s):
  for each word w in view:
     in(w)  = boundary between prev and w; out(w) = boundary between w and next
  boundary(a, b):                       # a = earlier word, b = later word (either may be None)
     gap = b.s - a.e
     if gap >= 40 ms: point = argmin over peaks (10 ms bins) inside [a.e + 20, b.s - 20] of |energy|,
                        ties -> closer to (b.s - min(80, gap/2)) for in-points, (a.e + min(80, gap/2)) for out-points
     else:            point = (a.e + b.s) / 2, flag tight
  plus: scene cuts, laughter ends (out-points only), silence midpoints, playhead
snap(t): the nearest target within 8 px; Alt disables; ties prefer word boundaries > laughter end > scene cut
```

The 10 ms energy comes from `peaks.dat` at 100 bins per second, a resolution 10× finer than the
100 ms `audio_timeline` `[R3 §6]`.

#### 2.11.2 Cut placement for a removal of words [wi..wj]

```
keep_a = last kept word before wi; keep_b = first kept word after wj
cut_in  = boundary(keep_a, wi) as an out-point for keep_a   (if keep_a exists, else segment start)
cut_out = boundary(wj, keep_b) as an in-point for keep_b     (if keep_b exists, else segment end)
removal = [cut_in, cut_out]; if the energy at cut_in or cut_out > -30 dBFS -> warning tight_cut
```

The removal is then frame-quantized by the time map.

#### 2.11.3 Gap classes (Rapikan)

This is precomputed into `words.gaps` at words-artifact build time, so the client does no audio
work:

```
for consecutive words (a, b) with gap = b.s - a.e > 600 ms:
   silent_part = intersection of [a.e, b.s] with audio_timeline.silences
   if any laughter event within [a.e - 500, b.s + 500]:        class = laughter
   elif len(silent_part) >= 0.8 * gap:                           class = silent
   else:                                                         class = voiced
proposal for silent: shorten each silent sub-span > X to Y, cut points centred in the silence
```

On the 48 gold moments this yields 22% silent, 66% voiced and 12% laughter `[UX-M2]`.

#### 2.11.4 Anchor resolution

```
{"at":"out","f":n}                  -> n
{"at":"clip_start"} / {"at":"clip_end"}   -> 0 / total_f
{"at":"word","word":id,"edge":e,"offset_f":k}
   -> src_to_out(seg of the word, word.s or word.e) + k
   if the word is removed: -> the output frame of the cut that swallowed it, + warning anchor_removed
   if the word is in the cold open and also in the body: prefer the body occurrence unless
      the item was created while the playhead was inside the cold open (stored as "seg": "seg_co")
```

An item whose resolved start is at or after `total_f` is not rendered, and it raises
`item_out_of_range`. It is never deleted silently.

---

## 3. Versioning and migration

### 3.1 Schema versioning

- **Source of truth.** The Python dataclasses in `src/ai_clipper/edit_v2/schema.py`.
  `python -m ai_clipper.edit_v2.schema --emit` writes `schemas/potongin.edit.v2.json` (JSON Schema
  2020-12), which is committed.
- **Drift check.** CI fails when the emitted schema differs from the committed one. This fixes the
  V2 duplication, where JS hand-mirrors Python `[R1 §12]`.
- **JS validation.** The browser and Next routes validate with **Ajv 8.20.0 (MIT) compiled
  standalone** at build time (`ajv/dist/standalone`). There is no `eval` at runtime, so it is CSP
  friendly.
- **Version string.** `schema` is `potongin.edit/<major>.<minor>`.
  - A minor version adds optional fields with defaults. The 2.x reader knows every field from 2.0
    to 2.x and stays exact-key.
  - A major version requires a pure migration function, `migrate_2_to_3(doc) -> (doc, report)`.
- **Migration on read, write on save.** Old documents are migrated in memory on read, and written
  only on the user's next save (a new revision with `base.migrated_from`). The archive keeps the
  original bytes.
- **Engine fingerprint.** It is not part of the document; it goes into render requests and output
  keys (§5.6). A renderer upgrade therefore never mutates documents, but it does mark renders
  stale ("Render usang").

### 3.2 Seeding from Selection V3 (revision 0 and revision 1)

`seed_from_selection(clip: SelectedClip, job_options, words, camera_plan) -> EditDoc` is a pure
function. It builds:

| Field | Seeded from |
|---|---|
| `main.segments` | `[cold_open?]` + `[start, end]` in ms, from `SelectedClip.cold_open`, `.start`, `.end` |
| `captions.pack` | `v3-karaoke/v1` or `v3-classic/v1` from `job.options.captionStyle` |
| Hook item | when `hookOverlay` is on: `v3-bar/v1`, text `SelectedClip.hook_text`, `dur_f = 4 s × fps` (the current `hook_duration`) |
| `layout.default.mode` | `job.options.renderMode` (`face-track` → `face_track` with the camera plan) |
| `output` | the job's render size (720×1280 for dashboard jobs today, `web/scripts/run-job.mjs`), fps 30 |
| `audio.loudness.normalize` | `false`, which equals today's auto render |
| `packaging` | title, description, hashtags |

**Stage 0 makes the V3 auto render call exactly this path:** `pipeline` → `seed` → `compile` →
`render`. So:

- revision 0 (a virtual document, never written) is what produced `clip-NN.mp4`;
- opening the editor and exporting without edits yields the same video stream hash (QG-06, by
  construction);
- `GET …/edit` no longer creates revision 1 as a side effect, which V2 does `[R1 §4]`. It returns
  the seed with `ETag: "<seed sha>"` and `X-Edit-Seed: 1`. The first PUT with
  `If-Match: <seed sha>` creates revision 1.

**Legacy auto renders** (jobs rendered before Stage 0, with gblur and old ASS) are **not**
re-rendered automatically. Opening them works through the seed, and the export dialog notes: "Hasil
ekspor memakai mesin render baru; tampilan latar blur sedikit berbeda" (the export uses the new
render engine; the blurred background looks slightly different). The plate blur measured SSIM
0.993 against the old look `[R3]`.

**Stable clip IDs.** Stage 0 adds `clip_id` to every `SelectedClip` in `selection.v3.json` (an
additive field):

```
clip_id = "clip_" + sha256(
    source_content_sha256 "\0" selection_version "\0"
    f"{start:.3f}" "\0" f"{end:.3f}" "\0" (f"{cs:.3f}-{ce:.3f}" if cold_open else "-"))
```

`rank` is not stable, so it is not used `[R1]`. For artifacts written before Stage 0, the ID is
computed on the fly. Re-running selection produces different windows, and therefore new clip IDs.
Old edits stay reachable under their own ID, and the project page lists them as "Klip yang diedit
dari seleksi sebelumnya" (clips edited from an earlier selection). They are never orphaned.

`source_content_sha256` is computed once per job, at about 0.3 s per 160 MB, and stored in
`analysis/source.json`.

### 3.3 Migrating V2 `clip-edit-v1.0` documents

`migrate_v1_to_v2(manifest, candidates_v2, transcript) -> (doc, report)` is pure and
deterministic. It is triggered when a V2 editor URL is opened. The old route redirects to
`/projects/:id/clips/:clipId/edit?from=cand_…`.

| V1 field | V2 result | Lossy? |
|---|---|---|
| `identity.candidate_start/end` | a `body` segment; `clip_id` computed from the window with no cold open | no |
| `visual.canvas_width/height` (720×1280) | `output` kept at 720×1280. The export dialog offers 1080×1920. | no |
| `visual.render_mode` fit-blur, center-crop | `layout.default` | no. Fit-blur changes gblur to the plate. |
| `visual.safe_area`, `focal_x/y` | center-crop `focal_x` becomes the centred-crop parameter (the render's math, not the CSS math `[R1 P15]`); `focal_y` is dropped (it had no effect) | noted |
| `caption_style.preset` | `clean` → `tiktok-box`, `bold-keyword` → `kuning-merah`, `karaoke` → `karaoke-sweep`, `podcast` → `tiktok-box`, `minimal` → `santai-ketik`. Colour and size become `overrides` where the pack has the field. | **yes**: the look changes, and the report says so once |
| `captions[].text` edits | a token diff (difflib `SequenceMatcher` on normalized tokens) against the original cue text, over the words in the cue span: replace → `word_edits.text`, delete → `hidden`, insert → appended to the previous word's text (stage 2 `inserted`) | inserts approximate |
| title overlay | a `text` item, whole clip, preset "outline" | style differs |
| logo overlay | an `image` item if the asset file exists in `analysis/edits/assets/`; otherwise the item is kept and the warning `asset_missing` is raised | no |
| `audio.gain_db`, `normalize` | `audio.source.gain_db`, `audio.loudness.normalize` (now two-pass, 48 kHz `[R1 D4]`) | no |

The report is stored as `migration.<sha>.json`. The UI shows it in a dismissible banner. After
migration the V2 editor route is **read-only** and V2 renders stay downloadable. The V2 defects
D1–D11 `[R1]` are therefore not fixed in V2 code; they are designed out in V2's replacement
(QG-11, QG-14).

---

## 4. Browser preview and exact parity

### 4.1 What the user sees at each moment

| State | Pixels on the stage | Guarantee |
|---|---|---|
| Playing or scrubbing | The live engine: WebGL2 compositor (parity-safe ops) + JASSUB (the same ASS bytes and font files as the server) + WebAudio | L0 semantic parity always. L1 perceptual parity per op (composite SSIM ≥ 0.99, PSNR ≥ 35 dB; text SSIM ≥ 0.9995) `[R3 §1]` |
| Paused for 250 ms | The live frame, then the **exact server frame** swapped in when it differs (SSIM < 0.98 on downscaled luma) | L2 pixel parity. Badge "Exact ●" (green: the live frame matched; blue: showing the server frame) |
| "Cek akhir" (optional) | A server 540p proxy render of the whole clip (1.7 s per 20 s `[R2]`), played in `<video>` | L2 over time, including audio |
| Before the proxy is ready | The auto-render MP4 (read-only) | Exact for the seed |

The parity sentinel reports SSIM telemetry for every exact frame, as a production drift detector
`[R3 §5.3]`.

### 4.2 Engine (adopts R3 §5, with UX-driven details)

```
web/lib/preview/
  engine.worker.mjs      OffscreenCanvas, owns decode + composite; main thread sends {doc-derived scene, t_out}
  decoder-pool.mjs       Mediabunny 1.59.1 (MPL-2.0) Input(UrlSource) -> VideoSampleSink; 2 decoders:
                         current piece + next piece pre-rolled >= 500 ms before each cut
  audio-graph.mjs        AudioBufferSink -> per-piece AudioBufferSourceNode scheduled on the output timeline,
                         8 ms fades at cuts, GainNode automation for duck envelope and fades; master clock
  compositor-webgl2.mjs  ops: range/cut, crop+scale (bicubic B=0,C=0.6), camera crop (sampled values),
                         fit-blur plate, overlay (premultiplied), fade; shaders/*.glsl
  captions-jassub.mjs    JASSUB 2.5.16 in manualRender mode, mediaTime = floor(t_out*fps)/fps,
                         canvas = output resolution, fonts = pack TTFs, queryFonts:false
  truth-frame.mjs        POST /frame {doc, f} debounced 250 ms, LRU by (doc sha, f)
  parity-sentinel.mjs    ssim.js 3.5.0 on 180x320 luma; telemetry
```

UX-driven specifics:

- **Canvas stack**, mirroring the FFmpeg band order `[R3 §4]`:
  - WebGL canvas A: video, B-roll and under-text images;
  - the JASSUB canvas: captions, hook and text items;
  - WebGL canvas B: over-text stickers, emoji (including derived inline emoji) and the logo;
  - a DOM gizmo layer: selection boxes, handles, snapping guides, safe-zone overlays for the
    TikTok, Reels and Shorts presets.
- **Scene per frame.** The main thread computes the derived scene once per document change, in
  about 1 ms for typical documents. The worker samples it at `t_out`. Keyframes, the camera and
  envelopes are **pre-sampled per output frame** by shared code (`sample.mjs` ↔ `sample.py`), so
  both compilers use identical numbers `[R3 §5.2]`.
- **Proxies.**
  - A **window proxy** per clip, at 720p or the source height if lower, covering the clip ±60 s
    `[R3 §6]` (GOP 0.5 s, `setsar=1`, BT.709 tags). It takes 5–8 s of CPU and is **prebuilt for
    every V3 clip at the end of the job**, so the first open is instant.
  - A **scrub proxy** for the whole source at 360p, built lazily at nice 10 when the user expands
    context beyond ±60 s or searches the whole transcript for a cold open.
- **COOP/COEP on editor routes only.** The headers are `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`, so JASSUB can use threads
  (`crossOriginIsolated`, verified in the lab). This requires self-hosting all editor
  subresources, so the Google Fonts `@import` in the dashboard CSS is removed and the UI fonts are
  self-hosted `[R1 §8]`.
- **Fallback.** Without WebCodecs or WebGL2, or when the document uses an op that is not yet
  ported:
  - the stage switches to **server preview segments** (2 s fMP4, `hls.js` 1.7.3 Apache-2.0) plus
    exact frames;
  - audio stays client-side `[R3 §5.3]`;
  - the badge reads "Pratinjau server" (server preview).
- **Browser support.** Chrome and Edge ≥ 120 on desktop get full support, and CI gates on them.
  Safari 17+ and Firefox 130+ run the same suites **report-only** until they are green, and the
  UI labels them "beta". Phones get review and export only.
- **Op gating is data, not code.** CI writes `web/public/parity-manifest.<hash>.json` listing
  ops, packs and designs whose golden cases passed. The UI hides anything absent. A feature that
  is not green cannot be clicked (the "no half-baked features" rule).

### 4.3 Text: one generator, two runtimes

- `edit_v2/captions/*.py` and hooks are canonical. The JS port lives in
  `web/lib/edit-v2/captions/`.
- `tests/fixtures/edit-v2/vectors/ass/*.json` hold ≥ 200 inputs covering every pack × reveal
  mode, 10 hook designs (9 + legacy `v3-bar`) × text lengths, emoji, RTL and escape fuzz strings (`\N {\b1} \h`). The
  expected `.ass` is **byte-identical** in `pytest` and `node --test` (QG-02).
- **The client never sends ASS to the server.** The server regenerates ASS from the validated
  document, which also closes the injection surface `[R3 §4]`.
- **libass skew.** The server has libass 0.17.1 and JASSUB has 0.17.4-43. They measured SSIM
  0.9998 against each other `[R3]`. The version pair is pinned (the image digest and `jassub`
  exact version in `package.json`), and upgrades are gated by the golden suite. Aligning the
  versions is optional: a trixie-based image ships libass 0.17.3 `[R2 §3]`.

### 4.4 Golden parity suite (CI)

This follows R3 §9, with the case list derived from the flows:

| Case family | Examples | Thresholds |
|---|---|---|
| Text only | 8 packs × 3 texts × 5 timestamps; 9 hook designs × {10, 40, 90 chars} × {emoji, none}; text item presets | SSIM ≥ 0.9995, max diff ≤ 16, 0 px above 32 (RGB, lossless reference) |
| Composite | seed round trip; cold open + flash join; 20 jump cuts; face-track camera plan; split; fit-blur plate; branded frame; B-roll cutaway and PiP with fade; stickers over text; logo | SSIM ≥ 0.99, PSNR ≥ 35 dB, px above 64 ≤ 0.05%, bbox ±1 px, temporal offset 0 |
| Audio | 20 cuts with 8 ms fades; ducking envelope; music fades and loop; loudness gain | envelope RMS error < −40 dB (measured −153 dB for ducking `[UX-M5]`); fade positions ±1 ms |
| Jitter | per-word pop in 3 packs | non-active words move ≤ 1 px between frames |
| Decode | proxy decode vs FFmpeg | SSIM ≥ 0.997, max ≤ 8 `[R3]` |

Sample times per case: every event boundary ±1 frame, word onsets, fade midpoints, transitions at
25/50/75%, and 10 seeded random frames. References are rendered **inside the production image**
at a pinned digest. Candidates come from Playwright 1.62 with a pinned Chrome for Testing (147,
`chromium-1217`). A failure uploads ×8 diff heatmaps, side-by-side images and metrics JSON.

---

## 5. FFmpeg compilation and CPU performance

### 5.1 Module layout

```
src/ai_clipper/edit_v2/
  schema.py        dataclasses + JSON Schema emit          validate.py   semantic rules + warnings
  timemap.py       §2.2                                    anchors.py    §2.11.4
  captions/        derive.py, layout.py, ass.py (promoted from captions_ass.py), metrics.py
  hooks.py         design programs -> ASS events           camera.py     plan sampling -> sendcmd
  audio_env.py     duck/fade envelopes -> f32 PCM          seed.py       seed_from_selection
  migrate.py       v1 -> v2                                compile_ffmpeg.py  doc -> RenderPlan
  render.py        runs a RenderPlan (fail-closed runner from render_manifest: no shell, fd inputs,
                   timeouts, -progress liveness)            verify.py     QG-07..QG-10 on the output
  cli.py           get | put | seed | validate | frame | segment | render-plan | migrate (envelope
                   protocol and exit codes of editor_api.py)
```

`compile_ffmpeg(doc, words, camera_plan, assets_root, fonts_root, *, window=None) -> RenderPlan`
is **pure**:

```python
@dataclass(frozen=True)
class RenderPlan:
    inputs: tuple[InputSpec, ...]          # path ids resolved by the runner, never client strings
    filter_complex: str
    side_files: Mapping[str, bytes]        # captions.ass, cam_<k>.cmd (sendcmd), env_<k>.f32
    encode_args: tuple[str, ...]
    expected: ExpectedOutput               # width, height, fps, total_f, audio_rate, has_audio
    loudness_pass: bool                    # needs pass-1 measurement
    fingerprint: str                       # sha256(compiler_version, ffmpeg -version line, libass ver,
                                           #        font pack sha, pack/design shas used)
```

G-DET/QG-01: the same inputs give byte-identical plans. This is a unit test that hashes the plan.

### 5.2 Graph template (stage 1)

Render units are the time-map pieces, further split at layout-range boundaries.

```
INPUTS   per unit u:  -ss <u.in_s> -t <u.n/fps + 0.5> -i source          (strategy A, [UX-M3])
         assets:      -loop 1 -framerate 30 -i <still>.png | -i <broll>.mp4 | -i <music>.m4a
         envelopes:   -f f32le -ar 48000 -ac 1 -i env_music.f32

VIDEO u  [u:v] fps=30:round=near, trim=end_frame=<u.n>, setpts=PTS-STARTPTS,
               <layout chain>, settb=1/30, setsar=1, format=yuv420p [v_u]
   layout chains:
     face_track/smart_speaker: scale=<cover>, sendcmd=f=cam_u.cmd, crop@cam=<W>:<H>:x0:y0
     fit_blur (plate):  split[a][b]; [a]scale=90:160:force_original_aspect_ratio=increase:flags=area,
                        crop=90:160,boxblur=4:3:2:3,scale=W:H:flags=bilinear[bg];
                        [b]scale=W:H:force_original_aspect_ratio=decrease[fg];
                        [bg][fg]overlay=x=<even>:y=<even>              ([R3 §5.2]; -37 % render time)
     split:        split; 2 x (crop seat, scale=W:H/2); vstack
     center_crop:  scale=<cover>, crop=W:H:x=<even>:y=<even>
     branded:      scale into content rect + pad onto template background (still input)
AUDIO u  [u:a] aresample=48000, aformat=sample_fmts=fltp:channel_layouts=stereo, apad,
               atrim=end_sample=<round(u.n*48000/30)>, asetpts=N/SR/TB,
               afade=t=in:d=0.008, afade=t=out:st=<len-0.008>:d=0.008 [a_u]
JOIN     [v_0][a_0]...[v_k][a_k] concat=n=k+1:v=1:a=1 [base][speech]
         joins with a style: flash_white = overlay of a white color source with enable on frames
         [j-1, j+1] and fade alpha;  stage 2 xfade/acrossfade with equal duration d (both shrink by d,
         so no drift; the time map already accounts for it)
HOLD     tpad=start_duration=<h/fps>:start_mode=clone ; adelay=<h ms>:all=1   (intro hold)
BAND 0   [base][broll_k]overlay=x:y:enable='between(n,a,b)':eof_action=pass ...   (frame indices n,
         never float t)
BAND 1   ass=filename=captions.ass:fontsdir=/app/resources/fonts
BAND 2   [..][sticker_k]overlay=...:enable='between(n,a,b)'  (emoji, stickers, logo)
AUDIO    [music] atrim/aloop, volume=<gain>, afade in/out, [env] amultiply -> [m];
         [sfx_k] adelay -> [s_k];  [speech][m][s_*] amix=inputs=N:normalize=0:duration=first
         loudness: constant gain from pass 1 (below), then aresample=48000
ENCODE   -c:v libx264 -preset veryfast -crf 21 (Standar) | -preset medium -crf 18 (Tinggi)
         -g 60 -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
         -c:a aac -b:a 192k -ar 48000 -ac 2 -map_metadata -1 -movflags +faststart
```

Rules learned by measurement:

- **Frame-index enables.** `between(n,a,b)` on integer frames avoids float `t` edge ambiguity.
  The browser uses the same integers.
- **Even positions.** Overlay x/y are computed with `round_half_up` and then **cleared to even**.
  `overlay` truncates odd positions in yuv420, and a one-row mismatch gives diffs of 150+ `[R3]`.
- **Shared assets are normalized** to sRGB PNG with the colour chunks stripped (§6.5), which
  avoids the 9.5-level shift `[R3]`.
- **No `xfade` without `settb` and `fps` normalization**, which fails otherwise `[R2]`. Every
  branch is normalized as above.
- **Zoom** (stage 2 punch-in and Ken Burns) uses `zoompan` or scale-then-fixed-crop. A crop size
  that changes over time fails `[R2]`.
- **Why strategy A.** Per-unit inputs keep seeking simple and decode only kept frames. Measured
  against single-decode split/trim: equal cost (22.7 vs 22.3 s) and equal sync (−4 ms) `[UX-M3]`.
  The select/aselect form was rejected: 53 ms A/V drift and no fades.

### 5.3 Loudness: two passes, linear

1. **Pass 1.** Run only the audio chain (`-vn`) through `loudnorm=I=-14:TP=-1:LRA=11:print_format=json`
   in measure mode, or through `ebur128=peak=true`. The audio chain for 60 s decodes in about
   1 s; this is an estimate to confirm in the Stage 0 benchmark.
2. **Gain.** `g = min(-14 - I_measured, -1 - TP_measured)` dB.
3. **Pass 2.** A constant `volume=g dB`, which the preview applies too, so there is exact parity.
4. **Peaky content.** If the TP constraint pulls the result below −15 LUFS, add `alimiter=limit=-1dB`.
   That span's preview audio is flagged "approx" in QA reports, and G-AUDIO still holds.

This yields 48 kHz output, fixing the 96 kHz single-pass bug `[R1 D4]`.

### 5.4 Ducking and audio envelopes (exact)

`audio_env.py` and `audio-env.mjs` compute breakpoints from the speech intervals **in output
time** (visible words merged when the gap is < 300 ms):

```
env(t) = 1 outside speech; depth = 10^(-depth_db/20) inside;
         ramp down over attack_ms ending at speech start; ramp up over release_ms after speech end.
```

Both sides evaluate the same piecewise-linear function:

- **FFmpeg:** rendered to a 48 kHz f32 mono PCM side file and applied with `amultiply`. This was
  bit-exact against the reference and takes 0.107 s for 60 s in the production image.
- **Browser:** `GainNode.gain.linearRampToValueAtTime` on the same breakpoints. Chrome 147 matches
  FFmpeg within 3.0e-7 (−153 dB) `[UX-M5]`.

Fades, mute ranges and per-item volume use the same mechanism.

### 5.5 Performance budget on CPU

| Measured | Result |
|---|---|
| 21-range jump cut, 67.8 s output, 1080×1920 centre crop, veryfast crf21, **prod image, 4 CPUs** | 22.2–22.7 s (3.0× RT) `[UX-M3]` |
| Same job, local ffmpeg 6.1.1, 4 cores | 16.8–17.4 s (3.9–4.0× RT) `[UX-M3]` |
| 30 s at 720×1280, fit-blur: gblur vs plate | 5.46 → 3.45 s `[R3]` |
| 30 s at 1080×1920, fit-blur with gblur, 4 cores | 11.63 s `[R3]` (the plate should remove about 36%; to confirm in Stage 0) |
| Animated per-word ASS overhead | +14% `[R2]` |
| Stage-2 graph (3 segments, zoompan, xfade, overlay, animated ASS, ducking, loudnorm), 17.8 s at 1080×1920, prod | 9.44 s (1.9× RT) `[R2]` |
| One exact frame at 1080×1920 with ASS / at 720×1280 | 0.43 s `[R2]` / 0.16–0.20 s `[R3]` |
| Window proxy per clip | 5–8 s `[R3]` |

Budgets (QG-13), measured in the production image with 4 CPUs:

| Document | Budget |
|---|---|
| Stage-1 document (cuts, camera or plate layout, animated captions, hook, ≤ 10 overlays, music) | ≤ 0.5× output duration at 1080×1920 |
| Stage-2 document | ≤ 0.6× output duration |
| Truth frame | ≤ 0.6 s p95 |
| Proxies for 12 clips | ≤ 2 min CPU per job, run at nice 10 after the auto renders |

**Timeout and liveness.** The timeout is `60 s + 1.5 × k_mode × output_s × (W×H / 1080×1920)`,
with `k_mode` measured per layout (for example 0.35 for centre crop and 0.45 for plate fit-blur).
The runner also kills the process when `-progress pipe:1` reports no advance for 60 s. This
replaces the fixed 120 s timeout `[R1 D9]`.

**Scheduling.**

| Work | Where and how |
|---|---|
| Final renders | `render-worker` (4 CPUs), one at a time |
| Truth frames and preview segments | the `app` container (6 CPUs), semaphore 2, nice 5, superseded requests cancelled by document sha |
| Proxies and camera plans | the primary job queue at nice 10 |

Priority order: truth frames > final renders > proxies. Final renders get a cancel endpoint
(§6.2).

### 5.6 Output identity, caching and verification

- **Output key.** `output/edits/<clip_id>/<sha256(canonical doc ‖ fingerprint)[:20]>.mp4` (+
  `.srt`, `cover.jpg`), plus a `latest.json` pointer. Re-exporting an unchanged document with the
  same engine is an instant cache hit, as in LokaClip `[LC-bin 14454]`. An engine change creates a
  new key, which fixes stale renders `[R1 D8]`.
- **Inline gates at no extra decode.**
  - Video: `split` → `blackdetect=d=0.5,freezedetect=d=0.5` → `nullsink`.
  - Audio: `asplit` → `ebur128=peak=true` → `anullsink`.
  - Results are parsed from stderr metadata.
- **After encode:** an ffprobe contract (QG-07) and per-stream duration checks (QG-09). A failure
  sets the render to `verification_failed`, a state that exists in the enum and is never written
  today `[R1 §7.2]`, with the gate name and an Indonesian message.

---

## 6. API, storage, revisions, concurrency and asset security

### 6.1 Storage layout

```
JOBS_ROOT/<job>/
  analysis/source.json                         {content_sha256, probe}                   (Stage 0)
  analysis/selection.v3.json                   + clip_id per clip (additive)
  analysis/camera-plan.v1.json                 §2.5
  analysis/media/scrub-360.mp4                 lazy; storage-admitted
  analysis/media/peaks.dat                     audiowaveform .dat v2 header, int8 min/max @100/s  [R3 §6]
  analysis/media/sprite.json, sprite-<n>.webp  keyframe sprite
  analysis/edits/<clip_id>/
      doc.json                                 current revision (canonical, 0600)
      archive/r<N>.<sha>.json                  retained per policy (below)
      receipts/<idempotency-key>.json          {payload_sha256, result_etag, created_at}  (no document copy)
      checkpoints.json                         [{name, revision, sha, at}]
      words.<sha>.json                         §2.4
      media/window-720.mp4, filmstrip.json, filmstrip-<n>.webp
      suggestions/<id>.json                    §7
      migration.<sha>.json                     §3.3 report (if migrated)
  analysis/assets/<sha>.<ext> + <sha>.json     job-scoped normalized uploads + probe
  analysis/render-requests/…                   existing queue (candidate_id → clip_id generalization)
  output/edits/<clip_id>/<key>.mp4|.srt|cover.jpg, latest.json
JOBS_ROOT/_workspace/
  brand-kit.json, templates/<id>/v<N>.json, style-packs/user-<uuid>/v<N>.json,
  library/<sha>.<ext> + .json (user library), music-library.json (curated, licensed)
```

The storage primitives from `edit_manifest.py` are extracted into `versioned_document.py`:
canonical bytes, `_atomic_write`, `_archive_current`, `flock` locks, `O_NOFOLLOW` reads and
bounded sizes `[R1 §12]`. `edit_v2` and the V2 read-only path both use it.

**Retention**, run by a janitor inside the existing primary job queue, under the document lock:

| Item | Kept |
|---|---|
| Receipts | 24 h, or the last 200, whichever keeps more. This removes the 1,000-save lockout `[R1 D5]`. |
| Archive revisions | rev 1; every revision referenced by a render request or checkpoint; the last 50; one per hour for 7 days. Everything else is deleted. |
| Suggestions | 30 days |
| Proxies | kept while the job is kept; subject to the existing storage retention policy (`docs/operations/STORAGE_RETENTION.md`) |

**Render inputs.** Today the whole source is copied per render request `[R1 §7.2]`. Instead, the
source is **hard-linked** into `render-inputs/` when it is on the same filesystem (0 bytes), and
copied only across filesystems. The rest of the byte-level binding stays: the source content sha
and the archived document sha.

### 6.2 HTTP API

The Next.js route handlers reuse `requireAuth`, the CSRF checks (Origin, Host,
`Sec-Fetch-Site`), strict DTO validation and the "Python CLI per request" bridge (70–90 ms,
acceptable for every endpoint below) `[R1]`.

| Route | Method | Contract |
|---|---|---|
| `/api/jobs/:id/clips` | GET | V3 clips with `clipId`, `rank`, `title`, edit status (`seed`, `edited`, `rendered`, `stale`), latest render |
| `/api/jobs/:id/clips/:clipId/edit` | GET | 200 with the document and `ETag`; or the seed with `X-Edit-Seed: 1` and `ETag: "<seed sha>"`. **No side effects.** |
| same | PUT | `If-Match` (428 if missing), `Idempotency-Key` (UUID), JSON ≤ 1 MiB streamed and counted. 200 `{doc, etag, warnings}`; 409 `{code: "revision_conflict", current, etag}`; 422 `{errors: [{path, code, messageId}]}` |
| `…/edit/history?cursor=` | GET | `[{revision, sha, updatedAt, label, checkpoint}]`, paginated |
| `…/edit/revisions/:sha` | GET | the archived document (for A/B compare and restore) |
| `…/edit/checkpoints` | POST | `{name ≤ 60, etag}` → 201 |
| `…/words` | GET | the words artifact. `ETag` is its sha; `Cache-Control: private, max-age=31536000, immutable` |
| `…/media/window.mp4` | GET/HEAD | Range. 202 with `Retry-After` while building. The file streaming code is reused from `preview-source` `[R1 §12]`. |
| `/api/jobs/:id/media/{scrub.mp4, peaks.dat, sprite.json, sprite-<n>.webp}` | GET | Range where relevant; immutable once built |
| `…/frame` | POST | `{doc, f, width ≤ 1080}` → `image/png` (sRGB, no colour chunks). Validates the **inline** (possibly unsaved) document. Cache key `(sha(doc), f, width)`. Rate limited to 4/s per session, concurrency 2. |
| `…/preview-segments` | POST | `{doc, fromF, toF}` → HLS playlist URL (fallback path) |
| `…/renders` | POST | `{etag, quality, resolution}` → 202 status DTO (existing `render_queue`, generalized to `clip_id` and a `kind`) |
| `/api/jobs/:id/renders/:renderId` | GET, **DELETE** | existing status DTO; DELETE cancels (new): a queued request is removed, a running one is signalled through the lease |
| `…/ai/:task` | POST | `task` ∈ `hooks`, `cold_open`, `keywords`, `condense`, `broll`, `packaging`; body `{etag, params}` → 202 `{suggestionId}` |
| `…/ai/:suggestionId` | GET | `{state: queued\|running\|done\|failed, heuristic: [...], llm: [...]\|null, error?, provider?, model?}` |
| `…/apply-all` | POST | `{what: "captions"\|"template"\|"brandkit", source: clipId, targets: [clipId], mode: "skip_overrides"\|"overwrite"}` → a batch of server-side PUTs, each an ordinary new revision; returns per-clip results |
| `/api/assets?scope=job:<id>\|workspace&kind=image\|video\|audio` | POST | raw body upload (§6.5) → 201 `{assetId, sha256, kind, w, h, durMs, hasAudio}` |
| `/api/assets/:scope/:sha` | GET | normalized asset, immutable |
| `/api/resources/{fonts,style-packs,hook-designs,emoji,parity-manifest}/…` | GET | static, content-hashed, immutable |
| `/api/workspace/{templates,brand-kit,style-packs}` | GET/PUT | same `If-Match` and idempotency pattern as documents |

### 6.3 Revisions and concurrency (client side)

- **Autosave.**
  - It fires 1.5 s after the last committed command, and at least every 10 s during continuous
    editing.
  - One PUT is in flight at a time.
  - The payload is the whole document (≤ 1 MiB, typically 8–12 KB).
  - The status line shows "Menyimpan…" (saving), "Tersimpan • n dtk lalu" (saved n s ago) or
    "Gagal menyimpan — mencoba lagi" (save failed, retrying).
- **Crash safety.** An IndexedDB draft (idb-keyval 6.3, Apache-2.0) is keyed by `(clipId,
  baseEtag)` and written after every command, as a per-viewer convenience. When the editor opens
  and a draft newer than the server document exists, it offers "Pulihkan draf" (restore draft).
- **Conflict rebase** (a second tab or a batch apply-all):
  1. The client keeps `pending`: the forward patches since `baseEtag`.
  2. On 409 it takes `current` from the response and computes the set of paths changed between
     `base` and `current` (a JSON diff with array-by-id matching for `items`, `removals`,
     `segments` and `word_edits`).
  3. If no pending patch touches a changed path, it applies `pending` onto `current`, validates,
     and PUTs with `If-Match: current.etag`. The toast "Digabung dengan perubahan dari tab lain"
     (merged with changes from another tab) appears.
  4. Otherwise a dialog lists the conflicting parts by label ("Teks hook", "Potongan 00:12") with
     "Pakai punyaku / Pakai yang tersimpan" (use mine / use the saved one) per part.

  **The editor never locks**, which is what V2 does today `[R1 §5]`.
- **Idempotency.** The V2 algorithm is kept (pending → committed receipts with crash
  reconciliation) `[R1 §5]`, with the pruning above.

### 6.4 Server-side batch ("apply to all clips")

`apply-all` runs in one Python process holding each clip's lock in turn. For each target it
reads, applies the partial (pack, template or brand kit) according to `mode`, validates, and
writes a new revision with the label "Terapkan ke semua klip". Open editors see a 409 on their
next save and rebase automatically (§6.3). The result lists skipped clips and their reasons.

### 6.5 Asset upload security

Uploads are the largest new attack surface: user bytes reach FFmpeg and libass. Rules:

1. **Transport.**
   - The body is a raw stream (no multipart parser), with a `Content-Type` allowlist and a
     required `Content-Length` no larger than the kind cap (image 10 MB, audio 50 MB, video
     300 MB).
   - It is streamed to `tmp/upload-<uuid>` with `O_EXCL|O_NOFOLLOW` and mode 0600, counting bytes
     and aborting at the cap.
   - A storage-admission reservation is taken first (the existing `storage-admission.mjs`).
   - Rate limit: 30 uploads per minute per session.
2. **Sniff.** The first 64 bytes must match the declared kind: PNG, JPEG, WebP, GIF (static, first
   frame, stage 1), MP4/MOV `ftyp`, WebM/MKV EBML, MP3 ID3/sync, M4A `ftyp`, WAV `RIFF….WAVE`, or
   Ogg. **Everything else is rejected**, including SVG (the image's FFmpeg has `librsvg`, so SVG
   must never reach it), HEIC, PDF, archives, and fonts. No font uploads in stages 1–2 (FreeType
   parser surface, and licensing).
3. **Normalize** in `python -m ai_clipper.assets ingest`: no shell, input through
   `/proc/self/fd/N`, a **forced demuxer** from the sniff (`-f png_pipe|mov|matroska|…`, never
   auto-probe), `-protocol_whitelist file,pipe`, `-threads 2`, `RLIMIT_AS` 2 GiB, CPU-time and
   wall timeouts (image 20 s, audio 60 s, video 10 min), non-root (the container already runs
   this way).

   | Kind | Output | Caps |
   |---|---|---|
   | Image | first frame → RGBA → PNG. **Ancillary chunks stripped** (keep IHDR, PLTE, tRNS, IDAT, IEND), which drops EXIF/GPS and colour tags `[R3 bug 2]`. Written in about 40 lines of Python with no Pillow, which is not in the image. | ≤ 4096², ≤ 16.7 MP (reuse `_verify_raster` `[R1]`) |
   | Video | H.264 High yuv420p CFR at the document fps, longest side ≤ 1920, GOP 0.5 s, BT.709 tags, AAC 48 kHz or no audio, `+faststart`. **The same file feeds the preview decoder and the render**, which gives parity. | ≤ 10 min |
   | Audio | AAC-LC 48 kHz stereo 192k, with integrated LUFS measured (`ebur128`) into the probe JSON | ≤ 15 min |

4. **Identity.** An asset is `sha256(normalized bytes)`. The original upload is deleted after
   ingest. `name` is kept for display only: NFC, ≤ 120 chars, separators and controls stripped.
5. **Use.** Documents reference assets by ID only. The compiler resolves them to
   `analysis/assets/<sha>.<ext>` or `_workspace/library/…` through a fixed root (the worker now
   receives the roots, fixing `[R1 D3]`). Client paths never reach FFmpeg.
6. **Serving.**
   - headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none';
     sandbox`, `Cross-Origin-Resource-Policy: same-origin`, and `Content-Disposition: inline;
     filename="<sanitized>"`;
   - Range for media;
   - immutable cache.
7. **Quotas.** Per job ≤ 2 GB of assets and ≤ 300 files. The workspace library is ≤ 10 GB. All
   are configurable through env, following the existing `JOBS_STORAGE_*` pattern.
8. **Licensing.** Library music and SFX require `{owner, id, attribution, url}` or they are not
   listed. User uploads carry `owner: "user"` and a one-time warning about Content ID.
9. **Tests (QG-14).** A fuzz corpus:
   - truncated and malformed PNG, JPEG and MP4;
   - PNG/ZIP and MP4/HTML polyglots;
   - SVG renamed to `.png`;
   - decompression bombs (a 30000×30000 PNG header);
   - a 10-hour silent MP3;
   - MKV with external references;
   - HLS playlist text renamed to `.mp4`;
   - path-traversal file names.

   Each must be rejected or normalized safely within its time cap.

Session hardening (from R1 §8, required before exposing uploads):
- server-side session IDs with a denylist on logout, instead of stateless 30-day tokens;
- a CSP with `frame-ancestors 'none'` on the editor pages;
- self-hosted fonts in place of the Google Fonts `@import`.

---

## 7. AI features in the editor (free-first LLM layer)

### 7.1 Rules for every AI feature

1. **Deterministic first.** Every task returns a heuristic result within 300 ms from local code
   (`hook_heuristics.py`, the gap classes, lexicons). The LLM result is added when it arrives.
2. **Async and never blocking.** `POST …/ai/:task` → 202. A Python process runs the task with an
   **overall deadline of 45 s**; `llm.py` timeouts are per request and multiply across failover
   `[REPO plan §llm.py]`. The UI polls every 1 s and shows ghost cards. On failure it shows "Saran
   AI belum tersedia (kuota/koneksi); pakai saran otomatis" (AI suggestions not available because
   of quota or connection; using automatic suggestions) with the `LLMError.code`.
3. **Grounded in the edited clip.** Prompts use the **current visible transcript** after
   removals and word edits, with IDs `L0001…` per sentence unit, so suggestions match what the
   viewer will hear.
4. **Small prompts.**
   - The system prompt is a short excerpt of `standar_klip_ai.md` (§6 archetypes and §8 packaging,
     about 1.2k tokens), not the full 11.4 KB standard (about 3.8k tokens).
   - The user prompt is the clip transcript, about 400–900 tokens for 160–400 words.
   - `max_output_tokens` is 800–1,200, with `reasoning_effort="low"` where supported.
   - Target: ≤ 3k tokens per call, the size that answered in 3.3–14.7 s on the free provider
     `[UX-M6]`.
5. **Validated like selection.** The client does no schema validation `[REPO plan]`, so every
   field is validated in Python. Invalid items are dropped and the rest kept, and the
   drop reasons are stored.
6. **Cached and recorded.** `create_llm_client_from_env(cache_dir=<job>/analysis/llm-cache)`,
   keyed by the full request. The suggestion file stores `prompt_version`, provider, model, usage
   and latency. The API key never appears `[REPO llm.py]`.
7. **Privacy switch.** `POTONGIN_LLM=off` or no configuration hides the ✨ buttons and leaves the
   heuristics. Only the clip's own transcript is sent, never the whole episode.
8. **Optional editor-specific model chain.** An additive `POTONGIN_LLM_EDITOR_MODELS` (a comma
   list) lets fast models serve editor tasks while selection keeps larger models. It is
   implemented as `load_llm_configs(env, purpose="editor")`.

Prompt files (versioned) live in `src/ai_clipper/prompts/`: `editor_hooks_v1.md`,
`editor_condense_v1.md`, `editor_keywords_v1.md`, `editor_broll_v1.md` and
`editor_packaging_v1.md`. The task code is `src/ai_clipper/editor_ai.py`.

### 7.2 Hook text suggestions (F5)

**Output contract:**

```json
{"hooks": [{"text": "…", "archetype": "curiosity_gap", "style": "pertanyaan|klaim|penasaran|angka|kutipan|lucu",
            "emphasis": ["kata"], "label": "LUCU|FAKTA|PLOT TWIST|…|null",
            "quote_line": "L0007|null"}]}
```

| Aspect | Rule |
|---|---|
| Request | 6 variants over different styles, ≤ 60 chars (or the design's `max_chars`), tone from the chips |
| Validation | length; the archetype maps through `normalize_archetype`; every capitalized token (names) must appear in the clip transcript, else the item is dropped as `ungrounded_name`; a `kutipan` (quote) must reach `quote_overlap ≥ 0.6` against the referenced line (the `llm_selection.quote_overlap` helper); no URLs, @handles or hashtags; emphasis words must appear in the text |
| Heuristic set (instant) | the V3 `hook_text`; the hook unit excerpt (`hook_heuristics._excerpt` made public as `suggest_hooks_heuristic(units, k)`); a question form when the first unit `is_question` |
| UI | ghost cards under the hook box. Click to apply (`ApplySuggestion`); hover previews the card on the stage through JASSUB; "Lagi" (more) regenerates with a new seed |

### 7.3 Cold-open suggestions (F4)

- **Heuristic (instant):**
  - the V3 `cold_open`;
  - the V3 `hook_unit_id` unit;
  - the top 3 units in the clip scored by `hook_heuristics` quotability.

  Each is trimmed to 0.5–8.0 s at word boundaries (§2.11.1).
- **LLM (optional):** ranks those candidates and may propose one `quote_line` of its own. The
  result is checked against the cold-open rules.
- **UI:** a list under the cold-open card, each with ▶ audition of the resulting first 6 s.

### 7.4 "Padatkan ke N detik" (condense to N seconds; F3)

This is the main AI tightening feature, justified by `[UX-M2]`: gap removal alone saves only
about 2%.

- **Input:**
  - numbered sentence units with their durations;
  - the hook unit and payoff flags from V3 (`hook_unit_id`, and the payoff from
    `ClipProposal.payoff_unit` if it was persisted: an additive field to add in Stage 1A);
  - the target N.
- **Output:** `{"drop": ["L0004", "L0011"], "reason": "…"}`.
- **Validation:**
  - never drop the hook or payoff units, the body occurrence of the cold-open line, or the first
    unit when it is the setup question (the standard §3);
  - the resulting duration is within N ± 10%;
  - dropping creates removals through §2.11.2;
  - more than 12 new cuts is rejected with "terlalu banyak potongan" (too many cuts).
- **Heuristic fallback:** drop the units with the lowest (`loudness_z`, question/answer relevance)
  score. Units containing laughter are never dropped.
- **UI:** strike-through ghosts in the transcript with "Terima semua / satu-satu" (accept all /
  one by one), plus a ▶ preview of the condensed version.

### 7.5 Keyword emphasis ("AI tandai kata kunci"; F5)

- **Contract:** `{"cues": [{"cue": 12, "word": "w048140"}]}`, at most 1 per cue.
- **Validation:** the word is in the cue; no protected particles; no pronouns.
- **Heuristic:** numbers and amounts ("Rp", "juta", "%"), capitalized non-initial tokens, else
  the longest content word.
- **Apply:** one transaction of `SetWordFlags{emphasis}`.

### 7.6 B-roll suggestions (F9)

- **Contract:**

  ```json
  {"items": [{"line": "L0006", "phrase": "motor ninja", "query_id": "motor ninja kawasaki",
              "query_en": "kawasaki ninja motorcycle", "kind": "photo|video|meme"}]}
  ```

  At most 5 items, at most 1 per 8 s.
- **Stage 1B:** suggestions are **ghost markers on the B-roll lane** ("Tambah gambar: motor ninja
  @ 00:12"). Clicking one opens the media tab filtered to the user library and upload.
- **Stock search** (Pexels and similar) is stage 3, because it needs licence handling `[R2 C1]`.
- **Validation:** the phrase appears in the referenced line; there are no person names unless the
  person is discussed as the subject (the user decides).

### 7.7 Packaging after edits

"Buat ulang judul & deskripsi" (regenerate title and description) reuses the §8 packaging
contract of `standar_klip_ai.md` with the edited transcript. The limits come from `llm_selection`:
`MAX_TITLE_CHARS` 70, `MAX_DESCRIPTION_CHARS` 300, `MAX_HASHTAGS` 6 (and `MAX_HOOK_TEXT_CHARS` 60
when a hook is regenerated too). It is shown as a diff before applying.

### 7.8 Deterministic "AI-like" features (no LLM)

These are Rapikan (§1.4.3), laughter extension (F2), SFX suggestions (a whoosh at the cold-open
join, a pop on emphasized words, at most 1 per 5 s; stage 2), and the source-credit auto-fill.
They are labelled "Otomatis", not "AI".

### 7.9 AI quality gates (QG-15)

- **Automatic, on the 48 gold moments × the configured free chain:**
  - 100% of accepted hooks within limits;
  - 0 ungrounded names;
  - quote grounding ≥ 0.6;
  - condense results within target ±10%, with 0 hook or payoff drops;
  - p50 latency ≤ 15 s;
  - a failure rate ≤ 10%, with a heuristic present in 100% of cases.
- **Human:** the owner rates hooks and condense results on 20 moments with a 1–5 rubric
  ("bikin berhenti scroll?", does it stop the scroll; "setia isi?", is it faithful to the
  content). The median must be ≥ 3.5, and the LLM must beat the heuristic set on ≥ 60% of pairs.
  Otherwise the LLM path ships disabled and only heuristics show.

---

## 8. Staged delivery plan and quality gates

### 8.1 Gate catalogue

These consolidate R1 G1–G8, R2 G-*, R3 §9 and this proposal. A feature ships only when every gate
listed for it is green.

| Gate | Check | Threshold |
|---|---|---|
| QG-01 Determinism | Same document, assets and engine → identical `RenderPlan` hash and identical ASS; schema drift test | exact |
| QG-02 Conformance | Python vs JS vectors: time map, anchors, cue derivation, ASS text, camera sampling, envelopes, snapping | byte-identical outputs, ≥ 500 vectors in total |
| QG-03 Text parity | JASSUB vs server libass | SSIM ≥ 0.9995, max ≤ 16, 0 px above 32 |
| QG-04 Composite parity | live compositor vs lossless reference | SSIM ≥ 0.99, PSNR ≥ 35 dB, px above 64 ≤ 0.05%, bbox ±1 px, temporal offset 0 |
| QG-05 Audio parity | OfflineAudioContext vs FFmpeg PCM | envelope error < −40 dB, fades ±1 ms |
| QG-06 Round trip | seed compiled vs V3 auto render (same engine) | identical video stream hash. Against the legacy auto render (Stage 0 switch only; frames matched by timestamp, since the legacy output keeps the source fps): SSIM ≥ 0.98 and caption bbox ±2 px |
| QG-07 Container | ffprobe | h264 High, yuv420p, W×H, SAR 1, CFR fps, BT.709 tags, AAC-LC 48 kHz stereo, `+faststart`; video frames = `total_f` exactly |
| QG-08 Loudness and clicks | `ebur128`; sample-step scan at cuts | −14 ±1 LUFS, TP ≤ −1 dBTP (when normalize is on); step at cuts < −40 dBFS |
| QG-09 Sync | per-stream durations; tone-burst test | A/V end offset ≤ 1 frame after 20 cuts, a cold open and a transition; word onset ±1 frame |
| QG-10 Safe zone | geometry validator plus golden bbox | all text and stickers inside the preset unless overridden; tilted corners inside the frame |
| QG-11 No silent fallback | negative tests | no face, missing font, emoji, asset, unknown op or pack → explicit error or warning code |
| QG-12 Undo and persistence | property test | 10k random command sequences: undo-all equals the initial state, redo-all equals the final state; autosave → reload is equal; conflict rebase has no lost updates |
| QG-13 Performance | Playwright traces on the reference device; render timer in the production image | the §1.6 budgets and §5.5 budgets |
| QG-14 Security | fuzz corpus, auth/CSRF/path tests, header checks | all rejected or safely normalized; no 5xx; caps hold |
| QG-15 AI | §7.9 | as stated |
| QG-16 UX acceptance | moderated sessions (§8.6) | stage-specific task times; 100% completion; no open severity-1 issue; SUS ≥ 75 |
| QG-17 i18n and accessibility | lint for untranslated strings; axe-core on the editor shell | 0 untranslated; no critical axe violations; every action reachable by keyboard |

### 8.2 Stage 0: "Satu mesin" (one engine; foundations, no new UI; about 5–6 engineer-weeks)

| Deliverable | Files |
|---|---|
| Schema, validator, JSON Schema emit, Ajv standalone | `edit_v2/schema.py`, `validate.py`, `schemas/potongin.edit.v2.json`, `web/lib/edit-v2/schema.generated.mjs` |
| Time map, anchors, captions (derive, layout, ass), hooks, legacy packs `v3-classic`, `v3-karaoke`, `v3-bar` | `edit_v2/*`, `resources/style-packs/v3-*`, `web/lib/edit-v2/*` (JS ports + vectors) |
| Font pack (OFL) + metrics tables + `fontsdir` in the image | `resources/fonts/**`, `Dockerfile` |
| Compiler + runner + verify; plate blur; fps 30; BT.709 tags; 48 kHz; two-pass linear loudness; frame-index enables; duration-scaled timeout; `-progress` liveness | `compile_ffmpeg.py`, `render.py`, `verify.py` |
| Camera plan artifact (port of the current face tracking) + `sendcmd` | `camera_plan.py`, `camera.py` |
| `clip_id`, `source.json`, words artifact builder, gap classes, laughter spans | `selection_v3.py` (additive), `edit_v2/words.py` |
| **V3 auto render goes through seed → compile → render** behind `POTONGIN_RENDER_ENGINE=v2` (default on after the gates pass) | `pipeline.py` |
| Media prep: window proxies, peaks, filmstrip at the end of the job; lazy scrub proxy | `media_prep.py`, `web/scripts/run-job.mjs` stage |
| `versioned_document.py` extraction, receipt pruning, archive janitor, output key with fingerprint, render cancel, asset roots in the worker | `versioned_document.py`, `render_queue.py`, `render_worker.py` |
| V2 editor made read-only, plus migration | `migrate.py`, route redirect |

**Exit gates:**

- QG-01 and QG-02 (≥ 300 vectors at this stage).
- QG-03 for the legacy packs and design.
- QG-06: new engine vs the legacy auto render on the 4 benchmark episodes × 5 clips, SSIM ≥ 0.98.
  Legacy ASS bytes are identical for `v3-classic` and `v3-karaoke` on 50 fixture cue sets.
- QG-07, QG-09, QG-11.
- QG-13 renders: the new auto render is **≤ the legacy wall time** on the same clips (expected
  −30% from the plate `[R3]`), and 12 proxies per job ≤ 2 min CPU.

### 8.3 Stage 1A: "Poles cepat" (fast polish; about 10–12 engineer-weeks)

**Scope:**
- F1–F5, F11 (export), F13 (history), and undo, autosave and rebase;
- the preview engine (decode, audio clock, WebGL2 ops: range/cut, crop/scale, camera crop, plate,
  fade, overlay), JASSUB, the truth-frame endpoint, the parity sentinel, the server-segment
  fallback;
- the 8 caption packs and 9 hook designs;
- AI: hooks, cold open, keywords, condense (§7.2–7.5), packaging (§7.7);
- Rapikan.

**Performance budgets:** all of §1.6 except dress-up items.

**UX acceptance (QG-16, 1A tasks):**
- T-POLISH-A (trim to a laugh, fix 2 words, delete one sentence, pick an AI hook and a design,
  switch to Kotak Hitam, export) has a median ≤ 3 min;
- first-time users succeed without help after a 5-minute onboarding video;
- "Kembali ke versi AI" is found in ≤ 20 s.

**Exit gates:**
- QG-01 to QG-13, QG-15, QG-16, QG-17;
- QG-14 for auth, CSRF and the frame/segment endpoints (inline document size and rate caps).

### 8.4 Stage 1B: "Dandani" (dress up; about 10–12 engineer-weeks)

**Scope:**
- F6–F10 and F12;
- asset upload and library, brand kit and source credit;
- emoji (Noto PNG);
- B-roll (cutaway, PiP, split, fades, Ken Burns through `zoompan`);
- music library + ducking + SFX pack;
- layouts: face-track editing, split, fit-blur and fit-black, branded frame;
- **smart speaker** (YuNet + speaking-seat estimation);
- templates and apply-all with a diff;
- a batch export queue;
- the cover frame.

**Feature-specific gates:**

| Feature | Gate |
|---|---|
| Smart speaker | On 10 labelled two-speaker clips (the gold episodes), the active speaker's face centre is inside the crop in **≥ 97% of speech frames**; no switch within 1.0 s; pan ≤ 6% W per 100 ms `[R2 M11]`. **If this is not met, smart speaker stays off** and face-track + manual speaker chips ship. |
| Laughter spans (for "sampai tawa selesai" and Rapikan protection) | precision ≥ 0.8 on 30 labelled events, else points only |
| Emoji | frame check: the emoji bbox has > 3 distinct hues in the production image `[R2 M10]` |
| B-roll and overlays | timing ±1 frame; 5 overlays on a 60 s clip within the 0.5× render budget; VFR phone video normalized with no drift over 10 s |
| Music | during speech, music RMS is ≥ 8 dB below voice; it recovers within 600 ms; QG-05 |
| Templates | apply to 12 clips as one batch; manual overrides preserved in `skip_overrides` mode; undoable per clip |
| Uploads | QG-14 fuzz corpus green before the upload route is enabled |

**UX acceptance:** T-POLISH-B (T-POLISH-A + logo from the brand kit + credit + emoji on the
punchline + music with ducking) median ≤ 4 min; "template + export 12 clips" ≤ 3 min of user time.

### 8.5 Stage 2: "Mode Pro" (the CapCut core; about 14–18 engineer-weeks)

**Scope `[R2 §6]`:**
- the Pro timeline: track headers, add/lock/hide/mute, move between tracks, ripple/roll/slip/slide,
  Q/W, Ctrl+Shift+D;
- keyframes with easing presets (transform, opacity, volume, camera pan) through per-frame
  `sendcmd`;
- punch-in zoom (`zoompan`);
- transitions: the deterministic xfade subset + `acrossfade` of equal length, **no `dissolve`**
  `[R3]`;
- effects: punch-in, shake, flash, vignette, `eq`, LUT `.cube` upload (a validated parser,
  ≤ 65³);
- text animations in/out/loop through ASS `\t`, `\move`, `\fad`;
- the SFX library + deterministic SFX suggestions;
- masks (rounded rectangle and circle via a shared generated alpha-mask asset);
- multi-aspect export (9:16, 1:1, 4:5, 16:9) with per-aspect layout overrides;
- a cover card and a comment-reply card (pure ASS vector + text + optional avatar image);
- a caption animation pack 2 (neon, comic, bounce, shake);
- the wordbar retime.

**Non-portable operations use the "derived intermediate asset" rule.** These are speed changes
with pitch-preserving audio (`rubberband`, available in the production image), audio clean-up
(`afftdn` or `arnndn`), and GIF or animated-sticker transcodes. **The server renders them once**
into `derived/<sha(op, inputs)>.<ext>`, and both the preview and the render consume that same
file. This gives parity by shared bytes, and it resolves R3's "speed ramps cannot keep audio
parity". The preview shows a spinner on that item for the 0.2–2 s build.

**Gates:**
- every op has goldens (QG-03, QG-04, QG-05);
- xfade is verified per transition name against FFmpeg 5.1.9;
- the stage-2 render budget is ≤ 0.6× (the measured stage-2 graph was 0.53× `[R2]`);
- 50 items at 60 fps interaction;
- UX: CapCut users complete "split, delete, add transition, keyframe a zoom" without help, with a
  median ≤ 2 min.

### 8.6 UX acceptance protocol (QG-16)

- **Participants and setup:** 5 Indonesian clippers per stage (at least 2 LokaClip users and 2
  CapCut-only users), on the reference device at 1366×768 and 1920×1080, think-aloud, recorded.
- **Clips:** 3 per participant from the gold episodes, not seen before.
- **Measures:** task time, completion, errors, SUS, and a severity rating for every issue (1 =
  blocks the task or causes a wrong export, 2 = major delay, 3 = cosmetic). Gates: no open
  severity-1 issue, and at most 2 open severity-2 issues per stage.
- **Output-quality check:** the exported clips are checked by QG-07 to QG-10 automatically. A
  "fast" session that exports a clip failing a gate counts as a failure.

### 8.7 Feature-flag and release rules

- **Flag naming and state.** Flags are `studio.<feature>`, stored in
  `web/public/parity-manifest.<hash>.json` plus env overrides. A flag defaults off until its gates
  are green in CI on `main`.
- **Owner ramp.** Features ramp to the owner first (a single-user system), with telemetry on:
  - parity-sentinel SSIM;
  - render failures by gate;
  - autosave conflicts;
  - AI failures by `LLMError.code`.
- **Kill switch.** Any gate regression in production (for example sentinel SSIM p5 < 0.98 for an
  op) flips that op's flag off automatically. The document stays editable; the op's items render
  through the server preview.

---

## 9. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Scope: "CapCut + LokaClip" is several person-years in commercial products | High / High | Strict staging; Mode Pro only after 1A and 1B meet the gates; §10 cuts; op gating hides anything unfinished |
| libass or JASSUB version skew, or GPU/driver differences (Safari, Firefox) | Medium / Medium | Pinned versions; golden suite in the production image; sentinel + auto kill switch; Safari and Firefox report-only |
| Word timing quality (YouTube captions: up to 4.7% zero-length words; Whisper drift) makes snapping and captions look off | Medium / Medium | 10 ms peaks refine cut points; the `tight_cut` warning with audition; stage-2 wordbar retime |
| Voiced-gap removal clips speech (66% of long gaps are voiced `[UX-M2]`) | High if automated / High | Never pre-checked; audition; condense works at sentence granularity; stage-3 acoustic filler classifier only with precision ≥ 0.9 on 200 labelled tokens `[R2 M4]` |
| Weak face detection (Haar cascade today) makes face-track and smart speaker wrong | Medium / High | Camera plan as editable data; YuNet in 1B behind the 97% gate; no silent centre crop (`no_face` warning) |
| Low-resolution sources (the eval downloads are 640×360 AV1) look soft at 1080×1920 | High / Medium | `low_res_source` warning; recommend ≥ 720p downloads in the downloader settings; text is rendered natively at the output resolution anyway |
| One CPU box shared by transcription, selection, renders, proxies and truth frames | Medium / Medium | nice levels, semaphores, priorities (§5.5); proxies only for selected clips; truth frames cancelled when superseded |
| Storage growth (proxies about 20 MB per clip window; the scrub proxy about 120 MB per hour) | Medium / Low | Storage admission; lazy scrub proxy; retention policy |
| Free LLM tiers: rate limits, latency 3–28 s, quota exhaustion | High / Low (heuristics exist) | Async, deadline, cache, editor model chain, heuristic always shown |
| Licensing: LGPL FriBidi inside the JASSUB WASM; GPL FFmpeg if the image is distributed; music rights | Medium / Medium | Notices page + source links; legal review before GA `[R3 §10]`; licensed library only |
| COOP/COEP breaks third-party embeds on editor pages | Low / Low | Scoped to editor routes; everything self-hosted |
| Conflict rebase bugs lose edits | Low / High | QG-12 property tests; IndexedDB draft; archive retention |
| The metrics tables diverge from libass shaping (kerning, ligatures) | Medium / Low | Spacing only, not parity; golden word-gap tests; fonts limited to Latin sets for captions |

---

## 10. What we will NOT build (and why)

| Not building | Why | Instead |
|---|---|---|
| ffmpeg.wasm preview | 32 MB, GPL to every browser, no AV1, 0.9× realtime `[R3]` | The WebGL2 + JASSUB engine |
| DOM/CSS captions or any browser-only effect (CSS filters, Canvas `filter`, Lottie) | SSIM 0.976–0.990 at best; no `\k` or `\t` parity `[R3]` | JASSUB; pre-rasterized derived assets |
| Remotion, Editframe, DesignCombo, Twick, Shotstack, etro | Licences (company, commercial, non-compete, GPL) or telemetry `[R3 §7]` | Own timeline (about 2.5–3.5k lines) |
| `sidechaincompress` ducking | Not reproducible in WebAudio | An explicit envelope (exact `[UX-M5]`) |
| "Hapus semua kata pengisi" (remove all fillers) as one blind button | 78% of long gaps are not silent; transcripts lack fillers `[UX-M1, M2]` | The Rapikan review list and condense |
| Arbitrary z-interleaving of text between images | Needs multiple ASS passes and multiple JASSUB canvases; rare need | Three bands: under-text, text, over-text |
| Segment-level smart re-render and stitching | x264 GOP and AAC priming seams risk visible and audible glitches; a full render is already ≥ 2× realtime | Idempotent whole renders + cache by document hash |
| Real-time multi-user collaboration (CRDT) | Single-user product; high complexity | ETag + rebase + checkpoints |
| Full mobile editor | Screen size; WebCodecs and WebGL variance on phones | Mobile review, hook and caption text edits, and export |
| User font upload | FreeType attack surface, licensing, metrics tables must be built | A curated OFL pack; request fonts through releases |
| Client-supplied ASS, filtergraphs or plug-ins | Injection surface; undermines determinism | Server regenerates from the validated document |
| Generative video (eye contact, morph cuts, background removal on CPU) | GPU-bound, ethics, quality `[R2 C4, C6, C7]` | Out of scope |
| Stock-media search and TTS in stages 1–2 | Licensing and quality work `[R2 C1, C2]` | Stage 3 candidates |
| Bézier graph editor for keyframes | High UI cost, low value for podcast clips | Easing presets |
| Automatic re-render of all legacy auto clips on engine change | Wastes CPU; the owner's old exports are fine | Re-render on demand ("Render usang" badge) |

---

## Appendix A: Measurements made for this proposal

All scripts and outputs are in `editor-design/ux/`. The machine is a Ryzen 7 5700G (16 threads).
The production image is `ai-video-clipper:latest` (FFmpeg 5.1.9, libass 0.17.1, numpy 2.4.6, no
Pillow). The browser is Chrome for Testing 147.0.7727.15 headless with SwiftShader; the lab
server sends COOP/COEP, so `crossOriginIsolated=true`.

| ID | Script | Result |
|---|---|---|
| UX-M1 | `tighten_stats.py` → `tighten_stats.json` | 48 gold moments over 4 episodes. Duration median 69.2 s (p90 87.7, max 134). Words median 159.5 (p90 223, max 398). Transcript filler tokens median 0 (max 2). Repeat suggestions median 3 (max 9). Protected particles median 14.5. "Shorten every gap > 600 ms to 200 ms + remove filler tokens" gives 8 cuts median (p90 14, max 20) and saves 6.47 s median (11.3%, max 25.6%). Zero-length words median 0% (p90 1.2%, max 4.7%). Word JSON median 7.2 KB (max 17.9 KB). Whole-episode filler counts: Whisper `transcript.json` 8–13 per episode (about 1 per 1,000 words); YouTube `transcript.yt.json` 66–114 (7.0–11.9 per 1,000; mostly `ee`, `eh`, `hm`). |
| UX-M2 | `gap_classes.py`, `safe_tighten.py` | 414 gaps > 600 ms: silent 92 (22%, 93 s), laughter 49 (12%, 100 s), voiced 273 (66%, 277 s); a median of 5 voiced gaps per moment. The safe policy (silence ∩ gap, laughter-protected) saves 1.23 s median (1.9%), p90 3.34 s, max 6.24 s, with 2 cuts median (max 8). Caveat: `audio_timeline` silences use a relative floor + 6 dB and 100 ms frames, so borderline room tone counts as voiced. The classes are a conservative default, not ground truth. |
| UX-M3 | `jumpcut_bench.py` → `jumpcut_local.json`, `jumpcut_prod.json` | 0dzvz9JZFIM G3, 21 kept ranges, 88.2 → 67.79 s, source AV1 640×360 25 fps → 1080×1920 30 fps centre crop, x264 veryfast crf21, AAC 48 kHz, best of 2. **Production image with `--cpus=4`:** A (per-range inputs + concat) 22.69 s, B (split/trim, single decode) 22.27 s, C (select/aselect) 22.15 s. **Local with `taskset 0-3`:** 17.37 / 16.79 / 16.76 s. A/V end difference: A and B −4 ms; C −53 ms (and no fades possible). Video 67.867 s against 67.79 s expected (+77 ms from per-range frame rounding, hence the §2.2 quantization). |
| UX-M4 | `lab/www/jassub_edit.html`, `jassub_edit_bench.mjs` | JASSUB 2.5.16, 1080×1920, 520 events (260 words × base + pop event, `\t` scale animation), 57 KB of ASS. **Scrub render p50 14.43 ms, p95 28.97 ms, max 60.0 ms (300 renders). `setTrack` (full document) + render p50 14.40 ms, p95 23.92 ms (40 edits).** Frame `jassub_edit_frame.png` shows the base-plus-active double-draw that §2.6 step 5 avoids by splitting base events. |
| UX-M5 | `duck_envelope.py`, `webaudio_env.mjs`, `cmp_env.py` | 60 s at 48 kHz, 5 speech spans, −10 dB, attack 30 ms, release 400 ms. FFmpeg 5.1.9 `amultiply` with an f32 envelope vs the numpy reference: **max abs error 0.0** (0.107 s). Chrome 147 `OfflineAudioContext` + `linearRampToValueAtTime` vs the FFmpeg envelope: **max abs diff 2.98e-7, −153.3 dB**. |
| UX-M6 | read from `artifacts/eval/Ive926sC6mc/llm-cache/*.json` | ollama-cloud `gpt-oss:120b`: 4,073–4,605 input tokens → 3.32–14.70 s (1,012–3,654 output tokens); 26,486–27,051 input → 19.0–27.8 s (4,922–7,843 output); `gemma4:31b` at 27k input → 42.4 s. |

Production-image filters confirmed present: `amultiply`, `asendcmd`, `sendcmd`, `zoompan`, `xfade`,
`boxblur`, `lut3d`, `loudnorm`, `ebur128`, `aevalsrc`, `alphamerge`, `colorchannelmixer`. The
build includes `librubberband`, `librsvg`, `libass`, `libfribidi` and `libwebp`. `fc-list`
reports 6 fonts, all DejaVu.

## Appendix B: New and changed files (overview)

| Area | Files |
|---|---|
| Python engine | `src/ai_clipper/edit_v2/` (§5.1); `versioned_document.py`; `camera_plan.py`; `media_prep.py`; `assets.py`; `editor_ai.py`; `prompts/editor_*_v1.md`; additive `clip_id` in `selection_v3.py`; `pipeline.py` V3 path via seed → compile |
| Resources | `resources/fonts/**` (TTF + OFL + metrics), `resources/style-packs/**`, `resources/hook-designs/**`, `resources/emoji/noto/**`, `schemas/potongin.edit.v2.json` |
| Web | `web/app/projects/[id]/clips/[clipId]/edit/page.jsx`; `web/components/editor/**` (TopBar, panels, Stage, Timeline Cepat/Pro, Inspector); `web/lib/edit-v2/**` (schema.generated, validate, timemap, anchors, captions, hooks, camera, audio-env, commands, store, history, autosave, rebase, snapping, tighten); `web/lib/preview/**` (§4.2); routes under `web/app/api/jobs/[id]/clips/**`, `web/app/api/assets/**`, `web/app/api/resources/**`, `web/app/api/workspace/**` |
| Tests | `tests/fixtures/edit-v2/vectors/**`; `tests/golden/editor-v2/<case>/**`; `tests/test_edit_v2_*.py`; `web/tests/edit-v2-*.test.mjs`; `web/e2e/studio-*.spec.mjs`; `tests/security/upload-fuzz/**` |
| Retired | `render_manifest._build_ass` and `_layout_filter`, `candidate_cues.py` (V3 path), the V2 editor UI (read-only) |

## Appendix C: New dependencies

| Package | Version | Licence | Use |
|---|---|---|---|
| jassub | 2.5.16 (pinned exact) | MIT wrapper; WASM bundles LGPL-2.1+ FriBidi, FTL FreeType, ISC libass, MIT HarfBuzz | caption and hook rendering in the browser |
| mediabunny | 1.59.1 | MPL-2.0 | WebCodecs demux and decode |
| immer | 11.1.18 | MIT | patches and undo |
| zustand | 5.0.15 | MIT | editor store |
| ajv | 8.20.0 | MIT | standalone validators |
| @tanstack/react-virtual | 3.14.13 | MIT | whole-source transcript search list |
| idb-keyval | 6.3 | Apache-2.0 | local drafts |
| ssim.js | 3.5.0 | MIT | parity sentinel |
| hls.js | 1.7.3 | Apache-2.0 | server-segment fallback |
| fontTools (Python, build-time only) | 4.66.0 | MIT | font metrics tables |
| Fonts: Montserrat, Poppins, Anton, Oswald, Plus Jakarta Sans, Courier Prime, Lilita One, Bangers, Inter, DejaVu | pinned by sha | OFL-1.1 (DejaVu: Bitstream Vera licence) | packs and designs `[R2 §7.4]` |
| Noto Emoji images | pinned | Apache-2.0 | emoji overlays |

Versions were checked on npm and PyPI on 2026-09-24: ajv, @tanstack/react-virtual and fontTools
for this proposal; the rest by R3.
