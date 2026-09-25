"""Revision 0 (the seed), ``prepare_legacy_job`` and the synthetic V3 job (plan §3.5, §4.2, §11.1).

``build_seed`` follows every row of the plan §3.5 table; the T1.0 document-fixture seeds were
built from the same table independently, so the three contexts double as golden vectors.
``prepare_legacy_job`` persists ``source.json``, the words and peaks artifacts, the camera plan
(face-track only) and ``seed.json`` once for every openable clip of a job rendered before
Essentials, and names the reason for every clip it cannot open. The job fixtures come from
``scripts/editor_fixture/make_job.py`` (generated on the fly, never committed).
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import sys
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper.audio_timeline import read_audio_timeline
from ai_clipper.edit_v2 import COMPILER_ID, PACK_DEFAULT_OVERRIDES, camera
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.clip_id import clip_id, ms_from_seconds
from ai_clipper.edit_v2.seed import (
    DEFAULT_RENDER_SIZE,
    HOOK_DURATION_DEFAULT_S,
    SeedError,
    build_seed,
    encode_seed,
    inspect_job,
    output_fps,
    prepare_legacy_job,
    seed_window_ms,
)
from ai_clipper.edit_v2.source_info import SOURCE_INFO_RELATIVE_PATH, file_sha256
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.pipeline import DEFAULT_HOOK_DURATION
from ai_clipper.selection_types import SCORE_DIMENSIONS, SelectedClip
from ai_clipper.selection_v3 import read_selection_artifact
from ai_clipper.sentences import build_sentence_units
from ai_clipper.sound_events import read_sound_events
from ai_clipper.transcript_io import read_transcript_json
from ai_clipper.transcript_quality import TranscriptQuality, assess_transcript

ROOT = Path(__file__).resolve().parents[1]
MAKE_JOB = ROOT / "scripts" / "editor_fixture" / "make_job.py"
LAYOUT_OF = {"fit_blur": "fit-blur", "camera": "face-track", "fill_center": "center-crop"}
UUID_HEX = "0123456789abcdef-"


def _load_make_job():
    name = "editor_fixture_make_job"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, MAKE_JOB)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _clip(*, rank=1, start=20.0, end=50.0, cold_open=None, hook_unit_id="S0007",
          hook_text="Kenapa dia ditahan security?", source="llm"):
    return SelectedClip(
        rank=rank, start=start, end=end, cold_open=cold_open, unit_ids=("S0005", "S0012"),
        hook_unit_id=hook_unit_id, title="Judul klip", hook_text=hook_text, description="",
        hashtags=("#film",), archetype="story_twist", score=7.5,
        scores={name: 7.0 for name in SCORE_DIMENSIONS}, reasons=("alasan",), source=source,
        text="teks klip",
    )


def _source_info(*, fps=(30000, 1001), vfr=False, duration_ms=180_000, w=1280, h=720):
    return {"content_sha256": "a" * 64,
            "probe": {"w": w, "h": h, "fps_native": list(fps), "vfr": vfr,
                      "duration_ms": duration_ms, "has_audio": True}}


def _job(**options):
    base = {"renderMode": "fit-blur", "captionStyle": "karaoke", "coldOpen": True,
            "hookOverlay": True, "selectionMode": "v3"}
    base.update(options)
    return {"id": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "options": base, "seedAtMs": 1_790_000_000_000}


def _seed(clip=None, job=None, source_info=None, camera_sha=None):
    return build_seed(clip=clip or _clip(), job=job or _job(),
                      source_info=source_info or _source_info(), words_sha="b" * 64,
                      words_count=321, camera_sha=camera_sha, selection_sha="c" * 64)


def _no_floats(value):
    if isinstance(value, float):
        return False
    if isinstance(value, dict):
        return all(_no_floats(item) for item in value.values())
    if isinstance(value, list):
        return all(_no_floats(item) for item in value)
    return True


# --- rules ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("native", "vfr", "expected"),
    [
        ((30000, 1001), False, (30000, 1001)),
        ((25, 1), False, (25, 1)),
        ((24, 1), False, (24, 1)),
        ((24000, 1001), False, (24000, 1001)),
        ((30, 1), False, (30, 1)),
        ((50, 1), False, (25, 1)),
        ((60, 1), False, (30, 1)),
        ((60000, 1001), False, (30000, 1001)),
        ((2997, 100), False, (30000, 1001)),  # a container's rounded 29.97 is 30000/1001
        ((23976, 1000), False, (24000, 1001)),
        ((48, 1), False, (30, 1)),
        ((15, 1), False, (30, 1)),
        ((120, 1), False, (30, 1)),
        ((30000, 1001), True, (30, 1)),
        ((25, 1), True, (30, 1)),
    ],
)
def test_output_fps_rule(native, vfr, expected):
    assert output_fps({"fps_native": list(native), "vfr": vfr}) == Fps(*expected)


def test_window_is_the_clip_plus_sixty_seconds_clamped_to_the_source():
    assert seed_window_ms(100_000, 130_000, None, 400_000) == (40_000, 190_000)
    assert seed_window_ms(20_000, 50_000, None, 400_000) == (0, 110_000)
    assert seed_window_ms(100_000, 170_000, None, 200_000) == (40_000, 200_000)
    assert seed_window_ms(100_000, 130_000, (150_000, 154_000), 400_000) == (40_000, 214_000)
    assert seed_window_ms(100_000, 130_000, (70_000, 74_000), 400_000) == (10_000, 190_000)


def test_hook_default_matches_the_pipeline():
    assert HOOK_DURATION_DEFAULT_S == DEFAULT_HOOK_DURATION
    assert DEFAULT_RENDER_SIZE == (720, 1280)


# --- build_seed ----------------------------------------------------------------------------------


@pytest.mark.parametrize("context_id", fixtures.CONTEXT_IDS)
def test_build_seed_reproduces_the_t1_0_fixture_seeds(context_id, edit_v2_doc_contexts):
    spec = fixtures.SPECS[context_id]
    expected = edit_v2_doc_contexts[context_id].seed
    base = expected["base"]
    cold = spec.cold_open_ms
    clip = _clip(
        rank=spec.rank, start=spec.start_ms / 1000, end=spec.end_ms / 1000,
        cold_open=None if cold is None else (cold[0] / 1000, cold[1] / 1000),
        hook_unit_id=base["origin"]["hook_unit_id"], hook_text=spec.hook_text or "Hook",
        source=spec.selection_source,
    )
    job = {
        "id": spec.job_id,
        "options": {"renderMode": LAYOUT_OF[spec.layout], "captionStyle": spec.pack,
                    "coldOpen": cold is not None, "hookOverlay": spec.hook_text is not None,
                    "selectionMode": "v3"},
        "hookDuration": spec.hook_duration_s,
        "renderSize": list(spec.output),
        "seedAtMs": fixtures.CREATED_AT_MS,
    }
    source_info = {"content_sha256": spec.source_sha,
                   "probe": {"w": spec.source_w, "h": spec.source_h,
                             "fps_native": list(spec.fps_native), "vfr": False,
                             "duration_ms": spec.duration_ms, "has_audio": True}}
    built = build_seed(clip=clip, job=job, source_info=source_info,
                       words_sha=base["words"]["sha256"], words_count=base["words"]["count"],
                       camera_sha=base["camera"]["sha256"],
                       selection_sha=base["origin"]["selection_artifact_sha256"])
    assert built == expected
    assert encode_seed(built) == fixtures.canonical_bytes(expected)


def test_seed_rows_of_the_plan_table():
    clip = _clip(start=20.0, end=50.0, cold_open=(40.5, 43.25))
    seed = _seed(clip)
    fps = Fps(30000, 1001)
    assert seed["schema"] == "clip-edit-v2" and seed["schema_minor"] == 0
    assert seed["revision"] == 0 and seed["parent_sha256"] is None
    assert seed["clip_id"] == clip_id("a" * 64, 20_000, 50_000, (40_500, 43_250))
    assert seed["main"] == {
        "segments": [
            {"id": "seg_co", "role": "cold_open", "in_sf": tm.sf_floor(40_500, fps),
             "out_sf": tm.sf_ceil(43_250, fps)},
            {"id": "seg_b1", "role": "body", "in_sf": tm.sf_floor(20_000, fps),
             "out_sf": tm.sf_ceil(50_000, fps)},
        ],
        "removals": [],
        "joins": [{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}],
        "cut_fade_ms": 8,
    }
    assert seed["captions"] == {"enabled": True, "pack": {"id": "karaoke", "v": 1},
                                "overrides": dict(PACK_DEFAULT_OVERRIDES["karaoke"]),
                                "word_edits": {}}
    assert seed["layout"] == {"default": {"mode": "fit_blur", "no_face": "center"}}
    assert seed["output"] == {"w": 720, "h": 1280, "fps": [30000, 1001], "sample_rate": 48000,
                              "channels": 2}
    assert seed["audio"] == {"source": {"gain_cdb": 0},
                             "master": {"mode": "off", "target_clufs": -1400, "tp_cdb": -100}}
    assert seed["assets"] == {}
    (track,) = seed["tracks"]
    assert track["id"] == "tr_hook" and track["kind"] == "hook"
    (item,) = track["items"]
    assert item == {"id": "it_hook", "type": "hook", "start": {"at": "out", "f": 0},
                    "dur_f": 120, "transform": {"x_e5": 50000, "y_e5": 13000},
                    "payload": {"text": "Kenapa dia ditahan security?",
                                "design": {"id": "legacy-bar", "v": 1}},
                    "origin": "seed"}
    base = seed["base"]
    assert base["job_id"] == "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"
    assert base["source"] == {"content_sha256": "a" * 64, "w": 1280, "h": 720,
                              "fps_native": [30000, 1001], "vfr": False, "duration_ms": 180_000,
                              "has_audio": True}
    assert base["origin"] == {"kind": "v3_clip", "selection_artifact_sha256": "c" * 64,
                              "selection_version": "selection-v3.0", "rank_at_seed": 1,
                              "hook_unit_id": "S0007", "selection_source": "llm"}
    assert base["window_ms"] == [0, 110_000]
    assert base["words"] == {"sha256": "b" * 64, "count": 321}
    assert base["camera"] == {"sha256": None}
    assert base["engine"] == {"compiler": COMPILER_ID, "render_semantics": 1}
    assert seed["audit"] == {"created_at_ms": 1_790_000_000_000,
                             "updated_at_ms": 1_790_000_000_000,
                             "editor": "pipeline/edit-v2/1", "last_command": "Seed"}
    nulled = copy.deepcopy(seed)
    nulled["base"]["seed_sha256"] = None
    assert base["seed_sha256"] == hashlib.sha256(fixtures.canonical_bytes(nulled)).hexdigest()
    assert _no_floats(seed)


def test_seed_options_from_the_job():
    clip = _clip(cold_open=(40.5, 43.25))
    no_extras = _seed(clip, _job(coldOpen=False, hookOverlay=False, captionStyle="classic",
                                 renderMode="center-crop"))
    assert [segment["role"] for segment in no_extras["main"]["segments"]] == ["body"]
    assert no_extras["main"]["joins"] == []
    assert no_extras["clip_id"] == clip_id("a" * 64, 20_000, 50_000, None)
    assert no_extras["tracks"] == []
    assert no_extras["captions"]["pack"] == {"id": "classic", "v": 1}
    assert no_extras["layout"]["default"]["mode"] == "fill_center"
    face = _seed(clip, _job(renderMode="face-track"), camera_sha="d" * 64)
    assert face["layout"]["default"]["mode"] == "camera"
    assert face["base"]["camera"] == {"sha256": "d" * 64}
    with pytest.raises(SeedError):
        _seed(clip, _job(renderMode="face-track"))
    with pytest.raises(SeedError):
        _seed(clip, _job(), camera_sha="d" * 64)


def test_seed_prepare_marks_the_legacy_engine():
    job = _job()
    job["seedBy"] = "prepare"
    seed = _seed(job=job)
    assert seed["base"]["engine"]["compiler"] == "legacy"
    assert seed["audit"]["editor"] == "prepare/edit-v2/1"


def test_seed_output_size_hook_duration_and_fps():
    job = _job()
    job.update(renderSize=[1080, 1920], hookDuration=2.5)
    seed = _seed(job=job, source_info=_source_info(fps=(60, 1)))
    assert (seed["output"]["w"], seed["output"]["h"]) == (1080, 1920)
    assert seed["output"]["fps"] == [30, 1]
    assert seed["tracks"][0]["items"][0]["dur_f"] == 75
    vfr = _seed(source_info=_source_info(vfr=True))
    assert vfr["output"]["fps"] == [30, 1]
    assert vfr["main"]["segments"][-1]["in_sf"] == tm.sf_floor(20_000, Fps(30, 1))
    with pytest.raises(SeedError):
        bad = _job()
        bad["renderSize"] = [640, 360]
        _seed(job=bad)


def test_hook_text_is_normalised_for_the_document():
    seed = _seed(_clip(hook_text="  Dia\tditahan\nsecurity  "))
    assert seed["tracks"][0]["items"][0]["payload"]["text"] == "Dia ditahan security"
    decomposed = _seed(_clip(hook_text="Cafe" + chr(0x301) + " dong"))  # e + combining acute
    assert decomposed["tracks"][0]["items"][0]["payload"]["text"] == "Caf" + chr(0xE9) + " dong"


def test_an_overlong_cold_open_is_clamped_to_eight_seconds():
    fps = Fps(30000, 1001)
    seed = _seed(_clip(start=20.0, end=50.0, cold_open=(40.001, 48.001)))
    co = seed["main"]["segments"][0]
    assert co["in_sf"] == tm.sf_floor(40_001, fps)
    assert co["out_sf"] - co["in_sf"] == 8 * 30000 // 1001  # ⌊8·F⌋ = 239 frames
    assert seed["clip_id"] == clip_id("a" * 64, 20_000, 50_000, (40_001, 48_001))


def test_a_cold_open_that_only_repeats_the_opening_is_dropped():
    seed = _seed(_clip(start=20.0, end=50.0, cold_open=(20.5, 24.0)))
    assert [segment["role"] for segment in seed["main"]["segments"]] == ["body"]
    assert seed["clip_id"] == clip_id("a" * 64, 20_000, 50_000, None)


def test_a_body_outside_the_duration_limits_is_refused():
    with pytest.raises(SeedError):
        _seed(_clip(start=20.0, end=22.5))
    with pytest.raises(SeedError):
        _seed(_clip(start=20.0, end=330.0), source_info=_source_info(duration_ms=400_000))
    with pytest.raises(SeedError):
        _seed(_clip(start=20.0, end=50.0), source_info=_source_info(duration_ms=40_000))


# --- the synthetic job ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def make_job():
    return _load_make_job()


@pytest.fixture(scope="module")
def synthetic(tmp_path_factory, make_job, edit_v2_ffmpeg):
    root = tmp_path_factory.mktemp("editor_fixture")
    index = make_job.build(root, size=(256, 144), only=("main", "old", "stranded", "v1"))
    return root, index


def _job_dir(synthetic, name):
    root, index = synthetic
    return root / index["jobs"][name]["dir"]


def _copy_job(synthetic, name, tmp_path):
    target = tmp_path / "jobs" / f"{name}-copy"
    shutil.copytree(_job_dir(synthetic, name), target, symlinks=True)
    return target


def _tree(path):
    return sorted(
        (str(item.relative_to(path)), item.stat().st_ino, item.stat().st_mtime_ns)
        for item in path.rglob("*")
    )


def test_the_synthetic_transcript_is_deterministic(make_job):
    first, second = make_job.script(), make_job.script()
    assert first.transcription == second.transcription
    assert first.labels == second.labels
    assert first.bursts == second.bursts


def test_the_synthetic_job_loads_with_the_production_readers(synthetic):
    _root, index = synthetic
    job_dir = _job_dir(synthetic, "main")
    transcription = read_transcript_json(job_dir / "output" / "transcript.json")
    selection = read_selection_artifact(job_dir / "analysis" / "selection.v3.json")
    assert len(selection.clips) == 3
    assert sum(clip.cold_open is not None for clip in selection.clips) == 1
    timeline = read_audio_timeline(job_dir / "analysis" / "audio-timeline.json")
    assert timeline.silences and timeline.scene_cuts
    events, _source = read_sound_events(job_dir / "analysis" / "sound-events.json")
    assert any(event.kind == "laughter" and event.label == "tertawa" for event in events)
    quality = TranscriptQuality.from_dict(
        json.loads((job_dir / "analysis" / "transcript-quality.json").read_text())
    )
    assert quality.has_word_timestamps and not quality.suspect_segment_indices
    job = json.loads((job_dir / "job.json").read_text())
    assert job["id"] == index["jobs"]["main"]["id"] == job_dir.name
    assert job["status"] == "completed" and len(job["clips"]) == 3
    assert job["options"] == {"renderMode": "fit-blur", "limit": 3, "minDuration": 20,
                              "maxDuration": 60, "selectionMode": "v3", "llmMode": "auto",
                              "coldOpen": True, "hookOverlay": True, "captionStyle": "karaoke"}
    assert Path(job["sourcePath"]).is_file()
    manifest = json.loads((job_dir / "output" / "manifest.json").read_text())
    assert manifest["status"] == "completed" and len(manifest["clips"]) == 3
    assert not list((job_dir / "output").glob("*.mp4"))  # no renders
    units = build_sentence_units(
        transcription.segments, quality=assess_transcript(transcription.segments, language="id")
    )
    unit_ids = {unit.unit_id for unit in units}
    for clip in selection.clips:
        assert set(clip.unit_ids) <= unit_ids and clip.hook_unit_id in unit_ids
        assert 20.0 <= clip.end - clip.start <= 60.0
        if clip.cold_open is not None:
            assert 0.5 <= clip.cold_open[1] - clip.cold_open[0] <= 8.0
            assert clip.cold_open[0] >= clip.start + 5.0
    assert selection.clips[-1].end <= index["duration_ms"] / 1000


def test_the_synthetic_transcript_carries_every_labelled_case(synthetic, make_job):
    job_dir = _job_dir(synthetic, "main")
    transcription = read_transcript_json(job_dir / "output" / "transcript.json")
    flat = []
    for segment in transcription.segments:
        if segment.words:
            flat.extend((w.start, w.end, w.text) for w in segment.words)
        else:
            flat.extend(make_job.split_segment(segment))
    labels = synthetic[1]["labels"]

    def text(word_id):
        return flat[int(word_id[1:])][2].strip(".,?!").casefold()

    assert sorted(text(w) for w in labels["filler"]) == ["anu", "eh"]
    assert sorted(text(w) for w in labels["particle"]) == ["dong", "mah", "sih"]
    assert [[text(w) for w in pair] for pair in labels["stutter"]] == [["gua", "gua"]]
    assert sorted(tuple(text(w) for w in pair) for pair in labels["reduplication"]) == [
        ("hati", "hati"), ("pelan", "pelan")]
    (first, second), = labels["overlap"]
    assert flat[int(second[1:])][0] < flat[int(first[1:])][1]
    assert [text(w) for w in labels["laughter_token"]] == ["wkwk"]
    (zero,) = labels["zero_length"]
    assert flat[int(zero[1:])][0] == flat[int(zero[1:])][1]
    assert labels["split_segment_words"]
    assert any(not segment.words for segment in transcription.segments)
    assert any(event["label"] == "tertawa" for event in synthetic[1]["events"])


# --- prepare_legacy_job ----------------------------------------------------------------------------


def test_prepare_persists_every_artifact_once(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    before = inspect_job(job_dir)
    assert [(entry["index"], entry["clip_id"], entry["openable"], entry["reason"])
            for entry in before] == [(i, None, False, "needs_prepare") for i in (1, 2, 3)]
    assert not (job_dir / "analysis" / "clips").exists()
    results = prepare_legacy_job(job_dir)
    assert [entry["index"] for entry in results] == [1, 2, 3]
    assert all(entry["openable"] and entry["reason"] is None for entry in results)
    source = job_dir / "input" / "source.mp4"
    info = json.loads((job_dir / SOURCE_INFO_RELATIVE_PATH).read_text())
    assert info["content_sha256"] == file_sha256(source)
    selection = read_selection_artifact(job_dir / "analysis" / "selection.v3.json")
    selection_sha = hashlib.sha256(
        (job_dir / "analysis" / "selection.v3.json").read_bytes()).hexdigest()
    for entry, clip in zip(results, selection.clips):
        teaser = clip.cold_open
        expected_id = clip_id(info["content_sha256"], ms_from_seconds(clip.start),
                              ms_from_seconds(clip.end),
                              None if teaser is None else (ms_from_seconds(teaser[0]),
                                                           ms_from_seconds(teaser[1])))
        assert entry["clip_id"] == expected_id
        clip_dir = job_dir / "analysis" / "clips" / expected_id
        assert stat.S_IMODE(clip_dir.stat().st_mode) == 0o700
        names = sorted(path.name for path in clip_dir.iterdir())
        assert len(names) == 3 and names[1].startswith("seed")
        seed_raw = (clip_dir / "seed.json").read_bytes()
        seed = json.loads(seed_raw)
        assert seed_raw == encode_seed(seed)
        words_sha = seed["base"]["words"]["sha256"]
        words_raw = (clip_dir / f"words.{words_sha[:16]}.json").read_bytes()
        assert hashlib.sha256(words_raw).hexdigest() == words_sha
        words = json.loads(words_raw)
        assert seed["base"]["words"]["count"] == len(words["words"])
        assert (clip_dir / words["peaks"]["file"]).is_file()
        assert words["window_ms"] == seed["base"]["window_ms"]
        assert words["fps"] == seed["output"]["fps"] == [30000, 1001]
        assert words["missing"] == []
        assert seed["base"]["engine"]["compiler"] == "legacy"
        assert seed["audit"]["editor"] == "prepare/edit-v2/1"
        assert seed["base"]["origin"]["selection_artifact_sha256"] == selection_sha
        assert seed["base"]["origin"]["rank_at_seed"] == clip.rank
        assert seed["base"]["camera"]["sha256"] is None
        assert _no_floats(seed)
        for path in clip_dir.iterdir():
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
    after = inspect_job(job_dir)
    assert [(e["clip_id"], e["openable"], e["reason"]) for e in after] == [
        (e["clip_id"], True, None) for e in results]


def test_prepare_is_idempotent_and_never_overwrites(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    first = prepare_legacy_job(job_dir)
    tree = _tree(job_dir / "analysis")
    assert prepare_legacy_job(job_dir) == first
    assert _tree(job_dir / "analysis") == tree
    seed_path = job_dir / "analysis" / "clips" / first[0]["clip_id"] / "seed.json"
    seed_path.chmod(0o600)
    marker = seed_path.read_bytes().replace(b'"Seed"', b'"Kept"')
    seed_path.write_bytes(marker)
    assert prepare_legacy_job(job_dir) == first
    assert seed_path.read_bytes() == marker


def test_inspect_writes_nothing(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    tree = _tree(job_dir)
    inspect_job(job_dir)
    assert _tree(job_dir) == tree


def test_an_old_job_without_sound_events_opens(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "old", tmp_path)
    assert not (job_dir / "analysis" / "sound-events.json").exists()
    assert (job_dir / ".attempts").is_dir()
    results = prepare_legacy_job(job_dir)
    assert len(results) == 3 and all(entry["openable"] for entry in results)
    for entry in results:
        clip_dir = job_dir / "analysis" / "clips" / entry["clip_id"]
        (words_path,) = clip_dir.glob("words.*.json")
        words = json.loads(words_path.read_text())
        assert words["missing"] == ["sound_events"]
        assert all(event["src"] == "transcript" for event in words["events"])


def test_a_job_with_stranded_analysis_is_incomplete(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "stranded", tmp_path)
    tree = _tree(job_dir)
    results = prepare_legacy_job(job_dir)
    assert results == [{"clip_id": None, "index": i, "openable": False,
                        "reason": "analysis_incomplete"} for i in (1, 2, 3)]
    assert _tree(job_dir) == tree
    assert inspect_job(job_dir) == results


def test_a_v1_job_is_not_v3(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "v1", tmp_path)
    results = prepare_legacy_job(job_dir)
    assert results and all(entry["reason"] == "not_v3" for entry in results)
    assert all(entry["clip_id"] is None and not entry["openable"] for entry in results)


@pytest.mark.parametrize(
    ("breakage", "reason"),
    [
        ("source", "source_missing"),
        ("transcript", "transcript_missing"),
        ("selection_corrupt", "selection_unreadable"),
        ("selection_gone", "selection_unreadable"),
    ],
)
def test_broken_jobs_name_their_reason(synthetic, tmp_path, breakage, reason):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    if breakage == "source":
        (job_dir / "input" / "source.mp4").unlink()
    elif breakage == "transcript":
        (job_dir / "output" / "transcript.json").unlink()
    elif breakage == "selection_corrupt":
        (job_dir / "analysis" / "selection.v3.json").write_text('{"clips": 1}')
    else:
        (job_dir / "analysis" / "selection.v3.json").unlink()
    results = prepare_legacy_job(job_dir)
    assert results == [{"clip_id": None, "index": i, "openable": False, "reason": reason}
                       for i in (1, 2, 3)]
    assert not (job_dir / "analysis" / "clips").exists()


def test_a_source_outside_the_job_is_never_used(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    (job_dir / "input" / "source.mp4").unlink()
    (job_dir / "input" / "source.mp4").symlink_to(_job_dir(synthetic, "main") / "input" /
                                                  "source.mp4")
    results = prepare_legacy_job(job_dir)
    assert {entry["reason"] for entry in results} == {"source_missing"}


def test_a_missing_job_is_not_found(tmp_path):
    from ai_clipper.edit_v2.errors import NotFound

    with pytest.raises(NotFound):
        prepare_legacy_job(tmp_path / "nope")
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad" / "job.json").write_text("[1]")
    with pytest.raises(NotFound):
        prepare_legacy_job(tmp_path / "bad")


def test_a_face_track_job_gets_a_camera_plan(synthetic, tmp_path, monkeypatch):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    job_path = job_dir / "job.json"
    job = json.loads(job_path.read_text())
    job["options"]["renderMode"] = "face-track"
    job_path.write_text(json.dumps(job))
    calls = []

    def stub(source, *, start, end, sample_interval=0.75):
        calls.append((start, end))
        times = [i * sample_interval for i in range(int((end - start) / sample_interval) + 1)
                 if i * sample_interval < end - start]
        return times, [0.5 if i % 7 else None for i in range(len(times))], [False] * len(
            times), 256, 144

    monkeypatch.setattr(camera, "detect_face_track", stub)
    results = prepare_legacy_job(job_dir)
    assert len(calls) == 3 and all(entry["openable"] for entry in results)
    for entry in results:
        clip_dir = job_dir / "analysis" / "clips" / entry["clip_id"]
        seed = json.loads((clip_dir / "seed.json").read_text())
        assert seed["layout"]["default"]["mode"] == "camera"
        camera_sha = seed["base"]["camera"]["sha256"]
        raw = (clip_dir / f"camera.{camera_sha[:16]}.json").read_bytes()
        assert hashlib.sha256(raw).hexdigest() == camera_sha
        plan = json.loads(raw)
        assert plan["window_ms"] == seed["base"]["window_ms"]
        assert plan["output"] == {"w": 720, "h": 1280}


def test_prepared_seeds_have_the_documented_shape(synthetic, tmp_path):
    job_dir = _copy_job(synthetic, "main", tmp_path)
    for entry in prepare_legacy_job(job_dir):
        seed = json.loads(
            (job_dir / "analysis" / "clips" / entry["clip_id"] / "seed.json").read_text())
        assert set(seed) == {"schema", "schema_minor", "clip_id", "revision", "parent_sha256",
                             "base", "output", "main", "captions", "layout", "tracks", "audio",
                             "assets", "audit"}
        assert all(character in UUID_HEX for character in seed["base"]["job_id"])
        window = seed["base"]["window_ms"]
        assert 0 <= window[0] < window[1] <= seed["base"]["source"]["duration_ms"]
        fps = Fps.from_json(seed["output"]["fps"])
        for segment in seed["main"]["segments"]:
            assert tm.sf_floor(window[0], fps) <= segment["in_sf"] < segment["out_sf"]
            assert segment["out_sf"] <= tm.sf_ceil(window[1], fps)
        assert seed["tracks"][0]["items"][0]["dur_f"] == 120
        assert os.path.basename(str(job_dir)) != seed["base"]["job_id"]  # a copy keeps the id
