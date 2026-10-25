"""Codes beside the pipeline's Indonesian prose (rombak 07 §10.4, i18n M5).

A progress callback that takes ``code`` and ``params`` gets the stage code of every report (the
CLI writes them as ``stage_code``/``stage_params``); a three-argument callback is called as before.
Every V3 manifest clip has ``reason_codes`` (one per reason) and, when a warning names it,
``warning_codes``.
"""

from __future__ import annotations

import pytest
from test_pipeline_v3 import (  # the V3 pipeline fixture: fakes for every external stage
    GROQ,
    ForbiddenWhisper,
    env,  # noqa: F401 - pytest fixture
    manifest_of,
    result,
    run,
    segments,
    selected,
)

import ai_clipper.pipeline as pipeline_module
from ai_clipper.i18n_codes import REASON_CODES, STAGE_CODES, clip_warning_codes
from ai_clipper.models import Transcription
from ai_clipper.reason_codes import reason_code
from ai_clipper.time_ranges import TimeRange


def coded_progress(events: list[tuple[str, int, str, str | None, dict | None]]):
    def progress(stage, percent, detail, *, code=None, params=None):
        events.append((stage, percent, detail, code, params))

    return progress


def codes(events) -> list[str]:
    ordered: list[str] = []
    for *_rest, code, _params in events:
        if not ordered or ordered[-1] != code:
            ordered.append(code)
    return ordered


def test_every_v3_report_carries_a_known_stage_code(env):  # noqa: F811
    events: list = []
    manifest = manifest_of(run(env, progress=coded_progress(events)))

    assert manifest["status"] == "completed"
    assert all(code in STAGE_CODES for *_rest, code, _params in events)
    found = codes(events)
    assert found[0] == "analyze_video"
    assert found[-1] == "finalizing"
    for code in ("transcribe_audio", "audio_analysis", "select_heuristic", "packaging"):
        assert code in found
    renders = [(params, detail) for _s, _p, detail, code, params in events if code == "render_clip"]
    total = len(manifest["clips"])
    assert renders[0] == ({"index": 1, "total": total}, f"Merender klip 1 dari {total}")
    assert renders[-1][0] == {"index": total, "total": total}
    # the prose stays beside the code, for logs and older web images
    assert all(isinstance(detail, str) and detail for _s, _p, detail, *_rest in events)
    with_params = {"render_clip", "transcribe_progress"}
    assert all(params is None for *_rest, code, params in events if code not in with_params)


def test_three_argument_progress_callbacks_are_called_as_before(env):  # noqa: F811
    seen: list[tuple] = []
    run(env, progress=lambda *args, **kwargs: seen.append((args, kwargs)))
    assert seen and all(len(args) == 3 for args, _kwargs in seen)
    assert any(kwargs.get("code") == "render_clip" for _args, kwargs in seen)

    plain: list[tuple] = []
    run(env, progress=lambda stage, percent, detail: plain.append((stage, percent, detail)))
    assert plain and all(len(item) == 3 for item in plain)


def test_groq_and_its_progress_have_their_own_codes(env, monkeypatch):  # noqa: F811
    def groq(source, **options):
        options["progress_callback"](0.5)
        return Transcription("id", segments())

    monkeypatch.setattr(pipeline_module, "transcribe_with_groq", groq)
    events: list = []
    run(env, model=ForbiddenWhisper(), groq=GROQ, progress=coded_progress(events))

    coded = [(code, params) for *_rest, code, params in events]
    assert ("transcribe_groq", None) in coded
    assert ("transcribe_groq_progress", {"percent": 50}) in coded
    assert "transcribe_audio" not in codes(events)


def test_typed_ranges_that_take_every_slot_report_select_ranges(env):  # noqa: F811
    events: list = []
    ranges = (TimeRange(10, 40), TimeRange(80, 110))
    run(env, limit=2, ranges=ranges, progress=coded_progress(events))
    assert "select_ranges" in codes(events)
    assert "select_heuristic" not in codes(events)


@pytest.mark.parametrize("fraction, percent", [(0.0, 0), (0.37, 37), (1.0, 100)])
def test_whisper_progress_carries_its_percent(env, monkeypatch, fraction, percent):  # noqa: F811
    real = pipeline_module.transcribe_video

    def transcribe(source, **options):
        options["progress_callback"](fraction)
        return real(source, **options)

    monkeypatch.setattr(pipeline_module, "transcribe_video", transcribe)
    events: list = []
    run(env, progress=coded_progress(events))
    assert ("transcribe_progress", {"percent": percent}) in [
        (code, params) for *_rest, code, params in events
    ]


def test_cli_writes_stage_code_and_params_beside_the_detail(monkeypatch, tmp_path, capsys):
    """web/scripts/run-job.mjs reads stage_code/stage_params; older readers ignore them."""
    from test_cli import WEB_V3_ARGS, _progress_events

    from ai_clipper import cli

    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")

    def pipeline(*args, progress, stage_summary, **kwargs):
        progress("transcribing", 40, "Transkripsi audio 37%", code="transcribe_progress",
                 params={"percent": 37})  # fmt: skip
        stage_summary("transcript", {"words": 12, "source": "whisper"})
        progress("audio", 58, "Menganalisis jeda dan energi audio", code="audio_analysis")
        progress("audio", 59, "Teks tanpa kode")
        manifest = tmp_path / "manifest.json"
        manifest.touch()
        return manifest

    monkeypatch.setattr(cli, "run_pipeline", pipeline)

    assert cli.main(WEB_V3_ARGS) == 0

    coded = {"stage_code": "transcribe_progress", "stage_params": {"percent": 37}}
    assert _progress_events(capsys.readouterr().out) == [
        {"stage": "transcribing", "progress": 40, "detail": "Transkripsi audio 37%", **coded},
        {
            "stage": "transcribing",
            "progress": 40,
            "detail": "Transkripsi audio 37%",
            **coded,
            "summary": {"transcript": {"words": 12, "source": "whisper"}},
        },
        {
            "stage": "audio",
            "progress": 58,
            "detail": "Menganalisis jeda dan energi audio",
            "stage_code": "audio_analysis",
        },
        {"stage": "audio", "progress": 59, "detail": "Teks tanpa kode"},
    ]


# --- reason_codes and warning_codes on the manifest clips ------------------------------------


def test_heuristic_clips_carry_one_reason_code_per_reason(env):  # noqa: F811
    manifest = manifest_of(run(env))

    assert manifest["clips"]
    for clip in manifest["clips"]:
        assert clip["selection_source"] == "heuristic"
        coded = clip["reason_codes"]
        assert len(coded) == len(clip["reasons"])
        assert coded == [reason_code(reason) for reason in clip["reasons"]]
        assert all(entry["code"] in REASON_CODES for entry in coded), coded
        assert "warning_codes" not in clip


def test_an_llm_reason_is_text_shown_as_written(env, monkeypatch):  # noqa: F811
    reasons = ("Alasan kuat.", "Peringkat ulang LLM: 8,0/10")
    chosen = result(selected(1, 100.0, 130.0, reasons=reasons))
    monkeypatch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: chosen)

    [clip] = manifest_of(run(env))["clips"]

    assert clip["reasons"] == list(reasons)
    assert clip["reason_codes"] == [
        {"code": "text", "params": {"text": "Alasan kuat."}},
        {"code": "llm_rerank", "params": {"score": 8.0}},
    ]


def test_a_clip_without_a_poster_names_it_in_its_warning_codes(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(
        pipeline_module,
        "select_clips_v3",
        lambda *a, **k: result(selected(1, 100.0, 130.0), selected(2, 200.0, 230.0)),
    )

    def flaky(clip, *, duration, at=None):
        if clip.name == "clip-02.mp4":
            raise pipeline_module.ThumbnailError("FFmpeg thumbnail failed")
        return clip.with_suffix(".jpg")

    monkeypatch.setattr(pipeline_module, "write_clip_thumbnail", flaky)

    first, second = manifest_of(run(env, max_duration=60.0, limit=2))["clips"]

    assert "warning_codes" not in first
    assert second["warning_codes"] == [{"code": "thumbnail_failed", "params": {"clip": 2}}]


def test_clip_warning_codes_only_take_the_warnings_of_that_clip():
    warnings = ["thumbnail_failed:1", "thumbnail_failed:12", "clip_failed:1", "engine_fallback:1",
                "clip_trimmed_to_media:1", "few_clips:1", "auto_reframe_failed:1"]  # fmt: skip
    assert clip_warning_codes(warnings, 1) == [
        {"code": "thumbnail_failed", "params": {"clip": 1}},
        {"code": "auto_reframe_failed", "params": {"clip": 1}},
    ]
    assert clip_warning_codes(warnings, 3) == []
