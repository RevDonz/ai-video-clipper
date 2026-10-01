"""Tests for the T3.3 music gate tool (``scripts/parity/audio_gates.py``; plan §10.2 duck, G3,
G3b, G-CLICK; §10.1 P-AUD).

The measurements are checked on synthetic signals whose answer is known: a music stem shaped by
the real ``envelope.music_envelope`` must pass the duck gate and a wrong depth must fail it; a
hard cut must show up at its join; the music asset lands in the job asset store in the pinned
document form (docs/editor/CONTRACTS.md §5.9); the silent twin keeps the video stream and
silences the audio; the documents are the ones the Musik panel builds and the validator accepts.
"""

from __future__ import annotations

import array
import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import audio_gates
from support.edit_v2_fixtures import DOC_FIXTURES_DIR, etag

from ai_clipper.edit_v2 import envelope
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import validate_doc

RATE = 48_000
FPS = tm.Fps(30, 1)


def _stereo(values: list[float]) -> array.array:
    out = array.array("h")
    for value in values:
        sample = max(-32768, min(32767, round(value * 32767)))
        out.extend((sample, sample))
    return out


def _item(duck_on: bool, depth_cdb: int = 1000) -> dict:
    return {"payload": {"asset": "sha256:" + "0" * 64, "src_in_smp": 0, "loop": True, "gain_cdb": 0,
                        "fade_in_f": 0, "fade_out_f": 0,
                        "duck": {"on": duck_on, "depth_cdb": depth_cdb, "attack_ms": 30,
                                 "release_ms": 400, "hold_ms": 250, "detector": "words"}}}


def _stems(spans, total, depth_cdb=1000):
    tone = [0.25 * math.sin(2 * math.pi * 110 * n / RATE) for n in range(total)]
    ducked_env = array.array("f")
    ducked_env.frombytes(envelope.expand_f32(
        envelope.music_envelope(spans, _item(True, depth_cdb), total, FPS), total))
    flat_env = array.array("f")
    flat_env.frombytes(envelope.expand_f32(
        envelope.music_envelope(spans, _item(False), total, FPS), total))
    return (_stereo([t * g for t, g in zip(tone, ducked_env)]),
            _stereo([t * g for t, g in zip(tone, flat_env)]))


SPANS = ((48_000, 72_000), (82_000, 96_000), (200_000, 260_000))  # the first two merge (gap < hold)
TOTAL = 360_000
DUCK = {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400, "hold_ms": 250}


def test_the_duck_measurement_passes_an_exact_envelope() -> None:
    ducked, unducked = _stems(SPANS, TOTAL)
    report = audio_gates.duck_rows(ducked, unducked, SPANS, DUCK, TOTAL)
    assert report["failures"] == 0
    assert [row["span"] for row in report["spans"]] == [[48_000, 96_000], [200_000, 260_000]]
    assert all(row["max_deviation_db"] < 0.05 for row in report["spans"])
    assert report["recovery_checks"] == 2
    assert all(abs(row["recovery_db"]) < 0.05 for row in report["spans"])
    assert report["windows"] > 100


def test_the_duck_measurement_fails_a_wrong_depth() -> None:
    ducked, unducked = _stems(SPANS, TOTAL, depth_cdb=1100)
    report = audio_gates.duck_rows(ducked, unducked, SPANS, DUCK, TOTAL)
    assert report["failures"] == 2
    assert all(0.9 < row["max_deviation_db"] < 1.1 for row in report["spans"])


def test_the_duck_measurement_stops_at_the_plans_last_sample() -> None:
    # A span that runs to the clip's end, and a decoded export 512 samples longer than the plan
    # (the AAC padding G2 allows): the padding is not music and must not be measured.
    spans = ((300_000, TOTAL),)
    ducked, unducked = _stems(spans, TOTAL)
    tail = _stereo([0.001] * 512)
    report = audio_gates.duck_rows(ducked + tail, unducked + tail, spans, DUCK,
                                   TOTAL)
    assert report["failures"] == 0
    assert report["spans"][0]["windows"] == (TOTAL - 300_000) // audio_gates.DUCK_WINDOW


def test_join_steps_find_a_hard_cut_and_pass_a_faded_join() -> None:
    smooth = _stereo([0.3 * math.sin(2 * math.pi * 55 * n / RATE) for n in range(9600)])
    steps = audio_gates.join_steps_dbfs(smooth, [4800])
    assert steps[0] < -40
    jumped = array.array("h", smooth)
    for n in range(4800, 9600):
        jumped[2 * n] = jumped[2 * n + 1] = 12000
    assert audio_gates.join_steps_dbfs(jumped, [4800])[0] > -40


def test_the_g3_and_g3b_rules() -> None:
    assert audio_gates.g3_pass(export_i=-14.4, export_tp=-2.0, target=-14.0, clamped=None)
    assert not audio_gates.g3_pass(export_i=-15.2, export_tp=-2.0, target=-14.0, clamped=None)
    assert not audio_gates.g3_pass(export_i=-14.0, export_tp=-0.9, target=-14.0, clamped=None)
    assert audio_gates.g3_pass(export_i=-16.6, export_tp=-1.2, target=-14.0, clamped=-16.3)
    assert not audio_gates.g3_pass(export_i=-17.0, export_tp=-1.2, target=-14.0, clamped=-16.3)
    assert audio_gates.g3b_pass(-1.0) and not audio_gates.g3b_pass(-0.99)


def test_the_tools_own_renders_wait_out_a_busy_machine() -> None:
    from ai_clipper.edit_v2.compile_ffmpeg import FfmpegJob

    job = FfmpegJob(argv=("-i", "@in:0", "@out"), filter_script="anull", inputs=(), sidecars={},
                    expected={"mode": "reference", "samples": 480})
    patient = audio_gates.patient(job)
    # only the stall window changes (the production default is 20 s of no progress)
    assert patient.expected == {"mode": "reference", "samples": 480,
                                "stall_s": audio_gates.REFERENCE_STALL_S}
    assert audio_gates.REFERENCE_STALL_S >= 120
    assert (patient.argv, patient.filter_script, patient.inputs) == (job.argv, "anull", ())
    assert "stall_s" not in job.expected


def test_each_gate_writes_its_evidence_when_it_ends_and_a_crash_fails_only_that_gate(
        tmp_path, monkeypatch, capsys) -> None:
    from ai_clipper.edit_v2 import errors

    order = []

    class Busy:
        def __init__(self, jobs_root, work) -> None:
            pass

        def click(self):
            order.append("click")
            return {"gate": "G-CLICK", "pass": True}

        def duck(self):
            order.append("duck")
            raise errors.RenderFailed("render_stalled")

        def loudness(self):
            order.append("loudness")
            return {"gate": "G3", "pass": True}, {"gate": "G3b", "pass": False}

    monkeypatch.setattr(audio_gates, "Exports", Busy)
    evidence = tmp_path / "evidence"
    code = audio_gates.main(["exports", "--jobs-root", str(tmp_path), "--work", str(tmp_path),
                             "--evidence", str(evidence)])
    assert code == 1 and order == ["click", "duck", "loudness"]
    written = sorted(path.name for path in evidence.iterdir())
    assert written == [f"{audio_gates.TASK}-{gate}.json" for gate in ("G-CLICK", "G3", "G3b")]
    out = capsys.readouterr().out
    assert "G-CLICK: pass" in out and "G3b: FAIL" in out
    assert "duck: FAIL (RenderFailed: render_stalled)" in out


def test_every_gate_names_only_roles_that_both_media_sets_fill() -> None:
    used = {*audio_gates.TWIN_ROLES, *audio_gates.CLICK_ROLES, audio_gates.PF_AUDIO_ROLE,
            *(role for role, _kind, _settings in audio_gates.LOUDNESS_PLANS),
            *(role for role, _kind, _settings in audio_gates.P_AUD_VARIANTS)}
    assert used == set(audio_gates.P3_ROLES) == set(audio_gates.SYNTHETIC_ROLES)
    for roles in (audio_gates.P3_ROLES, audio_gates.SYNTHETIC_ROLES):
        assert all(isinstance(role["clip"], str) and role["clip"] for role in roles.values())


def test_the_synthetic_roles_come_from_the_fixture_index(tmp_path) -> None:
    index = {"jobs": {name: {"id": f"id-{name}", "dir": f"jobs/id-{name}"}
                      for name in ("main", "fps25", "fps60", "vfr", "old", "v1")}}
    roles = audio_gates.synthetic_roles(index)
    assert {role: (entry["job"], entry["rank"]) for role, entry in roles.items()} == {
        role: (f"id-{audio_gates.SYNTHETIC_ROLES[role]['fixture']}",
               audio_gates.SYNTHETIC_ROLES[role]["rank"]) for role in audio_gates.SYNTHETIC_ROLES}
    assert roles["cold_open"]["job"] == "id-main" and roles["fps60"]["job"] == "id-fps60"
    with pytest.raises(SystemExit, match="vfr"):
        audio_gates.synthetic_roles({"jobs": {"main": {"id": "a"}, "fps25": {"id": "b"},
                                              "fps60": {"id": "c"}}})


def test_the_gates_read_the_roles_setup_wrote(tmp_path) -> None:
    # no roles file: the owner's P3 copies (the default before synthetic media existed)
    assert audio_gates.read_roles(tmp_path) == audio_gates.p3_roles()
    assert audio_gates.read_roles(tmp_path)["cold_open"]["job"] == audio_gates.JOBS[0]
    roles = audio_gates.synthetic_roles(
        {"jobs": {name: {"id": f"id-{name}"} for name in ("main", "fps25", "fps60", "vfr")}})
    audio_gates.write_roles(tmp_path, roles, media="synthetic")
    assert audio_gates.read_roles(tmp_path) == roles
    assert audio_gates.media_of(tmp_path) == "synthetic"
    assert audio_gates.media_of(tmp_path / "elsewhere") == "p3"
    gates = audio_gates.Exports(tmp_path, tmp_path / "work")
    assert gates.roles == roles and gates.media == "synthetic"


def test_evidence_is_one_file_per_gate_and_a_label_keeps_every_run(tmp_path) -> None:
    plain = audio_gates.write_evidence(tmp_path, "G3", {"gate": "G3", "pass_": True,
                                                        "path": tmp_path / "x.mp4"})
    body = json.loads(plain.read_text())
    assert plain.name == f"{audio_gates.TASK}-G3.json"
    assert body["pass"] is True and body["path"] == "x.mp4" and "environment" in body

    # PF-AUDIO is timed, so each load it is measured at is kept under its own label
    audio_gates.write_evidence(tmp_path, "PF-AUDIO", {"gate": "PF-AUDIO", "p95": 1.5}, "busy")
    path = audio_gates.write_evidence(tmp_path, "PF-AUDIO", {"gate": "PF-AUDIO", "p95": 0.9}, "idle")
    runs = json.loads(path.read_text())
    assert (runs["gate"], runs["task"]) == ("PF-AUDIO", audio_gates.TASK)
    assert {label: run["p95"] for label, run in runs["runs"].items()} == {"busy": 1.5, "idle": 0.9}
    assert all("environment" in run for run in runs["runs"].values())
    audio_gates.write_evidence(tmp_path, "PF-AUDIO", {"gate": "PF-AUDIO", "p95": 0.8}, "idle")
    assert json.loads(path.read_text())["runs"]["idle"]["p95"] == 0.8  # a label is replaced

    path.write_text("not json")  # a damaged file starts over instead of failing the run
    audio_gates.write_evidence(tmp_path, "PF-AUDIO", {"gate": "PF-AUDIO", "p95": 0.7}, "again")
    assert list(json.loads(path.read_text())["runs"]) == ["again"]


@pytest.fixture(scope="module")
def tone_asset(tmp_path_factory) -> tuple[Path, str, dict]:
    job = tmp_path_factory.mktemp("job")
    path = audio_gates.make_music(job / "tone.m4a", "tone", seconds=3)
    asset, meta = audio_gates.store_asset(job, path)
    return job, asset, meta


def test_music_is_stored_in_the_document_form_of_the_asset_store(tone_asset) -> None:
    job, asset, meta = tone_asset
    hexdigest = asset.removeprefix("sha256:")
    stored = job / "analysis" / "assets"
    assert (stored / f"{hexdigest}.m4a").is_file()
    assert json.loads((stored / f"{hexdigest}.json").read_text()) == meta
    assert set(meta) == {"kind", "mime", "duration_ms", "lufs_c"}
    assert (meta["kind"], meta["mime"]) == ("audio", "audio/mp4")
    assert abs(meta["duration_ms"] - 3000) <= 50
    assert isinstance(meta["lufs_c"], int) and -4000 < meta["lufs_c"] < -900
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                            "stream=codec_name,sample_rate,channels", "-of", "csv=p=0",
                            str(stored / f"{hexdigest}.m4a")], capture_output=True, text=True,
                           check=True).stdout.strip()
    assert probe == "aac,48000,2"


def test_the_loud_track_is_loud(tmp_path) -> None:
    path = audio_gates.make_music(tmp_path / "loud.m4a", "loud", seconds=3)
    measured = audio_gates.measure_file(path)
    assert measured.i_clufs > -1000, "louder than −10 LUFS"
    assert measured.tp_cdb > -100, "true peak above −1 dBTP before any protection"


def test_the_silent_twin_keeps_the_video_and_silences_the_audio(tmp_path) -> None:
    source = tmp_path / "source.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc2=s=160x90:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-threads", "2",
                    "-shortest", str(source)], check=True)
    twin = audio_gates.silent_twin(source, tmp_path / "twin.mp4")

    def video_md5(path: Path) -> str:
        return subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-map",
                               "0:v:0", "-c", "copy", "-f", "md5", "-"], capture_output=True,
                              text=True, check=True).stdout.strip()

    assert video_md5(twin) == video_md5(source)
    samples = audio_gates.pcm_of(twin)
    assert len(samples) >= 2 * 48_000 * 19 // 10
    assert max(abs(v) for v in samples) == 0


def test_music_documents_are_the_panels_and_validate(tone_asset) -> None:
    contexts = DOC_FIXTURES_DIR / "contexts"
    seed = json.loads((contexts / "c30.seed.json").read_bytes())
    words = json.loads((contexts / "c30.words.json").read_bytes())
    _job, asset, meta = tone_asset
    doc = audio_gates.music_doc(seed, etag(seed), asset, meta, preset="kuat")
    assert doc["revision"] == 1 and doc["parent_sha256"] == etag(seed)
    payload = doc["tracks"][-1]["items"][0]["payload"]
    assert payload["gain_cdb"] == max(-4800, min(600, -2600 - meta["lufs_c"]))
    assert (payload["loop"], payload["fade_in_f"], payload["fade_out_f"]) == (True, 15, 30)
    assert payload["duck"] == {"on": True, "depth_cdb": 1600, "attack_ms": 30, "release_ms": 400,
                               "hold_ms": 250, "detector": "words"}
    assert doc["assets"][asset] == meta
    result = validate_doc(doc, words=words, assets={asset: meta}, seed=seed)
    assert result.errors == ()
    loud = audio_gates.music_doc(seed, etag(seed), asset, meta, gain_cdb=600, duck_on=False,
                                 master="normalize", source_gain_cdb=1200)
    assert loud["audio"] == {"source": {"gain_cdb": 1200},
                             "master": {"mode": "normalize", "target_clufs": -1400, "tp_cdb": -100}}
    assert validate_doc(loud, words=words, assets={asset: meta}, seed=seed).errors == ()
