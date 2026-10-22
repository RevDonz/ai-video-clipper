#!/usr/bin/env python3
"""A demo V3 job for the editor, made only from the landing's public clip (docs/design/LANDING.md).

The source is ``web/public/landing/sesudah.mp4`` (11 s, 9:16, *Elephants Dream*, CC BY 2.5),
copied, never re-encoded. Its words and times were read off the clip's own karaoke captions
(frames sampled in Chrome every 0.2 s). The layout is that of ``make_job.py``; ``prepare_job`` of
``ai_clipper.edit_v2.api`` then writes ``source.json``, the words, the peaks and the seed (FFmpeg
only probes and decodes). Revision 1 turns the editor's captions off: the source already carries
the captions it was rendered with. ``sourcePath`` is relative, so the folder can be copied into
any ``JOBS_ROOT``. Opening the clip in the editor makes the preview lane build its plate cells.

Usage::

    python scripts/editor_fixture/landing_demo.py JOBS_ROOT [JOB_ID]
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from ai_clipper.models import Transcription, TranscriptSegment, TranscriptWord
from ai_clipper.selection_types import SelectedClip, SelectionResult
from ai_clipper.selection_v3 import HEURISTIC_VERSION, write_selection_artifact
from ai_clipper.sentences import build_sentence_units
from ai_clipper.transcript_io import write_transcript_json
from ai_clipper.transcript_quality import assess_transcript, write_transcript_quality_json

DEMO = ROOT / "web" / "public" / "landing" / "sesudah.mp4"
SOURCE_NAME = "elephants-dream-contoh.mp4"
CREATED_AT = "2026-10-22T14:30:00.000Z"
DURATION_S = 11.0

# (start, end, text) per word in seconds of the clip, from its karaoke highlight.
SENTENCES = [
    [(0.15, 0.45, "On"), (0.45, 0.70, "the"), (0.70, 0.90, "right"), (0.90, 1.45, "side"),
     (1.50, 1.65, "you"), (1.65, 1.80, "can"), (1.80, 2.30, "see"), (2.30, 2.65, "the"),
     (2.70, 4.45, "Colossus"), (4.45, 4.75, "of"), (4.75, 5.30, "Rhodus.")],
    [(5.75, 6.00, "How's"), (6.00, 6.40, "that"), (6.40, 6.55, "for"), (6.55, 6.75, "a"),
     (6.80, 7.15, "trap?")],
    [(9.40, 9.75, "No,"), (9.75, 10.30, "Emo.")],
]
# Title, hook, archetype and scores as the real project showed them (web/public/landing/hasil.webp).
TITLE = "How's that for trap?"
HOOK = "On the right side you can see the Colossus of Rhodus."
SCORES = {"hook": 2.9, "standalone": 7.5, "payoff": 4.5, "emotion": 2.0, "shareability": 4.0}


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _api(jobs_root: Path, envelope: dict) -> dict:
    env = {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8",
           "JOBS_ROOT": str(jobs_root), "PYTHONPATH": str(ROOT / "src")}
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.api"],
                            input=json.dumps(envelope).encode(), capture_output=True, env=env,
                            timeout=600, check=False)
    body = json.loads(result.stdout or b"{}")
    if result.returncode != 0:
        raise SystemExit(f"{envelope['op']} exit {result.returncode}: {json.dumps(body)[:800]}")
    return body


def _transcription() -> Transcription:
    segments = [
        TranscriptSegment(start=words[0][0], end=words[-1][1], text=" ".join(w[2] for w in words),
                          words=tuple(TranscriptWord(start=s, end=e, text=t, probability=0.95)
                                      for s, e, t in words))
        for words in SENTENCES
    ]
    return Transcription(language="en", segments=segments)


def build(jobs_root: Path, job_id: str) -> dict:
    """Write the job under ``jobs_root/job_id``, prepare it and save revision 1."""
    job_dir = jobs_root / job_id
    if job_dir.exists():
        raise SystemExit(f"{job_dir} exists")
    source = job_dir / "input" / SOURCE_NAME
    source.parent.mkdir(parents=True)
    shutil.copyfile(DEMO, source)
    output = job_dir / "output"
    output.mkdir(parents=True)
    shutil.copyfile(DEMO, output / "clip-01.mp4")

    transcription = _transcription()
    segments = transcription.segments
    write_transcript_json(output / "transcript.json", transcription)
    quality = assess_transcript(segments, language="en")
    analysis = job_dir / "analysis"
    write_transcript_quality_json(analysis / "transcript-quality.json", quality)
    units = build_sentence_units(segments, quality=quality)
    text = " ".join(segment.text for segment in segments)
    clip = SelectedClip(
        rank=1, start=0.0, end=DURATION_S, cold_open=None,
        unit_ids=(units[0].unit_id, units[-1].unit_id), hook_unit_id=units[0].unit_id,
        title=TITLE, hook_text=HOOK,
        description="Contoh dari film terbuka Elephants Dream (2006), CC BY 2.5.",
        hashtags=("#elephantsdream", "#contoh"), archetype="curiosity_gap", score=3.9,
        scores=SCORES, reasons=("Klip contoh dari halaman depan Potongin",), source="heuristic",
        text=text,
    )
    write_selection_artifact(analysis / "selection.v3.json", SelectionResult(
        clips=(clip,), source="heuristic", status="completed", provider=None, model=None,
        prompt_version=HEURISTIC_VERSION))
    summary = {"mode": "v3", "status": "completed", "source": "heuristic", "provider": None,
               "model": None, "prompt_version": HEURISTIC_VERSION, "warnings": [],
               "artifact": "analysis/selection.v3.json", "transcript_source": "whisper"}
    manifest_clip = {
        "index": 1, "start": 0.0, "end": DURATION_S, "duration": DURATION_S, "score": 3.9,
        "text": text, "output": "output/clip-01.mp4", "subtitles": "output/clip-01.srt",
        "title": TITLE, "hook_text": HOOK, "description": clip.description,
        "hashtags": list(clip.hashtags), "archetype": clip.archetype,
        "selection_source": "heuristic", "reasons": list(clip.reasons), "scores": SCORES,
        "cold_open": None, "source_start": 0.0, "source_end": DURATION_S, "thumbnail": None,
    }
    _write_json(output / "manifest.json", {
        "source": f"input/{SOURCE_NAME}", "render_mode": "fit-blur", "status": "completed",
        "language": "en", "transcript": "output/transcript.json", "clips": [manifest_clip],
        "selection_v3": summary})
    options = {"renderMode": "fit-blur", "limit": 1, "minDuration": 5, "maxDuration": 60,
               "selectionMode": "v3", "llmMode": "off", "coldOpen": False, "hookOverlay": False,
               "captionStyle": "karaoke", "videoLanguage": "en"}
    job = {
        "id": job_id, "status": "completed", "progress": 100, "createdAt": CREATED_AT,
        "updatedAt": CREATED_AT, "completedAt": CREATED_AT,
        "source": {"type": "upload", "name": "Contoh Elephants Dream (11 detik).mp4",
                   "size": source.stat().st_size},
        "sourcePath": f"input/{SOURCE_NAME}", "options": options,
        "clips": [{
            "index": 1, "score": 3.9, "start": 0.0, "end": DURATION_S, "duration": DURATION_S,
            "text": text, "videoUrl": f"/api/jobs/{job_id}/files/output/clip-01.mp4",
            "downloadUrl": f"/api/jobs/{job_id}/files/output/clip-01.mp4?download=1",
            "title": TITLE, "hookText": HOOK,
            "description": f"{clip.description}\n\n{' '.join(clip.hashtags)}",
            "hashtags": list(clip.hashtags), "archetype": clip.archetype,
            "selectionSource": "heuristic", "reasons": list(clip.reasons), "scores": SCORES,
            "sourceStart": 0.0, "sourceEnd": DURATION_S, "metadataVersion": 5,
        }],
        "stage": "completed", "stageDetail": "Semua klip siap digunakan", "selectionV3": summary,
    }
    _write_json(job_dir / "job.json", job)

    prepared = _api(jobs_root, {"op": "prepare_job", "jobId": job_id})
    entry = prepared["clips"][0]
    if not entry["openable"]:
        raise SystemExit(f"not openable: {entry}")
    clip_id = entry["clipId"]
    seed = _api(jobs_root, {"op": "get", "jobId": job_id, "clipId": clip_id})
    doc = json.loads(json.dumps(seed["doc"]))
    doc["captions"]["enabled"] = False
    doc["revision"] = seed["doc"]["revision"] + 1
    doc["parent_sha256"] = seed["etag"]
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    saved = _api(jobs_root, {"op": "put", "jobId": job_id, "clipId": clip_id,
                             "expectedEtag": seed["etag"], "idempotencyKey": str(uuid.uuid4()),
                             "docRaw": base64.b64encode(raw).decode("ascii")})
    job["clips"][0]["clipId"] = clip_id
    _write_json(job_dir / "job.json", job)
    (job_dir / "analysis" / "clips" / ".prepare.lock").unlink(missing_ok=True)
    return {"jobId": job_id, "clipId": clip_id, "revision": saved["doc"]["revision"]}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not 1 <= len(args) <= 2:
        print(__doc__, file=sys.stderr)
        return 2
    job_id = args[1] if len(args) == 2 else str(uuid.uuid4())
    print(json.dumps(build(Path(args[0]).resolve(), job_id), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
