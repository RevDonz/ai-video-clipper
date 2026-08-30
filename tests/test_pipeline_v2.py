import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

import ai_clipper.pipeline as pipeline_module
from ai_clipper.candidates import BoundaryCandidate
from ai_clipper.media_features import (
    ANALYZER_VERSION,
    AudioFeatures,
    MediaFeatureAnalysis,
    VisualFeatures,
)
from ai_clipper.models import ClipProfile, SelectionMode, Transcription, TranscriptSegment
from ai_clipper.ranking import SELECTION_VERSION, read_candidates_artifact

SEGMENTS = [
    TranscriptSegment(0.0, 15.0, "Mau tahu cara mengurangi biaya cloud?"),
    TranscriptSegment(15.0, 30.0, "Jawabannya adalah audit tagihan cloud setiap minggu."),
    TranscriptSegment(30.0, 45.0, "Gunakan batas anggaran agar biaya cloud tetap terkendali."),
    TranscriptSegment(45.0, 60.0, "Langkah ini membuat tim memilih layanan dengan disiplin."),
]


def _stub_v1(monkeypatch: pytest.MonkeyPatch, calls: list[object]) -> None:
    monkeypatch.setattr(
        pipeline_module,
        "transcribe_video",
        lambda *args, **kwargs: Transcription("id", SEGMENTS),
    )
    monkeypatch.setattr(
        pipeline_module,
        "select_highlights",
        lambda *args, **kwargs: [
            SimpleNamespace(start=0.0, end=30.0, score=7.0, text="V1 exact result")
        ],
    )
    monkeypatch.setattr(
        pipeline_module,
        "render_vertical",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )


def test_selection_mode_is_strict_and_defaults_to_v1():
    assert SelectionMode.V1.value == "v1"
    assert SelectionMode.V2_SHADOW.value == "v2-shadow"
    assert SelectionMode("v1") is SelectionMode.V1
    with pytest.raises(ValueError):
        SelectionMode("v2")


def test_v1_default_never_calls_v2_or_changes_completed_manifest(monkeypatch, tmp_path: Path):
    calls: list[object] = []
    _stub_v1(monkeypatch, calls)
    monkeypatch.setattr(
        pipeline_module,
        "generate_candidates",
        lambda *args, **kwargs: pytest.fail("V2 generation called in v1 mode"),
    )

    manifest_path = pipeline_module.run_pipeline(
        tmp_path / "source.mp4", tmp_path / "out", model=object()
    )

    source = (tmp_path / "source.mp4").resolve()
    output = (tmp_path / "out").resolve()
    expected = {
        "source": str(source),
        "render_mode": "center-crop",
        "status": "completed",
        "language": "id",
        "transcript": str(output / "transcript.json"),
        "clips": [
            {
                "index": 1,
                "start": 0.0,
                "end": 30.0,
                "duration": 30.0,
                "score": 7.0,
                "text": "V1 exact result",
                "output": str(output / "clip-01.mp4"),
                "subtitles": str(output / "clip-01.srt"),
            }
        ],
    }
    assert manifest_path.read_text() == json.dumps(expected, ensure_ascii=False, indent=2)
    assert not (tmp_path / "out" / "analysis" / "candidates.v2.json").exists()
    assert len(calls) == 1


def _media(source: Path, start: float, end: float) -> MediaFeatureAnalysis:
    return MediaFeatureAnalysis(
        analyzer_version=ANALYZER_VERSION,
        analysis_id=f"media-{start}-{end}",
        source=str(source.resolve()),
        source_duration=60.0,
        window_start=start,
        window_end=end,
        audio=AudioFeatures(None, 8.0, (), 0.0, 7.0, 10),
        visual=VisualFeatures((), 6.0, 5.0, 0.5, 4.0, 10),
        warnings=(),
        provenance=("test measurement",),
    )


def test_v2_shadow_writes_strict_artifact_but_v1_still_renders(monkeypatch, tmp_path: Path):
    render_calls: list[object] = []
    media_windows: list[tuple[float, float]] = []
    progress: list[tuple[str, int]] = []
    source = tmp_path / "source.mp4"
    source.touch()
    _stub_v1(monkeypatch, render_calls)

    def analyze(path: Path, *, start: float, end: float, **kwargs):
        media_windows.append((start, end))
        return _media(path, start, end)

    monkeypatch.setattr(pipeline_module, "analyze_media", analyze)

    manifest_path = pipeline_module.run_pipeline(
        source,
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
        clip_profile="standard",
        max_candidates=20,
        max_media_candidates=2,
        limit=2,
        progress=lambda stage, percent, detail: progress.append((stage, percent)),
    )

    manifest = json.loads(manifest_path.read_text())
    summary = manifest["selection_v2"]
    assert summary["mode"] == "v2-shadow"
    assert summary["status"] == "completed"
    assert summary["selection_version"] == SELECTION_VERSION
    assert summary["candidate_count"] == 1
    assert summary["artifact"] == "analysis/candidates.v2.json"
    assert isinstance(summary["analysis_id"], str) and summary["analysis_id"]
    artifact = read_candidates_artifact(tmp_path / "out" / summary["artifact"])
    assert len(artifact.candidates) == 1
    assert artifact.source == str(source.resolve())
    assert media_windows == [(0.0, 60.0)]
    assert manifest["clips"][0]["text"] == "V1 exact result"
    assert [candidate.start for candidate in artifact.candidates] == [0.0]
    assert all(candidate.profile is ClipProfile.STANDARD for candidate in artifact.candidates)
    assert all(snapshot is not None for snapshot in artifact.media_snapshots)
    assert [
        stage
        for stage, _ in progress
        if stage in {"candidates_generating", "features", "ranking", "media", "candidates_ready"}
    ] == ["candidates_generating", "features", "ranking", "media", "candidates_ready"]
    assert [percent for _, percent in progress] == sorted(percent for _, percent in progress)


def test_v2_exception_is_sanitized_and_falls_back_to_exact_v1(monkeypatch, tmp_path: Path):
    render_calls: list[object] = []
    _stub_v1(monkeypatch, render_calls)

    class SecretTokenInCustomExceptionName(RuntimeError):
        pass

    monkeypatch.setattr(
        pipeline_module,
        "generate_candidates",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            SecretTokenInCustomExceptionName("token=super-secret /private/source.mp4")
        ),
    )

    manifest_path = pipeline_module.run_pipeline(
        tmp_path / "source.mp4",
        tmp_path / "out",
        model=object(),
        selection_mode=SelectionMode.V2_SHADOW,
    )

    manifest = json.loads(manifest_path.read_text())
    assert manifest["status"] == "completed"
    assert manifest["clips"][0]["text"] == "V1 exact result"
    assert len(render_calls) == 1
    assert manifest["selection_v2"]["status"] == "failed"
    serialized = json.dumps(manifest)
    assert manifest["selection_v2"]["error"] == "shadow_failed"
    assert "super-secret" not in serialized
    assert "SecretTokenInCustomExceptionName" not in serialized
    assert not (tmp_path / "out" / "analysis" / "candidates.v2.json").exists()


def test_media_failure_is_per_candidate_and_preserves_text_only_candidate(
    monkeypatch, tmp_path: Path
):
    render_calls: list[object] = []
    _stub_v1(monkeypatch, render_calls)
    source = tmp_path / "source.mp4"
    source.touch()
    boundaries = [
        BoundaryCandidate(
            0,
            1,
            0.0,
            30.0,
            "Mau tahu biaya cloud? Jawabannya audit cloud.",
            ("transcript-edge",),
            ("segment",),
        ),
        BoundaryCandidate(
            2,
            3,
            30.0,
            60.0,
            "Gunakan anggaran. Solusinya kurangi biaya layanan.",
            ("segment",),
            ("transcript-edge",),
        ),
    ]
    monkeypatch.setattr(pipeline_module, "generate_candidates", lambda *args, **kwargs: boundaries)

    class SecretMediaExceptionName(RuntimeError):
        pass

    def analyze(path: Path, *, start: float, end: float, **kwargs):
        if start == 0.0:
            raise SecretMediaExceptionName("token=media-secret /private/media.mp4")
        return _media(path, start, end)

    monkeypatch.setattr(pipeline_module, "analyze_media", analyze)

    manifest_path = pipeline_module.run_pipeline(
        source,
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
        max_media_candidates=2,
        limit=2,
    )

    manifest = json.loads(manifest_path.read_text())
    artifact = read_candidates_artifact(tmp_path / "out" / "analysis" / "candidates.v2.json")
    assert manifest["selection_v2"]["status"] == "completed"
    assert len(artifact.candidates) == 2
    snapshots = {
        candidate.start: snapshot
        for candidate, snapshot in zip(artifact.candidates, artifact.media_snapshots, strict=True)
    }
    assert snapshots[0.0] is None
    assert snapshots[30.0] is not None
    assert manifest["selection_v2"]["warnings"] == ["candidate 0:1: media_unavailable"]
    serialized = json.dumps(manifest)
    assert "media-secret" not in serialized
    assert "SecretMediaExceptionName" not in serialized


def test_media_analysis_warnings_publish_only_safe_count(monkeypatch, tmp_path: Path):
    _stub_v1(monkeypatch, [])
    source = tmp_path / "source.mp4"
    source.touch()

    def analyze(path: Path, *, start: float, end: float, **kwargs):
        measured = _media(path, start, end)
        return replace(
            measured,
            warnings=(
                "token=warning-secret /private/analyzer.mp4",
                "ffmpeg command contained a credential",
            ),
        )

    monkeypatch.setattr(pipeline_module, "analyze_media", analyze)

    manifest_path = pipeline_module.run_pipeline(
        source,
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
    )

    summary = json.loads(manifest_path.read_text())["selection_v2"]
    assert summary["warnings"] == ["candidate 0:3: media_analysis_warnings=2"]
    serialized = json.dumps(summary)
    artifact_text = (tmp_path / "out" / "analysis" / "candidates.v2.json").read_text()
    assert "warning-secret" not in serialized
    assert "/private/analyzer.mp4" not in serialized
    assert "warning-secret" not in artifact_text
    assert "/private/analyzer.mp4" not in artifact_text


def test_stale_v2_artifact_is_moved_to_previous_before_failed_shadow(monkeypatch, tmp_path: Path):
    render_calls: list[object] = []
    _stub_v1(monkeypatch, render_calls)
    artifact = tmp_path / "out" / "analysis" / "candidates.v2.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("old candidate artifact")
    monkeypatch.setattr(
        pipeline_module,
        "generate_candidates",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("failed")),
    )

    manifest_path = pipeline_module.run_pipeline(
        tmp_path / "source.mp4",
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
    )

    assert not artifact.exists()
    assert artifact.with_name("candidates.v2.json.previous").read_text() == "old candidate artifact"
    assert json.loads(manifest_path.read_text())["selection_v2"]["status"] == "failed"


def test_stale_rotation_preserves_existing_previous_and_failed_new_artifact(
    monkeypatch, tmp_path: Path
):
    _stub_v1(monkeypatch, [])
    artifact = tmp_path / "out" / "analysis" / "candidates.v2.json"
    previous = artifact.with_name("candidates.v2.json.previous")
    artifact.parent.mkdir(parents=True)
    artifact.write_text("stale canonical")
    previous.write_text("older archive")

    def fail_after_publish(stage: str, percent: int, detail: str) -> None:
        if stage == "candidates_ready":
            raise RuntimeError("callback secret")

    monkeypatch.setattr(
        pipeline_module,
        "analyze_media",
        lambda path, *, start, end, **kwargs: _media(path, start, end),
    )

    manifest_path = pipeline_module.run_pipeline(
        tmp_path / "source.mp4",
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
        progress=fail_after_publish,
    )

    assert not artifact.exists()
    assert previous.read_text() == "older archive"
    archives = sorted(artifact.parent.glob("candidates.v2.json.previous*"))
    assert len(archives) == 3
    archive_contents = [path.read_text() for path in archives]
    assert "older archive" in archive_contents
    assert "stale canonical" in archive_contents
    assert sum(content.startswith("{") for content in archive_contents) == 1
    summary = json.loads(manifest_path.read_text())["selection_v2"]
    assert summary["status"] == "failed"
    assert summary["error"] == "shadow_failed"


def test_success_archives_stale_artifact_without_overwriting_previous(monkeypatch, tmp_path: Path):
    _stub_v1(monkeypatch, [])
    artifact = tmp_path / "out" / "analysis" / "candidates.v2.json"
    previous = artifact.with_name("candidates.v2.json.previous")
    artifact.parent.mkdir(parents=True)
    artifact.write_text("stale canonical")
    previous.write_text("older archive")
    monkeypatch.setattr(
        pipeline_module,
        "analyze_media",
        lambda path, *, start, end, **kwargs: _media(path, start, end),
    )

    pipeline_module.run_pipeline(
        tmp_path / "source.mp4",
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
    )

    read_candidates_artifact(artifact)
    assert previous.read_text() == "older archive"
    archives = list(artifact.parent.glob("candidates.v2.json.previous.*"))
    assert len(archives) == 1
    assert archives[0].read_text() == "stale canonical"


def test_shadow_moves_symlink_artifact_without_following_target(monkeypatch, tmp_path: Path):
    render_calls: list[object] = []
    _stub_v1(monkeypatch, render_calls)
    artifact = tmp_path / "out" / "analysis" / "candidates.v2.json"
    artifact.parent.mkdir(parents=True)
    target = tmp_path / "outside.json"
    target.write_text("outside")
    artifact.symlink_to(target)
    monkeypatch.setattr(pipeline_module, "generate_candidates", lambda *args, **kwargs: [])

    manifest_path = pipeline_module.run_pipeline(
        tmp_path / "source.mp4",
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
    )

    manifest = json.loads(manifest_path.read_text())
    assert manifest["status"] == "completed"
    assert manifest["selection_v2"]["status"] == "failed"
    assert not artifact.exists()
    assert target.read_text() == "outside"
    archived = artifact.with_name("candidates.v2.json.previous")
    assert archived.is_symlink()
    assert archived.resolve() == target.resolve()


@pytest.mark.parametrize("fatal", [KeyboardInterrupt, SystemExit])
def test_shadow_does_not_swallow_process_control_exceptions(
    monkeypatch, tmp_path: Path, fatal: type[BaseException]
):
    _stub_v1(monkeypatch, [])
    monkeypatch.setattr(
        pipeline_module,
        "generate_candidates",
        lambda *args, **kwargs: (_ for _ in ()).throw(fatal()),
    )

    with pytest.raises(fatal):
        pipeline_module.run_pipeline(
            tmp_path / "source.mp4",
            tmp_path / "out",
            model=object(),
            selection_mode="v2-shadow",
        )


@pytest.mark.parametrize(
    ("option", "value", "error"),
    [
        ("selection_mode", True, TypeError),
        ("selection_mode", "v2", ValueError),
        ("clip_profile", True, TypeError),
        ("clip_profile", "long", ValueError),
        ("max_candidates", True, TypeError),
        ("max_candidates", 5001, ValueError),
        ("max_media_candidates", 101, ValueError),
        ("media_timeout", float("nan"), ValueError),
        ("media_timeout", True, TypeError),
        ("limit", 0, ValueError),
        ("limit", True, TypeError),
    ],
)
def test_v2_options_are_strictly_validated_before_transcription(
    monkeypatch, tmp_path: Path, option: str, value: object, error: type[Exception]
):
    called = False

    def transcribe(*args, **kwargs):
        nonlocal called
        called = True
        return Transcription("id", SEGMENTS)

    monkeypatch.setattr(pipeline_module, "transcribe_video", transcribe)
    with pytest.raises(error):
        pipeline_module.run_pipeline(
            tmp_path / "source.mp4", tmp_path / "out", model=object(), **{option: value}
        )
    assert called is False


def test_media_shortlist_cap_never_exceeds_candidate_cap(monkeypatch, tmp_path: Path):
    captured: dict[str, object] = {}
    _stub_v1(monkeypatch, [])

    def shadow(*args, **kwargs):
        captured.update(kwargs)
        return {"mode": "v2-shadow", "status": "failed"}

    monkeypatch.setattr(pipeline_module, "_run_v2_shadow", shadow)
    pipeline_module.run_pipeline(
        tmp_path / "source.mp4",
        tmp_path / "out",
        model=object(),
        selection_mode="v2-shadow",
        max_candidates=3,
        max_media_candidates=10,
    )

    assert captured["max_candidates"] == 3
    assert captured["max_media_candidates"] == 3
