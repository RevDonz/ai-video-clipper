# 001 — Transcribe, Highlight, and Render

## Question

**Given** a horizontal Indonesian long-form video, **when** the local pipeline processes it, **then** can it produce coherent portrait MP4 clips with usable transcription and burned-in subtitles without a paid API?

Risk: high. If transcription, timestamps, or FFmpeg rendering fail, the core product is not feasible.

## Approach

- `faster-whisper` model `small`, CPU/int8
- Transcript-first contiguous-window scoring
- FFmpeg center crop to 9:16
- SRT cues split to at most four words and timed proportionally
- FFmpeg/libass subtitle burn-in
- H.264/AAC export

## Evidence

Input:

- `artifacts/demo-source-id.mp4`
- Synthetic horizontal podcast visual
- Native Indonesian Edge TTS narration
- Duration approximately 75 seconds

End-to-end command:

```bash
uv run ai-clipper artifacts/demo-source-id.mp4 \
  --output-dir artifacts/demo-output-verified \
  --model small --language id \
  --min-duration 20 --max-duration 45 --limit 2 \
  --width 720 --height 1280
```

Observed outputs:

| Output | Resolution | Duration | Video | Audio | SAR |
|---|---:|---:|---|---|---|
| clip-01.mp4 | 720×1280 | 44.47 s | H.264 | AAC | 1:1 |
| clip-02.mp4 | 720×1280 | 23.70 s | H.264 | AAC | 1:1 |

The final frame was visually inspected: portrait orientation was correct, the image was not corrupted, and the revised subtitle style was readable without dominating the frame.

Quality gates:

```text
30 tests passed
Ruff: All checks passed
```

## Verdict: PARTIAL

### What worked

- Fully local Indonesian transcription worked without an API key.
- The `small` model transcribed the native Indonesian demo accurately enough for clipping.
- The selector ranked the section beginning with “kesalahan terbesar” first.
- Two non-overlapping clips were rendered successfully.
- Subtitles were burned into playable vertical MP4 files.
- A visual subtitle defect was found during frame inspection, reproduced with a test, and fixed by shorter cues and a smaller style.
- Non-square output pixels were found through FFprobe, reproduced with a failing test, and fixed with `setsar=1`.

### What did not work yet

- The initial generic TTS voice produced poor Indonesian transcription even when switching from Whisper `tiny` to `small`; using a native Indonesian voice fixed the input quality problem.
- Highlight selection is not yet semantic LLM scoring.
- No face or active-speaker tracking exists.
- The source visual is synthetic; a real multi-speaker podcast remains untested.

### Surprises

- Better Whisper size alone did not fix incorrectly pronounced source audio.
- SRT sentences that looked reasonable as text became visually unusable after ASS scaling; frame-level inspection was necessary.
- Scale-and-crop introduced a near-1:1 sample aspect ratio instead of exact square pixels until `setsar=1` was added.

### Recommendation for the real build

Proceed to a vertical MVP slice with:

1. A provider interface for LLM-based highlight ranking, retaining the deterministic fallback.
2. Word-level timestamps and editable transcript JSON.
3. Face detection and manual crop override before automatic tracking.
4. A queue-backed API around this proven worker.
5. Evaluation on real Indonesian podcasts before building billing or a complex editor.
