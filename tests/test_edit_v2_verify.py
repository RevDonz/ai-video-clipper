"""verify_output on good and deliberately broken files: G1 container, G2 A/V counts, G3 loudness,
G3b true peak (blocking) and G5 text-safe geometry (warning) (plan §5.9)."""

from __future__ import annotations

import copy
import dataclasses
import os
import subprocess
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_compile import run_to_file, synthetic_clip
from test_edit_v2_plan import HARNESS

from ai_clipper.edit_v2 import errors, loudness, verify
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.compile_ffmpeg import compile_job
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.loudness import Loudness
from ai_clipper.edit_v2.plan import Resources, build_plan

FPS = (30000, 1001)
FRAMES = 100


@pytest.fixture
def harness(monkeypatch):
    for module, name, function in HARNESS.HARNESS_PATCHES:
        monkeypatch.setattr(module, name, function)
    return HARNESS


def small_doc(**kwargs):
    info = HARNESS.SourceInfo(640, 360, FPS, False, 60_000, True)
    return HARNESS.make_doc(info, fps=FPS, body=(30, 30 + FRAMES), **kwargs)


def small_plan(**kwargs):
    doc = small_doc(**kwargs)
    return fixtures.make_render_plan(doc, HARNESS.make_words(60_000))


def encode(path: Path, *, size=(720, 1280), rate="30000/1001", frames=FRAMES, samples=None,
           pix_fmt="yuv420p", profile="high", tags=True, faststart=True, audio=True,
           audio_rate=48000, channels=2, sar="1", container="mp4", level_db=-20):
    """An output made with the R7 settings, with one property changed at a time."""
    samples = tm.smp(frames, tm.Fps(30000, 1001)) if samples is None else samples
    duration = frames / (30000 / 1001) + 1
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
            "-i", f"testsrc2=size={size[0]}x{size[1]}:rate={rate}:duration={duration:.3f}"]
    if audio:
        argv += ["-f", "lavfi", "-i",
                 f"sine=frequency=1000:sample_rate={audio_rate}:duration={duration:.3f}"]
    graph = f"[0:v]setsar={sar},trim=end_frame={frames}[v]"
    if audio:
        layout = "pan=stereo|c0=c0|c1=c0" if channels == 2 else "aformat=channel_layouts=mono"
        graph += (f";[1:a]volume={level_db}dB,{layout},"
                  f"atrim=end_sample={samples * audio_rate // 48000}[a]")
    argv += ["-filter_complex", graph, "-map", "[v]"]
    if audio:
        argv += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    # veryfast as in R7: ultrafast drops CABAC and 8x8dct, so x264 would signal Constrained
    # Baseline whatever -profile:v says
    argv += ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", pix_fmt, "-threads", "4"]
    if pix_fmt == "yuv420p":
        argv += ["-profile:v", profile]
    if tags:
        argv += ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                 "-color_range", "tv"]
    if faststart and container == "mp4":
        argv += ["-movflags", "+faststart"]
    argv += ["-f", "matroska" if container == "mkv" else "mp4", str(path)]
    subprocess.run(argv, check=True)
    return path


def run_verify(path: Path, plan, *, normalize=False):
    fd = os.open(path, os.O_RDONLY)
    try:
        return verify.verify_output(fd, plan, size=plan.output, normalize=normalize)
    finally:
        os.close(fd)


def problems(path: Path, plan, **kwargs) -> set[str]:
    with pytest.raises(errors.VerificationFailed) as caught:
        run_verify(path, plan, **kwargs)
    report = caught.value.report
    assert not report.ok
    assert caught.value.code == "verification_failed"
    return {problem for gate in report.gates for problem in gate.problems}


def test_a_good_output_passes(tmp_path, edit_v2_ffmpeg):
    plan = small_plan()
    report = run_verify(encode(tmp_path / "good.mp4"), plan)
    assert report.ok
    g1, g2 = report.gate("G1"), report.gate("G2")
    assert g1.ok and g1.blocking and g2.ok and g2.blocking
    assert g2.values["frames"] == FRAMES
    assert abs(g2.values["samples"] - plan.total_samples) <= verify.SAMPLE_TOLERANCE
    assert report.gate("G3") is None and report.gate("G3b") is None
    assert report.to_json()["ok"] is True


@pytest.mark.parametrize(
    ("change", "problem"),
    [
        ({"size": (720, 1276)}, "size"),
        ({"frames": FRAMES - 1}, "frame_count"),
        ({"samples": tm.smp(FRAMES, tm.Fps(30000, 1001)) - 2000}, "sample_count"),
        ({"rate": "25/1"}, "frame_rate"),
        ({"profile": "main"}, "video_profile"),
        ({"pix_fmt": "yuv444p"}, "pix_fmt"),
        ({"tags": False}, "color_tags"),
        ({"faststart": False}, "faststart"),
        ({"audio_rate": 44100}, "sample_rate"),
        ({"channels": 1}, "channels"),
        ({"audio": False}, "streams"),
        ({"sar": "2"}, "sar"),
        ({"container": "mkv"}, "container"),
    ],
)
def test_broken_outputs_are_blocked(tmp_path, edit_v2_ffmpeg, change, problem):
    plan = small_plan()
    path = encode(tmp_path / "broken.bin", **change)
    assert problem in problems(path, plan)


def test_a_pipe_is_not_a_regular_file():
    plan = small_plan()
    read, write = os.pipe()
    try:
        with pytest.raises(errors.VerificationFailed) as caught:
            verify.verify_output(read, plan, size=plan.output, normalize=False)
    finally:
        os.close(read)
        os.close(write)
    assert "not_regular_file" in caught.value.report.gate("G1").problems


def test_the_size_argument_is_checked(tmp_path, edit_v2_ffmpeg):
    plan = small_plan()
    path = encode(tmp_path / "good.mp4")
    fd = os.open(path, os.O_RDONLY)
    try:
        with pytest.raises(errors.VerificationFailed) as caught:
            verify.verify_output(fd, plan, size=(1080, 1920), normalize=False)
    finally:
        os.close(fd)
    assert "size" in caught.value.report.gate("G1").problems


def test_a_compiled_render_passes(harness, tmp_path, edit_v2_libass):
    clip = synthetic_clip(tmp_path, frames=240, cold_open=(180, 200), body=(20, 160),
                          removals=((60, 70), (100, 101)))
    plan = build_plan(clip.doc, words=clip.words, camera=None, assets={},
                      resources=Resources(RESOURCES_DIR))
    job = compile_job(plan, mode="final", source=clip.source, assets_root=tmp_path)
    run_to_file(job, tmp_path / "final.mp4")
    report = run_verify(tmp_path / "final.mp4", plan)
    assert report.ok, report.to_json()
    assert report.gate("G2").values["frames"] == plan.total_frames


# --- G3, G3b ------------------------------------------------------------------------------------


@pytest.fixture
def measured(monkeypatch):
    state = {"value": None, "calls": 0}

    def measure(fd):
        state["calls"] += 1
        return state["value"]

    monkeypatch.setattr(verify, "measure_loudness", measure)
    return state


def music_plan(**kwargs):
    music = {"asset": fixtures.MUSIC, "src_in_smp": 0, "loop": True, "gain_cdb": -1000,
             "fade_in_f": 0, "fade_out_f": 0,
             "duck": {"on": False, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                      "hold_ms": 250, "detector": "words"}}
    assets = {fixtures.MUSIC: fixtures.asset_store()[fixtures.MUSIC]}
    return small_plan(music=music, assets=assets, **kwargs)


def test_g3_checks_integrated_loudness_and_true_peak(tmp_path, edit_v2_ffmpeg, measured):
    path = encode(tmp_path / "good.mp4")
    plan = small_plan(master="normalize")
    measured["value"] = Loudness(-1450, -150)
    report = run_verify(path, plan, normalize=True)
    assert report.gate("G3").ok and report.gate("G3").values == {"i_clufs": -1450,
                                                                 "tp_cdb": -150}
    measured["value"] = Loudness(-1250, -150)
    assert "integrated_loudness" in problems(path, plan, normalize=True)
    measured["value"] = Loudness(-1400, -60)
    assert "true_peak" in problems(path, plan, normalize=True)
    clamped = dataclasses.replace(plan, loudness_clamped_clufs=-1720)
    measured["value"] = Loudness(-1690, -110)
    assert run_verify(path, clamped, normalize=True).gate("G3").ok
    measured["value"] = Loudness(-1600, -110)
    assert "integrated_loudness" in problems(path, clamped, normalize=True)


def test_g3b_protects_the_true_peak_with_music_or_gain(tmp_path, edit_v2_ffmpeg, measured):
    path = encode(tmp_path / "good.mp4")
    plan = music_plan()
    measured["value"] = Loudness(-1800, -120)
    report = run_verify(path, plan)
    assert report.gate("G3b").ok and report.gate("G3") is None
    measured["value"] = Loudness(-1800, -80)
    assert "true_peak" in problems(path, plan)
    measured["value"] = Loudness(-1800, -80)
    assert "true_peak" in problems(path, small_plan(source_gain_cdb=300))
    calls = measured["calls"]
    assert run_verify(path, small_plan()).gate("G3b") is None
    assert measured["calls"] == calls  # revision-0-like audio is never measured


def test_loudness_is_measured_on_the_decoded_file(harness, tmp_path, edit_v2_ffmpeg):
    path = encode(tmp_path / "quiet.mp4", level_db=-12)  # 1 kHz sine, -30 dBFS per channel
    plan = small_plan(master="normalize")
    fd = os.open(path, os.O_RDONLY)
    try:
        value = verify.measure_loudness(fd)
    finally:
        os.close(fd)
    assert -3300 < value.i_clufs < -2700 and -3300 < value.tp_cdb < -2700
    assert "integrated_loudness" in problems(path, plan, normalize=True)
    assert loudness.parse_ebur128 is harness.harness_parse_ebur128


# --- G5 -------------------------------------------------------------------------------------------


def test_g5_reports_the_ui_zone_from_plan_geometry(tmp_path, edit_v2_ffmpeg):
    path = encode(tmp_path / "good.mp4")
    report = run_verify(path, small_plan())  # captions at the seed's 83% (K5 keeps it)
    assert report.ok
    g5 = report.gate("G5")
    assert not g5.blocking and not g5.ok
    assert [issue.code for issue in report.warnings] == ["unsafe_zone"]
    assert report.warnings[0].path == "/captions/overrides/y_e5"

    plan = small_plan(hook=("Halo", 45), logo=(fixtures.LOGO, {"x_e5": 50000, "y_e5": 50000,
                                                               "w_e5": 16000,
                                                               "opacity_pm": 850}),
                      assets={fixtures.LOGO: fixtures.asset_store()[fixtures.LOGO]})
    doc = copy.deepcopy(plan.doc)
    doc["captions"]["overrides"]["y_e5"] = 70000
    safe = dataclasses.replace(plan, doc=doc)
    assert run_verify(path, safe).gate("G5").ok

    doc["tracks"][0]["items"][0]["transform"]["y_e5"] = 6000
    doc["tracks"][1]["items"][0]["transform"].update(x_e5=90000, y_e5=5000)
    hot = dataclasses.replace(plan, doc=doc)
    refs = sorted(issue.ref for issue in run_verify(path, hot).warnings)
    assert refs == ["it_hook", "it_logo"]


def test_verification_failed_has_an_indonesian_message():
    assert errors.message("verification_failed")
