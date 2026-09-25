"""The single compiler: string goldens for R1–R9 in every mode, graph rules, layouts, and real
FFmpeg checks of frame identity, plate cells, frame-mode timing and crop x (plan §5.1–§5.3).

Goldens live in ``tests/fixtures/edit_v2/goldens/``; regenerate them after an intended change
with ``EDIT_V2_UPDATE_GOLDENS=1 uv run pytest tests/test_edit_v2_compile.py`` and review the
diff. They are compiled with the harness stand-ins for captions (T1.2a) and audio (T1.4), so
they pin only this task's part of the graph.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import random
import re
import subprocess
from fractions import Fraction
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from support import edit_v2_media as media
from test_edit_v2_plan import HARNESS, camera_for, context_for, load_doc

from ai_clipper import face_tracking, render
from ai_clipper.edit_v2 import captions, compile_ffmpeg, execute, layouts
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.compile_ffmpeg import (
    GRAPH_FILE,
    MODES,
    FfmpegJob,
    SourceStreams,
    compile_job,
    decoder_runs,
    seek_arg,
    select_expression,
)
from ai_clipper.edit_v2.loudness import Loudness
from ai_clipper.edit_v2.plan import Resources, build_plan
from ai_clipper.edit_v2.timemap import Fps, Piece

ROOT = Path(__file__).resolve().parents[1]
GOLDENS = ROOT / "tests" / "fixtures" / "edit_v2" / "goldens"
SOURCE = Path("/jobs/job-1/source.mp4")
ASSETS_ROOT = Path("/jobs/job-1/analysis/assets")
RESOURCES = Resources(Path("/app/resources"))


@pytest.fixture
def harness(monkeypatch):
    for module, name, function in HARNESS.HARNESS_PATCHES:
        monkeypatch.setattr(module, name, function)
    return HARNESS


def fake_probe(doc):
    source = doc["base"]["source"]
    return SourceStreams(video_index=0, audio_index=1 if source["has_audio"] else None,
                         width=source["w"], height=source["h"], color_space="bt709",
                         color_range="tv", duration_s=source["duration_ms"] / 1000)


@pytest.fixture
def probe_stub(monkeypatch):
    state = {}

    def probe(path):
        return state["streams"]

    monkeypatch.setattr(compile_ffmpeg, "probe_source", probe)
    return state


def fixture_plan(name, *, doc=None, camera="auto"):
    context = context_for(name)
    doc = load_doc(name) if doc is None else doc
    if camera == "auto":
        camera = camera_for(doc) if doc["layout"]["default"]["mode"] == "camera" else None
    return build_plan(doc, words=context.words, camera=camera, assets=context.assets,
                      resources=RESOURCES)


def compiled(name, probe_stub, *, doc=None, **kwargs):
    plan = fixture_plan(name, doc=doc)
    probe_stub["streams"] = fake_probe(plan.doc)
    return plan, compile_job(plan, source=SOURCE, assets_root=ASSETS_ROOT, **kwargs)


def render_golden(job: FfmpegJob) -> str:
    lines = ["## argv", *job.argv, "## inputs"]
    lines += [f"{spec.kind} {spec.name} {' '.join(spec.options)}".rstrip() for spec in job.inputs]
    lines.append("## sidecars")
    lines += [f"{name} {hashlib.sha256(data).hexdigest()}"
              for name, data in sorted(job.sidecars.items())]
    lines.append("## expected")
    lines.append(json.dumps(job.expected, sort_keys=True, indent=1, ensure_ascii=False))
    lines.append("## filter_script")
    lines.append(job.filter_script)
    return "\n".join(lines) + "\n"


GOLDEN_CASES = {
    "final__seed__c30": ("seed__c30", {"mode": "final"}),
    "final__seed__c25": ("seed__c25", {"mode": "final"}),
    "final__seed__c24": ("seed__c24", {"mode": "final"}),
    "final__full_example__c30": ("full_example__c30",
                                 {"mode": "final", "loudness": Loudness(-1900, -300)}),
    "final__removals_many__c30": ("removals_many__c30", {"mode": "final"}),
    "final__logo_wide__c24": ("logo_wide__c24", {"mode": "final"}),
    "final__music__c30": ("music__c30", {"mode": "final", "loudness": Loudness(-1650, -40)}),
    "reference__full_example__c30": ("full_example__c30",
                                     {"mode": "reference", "loudness": Loudness(-1900, -300)}),
    "plate_cells__seed__c30": ("seed__c30", {"mode": "plate_cells",
                                             "cells": (1242, 620, 621, 622, 1241)}),
    "plate_cells__seed__c25": ("seed__c25", {"mode": "plate_cells", "cells": (300, 301)}),
    "frame__full_example__c30": ("full_example__c30", {"mode": "frame", "frame": 150}),
    "frame__seed__c25": ("seed__c25", {"mode": "frame", "frame": 10}),
    "audio_preview__full_example__c30": ("full_example__c30",
                                         {"mode": "audio_preview",
                                          "loudness": Loudness(-1900, -300)}),
    "audio_measure__music__c30": ("music__c30", {"mode": "audio_measure"}),
    "derive_image__logo__c30": ("logo__c30", {"mode": "derive_image"}),
}
# The S-COLOR choice (gbrp) is the default and pinned by the goldens above; the other two
# candidates keep a golden each (W1 integration).
COMPOSITE_CASES = ("yuv420p", "yuv444p")


def check_golden(name: str, text: str) -> None:
    path = GOLDENS / f"{name}.txt"
    if os.environ.get("EDIT_V2_UPDATE_GOLDENS") == "1":
        GOLDENS.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    assert path.is_file(), f"missing golden {path.name} (EDIT_V2_UPDATE_GOLDENS=1 writes it)"
    assert text == path.read_text(encoding="utf-8"), name


@pytest.mark.parametrize("golden", sorted(GOLDEN_CASES))
def test_string_goldens(harness, probe_stub, golden):
    name, kwargs = GOLDEN_CASES[golden]
    _plan, job = compiled(name, probe_stub, **kwargs)
    check_golden(golden, render_golden(job))


@pytest.mark.parametrize("composite", COMPOSITE_CASES)
def test_string_goldens_for_the_composite_candidates(harness, probe_stub, monkeypatch, composite):
    monkeypatch.setattr(compile_ffmpeg, "COMPOSITE_FORMAT", composite)
    _plan, job = compiled("logo__c30", probe_stub, mode="final")
    check_golden(f"final__logo__c30__{composite}", render_golden(job))


def graph_labels(job: FfmpegJob) -> tuple[dict[str, int], dict[str, int]]:
    """How often each link label is produced and consumed (``-map`` counts as consuming)."""
    produced: dict[str, int] = {}
    consumed: dict[str, int] = {}
    for statement in re.split(r";\s*", job.filter_script.strip()):
        head = re.match(r"^((?:\[[^\]]+\])*)", statement).group(1)
        tail = re.search(r"((?:\[[^\]]+\])*)$", statement).group(1)
        for label in re.findall(r"\[([^\]]+)\]", head):
            if not re.fullmatch(r"\d+:[av0-9]+", label):  # stream specifiers are inputs
                consumed[label] = consumed.get(label, 0) + 1
        for label in re.findall(r"\[([^\]]+)\]", tail):
            produced[label] = produced.get(label, 0) + 1
    argv = list(job.argv)
    for position, token in enumerate(argv[:-1]):
        if token == "-map" and argv[position + 1].startswith("["):
            label = argv[position + 1][1:-1]
            consumed[label] = consumed.get(label, 0) + 1
    return produced, consumed


@pytest.mark.parametrize("golden", sorted(GOLDEN_CASES))
def test_every_label_is_produced_once_and_consumed_once(harness, probe_stub, golden):
    name, kwargs = GOLDEN_CASES[golden]
    _plan, job = compiled(name, probe_stub, **kwargs)
    produced, consumed = graph_labels(job)
    assert produced and set(produced.values()) == {1}, golden
    assert produced == consumed, golden


def test_every_golden_file_has_a_case():
    names = {path.stem for path in GOLDENS.glob("*.txt")}
    expected = set(GOLDEN_CASES) | {f"final__logo__c30__{c}" for c in COMPOSITE_CASES}
    assert names == expected


def test_every_mode_has_a_golden():
    assert {kwargs["mode"] for _name, kwargs in GOLDEN_CASES.values()} == set(MODES)


# --- R8 hygiene and user text --------------------------------------------------------------------

HOSTILE = (
    "XH1';[0:v]split[x];[x]drawtext=text=pwn",
    "XH2 %{pts} $(rm -rf /) `id`",
    "XH3\\', ../../etc/passwd",
    "XH4 a:b=c,d;e[f]",
    "XH5 {\\b1}\\N\\h tebal",
    "XH6 \u202eRTL \u05e9\u05dc\u05d5\u05dd 😂",
    "XH7 -i /dev/zero -f null",
)


def hostile_doc() -> dict:
    doc = load_doc("full_example__c30")
    hook = next(t for t in doc["tracks"] if t["kind"] == "hook")["items"][0]
    hook["payload"]["text"] = HOSTILE[0]
    for word_id, text in zip(sorted(doc["captions"]["word_edits"]), HOSTILE[1:]):
        doc["captions"]["word_edits"][word_id] = {"text": text}
    return doc


def all_mode_jobs(probe_stub, doc):
    jobs = []
    for mode in MODES:
        kwargs = {"mode": mode}
        if mode in ("final", "reference", "audio_preview"):
            kwargs["loudness"] = Loudness(-1900, -300)
        if mode == "plate_cells":
            kwargs["cells"] = (620, 621)
        if mode == "frame":
            kwargs["frame"] = 30
        jobs.append(compiled("full_example__c30", probe_stub, doc=doc, **kwargs)[1])
    return jobs


def test_user_text_never_reaches_argv_or_the_graph(harness, probe_stub):
    doc = hostile_doc()
    jobs = all_mode_jobs(probe_stub, doc)
    assert jobs
    for job in jobs:
        blob = "\n".join(job.argv) + "\n" + job.filter_script
        for text in HOSTILE:
            assert text not in blob
            assert text.split()[0] not in blob  # the XH marker
        for word_id in doc["captions"]["word_edits"]:
            assert word_id not in blob
        for identifier in ("seg_co", "seg_b1", "it_hook", "it_logo", "it_music", "rm_1"):
            assert identifier not in blob
    final = jobs[0]
    assert "XH1" in final.sidecars["captions.ass"].decode("utf-8")


def test_random_user_text_never_reaches_argv_or_the_graph(harness, probe_stub):
    rng = random.Random(20260925)
    alphabet = "abc XYZ:;,[]'\"\\{}%$`=/.-_\u202e\u05e9😂\n\t"
    for _ in range(40):
        doc = load_doc("full_example__c30")
        text = "QQ" + "".join(rng.choice(alphabet) for _ in range(rng.randint(5, 60))) + "QQ"
        text = text.replace("\n", " ").replace("\t", " ")
        hook = next(t for t in doc["tracks"] if t["kind"] == "hook")["items"][0]
        hook["payload"]["text"] = text
        _plan, job = compiled("full_example__c30", probe_stub, doc=doc, mode="final",
                              loudness=Loudness(-1900, -300))
        assert "QQ" not in "\n".join(job.argv) + job.filter_script


def test_r8_hygiene(harness, probe_stub):
    _plan, job = compiled("full_example__c30", probe_stub, mode="final",
                          loudness=Loudness(-1900, -300))
    argv = list(job.argv)
    assert argv[0] == "ffmpeg" and "-nostdin" in argv
    assert argv[argv.index("-filter_complex_script") + 1] == GRAPH_FILE
    assert argv[argv.index("-progress") + 1] == compile_ffmpeg.PROGRESS_TOKEN
    assert "-filter_complex" not in argv and "-vf" not in argv and "-af" not in argv
    inputs = [i for i, token in enumerate(argv) if token == "-i"]
    assert len(inputs) == len(job.inputs)
    for k, position in enumerate(inputs):
        assert argv[position + 1] == compile_ffmpeg.INPUT_TOKEN.format(k)
        options = argv[:position]
        assert options[-len(job.inputs[k].options) - 2:][:2] == ["-protocol_whitelist",
                                                                  "file,pipe"]
    blob = "\n".join(argv) + job.filter_script
    for path in (str(SOURCE), str(ASSETS_ROOT), str(RESOURCES.root), "/proc/"):
        assert path not in blob
    assert job.expected["paths"]["source"] == str(SOURCE)
    assert set(job.sidecars) <= {"captions.ass"}


def test_r7_encode_arguments(harness, probe_stub):
    for name, gop in (("seed__c30", 60), ("seed__c25", 50), ("seed__c24", 48)):
        _plan, job = compiled(name, probe_stub, mode="final")
        argv = "\x00".join(job.argv)
        video = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high",
                 "-pix_fmt", "yuv420p", "-g", str(gop), "-x264-params", "threads=4",
                 "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                 "-color_range", "tv"]
        audio = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
        hygiene = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
                   "-flags:a", "+bitexact", "-movflags", "+faststart"]
        for sequence in (video, audio, hygiene, ["-filter_complex_threads", "4"]):
            assert "\x00".join(sequence) in argv, sequence


def test_compile_rejects_other_sizes_qualities_and_modes(harness, probe_stub):
    plan = fixture_plan("seed__c30")
    probe_stub["streams"] = fake_probe(plan.doc)
    kwargs = {"source": SOURCE, "assets_root": ASSETS_ROOT}
    compile_job(plan, mode="final", size=(720, 1280), **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="final", size=(1080, 1920), **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="final", quality="tinggi", **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="preview", **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="frame", frame=plan.total_frames, **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="frame", **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="plate_cells", cells=(), **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="plate_cells", cells=(-1,), **kwargs)
    with pytest.raises(ValueError):
        compile_job(plan, mode="derive_image", **kwargs)  # no logo


def test_text_modes_need_the_caption_track(harness, probe_stub):
    context = fixtures.load_context("c30")
    plan = fixtures.make_render_plan(load_doc("seed__c30"), context.words)
    probe_stub["streams"] = fake_probe(plan.doc)
    for mode in ("final", "reference", "frame"):
        with pytest.raises(ValueError, match="caption"):
            compile_job(plan, mode=mode, source=SOURCE, assets_root=ASSETS_ROOT, frame=0)
    job = compile_job(plan, mode="plate_cells", cells=(620,), source=SOURCE,
                      assets_root=ASSETS_ROOT)
    assert "ass=" not in job.filter_script


def test_source_audio_must_match_the_document(harness, probe_stub):
    plan = fixture_plan("seed__c30")
    probe_stub["streams"] = dataclasses.replace(fake_probe(plan.doc), audio_index=None)
    with pytest.raises(Exception) as caught:
        compile_job(plan, mode="final", source=SOURCE, assets_root=ASSETS_ROOT)
    assert getattr(caught.value, "code", None) == "render_failed"


# --- R1/R2: frame identity and decoder runs ------------------------------------------------------


def piece(i, in_sf, out_sf, out_f0=0, seg="seg_b1"):
    return Piece(i, seg, "body", in_sf, out_sf, out_f0, out_sf - in_sf)


def test_decoder_runs_share_forward_pieces_closer_than_ten_seconds():
    fps = Fps(30000, 1001)
    ten_s = 300  # frames of 10 s at 29.97 (300 frames = 10.01 s)
    pieces = (
        piece(0, 38210, 38345, seg="seg_co"),  # cold open, later in the source
        piece(1, 37215, 37483),  # backwards: new run
        piece(2, 37556, 37813),  # gap 73 frames: shared
        piece(3, 37848, 38000),  # gap 35: shared
        piece(4, 38000 + ten_s, 38400),  # gap 300 frames ≥ 10 s: new run
        piece(5, 38400 + 299, 38800),  # gap 299 frames = 9.976 s: shared
    )
    assert decoder_runs(pieces, fps) == ((0,), (1, 2, 3), (4, 5))
    assert decoder_runs(pieces[:1], fps) == ((0,),)
    assert decoder_runs((), fps) == ()
    fps25 = Fps(25, 1)
    touching = (piece(0, 0, 100), piece(1, 100, 200), piece(2, 449, 500), piece(3, 750, 800))
    assert decoder_runs(touching, fps25) == ((0, 1, 2), (3,))


def test_seek_is_one_second_before_the_first_frame():
    assert seek_arg(300, Fps(30000, 1001)) == "9.010000"
    assert seek_arg(15, Fps(30000, 1001)) == "0.000000"
    assert seek_arg(30, Fps(30, 1)) == "0.000000"
    assert seek_arg(31, Fps(30, 1)) == "0.033333"
    assert seek_arg(38210, Fps(30000, 1001)) == "1273.940333"  # 38210·1001/30000 − 1
    assert seek_arg(100, Fps(24000, 1001)) == "3.170833"


def test_every_piece_uses_the_measured_grid_rule(harness, probe_stub):
    """R1: a decoder run of one piece is the PF string verbatim; a run of several keeps the
    same grid frames with one ``select`` on the grid index, never ``split`` into trims."""
    plan, job = compiled("removals_many__c30", probe_stub, mode="final")
    num, den = plan.fps.num, plan.fps.den
    runs = decoder_runs(plan.pieces, plan.fps)
    assert any(len(run) > 1 for run in runs) and any(len(run) == 1 for run in runs)
    sources = [spec for spec in job.inputs if spec.kind == "source"]
    assert len(sources) == len(runs)
    for r, (spec, run) in enumerate(zip(sources, runs)):
        first = plan.pieces[run[0]].in_sf
        assert spec.options[spec.options.index("-ss") + 1] == seek_arg(first, plan.fps)
        ranges = [(plan.pieces[i].in_sf, plan.pieces[i].out_sf) for i in run]
        if len(run) == 1:
            chain = (f"[{r}:0]fps={num}/{den},trim=start_pts={ranges[0][0]}:"
                     f"end_pts={ranges[0][1]},setpts=PTS-STARTPTS[vr{r}]")
        else:
            chain = (f"[{r}:0]fps={num}/{den},select='{select_expression(ranges)}',"
                     f"setpts=N[vr{r}]")
        assert job.filter_script.count(chain) == 1, run
    assert "split=" not in job.filter_script.replace("asplit=", "").replace(
        "[vcat]split=2", "")  # only fit_blur's own split remains
    assert "-copyts" in job.argv
    assert f"concat=n={len(runs)}:v=1:a=0,settb={den}/{num}[vcat]" in job.filter_script
    # R4: one layout chain after the join, however many cuts (one blur, two layout scales)
    assert job.filter_script.count("gblur=") == 1
    assert job.filter_script.count("force_original_aspect_ratio") == 2


def evaluate_select(expr: str, pts: int) -> bool:
    """Evaluate the ``select`` subset ``if(lt(pts,K),A,B)`` / ``between(pts,a,b)``."""
    if expr.startswith("between(pts,"):
        low, high = map(int, expr[len("between(pts,"):-1].split(","))
        return low <= pts <= high
    return bool(evaluate_tree(expr, pts, "pts", evaluate_select))


def evaluate_tree(expr, value, name, leaf):
    rest = expr[len(f"if(lt({name},"):]
    threshold, rest = rest.split(")", 1)
    body = rest[1:-1]
    depth = 0
    for position, char in enumerate(body):
        depth += char == "("
        depth -= char == ")"
        if char == "," and depth == 0:
            left, right = body[:position], body[position + 1:]
            break
    return leaf(left, value) if value < int(threshold) else leaf(right, value)


def test_select_expression_keeps_exactly_the_ranges():
    rng = random.Random(7)
    for count in (1, 2, 3, 7, 64, 500):
        ranges, position = [], rng.randint(0, 50)
        for _ in range(count):
            start = position + rng.randint(0, 40)
            end = start + rng.randint(1, 30)
            ranges.append((start, end))
            position = end
        expr = select_expression(ranges)
        wanted = {sf for a, b in ranges for sf in range(a, b)}
        for pts in range(ranges[-1][1] + 5):
            assert evaluate_select(expr, pts) == (pts in wanted), (count, pts)
        depth = deepest = 0
        for char in expr:
            depth += (char == "(") - (char == ")")
            deepest = max(deepest, depth)
        assert deepest <= 2 * (count - 1).bit_length() + 2  # balanced
    for bad in ([], [(5, 5)], [(10, 20), (15, 30)], [(10, 20), (0, 5)]):
        with pytest.raises(ValueError):
            select_expression(bad)


def test_source_audio_labels_follow_the_decoder_runs(harness, probe_stub):
    plan, job = compiled("removals_many__c30", probe_stub, mode="final")
    graph = job.filter_script
    for p in plan.pieces:
        assert graph.count(f"[sa{p.i}]") == 2  # produced once, consumed once by the fragment
    runs = decoder_runs(plan.pieces, plan.fps)
    for k, run in enumerate(runs):
        labels = "".join(f"[sa{i}]" for i in run)
        if len(run) > 1:
            assert f"[{k}:1]asplit={len(run)}{labels}" in graph
        else:
            assert f"[{k}:1]anull{labels}" in graph
    assert graph.count("[apre]") == 2


def test_a_source_without_audio_has_no_source_audio_labels(harness, probe_stub):
    doc = load_doc("seed__c30")
    doc["base"]["source"]["has_audio"] = False
    _plan, job = compiled("seed__c30", probe_stub, doc=doc, mode="final")
    assert "[sa" not in job.filter_script and ":1]" not in job.filter_script
    assert "anullsrc" in job.filter_script


def test_fragment_inputs_follow_the_video_inputs(harness, probe_stub, monkeypatch):
    real = HARNESS.harness_audio_fragment
    seen = {}

    def fragment(plan, *, mode, first_input_index):
        seen["first"] = first_input_index
        seen["mode"] = mode
        base = real(plan, mode=mode, first_input_index=first_input_index)
        spec = compile_ffmpeg.InputSpec("sidecar", "audio-env.f32",
                                        ("-f", "f32le", "-ar", "48000", "-ac", "1"))
        graph = base.graph + f";\n[{first_input_index}:a]anullsink"
        return dataclasses.replace(base, graph=graph, inputs=(spec,),
                                   sidecars={"audio-env.f32": b"\0" * 8})

    from ai_clipper.edit_v2 import audio_graph

    monkeypatch.setattr(audio_graph, "audio_fragment", fragment)
    plan, job = compiled("logo__c30", probe_stub, mode="final")
    runs = decoder_runs(plan.pieces, plan.fps)
    assert seen == {"first": len(runs) + 1, "mode": "final"}  # sources, then the logo
    assert job.inputs[len(runs)].kind == "asset"
    assert job.inputs[len(runs) + 1] == compile_ffmpeg.InputSpec(
        "sidecar", "audio-env.f32", ("-f", "f32le", "-ar", "48000", "-ac", "1"))
    assert job.sidecars["audio-env.f32"] == b"\0" * 8
    for mode, first in (("audio_preview", len(runs)), ("audio_measure", len(runs)),
                        ("reference", len(runs) + 1)):
        compile_job(plan, mode=mode, source=SOURCE, assets_root=ASSETS_ROOT)
        assert seen == {"first": first, "mode": mode}


def test_fragment_sidecar_names_are_checked(harness, probe_stub, monkeypatch):
    from ai_clipper.edit_v2 import audio_graph

    real = HARNESS.harness_audio_fragment
    monkeypatch.setattr(
        audio_graph, "audio_fragment",
        lambda plan, *, mode, first_input_index: dataclasses.replace(
            real(plan, mode=mode, first_input_index=first_input_index),
            sidecars={"../escape.f32": b""}))
    with pytest.raises(ValueError):
        compiled("seed__c30", probe_stub, mode="final")


# --- master stage and audio modes -------------------------------------------------------------------


def test_master_stage(harness, probe_stub):
    _plan, job = compiled("seed__c30", probe_stub, mode="final")
    assert ("[apre]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:"
            "channel_layouts=stereo[aout]") in job.filter_script
    assert "volume=" not in job.filter_script
    assert job.expected["gain_cdb"] == 0
    _plan, job = compiled("music__c30", probe_stub, mode="final", loudness=Loudness(-1650, -40))
    assert "[apre]volume=-0.60dB,aresample=48000,aformat=sample_fmts=fltp" in job.filter_script
    assert job.expected["gain_cdb"] == -60
    _plan, job = compiled("music__c30", probe_stub, mode="reference",
                          loudness=Loudness(-1650, -40))
    assert ("[apre]volume=-0.60dB,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:"
            "channel_layouts=stereo[aout]") in job.filter_script
    _plan, job = compiled("music__c30", probe_stub, mode="audio_preview",
                          loudness=Loudness(-1650, -40))
    assert "aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[aout]" in (
        job.filter_script)
    assert job.argv[job.argv.index("-c:a") + 1] == "flac"


def test_measurement_is_required_exactly_when_the_document_needs_it(harness, probe_stub):
    with pytest.raises(ValueError, match="measure"):
        compiled("music__c30", probe_stub, mode="final")
    with pytest.raises(ValueError, match="measure"):
        compiled("seed__c30", probe_stub, mode="final", loudness=Loudness(-1400, -300))
    _plan, job = compiled("music__c30", probe_stub, mode="audio_measure")
    # audio_graph.master_filter("audio_measure", …): framelog=verbose keeps the per-frame lines
    # out of the info log, so only the summary is printed (W1 integration, T1.4's request)
    assert job.filter_script.rstrip().endswith(
        "[apre]aformat=sample_fmts=dbl,ebur128=peak=true:framelog=verbose[ameas]")
    assert job.argv[-3:] == ("-f", "null", "-")
    assert job.argv[job.argv.index("-loglevel") + 1] == "info"
    assert "[v" not in job.filter_script  # no video in the audio modes


def test_audio_modes_decode_like_the_final(harness, probe_stub):
    _plan, final = compiled("removals_many__c30", probe_stub, mode="final")
    _plan, preview = compiled("removals_many__c30", probe_stub, mode="audio_preview")
    sources = [spec for spec in final.inputs if spec.kind == "source"]
    assert [spec for spec in preview.inputs if spec.kind == "source"] == sources
    assert "fps=" not in preview.filter_script


# --- R3/R5: explicit conversions and text compositing -----------------------------------------------


@pytest.mark.parametrize("composite", compile_ffmpeg.COMPOSITE_FORMATS)
def test_every_format_change_is_an_explicit_scale(harness, probe_stub, monkeypatch, composite):
    monkeypatch.setattr(compile_ffmpeg, "COMPOSITE_FORMAT", composite)
    for name in ("logo__c30", "seed__c25", "seed__c24"):
        plan = fixture_plan(name)
        first_cell = plan.pieces[0].in_sf // tm.cell_frames(plan.fps)
        for mode, extra in (("final", {}), ("frame", {"frame": 5}),
                            ("plate_cells", {"cells": (first_cell,)})):
            _plan, job = compiled(name, probe_stub, mode=mode, **extra)
            for chain in re.split(r";\s*", job.filter_script):
                filters = re.sub(r"\[[^\]]*\]", "\x00", chain).split(",")
                for index, item in enumerate(filters):
                    item = item.strip("\x00")
                    if item.startswith("format="):
                        before = filters[index - 1].strip("\x00")
                        assert before.startswith("scale"), (name, mode, chain)
                    if item.startswith("scale=") and "flags=lanczos" not in item:
                        assert "matrix" in item, item
                        if "force_original_aspect_ratio" in item:
                            assert "in_color_matrix=" in item and "out_color_matrix=bt709" in item
                            assert "out_range=tv" in item


def test_text_compositing_order(harness, probe_stub):
    plan, job = compiled("logo__c30", probe_stub, mode="final")
    graph = job.filter_script
    ass = graph.index("ass=filename=captions.ass:fontsdir=fonts:shaping=complex")
    overlay = graph.index("overlay=x=")
    last = graph.index("format=yuv420p[vout]")
    assert graph.index("settb=") < ass < overlay < last
    # R5 with the S-COLOR decision (docs/editor/SPIKES.md §1): into gbrp naming the input
    # matrix, the text, the logo in gbrp, back to BT.709/tv 4:2:0.
    assert compile_ffmpeg.COMPOSITE_FORMAT == "gbrp"
    assert ("[vlay]scale=in_color_matrix=bt709:in_range=tv,format=gbrp,"
            "ass=filename=captions.ass:fontsdir=fonts:shaping=complex[vtext]") in graph
    logo = plan.logo
    assert f"overlay=x={logo.x}:y={logo.y}:format=gbrp" in graph
    assert "[vlogo]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]" in graph
    assert (f"scale={logo.w}:{logo.h}:flags=lanczos,format=rgba,colorchannelmixer=aa=0.850"
            in graph)


# --- R4: layouts ------------------------------------------------------------------------------------


def test_fit_blur_sigma_scales_with_the_height():
    assert layouts.blur_sigma(1280) == "35"
    assert layouts.blur_sigma(1920) == "52.5"
    assert layouts.blur_sigma(640) == "17.5"


def test_layout_chains_keep_the_legacy_render_operations():
    """layouts.py starts from render.py's filter strings (imported, not modified)."""
    for mode, legacy_mode in (("fit_blur", "fit-blur"), ("fill_center", "center-crop")):
        legacy = render._layout_filter(Path("unused"), input_label="[in]", start=0.0, end=1.0,
                                       width=720, height=1280, render_mode=legacy_mode,
                                       label_suffix="_7")
        chain = layouts.layout_chain(mode, label_in="[in]", label_out="[out]", suffix="_7",
                                     output=(720, 1280), source=(1280, 720), matrix="bt709",
                                     in_range="tv")
        conversion = ":in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv"
        # the fit-blur foreground converts to yuva444p: overlay's yuv444 mode takes its second
        # input only with alpha, so the conversion is explicit instead of an auto-inserted scale
        simplified = (chain.replace(conversion + ",format=yuv444p", "")
                      .replace(conversion + ",format=yuva444p", "")
                      .replace(":format=yuv444", ""))
        assert simplified == legacy + "[out]"
        if mode == "fit_blur":
            assert "force_original_aspect_ratio=decrease" + conversion + ",format=yuva444p[" in chain
    camera = layouts.layout_chain("camera", label_in="[in]", label_out="[out]", suffix="_1",
                                  output=(720, 1280), source=(1280, 720), matrix="bt601",
                                  in_range="pc", crop=(0, 0, 2, 4))
    assert camera.startswith("[in]scale=720:1280:force_original_aspect_ratio=increase:"
                             "in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:"
                             "out_range=tv,format=yuv444p,crop=720:1280:x='")
    assert camera.endswith("':y=(ih-oh)/2,setsar=1[out]")


def test_scaled_size_matches_ffmpeg_increase():
    assert layouts.scaled_size((1280, 720), (720, 1280)) == (2276, 1280)
    assert layouts.scaled_size((640, 360), (720, 1280)) == (2276, 1280)
    assert layouts.scaled_size((1920, 1080), (1080, 1920)) == (3413, 1920)
    assert layouts.scaled_size((720, 1280), (720, 1280)) == (720, 1280)
    assert layouts.scaled_size((480, 1080), (720, 1280)) == (720, 1620)


def test_color_matrix_from_the_probe():
    assert layouts.color_matrix("bt709", 360) == "bt709"
    assert layouts.color_matrix("smpte170m", 1080) == "bt601"
    assert layouts.color_matrix("bt470bg", 1080) == "bt601"
    assert layouts.color_matrix(None, 720) == "bt709"
    assert layouts.color_matrix("unknown", 719) == "bt601"
    assert layouts.color_matrix("bt2020nc", 2160) == "bt2020"


def evaluate(expr: str, n: int) -> int:
    """Evaluate the crop expression subset ``if(lt(n,K),A,B)`` / integer."""
    expr = expr.strip()
    if not expr.startswith("if(lt(n,"):
        return int(expr)
    rest = expr[len("if(lt(n,"):]
    threshold, rest = rest.split(")", 1)
    assert rest[0] == "," and expr.endswith(")")
    body = rest[1:-1]
    depth = 0
    for position, char in enumerate(body):
        depth += char == "("
        depth -= char == ")"
        if char == "," and depth == 0:
            left, right = body[:position], body[position + 1:]
            break
    return evaluate(left, n) if n < int(threshold) else evaluate(right, n)


def test_crop_expression_is_a_balanced_integer_tree():
    values = [0, 0, 2, 2, 2, 8, 8, 10, 12, 12, 12, 12, 0]
    expr = layouts.crop_expression(values)
    assert [evaluate(expr, n) for n in range(len(values))] == values
    assert evaluate(expr, 99) == 0
    assert "t" not in expr.replace("lt(", "")
    assert layouts.crop_expression([4, 4, 4]) == "4"
    long = [2 * (i // 3) for i in range(9000)]
    expr = layouts.crop_expression(long)
    depth = deepest = 0
    for char in expr:
        depth += (char == "(") - (char == ")")
        deepest = max(deepest, depth)
    assert deepest <= 14  # log2(3000 runs) + 2: a balanced tree, not a 3000-deep chain
    assert all(evaluate(expr, n) == long[n] for n in range(0, 9000, 97))


def reference_crop(camera, sf, fps, source, output):
    """Float reference: build_crop_expression's interpolation at the frame start time."""
    scaled = layouts.scaled_size(source, output)[0]
    samples = camera["samples"]
    times = [t / 1000 for t, _c in samples]
    positions = [min(max(round(c / 1000 * scaled - output[0] / 2), 0), scaled - output[0])
                 for _t, c in samples]
    t = sf * fps.den / fps.num
    if t < times[0]:
        return positions[0]
    for index in range(len(times) - 1):
        if t < times[index + 1]:
            if camera["cuts"][index + 1] or positions[index] == positions[index + 1]:
                return positions[index]
            return positions[index] + (positions[index + 1] - positions[index]) * (
                t - times[index]) / (times[index + 1] - times[index])
    return positions[-1]


def test_camera_crop_is_an_even_integer_per_source_frame():
    fps = Fps(30000, 1001)
    camera = HARNESS.make_camera(60_000, (30000, 1001), (1280, 720), (720, 1280))
    values = layouts.crop_positions(camera, fps, source=(1280, 720), output=(720, 1280),
                                    first_sf=0, count=1700)
    assert len(values) == 1700
    assert all(isinstance(v, int) and v % 2 == 0 and 0 <= v <= 2276 - 720 for v in values)
    for sf in range(0, 1700, 7):
        assert abs(values[sf] - reference_crop(camera, sf, fps, (1280, 720), (720, 1280))) <= 1.5
    window = layouts.crop_positions(camera, fps, source=(1280, 720), output=(720, 1280),
                                    first_sf=500, count=40)
    assert window == values[500:540]
    # the float expression of today's renderer agrees too
    samples = camera["samples"]
    expression = face_tracking.build_crop_expression(
        [t / 1000 for t, _c in samples], [c / 1000 for _t, c in samples], cuts=camera["cuts"],
        source_width=1280, source_height=720, output_width=720, output_height=1280)
    assert expression.startswith("if(lt(t,")


def test_camera_crop_holds_across_a_cut_and_outside_the_samples():
    fps = Fps(25, 1)
    camera = {"samples": [[1000, 500], [2000, 900], [3000, 100]], "cuts": [False, False, True]}
    values = layouts.crop_positions(camera, fps, source=(1920, 1080), output=(720, 1280),
                                    first_sf=0, count=100)
    p0 = 778  # round_half_up(0.5 · 2276 − 360), even
    assert values[0] == values[24] == values[25] == p0  # before the first sample: held
    assert values[50] != values[25] and values[37] not in (values[25], values[50])  # linear
    assert values[50:75] == (values[50],) * 25  # the next sample is a cut: held
    assert values[75] == values[99] == 0  # last sample (clamped at 0) is held


def test_camera_crop_is_the_same_in_plate_cells_and_in_final_pieces(harness, probe_stub):
    doc = load_doc("seed__c25")  # camera layout, 25 fps
    body = doc["main"]["segments"][0]
    doc["main"]["removals"] = [
        {"id": f"rm_{k}", "seg": body["id"], "in_sf": body["in_sf"] + start,
         "out_sf": body["in_sf"] + start + length, "words": [], "reason": "user",
         "origin": "user"}
        for k, (start, length) in enumerate(((40, 7), (95, 30), (171, 2)))]
    plan = fixture_plan("seed__c25", doc=doc)
    probe_stub["streams"] = fake_probe(plan.doc)
    final = compile_job(plan, mode="final", source=SOURCE, assets_root=ASSETS_ROOT)
    first = plan.pieces[0].in_sf // 50
    cells = list(range(first, first + 6))
    plate = compile_job(plan, mode="plate_cells", cells=cells, source=SOURCE,
                        assets_root=ASSETS_ROOT)
    crop = re.compile(r"crop=\d+:\d+:x='([^']*)'")
    (final_expr,) = crop.findall(final.filter_script)  # one layout chain after the join
    trims = {int(run): int(start) for start, run in re.findall(
        r"trim=start_pts=(\d+):end_pts=\d+,setpts=PTS-STARTPTS\[pt(\d+)\]", plate.filter_script)}
    plate_exprs = {int(run): expr for run, expr in re.findall(
        r"\[pt(\d+)\]settb=[^;]*?crop=\d+:\d+:x='([^']*)'", plate.filter_script)}
    assert set(trims) == set(plate_exprs) == {0}  # the six cells are one run
    run_start, cell_end = trims[0], (first + 6) * 50
    checked = 0
    for n in range(plan.total_frames):
        sf = tm.out_to_src(n, plan.pieces)[1]
        value = evaluate(final_expr, n)
        assert value == layouts.crop_positions(plan.camera, plan.fps, source=(1920, 1080),
                                               output=(720, 1280), first_sf=sf, count=1)[0]
        if run_start <= sf < cell_end:
            assert value == evaluate(plate_exprs[0], sf - run_start), n
            checked += 1
    assert checked > 200
    assert len(plan.pieces) == 4  # the cuts are crossed: output n and source sf diverge
# --- modes ------------------------------------------------------------------------------------------


def test_frame_mode_shifts_pts_so_ass_sees_now_ms(harness, probe_stub):
    plan, job = compiled("full_example__c30", probe_stub, mode="frame", frame=150)
    _piece, sf = tm.out_to_src(150, plan.pieces)
    num, den = plan.fps.num, plan.fps.den
    assert (f"fps={num}/{den},trim=start_pts={sf}:end_pts={sf + 1},setpts=PTS-STARTPTS+150["
            in job.filter_script)
    assert f"settb={den}/{num}" in job.filter_script
    assert "concat" not in job.filter_script
    argv = list(job.argv)
    assert argv[argv.index("-frames:v") + 1] == "1"
    assert argv[argv.index("-crf") + 1] == "21"
    assert "[aout]" not in argv
    assert job.expected["output"] == "png"
    post = job.expected["post"]
    assert post[0] == "ffmpeg" and "scale=in_color_matrix=bt709:in_range=tv,format=rgb24" in post
    spec = next(spec for spec in job.inputs if spec.kind == "source")
    assert spec.options[spec.options.index("-ss") + 1] == seek_arg(sf, plan.fps)


def test_plate_cells_are_layout_only_segmented_idr_cells(harness, probe_stub):
    _plan, job = compiled("logo__c30", probe_stub, mode="plate_cells",
                          cells=(622, 620, 621, 700, 700))
    argv = list(job.argv)
    graph = job.filter_script
    assert "ass=" not in graph and "overlay=x=" not in graph and "[sa" not in graph
    assert "trim=start_pts=37200:end_pts=37380" in graph  # cells 620..622, C = 60
    assert "trim=start_pts=42000:end_pts=42060" in graph
    assert argv.count("-f") >= 2 and argv.count("segment") == 2
    starts = [argv[i + 1] for i, t in enumerate(argv) if t == "-segment_start_number"]
    frames = [argv[i + 1] for i, t in enumerate(argv) if t == "-segment_frames"]
    assert starts == ["620", "700"] and frames == ["60,120,180", "60"]
    for flag, value in (("-force_key_frames", "expr:eq(mod(n,60),0)"), ("-sc_threshold", "0"),
                        ("-bf", "0"), ("-forced-idr", "1"), ("-crf", "18"), ("-g", "60"),
                        ("-reset_timestamps", "1"), ("-segment_format", "mp4")):
        assert [argv[i + 1] for i, t in enumerate(argv) if t == flag] == [value, value], flag
    assert job.expected["output"] == "cells"
    assert job.expected["cells"] == {"620": 60, "621": 60, "622": 60, "700": 60}
    assert "[aout]" not in argv


# --- real FFmpeg --------------------------------------------------------------------------------------


@dataclasses.dataclass
class Clip:
    source: Path
    doc: dict
    words: dict
    grid: list


def synthetic_clip(tmp_path, *, fps=(30000, 1001), frames=450, layout="fit_blur",
                   cold_open=(300, 330), body=(60, 420),
                   removals=((100, 112), (150, 153), (200, 260), (300, 302)),
                   scene_cut_every=0, audio=True, hook=None, vfr=False, drop_every=0) -> Clip:
    spec = media.VideoSpec(width=640, height=360, fps=fps, frames=frames,
                           scene_cut_every=scene_cut_every, vfr=vfr, drop_every=drop_every,
                           container="mkv" if vfr else "mp4",
                           audio=media.AudioSpec() if audio else None)
    source = media.make_barcode_video(tmp_path / ("source.mkv" if vfr else "source.mp4"), spec)
    duration_ms = frames * 1000 * fps[1] // fps[0]
    info = HARNESS.SourceInfo(640, 360, fps, vfr, duration_ms, audio)
    doc = HARNESS.make_doc(info, fps=fps, body=body, cold_open=cold_open, removals=removals,
                           layout=layout, hook=hook)
    return Clip(source, doc, HARNESS.make_words(duration_ms), media.grid_indices(source, fps))


def run_to_file(job, path: Path, timeout_s=120.0):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        return execute.run(job, output_fd=fd, timeout_s=timeout_s)
    finally:
        os.close(fd)


def run_cells(job, directory: Path, timeout_s=120.0):
    directory.mkdir(exist_ok=True)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        return execute.run(job, output_fd=fd, timeout_s=timeout_s)
    finally:
        os.close(fd)


def decoded_indices(path: Path, *, scale: float, top: float):
    pattern = media.Pattern.for_size(640, 360)
    return [media.decode_index(plane, 720, 1280, pattern, scale=scale, top=top)
            for plane in HARNESS.iter_gray_frames(path, (720, 1280))]


FIT_BLUR_GEOMETRY = {"scale": 720 / 640, "top": (1280 - 360 * 720 / 640) / 2}
CROP_GEOMETRY = {"scale": 1280 / 360, "top": 0.0}


@pytest.mark.parametrize("source", ["cfr_29.97", "vfr_30"])
def test_final_and_plate_frames_are_the_grid_frames(harness, tmp_path, edit_v2_libass, source):
    """P-FRAME on PR: every output frame of plate and final shows ``grid[out_to_src(n)]``."""
    if source == "vfr_30":  # Matroska, ms timestamps with jitter, every 11th frame dropped
        clip = synthetic_clip(tmp_path, fps=(30, 1), vfr=True, drop_every=11)
    else:
        clip = synthetic_clip(tmp_path)
    assert None not in clip.grid
    plan = build_plan(clip.doc, words=clip.words, camera=None, assets={},
                      resources=Resources(tmp_path / "resources"))
    final = compile_job(plan, mode="final", source=clip.source, assets_root=tmp_path)
    result = run_to_file(final, tmp_path / "final.mp4")
    assert result.returncode == 0
    expected = [clip.grid[tm.out_to_src(n, plan.pieces)[1]] for n in range(plan.total_frames)]
    got = decoded_indices(tmp_path / "final.mp4", **FIT_BLUR_GEOMETRY)
    assert len(got) == plan.total_frames
    assert sum(a != b for a, b in zip(got, expected)) == 0

    cell_frames = tm.cell_frames(plan.fps)
    cells = sorted({sf // cell_frames for p in plan.pieces for sf in range(p.in_sf, p.out_sf)})
    plate = compile_job(plan, mode="plate_cells", cells=cells, source=clip.source,
                        assets_root=tmp_path)
    run_cells(plate, tmp_path / "cells")
    decoded = {k: decoded_indices(tmp_path / "cells" / f"c{k:07d}.mp4", **FIT_BLUR_GEOMETRY)
               for k in cells}
    mismatches = 0
    for n in range(plan.total_frames):
        sf = tm.out_to_src(n, plan.pieces)[1]
        mismatches += decoded[sf // cell_frames][sf % cell_frames] != clip.grid[sf]
    assert mismatches == 0
    assert 2 * plan.total_frames >= 300


def test_probe_uses_the_legacy_stream_selection(tmp_path, edit_v2_ffmpeg):
    mp4 = media.make_barcode_video(tmp_path / "a.mp4", media.VideoSpec(frames=30))
    streams = compile_ffmpeg.probe_source(mp4)
    duration, video, audio = render._probe_source(mp4)
    assert (streams.video_index, streams.audio_index, streams.duration_s) == (video, audio,
                                                                              duration)
    assert (streams.width, streams.height, streams.color_space) == (640, 360, "bt709")
    # Matroska states no stream duration; the compiler needs none (the container's is kept)
    mkv = media.make_barcode_video(tmp_path / "b.mkv",
                                   media.VideoSpec(frames=30, container="mkv"))
    streams = compile_ffmpeg.probe_source(mkv)
    assert (streams.video_index, streams.audio_index) == (0, 1)
    assert 0.9 < streams.duration_s < 1.2
    silent = media.make_barcode_video(tmp_path / "c.mp4",
                                      media.VideoSpec(frames=30, audio=None))
    assert compile_ffmpeg.probe_source(silent).audio_index is None
    (tmp_path / "broken.mp4").write_bytes(b"not a video")
    with pytest.raises(Exception) as caught:
        compile_ffmpeg.probe_source(tmp_path / "broken.mp4")
    assert getattr(caught.value, "code", None) == "render_failed"


def keyframes(path: Path) -> list[int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "frame=key_frame,pict_type", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout.split()
    return [i for i, row in enumerate(out) if row.startswith("1")]


@pytest.mark.parametrize("layout", ["fill_center", "fit_blur"])
def test_plate_cells_have_exact_frames_and_an_idr_at_every_start(harness, tmp_path,
                                                                  edit_v2_ffmpeg, layout):
    clip = synthetic_clip(tmp_path, frames=420, layout=layout, scene_cut_every=7,
                          cold_open=None, body=(30, 400), removals=())
    plan = build_plan(clip.doc, words=clip.words, camera=None, assets={},
                      resources=Resources(tmp_path / "resources"))
    job = compile_job(plan, mode="plate_cells", cells=(1, 2, 3, 5), source=clip.source,
                      assets_root=tmp_path)
    result = run_cells(job, tmp_path / "cells")
    assert sorted(result.files) == [f"c{k:07d}.mp4" for k in (1, 2, 3, 5)]
    for k in (1, 2, 3, 5):
        path = tmp_path / "cells" / f"c{k:07d}.mp4"
        assert keyframes(path) == [0]
        geometry = CROP_GEOMETRY if layout == "fill_center" else FIT_BLUR_GEOMETRY
        indices = decoded_indices(path, **geometry)  # cells 1-3 and 5 are two plate runs
        assert indices == clip.grid[k * 60:(k + 1) * 60]
        nal = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v",
                              "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-frames:v", "1",
                              "-f", "h264", "-"], capture_output=True, check=True).stdout
        types = {match[0] & 0x1F for match in re.findall(rb"\x00\x00\x01(.)", nal, re.DOTALL)}
        assert 5 in types  # IDR slice


def hazard_frame(fps: Fps, start: int) -> int:
    n = start
    while tm.now_ms(n, fps) * fps.num == n * 1000 * fps.den or (n * 1000 * fps.den) % fps.num:
        n += 1
    return n


def test_frame_mode_matches_the_final_at_ass_hazard_frames(harness, tmp_path, monkeypatch,
                                                           edit_v2_libass):
    fps = Fps(30, 1)
    clip = synthetic_clip(tmp_path, fps=(30, 1), frames=240, cold_open=None, body=(30, 210),
                          removals=())
    first = hazard_frame(fps, 40)  # 111: FFmpeg's double gives 3699 ms, not 3700
    last = first + 12
    assert tm.now_ms(first, fps) < first * 1000 // 30  # a truncation hazard

    def box_track(doc, words, pieces):
        start, end = tm.safe_cs(first, fps), tm.safe_cs(last, fps)
        ass = "\n".join([
            "[Script Info]", "ScriptType: v4.00+", "PlayResX: 720", "PlayResY: 1280", "",
            "[V4+ Styles]",
            ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
             "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
             "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"),
            ("Style: Box,DejaVu Sans,20,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,"
             "100,100,0,0,1,0,0,7,0,0,0,1"), "", "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            (f"Dialogue: 0,{HARNESS._ass_time(start)},{HARNESS._ass_time(end)},Box,,0,0,0,,"
             "{\\pos(0,1100)\\p1}m 0 0 l 720 0 720 100 0 100{\\p0}"), ""])
        return captions.CaptionResult((), ass, hashlib.sha256(ass.encode()).hexdigest(), (), ())

    monkeypatch.setattr(captions, "caption_track", box_track)
    plan = build_plan(clip.doc, words=clip.words, camera=None, assets={},
                      resources=Resources(tmp_path / "resources"))

    def box_on(plane: bytes, width=720) -> bool:
        rows = [plane[y * width + 360] for y in range(1110, 1190, 10)]
        return min(rows) > 200

    final = compile_job(plan, mode="final", source=clip.source, assets_root=tmp_path)
    run_to_file(final, tmp_path / "final.mp4")
    planes = list(HARNESS.iter_gray_frames(tmp_path / "final.mp4", (720, 1280)))
    for n in (first - 1, first, last - 1, last):
        job = compile_job(plan, mode="frame", frame=n, source=clip.source, assets_root=tmp_path)
        png = execute.run(job, output_fd=None, timeout_s=60).output
        gray = HARNESS.png_to_gray(png, (720, 1280))
        expected = first <= n < last
        assert box_on(gray) is expected, n
        assert box_on(planes[n]) is expected, n


def test_camera_crop_decoded_from_the_ruler_matches_the_plan(harness, tmp_path, edit_v2_ffmpeg):
    """P-PLATE crop part on PR: crop x of plate and final (reference) equals the plan."""
    clip = synthetic_clip(tmp_path, frames=330, layout="camera", cold_open=(240, 270),
                          body=(40, 200), removals=((90, 96), (130, 131)))
    camera = HARNESS.make_camera(clip.doc["base"]["source"]["duration_ms"], (30000, 1001),
                                 (640, 360), (720, 1280))
    plan = build_plan(clip.doc, words=clip.words, camera=camera, assets={},
                      resources=Resources(tmp_path / "resources"))
    reference = compile_job(plan, mode="reference", source=clip.source, assets_root=tmp_path)
    run_to_file(reference, tmp_path / "reference.mkv")
    cells = sorted({sf // 60 for p in plan.pieces for sf in range(p.in_sf, p.out_sf)})
    plate = compile_job(plan, mode="plate_cells", cells=cells, source=clip.source,
                        assets_root=tmp_path)
    run_cells(plate, tmp_path / "cells")
    pattern = media.Pattern.for_size(640, 360)
    scaled = layouts.scaled_size((640, 360), (720, 1280))[0]

    def crop_x(plane):
        return media.decode_crop_x(plane, 720, 1280, pattern, scale=scaled / 640)

    table = layouts.crop_positions(camera, plan.fps, source=(640, 360), output=(720, 1280),
                                   first_sf=0, count=330)
    ref_planes = list(HARNESS.iter_gray_frames(tmp_path / "reference.mkv", (720, 1280)))
    assert len(ref_planes) == plan.total_frames
    cell_planes = {k: list(HARNESS.iter_gray_frames(tmp_path / "cells" / f"c{k:07d}.mp4",
                                                    (720, 1280))) for k in cells}
    for n in range(plan.total_frames):
        sf = tm.out_to_src(n, plan.pieces)[1]
        assert crop_x(ref_planes[n]) == table[sf], n
        assert crop_x(cell_planes[sf // 60][sf % 60]) == table[sf], n


def test_no_implicit_video_conversions(harness, tmp_path, monkeypatch, edit_v2_libass):
    """R3: every conversion is explicit, so FFmpeg never auto-inserts a scale filter."""
    clip = synthetic_clip(tmp_path, frames=200, cold_open=(150, 170), body=(20, 140),
                          removals=((50, 60),), hook=("Halo", 30))
    logo = media.make_logo_png(tmp_path / "logo.png", 64, 32)
    digest = hashlib.sha256(logo.read_bytes()).hexdigest()
    (tmp_path / "assets").mkdir()
    logo.rename(tmp_path / "assets" / f"{digest}.png")
    asset = f"sha256:{digest}"
    meta = {asset: {"kind": "image", "mime": "image/png", "w": 64, "h": 32}}
    for layout, composite in (("fit_blur", "yuv444p"), ("fill_center", "gbrp"),
                              ("fit_blur", "yuv420p")):
        clip.doc["layout"]["default"]["mode"] = layout
        clip.doc["tracks"] = [t for t in clip.doc["tracks"] if t["kind"] != "visual"]
        clip.doc["tracks"].append({"id": "tr_ovr", "kind": "visual", "band": "over_text",
                                   "role": "overlay", "items": [{
                                       "id": "it_logo", "type": "image",
                                       "start": {"at": "clip_start"},
                                       "end": {"at": "clip_end"},
                                       "transform": {"x_e5": 50000, "y_e5": 50000,
                                                     "w_e5": 20000, "opacity_pm": 700},
                                       "payload": {"asset": asset, "mode": "free"},
                                       "origin": "user"}]})
        clip.doc["assets"] = meta
        monkeypatch.setattr(compile_ffmpeg, "COMPOSITE_FORMAT", composite)
        plan = build_plan(clip.doc, words=clip.words, camera=None, assets=meta,
                          resources=Resources(tmp_path / "resources"))
        job = compile_job(plan, mode="final", source=clip.source,
                          assets_root=tmp_path / "assets")
        argv = list(job.argv)
        argv[argv.index("-loglevel") + 1] = "verbose"
        verbose = dataclasses.replace(job, argv=tuple(argv))
        result = run_to_file(verbose, tmp_path / f"final-{layout}-{composite}.mp4")
        assert result.returncode == 0
        assert "auto_scale" not in result.stderr, (layout, composite)
        assert "auto-inserting" not in result.stderr, (layout, composite)


def test_execution_is_deterministic(harness, tmp_path, edit_v2_ffmpeg):
    """G-DET (bitstream): two runs of the same job give identical bytes."""
    clip = synthetic_clip(tmp_path, frames=150, cold_open=None, body=(10, 120),
                          removals=((40, 44),))
    plan = build_plan(clip.doc, words=clip.words, camera=None, assets={},
                      resources=Resources(tmp_path / "resources"))
    job = compile_job(plan, mode="final", source=clip.source, assets_root=tmp_path)
    run_to_file(job, tmp_path / "a.mp4")
    run_to_file(job, tmp_path / "b.mp4")
    assert (tmp_path / "a.mp4").read_bytes() == (tmp_path / "b.mp4").read_bytes()


def test_fraction_free_seek_matches_the_rational_value():
    for fps in (Fps(24000, 1001), Fps(25, 1), Fps(30000, 1001)):
        for sf in (0, 1, 29, 30, 31, 1799, 108_000):
            value = Fraction(sf * fps.den, fps.num) - 1
            expected = max(value, Fraction(0))
            micro = int(expected * 1_000_000)
            assert seek_arg(sf, fps) == f"{micro // 1_000_000}.{micro % 1_000_000:06d}"


def test_the_gate_cases_meet_the_p_frame_size_by_construction():
    """P-FRAME (scripts/parity/frame_identity.py): 4 sources, each with a cold open and 20
    removals, ≥ 2,000 output frames in total (plate and final are each checked on all)."""
    total = 0
    for case in HARNESS.P_FRAME_CASES:
        edges = HARNESS.case_edges(case)
        duration_ms = case.frames * 1000 * case.fps[1] // case.fps[0]
        info = HARNESS.SourceInfo(640, 360, case.fps, case.vfr, duration_ms, True)
        doc = HARNESS.make_doc(info, fps=case.fps, body=edges["body"],
                               cold_open=edges["cold_open"], removals=edges["removals"],
                               layout=case.layout)
        pieces = tm.pieces(doc)
        assert len(doc["main"]["removals"]) == 20 and pieces[0].role == "cold_open"
        assert len(pieces) == 22  # no removal leaves a sliver: every cut is a join
        assert decoder_runs(pieces, Fps(*case.fps)) == ((0,), tuple(range(1, 22)))
        total += tm.total_frames(pieces)
    assert {case.fps for case in HARNESS.P_FRAME_CASES} == {(30000, 1001), (25, 1), (30, 1)}
    assert [case.vfr for case in HARNESS.P_FRAME_CASES].count(True) == 1
    assert total >= HARNESS.P_FRAME_MIN_FRAMES
