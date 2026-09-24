# R1: Audit of the existing clip editor (the V2-bound "Custom Clip Editor")

Date: 2026-09-24. Branch `feat/selection-v3-llm` (working tree has uncommitted V3 work by other agents; editor files audited as they are on disk).
The repo was only read, never changed. Scratch measurements are in `editor-design/measure/`: `parity_probe.py`, `speed4.py`, `save_ceiling.py`, `cli_latency.sh`, `probe-result.json`, the frame PNGs under `out/`, and the libass BorderStyle check in `bs4/`.
Resume note: `editor-design/` was empty when this run started, so this is a first full write.

---

## 0. Key points

1. **The editor only works on V2 candidates.** It can open only `cand_<sha256>` entries of `analysis/candidates.v2.json`, which only the `v2-shadow` selection mode produces. It edits a *candidate window*, not a rendered clip. **V3 clips (`analysis/selection.v3.json`) cannot be opened at all.** `SelectedClip` also has no stable ID (only `rank`).
2. **What the manifest can hold** (`ClipEditManifest`, `clip-edit-v1.0`):
   - an immutable window (no trim);
   - immutable caption cue timing, IDs and count after revision 1 (text edits only);
   - canvas fixed at 720×1280;
   - render modes `fit-blur` and `center-crop` only (`face-track` is rejected by the renderer);
   - at most 1 title and 1 logo;
   - audio `gain_db` and `normalize` only.

   It has no cold open, no hook text, no word timings, no karaoke, no keyframes, no tracks, no B-roll, no music and no transitions.
3. **Captions are a single static banner in practice.** On first GET, the backend creates revision 1 with **one cue that spans the whole candidate** and holds its whole text (≤500 chars). Once revision 1 exists, cue bindings are immutable. The page loads segment cues from `/caption-cues` but never uses them.
   - Measured: the final render shows only the first ~64 chars (2 lines × 32) for the entire clip, cut mid-word ("…cukup panjang untu…").
4. **Seven measured render/preview defects:**
   - (a) `background_opacity` has no effect. The caption box is always opaque black: measured fill RGB (4,4,4) at opacity 0.3, 0.65 and 1.0. The expected value at 0.65 is about 45.
   - (b) ASS backslash escaping is broken. Typing `\N` or `\h` in a caption forces a line break or a hard space (screenshot).
   - (c) `normalize=true` outputs **96 kHz** AAC, because single-pass `loudnorm` upsamples to 192 kHz.
   - (d) The preview puts bottom captions at y = 78% (centre). The render puts them at 88–95% (bottom-anchored, 64 px margin). Top captions: preview 12%, render 5–8%.
   - (e) The preview caption font is `font_size/3` CSS px. The correct size is `font_size/1.164 × stageWidth/720`, so the preview is **~69% of the true size** on a 405 px stage.
   - (f) In center-crop, the render centres the crop on the focal point, but CSS `object-position` aligns percentages. The two disagree by up to **246 px (34% of frame width)**.
   - (g) Font: the preview uses the literal CSS family (`Inter` is not loaded, so the browser's default font is used). The render maps every font to DejaVu Sans.
5. **Two features are dead in production:**
   - **Logo overlay:** the worker never passes `logo_assets_root`, so any manifest with a logo fails with `render_failed`, and no upload API exists.
   - **Keyword colour:** it goes into ASS `SecondaryColour`, which is used only by `\k` tags, and none are emitted.
6. **Hard 1000-save ceiling per candidate.** Idempotency receipts are never pruned, so save 1001 returns 422 permanently (measured). Autosave fires after 1.2 s of idle, so one long session can reach it. Archives (≤2 MiB each) and render requests (≤1000 per job) are also never pruned.
7. **Worth keeping:**
   - the storage and concurrency core:
     - canonical JSON with SHA-256 ETags;
     - `If-Match` plus a monotonic revision and parent hash;
     - idempotency receipts with crash recovery;
     - `flock` locks, no-follow bounded atomic writes, and an append-only archive;
   - the render queue: leases, heartbeats, fenced publication, no-clobber output, and storage reservations;
   - the fail-closed FFmpeg execution: no shell, timeouts, ffprobe verification;
   - the auth/CSRF pattern.

   All of these are tested and fast: 101 Python tests pass in 7.1 s, and 122 web tests pass in 0.7 s. PUT takes about 19 ms in-process and about 80–90 ms through the per-request Python CLI spawn.
8. **Replace or rewrite:**
   - the manifest schema, which needs clip identity not tied to a V2 candidate, trim, tracks, word-level captions, hook, cold open, layout plans, assets and audio mix;
   - the preview, which must be driven by the same layout/text engine as the render, with frame-accurate clocks and a proxy/clean-master video;
   - the ASS builder: reuse `captions_ass.py` rather than `render_manifest._build_ass`;
   - the verification, which needs gates beyond codec, size and duration;
   - the conflict UX, which today locks the editor and loses the draft.
9. **Performance margin.** A 60 s fit-blur render at 720×1280 takes 13.2 s on 16 threads and 14.7 s pinned to 4 CPUs (Ryzen 7 5700G, 720p test source). The worker uses a fixed 120 s timeout that does not scale with clip length. A 300 s deep-dive clip would take ≈74 s on 4 CPUs with a cheap source, a margin of only ≈1.6×, and less with 1080p/HEVC sources or 1080×1920 output.

---

## 1. Scope and method

| Item | Details |
|---|---|
| Files read in full | `web/app/projects/[id]/candidates/[candidateId]/edit/page.jsx` (556 lines), `web/lib/{editor-view,editor-timeline,edit-document,caption-cues,render-requests,preview-source,auth,request-security}.mjs`, the routes `web/app/api/jobs/[id]/candidates/[candidateId]/{edit,renders,caption-cues}/route.js`, `api/jobs/[id]/renders/[renderId]`, `preview-source` and `files/[...path]`, `web/proxy.js`, `web/next.config.mjs`, `src/ai_clipper/{edit_manifest,render_manifest,render_queue,render_worker,editor_api,candidate_cues,render,captions_ass,selection_types}.py`, `Dockerfile`, `compose.yaml`, both plan docs |
| Editor code size | 5,517 lines (web 1,542 + Python 3,720, plus 255 lines of routes) |
| Tests run | `pytest tests/test_{edit_manifest,editor_api,render_manifest,render_queue,render_worker,candidate_cues}.py`: **101 passed, 7.07 s**. `node --test` over 8 editor-related web files: **122 passed, 0 failed, 0.68 s**. Two web files (`edit-document`, `caption-cues`) depend on the working directory: run from the repo root, 1 and 2 of their tests do not pass. |
| Probes | FFmpeg 6.1.1 (libass, local). Probes call the repo's own `_build_ass` and `_layout_filter` on synthetic grey and testsrc2 sources, and read back pixels with rawvideo. The container uses Debian bookworm FFmpeg 5.1 with the same libass semantics. |
| Hardware | AMD Ryzen 7 5700G (16 threads), 30 GiB. The production `render-worker` container is limited to `cpus: 4`, `mem_limit: 6g`. |

---

## 2. Architecture as built

```
Browser (page.jsx, client component)
  ├─ GET  /api/jobs/:id                          (job)
  ├─ GET  /api/jobs/:id/candidates               (V2 candidates list)
  ├─ GET  /api/jobs/:id/candidates/:cid/caption-cues   → python -m ai_clipper.candidate_cues (stdin envelope)
  ├─ GET  /api/jobs/:id/candidates/:cid/edit     → python -m ai_clipper.editor_api --analysis-dir … (get; creates rev 1)
  ├─ PUT  /api/jobs/:id/candidates/:cid/edit     (If-Match + Idempotency-Key) → editor_api (put)
  ├─ POST /api/jobs/:id/candidates/:cid/renders  (Idempotency-Key, body {"editEtag"}) → storage reservation (node)
  │                                                → python -m ai_clipper.render_queue --job-dir … (create)
  ├─ GET  /api/jobs/:id/renders/:renderId        → render_queue (get), polled 2 s → 10 s backoff
  ├─ GET  /api/jobs/:id/preview-source           raw uploaded source, HTTP Range, streamed from an fd
  └─ GET  /api/jobs/:id/files/output/edits/:cid/revision-N.mp4   (result)

render-worker container: python -m ai_clipper.render_worker --watch (poll 2 s)
  claim_next (lease 300 s, heartbeat ≤30 s) → render_from_manifest(archive manifest, candidate snapshot,
  source snapshot) → FFmpeg → ffprobe verify → staging → publish_completed_output (hard link, fenced)
```

Every document operation spawns a fresh Python process. Stdin and stdout are bounded, there is no shell, timeouts end in SIGKILL, and exit codes map to fixed error classes: 3 invalid, 4 not found, 5 conflict, 6 semantic, 8 selection changed, 9 idempotency. Measured round trip for one GET through the CLI is **0.07–0.09 s**, of which in-process PUT is **p50 19.0 ms, p95 23.1 ms**.

On-disk layout per job:

```
analysis/candidates.v2.json                       (V2 artifact the manifest is bound to)
analysis/edits/<cid>.edit.v1.json                 current revision (canonical JSON, 0600)
analysis/edits/archive/<cid>.edit.v1.r<N>.<sha>.json   every superseded + every render-requested revision
analysis/edits/receipts/<cid>.<uuid>.json         idempotency receipts (full desired manifest inside)
analysis/edits/.<cid>.edit.lock, .<cid>.editor-api.lock
analysis/render-requests/<render_id>.json + .queue.lock
analysis/render-inputs/candidates.<sha>.json, source.<sha>.<ext>   (full byte copy of the source)
analysis/render-staging/<render_id>.<lease>.mp4
output/edits/<cid>/revision-<N>.mp4
```

---

## 3. Data model: `ClipEditManifest` (`clip-edit-v1.0`, `src/ai_clipper/edit_manifest.py`)

Unknown or missing keys are rejected at every level. Text must be NFC with no Cc/Cs characters. Numbers must be finite. Duplicate JSON keys and NaN are rejected. The canonical bytes are `json.dumps(sort_keys, separators=(",",":"), ensure_ascii=False)`, and the whole manifest is capped at 2 MiB.

| Block | Fields | Constraints | V3 relevance |
|---|---|---|---|
| `identity` | `selection_version`, `candidate_id` (`cand_[0-9a-f]{64}`), `candidate_artifact_sha256`, `source_sha256`, `candidate_start/end`, `profile` (viral-short, standard, deep-dive) | Must equal the values recomputed from the **current** `candidates.v2.json` on every read and write. `candidate_artifact_sha256` is the hash of the **whole artifact file**. `source_sha256` is the hash of the canonical source *string*, not of the content. | Fully V2-specific. Any artifact rewrite orphans every edit (`selection_changed`). |
| `revision`, `parent_revision_sha256` | int ≥1; the parent is null exactly when rev = 1 | Must be current+1, and parent = current ETag | Keep |
| `timeline` | `{start,end}` | **Must equal the candidate window** and never changes | Must become editable (trim, multiple ranges, cold open) |
| `visual` | `canvas_width=720`, `canvas_height=1280`, `render_mode` (fit-blur, face-track, center-crop), `safe_area` (0–0.25 per edge), `focal_x/y` | fit-blur takes no focal point. Face-track passes the schema but the renderer rejects it. | Canvas must be variable (1080×1920). Face-track and speaker plans need data. |
| `caption_style` | `preset` (clean, bold-keyword, karaoke, podcast, minimal), `position` (top, center, bottom), `font_family` (Inter, Noto Sans, DejaVu Sans, sans-serif), `font_size` 18–96, `color`, `keyword_color`, `background_color` (`#RRGGBB` uppercase), `background_opacity`, `max_chars_per_line` 8–80, `max_lines` 1–3, `emphasis` (none, keyword) | `emphasis=keyword` makes the renderer raise `RenderUnsupported`. Presets only change bold, border style, outline and shadow. | A style pack must become a real, versioned renderer. |
| `captions[]` | `cue_id`, `index`, `start`, `end`, `text` (≤500), `original_text_sha256` | ≤1000 cues, sorted, no overlap, inside the window. **`(cue_id, index, start, end, original_text_sha256)` cannot change after rev 1.** | No word timings, no speaker, no emphasis spans, no retiming, split or merge. |
| `overlays[]` | ≤2: one `title` `{text≤100, x, y, max_width}` and one `logo` `{asset: assets/<sha>.(png|jpg|jpeg|webp), x, y, opacity, scale}` | Anchors must stay inside the safe area. The logo is treated as square. | No timing (always the full clip), no animation, no stickers, no multiple text layers. |
| `audio` | `gain_db` −24..+12, `normalize` bool | none | No mute or ducking, no music, no per-range volume. |
| `audit` | `created_at`, `updated_at` (ms UTC), `editor_schema` | `updated_at` strictly increases, `created_at` never changes | Keep the pattern |

What the V2 plan (`docs/plans/2026-08-28-…md`) asked for but was **not delivered**:
- acceptance criterion 5 (change start/end) and 6 (edit cue and keyword);
- Task 9 step 5 (visual regression screenshot per preset);
- Task 10 step 1 (proxy video), step 2 (trim handles) and step 5 (face-track toggle).

---

## 4. API surface

| Route | Method | Auth | CSRF | Preconditions | Success | Errors |
|---|---|---|---|---|---|---|
| `…/candidates/:cid/edit` | GET | `requireAuth` plus `proxy.js` | none (GET) | none | 200 manifest, `ETag: "<sha>"`, `no-store`. **The first GET writes revision 1 to disk (a GET with a side effect).** | 400, 404, 409 `selection_changed`, 422, 503 |
| same | PUT | yes | Origin == URL origin, Host == URL host, and `Sec-Fetch-Site` is absent or same-origin | `If-Match: "<sha>"` (428 if missing), `Idempotency-Key: <uuid>`, `Content-Type: application/json`, body ≤2 MiB (streamed and counted) | 200 manifest plus new ETag | 409 `revision_conflict` (with `current` and its ETag), 409 `idempotency_conflict`, 409 `selection_changed`, 422, 503 |
| `…/candidates/:cid/caption-cues` | GET | yes | none | none | `{candidateId, candidateArtifactSha256, selectionVersion:"selection-v2.0", timingProvenance:"segment-v1", wordTiming:false, cues:[{id,start,end,text,originalTextSha256}]}`. **Times are clip-relative; manifest times are absolute.** | 404, 422, 503 |
| `…/candidates/:cid/renders` | POST | yes | same as PUT | `Idempotency-Key`; body must match `^\s*\{\s*"editEtag"\s*:\s*"[0-9a-f]{64}"\s*\}\s*$` and be ≤1 KiB | 202 public status DTO | 409 `render_conflict`, 413, 507 or 503 for storage |
| `/api/jobs/:id/renders/:renderId` | GET | yes | none | none | DTO `{renderId, candidateId, state, revision, attempts, createdAt, updatedAt, errorCode[, resultUrl]}` | 400, 404, 503 |
| `/api/jobs/:id/preview-source` | GET/HEAD | yes | none | Range | 206 stream of the **original upload**. The extension must be in an allowlist (mp4, m4v, mov, webm, mkv) and the magic bytes are checked. | 404, 416, 422 |

The client does strict DTO validation (`validateEditorDocument`, `validatePublicRenderStatus`, `validateSavedEditorResponse` with a deep-equality check on save). The result URL is recomputed and compared exactly.

---

## 5. Revision, ETag, idempotency and conflict model

| Concern | As built | Assessment |
|---|---|---|
| ETag | `sha256(canonical manifest bytes)`, a strong quoted ETag. The client accepts `W/"…"` from proxies and normalizes it (`normalizeEditorEtag`). | Keep |
| Optimistic concurrency | Under locks, the server requires `expected == current sha`, `revision == current+1`, `parent == current sha`, the same identity and timeline, a later `updated_at`, and the same `created_at` | Keep. It is sound. |
| Idempotency | Each receipt (pending, then committed) stores `payload_sha256 = sha256(etag ‖ 0x00 ‖ canonical desired)`, the full desired manifest, and `result_etag`. A replay returns the same result. The same key with a different payload returns 409. After a crash, a pending receipt is reconciled: if the desired manifest is already current it is committed, if the expected one is still current it is published, anything else is a semantic error. | Correct and crash-safe. Two problems: receipts store the full manifest (≤2 MiB each), and they are **never pruned: 1000 per candidate is a hard limit** (§11, D5). |
| Locks | `flock` on `.<cid>.editor-api.lock`, the shared candidate-artifact lock, and `.<cid>.edit.lock`, plus a process `RLock` reset after `fork` | POSIX only. Fine for one host. |
| History | Every replaced revision is hard-linked into `archive/` and never deleted. Render requests point at an archived revision. | Good base for undo and history, but there is **no API or UI** to list, diff or restore revisions. |
| Client save loop | Debounce of `SAVE_DELAY_MS = 1200`. One save in flight at a time, with a queue behind it. A retry reuses the same key when the payload matches apart from `updated_at`. A `beforeunload` guard is in place. | OK for a single form. Too chatty for a multi-track editor: every nudge becomes a full ≤2 MiB PUT and a new archived file. |
| Conflict UX | 409 locks the editor and the only option is "Muat ulang". The UI tells the user to copy their text by hand. There is no merge or rebase and no local draft persistence. | Must change: keep the draft (IndexedDB) and rebase field-level operations onto the new head. |
| Render binding | A request binds the candidate snapshot hash, the archived manifest (its sha and revision), the source content sha of the byte copy, and an output path per revision (`revision-N.mp4`). | Good. However, **the output key ignores the renderer version**: a completed `revision-N.mp4` is reused forever, even after renderer bug fixes (worker `output.exists()` goes straight to verify, then complete). |

---

## 6. Preview implementation: what is exact and what is approximated

The preview is built from two `<video>` elements (main and blurred backdrop) playing the **raw source** through `/preview-source`, plus DOM overlays (`.previewCaption`, `.previewTitle`, `.previewLogo`, a dashed `.safeArea`). The stage is `width: min(100%, 405px)` at 9:16 (340 px on phones). The page labels it "Preview perkiraan … dapat berbeda" (an estimate that may differ).

| Aspect | Exact? | Details |
|---|---|---|
| Window start and end | Approximate | Driven by `timeupdate`, which Chromium fires about every 250 ms (the spec allows 15–250 ms). Playback can run up to about 250 ms (audio included) past `end` before `pause()` and the snap back. |
| Caption activation | Approximate | `currentCaptionCue` also runs on `timeupdate`, so captions switch up to about 250 ms late. The render uses centisecond ASS times. |
| Scrubbing | Engineering is good | The playhead is painted without React re-renders. Seeks are throttled to 10 Hz, and the backdrop is hidden while dragging (the team measured the drag cost). |
| fit-blur | Approximate | Preview: CSS `blur(22px) saturate(.75)`, `scale(1.12)`, `opacity .72` over `#080908`. Render: `gblur=sigma=35` on a 720×1280 cover crop at full brightness, with no desaturation and no darkening. The preview background is visibly darker, greyer and more zoomed. |
| center-crop | Wrong off-centre | Render: `x = clip(iw·f − ow/2, 0, iw−ow)`. CSS: `object-position f%`, which gives `x = (iw−ow)·f`. For a 16:9 source the delta is 0 at f = 0, 0.5 and 1, **±144 px at f = 0.3 or 0.7, and up to 246 px (34% of width) at f ≈ 0.16 or 0.84**. `focal_y` does nothing for 16:9 sources in either path, yet the UI shows a slider for it. |
| face-track | Not available | The radio button is disabled and `render_manifest` raises `UnsupportedRenderMode`. The automatic render path (`render.py`) *does* support face-track, so an auto clip cannot be reproduced in the editor. |
| Caption font family | Wrong | Preview: `fontFamily: "Inter"` (or Noto Sans or DejaVu Sans) with no fallback list. The dashboard loads only DM Sans and Manrope from Google Fonts, so clients without Inter get the **browser default font (often a serif)**. Render: all four choices map to `DejaVu Sans`. |
| Caption font size | Wrong | Preview: `font_size/3` px. Correct: `font_size / 1.164 × stageW/720`, because libass sizes by ascent plus descent (1.164 em for DejaVu). On a 405 px stage this is 14 px against 20.3 px, **69%**. On a 340 px stage, 14 px against 17.0 px, 82%. |
| Caption weight | Wrong | Preview: `font-weight: 800` for every preset. Render: bold only for bold-keyword, karaoke and podcast. |
| Caption position | Wrong | Preview centres the box at 12%, 50% or 78% of height. Render (measured bbox): **top 5.3–7.7%, center 48.7–51.1%, bottom 1 line 92.0–94.5%, bottom 2 lines 88.3–95.1%** (bottom-anchored, MarginV = safe.bottom × 1280 = 64 px). The render's bottom captions also sit inside TikTok's UI overlay zone (roughly the bottom 20%). |
| Caption width and wrap | Wrong | Preview: `left/right: 10%`, the browser wraps by pixel width, and `-webkit-line-clamp` hides extra lines. Render: margins at `safe_area` 5% (36 px), `textwrap` by **character count** (`max_chars_per_line`), `WrapStyle 2`, and a mid-word "…" cut after `max_lines`. Measured: "…cukup panjang untu…". |
| Caption box | Wrong | Preview: one rounded box, padding 7×9 CSS px, colour + opacity. Render: libass `BorderStyle 3` draws **a box per line**, with padding equal to `Outline` (2–4 px), filled with `OutlineColour` at alpha 00, so it is **always opaque** (measured). The shadow uses `BackColour`. |
| Presets | Wrong | Preview: `minimal` has no background, `podcast` has a lime left border and **left-aligned** text, `karaoke` gets letter-spacing. Render: presets only change bold, border style, outline and shadow. `karaoke` has **no word timing** and `podcast` is centred. |
| Keyword colour | No-op in both | Written to ASS `SecondaryColour`, which only `\k` karaoke tags use, and none are emitted. The preview ignores it too. |
| Title overlay | Wrong | Preview: Manrope 800 at `clamp(.7rem, 2vw, 1.05rem)` (**viewport-dependent**, unrelated to the canvas), on a dark rounded box, no line cap. Render: DejaVu Sans Bold 52 px, outline 3, shadow 1, no box, a wrap width estimated as `max_width·720/(52·0.58)` characters, 3 lines with "…", and a `\clip` to the safe area. |
| Logo | Placeholder | The preview draws a "LOGO" box. The render path is unreachable (D3). |
| Audio | Not previewed | `gain_db` and `normalize` are ignored by the `<video>` element (no Web Audio graph). The render uses `volume` then `loudnorm` single pass (dynamic mode), so a gain applied before normalization is mostly cancelled out. |
| Source decode | Different decoders | The preview decodes the original upload in the browser, twice (two elements). HEVC, ProRes, 10-bit and HDR sources, or MKV in Safari, can fail or tone-map differently. The render decodes anything FFmpeg can. There is no proxy. |
| Colour | Untagged | Output H.264 has no `colour_primaries`, `transfer` or `matrix` tags (ffprobe shows none), so players guess. |

**In short, only the window bounds (±250 ms) and the fit versus crop geometry at f = 0.5 match. Every caption and title property differs.**

---

## 7. Render path

### 7.1 `render_manifest.render_from_manifest`

1. Takes an output lock, then `_load_bound_manifest`. This accepts only the exact current manifest or an archived `r<N>.<sha>` manifest whose bytes are canonical. Identity is checked again against the candidate snapshot, whose digest must match its file name.
2. Validates the source as a regular file with no symlinks. `_assert_source_binding` requires that the identity path resolves to the same file, **or** that the sha of the fd content matches `expected_source_content_sha256`. Remote sources require the content digest.
3. Runs FFprobe through `/proc/self/fd/N`, and the window must lie within the duration.
4. Writes the ASS file from `_build_ass`. The FFmpeg command is:
   ```
   ffmpeg -nostdin -y -ss <start> -i /proc/self/fd/N [-loop 1 -i logo.ext]
     -t <dur> -filter_complex
       fit-blur:    [0:v]split[bg][fg];[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=35[b];
                    [fg]scale=720:1280:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1[base]
       center-crop: [0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280:x=clip(iw*fx-ow/2,0,iw-ow):y=…,setsar=1[base]
       ;[base]ass=filename='captions.ass'[captioned]  (+ logo overlay)  (+ [0:a]volume,loudnorm[audio])
     -map [captioned|video] -map [audio]|0:a? -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p
     -c:a aac -b:a 128k -movflags +faststart <tmp>.mp4
   ```
5. Verifies the result: `h264`, 720×1280, SAR 1:1, duration within `max(0.25 s, 2%)`, and AAC present exactly when the source has audio. It then publishes with `os.link` (no-clobber).

Weak points:
- Default timeout is **120 s** for every child process, and the worker does not override it.
- There is no `apad` or `-shortest` handling: audio shorter than the video passes if the container duration is within tolerance.
- There is no `-map_metadata -1` (unlike `render.py`).
- No colour tags are written.
- The ASS builder is a **separate, older implementation** from `captions_ass.py`. It has different escaping, char-count wrapping, no karaoke, and no hook.

### 7.2 Queue and worker (`render_queue.py`, `render_worker.py`)

- **States.** `queued → claimed → rendering → completed | failed`. At most 3 attempts. A claim sets `lease_token` and `heartbeat_at`. A stale lease (heartbeat older than 300 s) is reclaimed, or failed as `max_attempts_exceeded`. `publish_completed_output` hard-links the staging file to `output/edits/<cid>/revision-N.mp4` and marks the request completed while holding the queue lock (fenced by `lease_token`).
- **Storage.** A request can carry a storage reservation (`render-request-v2`). The worker heartbeats the reservation, rechecking every `JOBS_STORAGE_RECHECK_INTERVAL_MS` or after `JOBS_STORAGE_RECHECK_BYTES` of growth, and releases it on the terminal state. Losing the reservation sets `lost` and fails the render.
- **Creating a request** (inside the POST, under the edit lock and a Python timeout of 30 s):
  - archives the current manifest;
  - snapshots `candidates.v2.json`;
  - **copies the whole source file** (≤500 MB, deduplicated by sha) into `analysis/render-inputs/`, which doubles the source bytes per job.
- **Worker loop.** A single process scans every job directory every 2 s and renders **one request at a time globally**. There is no priority, no parallelism and no cancel.
- **Failures.** Any exception becomes `render_failed`. `verification_failed` exists in the enum but is never written. Failed is terminal, so the UI's "Coba render lagi" (try again) sends a new idempotency key for the same revision.
- **Verification.** After rendering, the worker re-verifies the result, including a **full sha256 of the source snapshot** on every render.

### 7.3 Measured throughput (`speed4.py`, `parity_probe.py`)

| Clip | 16 threads | Pinned to 4 CPUs (the container limit) |
|---|---|---|
| 60 s, fit-blur, 720×1280, 20 cues, testsrc2 720p30 source | 13.17 s | 14.71 s |
| 60 s, center-crop | 7.83 s | 9.48 s |

At 4 CPUs, fit-blur runs at about 4.1× real time. A 300 s deep-dive clip therefore needs about 74 s against the fixed 120 s timeout. Real 1080p H.264/HEVC sources decode more slowly than testsrc, and a 1080×1920 output has 2.25× the pixels, so the timeout must scale with duration and pixels.

---

## 8. Security posture

| Area | Status |
|---|---|
| AuthN | One user. Credentials come from env and are compared with `timingSafeEqual`. The session cookie is `payload.HMAC-SHA256`, 30 days, `HttpOnly; Secure; SameSite=Lax`. It is enforced both in `proxy.js` (Next 16 middleware) and in each route (`requireAuth`). **Sessions are stateless and cannot be revoked:** logout only clears the cookie, so a stolen token stays valid for up to 30 days. There are no roles. |
| CSRF | Mutations (PUT edit, POST renders) check `Origin`, `Host` and `Sec-Fetch-Site`. The GET edit has a side effect (it creates rev 1) but is idempotent and harmless. |
| Input handling | Everything is exact-key with strict types. Body sizes are streamed and counted (2 MiB edit, 1 KiB render). JSON is rejected on duplicate keys or NaN. Unicode must be NFC with no controls. |
| Process boundary | `execFile` without a shell, bounded stdin/stdout, SIGKILL on timeout, exit codes and stderr sanitized to fixed tokens. No paths or messages leak. |
| Filesystem | `O_NOFOLLOW`, `lstat` plus `realpath` containment, regular-file checks, bounded reads, atomic tmp→fsync→rename or link, directory fsync, 0600/0700 permissions. The source is read through `/proc/self/fd`, which avoids TOCTOU races. |
| FFmpeg injection | The filtergraph is built only from validated numbers and allowlisted fonts. The ASS path is a constant file name in a private temp directory. Logo bytes are content-addressed, the magic number is checked, ffprobe checks the stream, and size is capped at 4096² and 16.7 MP. |
| ASS injection | `{}` are escaped, so no override tags can be injected. **Backslash escaping is broken** (`\` becomes `\\`, which libass does not treat as an escape), so `\N`, `\n` and `\h` still work (measured, D2). This affects layout only, not code execution. `captions_ass.ass_escape` has the correct fix (a U+2060 word joiner after `\`). |
| Resource exhaustion | Receipts and render requests are capped at 1000 but never pruned. Archives grow without bound: each save archives the previous revision. Measured: 50 saves gave 50 archive files (66.6 KB for a small manifest), and the worst case is 2 MiB each. |
| Headers | No CSP, `frame-ancestors` or `X-Frame-Options` (clickjacking on "Render Final" is possible, though low risk). The Google Fonts `@import` is a third-party request from a self-hosted tool. |
| Media serving | Range parsing uses `parseByteRange`, the content type comes from an allowlist, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store` are set. |

---

## 9. Tests

| Suite | Count | What it covers | What it does not cover |
|---|---|---|---|
| `test_edit_manifest.py` (684 lines) | 21 | Schema strictness, canonical bytes, revision rules, archive, symlink and size attacks | none noted |
| `test_editor_api.py` (325) | 12 | Default creation, PUT and replay, idempotency conflicts, crash reconciliation, selection change | The receipt ceiling; long sessions |
| `test_render_manifest.py` (614) | 18, including **2 real-FFmpeg renders** (fit-blur, center-crop on a 4 s testsrc2) | Binding, no-clobber, logo validation, timeouts | **Any pixel assertion.** Caption position, box opacity, font, escaping and loudnorm sample rate are all untested, which is why D1, D2 and D4 went unnoticed. |
| `test_render_queue.py` (227), `test_render_worker.py` (489) | 9 + 15 (18 collected) | State machine, leases, heartbeats, storage reservation, fencing | Worker plus a real logo (D3); timeout scaling |
| `test_candidate_cues.py` (161) | 7 | Envelope protocol and bounds | none noted |
| Web `editor-view`, `editor-timeline`, `edit-document`, `caption-cues`, `render-requests`, `preview-source`, `final-files`, `request-security` | 23 + 10 + 4 + 12 + 15 + 32 + 23 + 3 = 122 | DTO validators, loaders, retry and poll logic, scrub math, route contracts. `page.jsx` is covered by a **source-string** test. | Any rendered-DOM or visual test. Two files depend on the working directory. |
| Playwright `e2e/mutation.spec.mjs`, `read-only.spec.mjs` | A few | Edit persists across reload; render queues, completes, downloads and plays; every V2 editor loads | Needs a live stack. Has no preview-vs-render comparison. |

**There is no golden-frame or perceptual-diff test between preview and render.** The V2 plan (Task 9 step 5) asked for visual regression per preset, and it was never built.

---

## 10. Parity gap register (browser preview vs final render)

Severity: **S1** means the user sees something materially different or the final output is wrong. **S2** means it is noticeable. **S3** means it is minor or cosmetic.

| # | Element | Preview | Final render | Measured or derived delta | Sev |
|---|---|---|---|---|---|
| P1 | Caption vertical position | Centre at 78% (bottom), 12% (top), 50% (center) | Bottom-anchored with 64 px margin: bottom 88–95%, top 5–8% | Bottom: 13.7–15.2% of frame height (175–195 px at 1280). Top: 5.5% (70 px). | S1 |
| P2 | Caption font size | `font_size/3` px | libass height = font_size canvas px | Preview is 69% of true size at a 405 px stage, 82% at 340 px | S1 |
| P3 | Caption font family | Literal "Inter" (not loaded), so the browser default is used | DejaVu Sans | Different face, often serif against sans | S1 |
| P4 | Caption box opacity | Honours `background_opacity` | Always opaque | Fill RGB (4,4,4) against the expected ≈45 at 0.65 | S1 |
| P5 | Caption wrap and truncation | Pixel wrap plus line clamp (hidden overflow) | Char-count wrap plus mid-word "…" | Different line breaks and different truncation points | S1 |
| P6 | Default caption content | One cue shows the full text (clamped) | One cue, first about 64 chars for the whole clip | Everything after about 64 chars never appears | S1 |
| P7 | Caption timing | `timeupdate`, about 250 ms granularity | Centisecond | Up to about 250 ms late | S2 |
| P8 | Window end | Overshoot up to about 250 ms, including audio | Exact `-t` | Up to about 250 ms | S2 |
| P9 | Presets | minimal, podcast (left-aligned, lime bar), karaoke (letter-spacing) | Only bold, border, outline and shadow change; karaoke has no `\k` | Categorically different | S1 |
| P10 | Caption weight and shadow | 800 weight, text-shadow always | Bold only for three presets; shadow 0 or 1 | Visible | S2 |
| P11 | Caption horizontal margins | 10% each side | Safe area, 5% each side | 36 px per side | S3 |
| P12 | Title font, size, box and wrap | Manrope, viewport-relative size, dark box | DejaVu Bold 52/1280, outline, no box, 3-line char wrap | Categorically different | S1 |
| P13 | Logo | Grey "LOGO" placeholder | Real raster, or a render failure in production (D3) | not applicable | S1 |
| P14 | fit-blur background | Blur 22 CSS px (≈39 canvas px), saturation 0.75, opacity 0.72 on near-black, scale 1.12 | gblur σ = 35, full brightness, no saturation change, no extra zoom | Preview background is darker, greyer and more zoomed | S2 |
| P15 | center-crop focal x | CSS object-position | Centred crop, clamped | Up to 246 px (34% of width) | S1 |
| P16 | focal_y | Slider shown | No effect for sources wider than 9:16 | UI promises something it does not do | S3 |
| P17 | Audio gain and normalize | Not applied | `volume` then `loudnorm` single pass, 96 kHz output | Loudness in preview differs from the final | S2 |
| P18 | Source decode | Raw upload in the browser (two decoders) | FFmpeg | HEVC/ProRes/HDR/MKV may not play or may tone-map differently | S2 |
| P19 | Colour metadata | Browser assumes | Untagged output | Possible shift in players | S3 |
| P20 | Face-track | Disabled | Refused (`UnsupportedRenderMode`) | Auto clips rendered with face-track cannot be reproduced | S1 for V3 |
| P21 | Keyword colour | Ignored | Ignored (`SecondaryColour` without `\k`) | The control is a no-op | S2 |
| P22 | Backslash sequences | Shown literally | Interpreted as `\N` newline or `\h` hard space | Extra line break (screenshot) | S2 |

---

## 11. Defects found (reproducible)

| ID | Defect | Where | Repro or evidence | Fix direction |
|---|---|---|---|---|
| D1 | `background_opacity` has no effect because the box is always opaque | `render_manifest._build_ass`: `OutlineColour = background_color` with alpha 00 and `BorderStyle 3` | `measure/probe-result.json` `opacity_sweep`: fill (0,0,0) at 0.3, 0.65 and 1.0 | Put the alpha on `OutlineColour`, as `captions_ass.py` Hook does. Verified in `measure/bs4/`: BorderStyle 3 with `OutlineColour=&H59000000` fills at 44, against 44.8 expected. The alternative is `BorderStyle 4`, which draws the box in `BackColour`. Verified on libass 0.17.1: with Outline set to opaque red and Back to 65% black, BS3 fills red and BS4 fills (44,44,44). |
| D2 | Broken backslash escape, so `\N`, `\h` and `\n` can be injected | `render_manifest._ass_escape` | `measure/out/box-default/t4.png`: "garis\\" then a break, "miring dan \\  spasi" | Reuse `captions_ass.ass_escape` (backslash + U+2060) |
| D3 | Logo overlays can never render in production | `render_worker.run_one` calls `renderer(...)` without `logo_assets_root`, and `_load_logo` raises "logo asset root is required" | Code path. The PUT validator accepts any `assets/<sha>.png` string, and there is no upload route. | Add an asset store with an upload API, and pass the root, or remove the feature |
| D4 | `normalize` produces 96 kHz AAC | Single-pass `loudnorm` outputs 192 kHz; the AAC encoder picks 96 kHz | `probe-result.json` `loudnorm_output_streams.sample_rate = "96000"` | Two-pass `loudnorm` with measured values plus `linear=true`, then `aresample=48000`, and verify `sample_rate == 48000` |
| D5 | Permanent save lockout after 1000 saves per candidate | `editor_api.MAX_RECEIPTS`, no pruning | `measure/save_ceiling.py`: save 1001 gives `EditorSemanticInvalid`, which maps to HTTP 422 | Keep receipts by TTL or last-N, or key them by `(key → result_etag)` without the full manifest; compact the archive |
| D6 | Default manifest makes captions useless | `editor_api._default_manifest` creates 1 cue for the whole window; cue bindings are immutable afterwards | Code, plus the rendered "…untu…" | Seed word-level cues from the transcript; make the cue structure editable |
| D7 | Imported cues are loaded and then discarded | `loadEditorWorkspace` returns `cues`, and `page.jsx` never reads them | grep `loaded.cues` finds nothing | Covered by the redesign |
| D8 | Renderer upgrades never re-render | Output key `revision-N.mp4`; the worker completes early when the output exists | Code | Key the output by `sha256(manifest ‖ renderer_version ‖ asset shas)` |
| D9 | Fixed 120 s timeout | `render_from_manifest(timeout=120)` default, the worker passes nothing | §7.3 | `timeout = max(120, k × duration × pixel_factor)`, with progress-based liveness (`-progress pipe:`) instead of a hard wall-clock limit |
| D10 | Preview `font-family` has no generic fallback | `page.jsx` inline style | Code | Self-host the exact render fonts with `@font-face` and use the same font files in libass (see §13) |
| D11 | Web tests depend on the working directory | `edit-document`, `caption-cues` tests | 1 and 2 tests fail when run from the repo root | Resolve the Python path from `import.meta.url` |

---

## 12. Keep, change or drop for V3 clips

| Component | Decision | Rationale |
|---|---|---|
| `edit_manifest.py` storage primitives (`_read_regular`, `_atomic_write`, `_archive_current`, `_edit_lock`, canonical bytes, strict decode, `_utc_timestamp`) | **Keep** and extract into a generic `versioned_document.py` | Solid, tested and fast |
| `ClipEditManifest` schema | **Replace** with a new versioned schema (`clip-edit-v2`, see §13) | Tied to the V2 candidate, and cannot express trim, tracks, words, hook, cold open or assets |
| Identity binding to the `candidates.v2.json` whole-file hash | **Drop** | Bind to a stable `clip_id` plus the source *content* hash plus transcript and word-timeline hashes, kept as provenance. A new selection run must not orphan edits. |
| `editor_api.py` receipts and reconciliation logic | **Keep the algorithm, change the storage** | Add pruning, and keep receipts small (the digest instead of the full manifest) |
| Web↔Python bridge (`execFile` per request) | **Keep for document commits.** Add a long-lived worker or an in-Node validator for high-frequency reads if needed | 80–90 ms per call is fine for debounced commits but too slow for interactive AI or preview calls |
| ETag, `If-Match`, `Idempotency-Key` HTTP contract | **Keep** | Standard and correct |
| Conflict handling (lock and reload) | **Change** | Needs an op log or field-level patches with rebase, plus local draft persistence |
| `render_queue.py` state machine, leases, storage reservations, fenced publish | **Keep, generalise** | Replace the `candidate_id` and `cand_` regexes with `clip_id`; add render kinds (final, preview proxy, clean master, waveform), priority, cancel, and a renderer version in the output key |
| `render_worker.py` | **Keep the skeleton** | Add concurrency above 1 with CPU budgeting, a duration-scaled timeout, `-progress` heartbeats, pass the assets root, and add quality gates (§14) |
| `render_manifest._build_ass`, `_layout_filter` | **Drop** | Superseded by `captions_ass.py` (correct escaping, pixel-width wrapping, karaoke `\k`, hook boxes) and by `render.py`/`face_tracking.py` (face-track, cold-open concat) |
| `render.py` and `captions_ass.py` (V3 auto render) | **Promote** to the single render engine, driven by the new manifest | This removes the second, diverging implementation (today there are two ASS builders and two layout builders) |
| `candidate_cues.py` segment cues | **Drop** for V3 | V3 has word timestamps (`transcript_io`) and `subtitles.build_caption_cues` |
| `preview-source` route (range streaming, fd-based) | **Keep the streaming code**, change what it serves | Serve a server-made proxy or clean master (H.264 8-bit, keyframes every 1 s), not the raw upload |
| `page.jsx` UI | **Rewrite** | A single 556-line component with inline styles; the V3 editor needs a timeline, tracks, inspector and canvas architecture |
| `editor-timeline.mjs` pure scrub math and drag performance approach | **Keep the ideas** | Measured wins: seeks throttled to 10 Hz, playhead painted outside React |
| `validateEditorDraft` and `validateEditorDocument` duplication (JS mirrors Python) | **Change** | Generate both from one JSON Schema (2020-12) so they cannot drift |
| Auth and CSRF helpers | **Keep** | Add session revocation (a server-side session id with a denylist) and CSP or `frame-ancestors` |

---

## 13. What V3 clips need from the data model (input for the design tasks)

These are requirements the audit forces. They are not a full design.

1. **Stable clip identity.** Proposed: `clip_id = "clip_" + sha256(source_content_sha256 ‖ selection_version ‖ round(start,3) ‖ round(end,3) ‖ cold_open)`, written into `selection.v3.json` at selection time. This needs an additive `SelectedClip.clip_id`, since `rank` is not stable. Edits live at `analysis/edits/<clip_id>/…`, with provenance `{selection_artifact_sha256, transcript_sha256, words_sha256, audio_timeline_sha256, source_content_sha256}`. A change in provenance produces a *warning* and a re-anchor (words are matched by time and text), never an orphaned edit.
2. **Seed from the auto render, not an empty default.** Revision 1 must reproduce exactly what `render.py` produced for that clip:
   - source ranges, including the cold open;
   - `render_mode` plus the persisted face-track trajectory;
   - word-timed cues from `build_caption_cues`;
   - `caption_style` classic or karaoke;
   - `hook_text` and `hook_duration`;
   - 720×1280 or 1080×1920 output.

   Re-rendering an unedited revision 1 must be pixel-identical (or within a PSNR threshold) to the auto clip. This is a quality gate.
3. **Timeline.**
   - An ordered list of source ranges (the cold open, then the main range, then jump-cut ranges from transcript deletions), so trim is no longer immutable.
   - Words snap to `TranscriptWord` boundaries, with an optional `audio_timeline.nearest_quiet_point`.
   - Captions are derived from words plus edits (text override per word or cue, emphasis spans, and split/merge operations stored as operations), not frozen cue bindings.
4. **One layout/text engine for preview and render.**
   - Text layout needs identical font files (self-hosted DejaVu Sans / Bold, or a chosen OFL pack) loaded in both the browser (`@font-face`) and libass (`fontsdir=`).
   - Shared metrics: libass font size = ascent + descent.
   - Wrap decisions are computed once, stored or deterministically derived, and emitted as explicit `\N` plus `\q2` (as `captions_ass` Hook already does), so the browser never re-wraps.
   - A preview clock from `requestVideoFrameCallback` (Chrome 83+, Safari 15.4+, Firefox 132+) instead of `timeupdate`.
5. **Preview media.**
   - A server-rendered **clean master** per clip: the reframed layout with no text, following LokaClip's model. Its binary strings include "editor clean master invalidated; it will be rebuilt on next edit" and "smartcrop: trajectory persisted for the editor; … editor preview will fall back to a centre crop".
   - Alternatively, a low-res proxy plus the persisted crop trajectory applied in canvas or WebGL.
   - Text, stickers and hook are drawn in the browser by the same engine.
6. **Assets.** A content-addressed per-job asset store (`assets/<sha>.<ext>`) with an upload API: size and dimension caps, magic plus ffprobe validation (reuse `_verify_raster`), audio and video B-roll, and fonts. The worker must be passed the root (D3).
7. **Audio.** A mix graph (source gain, mute ranges, music track with `sidechaincompress` ducking, fades) with a 48 kHz output contract and two-pass loudness to −14 LUFS for TikTok/Reels (as opposed to −16 today).

---

## 14. Quality gates the existing path lacks (proposed for the editor stage)

| Gate | Check | Cheap implementation |
|---|---|---|
| G1: container | h264 High, yuv420p, even dimensions equal to the manifest canvas, SAR 1:1, colour tags bt709/tv, `+faststart`, AAC-LC 48 kHz stereo | ffprobe (extend `_verify_output`) |
| G2: duration and A/V | Video and audio stream durations each within ±1 frame of Σ ranges; no audio gap | ffprobe per stream (as `render.py` already does) |
| G3: loudness | Integrated −14 ±1 LUFS, true peak ≤ −1 dBTP when normalize is on | `ffmpeg -af ebur128=peak=true` |
| G4: not broken | No black or frozen spans over 0.5 s unless the source has them | `blackdetect`, `freezedetect` |
| G5: text-safe | Every caption and hook bbox stays inside the platform safe zone (TikTok: roughly the bottom 20% and right 12% are covered) | Computed from layout metrics; confirmed by the P1-style ink bbox on sampled frames |
| G6: preview parity | For N sampled timestamps, the preview frame (headless Chromium screenshot of the canvas) against the FFmpeg frame gives SSIM ≥ 0.97 on the overlay layer, and caption bbox IoU ≥ 0.9 | Playwright plus a `ssim` filter; this replaces the source-string test |
| G7: round trip | An unedited revision 1 renders equal to the auto clip (PSNR ≥ 40 dB) | FFmpeg `psnr` filter |
| G8: escaping and fuzz | Caption text with `\N {\b1} \h` Unicode RTL and emoji renders literally | Unit test on `ass_escape` plus one frame OCR or bbox check |

---

## 15. Appendix: raw measurements

`measure/probe-result.json` (abridged):

```json
{
 "default_caption_bbox_fraction_y": [0.8828, 0.9508],
 "box_fill_sample_rgb": [4, 4, 4],
 "expected_box_fill_if_opacity_0.65_black_over_grey": 45,
 "opacity_sweep": {"0.3": {"fill": [0,0,0]}, "0.65": {"fill": [0,0,0]}, "1.0": {"fill": [0,0,0]}},
 "positions_render": {"top": {"bbox_y_fraction": [0.0531, 0.0773]},
                      "center": {"bbox_y_fraction": [0.4867, 0.5109]},
                      "bottom": {"bbox_y_fraction": [0.9203, 0.9445]}},
 "positions_preview_css_center_y": {"top": 0.12, "center": 0.5, "bottom": 0.78},
 "loudnorm_output_streams": [{"codec_name": "aac", "sample_rate": "96000"}],
 "render_seconds_60s_clip_720x1280_veryfast_16threads": {"fit-blur": 13.17, "center-crop": 7.83},
 "center_crop_focal_render_vs_css": {"0.3": {"delta_px_at_720": -144.0}, "0.7": {"delta_px_at_720": 144.0}}
}
```

- 4-CPU pin (`taskset -c 0-3`): `{"fit-blur": 14.71, "center-crop": 9.48}`.
- Maximum focal delta over f ∈ [0,1] for a 16:9 source is 245.8 px (34.1% of 720).
- Save latency (`save_ceiling.py`, in-process): p50 19.02 ms, p95 23.14 ms. After 50 saves there were 50 archive files totalling 66,588 B. Save 1001 raises `EditorSemanticInvalid`.
- CLI round trip (`cli_latency.sh`): 0.07–0.09 s per GET.
- Output colour tags: none (ffprobe shows no `color_space`, `color_primaries` or `color_transfer`).
