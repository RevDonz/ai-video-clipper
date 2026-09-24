import math
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import ClassVar

import pytest

from ai_clipper.models import TranscriptWord
from ai_clipper.transcribe import (
    DEFAULT_CONDITION_ON_PREVIOUS_TEXT,
    DEFAULT_INITIAL_PROMPT,
    ENV_CONDITION_ON_PREVIOUS_TEXT,
    ENV_INITIAL_PROMPT,
    ENV_PROMPT_EVERY_WINDOW,
    MAX_INITIAL_PROMPT_CHARS,
    WhisperDecoding,
    WhisperEngine,
    load_whisper_model,
    transcribe_video,
    whisper_decoding_from_env,
)


class FakeWhisperModel:
    def transcribe(self, source: str, **options):
        assert Path(source).name == "podcast.mp4"
        assert options["language"] == "id"
        return (
            [
                SimpleNamespace(start=0.0, end=2.0, text=" Halo semuanya. "),
                SimpleNamespace(start=2.0, end=5.5, text=" Ini bagian penting. "),
            ],
            SimpleNamespace(language="id"),
        )


class RecordingModel:
    def __init__(self, segments, *, duration: float = 0.0):
        self.segments = segments
        self.duration = duration
        self.options: dict[str, object] = {}

    def transcribe(self, source: str, **options):
        self.options = options
        return iter(self.segments), SimpleNamespace(language="id", duration=self.duration)


def _word(start, end, word, probability=0.9):
    return SimpleNamespace(start=start, end=end, word=word, probability=probability)


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "podcast.mp4"
    path.touch()
    return path


def test_normalizes_whisper_segments_and_language(source: Path):
    result = transcribe_video(source, model=FakeWhisperModel(), language="id")

    assert result.language == "id"
    assert [segment.text for segment in result.segments] == [
        "Halo semuanya.",
        "Ini bagian penting.",
    ]
    assert result.segments[-1].end == 5.5
    assert all(segment.words == () for segment in result.segments)


def test_requests_word_timestamps_by_default_and_leaves_decoding_to_the_model(source: Path):
    model = RecordingModel([SimpleNamespace(start=0.0, end=1.0, text="Halo")])

    transcribe_video(source, model=model)

    # initial_prompt / condition_on_previous_text come from the engine (load_whisper_model).
    assert model.options == {
        "language": "id",
        "vad_filter": True,
        "beam_size": 5,
        "word_timestamps": True,
    }


def test_passes_explicit_decoding_options_and_can_disable_word_timestamps(source: Path):
    model = RecordingModel(
        [SimpleNamespace(start=0.0, end=1.0, text="Halo", words=[_word(0.0, 0.5, " Halo")])]
    )

    result = transcribe_video(
        source,
        model=model,
        word_timestamps=False,
        initial_prompt="Podcast santai, pakai tanda baca.",
        condition_on_previous_text=True,
    )

    assert model.options["word_timestamps"] is False
    assert model.options["initial_prompt"] == "Podcast santai, pakai tanda baca."
    assert model.options["condition_on_previous_text"] is True
    assert result.segments[0].words == ()


def test_rejects_invalid_explicit_decoding_options(source: Path):
    with pytest.raises(TypeError, match="initial_prompt"):
        transcribe_video(source, model=RecordingModel([]), initial_prompt=3)
    with pytest.raises(TypeError, match="condition_on_previous_text"):
        transcribe_video(source, model=RecordingModel([]), condition_on_previous_text="false")


def test_engine_defaults_reach_whisper_and_explicit_options_win(source: Path):
    inner = RecordingModel([SimpleNamespace(start=0.0, end=1.0, text="Halo.")])
    engine = WhisperEngine(inner, WhisperDecoding())

    transcribe_video(source, model=engine)

    assert inner.options["hotwords"] == DEFAULT_INITIAL_PROMPT
    assert inner.options["initial_prompt"] is None
    assert inner.options["condition_on_previous_text"] is DEFAULT_CONDITION_ON_PREVIOUS_TEXT
    assert inner.options["beam_size"] == 5

    transcribe_video(
        source, model=engine, initial_prompt="Lain, ya?", condition_on_previous_text=True
    )

    # An explicit prompt replaces the configured one instead of stacking on it.
    assert inner.options["initial_prompt"] == "Lain, ya?"
    assert "hotwords" not in inner.options
    assert inner.options["condition_on_previous_text"] is True


# --- Decoding defaults and configuration -----------------------------------------------------


def test_default_decoding_is_the_measured_recommendation():
    decoding = WhisperDecoding()

    # docs/operations/TRANSCRIPTION.md: condition_on_previous_text=False and the punctuated
    # prompt in front of every 30 s window (faster-whisper's ``hotwords`` slot).
    assert DEFAULT_CONDITION_ON_PREVIOUS_TEXT is False
    assert decoding.condition_on_previous_text is False
    assert decoding.initial_prompt == DEFAULT_INITIAL_PROMPT
    assert decoding.prompt_every_window is True
    assert decoding.options() == {
        "initial_prompt": None,
        "hotwords": DEFAULT_INITIAL_PROMPT,
        "condition_on_previous_text": False,
    }
    # The prompt shows Whisper the punctuation we want back, in casual Indonesian.
    assert {",", "?", "."} <= set(DEFAULT_INITIAL_PROMPT)
    assert DEFAULT_INITIAL_PROMPT == " ".join(DEFAULT_INITIAL_PROMPT.split())
    assert len(DEFAULT_INITIAL_PROMPT) <= MAX_INITIAL_PROMPT_CHARS


def test_decoding_accepts_no_prompt_and_rejects_invalid_values():
    assert WhisperDecoding(None, True).options() == {
        "initial_prompt": None,
        "hotwords": None,
        "condition_on_previous_text": True,
    }
    assert WhisperDecoding("Halo, ya?", True, prompt_every_window=False).options() == {
        "initial_prompt": "Halo, ya?",
        "hotwords": None,
        "condition_on_previous_text": True,
    }
    with pytest.raises(TypeError, match="initial_prompt"):
        WhisperDecoding(initial_prompt=3)
    with pytest.raises(TypeError, match="condition_on_previous_text"):
        WhisperDecoding(condition_on_previous_text=0)
    with pytest.raises(TypeError, match="prompt_every_window"):
        WhisperDecoding(prompt_every_window="yes")
    for prompt in (
        "",
        "   ",
        "Halo\n apa kabar?",
        "Halo\x00",
        "x" * (MAX_INITIAL_PROMPT_CHARS + 1),
    ):
        with pytest.raises(ValueError, match="initial_prompt"):
            WhisperDecoding(initial_prompt=prompt)


def test_decoding_from_env_uses_defaults_when_unset_or_blank():
    assert whisper_decoding_from_env({}) == WhisperDecoding()
    blank = {
        ENV_INITIAL_PROMPT: "  ",
        ENV_CONDITION_ON_PREVIOUS_TEXT: "",
        ENV_PROMPT_EVERY_WINDOW: "",
    }
    assert whisper_decoding_from_env(blank) == WhisperDecoding()


def test_decoding_from_env_reads_os_environ_by_default(monkeypatch):
    monkeypatch.setenv(ENV_CONDITION_ON_PREVIOUS_TEXT, "true")
    monkeypatch.setenv(ENV_INITIAL_PROMPT, "off")
    monkeypatch.setenv(ENV_PROMPT_EVERY_WINDOW, "0")

    assert whisper_decoding_from_env() == WhisperDecoding(None, True, prompt_every_window=False)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1", True), ("true", True), (" TRUE ", True), ("yes", True), ("on", True),
        ("0", False), ("false", False), ("No", False), ("off", False),
    ],
)  # fmt: skip
def test_decoding_from_env_parses_booleans(raw: str, expected: bool):
    decoding = whisper_decoding_from_env({ENV_CONDITION_ON_PREVIOUS_TEXT: raw})
    assert decoding.condition_on_previous_text is expected
    assert decoding.initial_prompt == DEFAULT_INITIAL_PROMPT
    decoding = whisper_decoding_from_env({ENV_PROMPT_EVERY_WINDOW: raw})
    assert decoding.prompt_every_window is expected
    assert decoding.condition_on_previous_text is DEFAULT_CONDITION_ON_PREVIOUS_TEXT


@pytest.mark.parametrize("raw", ["off", "OFF", " none ", "None"])
def test_env_prompt_can_be_switched_off(raw: str):
    assert whisper_decoding_from_env({ENV_INITIAL_PROMPT: raw}).initial_prompt is None


def test_env_prompt_is_whitespace_normalized():
    env = {ENV_INITIAL_PROMPT: "  Halo,\n\tapa kabar?  Baik.  "}
    assert whisper_decoding_from_env(env).initial_prompt == "Halo, apa kabar? Baik."


def test_invalid_env_values_raise_without_echoing_them():
    for variable in (ENV_CONDITION_ON_PREVIOUS_TEXT, ENV_PROMPT_EVERY_WINDOW):
        with pytest.raises(ValueError, match=variable) as condition:
            whisper_decoding_from_env({variable: "kadang-kadang"})
        assert "kadang" not in str(condition.value)

    for prompt in ("rahasia " * 100, "rahasia\x07"):
        with pytest.raises(ValueError, match=ENV_INITIAL_PROMPT) as error:
            whisper_decoding_from_env({ENV_INITIAL_PROMPT: prompt})
        assert "rahasia" not in str(error.value)


def test_explicit_values_override_the_environment():
    env = {
        ENV_INITIAL_PROMPT: "Dari env, ya?",
        ENV_CONDITION_ON_PREVIOUS_TEXT: "1",
        ENV_PROMPT_EVERY_WINDOW: "off",
    }

    assert whisper_decoding_from_env(env) == WhisperDecoding("Dari env, ya?", True, False)
    assert whisper_decoding_from_env(
        env, initial_prompt="off", condition_on_previous_text=False, prompt_every_window=True
    ) == WhisperDecoding(None, False, True)
    assert whisper_decoding_from_env(env, initial_prompt=" Dari CLI,\nya? ") == WhisperDecoding(
        "Dari CLI, ya?", True, False
    )
    with pytest.raises(TypeError, match="condition_on_previous_text"):
        whisper_decoding_from_env({}, condition_on_previous_text="yes")
    with pytest.raises(TypeError, match="prompt_every_window"):
        whisper_decoding_from_env({}, prompt_every_window=1)
    with pytest.raises(ValueError, match="--initial-prompt") as error:
        whisper_decoding_from_env({}, initial_prompt="rahasia " * 100)
    assert "rahasia" not in str(error.value)


def test_engine_merges_defaults_and_call_options_win():
    inner = RecordingModel([])
    engine = WhisperEngine(inner, WhisperDecoding("Halo, apa kabar?", False))

    engine.transcribe("a.wav", language="id")
    assert inner.options == {
        "initial_prompt": None,
        "hotwords": "Halo, apa kabar?",
        "condition_on_previous_text": False,
        "language": "id",
    }

    engine.transcribe("a.wav", condition_on_previous_text=True, initial_prompt=None)
    assert inner.options == {"initial_prompt": None, "condition_on_previous_text": True}

    engine.transcribe("a.wav", hotwords="Lain, ya?")
    assert inner.options == {"hotwords": "Lain, ya?", "condition_on_previous_text": False}

    with pytest.raises(TypeError, match="decoding"):
        WhisperEngine(inner, {"initial_prompt": None})


class FakeFasterWhisper:
    created: ClassVar[list[tuple[tuple, dict]]] = []

    def __init__(self, *args, **kwargs):
        FakeFasterWhisper.created.append((args, kwargs))


@pytest.fixture
def fake_faster_whisper(monkeypatch):
    module = ModuleType("faster_whisper")
    module.WhisperModel = FakeFasterWhisper
    FakeFasterWhisper.created = []
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    return FakeFasterWhisper


def test_load_whisper_model_returns_an_engine_with_decoding(fake_faster_whisper):
    engine = load_whisper_model("small")

    assert isinstance(engine, WhisperEngine)
    assert isinstance(engine.model, FakeFasterWhisper)
    assert engine.decoding == WhisperDecoding()
    assert fake_faster_whisper.created == [(("small",), {"device": "cpu", "compute_type": "int8"})]

    custom = WhisperDecoding(None, True)
    engine = load_whisper_model("large-v3-turbo", device="cuda", decoding=custom)

    assert engine.decoding is custom
    assert fake_faster_whisper.created[-1] == (
        ("large-v3-turbo",),
        {"device": "cuda", "compute_type": "float16"},
    )
    with pytest.raises(TypeError, match="decoding"):
        load_whisper_model("small", decoding={"condition_on_previous_text": False})


def test_load_whisper_model_reports_missing_dependency(monkeypatch):
    monkeypatch.setitem(sys.modules, "faster_whisper", None)

    with pytest.raises(RuntimeError, match="uv sync --extra transcribe"):
        load_whisper_model("small")


def test_normalizes_word_timestamps(source: Path):
    words = [
        _word(-0.2, 0.3, " Gue", 0.93),
        _word(0.3, 0.2, " bukan", 1.2),
        _word(0.5, 0.5, "   ", 0.5),
        _word(0.6, 0.9, " jambret.", -0.3),
        _word(math.nan, 1.0, " hilang", 0.5),
        _word(0.95, 1.4, " lagi", math.nan),
        _word(1.45, 1.6, " ya", None),
    ]
    model = RecordingModel(
        [SimpleNamespace(start=0.0, end=1.5, text=" Gue  bukan\njambret. lagi ya", words=words)]
    )

    segment = transcribe_video(source, model=model).segments[0]

    assert segment.text == "Gue bukan jambret. lagi ya"
    assert segment.words == (
        TranscriptWord(0.0, 0.3, "Gue", 0.93),
        TranscriptWord(0.3, 0.3, "bukan", 1.0),
        TranscriptWord(0.6, 0.9, "jambret.", 0.0),
        TranscriptWord(0.95, 1.4, "lagi", None),
        TranscriptWord(1.45, 1.5, "ya", None),
    )


def test_words_are_forced_chronological_inside_their_segment(source: Path):
    words = [_word(1.0, 1.4, " satu"), _word(0.8, 1.2, " dua"), _word(1.3, 2.4, " tiga")]
    model = RecordingModel([SimpleNamespace(start=1.0, end=2.0, text="satu dua tiga", words=words)])

    segment = transcribe_video(source, model=model).segments[0]

    assert [(word.start, word.end) for word in segment.words] == [
        (1.0, 1.4),
        (1.0, 1.2),
        (1.3, 2.0),
    ]


def test_overlapping_segments_are_clamped_and_degenerate_ones_dropped(source: Path):
    model = RecordingModel(
        [
            SimpleNamespace(start=0.0, end=2.0, text="Satu.", words=[_word(0.1, 1.9, " Satu.")]),
            SimpleNamespace(start=1.8, end=3.0, text="Dua.", words=[_word(1.8, 2.9, " Dua.")]),
            SimpleNamespace(start=2.5, end=2.9, text="Hantu."),
            SimpleNamespace(start=3.0, end=3.0, text="Kosong."),
            SimpleNamespace(start=3.2, end=4.0, text="   "),
            SimpleNamespace(start=math.inf, end=5.0, text="Rusak."),
            SimpleNamespace(start=4.0, end=5.0, text="Tiga."),
        ]
    )

    segments = transcribe_video(source, model=model).segments

    assert [(segment.start, segment.end, segment.text) for segment in segments] == [
        (0.0, 2.0, "Satu."),
        (2.0, 3.0, "Dua."),
        (4.0, 5.0, "Tiga."),
    ]
    assert segments[1].words == (TranscriptWord(2.0, 2.9, "Dua.", 0.9),)


def test_reports_progress_against_media_duration(source: Path):
    progress: list[float] = []
    model = RecordingModel(
        [
            SimpleNamespace(start=0.0, end=5.0, text="Satu."),
            SimpleNamespace(start=5.0, end=12.0, text="Dua."),
        ],
        duration=10.0,
    )

    transcribe_video(source, model=model, progress_callback=progress.append)

    assert progress == [0.5, 1.0]


def test_missing_source_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        transcribe_video(tmp_path / "missing.mp4", model=RecordingModel([]))
