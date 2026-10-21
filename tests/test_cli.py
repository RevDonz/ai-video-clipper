import json
from pathlib import Path

import pytest

from ai_clipper import cli
from ai_clipper.cli import parse_args
from ai_clipper.focus import FocusSpec
from ai_clipper.time_ranges import TimeRange
from ai_clipper.transcribe import (
    ENV_CONDITION_ON_PREVIOUS_TEXT,
    ENV_INITIAL_PROMPT,
    ENV_PROMPT_EVERY_WINDOW,
    WhisperDecoding,
)
from ai_clipper.transcribe_groq import ENV_API_KEY, ENV_SWITCH, GroqTranscription


@pytest.fixture(autouse=True)
def _no_whisper_env(monkeypatch):
    """The developer's shell must not leak Whisper decoding settings into these tests."""
    monkeypatch.delenv(ENV_INITIAL_PROMPT, raising=False)
    monkeypatch.delenv(ENV_CONDITION_ON_PREVIOUS_TEXT, raising=False)
    monkeypatch.delenv(ENV_PROMPT_EVERY_WINDOW, raising=False)
    monkeypatch.delenv(ENV_SWITCH, raising=False)
    monkeypatch.delenv(ENV_API_KEY, raising=False)


def test_cli_parses_source_and_processing_options():
    args = parse_args(
        [
            "video.mp4",
            "--output-dir",
            "hasil",
            "--model",
            "tiny",
            "--language",
            "id",
            "--min-duration",
            "15",
            "--max-duration",
            "45",
            "--limit",
            "3",
            "--render-mode",
            "fit-blur",
        ]
    )

    assert args.source == Path("video.mp4")
    assert args.output_dir == Path("hasil")
    assert args.model == "tiny"
    assert args.language == "id"
    assert args.min_duration == 15
    assert args.max_duration == 45
    assert args.limit == 3
    assert args.render_mode == "fit-blur"


def test_cli_defaults_to_face_tracking():
    args = parse_args(["video.mp4"])
    assert args.render_mode == "face-track"
    assert args.clip_profile == "standard"
    assert args.max_candidates == 200
    assert args.max_media_candidates == 12
    assert args.media_timeout == 30.0


def test_cli_defaults_to_the_current_selection_and_keeps_the_flag():
    assert parse_args(["video.mp4"]).selection_mode == "v3"
    assert parse_args(["video.mp4", "--selection-mode", "v1"]).selection_mode == "v1"
    assert parse_args(["video.mp4", "--selection-mode", "v2-shadow"]).selection_mode == "v2-shadow"
    # Focus terms work without naming the mode: the default is the current selection.
    assert parse_args(["video.mp4", "--focus-term", "jomok"]).focus is not None


@pytest.mark.parametrize(
    "arguments",
    [
        ["--selection-mode", "v2"],
        ["--clip-profile", "long"],
        ["--max-candidates", "0"],
        ["--max-candidates", "5001"],
        ["--max-media-candidates", "0"],
        ["--max-media-candidates", "101"],
        ["--media-timeout", "nan"],
        ["--media-timeout", "301"],
    ],
)
def test_cli_rejects_invalid_v2_options(arguments: list[str]):
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", *arguments])


def test_cli_parses_v2_shadow_options():
    args = parse_args(
        [
            "video.mp4",
            "--selection-mode",
            "v2-shadow",
            "--clip-profile",
            "viral-short",
            "--max-candidates",
            "40",
            "--max-media-candidates",
            "6",
            "--media-timeout",
            "12.5",
        ]
    )

    assert args.selection_mode == "v2-shadow"
    assert args.clip_profile == "viral-short"
    assert args.max_candidates == 40
    assert args.max_media_candidates == 6
    assert args.media_timeout == 12.5


def test_cli_forwards_v2_options_to_pipeline(monkeypatch, tmp_path: Path):
    received = {}
    monkeypatch.setattr(cli, "load_whisper_model", lambda *args, **kwargs: object())

    def pipeline(*args, **kwargs):
        received.update(kwargs)
        manifest = tmp_path / "manifest.json"
        manifest.touch()
        return manifest

    monkeypatch.setattr(cli, "run_pipeline", pipeline)
    assert (
        cli.main(
            [
                "video.mp4",
                "--selection-mode",
                "v2-shadow",
                "--clip-profile",
                "deep-dive",
                "--max-candidates",
                "25",
                "--max-media-candidates",
                "4",
                "--media-timeout",
                "9",
            ]
        )
        == 0
    )
    assert received["selection_mode"] == "v2-shadow"
    assert received["clip_profile"] == "deep-dive"
    assert received["max_candidates"] == 25
    assert received["max_media_candidates"] == 4
    assert received["media_timeout"] == 9.0


def test_cli_returns_nonzero_and_reports_pipeline_value_error(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *args, **kwargs: object())

    def fail_pipeline(*args, **kwargs):
        raise ValueError("No eligible highlights found")

    monkeypatch.setattr(cli, "run_pipeline", fail_pipeline)

    exit_code = cli.main(["video.mp4"])

    assert exit_code == 1
    assert "Error: No eligible highlights found" in capsys.readouterr().err


# --- Selection V3 flags ---------------------------------------------------------------------

# The argument vectors web/scripts/run-job.mjs (buildClipperInvocation) sends.
WEB_BASE_ARGS = [
    "/data/jobs/j/input/source.mp4",
    "--output-dir", "/data/jobs/j/output",
    "--model", "small",
    "--device", "cpu",
    "--language", "id",
    "--min-duration", "20",
    "--max-duration", "60",
    "--limit", "5",
    "--width", "720",
    "--height", "1280",
    "--render-mode", "fit-blur",
    "--artifact-root", "/data/jobs/j",
]  # fmt: skip
# Old V1 jobs name their mode: the CLI default is the current selection.
WEB_V1_ARGS = [*WEB_BASE_ARGS, "--selection-mode", "v1"]
WEB_V3_ARGS = [
    *WEB_BASE_ARGS,
    "--selection-mode", "v3",
    "--llm", "auto",
    "--no-cold-open",
    "--hook-overlay",
    "--caption-style", "classic",
    "--captions-dir", "/data/jobs/j/input/captions",
]  # fmt: skip


def _capture_pipeline(monkeypatch, tmp_path: Path) -> dict:
    received: dict = {}

    def pipeline(*args, **kwargs):
        received["args"] = args
        received.update(kwargs)
        manifest = tmp_path / "manifest.json"
        manifest.touch()
        return manifest

    monkeypatch.setattr(cli, "run_pipeline", pipeline)
    return received


def test_cli_v3_defaults():
    args = parse_args(["video.mp4"])
    assert args.llm_mode == "auto"
    assert args.cold_open is True
    assert args.hook_overlay is True
    assert args.caption_style is None  # karaoke for v3, classic otherwise (run_pipeline)
    # None: the pack's own spot and size (bottom, medium; CONTRACTS §5.48)
    assert args.caption_position is None and args.caption_size is None
    assert args.captions_dir is None
    assert args.trend_context is None
    assert args.word_timestamps is True
    assert args.hook_duration == 4.0


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        (["--selection-mode", "v3"], {"selection_mode": "v3"}),
        (["--llm", "off"], {"llm_mode": "off"}),
        (["--llm", "required"], {"llm_mode": "required"}),
        (["--no-cold-open"], {"cold_open": False}),
        (["--no-cold-open", "--cold-open"], {"cold_open": True}),
        (["--no-hook-overlay"], {"hook_overlay": False}),
        (["--caption-style", "karaoke"], {"caption_style": "karaoke"}),
        (["--caption-style", "classic"], {"caption_style": "classic"}),
        (["--caption-style", "box"], {"caption_style": "box"}),
        (["--caption-style", "sorot"], {"caption_style": "sorot"}),
        (["--caption-position", "top"], {"caption_position": "top"}),
        (["--caption-position", "middle"], {"caption_position": "middle"}),
        (["--caption-size", "large"], {"caption_size": "large"}),
        (["--captions-dir", "caps"], {"captions_dir": Path("caps")}),
        (["--trend-context", "tc.json"], {"trend_context": Path("tc.json")}),
        (["--no-word-timestamps"], {"word_timestamps": False}),
        (["--hook-duration", "2.5"], {"hook_duration": 2.5}),
        (["--hook-duration", "30"], {"hook_duration": 30.0}),
    ],
)
def test_cli_parses_v3_options(arguments: list[str], expected: dict):
    args = parse_args(["video.mp4", *arguments])
    assert {name: getattr(args, name) for name in expected} == expected


@pytest.mark.parametrize(
    "arguments",
    [
        ["--selection-mode", "v4"],
        ["--llm", "on"],
        ["--llm", "AUTO"],
        ["--caption-style", "neon"],
        ["--caption-position", "atas"],
        ["--caption-position", "38000"],
        ["--caption-size", "besar"],
        ["--caption-size"],
        ["--hook-duration", "0"],
        ["--hook-duration", "-1"],
        ["--hook-duration", "30.5"],
        ["--hook-duration", "nan"],
        ["--hook-duration", "inf"],
        ["--hook-duration", "soon"],
        ["--cold-open=yes"],
        ["--captions-dir"],
        ["--trend-context"],
    ],
)
def test_cli_rejects_invalid_v3_options(arguments: list[str]):
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", *arguments])


def test_cli_forwards_the_caption_look_of_a_web_job(monkeypatch, tmp_path: Path):
    """CONTRACTS §5.48: the dashboard's pack, spot and size reach run_pipeline unchanged."""
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    arguments = [*WEB_V3_ARGS[:-4], "--caption-style", "bold", "--caption-position", "top",
                 "--caption-size", "small", *WEB_V3_ARGS[-2:]]

    assert cli.main(arguments) == 0

    assert (received["caption_style"], received["caption_position"], received["caption_size"]) == (
        "bold", "top", "small")


def test_cli_legacy_web_v1_command_keeps_v1_defaults(monkeypatch, tmp_path: Path):
    loaded = []
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: loaded.append((a, k)) or "M")
    received = _capture_pipeline(monkeypatch, tmp_path)

    assert cli.main(WEB_V1_ARGS) == 0

    assert loaded == [(("small",), {"device": "cpu", "decoding": WhisperDecoding()})]
    assert received["model"] == "M"
    assert received["args"] == (Path("/data/jobs/j/input/source.mp4"), Path("/data/jobs/j/output"))
    assert received["artifact_root"] == Path("/data/jobs/j")
    assert received["render_mode"] == "fit-blur"
    assert (received["width"], received["height"], received["limit"]) == (720, 1280, 5)
    assert received["selection_mode"] == "v1"
    assert received["caption_style"] is None
    assert received["captions_dir"] is None
    assert received["trend_context"] is None
    assert received["word_timestamps"] is True


def test_cli_forwards_web_v3_command_and_loads_whisper_lazily(monkeypatch, tmp_path: Path):
    loaded = []

    class Model:
        def transcribe(self, source, **options):
            return ("segments", source, options)

    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: loaded.append((a, k)) or Model())
    received = _capture_pipeline(monkeypatch, tmp_path)

    assert cli.main(WEB_V3_ARGS) == 0

    assert received["selection_mode"] == "v3"
    assert received["llm_mode"] == "auto"
    assert received["cold_open"] is False
    assert received["hook_overlay"] is True
    assert received["caption_style"] == "classic"
    assert received["caption_position"] is None and received["caption_size"] is None
    assert received["captions_dir"] == Path("/data/jobs/j/input/captions")
    assert received["hook_duration"] == 4.0
    assert received["min_duration"] == 20.0 and received["max_duration"] == 60.0
    assert loaded == []  # usable captions may skip Whisper, so the model is not loaded yet
    model = received["model"]
    assert model.transcribe("a.mp4", language="id") == ("segments", "a.mp4", {"language": "id"})
    model.transcribe("b.mp4")
    assert loaded == [(("small",), {"device": "cpu", "decoding": WhisperDecoding()})]


@pytest.mark.parametrize(
    ("value", "expected"), [("id", "id"), ("en", "en"), ("auto", None)]
)  # fmt: skip
def test_cli_language_auto_means_detect(value: str, expected: str | None):
    assert parse_args(["video.mp4", "--language", value]).language == expected
    assert parse_args(["video.mp4"]).language == "id"


def _web_args(language: str, base: list[str]) -> list[str]:
    args = list(base)
    args[args.index("--language") + 1] = language
    return args


def test_cli_passes_the_video_language_to_whisper_and_the_pipeline(monkeypatch, tmp_path: Path):
    loaded = []

    class Model:
        def transcribe(self, source, **options):
            return ()

    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: loaded.append(k) or Model())
    received = _capture_pipeline(monkeypatch, tmp_path)

    assert cli.main(_web_args("auto", WEB_V3_ARGS)) == 0
    assert received["language"] is None
    received["model"].transcribe("a.mp4")
    # A detected language gets no built-in Indonesian prompt; Indonesian keeps it.
    assert loaded[-1]["decoding"] == WhisperDecoding(initial_prompt=None)

    assert cli.main(_web_args("en", WEB_V1_ARGS)) == 0
    assert received["language"] == "en"
    assert loaded[-1]["decoding"] == WhisperDecoding(initial_prompt=None)

    assert cli.main(WEB_V1_ARGS) == 0
    assert received["language"] == "id"
    assert loaded[-1]["decoding"] == WhisperDecoding()


def test_cli_forwards_the_trend_context_path_only(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    snapshot = "/data/jobs/j/attempts/2/analysis/trend-context.json"

    assert cli.main([*WEB_V3_ARGS, "--trend-context", snapshot]) == 0

    assert received["trend_context"] == Path(snapshot)
    assert received["selection_mode"] == "v3"


# --- Fokus klip -------------------------------------------------------------------------------


def test_cli_focus_defaults_to_none():
    args = parse_args(["video.mp4", "--selection-mode", "v3"])
    assert args.focus_terms is None and args.focus_note is None and args.focus is None


def test_cli_parses_repeatable_focus_terms_and_a_note():
    args = parse_args([
        "video.mp4", "--selection-mode", "v3", "--focus-term", "jomok", "--focus-term",
        " Reza\u200b Auditore ", "--focus-note", "momen jomok yang lucu",
    ])  # fmt: skip
    assert args.focus_terms == ["jomok", " Reza\u200b Auditore "]
    assert args.focus == FocusSpec(("jomok", "Reza Auditore"), "momen jomok yang lucu")


def test_cli_reads_the_workers_flag_equals_value_form():
    # web/scripts/run-job.mjs always sends "--flag=value", so a value that starts with "-"
    # stays a value and never becomes a flag.
    args = parse_args([
        "video.mp4", "--selection-mode", "v3", "--focus-term=jomok", "--focus-term=-rm -rf",
        "--focus-note=--help; momen jomok",
    ])  # fmt: skip
    assert args.focus == FocusSpec(("jomok", "-rm -rf"), "--help; momen jomok")


@pytest.mark.parametrize(
    "arguments",
    [
        [flag for index in range(9) for flag in ("--focus-term", f"istilah{index}")],
        ["--focus-term", "x" * 41],
        ["--focus-term", "a"],
        ["--focus-term", "jomok", "--focus-term", "JOMOK"],
        ["--focus-term", "jomok", "--focus-note", "x" * 201],
        ["--focus-note", "catatan tanpa istilah"],
        ["--focus-term"],
        ["--focus-note"],
    ],
)
def test_cli_rejects_invalid_focus_options(arguments: list[str]):
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", "--selection-mode", "v3", *arguments])


def test_cli_focus_is_only_for_selection_v3():
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", "--selection-mode", "v1", "--focus-term", "jomok"])
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", "--selection-mode", "v2-shadow", "--focus-term", "jomok"])


def test_cli_forwards_the_focus_to_the_pipeline(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)

    focus = ["--focus-term", "jomok", "--focus-term", "jomokers"]
    assert cli.main([*WEB_V3_ARGS, *focus, "--focus-note", "momen jomok yang lucu"]) == 0

    assert received["focus"] == FocusSpec(("jomok", "jomokers"), "momen jomok yang lucu")
    assert received["selection_mode"] == "v3"


def test_cli_without_focus_forwards_none(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    assert cli.main(WEB_V3_ARGS) == 0
    assert received["focus"] is None


# --- Rentang waktu ---------------------------------------------------------------------------


def test_cli_ranges_default_to_none_typed():
    assert parse_args(["video.mp4"]).ranges == ()


def test_cli_parses_repeatable_ranges_in_the_typed_order():
    args = parse_args([
        "video.mp4", "--limit", "3", "--range=630-725", "--range", "1:02:10-1:03:00",
        "--range=１０．００－１０．３０",
    ])  # fmt: skip
    assert args.ranges == (TimeRange(630, 725), TimeRange(3730, 3780), TimeRange(600, 630))


@pytest.mark.parametrize(
    "arguments",
    [
        ["--range", "10.30"],
        ["--range", "12.05-10.30"],
        ["--range", "10.00-10.02"],
        ["--range", "10.00-14.00"],
        ["--range", "1:00-1:30", "--range", "1:20-2:00"],
        ["--limit", "1", "--range", "1:00-1:30", "--range", "2:00-2:30"],
        ["--range"],
    ],
)
def test_cli_rejects_invalid_ranges(arguments, capsys):
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", "--selection-mode", "v3", *arguments])
    assert "--range" in capsys.readouterr().err


def test_cli_ranges_are_only_for_selection_v3():
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", "--selection-mode", "v1", "--range", "1:00-1:30"])


def test_cli_forwards_the_ranges_to_the_pipeline(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)

    assert cli.main([*WEB_V3_ARGS, "--range=630-725", "--range=60-90"]) == 0

    assert received["ranges"] == (TimeRange(630, 725), TimeRange(60, 90))


def test_cli_without_ranges_forwards_none(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    assert cli.main(WEB_V3_ARGS) == 0
    assert received["ranges"] == ()


def _progress_events(stdout: str) -> list[dict]:
    prefix = "POTONGIN_PROGRESS "
    return [
        json.loads(line[len(prefix) :]) for line in stdout.splitlines() if line.startswith(prefix)
    ]


def test_cli_prints_stage_summaries_on_the_current_progress_line(monkeypatch, tmp_path, capsys):
    """web/lib/jobs.mjs parseWorkerProgress reads both lines; older readers ignore `summary`."""
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")

    def pipeline(*args, progress, stage_summary, **kwargs):
        progress("transcribing", 57, "Transkripsi audio 100%")
        stage_summary("transcript", {"words": 2304, "source": "youtube-captions", "language": "id"})
        progress("audio", 58, "Menganalisis jeda dan energi audio")
        manifest = tmp_path / "manifest.json"
        manifest.touch()
        return manifest

    monkeypatch.setattr(cli, "run_pipeline", pipeline)

    assert cli.main(WEB_V3_ARGS) == 0

    assert _progress_events(capsys.readouterr().out) == [
        {"stage": "transcribing", "progress": 57, "detail": "Transkripsi audio 100%"},
        {
            "stage": "transcribing",
            "progress": 57,
            "detail": "Transkripsi audio 100%",
            "summary": {
                "transcript": {"words": 2304, "source": "youtube-captions", "language": "id"}
            },
        },
        {"stage": "audio", "progress": 58, "detail": "Menganalisis jeda dan energi audio"},
    ]


def test_cli_a_summary_before_any_progress_rides_on_the_workers_own_stage(
    monkeypatch, tmp_path, capsys
):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")

    def pipeline(*args, stage_summary, **kwargs):
        stage_summary("video", {"duration": 125.5})
        manifest = tmp_path / "manifest.json"
        manifest.touch()
        return manifest

    monkeypatch.setattr(cli, "run_pipeline", pipeline)

    assert cli.main(WEB_V3_ARGS) == 0

    assert _progress_events(capsys.readouterr().out) == [
        {
            "stage": "analyzing",
            "progress": 0,
            "detail": "Menyiapkan engine AI",
            "summary": {"video": {"duration": 125.5}},
        }
    ]


def test_cli_reports_llm_errors_without_traceback(monkeypatch, capsys):
    from ai_clipper.llm import LLMUnavailable

    monkeypatch.setattr(cli, "load_whisper_model", lambda *args, **kwargs: object())

    def fail_pipeline(*args, **kwargs):
        raise LLMUnavailable("not_configured", "LLM belum dikonfigurasi.")

    monkeypatch.setattr(cli, "run_pipeline", fail_pipeline)

    assert cli.main(["video.mp4", "--selection-mode", "v3", "--llm", "required"]) == 1
    assert "Error: not_configured: LLM belum dikonfigurasi." in capsys.readouterr().err


# --- Whisper decoding (docs/operations/TRANSCRIPTION.md) ------------------------------------


def test_cli_whisper_decoding_flags_default_to_the_environment():
    args = parse_args(["video.mp4"])
    assert args.initial_prompt is None
    assert args.condition_on_previous_text is None
    assert args.prompt_every_window is None


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        (["--initial-prompt", "Halo, apa kabar?"], {"initial_prompt": "Halo, apa kabar?"}),
        (["--initial-prompt", "off"], {"initial_prompt": "off"}),
        (["--condition-on-previous-text"], {"condition_on_previous_text": True}),
        (["--no-condition-on-previous-text"], {"condition_on_previous_text": False}),
        (["--prompt-every-window"], {"prompt_every_window": True}),
        (["--no-prompt-every-window"], {"prompt_every_window": False}),
    ],
)
def test_cli_parses_whisper_decoding_flags(arguments: list[str], expected: dict):
    args = parse_args(["video.mp4", *arguments])
    assert {name: getattr(args, name) for name in expected} == expected


@pytest.mark.parametrize(
    "arguments",
    [["--initial-prompt"], ["--condition-on-previous-text=yes"], ["--prompt-every-window=0"]],
)
def test_cli_rejects_invalid_whisper_decoding_flags(arguments: list[str]):
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", *arguments])


@pytest.mark.parametrize("extra", [[], ["--selection-mode", "v3"]])
def test_cli_loads_whisper_with_env_decoding_and_flags_win(monkeypatch, tmp_path, extra):
    loaded = []

    class Model:
        def transcribe(self, source, **options):
            return None

    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: loaded.append((a, k)) or Model())
    received = _capture_pipeline(monkeypatch, tmp_path)
    monkeypatch.setenv(ENV_INITIAL_PROMPT, "  Dari env,\n ya? ")
    monkeypatch.setenv(ENV_CONDITION_ON_PREVIOUS_TEXT, "1")
    monkeypatch.setenv(ENV_PROMPT_EVERY_WINDOW, "no")

    assert cli.main(["video.mp4", "--model", "large-v3-turbo", *extra]) == 0
    received["model"].transcribe("a.mp4")
    assert loaded[-1] == (
        ("large-v3-turbo",),
        {"device": "cpu", "decoding": WhisperDecoding("Dari env, ya?", True, False)},
    )

    command = [
        "video.mp4",
        "--initial-prompt", "off",
        "--no-condition-on-previous-text",
        "--prompt-every-window",
        *extra,
    ]  # fmt: skip
    assert cli.main(command) == 0
    received["model"].transcribe("a.mp4")
    assert loaded[-1][1]["decoding"] == WhisperDecoding(None, False, True)


@pytest.mark.parametrize(
    ("variable", "value", "argv"),
    [
        (ENV_CONDITION_ON_PREVIOUS_TEXT, "kadang-kadang", []),
        (ENV_PROMPT_EVERY_WINDOW, "kadang-kadang", []),
        (ENV_INITIAL_PROMPT, "rahasia " * 100, []),
        (ENV_INITIAL_PROMPT, "", ["--initial-prompt", "rahasia\x07"]),
    ],
    ids=["env-condition", "env-every-window", "env-long-prompt", "flag-control-character"],
)
def test_cli_rejects_invalid_whisper_decoding_before_any_work(
    monkeypatch, capsys, variable, value, argv
):
    calls = []
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: calls.append("load"))
    monkeypatch.setattr(cli, "run_pipeline", lambda *a, **k: calls.append("pipeline"))
    monkeypatch.setenv(variable, value)

    assert cli.main(["video.mp4", *argv]) == 1

    err = capsys.readouterr().err
    assert err.startswith("Error: ")
    assert "WHISPER_" in err or "--initial-prompt" in err
    assert "rahasia" not in err and "kadang" not in err
    assert "Traceback" not in err
    assert calls == []


# --- Transkripsi lewat Groq ------------------------------------------------------------------

GROQ_KEY = "groq-test-key-0000"


def test_cli_hands_the_workers_groq_switch_and_key_to_the_pipeline(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    monkeypatch.setenv(ENV_SWITCH, "on")
    monkeypatch.setenv(ENV_API_KEY, GROQ_KEY)

    assert cli.main(WEB_V3_ARGS) == 0

    # The Groq request gets the same style prompt as local Whisper.
    expected = GroqTranscription(api_key=GROQ_KEY, prompt=WhisperDecoding().initial_prompt)
    assert received["groq"] == expected


def test_cli_a_detected_language_sends_groq_no_indonesian_prompt(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    monkeypatch.setenv(ENV_SWITCH, "on")
    monkeypatch.setenv(ENV_API_KEY, GROQ_KEY)

    assert cli.main(_web_args("auto", WEB_V3_ARGS)) == 0

    assert received["groq"] == GroqTranscription(api_key=GROQ_KEY, prompt=None)


def test_cli_without_the_switch_forwards_no_groq(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    monkeypatch.setenv(ENV_API_KEY, GROQ_KEY)  # a key alone switches nothing on

    assert cli.main(WEB_V3_ARGS) == 0

    assert received["groq"] is None


def test_cli_older_selection_modes_never_use_groq(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: "M")
    received = _capture_pipeline(monkeypatch, tmp_path)
    monkeypatch.setenv(ENV_SWITCH, "on")
    monkeypatch.setenv(ENV_API_KEY, GROQ_KEY)

    assert cli.main(WEB_V1_ARGS) == 0

    assert received["groq"] is None


def test_cli_refuses_an_invalid_groq_switch_before_any_work(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(cli, "load_whisper_model", lambda *a, **k: calls.append("load"))
    monkeypatch.setattr(cli, "run_pipeline", lambda *a, **k: calls.append("pipeline"))
    monkeypatch.setenv(ENV_SWITCH, "kadang")
    monkeypatch.setenv(ENV_API_KEY, GROQ_KEY)

    assert cli.main(["video.mp4"]) == 1

    err = capsys.readouterr().err
    assert ENV_SWITCH in err and "kadang" not in err and GROQ_KEY not in err
    assert calls == []
