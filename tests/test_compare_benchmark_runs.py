"""scripts/eval/compare_benchmark_runs.py: the selection before and after a change (08 §8)."""

import importlib.util
import json
from pathlib import Path

from ai_clipper.models import Transcription, TranscriptSegment
from ai_clipper.transcript_io import write_transcript_json

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "compare_benchmark_runs", ROOT / "scripts" / "eval" / "compare_benchmark_runs.py"
)
compare_runs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compare_runs)

LINES = [
    "Kenapa lu akhirnya berhenti jadi pesulap jalanan di Jakarta?",
    "Jujur gua pernah ketangkap satpol waktu main kartu di Monas.",
    "Ternyata yang nangkep gua itu penonton setia gua sendiri.",
    "Gua bukan penipu, tapi tetap aja rasanya malu banget waktu itu.",
    "Dia bilang ke gua jangan pernah balik lagi ke trotoar itu.",
    "Akhirnya gua malah diundang tampil di acara kantornya.",
]


def test_differences_ignore_timings_and_name_each_change():
    before = {"runs": [{"elapsed_seconds": 1.0, "selections": [{"rank": 1, "start": 2.0}]}]}
    same = {"runs": [{"elapsed_seconds": 9.0, "selections": [{"rank": 1, "start": 2.0}]}]}
    after = {"runs": [{"selections": [{"rank": 1, "start": 2.5}, {"rank": 2}]}], "extra": 1}

    assert compare_runs.differences(before, same) == []
    assert compare_runs.differences(before, after) == [
        "$.extra: added",
        "$.runs[0].selections: 1 items before, 2 after",
        "$.runs[0].selections[0].start: 2.0 -> 2.5",
    ]
    assert compare_runs.differences({"score": 1}, {"score": 1.0}) == ["$.score: 1 -> 1.0"]


def test_dump_then_compare_one_tree_is_identical(tmp_path, capsys):
    segments = [
        TranscriptSegment(start=index * 7.5, end=index * 7.5 + 7.0, text=LINES[index % len(LINES)])
        for index in range(60)
    ]
    transcript = tmp_path / "transcript.json"
    write_transcript_json(transcript, Transcription("id", segments))
    gold = ROOT / "docs" / "evaluation" / "gold" / "Ive926sC6mc.gold.json"
    outputs = []
    for name in ("before.json", "after.json"):
        out = tmp_path / name
        code = compare_runs.main(
            ["dump", "--gold", str(gold), "--transcript", str(transcript), "--k", "3", "--out", str(out)]
        )
        assert code == 0
        outputs.append(out)

    payload = json.loads(outputs[0].read_text("utf-8"))
    [episode] = payload["episodes"]
    assert episode["clips"] and {"rank", "start", "end", "score", "scores", "reasons"} <= set(
        episode["clips"][0]
    )
    assert compare_runs.main(["compare", *map(str, outputs)]) == 0
    assert capsys.readouterr().out.strip().endswith("identical")

    changed = json.loads(outputs[1].read_text("utf-8"))
    changed["episodes"][0]["clips"][0]["score"] += 0.01
    outputs[1].write_text(json.dumps(changed), "utf-8")
    assert compare_runs.main(["compare", *map(str, outputs)]) == 1
    assert compare_runs.main(["compare", str(tmp_path / "missing.json"), str(outputs[0])]) == 2
