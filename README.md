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

Candidate review requests validate `analysis/candidates.v2.json` through
`python -m ai_clipper.candidate_api`; Python's `CandidatesArtifact` contract is
the sole semantic validator. The authenticated Next.js route securely opens and
bounds the artifact, passes those exact bytes over stdin, and accepts only a
strict presentation DTO with source, raw provenance, credentials, weight config,
and internal media IDs removed. One bounded Python subprocess per request is an
intentional trade-off for this occasional review endpoint. `PYTHON_BIN` may select
the interpreter (default `python`), and `CANDIDATE_VALIDATOR_TIMEOUT_MS` controls
the timeout (default 5000 ms, capped at 30000 ms).

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

The CLI still defaults to `--selection-mode v1` for compatibility. For Selection V3, add
`--selection-mode v3`. The optional flags are `--llm auto|off|required`,
`--no-cold-open`, `--no-hook-overlay`, `--caption-style classic|karaoke`, and
`--captions-dir DIR`, where `DIR` holds YouTube json3 captions in `manual/` and `auto/`.
The dashboard sends `v3` by default.

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

## Selection V3: AI hook clips (default di dashboard)

**Bahasa Indonesia.** Mode bawaan dashboard sekarang **AI Hook (V3)**:

- **LLM gratis dulu.** Transkrip (bukan video) dikirim ke penyedia LLM yang kompatibel
  OpenAI. Urutan yang disarankan: `ollama-cloud → openrouter → gemini → groq`, dengan
  `POTONGIN_LLM_FREE_ONLY=1`. Penyedia yang gagal atau key-nya kosong dilewati. Kalau semua
  gagal atau LLM dimatikan, pemilih **heuristik lokal** (tanpa internet) dipakai, dan job
  tetap selesai. Dashboard menampilkan status LLM tanpa pernah menampilkan key. Penyedia,
  API key, URL, dan model diatur di halaman **Pengaturan** (`/settings`), jadi `.env` tidak
  perlu diedit (key disimpan terenkripsi di `/data/settings`; `.env` bisa diimpor sekali klik).
  Setup: [`docs/operations/LLM_PROVIDERS.md`](docs/operations/LLM_PROVIDERS.md).
- **Jalur cepat subtitle YouTube.** Untuk URL YouTube, worker mencoba mengunduh subtitle
  manual dan otomatis (json3) setelah videonya. Kalau kualitasnya cukup, engine melewati
  Whisper. Kalau tidak ada atau kualitasnya buruk, Whisper lokal tetap dipakai.
- **Cold open.** Kalimat terkuat bisa diputar lebih dulu, lalu klip berjalan dari awal.
- **Teks hook.** Kalimat pemancing singkat tampil di atas layar selama 4 detik pertama.
- **Subtitle karaoke.** Subtitle mengikuti waktu per kata, dan kata yang sedang diucapkan
  menyala. Gaya klasik masih tersedia.
- **Kemasan siap posting.** Setiap klip punya judul, teks hook, deskripsi, hashtag,
  arketipe, alasan dipilih, dan skor 0–10 (hook, berdiri sendiri, payoff, emosi, layak
  dibagikan). Semua tampil di halaman detail proyek dan bisa disalin sekali klik.
- **Benchmark.** Pemilihan diukur terhadap label emas (Recall@K, Precision@K, trap):
  [`docs/evaluation/SELECTION_BENCHMARK.md`](docs/evaluation/SELECTION_BENCHMARK.md).
  Angka hasil benchmark V3 belum dipublikasikan.
- Standar kualitas klip: [`docs/operations/STANDAR_KLIP_AI.md`](docs/operations/STANDAR_KLIP_AI.md).
- Mode lama **Klasik V1** dan **V2 shadow** tetap ada di bawah "Mode lama". Job lama
  tampil persis seperti sebelumnya.

**English.** The dashboard now defaults to **AI Hook (V3)**:

- **Free-first LLM selection.** Only transcript text is sent, to any OpenAI-compatible
  provider, tried in order (recommended `ollama-cloud, openrouter, gemini, groq` with
  `POTONGIN_LLM_FREE_ONLY=1`). When every provider fails, or the LLM is off, a local
  heuristic selector (no network) picks the moments and the job still completes. The
  status is reported as `selection_v3.status = "fallback"`. Providers, API keys, base URLs
  and models are managed on the **Pengaturan** page (`/settings`, `/api/settings/llm`); keys
  are sealed with AES-256-GCM in `/data/settings` and the worker hands them only to the
  engine process. Without a settings file the environment is used (one-click import).
  `GET /api/llm/status` (authenticated) reports the effective configuration: no network
  calls, and never key values.
- **YouTube captions fast path.** After the video download, two best-effort `yt-dlp` runs
  fetch manual and automatic json3 captions into `input/captions/{manual,auto}`. The engine
  gets `--captions-dir` only when a caption file exists, uses the captions when they pass
  its quality gate, and otherwise runs Whisper. Caption failures never fail a job.
- **Hook packaging.** An optional cold open (`--cold-open`), a 4-second on-screen hook
  (`--hook-overlay`), and word-timed karaoke captions (`--caption-style karaoke`). Clip
  length follows the dashboard's minimum and maximum duration.
- **Manifest.** Each clip gains `title`, `hook_text`, `description`, `hashtags`,
  `archetype`, `selection_source`, `reasons`, `scores`, `cold_open`, `source_start` and
  `source_end`. The top level gains `selection_v3`. The web worker sanitizes every string
  (length caps, control and bidi characters stripped) and allowlists the summary before it
  persists anything.
- **Benchmark.** Gold-label evaluation is described in
  `docs/evaluation/SELECTION_BENCHMARK.md`. No V3 numbers are claimed yet.
- The contracts are in `docs/plans/2026-09-24-selection-v3-llm-hooks.md`.

## Konteks Tren: tren dari agen luar

**Bahasa Indonesia.** Potongin bisa menerima **konteks tren** (orang, topik, jokes/meme, sound,
hashtag yang sedang ramai di Indonesia) dari agen milik pemilik, misalnya Hermes Agent, lewat
`POST /api/ingest/trends` dengan token `ptk_…`. Potongin sendiri tidak men-scrape platform apa
pun. Tren hanya dipakai untuk kemasan klip V3 (judul, teks hook, deskripsi, hashtag) dan dorongan
peringkat kecil, dan hanya bila transkrip klip benar-benar menyebutnya. Tanpa item aktif,
hasilnya identik. Item dan token dikelola di halaman **Konteks Tren** (`/trends`).

- Paket agen (skill Hermes, prompt cron, OpenAPI, `scripts/trends/push_trends.py`):
  [`docs/integrations/hermes-trends/README.md`](docs/integrations/hermes-trends/README.md).
- Panduan operator (token, file, batas, keamanan, cara mematikan):
  [`docs/operations/TREND_CONTEXT.md`](docs/operations/TREND_CONTEXT.md).

**English.** An owner-run agent pushes trending Indonesian topics to a token-authenticated
endpoint; Selection V3 uses them only for packaging and a capped ranking boost when a clip's
transcript actually mentions them, with no change at all when no trend items are active.

## Fokus klip: cari momen tentang kata kunci tertentu

**Bahasa Indonesia.** Di dashboard (mode V3) pemilik bisa mengisi kata kunci yang dicari
(misalnya "jomok") dan catatan untuk AI. Klip yang cocok diutamakan, sisa slot diisi momen
terbaik lain berlabel "Di luar fokus". Setiap klip berlabel "Menyebut 'jomok' · 12:34" (dicek
kode pada transkrip, termasuk kata berimbuhan seperti "perjomokan"), "Terkait 'jomok' (menurut
AI)", atau "Di luar fokus"; halaman proyek menampilkan "n dari k klip cocok". Kalau AI
mengusulkan terlalu sedikit momen fokus, AI ditanya sekali lagi tentang sebutan yang terlewat
(top-up fokus), dan sebutan yang tetap tidak diambil AI boleh diisi jendela heuristik sebelum
klip di luar fokus. Sapaan dan teaser pembuka tidak pernah dihitung. Tanpa kata kunci, hasilnya
identik dengan sebelumnya.

- Aturan, batas, kode peringatan:
  [`docs/operations/STANDAR_KLIP_AI.md`](docs/operations/STANDAR_KLIP_AI.md), bagian "Fokus klip".
- Spesifikasi: [`docs/plans/2026-09-25-fokus-klip.md`](docs/plans/2026-09-25-fokus-klip.md).

**English.** A V3 job may carry 1-8 focus terms and a note (`focusTerms`/`focusNote` form
fields, `options.focus`, CLI `--focus-term`/`--focus-note`). Matching clips (literal, checked
in code with Indonesian affixes; or semantic, the LLM's claim) rank before every clip outside
the focus (LLM matches first, then heuristic windows around mentions the LLM never looked at),
unless they score well below their source's own picks; clips outside the focus only fill the
slots left. When the LLM proposes too few focus moments, one extra request asks it about the
mentions it left out (the focus top-up). The episode's opening (teaser montage, channel
greeting) never counts for the focus. Each clip gets
`focus: {match, terms, at}` and the summary `focus: {terms, matched, requested}`. Without focus
terms every output is unchanged.

## What is real today

- Local Indonesian transcription with faster-whisper, word timestamps, and a transcript
  quality gate; YouTube captions can replace Whisper when their quality is good enough
- Selection V3 (dashboard default): LLM moment selection with ordered provider failover
  and a deterministic heuristic fallback; V1 and V2 shadow remain selectable
- Cold open, on-screen hook text, and karaoke or classic burned-in captions
- Selectable portrait layout: `face-track`, `fit-blur`, or `center-crop`
- OpenCV face tracking with smoothed crop movement across speaker shots
- H.264/AAC MP4 rendering with downloadable SRT that matches the burned captions
- Machine-readable, fail-closed manifest (`processing`, `completed`, or `failed`)
- Authenticated Next.js dashboard, durable job queue with fenced leases, persistent
  project history, candidate editor for V2 shadow candidates, and project deletion
- YouTube and direct upload ingestion through the web worker, with stage-based progress

## Important limitations

- LLM selection depends on free tiers whose quotas and model IDs change often. Fallback to
  the heuristic selector keeps jobs working, but its picks are weaker. The dashboard says
  when this happened.
- The benchmark gold labels were written by an LLM acting as an editor. They are a proxy
  until owner labels and real retention analytics exist.
- Face tracking follows the most prominent detected face; there is no audio diarization,
  so it cannot prove which visible person is speaking.
- Scores rank moments against each other. They are not a prediction or guarantee of
  virality and must never be marketed as one.
- The worker is designed for one trusted self-hosted instance. There is no database,
  billing, or multi-tenant isolation.

See `spikes/001-transcribe-highlight-render/README.md` for the evidence and verdict.
