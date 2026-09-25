"""Selection V3 pipeline wiring: transcript source, audio, LLM modes, manifest, and progress."""

import json
import os
import re
import shutil
import subprocess
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

import ai_clipper.pipeline as pipeline_module
from ai_clipper.audio_timeline import AudioTimelineError, build_audio_timeline
from ai_clipper.llm import LLMError, LLMUnavailable, ScriptedLLMClient
from ai_clipper.llm_selection import PROMPT_VERSION
from ai_clipper.models import SelectionMode, TranscriptSegment, TranscriptWord
from ai_clipper.selection_types import SelectedClip, SelectionResult
from ai_clipper.selection_v3 import read_selection_artifact
from ai_clipper.sound_events import read_sound_events
from ai_clipper.transcript_io import read_transcript_json
from ai_clipper.trend_context import TREND_CONTEXT_RELATIVE_PATH

# Mirrors of the web sanitizers in web/lib/jobs.mjs (anything else is dropped there).
WEB_PROVIDER = re.compile(r"[a-z0-9][a-z0-9_-]{0,39}")
WEB_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}")
WEB_PROMPT_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
WEB_WARNING = re.compile(r"[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95})?")
WEB_ARCHETYPE = re.compile(r"[a-z][a-z0-9_]{0,39}")
WEB_HASHTAG = re.compile(r"#?[A-Za-z0-9_]{1,40}")
SUMMARY_KEYS = {
    "mode",
    "status",
    "source",
    "provider",
    "model",
    "prompt_version",
    "warnings",
    "artifact",
    "transcript_source",
}
CLIP_KEYS = {
    "index",
    "start",
    "end",
    "duration",
    "score",
    "text",
    "output",
    "subtitles",
    "title",
    "hook_text",
    "description",
    "hashtags",
    "archetype",
    "selection_source",
    "reasons",
    "scores",
    "cold_open",
    "source_start",
    "source_end",
    "thumbnail",
}
SCORES = {"hook": 8.0, "standalone": 7.0, "payoff": 6.0, "emotion": 5.0, "shareability": 4.0}

SENTENCE_SECONDS = 7.3  # not whole seconds: whole-second durations look quantized
GAP_SECONDS = 0.5
SENTENCES = 40
DURATION = SENTENCES * (SENTENCE_SECONDS + GAP_SECONDS)


# --- fixtures ---------------------------------------------------------------------------------


def sentence(index: int) -> str:
    if index % 6 == 3:
        return f"Kenapa kamu pilih jalan{index} itu dulu?"
    return f"Gue cerita soal kisah{index} bareng teman{index} di kota{index} waktu itu."


def rows() -> list[tuple[float, float, str]]:
    result = []
    for index in range(SENTENCES):
        start = index * (SENTENCE_SECONDS + GAP_SECONDS)
        result.append((start, start + SENTENCE_SECONDS, sentence(index)))
    return result


def word_times(start: float, end: float, text: str) -> list[tuple[float, float, str]]:
    tokens = text.split()
    step = (end - start) / len(tokens)
    return [
        (round(start + i * step, 3), round(start + (i + 1) * step, 3), token)
        for i, token in enumerate(tokens)
    ]


def segments() -> list[TranscriptSegment]:
    result = []
    for start, end, text in rows():
        words = tuple(
            TranscriptWord(word_start, word_end, token, 0.9)
            for word_start, word_end, token in word_times(start, end, text)
        )
        result.append(TranscriptSegment(start, end, text, words))
    return result


class FakeWhisper:
    """faster-whisper shaped model: segments with words, plus the options it was called with."""

    def __init__(self, before=None):
        self.calls: list[dict[str, object]] = []
        self.before = before

    def transcribe(self, source: str, **options):
        self.calls.append(options)
        if self.before is not None:
            self.before()
        raw = [
            SimpleNamespace(
                start=start,
                end=end,
                text=f" {text}",
                words=[
                    SimpleNamespace(word=f" {token}", start=ws, end=we, probability=0.9)
                    for ws, we, token in word_times(start, end, text)
                ],
            )
            for start, end, text in rows()
        ]
        return raw, SimpleNamespace(language="id", duration=DURATION)


class ForbiddenWhisper:
    def transcribe(self, source: str, **options):
        raise AssertionError("Whisper must be skipped when the captions are usable")


def json3(*, laugh_after: int | None = None, words: bool = True) -> str:
    """Manual json3 cues, one sentence each; ``laugh_after`` adds a ``[tertawa]`` tag."""
    events = [{"tStartMs": 0, "dDurationMs": round(DURATION * 1000), "id": 1, "wpWinPosId": 1}]
    for index, (start, end, text) in enumerate(rows()):
        body = text if words else "[musik]"
        events.append(
            {"tStartMs": round(start * 1000), "dDurationMs": round((end - start) * 1000),
             "segs": [{"utf8": body}]}
        )  # fmt: skip
        if laugh_after == index:
            events.append(
                {"tStartMs": round(end * 1000) + 100, "dDurationMs": 300,
                 "segs": [{"utf8": "[tertawa]"}]}
            )  # fmt: skip
    return json.dumps({"wireMagic": "pb3", "events": events})


def timeline(duration: float = DURATION):
    """Speech at -20 dB with a quiet dip in every gap between sentences."""
    frames = []
    for frame in range(round(duration / 0.1)):
        time = frame * 0.1
        in_gap = time % (SENTENCE_SECONDS + GAP_SECONDS) >= SENTENCE_SECONDS
        frames.append(-60.0 if in_gap else -20.0 - (frame % 7))
    return build_audio_timeline(frames, duration=duration)


def selected(rank: int, start: float, end: float, **overrides) -> SelectedClip:
    values = {
        "rank": rank,
        "start": start,
        "end": end,
        "cold_open": None,
        "unit_ids": ("S0001", "S0004"),
        "hook_unit_id": "S0002",
        "title": "Judul klip",
        "hook_text": "Hook singkat",
        "description": "Deskripsi klip.",
        "hashtags": ("#podcastindonesia", "#fyp"),
        "archetype": "humor",
        "score": 7.25,
        "scores": dict(SCORES),
        "reasons": ("Alasan kuat.",),
        "source": "llm",
        "text": "Teks klip.",
    }
    values.update(overrides)
    return SelectedClip(**values)


def result(*clips: SelectedClip, **overrides) -> SelectionResult:
    values = {
        "clips": tuple(clips),
        "source": "llm",
        "status": "completed",
        "provider": "ollama-cloud",
        "model": "gpt-oss:120b",
        "prompt_version": "llm-select-v1+std.0123456789ab",
        "warnings": (),
        "usage": {"requests": 1},
    }
    values.update(overrides)
    return SelectionResult(**values)


@pytest.fixture
def env(monkeypatch, tmp_path: Path):
    """No network, no FFmpeg, no Whisper: every external stage is a recording fake."""
    for name in list(os.environ):
        if name.startswith("POTONGIN_LLM") or name.endswith("_API_KEY"):
            monkeypatch.delenv(name, raising=False)
    state = SimpleNamespace(
        tmp=tmp_path,
        source=tmp_path / "input" / "source.mp4",
        job=tmp_path / "job",
        renders=[],
        thumbnails=[],
        audio_calls=[],
        llm_factory_calls=[],
        progress=[],
        media_duration=DURATION,
        llm_client=None,
    )
    state.source.parent.mkdir()
    state.source.write_bytes(b"fake video")
    state.output = state.job / "output"

    def audio(source, **options):
        state.audio_calls.append((source, options))
        return timeline()

    def factory(env=None, *, cache_dir=None):
        state.llm_factory_calls.append(cache_dir)
        return state.llm_client

    monkeypatch.setattr(
        pipeline_module, "_probe_video_duration", lambda source: state.media_duration
    )
    monkeypatch.setattr(pipeline_module, "analyze_audio_timeline", audio)
    monkeypatch.setattr(pipeline_module, "create_llm_client_from_env", factory)
    monkeypatch.setattr(pipeline_module, "llm_request_budget", lambda env=None: (131072, 4096))
    monkeypatch.setattr(
        pipeline_module, "render_vertical", lambda *args, **kwargs: state.renders.append(kwargs)
    )

    def thumbnail(clip, *, duration):
        state.thumbnails.append((clip, duration))
        return clip.with_suffix(".jpg")

    monkeypatch.setattr(pipeline_module, "write_clip_thumbnail", thumbnail)
    return state


def run(env, **options):
    values = {
        "model": FakeWhisper(),
        "artifact_root": env.job,
        "selection_mode": "v3",
        "min_duration": 20.0,
        "max_duration": 40.0,
        "limit": 3,
        "llm_mode": "off",
        "progress": lambda stage, percent, detail: env.progress.append((stage, percent, detail)),
    }
    values.update(options)
    return pipeline_module.run_pipeline(env.source, env.output, **values)


def write_captions(root: Path, kind: str, name: str, content: str) -> Path:
    path = root / kind / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def stages(env) -> list[str]:
    ordered: list[str] = []
    for stage, _percent, _detail in env.progress:
        if not ordered or ordered[-1] != stage:
            ordered.append(stage)
    return ordered


def manifest_of(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_web_summary(summary: dict) -> None:
    assert set(summary) == SUMMARY_KEYS
    assert summary["mode"] == "v3"
    assert summary["status"] in {"completed", "fallback", "failed"}
    if summary["status"] == "failed":
        assert summary["source"] in {None, "llm", "heuristic"}
    else:
        assert summary["source"] in {"llm", "heuristic"}
    if summary["status"] == "fallback":
        assert summary["source"] == "heuristic"
    for key, pattern in (
        ("provider", WEB_PROVIDER),
        ("model", WEB_MODEL),
        ("prompt_version", WEB_PROMPT_VERSION),
    ):
        assert summary[key] is None or pattern.fullmatch(summary[key]), (key, summary[key])
    assert isinstance(summary["warnings"], list) and len(summary["warnings"]) <= 50
    assert len(set(summary["warnings"])) == len(summary["warnings"])
    for warning in summary["warnings"]:
        assert len(warning) <= 160 and WEB_WARNING.fullmatch(warning), warning
    assert summary["artifact"] in {None, "analysis/selection.v3.json"}
    assert summary["transcript_source"] in {None, "youtube-captions", "whisper"}


def assert_web_clip(clip: dict) -> None:
    assert set(clip) == CLIP_KEYS
    assert isinstance(clip["title"], str) and 0 < len(clip["title"]) <= 100
    assert isinstance(clip["hook_text"], str) and 0 < len(clip["hook_text"]) <= 90
    assert clip["description"] is None or len(clip["description"]) <= 600
    assert len(clip["hashtags"]) <= 10
    assert all(WEB_HASHTAG.fullmatch(tag) for tag in clip["hashtags"])
    assert clip["archetype"] is None or WEB_ARCHETYPE.fullmatch(clip["archetype"])
    assert clip["selection_source"] in {"llm", "heuristic"}
    assert len(clip["reasons"]) <= 8 and all(0 < len(reason) <= 300 for reason in clip["reasons"])
    assert set(clip["scores"]) == set(SCORES)
    assert all(0 <= value <= 10 for value in clip["scores"].values())
    assert 0 <= clip["score"] <= 10
    assert clip["source_start"] == clip["start"] and clip["source_end"] == clip["end"]
    assert clip["thumbnail"] is None or clip["thumbnail"] == str(
        Path(clip["output"]).with_suffix(".jpg")
    )
    main = clip["end"] - clip["start"]
    teaser = clip["cold_open"]
    if teaser is None:
        assert clip["duration"] == pytest.approx(main, abs=1e-3)
    else:
        assert set(teaser) == {"start", "end"}
        assert 0 <= teaser["start"] < teaser["end"] and teaser["end"] - teaser["start"] <= 30
        length = teaser["end"] - teaser["start"]
        assert clip["duration"] == pytest.approx(main + length, abs=2e-3)


# --- options ----------------------------------------------------------------------------------


def test_selection_mode_accepts_v3():
    assert SelectionMode("v3") is SelectionMode.V3


@pytest.mark.parametrize(
    ("option", "value", "error"),
    [
        ("llm_mode", "always", ValueError),
        ("llm_mode", None, TypeError),
        ("cold_open", "yes", TypeError),
        ("hook_overlay", 1, TypeError),
        ("word_timestamps", None, TypeError),
        ("caption_style", "neon", ValueError),
        ("caption_style", 3, TypeError),
        ("hook_duration", 0, ValueError),
        ("hook_duration", 30.5, ValueError),
        ("hook_duration", float("nan"), ValueError),
        ("hook_duration", True, TypeError),
        ("captions_dir", 42, TypeError),
        ("min_duration", -1.0, ValueError),
        ("max_duration", 10.0, ValueError),
        ("max_duration", float("inf"), ValueError),
    ],
)
def test_v3_options_are_validated_before_any_work(env, option, value, error):
    model = FakeWhisper()

    with pytest.raises(error):
        run(env, model=model, **{option: value})

    assert model.calls == [] and env.audio_calls == [] and env.renders == []
    manifest = manifest_of(env.output / "manifest.json")
    assert manifest["status"] == "failed"
    assert manifest["selection_v3"]["status"] == "failed"
    assert_web_summary(manifest["selection_v3"])


# --- transcript source ------------------------------------------------------------------------


def test_usable_captions_replace_whisper_and_are_only_read(env):
    captions = env.tmp / "input" / "captions"
    write_captions(captions, "manual", "source.id.json3", json3(laugh_after=5))
    write_captions(captions, "auto", "source.id-orig.json3", json3(words=False))
    before = snapshot(captions)

    manifest_path = run(env, model=ForbiddenWhisper(), captions_dir=captions)

    assert snapshot(captions) == before
    manifest = manifest_of(manifest_path)
    assert manifest["status"] == "completed"
    summary = manifest["selection_v3"]
    assert summary["transcript_source"] == "youtube-captions"
    assert not any(code.startswith("captions_") for code in summary["warnings"])
    transcript = read_transcript_json(env.output / "transcript.json")
    assert transcript.language == "id"
    assert transcript.segments[0].text == sentence(0)
    assert all(segment.words for segment in transcript.segments)
    events, source = read_sound_events(env.job / "analysis" / "sound-events.json")
    assert [event.kind for event in events] == ["laughter"] and source == "youtube-json3"
    assert (env.job / "analysis" / "transcript-quality.json").is_file()
    assert (env.job / "analysis" / "audio-timeline.json").is_file()
    assert stages(env) == [
        "analyzing",
        "captions",
        "audio",
        "selecting",
        "packaging",
        "rendering",
        "finalizing",
    ]


@pytest.mark.parametrize(
    ("files", "media_duration", "expected"),
    [
        ({}, DURATION, ["captions_missing"]),
        ({("auto", "source.en.json3"): json3()}, DURATION, ["captions_missing"]),
        ({("manual", "source.id.json3"): "{not json"}, DURATION, ["captions_rejected:invalid"]),
        (
            {("auto", "source.id-orig.json3"): json3()},
            DURATION * 10,
            ["captions_rejected:low_coverage", "captions_rejected:long_gap"],
        ),
    ],
)
def test_unusable_captions_fall_back_to_whisper_with_word_timestamps(
    env, files, media_duration, expected
):
    captions = env.tmp / "input" / "captions"
    captions.mkdir(parents=True)
    for (kind, name), content in files.items():
        write_captions(captions, kind, name, content)
    env.media_duration = media_duration
    model = FakeWhisper()

    manifest = manifest_of(run(env, model=model, captions_dir=captions))

    assert manifest["status"] == "completed"
    summary = manifest["selection_v3"]
    assert summary["transcript_source"] == "whisper"
    assert [code for code in summary["warnings"] if code.startswith("captions_")] == expected
    assert model.calls[0]["word_timestamps"] is True
    assert stages(env)[:4] == ["analyzing", "captions", "transcribing", "audio"]
    assert not (env.job / "analysis" / "sound-events.json").exists()
    transcript = read_transcript_json(env.output / "transcript.json")
    assert transcript.segments[0].words


def test_manual_captions_win_over_auto_captions(env):
    captions = env.tmp / "input" / "captions"
    write_captions(captions, "auto", "source.id-orig.json3", json3(laugh_after=1))
    write_captions(captions, "manual", "source.id.json3", json3(laugh_after=9))

    run(env, model=ForbiddenWhisper(), captions_dir=captions)

    events, _source = read_sound_events(env.job / "analysis" / "sound-events.json")
    assert [event.time for event in events] == [pytest.approx(rows()[9][1] + 0.1, abs=0.01)]


def test_without_captions_whisper_runs_and_can_skip_word_timestamps(env):
    model = FakeWhisper()

    manifest = manifest_of(run(env, model=model, word_timestamps=False))

    assert model.calls[0]["word_timestamps"] is False
    assert manifest["selection_v3"]["transcript_source"] == "whisper"
    assert "no_word_timestamps" in manifest["selection_v3"]["warnings"]
    transcript_text = (env.output / "transcript.json").read_text(encoding="utf-8")
    assert '"words"' not in transcript_text
    assert stages(env)[:3] == ["analyzing", "transcribing", "audio"]


def test_empty_transcript_fails_clearly(env):
    class Silent:
        def transcribe(self, source, **options):
            return [], SimpleNamespace(language="id", duration=DURATION)

    with pytest.raises(ValueError, match="no usable segments"):
        run(env, model=Silent())

    summary = manifest_of(env.output / "manifest.json")["selection_v3"]
    assert summary["status"] == "failed"
    assert summary["warnings"][0] == "pipeline_failed:transcribing"
    assert_web_summary(summary)


# --- audio ------------------------------------------------------------------------------------


def test_audio_timeline_runs_concurrently_with_whisper(env, monkeypatch):
    started = threading.Event()

    def audio(source, **options):
        env.audio_calls.append((source, options))
        started.set()
        return timeline()

    monkeypatch.setattr(pipeline_module, "analyze_audio_timeline", audio)
    model = FakeWhisper(before=lambda: started.wait(5) or pytest.fail("audio did not start"))

    manifest = manifest_of(run(env, model=model))

    assert manifest["status"] == "completed"
    assert len(env.audio_calls) == 1
    source, options = env.audio_calls[0]
    assert Path(source) == env.source.resolve()
    assert 0 < options["timeout"] <= 900
    assert (env.job / "analysis" / "audio-timeline.json").is_file()


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (AudioTimelineError("audio pass failed"), "audio_unavailable"),
        (RuntimeError("token=secret /private/source.mp4"), "audio_unavailable:error"),
    ],
)
def test_audio_failure_is_tolerated(env, monkeypatch, failure, code):
    seen = {}
    real_select = pipeline_module.select_clips_v3

    def select(segments, **options):
        seen.update(options)
        return real_select(segments, **options)

    monkeypatch.setattr(pipeline_module, "select_clips_v3", select)
    monkeypatch.setattr(
        pipeline_module,
        "analyze_audio_timeline",
        lambda source, **options: (_ for _ in ()).throw(failure),
    )

    manifest_path = run(env)

    manifest = manifest_of(manifest_path)
    assert manifest["status"] == "completed"
    assert code in manifest["selection_v3"]["warnings"]
    assert seen["audio"] is None
    assert not (env.job / "analysis" / "audio-timeline.json").exists()
    assert "secret" not in manifest_path.read_text() and "/private" not in manifest_path.read_text()


def test_audio_wait_is_bounded(env, monkeypatch):
    release = threading.Event()

    def stuck(source, **options):
        release.wait(10)
        return timeline()

    monkeypatch.setattr(pipeline_module, "analyze_audio_timeline", stuck)
    monkeypatch.setattr(pipeline_module, "AUDIO_TIMELINE_TIMEOUT", 0.05)
    monkeypatch.setattr(pipeline_module, "AUDIO_WAIT_GRACE", 0.05)
    try:
        manifest = manifest_of(run(env))
    finally:
        release.set()

    assert manifest["status"] == "completed"
    assert "audio_unavailable:timeout" in manifest["selection_v3"]["warnings"]


# --- LLM modes --------------------------------------------------------------------------------


def test_llm_off_never_builds_a_client(env):
    manifest = manifest_of(run(env, llm_mode="off"))

    assert env.llm_factory_calls == []
    summary = manifest["selection_v3"]
    assert summary["status"] == "completed" and summary["source"] == "heuristic"
    assert summary["provider"] is None and summary["model"] is None
    assert summary["prompt_version"] == "heuristic-v3.1"
    assert "llm" not in stages(env)
    assert all(clip["selection_source"] == "heuristic" for clip in manifest["clips"])


def test_llm_auto_uses_the_configured_client_with_cache_and_budget(env, monkeypatch):
    seen = {}
    real_select = pipeline_module.select_clips_v3

    def select(segments, **options):
        seen.update(options)
        return real_select(segments, **options)

    monkeypatch.setattr(pipeline_module, "select_clips_v3", select)
    moments = [
        {
            "start_id": "L0004",
            "end_id": "L0007",
            "hook_id": "L0005",
            "payoff_id": None,
            "archetype": "humor",
            "hook_quote": "kisah4 bareng teman4 di kota4",
            "title": "Judul dari LLM",
            "hook_text": "Hook dari LLM",
            "description": "Deskripsi singkat.",
            "hashtags": ["#podcastindonesia", "#fyp"],
            "scores": dict(SCORES),
            "reason": "Alasan kuat.",
        }
    ]
    env.llm_client = ScriptedLLMClient(
        [{"moments": moments}], provider="ollama-cloud", model="gpt-oss:120b"
    )

    manifest = manifest_of(run(env, llm_mode="auto"))

    assert env.llm_factory_calls == [env.job.resolve() / "analysis" / "llm-cache"]
    assert seen["llm_client"] is env.llm_client and seen["llm_mode"] == "auto"
    assert seen["context_tokens"] == 131072 and seen["max_output_tokens"] == 4096
    summary = manifest["selection_v3"]
    assert summary["status"] == "completed" and summary["source"] == "llm"
    assert summary["provider"] == "ollama-cloud" and summary["model"] == "gpt-oss:120b"
    assert summary["prompt_version"].startswith(f"{PROMPT_VERSION}.std.")  # "+" becomes "."
    assert_web_summary(summary)
    assert manifest["clips"][0]["selection_source"] == "llm"
    assert manifest["clips"][0]["title"] == "Judul dari LLM"
    assert "llm" in stages(env) and "selecting" not in stages(env)
    artifact = read_selection_artifact(env.job / "analysis" / "selection.v3.json")
    assert artifact.provider == "ollama-cloud"


def test_llm_auto_unavailable_falls_back_to_heuristic(env, monkeypatch):
    def unavailable(env=None, *, cache_dir=None):
        raise LLMUnavailable("missing_api_key", "API key belum diisi.")

    monkeypatch.setattr(pipeline_module, "create_llm_client_from_env", unavailable)

    manifest = manifest_of(run(env, llm_mode="auto"))

    summary = manifest["selection_v3"]
    assert manifest["status"] == "completed"
    assert summary["status"] == "fallback" and summary["source"] == "heuristic"
    assert "llm_unavailable" in summary["warnings"]
    assert "llm_unavailable:missing_api_key" in summary["warnings"]
    assert_web_summary(summary)


def test_llm_auto_not_configured_is_a_plain_heuristic_run(env, monkeypatch):
    manifest = manifest_of(run(env, llm_mode="auto"))

    summary = manifest["selection_v3"]
    assert summary["status"] == "completed" and summary["source"] == "heuristic"
    assert "llm_not_configured" in summary["warnings"]
    monkeypatch.setenv("POTONGIN_LLM", "off")
    summary = manifest_of(run(env, llm_mode="auto"))["selection_v3"]
    assert "llm_disabled" in summary["warnings"]


def test_llm_auto_runtime_error_falls_back(env):
    env.llm_client = ScriptedLLMClient([LLMError("rate_limited", "Kuota habis.")])

    summary = manifest_of(run(env, llm_mode="auto"))["selection_v3"]

    assert summary["status"] == "fallback"
    assert "llm_failed:rate_limited" in summary["warnings"]
    assert_web_summary(summary)


@pytest.mark.parametrize("configured", [False, True])
def test_llm_required_unavailable_fails_the_job(env, monkeypatch, configured):
    if configured:

        def unavailable(env=None, *, cache_dir=None):
            raise LLMUnavailable("config_invalid", "Konfigurasi LLM tidak valid.")

        monkeypatch.setattr(pipeline_module, "create_llm_client_from_env", unavailable)

    with pytest.raises(LLMUnavailable):
        run(env, llm_mode="required")

    manifest = manifest_of(env.output / "manifest.json")
    assert manifest["status"] == "failed"
    assert manifest["error"]
    summary = manifest["selection_v3"]
    assert summary["status"] == "failed"
    assert summary["warnings"][0] == "pipeline_failed:llm"
    assert summary["transcript_source"] == "whisper"
    assert summary["artifact"] is None
    assert_web_summary(summary)
    assert env.renders == []


@pytest.mark.parametrize(
    ("disabled", "code"), [(False, "llm_not_configured"), (True, "llm_disabled")]
)
def test_llm_required_without_configuration_names_the_reason(env, monkeypatch, disabled, code):
    # The web worker only shows "ai-clipper gagal (exit 1)" for a failed run, so the
    # summary warnings are the one place the dashboard can learn why "required" failed.
    if disabled:
        monkeypatch.setenv("POTONGIN_LLM", "off")

    with pytest.raises(LLMUnavailable, match="not_configured"):
        run(env, llm_mode="required")

    summary = manifest_of(env.output / "manifest.json")["selection_v3"]
    assert summary["warnings"][:2] == ["pipeline_failed:llm", code]
    assert_web_summary(summary)


def test_llm_required_runtime_error_fails_with_code(env):
    env.llm_client = ScriptedLLMClient([LLMError("timeout", "Penyedia terlalu lambat.")])

    with pytest.raises(LLMError):
        run(env, llm_mode="required")

    manifest = manifest_of(env.output / "manifest.json")
    assert manifest["error"] == "timeout: Penyedia terlalu lambat."
    assert "llm_failed:timeout" in manifest["selection_v3"]["warnings"]


@pytest.mark.parametrize("llm_mode", ["auto", "required"])
def test_llm_phase_has_a_hard_wall_clock_bound(env, monkeypatch, llm_mode):
    release = threading.Event()
    real_select = pipeline_module.select_clips_v3

    def select(segments, **options):
        if options["llm_client"] is not None:
            release.wait(10)  # a provider that never answers
        return real_select(segments, **options)

    monkeypatch.setattr(pipeline_module, "select_clips_v3", select)
    monkeypatch.setattr(pipeline_module, "LLM_WAIT_SECONDS", 0.05)
    env.llm_client = ScriptedLLMClient([])
    try:
        if llm_mode == "required":
            with pytest.raises(LLMError) as raised:
                run(env, llm_mode=llm_mode)
            assert raised.value.code == "timeout"
            summary = manifest_of(env.output / "manifest.json")["selection_v3"]
            assert summary["status"] == "failed" and "llm_failed:timeout" in summary["warnings"]
        else:
            manifest = manifest_of(run(env, llm_mode=llm_mode))
            summary = manifest["selection_v3"]
            assert summary["status"] == "fallback" and summary["source"] == "heuristic"
            assert "llm_failed:deadline" in summary["warnings"]
            assert manifest["clips"] and env.renders
            artifact = read_selection_artifact(env.job / "analysis" / "selection.v3.json")
            assert artifact.status == "fallback"
    finally:
        release.set()


# --- selection result -> render + manifest ----------------------------------------------------


def test_real_selection_renders_packaged_clips_with_full_manifest(env):
    manifest_path = run(env, llm_mode="off", caption_style=None)

    manifest = manifest_of(manifest_path)
    artifact = read_selection_artifact(env.job / "analysis" / "selection.v3.json")
    assert manifest["status"] == "completed"
    assert manifest["transcript"] == str(env.output.resolve() / "transcript.json")
    assert len(manifest["clips"]) == len(artifact.clips) == len(env.renders) == 3
    for index, (clip, chosen, render) in enumerate(
        zip(manifest["clips"], artifact.clips, env.renders, strict=True), start=1
    ):
        assert_web_clip(clip)
        assert clip["index"] == index
        assert clip["output"] == str(env.output.resolve() / f"clip-{index:02d}.mp4")
        assert clip["subtitles"] == str(env.output.resolve() / f"clip-{index:02d}.srt")
        assert clip["thumbnail"] == str(env.output.resolve() / f"clip-{index:02d}.jpg")
        assert env.thumbnails[index - 1] == (
            Path(clip["output"]),
            pytest.approx(clip["duration"], abs=1e-3),
        )
        assert (clip["start"], clip["end"]) == (chosen.start, chosen.end)
        assert render["start"] == chosen.start and render["end"] == chosen.end
        assert render["cold_open"] == chosen.cold_open
        assert render["hook_text"] == chosen.hook_text
        assert render["caption_style"] == "karaoke"
        assert render["hook_duration"] == 4.0
        assert render["render_mode"] == "center-crop"
        assert render["transcript"][0].words
    assert_web_summary(manifest["selection_v3"])
    assert manifest["selection_v3"]["artifact"] == "analysis/selection.v3.json"


def test_manifest_maps_every_clip_field_and_cold_open_duration(env, monkeypatch):
    clips = (
        selected(
            1,
            100.0,
            130.5,
            cold_open=(118.2, 121.7),
            hashtags=("#podcastindonesia", "#café", "fyp", "#two words"),
            description="",
        ),
        selected(2, 200.0, 225.0, source="heuristic", archetype="practical_tip"),
    )
    monkeypatch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: result(*clips))

    manifest = manifest_of(run(env, llm_mode="off", hook_duration=2.5))

    first, second = manifest["clips"]
    assert_web_clip(first)
    assert_web_clip(second)
    assert first["cold_open"] == {"start": 118.2, "end": 121.7}
    assert first["duration"] == pytest.approx(34.0)
    assert first["hashtags"] == ["#podcastindonesia", "#fyp"]
    assert first["description"] is None
    assert first["scores"] == SCORES and first["score"] == 7.25
    assert second["selection_source"] == "heuristic"
    assert second["archetype"] == "practical_tip"
    assert env.renders[0]["cold_open"] == (118.2, 121.7)
    assert env.renders[0]["hook_duration"] == 2.5
    assert [duration for _clip, duration in env.thumbnails] == [pytest.approx(34.0), 25.0]


def test_cold_open_and_hook_overlay_can_be_disabled(env, monkeypatch):
    seen = {}

    def select(*args, **options):
        seen.update(options)
        return result(selected(1, 100.0, 130.0))

    monkeypatch.setattr(pipeline_module, "select_clips_v3", select)

    manifest = manifest_of(run(env, cold_open=False, hook_overlay=False, caption_style="classic"))

    assert seen["cold_open"] is False
    assert env.renders[0]["cold_open"] is None
    assert env.renders[0]["hook_text"] is None
    assert env.renders[0]["caption_style"] == "classic"
    assert manifest["clips"][0]["cold_open"] is None
    assert manifest["clips"][0]["hook_text"] == "Hook singkat"


def test_summary_normalizes_joined_engines_and_drops_unsafe_warnings(env, monkeypatch):
    unsafe = (
        "llm_dropped:2:not_object",
        "Error: request failed with key sk-123",
        "llm_note:has spaces and key=sk-456",
        "UPPER_code",
        "x" * 170,
    )
    chosen = result(
        selected(1, 100.0, 130.0),
        provider="ollama-cloud+openrouter",
        model="gpt-oss:120b+qwen/qwen3.8-27b:free",
        warnings=unsafe,
    )
    monkeypatch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: chosen)

    manifest_path = run(env)

    summary = manifest_of(manifest_path)["selection_v3"]
    assert_web_summary(summary)
    assert summary["provider"] == "ollama-cloud"
    assert summary["model"] == "gpt-oss:120b"
    assert summary["prompt_version"] == "llm-select-v1.std.0123456789ab"
    assert "llm_providers:2" in summary["warnings"] and "llm_models:2" in summary["warnings"]
    assert "llm_dropped:2:not_object" in summary["warnings"]
    assert "llm_note" in summary["warnings"]
    serialized = json.dumps(summary)
    assert "sk-123" not in serialized and "sk-456" not in serialized and "UPPER" not in serialized
    artifact = read_selection_artifact(env.job / "analysis" / "selection.v3.json")
    assert artifact.provider == "ollama-cloud+openrouter"


def test_summary_warnings_are_capped_at_fifty(env, monkeypatch):
    many = tuple(f"code_{index}" for index in range(80))
    chosen = result(selected(1, 100.0, 130.0), warnings=many)
    monkeypatch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: chosen)

    summary = manifest_of(run(env))["selection_v3"]

    assert len(summary["warnings"]) == 50
    assert_web_summary(summary)


def test_clips_are_kept_inside_the_probed_video(env, monkeypatch):
    env.media_duration = 129.4567
    clips = (
        selected(1, 100.0, 130.0, cold_open=(128.0, 131.0)),
        selected(2, 129.0, 150.0),
        selected(3, 50.0, 80.0),
    )
    monkeypatch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: result(*clips))

    manifest = manifest_of(run(env))

    assert [(clip["start"], clip["end"]) for clip in manifest["clips"]] == [
        (100.0, 129.456),
        (50.0, 80.0),
    ]
    assert manifest["clips"][0]["cold_open"] is None
    warnings = manifest["selection_v3"]["warnings"]
    assert "clip_trimmed_to_media:1" in warnings
    assert "cold_open_beyond_media:1" in warnings
    assert "clip_beyond_media:2" in warnings
    artifact = read_selection_artifact(env.job / "analysis" / "selection.v3.json")
    assert [clip.rank for clip in artifact.clips] == [1, 2]


def test_no_selected_clips_fails_in_indonesian(env, monkeypatch):
    empty = result(source="heuristic", provider=None, model=None, prompt_version="heuristic-v3.1")
    empty = replace(empty, warnings=("few_clips:0",))
    monkeypatch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: empty)

    with pytest.raises(ValueError, match="Tidak ada momen"):
        run(env)

    manifest = manifest_of(env.output / "manifest.json")
    assert manifest["status"] == "failed" and "clips" not in manifest
    assert "Tidak ada momen" in manifest["error"]
    summary = manifest["selection_v3"]
    assert summary["status"] == "failed" and summary["source"] == "heuristic"
    assert summary["warnings"][:2] == ["pipeline_failed:selecting", "few_clips:0"]
    assert summary["artifact"] == "analysis/selection.v3.json"
    assert_web_summary(summary)


def test_render_failure_publishes_failed_summary(env, monkeypatch):
    monkeypatch.setattr(
        pipeline_module, "select_clips_v3", lambda *a, **k: result(selected(1, 100.0, 130.0))
    )

    def broken(*args, **kwargs):
        raise RuntimeError("FFmpeg render failed")

    monkeypatch.setattr(pipeline_module, "render_vertical", broken)

    with pytest.raises(RuntimeError, match="FFmpeg render failed"):
        run(env)

    manifest = manifest_of(env.output / "manifest.json")
    assert manifest["error"] == "FFmpeg render failed"
    summary = manifest["selection_v3"]
    assert summary["status"] == "failed" and summary["source"] == "llm"
    assert summary["warnings"][0] == "pipeline_failed:rendering"
    assert summary["provider"] == "ollama-cloud"
    assert_web_summary(summary)


@pytest.mark.parametrize("mode", ["v3", "v1"])
def test_thumbnail_failure_keeps_the_clip_without_a_poster(env, monkeypatch, mode):
    monkeypatch.setattr(
        pipeline_module,
        "select_clips_v3",
        lambda *a, **k: result(selected(1, 100.0, 130.0), selected(2, 200.0, 230.0)),
    )
    calls = []

    def flaky(clip, *, duration):
        calls.append(clip.name)
        if clip.name == "clip-01.mp4":
            raise pipeline_module.ThumbnailError("FFmpeg thumbnail failed")
        return clip.with_suffix(".jpg")

    monkeypatch.setattr(pipeline_module, "write_clip_thumbnail", flaky)

    manifest = manifest_of(run(env, selection_mode=mode, max_duration=60.0, limit=2))

    assert manifest["status"] == "completed"
    first, second = manifest["clips"]
    assert second["thumbnail"] == str(env.output.resolve() / "clip-02.jpg")
    assert calls == ["clip-01.mp4", "clip-02.mp4"]
    if mode == "v3":
        assert first["thumbnail"] is None  # every V3 field is always present
        assert "thumbnail_failed:1" in manifest["selection_v3"]["warnings"]
        assert_web_summary(manifest["selection_v3"])
    else:
        assert "thumbnail" not in first  # the historical V1 clip shape
        assert "selection_v3" not in manifest


def test_unexpected_thumbnail_errors_still_fail_the_job(env, monkeypatch):
    monkeypatch.setattr(
        pipeline_module, "select_clips_v3", lambda *a, **k: result(selected(1, 100.0, 130.0))
    )

    def broken(clip, *, duration):
        raise TypeError("programming error")

    monkeypatch.setattr(pipeline_module, "write_clip_thumbnail", broken)

    with pytest.raises(TypeError):
        run(env)

    summary = manifest_of(env.output / "manifest.json")["selection_v3"]
    assert summary["warnings"][0] == "pipeline_failed:rendering"


def test_v3_progress_stage_order_with_whisper_and_llm(env, monkeypatch):
    env.llm_client = ScriptedLLMClient([])  # exhausted -> auto fallback, still the LLM stage
    manifest = manifest_of(run(env, llm_mode="auto"))

    assert manifest["selection_v3"]["status"] == "fallback"
    assert stages(env) == [
        "analyzing",
        "transcribing",
        "audio",
        "llm",
        "packaging",
        "rendering",
        "finalizing",
    ]
    percents = [percent for _stage, percent, _detail in env.progress]
    assert percents == sorted(percents) and percents[-1] == 96
    assert all(isinstance(detail, str) and detail for *_rest, detail in env.progress)


def test_v3_writes_quality_artifact_with_transcript(env):
    run(env)

    quality = json.loads((env.job / "analysis" / "transcript-quality.json").read_text())
    assert quality["version"] == "transcript-quality-v1"
    assert quality["has_word_timestamps"] is True


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs FFmpeg"
)
def test_v3_renders_real_clips_with_ffmpeg(tmp_path: Path, monkeypatch):
    for name in list(os.environ):
        if name.startswith("POTONGIN_LLM") or name.endswith("_API_KEY"):
            monkeypatch.delenv(name, raising=False)
    source = tmp_path / "source.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=blue:size=320x180:rate=12:duration={DURATION}",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={DURATION}", "-c:v", "libx264",
         "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source)],
        check=True,
        capture_output=True,
    )  # fmt: skip

    manifest_path = pipeline_module.run_pipeline(
        source,
        tmp_path / "job" / "output",
        model=FakeWhisper(),
        artifact_root=tmp_path / "job",
        selection_mode="v3",
        llm_mode="off",
        min_duration=20.0,
        max_duration=40.0,
        limit=1,
        width=180,
        height=320,
    )

    manifest = manifest_of(manifest_path)
    assert manifest["status"] == "completed"
    assert_web_summary(manifest["selection_v3"])
    (clip,) = manifest["clips"]
    assert_web_clip(clip)
    rendered = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
         clip["output"]],
        check=True,
        capture_output=True,
        text=True,
    ).stdout  # fmt: skip
    assert float(rendered) == pytest.approx(clip["duration"], abs=0.25)
    assert Path(clip["subtitles"]).read_text(encoding="utf-8").startswith("1\n")
    assert (tmp_path / "job" / "analysis" / "audio-timeline.json").is_file()
    thumbnail = Path(clip["thumbnail"])
    assert thumbnail == Path(clip["output"]).with_suffix(".jpg")
    assert thumbnail.read_bytes()[:3] == b"\xff\xd8\xff"
    assert jpeg_size(thumbnail) == (180, 320)  # never upscaled past the rendered width


# --- thumbnails -------------------------------------------------------------------------------

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs FFmpeg"
)


def make_clip(path: Path, *, seconds: float, size: str = "180x320", blue_after: float = 0.8):
    """A red clip that turns blue after ``blue_after`` seconds, with an audio track."""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"color=c=red:size={size}:rate=12:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-vf", f"drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,{blue_after})'",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-shortest", str(path)],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return path


def jpeg_size(path: Path) -> tuple[int, int]:
    probed = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height",
         "-of", "json", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout  # fmt: skip
    (stream,) = json.loads(probed)["streams"]
    assert stream["codec_name"] == "mjpeg"
    return stream["width"], stream["height"]


def dominant_color(path: Path) -> str:
    red, _green, blue = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", "scale=1:1:flags=area,format=rgb24",
         "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout[:3]  # fmt: skip
    return "red" if red > blue else "blue"


def leftovers(directory: Path) -> list[str]:
    return sorted(path.name for path in directory.iterdir() if path.name.startswith("."))


@pytest.mark.parametrize(
    ("duration", "expected"),
    [(20.0, 1.0), (2.0, 1.0), (1.99, 0.3), (1.0, 0.3), (0.4, 0.2), (0.0, 0.0)],
)
def test_thumbnail_time_shows_the_hook_but_stays_inside_short_clips(duration, expected):
    assert pipeline_module.thumbnail_time(duration) == pytest.approx(expected)


@pytest.mark.parametrize("duration", [float("nan"), float("inf"), -1.0, True, "2"])
def test_thumbnail_rejects_invalid_durations(tmp_path: Path, duration):
    with pytest.raises((TypeError, ValueError)):
        pipeline_module.write_clip_thumbnail(tmp_path / "clip-01.mp4", duration=duration)


@needs_ffmpeg
def test_thumbnail_is_a_720_wide_jpeg_taken_after_the_first_second(tmp_path: Path):
    clip = make_clip(tmp_path / "output" / "clip-01.mp4", seconds=3.0, size="1080x1920")

    thumbnail = pipeline_module.write_clip_thumbnail(clip, duration=3.0)

    assert thumbnail == clip.with_suffix(".jpg")
    data = thumbnail.read_bytes()
    assert data[:3] == b"\xff\xd8\xff" and data[-2:] == b"\xff\xd9"
    assert jpeg_size(thumbnail) == (720, 1280)
    assert dominant_color(thumbnail) == "blue"  # 1.0 s, past the red first 0.8 s
    assert thumbnail.stat().st_mode & 0o777 == 0o600
    assert leftovers(clip.parent) == []


@needs_ffmpeg
def test_short_clip_thumbnail_is_taken_early(tmp_path: Path):
    clip = make_clip(tmp_path / "clip-01.mp4", seconds=1.5)

    thumbnail = pipeline_module.write_clip_thumbnail(clip, duration=1.5)

    assert dominant_color(thumbnail) == "red"  # 0.3 s
    assert jpeg_size(thumbnail) == (180, 320)


@needs_ffmpeg
def test_thumbnail_never_clobbers_an_existing_file_or_symlink(tmp_path: Path):
    clip = make_clip(tmp_path / "clip-01.mp4", seconds=2.0)
    existing = clip.with_suffix(".jpg")
    existing.write_bytes(b"keep me")

    with pytest.raises(pipeline_module.ThumbnailError, match="already exists"):
        pipeline_module.write_clip_thumbnail(clip, duration=2.0)

    assert existing.read_bytes() == b"keep me"
    existing.unlink()
    victim = tmp_path / "victim.txt"
    victim.write_text("secret")
    existing.symlink_to(victim)

    with pytest.raises(pipeline_module.ThumbnailError):
        pipeline_module.write_clip_thumbnail(clip, duration=2.0)

    assert victim.read_text() == "secret" and existing.is_symlink()
    assert leftovers(tmp_path) == []


@needs_ffmpeg
def test_thumbnail_refuses_a_symlinked_clip_or_directory(tmp_path: Path):
    real = make_clip(tmp_path / "real" / "clip-01.mp4", seconds=2.0)
    linked_clip = tmp_path / "out" / "clip-01.mp4"
    linked_clip.parent.mkdir()
    linked_clip.symlink_to(real)
    (tmp_path / "linked-dir").symlink_to(real.parent)

    for clip in (linked_clip, tmp_path / "linked-dir" / "clip-01.mp4"):
        with pytest.raises(pipeline_module.ThumbnailError):
            pipeline_module.write_clip_thumbnail(clip, duration=2.0)

    assert not (tmp_path / "out" / "clip-01.jpg").exists()
    assert not (real.parent / "clip-01.jpg").exists()


@needs_ffmpeg
def test_thumbnail_errors_are_sanitized_and_leave_nothing_behind(tmp_path: Path):
    secret_dir = tmp_path / "rahasia-klien"
    secret_dir.mkdir()
    clip = secret_dir / "clip-01.mp4"
    clip.write_bytes(b"not a video at all")

    with pytest.raises(pipeline_module.ThumbnailError) as caught:
        pipeline_module.write_clip_thumbnail(clip, duration=20.0)

    assert "rahasia" not in str(caught.value) and str(caught.value) == "FFmpeg thumbnail failed"
    assert not clip.with_suffix(".jpg").exists()
    assert leftovers(secret_dir) == []
    with pytest.raises(pipeline_module.ThumbnailError, match="clip is missing"):
        pipeline_module.write_clip_thumbnail(secret_dir / "clip-02.mp4", duration=20.0)


def test_thumbnail_timeout_is_reported_without_leftovers(tmp_path: Path, monkeypatch):
    clip = tmp_path / "clip-01.mp4"
    clip.write_bytes(b"video")

    def slow(command, **options):
        raise subprocess.TimeoutExpired(command, options["timeout"])

    monkeypatch.setattr(pipeline_module.subprocess, "run", slow)

    with pytest.raises(pipeline_module.ThumbnailError, match="timed out"):
        pipeline_module.write_clip_thumbnail(clip, duration=20.0)

    assert leftovers(tmp_path) == [] and not clip.with_suffix(".jpg").exists()


def test_thumbnail_rejects_output_that_is_not_a_jpeg(tmp_path: Path, monkeypatch):
    clip = tmp_path / "clip-01.mp4"
    clip.write_bytes(b"video")
    commands = []

    def fake(command, **options):
        commands.append(command)
        fd = int(command[-1].rsplit("/", 1)[1])
        os.write(fd, b"GIF89a not a jpeg")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(pipeline_module.subprocess, "run", fake)

    with pytest.raises(pipeline_module.ThumbnailError, match="not a JPEG"):
        pipeline_module.write_clip_thumbnail(clip, duration=20.0)

    assert leftovers(tmp_path) == [] and not clip.with_suffix(".jpg").exists()
    (command,) = commands
    assert command[command.index("-ss") + 1] == "1.000"
    assert command[command.index("-q:v") + 1] == "4"
    assert command[command.index("-frames:v") + 1] == "1"
    assert all(str(tmp_path) not in part for part in command)  # fds only, never paths


# --- V1 stays V1 ------------------------------------------------------------------------------


def test_v1_never_touches_v3_stages_and_writes_strict_transcript(env, monkeypatch):
    monkeypatch.setattr(
        pipeline_module,
        "select_clips_v3",
        lambda *a, **k: pytest.fail("V3 selection called in v1 mode"),
    )
    monkeypatch.setattr(
        pipeline_module,
        "analyze_audio_timeline",
        lambda *a, **k: pytest.fail("audio timeline called in v1 mode"),
    )
    captions = env.tmp / "input" / "captions"
    write_captions(captions, "manual", "source.id.json3", json3())

    manifest = manifest_of(
        run(env, selection_mode="v1", llm_mode="auto", captions_dir=captions, max_duration=60.0)
    )

    assert manifest["status"] == "completed"
    assert "selection_v3" not in manifest
    assert set(manifest["clips"][0]) == {
        "index",
        "start",
        "end",
        "duration",
        "score",
        "text",
        "output",
        "subtitles",
        "thumbnail",
    }
    assert manifest["clips"][0]["thumbnail"] == str(env.output.resolve() / "clip-01.jpg")
    assert env.thumbnails[0] == (
        Path(manifest["clips"][0]["output"]),
        pytest.approx(manifest["clips"][0]["duration"], abs=1e-3),
    )
    assert env.llm_factory_calls == []
    assert env.renders[0]["caption_style"] == "classic"
    assert "cold_open" not in env.renders[0] and "hook_text" not in env.renders[0]
    assert not (env.job / "analysis").exists()
    transcript = read_transcript_json(env.output / "transcript.json")
    assert transcript.segments[0].words
    assert '"words": []' not in (env.output / "transcript.json").read_text()


# --- Konteks Tren -----------------------------------------------------------------------------


def trend_item(unit: int, name: str, **overrides) -> dict:
    """A snapshot item mentioned only by sentence ``unit`` ("kisah<unit> bareng")."""
    item = {
        "id": f"trend-{name.lower()}",
        "kind": "topic",
        "title": f"Tren {name}",
        "keywords": [f"kisah{unit} bareng"],
        "hashtags": [f"#Tren{name}"],
        "score": 60,
        "firstSeenAt": "2026-09-24T08:00:00Z",
        "expiresAt": "2026-10-05T00:00:00Z",
    }
    item.update(overrides)
    return item


def trend_snapshot(env, *items, **overrides) -> Path:
    path = env.job / TREND_CONTEXT_RELATIVE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "generatedAt": "2026-09-25T06:00:00Z", "items": list(items)}
    payload.update(overrides)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def statement_inside(clip: dict) -> int:
    """A statement sentence (not a question) inside a manifest clip's source span."""
    for index, (start, end, _text) in enumerate(rows()):
        if clip["start"] <= start and end <= clip["end"] and index % 6 != 3:
            return index
    raise AssertionError("no statement inside the clip")


def selection_bytes(env) -> bytes:
    return (env.job / "analysis" / "selection.v3.json").read_bytes()


def test_a_trend_context_grounds_clips_and_the_manifest_records_it(env, monkeypatch):
    baseline = manifest_of(run(env))
    unit = statement_inside(baseline["clips"][0])
    path = trend_snapshot(env, trend_item(unit, "A"), trend_item(999, "Absen"))
    seen = {}
    real_select = pipeline_module.select_clips_v3

    def select(segments, **options):
        seen.update(options)
        return real_select(segments, **options)

    monkeypatch.setattr(pipeline_module, "select_clips_v3", select)

    manifest = manifest_of(run(env, trend_context=path))

    assert [item.id for item in seen["trends"]] == ["trend-a", "trend-absen"]
    trended = [clip for clip in manifest["clips"] if "trends" in clip]
    assert len(trended) == 1
    clip = trended[0]
    assert clip["trends"] == [{"id": "trend-a", "title": "Tren A", "kind": "topic"}]
    assert set(clip) == CLIP_KEYS | {"trends"}
    assert clip["hashtags"][0] == "#TrenA"
    assert clip["reasons"][-1] == "tren: Tren A"
    for other in manifest["clips"]:
        if other is not clip:
            assert_web_clip(other)
    assert_web_summary(manifest["selection_v3"])
    assert not any(code.startswith("trend") for code in manifest["selection_v3"]["warnings"])
    artifact = read_selection_artifact(env.job / "analysis" / "selection.v3.json")
    assert [len(item.trends) for item in artifact.clips].count(1) == 1
    assert "Tren A" not in repr(env.renders)  # trend text never reaches the renderer


def test_without_relevant_trends_the_outputs_are_unchanged(env):
    baseline = manifest_of(run(env))
    baseline_selection = selection_bytes(env)
    path = trend_snapshot(env, trend_item(999, "Absen"))

    manifest = manifest_of(run(env, trend_context=path))

    assert manifest == baseline
    assert selection_bytes(env) == baseline_selection


@pytest.mark.parametrize(
    "payload",
    [
        {"version": 2},
        {"items": "semua"},
        {"generatedAt": "kemarin"},
    ],
)
def test_an_invalid_trend_context_is_a_warning_and_the_job_continues(env, payload):
    baseline = manifest_of(run(env))
    path = trend_snapshot(env, trend_item(1, "A"), **payload)

    manifest = manifest_of(run(env, trend_context=path))

    assert manifest["status"] == "completed"
    assert manifest["clips"] == baseline["clips"]
    warnings = manifest["selection_v3"]["warnings"]
    assert "trend_context_invalid" in warnings
    assert [code for code in warnings if code != "trend_context_invalid"] == (
        baseline["selection_v3"]["warnings"]
    )
    assert_web_summary(manifest["selection_v3"])


def test_a_missing_or_broken_trend_file_is_a_warning(env):
    missing = manifest_of(run(env, trend_context=env.tmp / "tidak-ada.json"))
    assert "trend_context_invalid" in missing["selection_v3"]["warnings"]
    broken = env.job / "analysis" / "trend-context.json"
    broken.write_text("{bukan json", encoding="utf-8")
    manifest = manifest_of(run(env, trend_context=broken))
    assert manifest["status"] == "completed"
    assert "trend_context_invalid" in manifest["selection_v3"]["warnings"]


def test_skipped_trend_items_are_counted(env):
    path = trend_snapshot(env, trend_item(1, "A"), trend_item(2, "B", kind="gosip"), "teks")
    manifest = manifest_of(run(env, trend_context=path))
    assert "trend_items_skipped:2" in manifest["selection_v3"]["warnings"]
    assert_web_summary(manifest["selection_v3"])


def test_trend_context_must_be_a_path(env):
    with pytest.raises(TypeError):
        run(env, trend_context=5)


def test_v1_ignores_the_trend_context(env, monkeypatch):
    monkeypatch.setattr(
        pipeline_module,
        "load_trend_context",
        lambda *a, **k: pytest.fail("trend context read in v1 mode"),
    )
    manifest = manifest_of(
        run(env, selection_mode="v1", trend_context=env.tmp / "x.json", max_duration=60.0)
    )
    assert manifest["status"] == "completed"
