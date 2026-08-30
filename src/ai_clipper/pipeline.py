"""End-to-end orchestration for the technical spike."""

from __future__ import annotations

import json
import math
import os
import re
import stat
import uuid
from collections.abc import Callable
from dataclasses import asdict
from numbers import Real
from pathlib import Path
from typing import Any

from .candidates import generate_candidates
from .features import extract_features
from .highlight import select_highlights
from .media_features import analyze_media
from .models import ClipProfile, SelectionMode
from .ranking import (
    MAX_RANKING_INPUTS,
    SELECTION_VERSION,
    CandidatesArtifact,
    RankedInput,
    WeightConfig,
    rank_candidates_with_breakdowns,
    write_candidates_artifact,
)
from .render import render_vertical, validate_render_mode
from .transcribe import transcribe_video

MAX_MEDIA_CANDIDATES = 100
MAX_MEDIA_TIMEOUT = 300.0
DEFAULT_MAX_CANDIDATES = 200
DEFAULT_MAX_MEDIA_CANDIDATES = 12
DEFAULT_MEDIA_TIMEOUT = 30.0
_CANDIDATES_ARTIFACT = Path("analysis/candidates.v2.json")
_SAFE_INPUT_KEY = re.compile(r"\A\d+:\d+\Z")


def _publish_manifest(path: Path, payload: dict[str, object]) -> None:
    """Atomically replace the public manifest with one complete state."""
    pending_path = path.with_name(".manifest.json.next")
    pending_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    pending_path.replace(path)


def _bounded_integer(value: object, name: str, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if not 1 <= value <= maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value


def _positive_integer(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _bounded_timeout(value: object) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError("media_timeout must be a number")
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= MAX_MEDIA_TIMEOUT:
        raise ValueError(f"media_timeout must be finite and between 0 and {MAX_MEDIA_TIMEOUT}")
    return result


def _safe_candidate_key(input_key: str, ordinal: int) -> str:
    """Return only an internally generated numeric candidate identifier."""
    return input_key if _SAFE_INPUT_KEY.fullmatch(input_key) else str(ordinal)


def _archive_current_artifact(output_dir: Path) -> Path | None:
    """Move the canonical artifact aside without following links or deleting data."""
    current = output_dir / _CANDIDATES_ARTIFACT
    if current.parent.is_symlink():
        raise ValueError("analysis directory must not be a symlink")
    if not os.path.lexists(current):
        return None
    mode = current.lstat().st_mode
    if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
        raise ValueError("current candidates artifact must be a regular file or symlink")
    previous = current.with_name(f"{current.name}.previous")
    if os.path.lexists(previous):
        while True:
            previous = current.with_name(f"{current.name}.previous.{uuid.uuid4().hex}")
            if not os.path.lexists(previous):
                break
    os.replace(current, previous)
    return previous


def _run_v2_shadow(
    source: Path,
    output_dir: Path,
    segments: list[Any],
    *,
    profile: ClipProfile,
    max_candidates: int,
    max_media_candidates: int,
    media_timeout: float,
    k: int,
    report: Callable[[str, int, str], None],
) -> dict[str, object]:
    analysis_id = uuid.uuid4().hex
    warnings: list[str] = []
    try:
        _archive_current_artifact(output_dir)
        report("candidates_generating", 58, "Membuat kandidat V2 dari batas transkrip")
        boundaries = generate_candidates(
            segments,
            profile,
            max_candidates=max_candidates,
        )
        if not boundaries:
            raise ValueError("no V2 candidates satisfy the selected profile")

        report("features", 58, "Mengukur fitur teks kandidat V2")
        text_inputs = [
            RankedInput(
                f"{candidate.start_index}:{candidate.end_index}",
                candidate,
                extract_features(candidate),
            )
            for candidate in boundaries
        ]
        report("ranking", 59, "Membuat shortlist teks V2")
        shortlist = rank_candidates_with_breakdowns(
            text_inputs,
            source=str(source),
            profile=profile,
            k=min(max_media_candidates, len(text_inputs)),
        )
        input_by_interval = {
            (item.candidate.start, item.candidate.end): item for item in text_inputs
        }
        shortlisted_inputs = [
            input_by_interval[(candidate.start, candidate.end)]
            for candidate in shortlist.candidates
        ]

        report("media", 59, "Mengukur media hanya untuk shortlist V2")
        rerank_inputs: list[RankedInput] = []
        for ordinal, item in enumerate(shortlisted_inputs, start=1):
            safe_key = _safe_candidate_key(item.input_key, ordinal)
            try:
                measured = analyze_media(
                    source,
                    start=item.candidate.start,
                    end=item.candidate.end,
                    timeout=media_timeout,
                )
                if measured.warnings:
                    warnings.append(
                        f"candidate {safe_key}: media_analysis_warnings={len(measured.warnings)}"
                    )
                rerank_inputs.append(
                    RankedInput(item.input_key, item.candidate, item.extraction, measured)
                )
            except Exception:  # noqa: BLE001 - isolate each shadow media measurement
                warnings.append(f"candidate {safe_key}: media_unavailable")
                rerank_inputs.append(item)

        selection = rank_candidates_with_breakdowns(
            rerank_inputs,
            source=str(source),
            profile=profile,
            k=min(k, len(rerank_inputs)),
        )
        artifact = CandidatesArtifact(
            selection_version=SELECTION_VERSION,
            source=str(source),
            provenance=(
                "pipeline: transcript boundary candidates",
                "pipeline: deterministic text shortlist before bounded media analysis",
            ),
            weight_config=WeightConfig(),
            candidates=selection.candidates,
            breakdowns=selection.breakdowns,
            media_snapshots=selection.media_snapshots,
        )
        artifact_path = output_dir / _CANDIDATES_ARTIFACT
        write_candidates_artifact(artifact_path, artifact)
        report("candidates_ready", 60, "Kandidat bayangan V2 siap")
        return {
            "mode": SelectionMode.V2_SHADOW.value,
            "status": "completed",
            "analysis_id": analysis_id,
            "selection_version": SELECTION_VERSION,
            "candidate_count": len(selection.candidates),
            "artifact": _CANDIDATES_ARTIFACT.as_posix(),
            "warnings": warnings,
        }
    except Exception:  # noqa: BLE001 - the entire V2 shadow must not break V1
        try:
            _archive_current_artifact(output_dir)
        except Exception:  # noqa: BLE001 - preserve the original isolated shadow failure
            warnings.append("artifact_archive_failed")
        return {
            "mode": SelectionMode.V2_SHADOW.value,
            "status": "failed",
            "analysis_id": analysis_id,
            "selection_version": SELECTION_VERSION,
            "candidate_count": 0,
            "artifact": _CANDIDATES_ARTIFACT.as_posix(),
            "warnings": warnings,
            "error": "shadow_failed",
        }


def run_pipeline(
    source: Path,
    output_dir: Path,
    *,
    model: Any,
    language: str | None = "id",
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    limit: int = 5,
    width: int = 1080,
    height: int = 1920,
    render_mode: str = "center-crop",
    selection_mode: SelectionMode | str = SelectionMode.V1,
    clip_profile: ClipProfile | str = ClipProfile.STANDARD,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    max_media_candidates: int = DEFAULT_MAX_MEDIA_CANDIDATES,
    media_timeout: float = DEFAULT_MEDIA_TIMEOUT,
    progress: Callable[[str, int, str], None] | None = None,
) -> Path:
    """Transcribe, select highlights, render clips, and publish a status manifest."""
    source = Path(source).resolve()
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    manifest_base: dict[str, object] = {"source": str(source), "render_mode": render_mode}
    _publish_manifest(manifest_path, {**manifest_base, "status": "processing"})
    selection_v2_summary: dict[str, object] | None = None

    def report(stage: str, percent: int, detail: str) -> None:
        if progress is not None:
            progress(stage, percent, detail)

    try:
        if not isinstance(selection_mode, (SelectionMode, str)):
            raise TypeError("selection_mode must be a SelectionMode or string")
        selection_mode = SelectionMode(selection_mode)
        if not isinstance(clip_profile, (ClipProfile, str)):
            raise TypeError("clip_profile must be a ClipProfile or string")
        clip_profile = ClipProfile(clip_profile)
        limit = _positive_integer(limit, "limit")
        max_candidates = _bounded_integer(max_candidates, "max_candidates", MAX_RANKING_INPUTS)
        max_media_candidates = _bounded_integer(
            max_media_candidates, "max_media_candidates", MAX_MEDIA_CANDIDATES
        )
        max_media_candidates = min(max_media_candidates, max_candidates)
        media_timeout = _bounded_timeout(media_timeout)
        report("analyzing", 26, "Memeriksa video dan memuat model AI")
        validate_render_mode(render_mode)
        report("transcribing", 30, "Mendengarkan dan menulis transkrip")
        transcription = transcribe_video(
            source,
            model=model,
            language=language,
            progress_callback=lambda fraction: report(
                "transcribing",
                30 + round(fraction * 27),
                f"Transkripsi audio {round(fraction * 100)}%",
            ),
        )
        if not transcription.segments:
            raise ValueError("Transcription produced no usable segments")

        if selection_mode is SelectionMode.V2_SHADOW:
            selection_v2_summary = _run_v2_shadow(
                source,
                output_dir,
                transcription.segments,
                profile=clip_profile,
                max_candidates=max_candidates,
                max_media_candidates=max_media_candidates,
                media_timeout=media_timeout,
                k=limit,
                report=report,
            )

        report("selecting", 60, "Menilai dan memilih momen terbaik")
        highlights = select_highlights(
            transcription.segments,
            min_duration=min_duration,
            max_duration=max_duration,
            limit=limit,
        )
        if not highlights:
            raise ValueError("No eligible highlights found within the requested duration bounds")

        transcript_path = output_dir / "transcript.json"
        transcript_path.write_text(
            json.dumps(
                {
                    "language": transcription.language,
                    "segments": [asdict(segment) for segment in transcription.segments],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        clips: list[dict[str, object]] = []
        for index, highlight in enumerate(highlights, start=1):
            report(
                "rendering",
                65 + round(((index - 1) / len(highlights)) * 29),
                f"Merender klip {index} dari {len(highlights)}",
            )
            clip_path = output_dir / f"clip-{index:02d}.mp4"
            render_vertical(
                source,
                clip_path,
                start=highlight.start,
                end=highlight.end,
                transcript=transcription.segments,
                width=width,
                height=height,
                render_mode=render_mode,
            )
            clips.append(
                {
                    "index": index,
                    "start": round(highlight.start, 3),
                    "end": round(highlight.end, 3),
                    "duration": round(highlight.end - highlight.start, 3),
                    "score": highlight.score,
                    "text": highlight.text,
                    "output": str(clip_path),
                    "subtitles": str(clip_path.with_suffix(".srt")),
                }
            )

        report("finalizing", 96, "Menyimpan hasil, subtitle, dan metadata")
        completed_manifest: dict[str, object] = {
            **manifest_base,
            "status": "completed",
            "language": transcription.language,
            "transcript": str(transcript_path),
            "clips": clips,
            "render_mode": render_mode,
        }
        if selection_v2_summary is not None:
            completed_manifest["selection_v2"] = selection_v2_summary
        _publish_manifest(manifest_path, completed_manifest)
        return manifest_path
    except Exception as exc:
        failed_manifest: dict[str, object] = {
            **manifest_base,
            "status": "failed",
            "error": str(exc),
        }
        if selection_v2_summary is not None:
            failed_manifest["selection_v2"] = selection_v2_summary
        _publish_manifest(
            manifest_path,
            failed_manifest,
        )
        raise
