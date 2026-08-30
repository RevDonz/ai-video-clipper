# AI Video Clipper — Technical Spike

Runnable proof of concept for this flow:

```text
long-form MP4 → faster-whisper transcription → transcript highlight scoring
→ vertical 9:16 crop → short subtitle cues → FFmpeg H.264/AAC clips
```

This repository is intentionally a technical spike, not yet the production SaaS.

## Web dashboard (Docker)

The repository now includes a self-hosted Next.js dashboard that runs the Python
engine in background jobs. It supports YouTube URLs or uploaded files, live job
status, selectable render layout, video preview, and MP4 download.

```bash
cp .env.example .env
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/health
```

Open `http://SERVER_IP:3000`. For VM deployment through Nginx Proxy Manager and
Cloudflare, follow `deploy/VM_NGINX_CLOUDFLARE.md`.

The web MVP is designed for one trusted self-hosted instance. Put Cloudflare
Access or Nginx authentication in front of it before exposing it publicly.

## Verified result

The included Indonesian demo was exercised end to end using `faster-whisper` model `small` on CPU. It produced two playable portrait clips:

- `artifacts/demo-output-verified/clip-01.mp4` — 720×1280, 44.47 s
- `artifacts/demo-output-verified/clip-02.mp4` — 720×1280, 23.70 s
- Both use H.264 video, AAC audio, square pixels, and burned-in subtitles.
- `artifacts/demo-output-verified/manifest.json` records boundaries, scores, transcript, and output paths.

Generated media is excluded from Git because it is reproducible and relatively large.

## Requirements

- Linux/macOS with `ffmpeg` and `ffprobe`
- Python 3.11+
- `uv`
- Internet access on first run to download a faster-whisper model

No API key is required for the local CPU path.

## Setup

```bash
cd /home/revdonz/Projects/ai-video-clipper
uv sync --dev --extra transcribe --extra vision
```

## Run

```bash
uv run ai-clipper /path/to/source.mp4 \
  --output-dir artifacts/my-output \
  --model small \
  --language id \
  --min-duration 20 \
  --max-duration 45 \
  --limit 5 \
  --width 720 \
  --height 1280 \
  --render-mode face-track
```

For a CUDA machine, add `--device cuda`. The current machine has no `nvidia-smi`, so the verified demo used CPU inference and `libx264` rendering.

## Outputs

Each run writes:

```text
output/
├── transcript.json
├── manifest.json
├── clip-01.srt
├── clip-01.mp4
└── ...
```

## Tests and lint

```bash
uv run pytest
uv run ruff check .
```

Current verified Python result: **58 tests passed**. Targeted Ruff checks for the
new Selection V2 domain models pass.

## What is real today

- Local Indonesian transcription with faster-whisper
- Configurable duration and clip count
- Deterministic transcript-window scoring
- Non-overlapping highlight selection
- Portrait center-crop fallback
- Selectable portrait layout: `face-track`, `fit-blur`, or `center-crop`
- OpenCV face tracking with smoothed crop movement across speaker shots
- Short, proportionally timed subtitle cues
- Subtitle burn-in
- H.264/AAC MP4 rendering
- Machine-readable manifest
- Fail-closed manifest states (`processing`, `completed`, or `failed`)
- Runnable CLI
- Authenticated Next.js dashboard, public landing page, and persistent project history
- YouTube and direct upload ingestion through the web worker
- Interactive stage-based worker progress

## Next phase: Selection V2 and customized editor

- Evidence and design findings:
  `docs/research/TIKTOK_CLIPPER_REFERENCE_ANALYSIS.md`
- Task-by-task implementation plan:
  `docs/plans/2026-08-28-clip-selection-v2-custom-editor.md`
- Selection V2 domain models are being introduced behind the existing stable V1
  pipeline; they are not active in production yet.

## Important limitations

- Highlight selection is currently a deterministic transcript heuristic, not an LLM or multimodal virality model.
- Face tracking follows the most prominent detected face; it does not yet use audio
  diarization to prove which visible person is actively speaking.
- Faster-whisper segment timestamps are used; word-level karaoke timing is not implemented.
- The web worker is single-instance and does not yet have a durable queue, database,
  billing, quota/retention policy, or restart recovery for interrupted jobs.
- There is no user-facing correction editor yet; the customized editor is planned in
  the Selection V2 roadmap.
- “Potential score” is a ranking heuristic and must never be marketed as a guarantee of virality.

See `spikes/001-transcribe-highlight-render/README.md` for the evidence and verdict.
