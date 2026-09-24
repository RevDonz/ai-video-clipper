import json
import math
import sys
import types
from pathlib import Path

import pytest

from ai_clipper import benchmark
from ai_clipper.benchmark import (
    BenchmarkError,
    GoldMoment,
    GoldSet,
    GoldTrap,
    coverage,
    evaluate_selections,
    get_selector,
    iou,
    is_hit,
    load_gold,
    load_optional_selectors,
    load_transcript,
    main,
    parse_gold,
    register_selector,
    run_benchmark,
)
from ai_clipper.models import Transcription, TranscriptSegment

REPO = Path(__file__).resolve().parents[1]
COMMITTED_GOLD = REPO / "docs" / "evaluation" / "gold" / "Ive926sC6mc.gold.json"


@pytest.fixture(autouse=True)
def _isolated_registry(monkeypatch):
    monkeypatch.setattr(benchmark, "_SELECTORS", dict(benchmark._SELECTORS))


def _gold_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": 1,
        "source_id": "synthetic01",
        "title": "Synthetic episode",
        "duration_seconds": 1200.0,
        "labeler": "test",
        "caveats": ["synthetic"],
        "moments": [
            {"id": "G1", "start": 0.0, "end": 60.0, "archetype": "hook", "label": "first"},
            {"id": "G2", "start": 100.0, "end": 160.0, "archetype": "story", "label": "second"},
            {"id": "G3", "start": 200.0, "end": 260.0, "archetype": "story", "label": "third"},
        ],
        "traps": [{"id": "T1", "start": 300.0, "end": 330.0, "label": "trap"}],
    }
    payload.update(overrides)
    return payload


def _gold() -> GoldSet:
    return parse_gold(_gold_payload())


def _write_json(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _transcript_payload(count: int = 40, step: float = 3.0) -> dict[str, object]:
    return {
        "language": "id",
        "segments": [
            {
                "start": index * step,
                "end": (index + 1) * step,
                "text": f"Kenapa ini penting? Karena cerita nomor {index} ternyata seru.",
            }
            for index in range(count)
        ],
    }


# --- span arithmetic -------------------------------------------------------------------------


def test_iou_and_coverage_are_exact():
    assert iou((0.0, 10.0), (5.0, 15.0)) == pytest.approx(5.0 / 15.0)
    assert iou((0.0, 10.0), (10.0, 20.0)) == 0.0
    assert iou((0.0, 10.0), (0.0, 10.0)) == 1.0
    assert coverage((0.0, 10.0), (5.0, 25.0)) == pytest.approx(0.25)
    assert coverage((0.0, 300.0), (100.0, 160.0)) == 1.0


def test_hit_by_iou_threshold_is_inclusive():
    gold = (0.0, 100.0)
    assert is_hit((0.0, 30.0), gold)  # IoU 0.3, coverage 0.3
    assert not is_hit((0.0, 29.0), gold)  # IoU 0.29, coverage 0.29


def test_hit_by_gold_coverage_even_when_iou_is_low():
    gold = (100.0, 160.0)
    assert is_hit((0.0, 300.0), gold)  # IoU 0.2, covers the whole gold span
    assert is_hit((130.0, 400.0), gold)  # IoU 0.1, covers exactly 50%
    assert not is_hit((131.0, 400.0), gold)  # covers 48.3%


# --- metrics ---------------------------------------------------------------------------------


def test_metrics_arithmetic_with_duplicates_and_traps():
    selections = [
        (0.0, 60.0),  # G1
        (300.0, 330.0),  # T1
        (5.0, 65.0),  # G1 again: a duplicate hit
        (1000.0, 1030.0),  # miss
        (100.0, 160.0),  # G2
        (200.0, 260.0),  # G3 (rank 6)
    ]
    matches, metrics = evaluate_selections(_gold(), selections, ks=(5, 10))

    assert [match.rank for match in matches] == [1, 2, 3, 4, 5, 6]
    assert matches[0].gold_ids == ("G1",)
    assert matches[1].trap_ids == ("T1",)
    assert matches[2].start_offset == 5.0
    assert matches[3].gold_ids == () and matches[3].best_gold_id is None

    at5, at10 = metrics
    assert at5.k == 5 and at5.considered == 5
    assert at5.hits == 2
    assert at5.recall == pytest.approx(2 / 3)
    assert at5.hit_selections == 3
    assert at5.precision == pytest.approx(3 / 5)
    assert at5.duplicate_hits == 1
    assert at5.trap_hits == 1
    assert at5.trap_rate == pytest.approx(1 / 5)
    assert at5.trap_ids == ("T1",)
    assert at5.mean_best_iou == pytest.approx(2 / 3)
    assert dict(at5.gold_first_hit_rank) == {"G1": 1, "G2": 5}
    assert at5.start_offsets == (0.0, 5.0, 0.0)
    assert at5.start_offset_median == 0.0
    assert at5.start_offset_mean_abs == pytest.approx(5.0 / 3)
    assert (at5.duration_min, at5.duration_median, at5.duration_max) == (30.0, 60.0, 60.0)

    assert at10.k == 10 and at10.considered == 6
    assert at10.hits == 3
    assert at10.recall == 1.0
    assert at10.precision == pytest.approx(4 / 6)
    assert at10.mean_best_iou == 1.0
    assert dict(at10.gold_first_hit_rank) == {"G1": 1, "G2": 5, "G3": 6}


def test_one_selection_spanning_two_golds_counts_each_gold_once():
    matches, (metrics,) = evaluate_selections(_gold(), [(0.0, 170.0), (0.0, 60.0)], ks=(5,))

    assert matches[0].gold_ids == ("G1", "G2")
    assert metrics.hits == 2
    assert metrics.hit_selections == 2
    assert metrics.duplicate_hits == 1
    assert metrics.recall == pytest.approx(2 / 3)


def test_trap_hits_count_selections_not_trap_pairs():
    gold = parse_gold(
        _gold_payload(
            traps=[
                {"id": "T1", "start": 300.0, "end": 330.0, "label": "a"},
                {"id": "T2", "start": 330.0, "end": 360.0, "label": "b"},
            ]
        )
    )
    matches, (metrics,) = evaluate_selections(gold, [(300.0, 360.0), (500.0, 520.0)], ks=(2,))

    assert matches[0].trap_ids == ("T1", "T2")
    assert metrics.trap_hits == 1
    assert metrics.trap_rate == pytest.approx(0.5)
    assert metrics.trap_ids == ("T1", "T2")


def test_empty_selection_list_has_zero_metrics():
    matches, (metrics,) = evaluate_selections(_gold(), [], ks=(5,))

    assert matches == ()
    assert metrics.considered == 0
    assert metrics.hits == 0
    assert metrics.precision == 0.0
    assert metrics.trap_rate == 0.0
    assert metrics.mean_best_iou == 0.0
    assert metrics.start_offset_median is None
    assert metrics.duration_median is None


@pytest.mark.parametrize("selection", [(10.0, 5.0), (-1.0, 5.0), (0.0, math.nan), ("a", 1.0)])
def test_invalid_selections_are_rejected(selection):
    with pytest.raises(BenchmarkError):
        evaluate_selections(_gold(), [selection], ks=(5,))


@pytest.mark.parametrize("ks", [(), (0,), (5, 5), (True,)])
def test_invalid_k_values_are_rejected(ks):
    with pytest.raises(BenchmarkError):
        evaluate_selections(_gold(), [(0.0, 60.0)], ks=ks)


# --- gold loading ----------------------------------------------------------------------------


def test_committed_gold_file_loads_strictly():
    gold = load_gold(COMMITTED_GOLD)

    assert gold.source_id == "Ive926sC6mc"
    assert gold.duration_seconds == 3922.15
    assert [moment.id for moment in gold.moments] == [f"G{index}" for index in range(1, 13)]
    assert [trap.id for trap in gold.traps] == [f"T{index}" for index in range(1, 7)]
    assert gold.labeler.startswith("llm-editor-proxy")
    assert all(len(item.label) <= 80 for item in (*gold.moments, *gold.traps))
    assert isinstance(gold.moments[0], GoldMoment) and isinstance(gold.traps[0], GoldTrap)


def _broken(mutate) -> dict[str, object]:
    payload = json.loads(json.dumps(_gold_payload()))
    mutate(payload)
    return payload


@pytest.mark.parametrize(
    "payload",
    [
        _broken(lambda p: p.pop("labeler")),
        _broken(lambda p: p.update(extra=True)),
        _broken(lambda p: p.update(schema_version=2)),
        _broken(lambda p: p.update(schema_version=True)),
        _broken(lambda p: p.update(source_id="../escape")),
        _broken(lambda p: p.update(duration_seconds=0)),
        _broken(lambda p: p.update(caveats="one string")),
        _broken(lambda p: p.update(moments=[])),
        _broken(lambda p: p["moments"][0].update(start=70.0)),
        _broken(lambda p: p["moments"][0].update(end=5000.0)),
        _broken(lambda p: p["moments"][0].update(start=True)),
        _broken(lambda p: p["moments"][0].update(label="x" * 81)),
        _broken(lambda p: p["moments"][0].update(label=" ")),
        _broken(lambda p: p["moments"][0].update(archetype="")),
        _broken(lambda p: p["moments"][0].pop("archetype")),
        _broken(lambda p: p["moments"][1].update(id="G1")),
        _broken(lambda p: p["traps"][0].update(id="G1")),
        _broken(lambda p: p["moments"][1].update(start=0.0, end=60.0)),
        _broken(lambda p: p["traps"][0].update(archetype="x")),
        [1, 2, 3],
    ],
)
def test_malformed_gold_is_rejected(payload):
    with pytest.raises(BenchmarkError):
        parse_gold(payload)


def test_gold_file_rejects_duplicate_keys_and_non_finite_constants(tmp_path):
    duplicate = tmp_path / "duplicate.gold.json"
    duplicate.write_text('{"schema_version": 1, "schema_version": 1}', encoding="utf-8")
    nan = tmp_path / "nan.gold.json"
    nan.write_text(json.dumps(_gold_payload()).replace("1200.0", "NaN"), encoding="utf-8")
    broken = tmp_path / "broken.gold.json"
    broken.write_text("{", encoding="utf-8")

    for path in (duplicate, nan, broken, tmp_path / "missing.gold.json"):
        with pytest.raises(BenchmarkError):
            load_gold(path)


# --- transcript loading ----------------------------------------------------------------------


def _block_transcript_io(monkeypatch):
    monkeypatch.setitem(sys.modules, "ai_clipper.transcript_io", None)


def test_fallback_transcript_loader_accepts_segments_with_and_without_words(tmp_path, monkeypatch):
    _block_transcript_io(monkeypatch)
    path = _write_json(
        tmp_path / "transcript.json",
        {
            "language": "id",
            "segments": [
                {"start": 0.0, "end": 2.0, "text": "Tanpa kata."},
                {
                    "start": 2.0,
                    "end": 4.0,
                    "text": "Dengan kata.",
                    "words": [
                        {"start": 2.0, "end": 2.5, "text": "Dengan", "probability": 0.9},
                        {"start": 2.6, "end": 3.9, "word": " kata."},
                    ],
                    "avg_logprob": -0.2,
                },
                {"start": 4.0, "end": 5.0, "text": "   "},
            ],
        },
    )

    loaded = load_transcript(path)

    assert loaded.reader == "fallback"
    assert loaded.language == "id"
    assert [segment.text for segment in loaded.segments] == ["Tanpa kata.", "Dengan kata."]
    assert loaded.segments[0].words == ()
    assert [word.text for word in loaded.segments[1].words] == ["Dengan", "kata."]
    assert loaded.segments[1].words[0].probability == 0.9
    assert loaded.warnings == ("skipped_segments:1",)


def test_fallback_transcript_loader_accepts_a_bare_segment_list(tmp_path, monkeypatch):
    _block_transcript_io(monkeypatch)
    path = _write_json(tmp_path / "t.json", [{"start": 0, "end": 1, "text": "Halo."}])

    loaded = load_transcript(path)

    assert loaded.language is None
    assert loaded.segments == (TranscriptSegment(0.0, 1.0, "Halo."),)


@pytest.mark.parametrize(
    "payload",
    [{"language": "id"}, {"segments": "nope"}, {"segments": [{"start": 0, "end": 1}]}, 3],
)
def test_fallback_transcript_loader_rejects_unusable_input(tmp_path, monkeypatch, payload):
    _block_transcript_io(monkeypatch)
    path = _write_json(tmp_path / "t.json", payload)

    with pytest.raises(BenchmarkError):
        load_transcript(path)


def test_transcript_loader_prefers_transcript_io_when_available(tmp_path, monkeypatch):
    calls: list[Path] = []
    fake = types.ModuleType("ai_clipper.transcript_io")

    def read_transcript_json(path):
        calls.append(Path(path))
        return Transcription("id", [TranscriptSegment(0.0, 1.0, "Dari transcript_io.")])

    fake.read_transcript_json = read_transcript_json
    monkeypatch.setitem(sys.modules, "ai_clipper.transcript_io", fake)
    path = _write_json(tmp_path / "t.json", {"language": "id", "segments": []})

    loaded = load_transcript(path)

    assert calls == [path]
    assert loaded.reader == "transcript_io"
    assert loaded.segments[0].text == "Dari transcript_io."


def test_transcript_loader_falls_back_when_transcript_io_rejects_input(tmp_path, monkeypatch):
    fake = types.ModuleType("ai_clipper.transcript_io")

    def read_transcript_json(path):
        raise ValueError("strict reader says no")

    fake.read_transcript_json = read_transcript_json
    monkeypatch.setitem(sys.modules, "ai_clipper.transcript_io", fake)
    path = _write_json(tmp_path / "t.json", _transcript_payload(2))

    loaded = load_transcript(path)

    assert loaded.reader == "fallback"
    assert "transcript_io_rejected_input" in loaded.warnings
    assert len(loaded.segments) == 2


# --- selectors -------------------------------------------------------------------------------


def test_builtin_selectors_are_registered():
    for name in ("v1", "v2-standard", "v2-viral", "v2-deep"):
        assert callable(get_selector(name).fn)
    with pytest.raises(BenchmarkError):
        get_selector("does-not-exist")


def test_register_selector_rejects_duplicates_unless_replacing():
    def fake(segments, *, k, min_duration, max_duration, audio_timeline=None):
        return [(0.0, 1.0)]

    register_selector("fake", fake)
    with pytest.raises(BenchmarkError):
        register_selector("fake", fake)
    register_selector("fake", fake, replace=True, description="again")
    assert get_selector("fake").description == "again"
    with pytest.raises(BenchmarkError):
        register_selector("Bad Name", fake)


def test_v1_selector_returns_rank_order_not_chronological_order():
    texts = ["ternyata"] + ["kata biasa"] * 6 + ["rahasia penting"] + ["kata biasa"] * 2
    for index, text in enumerate(texts):
        texts[index] = f"{text} satu dua tiga empat lima enam"
    segments = [
        TranscriptSegment(index * 10.0, index * 10.0 + 10.0, text)
        for index, text in enumerate(texts)
    ]

    spans = get_selector("v1").fn(segments, k=2, min_duration=20.0, max_duration=30.0)

    assert spans == [(50.0, 80.0), (0.0, 30.0)]


@pytest.mark.parametrize(("name", "bounds"), [("v2-viral", (15.0, 45.0))])
def test_v2_selectors_return_ranked_spans_within_profile_bounds(name, bounds):
    segments = [
        TranscriptSegment(float(segment["start"]), float(segment["end"]), segment["text"])
        for segment in _transcript_payload(40)["segments"]
    ]
    spec = get_selector(name)

    spans = spec.fn(segments, k=3, min_duration=20.0, max_duration=60.0)

    assert spec.fixed_bounds == bounds
    assert 1 <= len(spans) <= 3
    for start, end in spans:
        assert bounds[0] <= end - start <= bounds[1]


def test_load_optional_selectors_registers_v3_plugins(monkeypatch):
    fake = types.ModuleType("ai_clipper.selection_v3")

    def v3_fake(segments, *, k, min_duration, max_duration, audio_timeline=None):
        return [(0.0, 30.0)]

    fake.benchmark_selectors = lambda: {"v3-fake": v3_fake}
    monkeypatch.setitem(sys.modules, "ai_clipper.selection_v3", fake)

    loaded = load_optional_selectors()

    assert "v3-fake" in loaded
    assert get_selector("v3-fake").fn is v3_fake


def test_run_benchmark_passes_arguments_and_audio_timeline():
    seen: dict[str, object] = {}

    def fake(segments, *, k, min_duration, max_duration, audio_timeline=None):
        seen.update(k=k, bounds=(min_duration, max_duration), timeline=audio_timeline)
        return [(0.0, 60.0), (300.0, 330.0)]

    register_selector("fake", fake)
    segments = [TranscriptSegment(0.0, 1.0, "halo")]

    run = run_benchmark(
        _gold(),
        segments,
        "fake",
        ks=(1, 5),
        min_duration=15.0,
        max_duration=45.0,
        audio_timeline="timeline",
    )

    assert seen == {"k": 5, "bounds": (15.0, 45.0), "timeline": "timeline"}
    assert run.status == "completed"
    assert run.duration_bounds == (15.0, 45.0)
    assert [metric.hits for metric in run.metrics] == [1, 1]
    assert [metric.trap_hits for metric in run.metrics] == [0, 1]


def test_run_benchmark_records_selector_failure_without_leaking_secrets(monkeypatch):
    secret = "sk-test-secret-value-123456"
    monkeypatch.setenv("POTONGIN_LLM_API_KEY", secret)

    def broken(segments, *, k, min_duration, max_duration, audio_timeline=None):
        raise RuntimeError(f"provider rejected key {secret}")

    register_selector("broken", broken)

    run = run_benchmark(_gold(), [TranscriptSegment(0.0, 1.0, "halo")], "broken", ks=(5,))

    assert run.status == "failed"
    assert secret not in (run.error or "")
    assert "[redacted]" in (run.error or "")
    assert run.metrics == ()


def test_run_benchmark_rejects_invalid_duration_bounds():
    with pytest.raises(BenchmarkError):
        run_benchmark(_gold(), [], "v1", ks=(5,), min_duration=60.0, max_duration=20.0)


# --- CLI -------------------------------------------------------------------------------------


def _cli_files(tmp_path: Path, name: str = "synthetic01") -> tuple[Path, Path]:
    gold = _write_json(tmp_path / f"{name}.gold.json", _gold_payload(source_id=name))
    transcript = _write_json(tmp_path / f"{name}.transcript.json", _transcript_payload(400))
    return gold, transcript


def _register_fixed(name: str, spans: list[tuple[float, float]]) -> None:
    def fixed(segments, *, k, min_duration, max_duration, audio_timeline=None):
        return spans[:k]

    register_selector(name, fixed)


def test_cli_single_run_prints_table_and_writes_json(tmp_path, capsys):
    gold, transcript = _cli_files(tmp_path)
    _register_fixed("fixed", [(0.0, 60.0), (300.0, 330.0), (1000.0, 1030.0)])
    output = tmp_path / "out" / "report.json"

    code = main(
        [
            "--gold",
            str(gold),
            "--transcript",
            str(transcript),
            "--selector",
            "fixed",
            "--k",
            "2",
            "--k",
            "5",
            "--json",
            str(output),
        ]
    )

    assert code == 0
    printed = capsys.readouterr().out
    assert "synthetic01" in printed and "fixed" in printed and "G1#1" in printed
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema_version"] == 1
    assert report["ks"] == [2, 5]
    assert report["hit_rule"] == {"min_iou": 0.3, "min_gold_coverage": 0.5}
    (run,) = report["runs"]
    assert run["selector"] == "fixed" and run["status"] == "completed"
    assert [metric["k"] for metric in run["metrics"]] == [2, 5]
    assert run["metrics"][0]["hits"] == 1
    assert run["metrics"][0]["trap_hits"] == 1
    assert run["selections"][0]["gold_hits"] == ["G1"]
    assert "text" not in run["selections"][0]


def test_cli_compare_runs_every_selector_on_every_episode(tmp_path, capsys):
    gold_a, transcript_a = _cli_files(tmp_path, "episodeA")
    gold_b, transcript_b = _cli_files(tmp_path, "episodeB")
    _register_fixed("fixed", [(0.0, 60.0)])
    _register_fixed("other", [(1000.0, 1030.0)])
    output = tmp_path / "compare.json"

    code = main(
        [
            "--compare",
            "--gold",
            str(gold_a),
            "--transcript",
            str(transcript_a),
            "--gold",
            str(gold_b),
            "--transcript",
            str(transcript_b),
            "--selector",
            "fixed",
            "--selector",
            "other",
            "--k",
            "5",
            "--json",
            str(output),
        ]
    )

    assert code == 0
    printed = capsys.readouterr().out
    assert "episodeA" in printed and "episodeB" in printed
    report = json.loads(output.read_text(encoding="utf-8"))
    assert [(run["source_id"], run["selector"]) for run in report["runs"]] == [
        ("episodeA", "fixed"),
        ("episodeA", "other"),
        ("episodeB", "fixed"),
        ("episodeB", "other"),
    ]
    pooled = {(row["selector"], row["k"]): row for row in report["pooled"]}
    assert pooled[("fixed", 5)]["episodes"] == 2
    assert pooled[("fixed", 5)]["gold"] == 6
    assert pooled[("fixed", 5)]["hits"] == 2
    assert pooled[("fixed", 5)]["recall"] == pytest.approx(2 / 6, abs=1e-6)
    assert pooled[("other", 5)]["hits"] == 0


def test_cli_rejects_multiple_selectors_without_compare(tmp_path, capsys):
    gold, transcript = _cli_files(tmp_path)

    code = main(
        [
            "--gold",
            str(gold),
            "--transcript",
            str(transcript),
            "--selector",
            "v1",
            "--selector",
            "v2-viral",
        ]
    )

    assert code == 2
    assert "--compare" in capsys.readouterr().err


def test_cli_exit_codes_for_bad_input(tmp_path, capsys):
    gold, transcript = _cli_files(tmp_path)
    bad_gold = _write_json(tmp_path / "bad.gold.json", _broken(lambda p: p.pop("moments")))

    assert main(["--gold", str(bad_gold), "--transcript", str(transcript), "--selector", "v1"]) == 2
    assert main(["--gold", str(gold), "--selector", "v1"]) == 2
    assert (
        main(
            [
                "--gold",
                str(gold),
                "--gold",
                str(gold),
                "--transcript",
                str(transcript),
                "--selector",
                "v1",
                "--compare",
            ]
        )
        == 2
    )
    assert main(["--gold", str(gold), "--transcript", str(transcript), "--selector", "nope"]) == 2
    assert (
        main(["--gold", str(gold), "--transcript", str(transcript), "--selector", "v1", "--k", "0"])
        == 2
    )
    assert (
        main(
            [
                "--gold",
                str(gold),
                "--transcript",
                str(transcript),
                "--selector",
                "v1",
                "--min-duration",
                "60",
                "--max-duration",
                "20",
            ]
        )
        == 2
    )
    err = capsys.readouterr().err
    assert "benchmark_error" in err


def test_cli_returns_one_when_a_selector_fails(tmp_path, capsys, monkeypatch):
    secret = "gsk_secret_value_abcdef123456"
    monkeypatch.setenv("GROQ_API_KEY", secret)
    gold, transcript = _cli_files(tmp_path)

    def broken(segments, *, k, min_duration, max_duration, audio_timeline=None):
        raise RuntimeError(f"boom {secret}")

    register_selector("broken", broken)
    _register_fixed("fixed", [(0.0, 60.0)])
    output = tmp_path / "report.json"

    code = main(
        [
            "--compare",
            "--gold",
            str(gold),
            "--transcript",
            str(transcript),
            "--selector",
            "broken",
            "--selector",
            "fixed",
            "--json",
            str(output),
        ]
    )

    assert code == 1
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
    assert secret not in output.read_text(encoding="utf-8")
    statuses = [run["status"] for run in json.loads(output.read_text())["runs"]]
    assert statuses == ["failed", "completed"]


def test_cli_audio_timeline_count_must_match_pairs(tmp_path, capsys):
    gold, transcript = _cli_files(tmp_path)
    timeline = _write_json(tmp_path / "timeline.json", {})

    code = main(
        [
            "--compare",
            "--gold",
            str(gold),
            "--transcript",
            str(transcript),
            "--audio-timeline",
            str(timeline),
            "--audio-timeline",
            str(timeline),
            "--selector",
            "v1",
        ]
    )

    assert code == 2


def test_run_benchmark_truncates_to_max_k_and_accepts_span_objects():
    class Clip:
        def __init__(self, start: float, end: float) -> None:
            self.start, self.end = start, end

    def generous(segments, *, k, min_duration, max_duration, audio_timeline=None):
        return [Clip(0.0, 60.0), (100.0, 160.0), (200.0, 260.0), (400.0, 430.0)]

    register_selector("generous", generous)

    run = run_benchmark(_gold(), [TranscriptSegment(0.0, 1.0, "halo")], "generous", ks=(2,))

    assert run.status == "completed"
    assert [match.rank for match in run.selections] == [1, 2]
    assert run.metrics[0].hits == 2


def test_run_benchmark_marks_invalid_selector_output_as_failed():
    register_selector("bad", lambda segments, **kwargs: [(10.0, 5.0)])

    run = run_benchmark(_gold(), [TranscriptSegment(0.0, 1.0, "halo")], "bad", ks=(5,))

    assert run.status == "failed"
    assert "BenchmarkError" in (run.error or "")


def test_unknown_v3_selector_explains_missing_plugin(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(benchmark, "_PLUGIN_FAILURES", {})
    monkeypatch.setitem(sys.modules, "ai_clipper.selection_v3", types.ModuleType("stub"))
    gold, transcript = _cli_files(tmp_path)

    code = main(["--gold", str(gold), "--transcript", str(transcript), "--selector", "v3-llm"])

    assert code == 2
    err = capsys.readouterr().err
    assert "unknown selector: v3-llm" in err
    assert "selection_v3" in err and "benchmark_selectors" in err


def test_broken_v3_plugin_reports_why_it_failed(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(benchmark, "_PLUGIN_FAILURES", {})
    monkeypatch.setenv("POTONGIN_TEST_API_KEY", "sk-benchmark-plugin-secret")
    broken = types.ModuleType("ai_clipper.selection_v3")

    def benchmark_selectors():
        raise RuntimeError("heuristic table missing (sk-benchmark-plugin-secret)")

    broken.benchmark_selectors = benchmark_selectors
    monkeypatch.setitem(sys.modules, "ai_clipper.selection_v3", broken)
    gold, transcript = _cli_files(tmp_path)

    code = main(["--gold", str(gold), "--transcript", str(transcript), "--selector", "v3-llm"])

    assert code == 2
    err = capsys.readouterr().err
    assert "RuntimeError: heuristic table missing" in err
    assert "sk-benchmark-plugin-secret" not in err


# --- selector context, sound events, SelectionResult provenance ------------------------------


def test_context_is_passed_only_to_selectors_that_accept_it():
    seen: dict[str, object] = {}

    def plain(segments, *, k, min_duration, max_duration, audio_timeline=None):
        return [(0.0, 60.0)]

    def aware(segments, *, k, min_duration, max_duration, audio_timeline=None, context=None):
        seen["context"] = context
        return [(0.0, 60.0)]

    register_selector("plain", plain)
    register_selector("aware", aware)
    context = benchmark.SelectorContext("synthetic01", (), Path("cache"))
    segments = [TranscriptSegment(0.0, 1.0, "halo")]

    assert run_benchmark(_gold(), segments, "plain", ks=(5,), context=context).status == (
        "completed"
    )
    assert run_benchmark(_gold(), segments, "aware", ks=(5,), context=context).status == (
        "completed"
    )
    assert seen["context"] is context
    with pytest.raises(BenchmarkError):
        run_benchmark(_gold(), segments, "plain", ks=(5,), context={"source_id": "x"})


def test_selection_result_provenance_and_cold_open_share_are_recorded(monkeypatch):
    secret = "sk-provenance-secret-000"
    monkeypatch.setenv("POTONGIN_LLM_API_KEY", secret)
    clips = (
        types.SimpleNamespace(start=0.0, end=60.0, cold_open=(10.0, 13.0)),
        types.SimpleNamespace(start=100.0, end=160.0, cold_open=None),
        types.SimpleNamespace(start=500.0, end=530.0, cold_open=None),
    )
    result = types.SimpleNamespace(
        clips=clips,
        source="llm",
        status="completed",
        provider="ollama-cloud",
        model="gpt-oss:120b",
        prompt_version="llm-select-v1+std.abc",
        warnings=("llm_filled:1", f"leak {secret}"),
        usage={"requests": 2, "cached_requests": 1},
    )

    def v3_like(segments, *, k, min_duration, max_duration, audio_timeline=None):
        return result

    register_selector("v3-like", v3_like)

    run = run_benchmark(_gold(), [TranscriptSegment(0.0, 1.0, "halo")], "v3-like", ks=(2, 3))

    assert run.status == "completed"
    assert [metric.hits for metric in run.metrics] == [2, 2]
    assert [metric.cold_open_share for metric in run.metrics] == [0.5, pytest.approx(1 / 3)]
    assert [match.cold_open for match in run.selections] == [True, False, False]
    assert run.selector_info["provider"] == "ollama-cloud"
    assert run.selector_info["usage"] == {"requests": 2, "cached_requests": 1}
    assert secret not in json.dumps(run.selector_info)
    report = benchmark.report_dict([], [run], (2, 3))
    assert report["runs"][0]["selector_info"]["source"] == "llm"
    assert report["runs"][0]["metrics"][0]["cold_open_share"] == 0.5
    assert report["runs"][0]["selections"][0]["cold_open"] is True


def test_plain_spans_have_no_cold_open_share():
    _register_fixed("fixed", [(0.0, 60.0)])

    run = run_benchmark(_gold(), [TranscriptSegment(0.0, 1.0, "halo")], "fixed", ks=(5,))

    assert run.metrics[0].cold_open_share is None
    assert run.selector_info is None


def test_load_sound_events_reads_the_artifact_and_the_legacy_format(tmp_path):
    from ai_clipper.sound_events import SoundEvent, write_sound_events

    artifact = tmp_path / "sound-events.json"
    write_sound_events(artifact, [SoundEvent.from_label(2.0, "tertawa")], source="youtube-json3")
    legacy = _write_json(
        tmp_path / "sound-events.yt.json",
        {
            "source": "youtube-json3",
            "events": [
                {"time": 5.0, "label": "tertawa][terkesiap"},
                {"time": 1.0, "label": "tepuk tangan"},
                {"time": 3.0, "label": "2x"},
            ],
        },
    )

    assert [(event.time, event.kind) for event in benchmark.load_sound_events(artifact)] == [
        (2.0, "laughter")
    ]
    assert [(event.time, event.kind) for event in benchmark.load_sound_events(legacy)] == [
        (1.0, "applause"),
        (5.0, "gasp"),
        (5.0, "laughter"),
    ]
    broken = _write_json(tmp_path / "broken.json", {"version": "sound-events-v1", "x": 1})
    with pytest.raises(BenchmarkError):
        benchmark.load_sound_events(broken)
    with pytest.raises(BenchmarkError):
        benchmark.load_sound_events(_write_json(tmp_path / "list.json", [1, 2]))


def test_cli_passes_sound_events_and_cache_dirs(tmp_path, capsys, monkeypatch):
    gold, transcript = _cli_files(tmp_path)
    events = _write_json(
        tmp_path / "events.json", {"source": "x", "events": [{"time": 4.0, "label": "tertawa"}]}
    )
    seen: list[object] = []

    def aware(segments, *, k, min_duration, max_duration, audio_timeline=None, context=None):
        seen.append(context)
        return [(0.0, 60.0)]

    register_selector("aware", aware)
    output = tmp_path / "report.json"

    code = main(
        [
            "--gold",
            str(gold),
            "--transcript",
            str(transcript),
            "--sound-events",
            str(events),
            "--llm-cache-dir",
            str(tmp_path / "cache"),
            "--selector",
            "aware",
            "--json",
            str(output),
        ]
    )

    assert code == 0
    (context,) = seen
    assert context.source_id == "synthetic01"
    assert [event.kind for event in context.sound_events] == ["laughter"]
    assert context.llm_cache_dir == tmp_path / "cache"
    episode = json.loads(output.read_text(encoding="utf-8"))["episodes"][0]
    assert episode["sound_events"] == 1 and episode["llm_cache"] is True

    seen.clear()
    assert main(["--gold", str(gold), "--transcript", str(transcript), "--selector", "aware"]) == 0
    assert seen[0].llm_cache_dir == Path("artifacts") / "eval" / "synthetic01" / "llm-cache"
    assert seen[0].sound_events == ()


@pytest.mark.parametrize("flag", ["--sound-events", "--llm-cache-dir"])
def test_cli_per_pair_options_must_match_pairs(tmp_path, capsys, flag):
    gold_a, transcript_a = _cli_files(tmp_path, "episodeA")
    gold_b, transcript_b = _cli_files(tmp_path, "episodeB")

    code = main(
        [
            "--compare",
            "--gold",
            str(gold_a),
            "--transcript",
            str(transcript_a),
            "--gold",
            str(gold_b),
            "--transcript",
            str(transcript_b),
            flag,
            str(tmp_path / "one"),
            "--selector",
            "v1",
        ]
    )

    assert code == 2
    assert flag in capsys.readouterr().err
