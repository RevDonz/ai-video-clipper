# Kritik adversarial: Editor V3 Esensial (PLAN.md, versi 2026-09-24 15:27)

Reviewer: adversarial critic (subagent). Evidence was checked against the repo
(`feat/selection-v3-llm`, read only), `FINAL-editor-design.md`, `r1-existing-editor.md`,
`r3-tech.md`, `proposal-parity-first.md` and `spike-pf/`. Nothing in the repo was changed except
the plan copy at `docs/plans/2026-09-24-editor-v3-esensial.md`.

Ringkasan (ID): rencananya kuat di model data, keamanan penyimpanan dan gerbang waktu. Tetapi
ada lima masalah besar:
1. klaim "pratinjau caption = hasil akhir" terlalu luas, karena MP4 akhir selalu 4:2:0 dan
   terkompresi;
2. "revisi 0 = klip otomatis" rusak setiap kali image Docker dibangun ulang;
3. saran AI mengabaikan pengaturan LLM yang disimpan, dan proses anak mewarisi rahasia server;
4. anggaran 30 agen tanpa cadangan tidak realistis;
5. ada beberapa fitur di luar daftar pemilik.

Semua temuan di bawah sudah diterapkan di PLAN.md (kolom "Applied in").

Severity: **H** = would break an owner requirement or security. **M** = would cause rework, a
flaky gate or a wrong claim. **L** = polish.

---

## A. Full-quality path per feature (preview = render)

| # | Sev | Finding | Evidence | Fix | Applied in |
|---|---|---|---|---|---|
| A1 | **H** | **The caption "identical" claim is broader than P-TXT proves.** P-TXT compares JASSUB with the `reference` render, which is the lossless composite *before* the final `format=yuv420p` and the H.264 encode. The delivered MP4 is always 4:2:0 at crf 21, so coloured caption edges lose chroma resolution in every export: the karaoke highlight `#FFE14D`, emphasis colours and the box. The badge "● Sama dengan hasil akhir" is therefore an overclaim. FINAL itself says the encode loses about 0.005 SSIM (§"What identical cannot mean"), and the plan dropped that sentence. The plan also never defines whether `reference` includes the 4:2:0 step. If it does, P-TXT (0 px > 16) cannot pass on coloured text, since PF measured a max of 93 for 4:2:0. | PF `reference` = "lossless PNG of the yuv444p composite" (proposal-parity-first §926); R3/PF numbers | (1) P-TXT is defined as **raster parity** against the pre-subsampling reference; its thresholds are unchanged. (2) New gate **P-ENC**: the final MP4 against the reference must reach whole-frame SSIM ≥ 0.990 and text-region SSIM ≥ 0.980, with the baseline measured in W1 and then locked. (3) The badge becomes "● Sesuai hasil akhir", with help text: same frames, same text raster and same audio samples; the final adds H.264/4:2:0 compression; "Frame akhir" shows the exact pixels. | §0, §5.2 R5, §6.1, §10.1, C.6 |
| A2 | **M** | **444/gbrp compositing may buy little in the delivered file.** Whichever format is used for compositing, the export is subsampled to 4:2:0 afterwards. The measured gain (max 93 → 15) is against the lossless reference, not the MP4. What 444 or gbrp really buys is **colour correctness**: FFmpeg 5.1 `drawutils` converts colours with BT.601 when compositing in YUV. That alone costs +19–40% render time. | PF cost table; plan E6 | S-COLOR scores the three candidates **on the delivered MP4**: yuv420p compositing (with a colour fix if needed), yuv444p and gbrp. It picks the cheapest that passes P-COLOR and P-ENC. yuv420p composite wins when its text-region SSIM on the delivered file is within 0.002 of the best. | §2.1 E6, §5.2 R5, T1.2b |
| A3 | **H** | **Revision 0 stops being the auto render after any image rebuild.** The instant hard link happens only when `render_key` matches, and the key includes the FFmpeg and libass versions. The Dockerfile installs unpinned `apt-get install ffmpeg` on an unpinned `node:20-bookworm-slim`, so a Debian security update changes the key. After that, "export without changes" re-renders and returns a *different* file, which breaks the owner's requirement. Also, `plan_sha256` "covers the document": if that includes `revision`, `parent_sha256` or `audit`, then undoing every edit back to the seed also misses the auto file. | `Dockerfile` (no pins); plan §4.6, §5.2 R9 | (1) **Content-identity rule R10**: when the content of a document equals the seed (canonical bytes without `revision`, `parent_sha256` and `audit`), the export *is* the auto file, whatever the toolchain. (2) `plan_sha256` excludes `revision`, `parent_sha256` and `audit`. (3) T1.Z pins the base image digest and the apt versions (ffmpeg, libass9, libfreetype6, libharfbuzz0b, libfribidi0, fontconfig) and writes `resources/toolchain.json` at build time (`dpkg-query`). The render key hashes that file, not a hand-picked version string. (4) Any toolchain change re-runs P-TXT/P-TIME/P-RT in CI. | §2.1 E10, §4.4, §4.6, §5.2 R9–R10, T1.Z |
| A4 | M | **Font fallback and shaping differ by default.** Without `fallbackFont`, JASSUB falls back to its own bundled font, while libass in FFmpeg falls back through fontconfig. FFmpeg's `ass` filter uses `shaping=auto`. Montserrat ExtraBold (Bold/Box packs) was never measured; only DejaVu was [R3]. libass `BorderStyle 3` boxes (Box pack) are also unmeasured across 0.17.1 and 0.17.4. | R3 §115, §137; `captions_ass.py` (DejaVu only) | Set `ass=…:shaping=complex` explicitly, and set JASSUB `fallbackFont` to DejaVu Sans with the same file on both sides. The P-TXT matrix adds a fallback-glyph case, Montserrat and the box pack. **A pack that fails P-TXT does not ship:** Bold/Box fall back to DejaVu Sans Bold (K6), and Box falls back to a `\p` vector box. | §5.2 R5–R6, §5.4, T1.2a/b |
| A5 | M | **Face-track crop may differ by 1–2 px between plate and final.** The crop expression uses `t` with float per-piece offsets. Plate cells and final pieces have different offsets, so a floating-point difference can flip the integer truncation of `crop x`. P-PLATE says "crop rectangle exact", but no test pattern can measure crop x. | `face_tracking.build_crop_expression` (float `t`, `.3f`) | Compute crop x per **source-grid frame** from integer positions: the expression is over `n + first_sf` (integers), and positions are precomputed in Python. The T1.0 media generator adds a **column-ruler** pattern so that crop x can be decoded per frame. | §5.2 R4, T1.0, §10.1 P-PLATE |
| A6 | M | **Plate cells will not start on IDR frames.** `-g cell_frames` only caps the GOP length. x264 scene cuts insert keyframes and reset the counter, so `-f segment -segment_frames` splits at the wrong frames. | x264/segment muxer behaviour | `-force_key_frames expr:eq(mod(n\,C)\,0)` plus `-sc_threshold 0`. The TDD test "IDR at every cell start" already exists and now has a rule to satisfy. | §5.1 `plate_cells` |
| A7 | **H** | **No clipping protection with music when normalize is off (the default, K9).** `amix normalize=0` sums the signals, and source gain can reach +12 dB. True peak then exceeds 0 dBFS and clips on playback or platform re-encode. G3 runs only with normalize on. | plan §5.6, K9 | Whenever music is present or source gain > 0, the compiler measures true peak (`audio_measure`, cached by mix sha). It applies a negative gain so that TP ≤ −1.0 dBTP, with the warning `peak_reduced`. New blocking gate **G3b**. Revision 0 (no music, gain 0) is unaffected. | §5.6, §5.9, §10.2 |
| A8 | M | **Browser audio is not bit-exact as described.** `decodeAudioData` resamples to the AudioContext rate, which is the device rate (often 44.1 kHz). P-AUD is only proven server-side. | plan §6.2 | Use `new AudioContext({sampleRate: 48000})`. The browser part of P-AUD requires the AudioBuffer to equal the reference PCM within 1 LSB. The docs state that the preview samples are the final pre-encode samples quantised to s16. | §5.6, §6.2, §10.1 |
| A9 | L | The PF-LIBASS budget is [E] and assumes a full libass render every frame. With `\k` (not `\kf`), text changes only at word onsets and during hook fades. | UX-M4 | The text layer reuses the last bitmap when libass reports no change. PF-LIBASS then applies to changed frames only. | §6.2 |
| A10 | L | Jump-cut cue grouping does not say whether the 600 ms gap is measured in source or output time. | §5.4 | The gap is measured in **output time**, after cuts (identical for revision 0). | §5.4 |

## B. Scope: extras beyond the owner list, and missing items

The owner's 13 items are all present. **Extras cut or deferred** (none is in the owner's list;
each adds work, gates or risk):

| Extra | Decision | Why |
|---|---|---|
| Export at 1080×1920 and "Tinggi" quality (K14) | **Deferred to Stage 2.** Exports use the auto-clip size and quality | It doubles the derive/truth-frame/P-LOGO work, and the 720p sources gain nothing |
| Revocable server-side sessions (K10) and nonce CSP | **Deferred.** Kept: COOP/COEP on the editor route, `frame-ancestors`/nosniff on the new routes, rate limits, and the child-env allowlist | "Match the repo's posture". Uploads do not widen what a stolen token can already do (delete projects) |
| Plate pre-warm in the pipeline | **Cut** | The revision-0 `<video>` fallback already covers opening |
| G4 blackdetect/freezedetect pass | **Cut** | A full extra decode per render, for a warning |
| G5 via ASS ink bbox on rendered frames | **Simplified** to geometry from the plan | Cheap; same warning |
| Archive retention "one per hour for 7 days" | **Simplified**: revision 1 + render-referenced + newest 50 | Janitor complexity |
| Self-hosted UI fonts (remove the Google Fonts `@import`) | **Deferred** with the CSP | COEP does not block CORS fonts |
| Read-only preview under 1024 px | **Simplified** to a notice | UI work outside the owner's scope |
| Trim snapping to laughter ends | **Cut** | It contradicts the "stored value is always a `bounds` frame" rule and has no file owner in W3 (VideoLane belongs to T2.6) |

Missing or underspecified relative to the owner list:
- **B1 (M), item 4 "free-first LLM layer".** The plan's client is `create_llm_client_from_env`,
  but LLM settings are saved on the Pengaturan page (sealed in `/data/settings`), and
  `run-job.mjs` builds the engine env with `loadLlmEnv` + `engineProcessEnv`. The editor would
  ignore the owner's saved providers and keys. Fixed in §7 (also a security fix, E1).
- **B2 (M), item 4 ship rule.** The rule "LLM ships **disabled** unless it beats the heuristic on
  ≥ 60% of blind pairs" can silently remove a feature the owner asked for. Worse, the
  "heuristic" set includes the V3 `hook_text` and title, which were LLM-generated at selection
  time. Sources are now labelled ("AI seleksi", "Heuristik", "AI baru"). The hard gates are
  grounding plus usable ≥ 70%; the blind comparison is informational; K13 decides.
- **B3 (M), item 6 Indonesian cleanup.** An "immediate token repeat" rule flags ASR-unhyphenated
  **reduplication** ("hati hati", "pelan pelan", "sama sama", "masing masing") as stutters.
  Added: a reduplication exclusion (lexicon plus "content word" rule; function words and pronouns
  such as "gua gua" and "yang yang" stay candidates), a gate of 0 reduplication false positives,
  and the particles `mah toh nah kek` in the protected list.
- **B4 (L), item 11.** The legacy editor's preview-parity defects (R1 P1–P3, P15: caption
  position, size, font, crop) remain for V2 candidates. The legacy preview is now labelled
  "Pratinjau perkiraan", and "Buka di Editor V3" is offered.

## C. File-ownership conflicts inside waves

| # | Sev | Conflict | Fix |
|---|---|---|---|
| C1 | **H** | W2: T2.7's panels and e2e need `EditorApp`, the panel registry and `fakes.mjs`, which T2.6 owns and writes **in parallel**. The same problem hits W3: T3.2, T3.3 and T3.6 need their panels and lanes mounted, but the registries are integrator-owned. | **Scaffolding moves before each wave.** T1.Z lands the editor skeleton (EditorApp with slots, the panel and lane registries listing **all** Essentials panels and lanes, placeholder components, `fakes.mjs`, CSS tokens). W2 and W3 tasks *replace their own placeholder files*, and the registries do not change during a wave. T2.Z adds the W3 placeholders. |
| C2 | M | T2.2 and T2.3 both need a Python spawn helper and a rate limiter. T4.2 later "creates" `rate-limit.mjs`, which W2 already needs. | T1.Z creates `web/lib/python-cli.mjs` (with the env allowlist, E1) and `web/lib/rate-limit.mjs`. W2 and W3 import them, and T4.2 only hardens them. |
| C3 | M | T4.3's janitor "runs from the primary job queue", but no W4 task owns `web/scripts/primary-worker.mjs` or `web/lib/primary-job-queue.mjs`. | T4.3 owns `web/scripts/primary-worker.mjs` (janitor tick). |
| C4 | M | The third-party notices page (JASSUB LGPL/FTL, Mediabunny MPL, OFL fonts), which R3 requires, has no owner. | T4.4 owns `web/app/licenses/page.jsx` plus `web/public/licenses/**`. T1.2a ships the font licence files. |
| C5 | L | `docs/editor/evidence/W<n>/` is written by many agents. | One file per task: `evidence/W<n>/<task-id>-<gate>.json`. |
| C6 | L | `tests/conftest.py` does not exist today; a new one affects every test. | Fixtures only; no `autouse`. |

## D. Effort against the 3–5 workflow budget

- **D1 (H).** By FINAL's own sizing, the Essentials subset is roughly 40–55% of Stage 1
  (≈ 100–140 agent-days [E]). The plan fits this into 30 agent runs with **no reserve**, and
  every exit gate is hard. That only works if each run delivers 3–5 agent-days, which is
  plausible for M tasks and risky for the 12 L tasks.
- **D2 (M).** T1.2 is the riskiest task and is overloaded: Python captions, 4 packs, fonts,
  glyphs, the JASSUB adapter, the harness page, the fixture route, the Playwright spec, S-COLOR
  and package.json. Splitting it would put W1 at 9 agents.
- **Fixes:**
  - The cuts in §B remove roughly 10–15% of the work.
  - T1.2 is split into **T1.2a** (Python text) and **T1.2b** (browser text parity + S-COLOR).
  - T1.6 (render queue v3) merges into **T2.2**, the export path end to end. W1 stays at 8.
  - A **reserve workflow W5 (≤ 4 agents)** runs only when an exit gate fails or the owner
    requests rework (fix-forward, no new scope). The total stays within 5 workflows.
  - A written **deferral rule**: if W5 cannot close a gap, the owner defers one *whole* owner
    item behind its flag (never a half feature). Recommended order: markers (10) → the LLM part
    of 4 (the heuristic stays) → face-track in 7 (fit-blur and center-crop stay).
- **D3 (M).** The owner is needed in 6+ places, and real jobs are needed for P-LOOK and QG-AI.
  These are consolidated into **3 owner checkpoints**: before W1 (decisions), after W2 (P-LOOK
  sheets plus U1/U6/U7), and after W4 (acceptance U1–U7, QG-AI review, filler-label
  confirmation). New prerequisite **P3**: the owner provides ≥ 3 real V3 jobs readable by agents.
  No media is committed.

## E. Security

| # | Sev | Finding | Fix |
|---|---|---|---|
| E1 | **H** | **Secret leakage into child processes.** The `app` container env holds `APP_PASSWORD`, `APP_SESSION_SECRET`, `POTONGIN_SETTINGS_SECRET` and every `*_API_KEY` (`compose.yaml`). `execFile` passes `process.env` by default, so every editor Python/FFmpeg child would hold them, including FFmpeg ingesting **untrusted uploads**. A demuxer exploit there could forge sessions. | `python-cli.mjs` spawns with an **allowlisted env** (PATH, HOME, LANG, TZ, TMPDIR, JOBS_ROOT, FONTCONFIG_FILE and non-secret `POTONGIN_*` flags). Only the AI task child gets `engineProcessEnv(await loadLlmEnv())`. A QG-SEC test asserts that no secret is present in a spawned child's `/proc/self/environ`. |
| E2 | M | SSRF in AI suggestions. `llm.py` already refuses redirects (`_NoRedirect`) and non-local `http`, so the risk is low, but the plan does not forbid request-supplied provider fields. | The AI route accepts only `{task, doc}`; provider, model and base URL come only from the sealed settings. The prompt text comes only from the validated document plus the words artifact. |
| E3 | M | AI task lifecycle: "202 + poll" leaves a Python child running beyond the request, with no owner for killing it. | The Node side tracks the child, SIGKILLs it at 25 s, and the result file is written atomically. `taskId` is validated as a UUID in both Node and Python. |
| E4 | L | Upload ingest: the `mov` demuxer can follow data references; FFmpeg 5.1 does not apply JPEG EXIF orientation. | `-enable_drefs 0` explicitly. EXIF orientation is read by a stdlib parser (orientation tag only) and applied with `transpose`, or else the image is rejected with a clear message. |
| E5 | L | ASS files served to the browser contain user text. | Serve them as `text/plain; charset=utf-8` with `nosniff` and `CSP: sandbox`, like assets. |

## F. Migration of V2 edits and old jobs

- **F1 (M).** For pre-Essentials jobs, the seed is computed on the fly and **never persisted**.
  A code update then changes the virtual revision-0 ETag, the "Kembali ke versi AI" target and
  the words artifact. Fix: `POST /clips` (prepare) writes `seed.json`, words, peaks and
  `source.json` immutably, exactly as the pipeline does for new jobs. GET stays side-effect free.
- **F2 (M).** No failure states for old jobs. Added `openable:false` reasons: `source_missing`,
  `selection_unreadable`, `transcript_missing`, `analysis_incomplete` (`.attempts/`) and
  `not_v3` (V1 jobs). When sound events or the audio timeline are missing, the marker lane shows
  "tidak tersedia untuk job ini" instead of an empty lane.
- **F3 (L).** V2 candidate edits (`clip-edit-v1`) are not migrated. That is honest and already
  stated. P-LOOK must include one 60 fps source and one VFR source, because K3 changes those
  (60 → 30 fps, VFR → CFR).

## G. Gates: measurability fixes

| Gate | Problem | Now |
|---|---|---|
| P-TXT | Reference undefined (A1) | Raster vs the pre-subsampling reference, plus the new **P-ENC** on the delivered MP4 |
| P-COLOR | Measured on which file? | The **delivered MP4**, decoded as tagged BT.709, against JASSUB |
| P-PLATE crop | Not measurable with the barcode alone | Column-ruler pattern; crop x decoded per frame, 0 px |
| P-SYNC | "Audible click" cannot be observed headless | Instrumented: presented-frame timestamp against `AudioContext.getOutputTimestamp()`, ≤ 1 frame |
| P-AUD | Browser side unproven | AudioBuffer vs reference ≤ 1 LSB at 48 kHz |
| QG-CLEAN | "Listening check" | Automated: every cut edge lies inside the word gap (or is flagged `tight`) and the RMS within ±10 ms is ≤ −35 dBFS unless `tight`. Plus 0 reduplication false positives |
| QG-AI | Ship-disabled rule (B2) | Grounding hard gate; owner usability ≥ 70%; blind pairs informational |
| G3b (new) | Clipping with music | TP ≤ −1.0 dBTP on every export with music or gain > 0 |
| PF-PIPELINE | One budget hides face-track | Per layout: fit-blur/center-crop ≤ 1.35×, face-track ≤ 1.6× [E] |

## H. What is good and was kept

- The integer document, the frame-grid rule, frame-safe ASS times and the `bounds` snap table
  (single source).
- Digest-only receipts with pruning, and a side-effect-free GET.
- Server plates plus JASSUB, never approximated pixels.
- The explicit `pan`, and the envelope approach to ducking.
- The render-queue reuse, the upload quarantine with forced demuxers, and the per-task TDD
  lists.
