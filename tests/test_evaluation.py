import hashlib
import json
import multiprocessing
import os
import threading
from pathlib import Path

import pytest

from ai_clipper.candidates import BoundaryCandidate
from ai_clipper.features import FeatureEvidence, FeatureExtractionResult
from ai_clipper.models import CandidateFeatures, ClipProfile
from ai_clipper.ranking import (
    SELECTION_VERSION,
    CandidatesArtifact,
    RankedInput,
    RankingMediaSignals,
    WeightConfig,
    rank_candidates_with_breakdowns,
    write_candidates_artifact,
)


def _json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _candidate_input(
    key: int,
    start: float,
    end: float,
    text: str,
    terms: tuple[str, ...],
    standalone: float,
    density: float,
    media: bool = False,
) -> RankedInput:
    features = CandidateFeatures(
        hook_strength=8,
        hook_relevance=7,
        standalone_context=standalone,
        payoff_completeness=9,
        information_density=density,
        emotion_energy=5,
        dialogue_dynamics=5,
        visual_activity=5,
        topic_value=4,
        boundary_quality=10,
    )
    extraction = FeatureExtractionResult(
        features,
        (FeatureEvidence("hook.direct_question", "hook_strength", "positive", "question"),),
        terms,
    )
    signals = None
    if media:
        signals = RankingMediaSignals(
            analyzer_version="media-v1",
            analysis_id="analysis-a",
            source="source.mp4",
            interval_start=start,
            interval_end=end,
            audio_energy=5,
            energy_change=5,
            scene_activity=5,
            motion=5,
            face_activity=5,
        )
    return RankedInput(
        str(key),
        BoundaryCandidate(key, key, start, end, text, ("segment",), ("segment",)),
        extraction,
        signals,
    )


def _write_candidates(job: Path, source: str, specs: list[tuple]) -> CandidatesArtifact:
    inputs = [_candidate_input(*spec) for spec in specs]
    selection = rank_candidates_with_breakdowns(
        inputs,
        source=source,
        profile=ClipProfile.STANDARD,
        k=len(inputs),
        config=WeightConfig(overlap_threshold=1, diversity_strength=0),
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        source,
        ("synthetic lexical evidence",),
        WeightConfig(overlap_threshold=1, diversity_strength=0),
        selection.candidates,
        selection.breakdowns,
        selection.media_snapshots,
    )
    write_candidates_artifact(job / "analysis" / "candidates.v2.json", artifact)
    return artifact


def _job(tmp_path: Path, name: str, *, manifest: bool = True) -> Path:
    job = tmp_path / name
    _json(
        job / "transcript.json",
        {
            "language": "en",
            "segments": [
                {"start": 0, "end": 30, "text": f"private transcript {name} alpha"},
                {"start": 30, "end": 60, "text": f"private transcript {name} beta"},
                {"start": 60, "end": 90, "text": f"private transcript {name} gamma"},
            ],
        },
    )
    if manifest:
        _json(
            job / "manifest.json",
            {
                "source": f"/private/{name}.mp4",
                "render_mode": "center-crop",
                "status": "completed",
                "language": "en",
                "transcript": f"/private/{name}/transcript.json",
                "clips": [
                    {
                        "index": 1,
                        "start": 0,
                        "end": 30,
                        "duration": 30,
                        "score": 7,
                        "text": f"private V1 {name}",
                        "output": f"/private/{name}/clip.mp4",
                        "subtitles": f"/private/{name}/clip.srt",
                    }
                ],
            },
        )
    return job


def _registry(tmp_path: Path, jobs: list[Path]) -> Path:
    path = tmp_path / "registry.json"
    sources = []
    licenses = ["CC-BY-4.0", "proprietary", "CC0-1.0"]
    allowed = [True, True, False]
    for index, job in enumerate(jobs):
        sources.append(
            {
                "source_id": f"source-{index + 1}",
                "job_id": job.name,
                "source_url": f"https://user:secret@example.test/{job.name}?token=hidden&v={index}",
                "license": licenses[index],
                "training_allowed": allowed[index],
            }
        )
    _json(path, {"registry_version": "source-registry-v1.0", "sources": sources})
    return path


def _feedback(job: Path, artifact: CandidatesArtifact, decisions: list[str]) -> None:
    candidate_path = job / "analysis" / "candidates.v2.json"
    events = []
    for index, decision in enumerate(decisions):
        events.append(
            {
                "event_id": f"00000000-0000-4000-8000-{index + 1:012d}",
                "client_request_id": f"10000000-0000-4000-8000-{index + 1:012d}",
                "candidate_id": artifact.candidates[index].candidate_id,
                "decision": decision,
                "note": "private reviewer note",
                "created_at": f"2026-08-30T00:00:0{index}.000Z",
            }
        )
    _json(
        job / "analysis" / "candidate-feedback.v1.json",
        {
            "feedback_version": "feedback-v1",
            "selection_version": SELECTION_VERSION,
            "candidate_artifact_analysis": {
                "artifact": "analysis/candidates.v2.json",
                "sha256": hashlib.sha256(candidate_path.read_bytes()).hexdigest(),
            },
            "events": events,
        },
    )


def test_evaluates_three_sources_with_honest_metrics_rights_and_privacy(tmp_path: Path):
    from ai_clipper.evaluation import evaluate_jobs

    jobs = [
        _job(tmp_path, "job-a"),
        _job(tmp_path, "job-b"),
        _job(tmp_path, "job-c", manifest=False),
    ]
    first = _write_candidates(
        jobs[0],
        "source.mp4",
        [
            (0, 0, 30, "candidate secret one", ("alpha", "shared"), 6, 5, True),
            (1, 30, 60, "candidate secret two", ("beta", "shared"), 8, 7, False),
        ],
    )
    _write_candidates(
        jobs[1],
        "source-b.mp4",
        [(0, 15, 45, "candidate B", ("topic",), 4, 3, False)],
    )
    _feedback(jobs[0], first, ["accepted", "rejected"])
    registry = _registry(tmp_path, jobs)
    output = tmp_path / "report"

    report = evaluate_jobs(registry, jobs, output, top_k=2)

    assert report["schema_version"] == "evaluation-v1.0"
    assert [source["source"]["id"] for source in report["sources"]] == [
        "source-1",
        "source-2",
        "source-3",
    ]
    one, two, three = report["sources"]
    assert one["duration_seconds"] == 90
    assert one["transcript_cue_count"] == 3
    assert one["v1"]["windows"][0] == {"start": 0.0, "end": 30.0, "duration": 30.0}
    assert one["v2"]["candidate_count"] == 2
    assert one["v2"]["profile_counts"] == {"standard": 2}
    assert one["v2"]["duration_distribution"] == {
        "sample_size": 2,
        "min": 30.0,
        "mean": 30.0,
        "median": 30.0,
        "max": 30.0,
    }
    assert one["comparison"]["pairwise_temporal_iou"]["max"] == 1.0
    assert one["comparison"]["coverage"]["v1_covered_by_v2"] == 1.0
    assert one["comparison"]["top_k_temporal_overlap"]["k"] == 2
    assert one["v2"]["topic_diversity_pairwise_jaccard"] == {
        "sample_size": 1,
        "mean": pytest.approx(1 / 3),
        "max": pytest.approx(1 / 3),
    }
    assert one["v2"]["media_coverage"] == {"available": 1, "total": 2, "rate": 0.5}
    assert one["feedback"]["counts"] == {"accepted": 1, "rejected": 1, "undecided": 0}
    assert one["feedback"]["acceptance_at_k"] == {"k": 2, "labeled": 2, "accepted": 1, "rate": 0.5}
    assert two["feedback"] == {
        "available": False,
        "counts": {"accepted": 0, "rejected": 0, "undecided": 0},
        "labeled_count": 0,
        "label_coverage": 0.0,
        "acceptance_at_k": None,
    }
    assert two["v2"]["media_coverage"] == {"available": 0, "total": 1, "rate": 0.0}
    assert two["source"]["use_classification"] == "evaluation_only"
    assert three["source"]["use_classification"] == "evaluation_only"
    assert three["v1"]["available"] is False
    assert three["v2"]["available"] is False
    assert three["comparison"] is None
    assert three["feedback"]["label_coverage"] is None
    assert report["aggregate"]["rights_counts"] == {"training": 1, "evaluation_only": 2}
    assert report["aggregate"]["micro"]["feedback_counts"] == {
        "accepted": 1,
        "rejected": 1,
        "undecided": 0,
    }
    assert report["aggregate"]["micro"]["label_coverage"] == pytest.approx(2 / 3)
    assert report["aggregate"]["macro"]["media_coverage"] == pytest.approx(0.25)

    raw = (output / "evaluation.json").read_text(encoding="utf-8")
    markdown = (output / "evaluation.md").read_text(encoding="utf-8")
    for secret in (
        "private transcript",
        "candidate secret",
        "private V1",
        "reviewer note",
        "secret",
        "token=",
        "source.mp4",
    ):
        assert secret not in raw
        assert secret not in markdown
    assert json.loads(raw) == report
    assert "v2 wins" not in markdown.lower()
    assert "viral probability" not in markdown.lower()


def _run_eval(arguments: tuple[str, list[str], str]) -> bytes:
    from ai_clipper.evaluation import evaluate_jobs

    registry, jobs, output = arguments
    evaluate_jobs(Path(registry), [Path(job) for job in jobs], Path(output))
    return (Path(output) / "evaluation.json").read_bytes()


def test_deterministic_atomic_concurrent_cli_and_strict_boundaries(tmp_path: Path, monkeypatch):
    from ai_clipper.evaluation import MAX_INPUT_BYTES, EvaluationError, main

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "output"

    assert main(["--registry", str(registry), "--job", str(job), "--output-dir", str(output)]) == 0
    first = (output / "evaluation.json").read_bytes()
    assert main(["--registry", str(registry), "--job", str(job), "--output-dir", str(output)]) == 0
    assert (output / "evaluation.json").read_bytes() == first
    assert not list(output.glob(".evaluation.*.tmp"))

    ctx = multiprocessing.get_context("fork")
    args = (str(registry), [str(job)], str(output))
    with ctx.Pool(4) as pool:
        results = pool.map(_run_eval, [args] * 8)
    assert results == [first] * 8

    transcript = job / "transcript.json"
    original = transcript.read_bytes()
    transcript.write_bytes(b'{"language":"en","language":"id","segments":[]}')
    with pytest.raises(EvaluationError, match="duplicate"):
        _run_eval(args)
    transcript.write_bytes(original)

    outside = tmp_path / "outside.json"
    outside.write_bytes(original)
    transcript.unlink()
    transcript.symlink_to(outside)
    with pytest.raises(EvaluationError, match="regular"):
        _run_eval(args)
    transcript.unlink()
    transcript.write_bytes(original)

    monkeypatch.setattr("ai_clipper.evaluation.MAX_INPUT_BYTES", 8)
    with pytest.raises(EvaluationError, match="at most"):
        _run_eval(args)
    assert MAX_INPUT_BYTES > 8


def test_rejects_tamper_nonfinite_bad_utf8_duplicate_jobs_and_unsafe_output(tmp_path: Path):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs

    job = _job(tmp_path, "job-a")
    artifact = _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])

    feedback_path = job / "analysis" / "candidate-feedback.v1.json"
    _feedback(job, artifact, ["accepted"])
    payload = json.loads(feedback_path.read_text())
    payload["candidate_artifact_analysis"]["sha256"] = "0" * 64
    _json(feedback_path, payload)
    with pytest.raises(EvaluationError, match="feedback"):
        evaluate_jobs(registry, [job], tmp_path / "out")

    feedback_path.unlink()
    transcript = job / "transcript.json"
    transcript.write_text('{"language":"en","segments":[{"start":NaN,"end":1,"text":"x"}]}')
    with pytest.raises(EvaluationError, match="non-standard"):
        evaluate_jobs(registry, [job], tmp_path / "out")
    transcript.write_bytes(b"\xff")
    with pytest.raises(EvaluationError, match="UTF-8"):
        evaluate_jobs(registry, [job], tmp_path / "out")
    _job(tmp_path, "job-a")

    with pytest.raises(EvaluationError, match="duplicate job"):
        evaluate_jobs(registry, [job, job], tmp_path / "out")

    output = tmp_path / "unsafe"
    output.mkdir()
    outside = tmp_path / "existing.json"
    outside.write_text("keep")
    (output / "evaluation.json").symlink_to(outside)
    with pytest.raises(EvaluationError, match="output"):
        evaluate_jobs(registry, [job], output)
    assert outside.read_text() == "keep"


def test_credential_only_registry_changes_do_not_change_report(tmp_path: Path):
    from ai_clipper.evaluation import evaluate_jobs

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    first = evaluate_jobs(registry, [job], tmp_path / "first")
    assert first["registry_hash_basis"] == "credential-stripped-canonical-registry-v1"

    payload = json.loads(registry.read_text(encoding="utf-8"))
    payload["sources"][0]["source_url"] = (
        "https://different-user:different-password@example.test/job-a?"
        "v=0&access_token=rotated&signature=also-rotated"
    )
    _json(registry, payload)
    second = evaluate_jobs(registry, [job], tmp_path / "second")

    assert second == first
    assert (tmp_path / "second" / "evaluation.json").read_bytes() == (
        tmp_path / "first" / "evaluation.json"
    ).read_bytes()


def test_aggregate_macro_and_micro_math_use_their_declared_denominators(tmp_path: Path):
    from ai_clipper.evaluation import evaluate_jobs

    first_job = _job(tmp_path, "job-a")
    second_job = _job(tmp_path, "job-b")
    first = _write_candidates(
        first_job,
        "source.mp4",
        [(0, 0, 30, "first", ("one",), 2, 4, True)],
    )
    second = _write_candidates(
        second_job,
        "source.mp4",
        [
            (0, 0, 10, "second a", ("two",), 4, 2, True),
            (1, 10, 30, "second b", ("three",), 6, 4, False),
            (2, 60, 90, "second c", ("four",), 8, 6, False),
        ],
    )
    _feedback(first_job, first, ["accepted"])
    _feedback(second_job, second, ["accepted", "rejected", "undecided"])

    report = evaluate_jobs(
        _registry(tmp_path, [first_job, second_job]),
        [second_job, first_job],
        tmp_path / "report",
        top_k=2,
    )
    aggregate = report["aggregate"]

    assert aggregate["rights_counts"] == {"training": 1, "evaluation_only": 1}
    assert aggregate["macro"]["candidate_count"] == 2
    assert aggregate["micro"]["candidate_count"] == 4
    assert aggregate["macro"]["candidate_duration_mean"] == 25
    assert aggregate["micro"]["candidate_duration_distribution"]["mean"] == 22.5
    assert aggregate["macro"]["media_coverage"] == pytest.approx(2 / 3)
    assert aggregate["micro"]["media_coverage"] == 0.5
    assert aggregate["macro"]["pairwise_temporal_iou_mean"] == pytest.approx(2 / 3)
    assert aggregate["micro"]["pairwise_temporal_iou_mean"] == 0.5
    assert aggregate["macro"]["v2_covered_by_v1"] == 0.75
    assert aggregate["micro"]["coverage"]["v2_covered_by_v1"] == pytest.approx(2 / 3)
    assert aggregate["macro"]["label_coverage"] == pytest.approx(5 / 6)
    assert aggregate["micro"]["label_coverage"] == 0.75
    assert aggregate["macro"]["acceptance_at_k"] == 0.75
    assert aggregate["micro"]["acceptance_rate"] == pytest.approx(2 / 3)
    assert report["sources"][1]["feedback"]["counts"] == {
        "accepted": 1,
        "rejected": 1,
        "undecided": 1,
    }
    assert report["sources"][1]["feedback"]["acceptance_at_k"] == {
        "k": 2,
        "labeled": 2,
        "accepted": 1,
        "rate": 0.5,
    }


def test_candidate_artifact_rejects_duplicate_nonfinite_oversize_and_symlink(
    tmp_path: Path, monkeypatch
):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    candidate_path = job / "analysis" / "candidates.v2.json"
    original = candidate_path.read_bytes()

    first_key = next(iter(json.loads(original)))
    candidate_path.write_bytes(b"{" + json.dumps(first_key).encode() + b":null," + original[1:])
    with pytest.raises(EvaluationError, match="duplicate"):
        evaluate_jobs(registry, [job], tmp_path / "duplicate")

    payload = json.loads(original)
    payload["candidates"][0]["score"] = float("nan")
    candidate_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(EvaluationError, match="non-standard"):
        evaluate_jobs(registry, [job], tmp_path / "nonfinite")

    candidate_path.unlink()
    outside = tmp_path / "outside-candidates.json"
    outside.write_bytes(original)
    candidate_path.symlink_to(outside)
    with pytest.raises(EvaluationError, match="regular"):
        evaluate_jobs(registry, [job], tmp_path / "symlink")

    candidate_path.unlink()
    candidate_path.write_bytes(original)
    monkeypatch.setattr("ai_clipper.evaluation.MAX_ARTIFACT_BYTES", len(original) - 1)
    with pytest.raises(EvaluationError, match="at most"):
        evaluate_jobs(registry, [job], tmp_path / "oversize")


def test_failed_atomic_replace_preserves_existing_report(tmp_path: Path, monkeypatch):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    evaluate_jobs(registry, [job], output)
    json_before = (output / "evaluation.json").read_bytes()
    markdown_before = (output / "evaluation.md").read_bytes()

    def fail_replace(_source, _target, **_kwargs):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("ai_clipper.evaluation.os.replace", fail_replace)
    with pytest.raises(EvaluationError, match="atomically publish"):
        evaluate_jobs(registry, [job], output)

    assert (output / "evaluation.json").read_bytes() == json_before
    assert (output / "evaluation.md").read_bytes() == markdown_before
    assert list(output.glob(".evaluation.*.tmp")) == []


def test_report_pair_is_one_immutable_generation_with_static_aliases(tmp_path: Path):
    from ai_clipper.evaluation import evaluate_jobs, read_evaluation_report_pair

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    first = evaluate_jobs(registry, [job], output)
    aliases_before = {
        name: os.readlink(output / name) for name in ("evaluation.json", "evaluation.md")
    }
    current_before = os.readlink(output / ".evaluation-current")

    payload, markdown = read_evaluation_report_pair(output)
    assert payload == first
    assert first["report_id"] in markdown
    assert aliases_before == {
        "evaluation.json": ".evaluation-current/evaluation.json",
        "evaluation.md": ".evaluation-current/evaluation.md",
    }
    assert (output / current_before / "evaluation.json").stat().st_mode & 0o777 == 0o600
    assert (output / current_before / "evaluation.md").stat().st_mode & 0o777 == 0o600

    registry_payload = json.loads(registry.read_text())
    registry_payload["sources"][0]["license"] = "proprietary"
    _json(registry, registry_payload)
    second = evaluate_jobs(registry, [job], output)
    assert second["report_id"] != first["report_id"]
    assert os.readlink(output / ".evaluation-current") != current_before
    assert {
        name: os.readlink(output / name) for name in ("evaluation.json", "evaluation.md")
    } == aliases_before
    assert (output / current_before / "evaluation.json").exists()
    assert read_evaluation_report_pair(output)[0] == second


def test_reader_rejects_generation_content_that_does_not_match_report_id(tmp_path: Path):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs, read_evaluation_report_pair

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    evaluate_jobs(registry, [job], output)
    generation = output / os.readlink(output / ".evaluation-current")
    payload = json.loads((generation / "evaluation.json").read_text())
    payload["top_k"] += 1
    _json(generation / "evaluation.json", payload)

    with pytest.raises(EvaluationError, match="generation binding"):
        read_evaluation_report_pair(output)


def test_failure_before_current_pointer_swap_leaves_whole_old_pair(tmp_path: Path, monkeypatch):
    from ai_clipper import evaluation

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    evaluation.evaluate_jobs(registry, [job], output)
    before = evaluation.read_evaluation_report_pair(output)
    current = os.readlink(output / ".evaluation-current")
    original = evaluation._write_generation_file

    def fail_markdown(*args, **kwargs):
        if args[1] == "evaluation.md":
            raise OSError("injected second-stage failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(evaluation, "_write_generation_file", fail_markdown)
    registry_payload = json.loads(registry.read_text())
    registry_payload["sources"][0]["license"] = "changed"
    _json(registry, registry_payload)
    with pytest.raises(evaluation.EvaluationError, match="atomically publish"):
        evaluation.evaluate_jobs(registry, [job], output)
    assert os.readlink(output / ".evaluation-current") == current
    assert evaluation.read_evaluation_report_pair(output) == before


def test_reader_protocol_never_observes_mixed_generation(tmp_path: Path):
    from ai_clipper.evaluation import evaluate_jobs, read_evaluation_report_pair

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    evaluate_jobs(registry, [job], output)
    errors: list[str] = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            payload, markdown = read_evaluation_report_pair(output)
            if payload["report_id"] not in markdown:
                errors.append("mixed")

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for index in range(8):
            value = json.loads(registry.read_text())
            value["sources"][0]["license"] = f"license-{index}"
            _json(registry, value)
            evaluate_jobs(registry, [job], output)
    finally:
        stop.set()
        thread.join(timeout=2)
    assert errors == []


def test_output_walk_rejects_symlink_parent_without_outside_side_effect(tmp_path: Path):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    outside = tmp_path / "outside"
    outside.mkdir()
    parent = tmp_path / "linked"
    parent.symlink_to(outside, target_is_directory=True)
    with pytest.raises(EvaluationError, match="without symlink traversal"):
        evaluate_jobs(registry, [job], parent / "must-not-exist")
    assert not (outside / "must-not-exist").exists()


def test_output_parent_swap_after_open_cannot_redirect_publication(tmp_path: Path, monkeypatch):
    from ai_clipper import evaluation

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    moved = tmp_path / "held-report"
    outside = tmp_path / "outside"
    outside.mkdir()
    original_publish = evaluation._publish

    def swap_then_publish(output_fd, report):
        output.rename(moved)
        output.symlink_to(outside, target_is_directory=True)
        return original_publish(output_fd, report)

    monkeypatch.setattr(evaluation, "_publish", swap_then_publish)
    evaluation.evaluate_jobs(registry, [job], output)

    assert (moved / "evaluation.json").is_symlink()
    assert list(outside.iterdir()) == []


def test_legacy_output_and_pointer_conflicts_are_refused_not_replaced(tmp_path: Path):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    output = tmp_path / "report"
    output.mkdir()
    legacy = output / "evaluation.json"
    legacy.write_text("keep")
    with pytest.raises(EvaluationError, match="conflicting evaluation output path"):
        evaluate_jobs(registry, [job], output)
    assert legacy.read_text() == "keep"


def test_micro_acceptance_at_k_excludes_labels_outside_each_source_top_k(tmp_path: Path):
    from ai_clipper.evaluation import evaluate_jobs

    jobs = [_job(tmp_path, "job-a"), _job(tmp_path, "job-b")]
    artifacts = [
        _write_candidates(
            job,
            "source.mp4",
            [
                (0, 0, 20, "a", ("one",), 8, 8, False),
                (1, 20, 40, "b", ("two",), 7, 7, False),
                (2, 40, 60, "c", ("three",), 6, 6, False),
            ],
        )
        for job in jobs
    ]
    _feedback(jobs[0], artifacts[0], ["accepted", "rejected", "accepted"])
    _feedback(jobs[1], artifacts[1], ["rejected", "accepted", "accepted"])
    report = evaluate_jobs(_registry(tmp_path, jobs), jobs, tmp_path / "out", top_k=2)
    micro = report["aggregate"]["micro"]
    assert micro["acceptance_at_k"] == {
        "k": 2,
        "source_count": 2,
        "candidate_sample_count": 4,
        "labeled": 4,
        "accepted": 2,
        "rate": 0.5,
    }
    assert micro["acceptance_rate"] == pytest.approx(4 / 6)


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("HTTPS://[2001:0DB8::1]:443/a?x=&empty", "https://[2001:db8::1]/a?empty&x="),
        ("https://BÜCHER.example:443/%E2%82%AC", "https://xn--bcher-kva.example/%E2%82%AC"),
    ],
)
def test_url_canonicalization_is_strict_and_ipv6_idna_safe(url: str, expected: str):
    from ai_clipper.evaluation import _sanitize_url

    assert _sanitize_url(url) == expected


@pytest.mark.parametrize(
    "url", ["https://example.test/%", "https://example.test/%GG", "https://example.test/%FF"]
)
def test_url_rejects_malformed_or_non_utf8_percent_encoding(url: str):
    from ai_clipper.evaluation import EvaluationError, _sanitize_url

    with pytest.raises(EvaluationError, match="source_url"):
        _sanitize_url(url)


def test_recursive_unicode_scalar_validation_and_cli_sanitization(tmp_path: Path, capsys):
    from ai_clipper.evaluation import EvaluationError, evaluate_jobs, main

    job = _job(tmp_path, "job-a")
    _write_candidates(job, "source.mp4", [(0, 0, 30, "secret", ("alpha",), 6, 5, False)])
    registry = _registry(tmp_path, [job])
    value = json.loads(registry.read_text())
    value["sources"][0]["license"] = "bad\ud800value"
    registry.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(EvaluationError, match="Unicode scalar"):
        evaluate_jobs(registry, [job], tmp_path / "out")
    assert (
        main(
            ["--registry", str(registry), "--job", str(job), "--output-dir", str(tmp_path / "cli")]
        )
        == 2
    )
    assert "bad" not in capsys.readouterr().err
