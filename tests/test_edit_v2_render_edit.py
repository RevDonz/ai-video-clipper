"""T2.1: revision 0 through the edit-v2 compiler, and ``render_request`` (plan §5.8, §4.6, R10).

Two real V3 jobs are built once per module on a 24 s lavfi source (320×180, 25 fps, stereo
48 kHz) with a scripted transcript and selection, and run through ``pipeline.run_pipeline``:

* ``auto_job``: ``render_engine="edit-v2"``: every clip is seeded (``source.json``, words,
  peaks, ``seed.json``) and rendered by the compiler, the manifest carries ``clip_id``,
  ``render_engine``, ``render_key`` and ``plan_sha256``;
* ``legacy_job``: the same job with the legacy engine, then ``prepare_legacy_job`` (the seed of
  an older job, ``base.engine.compiler = "legacy"``).

Tests that write (render requests, edits) work on a copy of the job directory.
"""

from __future__ import annotations

import copy
import gzip
import hashlib
import inspect
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

import ai_clipper.pipeline as pipeline_module
from ai_clipper.audio_timeline import build_audio_timeline
from ai_clipper.edit_v2 import COMPILER_ID, errors, execute, render_edit, seed, store, toolchain
from ai_clipper.edit_v2 import doc as doc_module
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources
from ai_clipper.selection_types import SelectedClip, SelectionResult

SECONDS = 24.0
FPS = 25
SENTENCE_S = 2.5
SENTENCE_STEP_S = 3.0
FIRST_S = 0.4
TEXTS = (
    "Halo semuanya selamat datang lagi",
    "Hari ini gue mau cerita sesuatu",
    "Ceritanya lumayan panjang tapi seru",
    "Kenapa kamu pilih jalan itu dulu?",
    "Gue juga nggak tahu jawabannya",
    "Pokoknya waktu itu rame banget",
    "Terus tiba tiba lampunya mati",
    "Semua orang langsung ketawa bareng",
)
DPKG = ("ffmpeg\t7:5.1.9-0+deb12u1\nfontconfig\t2.14.1-4\nlibass9:amd64\t1:0.17.1-1+deb12u1\n"
        "libfreetype6:amd64\t2.12.1+dfsg-5+deb12u4\nlibfribidi0:amd64\t1.0.8-2.1\n"
        "libharfbuzz0b:amd64\t6.0.0+dfsg-3\n")
ENGINE_KEYS = {"clip_id", "render_engine", "render_key", "plan_sha256"}
HEX64 = re.compile(r"[0-9a-f]{64}")


# --- the jobs -----------------------------------------------------------------------------------


def rows() -> list[tuple[float, float, str]]:
    return [(round(FIRST_S + i * SENTENCE_STEP_S, 3),
             round(FIRST_S + i * SENTENCE_STEP_S + SENTENCE_S, 3), text)
            for i, text in enumerate(TEXTS)]


def word_times(start: float, end: float, text: str) -> list[tuple[float, float, str]]:
    tokens = text.split()
    step = (end - start) / len(tokens)
    return [(round(start + i * step, 3), round(start + (i + 1) * step - 0.04, 3), token)
            for i, token in enumerate(tokens)]


class FakeWhisper:
    def transcribe(self, source, **options):
        raw = [SimpleNamespace(
            start=start, end=end, text=f" {text}",
            words=[SimpleNamespace(word=f" {token}", start=ws, end=we, probability=0.9)
                   for ws, we, token in word_times(start, end, text)])
            for start, end, text in rows()]
        return raw, SimpleNamespace(language="id", duration=SECONDS)


def clip(rank: int, start: float, end: float, cold_open=None) -> SelectedClip:
    return SelectedClip(
        rank=rank, start=start, end=end, cold_open=cold_open, unit_ids=("S0001", "S0003"),
        hook_unit_id="S0002", title=f"Judul {rank}", hook_text="Hook singkat",
        description="Deskripsi.", hashtags=("#tes",), archetype="humor", score=7.0,
        scores={"hook": 7.0, "standalone": 7.0, "payoff": 7.0, "emotion": 7.0,
                "shareability": 7.0},
        reasons=("Alasan.",), source="llm", text="Teks.")


CLIPS = (clip(1, 3.3, 12.0, cold_open=(18.3, 20.0)), clip(2, 12.3, 17.95))


def selection(clips=CLIPS) -> SelectionResult:
    return SelectionResult(clips=tuple(clips), source="llm", status="completed",
                           provider="fixture", model="fixture-model", prompt_version="fixture-v1",
                           warnings=(), usage={"requests": 1})


def timeline():
    frames = [-60.0 if (i * 0.1 - FIRST_S) % SENTENCE_STEP_S >= SENTENCE_S else -20.0
              for i in range(round(SECONDS / 0.1))]
    return build_audio_timeline(frames, duration=SECONDS)


def make_source(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"testsrc2=size=320x180:rate={FPS}:duration={SECONDS}",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SECONDS}",
         "-ac", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-g", str(FPS), "-c:a", "aac", "-b:a", "96k", "-shortest", str(path)],
        check=True, capture_output=True, timeout=120)
    return path


def make_job(root: Path, job_id: str, source: Path, *, render_mode="fit-blur") -> Path:
    job_dir = root / job_id
    target = job_dir / "input" / "source.mp4"
    target.parent.mkdir(parents=True)
    shutil.copyfile(source, target)
    options = {"renderMode": render_mode, "limit": 3, "minDuration": 3, "maxDuration": 60,
               "selectionMode": "v3", "llmMode": "off", "coldOpen": True, "hookOverlay": True,
               "captionStyle": "karaoke"}
    (job_dir / "job.json").write_text(json.dumps({
        "id": job_id, "status": "processing", "options": options,
        "source": {"type": "upload", "name": "source.mp4", "size": target.stat().st_size},
        "sourcePath": str(target)}), encoding="utf-8")
    return job_dir


def run_job(job_dir: Path, *, engine: str, render_mode="fit-blur", clips=CLIPS,
            patches=()) -> dict:
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline_module, "analyze_audio_timeline",
                      lambda source, **options: timeline())
        patch.setattr(pipeline_module, "select_clips_v3", lambda *a, **k: selection(clips))
        for target, name, value in patches:
            patch.setattr(target, name, value)
        for name in list(os.environ):
            if name.startswith("POTONGIN_LLM") or name.endswith("_API_KEY"):
                patch.delenv(name, raising=False)
        manifest = pipeline_module.run_pipeline(
            job_dir / "input" / "source.mp4", job_dir / "output", model=FakeWhisper(),
            artifact_root=job_dir, selection_mode="v3", llm_mode="off", min_duration=3.0,
            max_duration=60.0, limit=3, width=720, height=1280, render_mode=render_mode,
            caption_style="karaoke", render_engine=engine)
    return json.loads(manifest.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def source(tmp_path_factory, edit_v2_libass):
    return make_source(tmp_path_factory.mktemp("render-edit-source") / "source.mp4")


@pytest.fixture(scope="module")
def auto_job(tmp_path_factory, source):
    root = tmp_path_factory.mktemp("auto-jobs")
    job_id = str(uuid.uuid4())
    job_dir = make_job(root, job_id, source)
    manifest = run_job(job_dir, engine="edit-v2")
    return SimpleNamespace(root=root, job_id=job_id, job_dir=job_dir, manifest=manifest)


@pytest.fixture(scope="module")
def legacy_job(tmp_path_factory, source):
    root = tmp_path_factory.mktemp("legacy-jobs")
    job_id = str(uuid.uuid4())
    job_dir = make_job(root, job_id, source)
    manifest = run_job(job_dir, engine="legacy")
    return SimpleNamespace(root=root, job_id=job_id, job_dir=job_dir, manifest=manifest)


def copy_job(job, tmp_path: Path) -> Path:
    target = tmp_path / "jobs" / job.job_id
    shutil.copytree(job.job_dir, target, symlinks=True)
    return target


def clip_dir(job_dir: Path, clip_id: str) -> Path:
    return job_dir / "analysis" / "clips" / clip_id


def framemd5(path: Path) -> list[str]:
    output = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f",
         "framemd5", "-"], capture_output=True, text=True, check=True).stdout
    return [line for line in output.splitlines() if line and not line.startswith("#")]


def pcm_md5(path: Path) -> str:
    output = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "s16le",
         "-ac", "2", "-ar", "48000", "-"], capture_output=True, check=True).stdout
    return hashlib.md5(output).hexdigest()


def resources_with_toolchain(tmp_path: Path, snapshot="20260924T000000Z") -> Resources:
    root = tmp_path / f"resources-{snapshot}"
    shutil.copytree(RESOURCES_DIR, root, ignore=shutil.ignore_patterns("toolchain.json"))
    toolchain.write(root / "toolchain.json", apt_snapshot=snapshot,
                    base_image="node:20-bookworm-slim@sha256:" + "2c" * 32, dpkg_output=DPKG)
    return Resources(root)


def request_for(job_dir: Path, clip_id: str, relative: str, etag: str, revision: int, *,
                key: str | None = None, **extra) -> dict:
    key = key or hashlib.sha256(f"{clip_id}{etag}".encode()).hexdigest()
    request = {
        "version": "render-request-v3", "render_id": str(uuid.uuid4()),
        "idempotency_key": str(uuid.uuid4()), "state": "rendering", "clip_id": clip_id,
        "doc_sha256": etag, "doc_revision": revision, "doc_relative": relative,
        "render_key": key, "size": "output", "quality": "standar",
        "output_relative": f"output/edits/{clip_id}/{key[:16]}.mp4",
        "source_content_sha256": json.loads(
            (job_dir / "analysis" / "source.json").read_text())["content_sha256"],
    }
    request.update(extra)
    return request


def put_revision(clip_directory: Path, document: dict, etag: str, *, now_ms: int,
                 **changes) -> tuple[dict, str]:
    """Save ``document`` + changes as the next revision (the editor's PUT)."""
    nxt = copy.deepcopy(document)
    nxt["revision"] = document["revision"] + 1
    nxt["parent_sha256"] = etag
    nxt["audit"]["last_command"] = changes.pop("command", "SetHookText")
    if "hook" in changes:
        nxt["tracks"][0]["items"][0]["payload"]["text"] = changes.pop("hook")
    assert not changes
    saved, new_etag, _warnings = store.put(
        clip_directory, expected_etag=etag, idempotency_key=str(uuid.uuid4()),
        raw=doc_module.canonical_bytes(nxt), now_ms=now_ms)
    return saved, new_etag


def heartbeats():
    calls: list[tuple[str, int]] = []
    return calls, lambda stage, progress: calls.append((stage, progress))


# --- contract and unit ---------------------------------------------------------------------------


def test_render_functions_keep_the_appendix_a_signatures():
    parameter = inspect.Parameter
    document = list(inspect.signature(render_edit.render_document).parameters.values())
    assert [(p.name, p.kind) for p in document[:7]] == [
        ("doc", parameter.POSITIONAL_OR_KEYWORD), ("job_dir", parameter.POSITIONAL_OR_KEYWORD),
        ("output", parameter.POSITIONAL_OR_KEYWORD), ("size", parameter.KEYWORD_ONLY),
        ("quality", parameter.KEYWORD_ONLY), ("progress", parameter.KEYWORD_ONLY),
        ("cancel", parameter.KEYWORD_ONLY)]
    assert document[3].default is parameter.empty and document[4].default is parameter.empty
    assert document[5].default is None and document[6].default is None
    assert all(p.kind is parameter.KEYWORD_ONLY and p.default is not parameter.empty
               for p in document[7:])  # additions are optional keywords
    request = list(inspect.signature(render_edit.render_request).parameters.values())
    assert [(p.name, p.kind, p.default) for p in request[:4]] == [
        ("job_dir", parameter.POSITIONAL_OR_KEYWORD, parameter.empty),
        ("request", parameter.POSITIONAL_OR_KEYWORD, parameter.empty),
        ("heartbeat", parameter.KEYWORD_ONLY, parameter.empty),
        ("cancel", parameter.KEYWORD_ONLY, parameter.empty)]
    assert all(p.kind is parameter.KEYWORD_ONLY and p.default is not parameter.empty
               for p in request[4:])


@pytest.mark.parametrize(("value", "engine"), [
    (None, "legacy"), ("legacy", "legacy"), ("edit-v2", "edit-v2"), ("EDIT-V2", "legacy"),
    ("edit-v2 ", "legacy"), ("", "legacy"), ("on", "legacy")])
def test_the_engine_flag_is_edit_v2_only_when_exactly_set(value, engine):
    env = {} if value is None else {"POTONGIN_RENDER_ENGINE": value}
    assert render_edit.engine_from_env(env) == engine


def test_the_job_id_comes_from_the_job_json_of_the_job_or_its_attempt(tmp_path):
    job_id = str(uuid.uuid4())
    job_dir = tmp_path / job_id
    attempt = job_dir / ".attempts" / ("ab" * 32)
    attempt.mkdir(parents=True)
    assert render_edit.job_id_for(job_dir) is None
    (job_dir / "job.json").write_text(json.dumps({"id": job_id}), encoding="utf-8")
    assert render_edit.job_id_for(job_dir) == job_id
    assert render_edit.job_id_for(attempt) == job_id  # a queue attempt of the job
    other = tmp_path / str(uuid.uuid4())
    other.mkdir()
    (other / "job.json").write_text(json.dumps({"id": job_id}), encoding="utf-8")
    assert render_edit.job_id_for(other) is None  # the id must name its own directory
    (job_dir / "job.json").write_text('{"id": "x", "id": "' + job_id + '"}', encoding="utf-8")
    assert render_edit.job_id_for(job_dir) is None  # duplicate keys are refused


@pytest.mark.parametrize("broken", [
    {"version": "render-request-v2"},
    {"clip_id": "clip_../../../etc"},
    {"doc_relative": "analysis/clips/{clip}/../../../../job.json"},
    {"doc_relative": "/etc/passwd"},
    {"doc_sha256": "A" * 64},
    {"doc_revision": -1},
    {"doc_revision": True},
    {"size": "1080x1920"},
    {"quality": "tinggi"},
    {"render_key": "zz"},
    {"output_relative": "output/clip-01.mp4"},
    {"output_relative": "output/edits/{clip}/{key}.mp4.srt"},
    {"source_snapshot_relative": "../source.mp4"},
])
def test_malformed_requests_are_refused_before_any_work(tmp_path, broken):
    clip_id = "clip_" + "a" * 24
    key = "b" * 64
    request = {"version": "render-request-v3", "clip_id": clip_id, "doc_sha256": "c" * 64,
               "doc_revision": 0, "doc_relative": f"analysis/clips/{clip_id}/seed.json",
               "render_key": key, "size": "output", "quality": "standar",
               "output_relative": f"output/edits/{clip_id}/{key[:16]}.mp4",
               "source_content_sha256": "d" * 64}
    request.update({name: value.format(clip=clip_id, key=key) if isinstance(value, str) else value
                    for name, value in broken.items()})
    calls, heartbeat = heartbeats()
    with pytest.raises(errors.RenderFailed) as raised:
        render_edit.render_request(tmp_path, request, heartbeat=heartbeat,
                                   cancel=threading.Event())
    assert raised.value.code == "render_failed" and raised.value.ref == "request"
    assert calls == []


def test_measurements_hash_to_a_stable_render_key_part():
    from ai_clipper.edit_v2.loudness import Loudness

    assert render_edit.measure_sha256(None) is None
    first = render_edit.measure_sha256(Loudness(-1650, -120))
    assert HEX64.fullmatch(first)
    assert first == render_edit.measure_sha256(Loudness(-1650, -120))
    assert first != render_edit.measure_sha256(Loudness(-1650, -121))


# --- the pipeline path (revision 0) ---------------------------------------------------------------


def test_the_edit_v2_pipeline_writes_every_artifact_and_manifest_field(auto_job):
    job_dir, manifest = auto_job.job_dir, auto_job.manifest
    assert manifest["status"] == "completed"
    assert "engine_fallback" not in " ".join(manifest["selection_v3"]["warnings"])
    info = json.loads((job_dir / "analysis" / "source.json").read_text(encoding="utf-8"))
    assert HEX64.fullmatch(info["content_sha256"])
    assert len(manifest["clips"]) == 2
    for index, entry in enumerate(manifest["clips"], start=1):
        assert ENGINE_KEYS <= set(entry)
        assert entry["render_engine"] == COMPILER_ID
        assert entry["render_key"] is None  # no resources/toolchain.json outside the image
        assert HEX64.fullmatch(entry["plan_sha256"])
        directory = clip_dir(job_dir, entry["clip_id"])
        seed_doc, _etag = store.seed(directory)
        assert seed_doc["clip_id"] == entry["clip_id"]
        assert seed_doc["base"]["job_id"] == auto_job.job_id
        assert seed_doc["base"]["engine"] == {"compiler": COMPILER_ID, "render_semantics": 1}
        assert seed_doc["audit"]["editor"] == "pipeline/edit-v2/1"
        assert seed_doc["base"]["origin"]["rank_at_seed"] == index
        assert seed_doc["base"]["camera"]["sha256"] is None  # fit-blur
        words = store.load_words(directory, seed_doc["base"]["words"]["sha256"])
        assert words["clip_id"] == entry["clip_id"] and words["words"]
        assert len(list(directory.glob("peaks.*.bin"))) == 1
        assert not list(directory.glob("camera.*.json"))
        validation = doc_module.validate_doc(seed_doc, words=words, assets={}, seed=seed_doc)
        assert validation.ok, validation.errors
        output = job_dir / "output" / f"clip-{index:02d}.mp4"
        assert entry["output"] == str(output.resolve())
        assert output.is_file() and output.with_suffix(".srt").is_file()
        assert (job_dir / "output" / f"clip-{index:02d}.jpg").is_file()  # the poster stays
    first, second = manifest["clips"]
    assert first["cold_open"] == {"start": 18.3, "end": 20.0}
    assert second["cold_open"] is None
    assert first["clip_id"] != second["clip_id"]


def test_the_seed_file_is_what_was_rendered_and_passes_g1_g2(auto_job):
    job_dir = auto_job.job_dir
    for entry in auto_job.manifest["clips"]:
        seed_doc, _etag = store.seed(clip_dir(job_dir, entry["clip_id"]))
        inputs = render_edit.load_render_inputs(job_dir, seed_doc)
        assert inputs.plan.plan_sha256 == entry["plan_sha256"]
        report = render_edit.verify_file(Path(entry["output"]), inputs.plan)
        assert report.ok
        gates = {gate.name: gate for gate in report.gates}
        assert gates["G1"].ok and gates["G2"].ok
        assert gates["G2"].values["frames"] == inputs.plan.total_frames


def _srt_blocks(text: str) -> list[tuple[int, int, str]]:
    blocks = []
    for block in text.strip().split("\n\n"):
        _number, times, *lines = block.split("\n")
        start, end = (_srt_ms(stamp) for stamp in times.split(" --> "))
        blocks.append((start, end, " ".join(lines)))
    return blocks


def _srt_ms(stamp: str) -> int:
    hours, minutes, rest = stamp.split(":")
    seconds, millis = rest.split(",")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(millis)


def _ass_events(text: str) -> list[tuple[int, int, str]]:
    events = []
    for line in text.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        fields = line.split(",", 9)
        if fields[3] == "Hook":
            continue
        start, end = (_ass_cs(stamp) * 10 for stamp in fields[1:3])
        body = re.sub(r"\{[^}]*\}", "", fields[9]).replace("\\N", " ")
        events.append((start, end, " ".join(body.split())))
    return events


def _ass_cs(stamp: str) -> int:
    hours, minutes, rest = stamp.split(":")
    seconds, centis = rest.split(".")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 100 + int(centis)


def test_the_srt_comes_from_the_frame_cues_and_matches_the_burned_events(auto_job):
    frame_ms = 1000 / FPS
    for entry in auto_job.manifest["clips"]:
        seed_doc, _etag = store.seed(clip_dir(auto_job.job_dir, entry["clip_id"]))
        plan = render_edit.load_render_inputs(auto_job.job_dir, seed_doc).plan
        srt = Path(entry["subtitles"]).read_text(encoding="utf-8")
        assert srt == plan.srt()
        blocks, events = _srt_blocks(srt), _ass_events(plan.ass)
        assert blocks and len(blocks) == len(events)
        for (s0, s1, text), (a0, a1, burned) in zip(blocks, events, strict=True):
            assert text == burned
            assert abs(s0 - a0) <= frame_ms and abs(s1 - a1) <= frame_ms


def test_rendering_revision_0_again_gives_the_same_video_and_audio(auto_job, tmp_path):
    entry = auto_job.manifest["clips"][1]
    seed_doc, _etag = store.seed(clip_dir(auto_job.job_dir, entry["clip_id"]))
    again = tmp_path / "again.mp4"
    result = render_edit.render_document(seed_doc, auto_job.job_dir, again, size=(720, 1280),
                                         quality="standar")
    assert result.output == again and result.srt == again.with_suffix(".srt")
    assert result.plan_sha256 == entry["plan_sha256"] and result.reused is None
    assert framemd5(again) == framemd5(Path(entry["output"]))  # P-RT (local toolchain)
    assert pcm_md5(again) == pcm_md5(Path(entry["output"]))
    assert again.with_suffix(".srt").read_bytes() == Path(entry["subtitles"]).read_bytes()


def test_render_document_never_clobbers_and_leaves_no_temporary_files(auto_job, tmp_path):
    entry = auto_job.manifest["clips"][1]
    seed_doc, _etag = store.seed(clip_dir(auto_job.job_dir, entry["clip_id"]))
    target = tmp_path / "out" / "clip.mp4"
    target.parent.mkdir()
    target.with_suffix(".srt").write_text("mine", encoding="utf-8")
    with pytest.raises(errors.RenderFailed):
        render_edit.render_document(seed_doc, auto_job.job_dir, target, size=(720, 1280),
                                    quality="standar")
    assert sorted(path.name for path in target.parent.iterdir()) == ["clip.srt"]
    assert target.with_suffix(".srt").read_text(encoding="utf-8") == "mine"


def test_render_document_refuses_another_size_or_quality(auto_job, tmp_path):
    entry = auto_job.manifest["clips"][1]
    seed_doc, _etag = store.seed(clip_dir(auto_job.job_dir, entry["clip_id"]))
    for size, quality in (((1080, 1920), "standar"), ((720, 1280), "tinggi")):
        with pytest.raises(ValueError):
            render_edit.render_document(seed_doc, auto_job.job_dir, tmp_path / "x.mp4",
                                        size=size, quality=quality)


def test_a_render_key_is_recorded_with_a_pinned_toolchain(auto_job, tmp_path):
    entry = auto_job.manifest["clips"][1]
    seed_doc, _etag = store.seed(clip_dir(auto_job.job_dir, entry["clip_id"]))
    resources = resources_with_toolchain(tmp_path)
    inputs = render_edit.load_render_inputs(auto_job.job_dir, seed_doc, resources=resources)
    key = render_edit.render_key_for(inputs.plan, None, resources)
    assert HEX64.fullmatch(key)
    other = render_edit.render_key_for(inputs.plan, None,
                                       resources_with_toolchain(tmp_path, "20261001T000000Z"))
    assert other != key  # a toolchain change is a new key (R9)
    assert render_edit.render_key_for(inputs.plan, None, Resources(tmp_path / "none")) is None


# --- render_request: R10 --------------------------------------------------------------------------


def test_revision_0_exports_the_auto_file_itself(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][0]
    directory = clip_dir(job_dir, entry["clip_id"])
    _seed_doc, etag = store.seed(directory)
    relative, revision = store.archive_for_render(directory, etag)
    request = request_for(job_dir, entry["clip_id"], relative, etag, revision)
    calls, heartbeat = heartbeats()
    result = render_edit.render_request(job_dir, request, heartbeat=heartbeat,
                                        cancel=threading.Event())
    auto = job_dir / "output" / "clip-01.mp4"
    assert result.reused == "auto_file" and result.render_engine == COMPILER_ID
    assert result.output == job_dir / request["output_relative"]
    assert os.stat(result.output).st_ino == os.stat(auto).st_ino  # a hard link (R10)
    assert os.stat(result.srt).st_ino == os.stat(auto.with_suffix(".srt")).st_ino
    assert result.warnings == ()
    assert calls[0] == ("merender", 0) and calls[-1] == ("selesai", 1000)


def test_an_undone_edit_still_exports_the_auto_file(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][0]
    directory = clip_dir(job_dir, entry["clip_id"])
    seed_doc, etag = store.seed(directory)
    now = seed_doc["audit"]["created_at_ms"] + 1000
    first, first_etag = put_revision(directory, seed_doc, etag, now_ms=now, hook="Hook lain")
    second, second_etag = put_revision(directory, first, first_etag, now_ms=now + 1000,
                                       hook=seed_doc["tracks"][0]["items"][0]["payload"]["text"],
                                       command="Undo")
    assert second["revision"] == 2 and doc_module.content_equals_seed(second, seed_doc)
    relative, revision = store.archive_for_render(directory, second_etag)
    request = request_for(job_dir, entry["clip_id"], relative, second_etag, revision)
    result = render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                        cancel=threading.Event())
    assert result.reused == "auto_file"
    assert os.stat(result.output).st_ino == os.stat(job_dir / "output" / "clip-01.mp4").st_ino


def test_the_auto_file_is_exported_whatever_the_toolchain(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][1]
    directory = clip_dir(job_dir, entry["clip_id"])
    _seed_doc, etag = store.seed(directory)
    relative, revision = store.archive_for_render(directory, etag)
    for snapshot in ("20260924T000000Z", "20261001T000000Z"):
        resources = resources_with_toolchain(tmp_path, snapshot)
        request = request_for(job_dir, entry["clip_id"], relative, etag, revision,
                              key=hashlib.sha256(snapshot.encode()).hexdigest())
        result = render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                            cancel=threading.Event(), resources=resources)
        assert result.reused == "auto_file"
        assert os.stat(result.output).st_ino == os.stat(job_dir / "output" / "clip-02.mp4").st_ino


def test_a_missing_auto_file_renders_with_auto_file_unavailable(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][1]
    (job_dir / "output" / "clip-02.mp4").unlink()
    directory = clip_dir(job_dir, entry["clip_id"])
    _seed_doc, etag = store.seed(directory)
    relative, revision = store.archive_for_render(directory, etag)
    request = request_for(job_dir, entry["clip_id"], relative, etag, revision)
    result = render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                        cancel=threading.Event())
    assert result.reused is None and "auto_file_unavailable" in result.warnings
    assert result.plan_sha256 == entry["plan_sha256"]
    assert result.verify is not None and result.verify["ok"]
    assert framemd5(result.output) == framemd5(auto_job.job_dir / "output" / "clip-02.mp4")


def test_a_legacy_engine_clip_exports_its_auto_file(legacy_job, tmp_path):
    job_dir = copy_job(legacy_job, tmp_path)
    assert not (job_dir / "analysis" / "clips").exists()  # the legacy engine seeds nothing
    assert all(set(entry).isdisjoint(ENGINE_KEYS) for entry in legacy_job.manifest["clips"])
    prepared = seed.prepare_legacy_job(job_dir)
    assert [entry["openable"] for entry in prepared] == [True, True]
    for entry in prepared:
        directory = clip_dir(job_dir, entry["clip_id"])
        seed_doc, etag = store.seed(directory)
        assert seed_doc["base"]["engine"]["compiler"] == "legacy"
        relative, revision = store.archive_for_render(directory, etag)
        request = request_for(job_dir, entry["clip_id"], relative, etag, revision)
        result = render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                            cancel=threading.Event())
        auto = job_dir / "output" / f"clip-{entry['index']:02d}.mp4"
        assert result.reused == "auto_file" and result.render_engine == "legacy"
        assert os.stat(result.output).st_ino == os.stat(auto).st_ino


# --- render_request: edited documents -------------------------------------------------------------


def test_an_edited_document_renders_from_its_archive_under_its_key(auto_job, tmp_path,
                                                                    monkeypatch):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][1]
    directory = clip_dir(job_dir, entry["clip_id"])
    seed_doc, etag = store.seed(directory)
    edited, edited_etag = put_revision(directory, seed_doc, etag,
                                       now_ms=seed_doc["audit"]["created_at_ms"] + 1000,
                                       hook="Hook yang baru")
    relative, revision = store.archive_for_render(directory, edited_etag)
    assert relative.endswith(".json.gz") and revision == 1
    request = request_for(job_dir, entry["clip_id"], relative, edited_etag, revision)
    calls, heartbeat = heartbeats()
    result = render_edit.render_request(job_dir, request, heartbeat=heartbeat,
                                        cancel=threading.Event())
    assert result.reused is None and result.render_engine == COMPILER_ID
    assert result.output == job_dir / request["output_relative"]
    assert result.plan_sha256 != entry["plan_sha256"]
    assert result.verify["ok"] and result.frames == render_edit.load_render_inputs(
        job_dir, edited).plan.total_frames
    assert "Hook yang baru" not in result.srt.read_text(encoding="utf-8")  # the hook is no cue
    stages = [stage for stage, _progress in calls]
    assert stages[0] == "merender" and "memverifikasi" in stages and calls[-1] == ("selesai",
                                                                                     1000)
    rendering = [progress for stage, progress in calls if stage == "merender"]
    assert rendering == sorted(rendering) and all(0 <= value <= 1000 for value in rendering)
    # The same request again: the published export is verified and reused, nothing renders.
    monkeypatch.setattr(execute, "run", lambda *a, **k: pytest.fail("rendered again"))
    again = render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                       cancel=threading.Event())
    assert again.reused == "existing" and again.output == result.output


def test_a_request_whose_document_does_not_match_its_sha_is_refused(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][1]
    directory = clip_dir(job_dir, entry["clip_id"])
    seed_doc, etag = store.seed(directory)
    _edited, edited_etag = put_revision(directory, seed_doc, etag,
                                       now_ms=seed_doc["audit"]["created_at_ms"] + 1000,
                                       hook="Hook yang baru")
    relative, revision = store.archive_for_render(directory, edited_etag)
    archived = job_dir / relative
    tampered = json.loads(gzip.decompress(archived.read_bytes()))
    tampered["tracks"][0]["items"][0]["payload"]["text"] = "Hook palsu"
    archived.write_bytes(gzip.compress(doc_module.canonical_bytes(tampered)))
    request = request_for(job_dir, entry["clip_id"], relative, edited_etag, revision)
    with pytest.raises(errors.RenderFailed) as raised:
        render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                   cancel=threading.Event())
    assert raised.value.ref == "document"
    assert not (job_dir / "output" / "edits").exists() or not any(
        (job_dir / "output" / "edits").rglob("*.mp4"))


def test_a_cancelled_request_publishes_nothing(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][1]
    directory = clip_dir(job_dir, entry["clip_id"])
    seed_doc, etag = store.seed(directory)
    _edited, edited_etag = put_revision(directory, seed_doc, etag,
                                       now_ms=seed_doc["audit"]["created_at_ms"] + 1000,
                                       hook="Hook yang baru")
    relative, revision = store.archive_for_render(directory, edited_etag)
    request = request_for(job_dir, entry["clip_id"], relative, edited_etag, revision)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(errors.Cancelled):
        render_edit.render_request(job_dir, request, heartbeat=lambda *_: None, cancel=cancel)
    edits = job_dir / "output" / "edits" / entry["clip_id"]
    assert not edits.exists() or list(edits.iterdir()) == []


def test_a_snapshot_with_another_content_is_refused(auto_job, tmp_path):
    job_dir = copy_job(auto_job, tmp_path)
    entry = auto_job.manifest["clips"][1]
    directory = clip_dir(job_dir, entry["clip_id"])
    seed_doc, etag = store.seed(directory)
    _edited, edited_etag = put_revision(directory, seed_doc, etag,
                                       now_ms=seed_doc["audit"]["created_at_ms"] + 1000,
                                       hook="Hook yang baru")
    relative, revision = store.archive_for_render(directory, edited_etag)
    sha = json.loads((job_dir / "analysis" / "source.json").read_text())["content_sha256"]
    snapshot = job_dir / "analysis" / "render-inputs" / f"source.{sha}.mp4"
    snapshot.parent.mkdir(parents=True)
    snapshot.write_bytes(b"not the source")
    request = request_for(job_dir, entry["clip_id"], relative, edited_etag, revision,
                          source_snapshot_relative=str(snapshot.relative_to(job_dir)))
    with pytest.raises(errors.RenderFailed) as raised:
        render_edit.render_request(job_dir, request, heartbeat=lambda *_: None,
                                   cancel=threading.Event())
    assert raised.value.ref == "source"


# --- the rendering stage over an existing job (tools: P-LOOK, PF-PIPELINE, fixtures) ----------------


def test_an_existing_legacy_job_renders_again_with_the_new_engine(legacy_job, tmp_path):
    job_dir = copy_job(legacy_job, tmp_path)
    for name in ("clip-02.mp4", "clip-02.srt", "clip-02.jpg"):
        (job_dir / "output" / name).rename(tmp_path / name)  # the legacy render, kept aside
    run = pipeline_module.render_v3_job(job_dir, render_engine="edit-v2", ranks=[2])
    (entry,) = run.clips
    assert run.warnings == [] and set(run.timings) == {2} and run.seconds >= run.timings[2]
    assert entry["index"] == 2 and entry["render_engine"] == COMPILER_ID
    assert entry["output"] == str(job_dir / "output" / "clip-02.mp4")
    seed_doc, _etag = store.seed(clip_dir(job_dir, entry["clip_id"]))
    assert seed_doc["base"]["job_id"] == legacy_job.job_id
    assert render_edit.verify_file(Path(entry["output"]),
                                   render_edit.load_render_inputs(job_dir, seed_doc).plan).ok
    assert (job_dir / "output" / "clip-02.jpg").is_file()  # a new poster of the new render
    assert (job_dir / "output" / "clip-01.mp4").is_file()  # the other clip is untouched
    with pytest.raises(ValueError):
        pipeline_module.render_v3_job(job_dir, render_engine="edit-v3")


def _make_job_module():
    import importlib.util
    import sys

    name = "editor_fixture_make_job"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, Path(__file__).resolve().parents[1] / "scripts" / "editor_fixture" / "make_job.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def test_the_synthetic_job_render_option_records_engines(tmp_path, monkeypatch):
    make_job_module = _make_job_module()
    root = tmp_path / "fixture"
    jobs = {}
    for name in ("main", "old", "stranded", "v1"):
        job_dir = root / "jobs" / name
        (job_dir / "output").mkdir(parents=True)
        manifest = {"clips": [{"index": 1, "output": "x"}],
                    "selection_v3": {"warnings": ["few_clips:1"]}}
        (job_dir / "output" / "manifest.json").write_text(json.dumps(manifest))
        (job_dir / "job.json").write_text(json.dumps({"id": name, "clips": []}))
        jobs[name] = {"dir": f"jobs/{name}"}
    calls = []

    def fake(job_dir, *, render_engine):
        calls.append((Path(job_dir).name, render_engine))
        engine = {"edit-v2": COMPILER_ID}.get(render_engine)
        entry = {"index": 1, "score": 1.0, "start": 1.0, "end": 9.0, "duration": 8.0,
                 "text": "t", "output": str(Path(job_dir) / "output" / "clip-01.mp4"),
                 "subtitles": str(Path(job_dir) / "output" / "clip-01.srt")}
        if engine:
            entry.update(clip_id="clip_" + "a" * 24, render_engine=engine, render_key=None,
                         plan_sha256="b" * 64)
        return pipeline_module.V3RenderRun([entry], [], {1: 1.0}, 1.0)

    monkeypatch.setattr(pipeline_module, "render_v3_job", fake)
    report = make_job_module.render_all(root, {"jobs": jobs}, stub_camera=False)
    assert calls == [("main", "edit-v2"), ("old", "legacy")]
    assert report["main"]["clips"][0]["render_engine"] == COMPILER_ID
    assert report["old"]["clips"][0]["render_engine"] == "legacy"
    main_job = json.loads((root / "jobs" / "main" / "job.json").read_text())
    assert main_job["clips"][0]["clipId"] == "clip_" + "a" * 24
    assert main_job["clips"][0]["renderEngine"] == COMPILER_ID
    old_job = json.loads((root / "jobs" / "old" / "job.json").read_text())
    assert "clipId" not in old_job["clips"][0] and "renderEngine" not in old_job["clips"][0]
    index = json.loads((root / "fixture.json").read_text())
    assert index["jobs"]["main"]["rendered"] == "edit-v2"
    assert "rendered" not in index["jobs"]["v1"]


# --- engine fallback and face-track ---------------------------------------------------------------


def test_a_clip_the_new_engine_cannot_render_falls_back_to_the_legacy_engine(source, tmp_path):
    job_id = str(uuid.uuid4())
    job_dir = make_job(tmp_path, job_id, source)
    real = render_edit.render_document

    def flaky(doc, *args, **kwargs):
        if doc["base"]["origin"]["rank_at_seed"] == 2:
            raise errors.RenderFailed("render_failed")
        return real(doc, *args, **kwargs)

    manifest = run_job(job_dir, engine="edit-v2", patches=[(render_edit, "render_document",
                                                            flaky)])
    assert manifest["status"] == "completed"
    first, second = manifest["clips"]
    assert first["render_engine"] == COMPILER_ID and HEX64.fullmatch(first["plan_sha256"])
    assert second["render_engine"] == "legacy"
    assert second["render_key"] is None and second["plan_sha256"] is None
    assert "engine_fallback:2" in manifest["selection_v3"]["warnings"]
    assert Path(second["output"]).is_file() and Path(second["subtitles"]).is_file()
    # The clip keeps its id, but no seed claims the new engine for the legacy file: the
    # editor's prepare seeds it later as a legacy-engine clip.
    assert second["clip_id"] and not (clip_dir(job_dir, second["clip_id"]) / "seed.json").exists()
    assert (clip_dir(job_dir, first["clip_id"]) / "seed.json").is_file()
    prepared = seed.prepare_legacy_job(job_dir)
    assert [entry["openable"] for entry in prepared] == [True, True]
    legacy_seed, _etag = store.seed(clip_dir(job_dir, second["clip_id"]))
    assert legacy_seed["base"]["engine"]["compiler"] == "legacy"


def test_a_face_track_clip_gets_a_camera_plan_and_renders(source, tmp_path):
    from ai_clipper.edit_v2 import camera

    def detector(path, *, start, end, sample_interval=0.75, **_options):
        times = [index * sample_interval for index in range(int((end - start) / sample_interval))]
        centres = [0.35 + 0.3 * index / max(1, len(times) - 1) for index in range(len(times))]
        return times, centres, [False] * len(times), 320, 180

    job_dir = make_job(tmp_path, str(uuid.uuid4()), source, render_mode="face-track")
    manifest = run_job(job_dir, engine="edit-v2", render_mode="face-track",
                       clips=(clip(1, 12.3, 17.95),),
                       patches=[(camera, "detect_face_track", detector)])
    (entry,) = manifest["clips"]
    assert entry["render_engine"] == COMPILER_ID
    directory = clip_dir(job_dir, entry["clip_id"])
    seed_doc, _etag = store.seed(directory)
    assert seed_doc["layout"]["default"]["mode"] == "camera"
    camera_sha = seed_doc["base"]["camera"]["sha256"]
    plan_file = directory / f"camera.{camera_sha[:16]}.json"
    assert hashlib.sha256(plan_file.read_bytes()).hexdigest() == camera_sha
    assert render_edit.verify_file(Path(entry["output"]),
                                   render_edit.load_render_inputs(job_dir, seed_doc).plan).ok
