"""The cold-open transition: alpha table, FFmpeg chain, DTO, auto-render join and the whoosh
(spec docs/plans/2026-10-02-transisi-cold-open.md §1.6, §2, §3, §4.1, §6.1)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import errors
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2 import transitions as tr
from ai_clipper.edit_v2.timemap import Fps, Piece

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "resources"
WAV = RESOURCES / "sfx" / "whoosh" / "v1.wav"
META = RESOURCES / "sfx" / "whoosh" / "v1.meta.json"
RATES = {"24/1": Fps(24, 1), "25/1": Fps(25, 1), "30/1": Fps(30, 1),
         "24000/1001": Fps(24000, 1001), "30000/1001": Fps(30000, 1001)}

# Spec §2.2, verbatim: (style, fps, before, after, alpha_pm from the first affected frame,
# visible frames, visible ms).
TABLE = (
    ("flash_white", "24/1", 2, 3, (167, 583, 1000, 583, 167), 5, 208),
    ("flash_white", "25/1", 2, 3, (200, 600, 1000, 600, 200), 5, 200),
    ("flash_white", "30/1", 2, 3, (333, 667, 1000, 667, 333), 5, 167),
    ("flash_white", "24000/1001", 2, 3, (166, 583, 1000, 583, 166), 5, 209),
    ("flash_white", "30000/1001", 2, 3, (333, 666, 1000, 666, 333), 5, 167),
    ("dip_black", "24/1", 3, 4, (167, 444, 722, 1000, 722, 444, 167), 7, 292),
    ("dip_black", "25/1", 3, 4, (200, 467, 733, 1000, 733, 467, 200), 7, 280),
    ("dip_black", "30/1", 4, 5, (111, 333, 556, 778, 1000, 778, 556, 333, 111), 9, 300),
    ("dip_black", "24000/1001", 3, 4, (166, 444, 722, 1000, 722, 444, 166), 7, 292),
    ("dip_black", "30000/1001", 4, 5, (110, 333, 555, 778, 1000, 778, 555, 333, 110), 9, 300),
)


@pytest.mark.parametrize(("style", "rate", "before", "after", "alphas", "visible", "ms"), TABLE)
def test_the_alpha_table_of_every_rate(style, rate, before, after, alphas, visible, ms):
    fps = RATES[rate]
    assert tr.side_frames(style, fps) == (before, after)
    assert tuple(tr.alpha_pm(style, k, fps) for k in range(-before, after)) == alphas
    assert alphas[before] == 1000  # the peak is J, the first frame after the join
    assert tr.alpha_pm(style, -before - 1, fps) == 0
    assert tr.alpha_pm(style, after, fps) == 0
    assert len(alphas) == visible
    assert tm.div_round_half_up(visible * 1000 * fps.den, fps.num) == ms
    # The support is exactly 2W: affected frames start within W of the join, the next ones
    # out do not.
    width = tr.HALF_WIDTH_MS[style]
    for k in range(-before, after):
        assert abs(k) * 1000 * fps.den < width * fps.num
    for k in (-before - 1, after):
        assert abs(k) * 1000 * fps.den >= width * fps.num


def test_cut_has_no_alpha_and_the_styles_are_fixed():
    fps = RATES["30000/1001"]
    assert tr.JOIN_STYLES == ("cut", "flash_white", "dip_black")
    assert tr.DISABLED_JOIN_STYLES == ("xfade",)
    assert tr.HALF_WIDTH_MS == {"flash_white": 100, "dip_black": 150}
    assert tr.RGB == {"flash_white": (255, 255, 255), "dip_black": (0, 0, 0)}
    assert tr.YUV_TV == {"flash_white": (235, 128, 128), "dip_black": (16, 128, 128)}
    assert tr.side_frames("cut", fps) == (0, 0)
    assert all(tr.alpha_pm("cut", k, fps) == 0 for k in range(-5, 6))
    assert tr.join_alpha("cut", 60, 400, fps) == ()
    with pytest.raises(ValueError):
        tr.alpha_pm("xfade", 0, fps)


def test_join_alpha_drops_frames_outside_the_clip_and_never_rescales():
    fps = RATES["30/1"]
    full = tr.join_alpha("dip_black", 60, 400, fps)
    assert full == ((56, 111), (57, 333), (58, 556), (59, 778), (60, 1000), (61, 778),
                    (62, 556), (63, 333), (64, 111))
    assert tr.join_alpha("dip_black", 2, 400, fps) == ((0, 556), (1, 778), (2, 1000), (3, 778),
                                                       (4, 556), (5, 333), (6, 111))
    assert tr.join_alpha("dip_black", 60, 62, fps) == full[:6]


def _pieces(*runs: tuple[str, int, int]) -> tuple[Piece, ...]:
    pieces, out = [], 0
    for i, (seg, in_sf, out_sf) in enumerate(runs):
        role = "cold_open" if seg == "seg_co" else "body"
        pieces.append(Piece(i, seg, role, in_sf, out_sf, out, out_sf - in_sf))
        out += out_sf - in_sf
    return tuple(pieces)


def _doc(join: dict) -> dict:
    return {"main": {"joins": [join]}}


def test_plan_joins_places_the_join_after_every_cold_open_piece():
    fps = RATES["30000/1001"]
    pieces = _pieces(("seg_co", 1000, 1040), ("seg_co", 1045, 1065), ("seg_b1", 100, 400))
    (join,) = tr.plan_joins(_doc({"after": "seg_co", "style": "flash_white",
                                  "audio_fade_ms": 30, "sfx": {"id": "whoosh", "v": 1}}),
                            pieces, fps, 360)
    assert join.at_f == 60 and join.after == "seg_co" and join.style == "flash_white"
    assert join.alpha == ((58, 333), (59, 666), (60, 1000), (61, 666), (62, 333))
    assert join.sfx == tr.SfxPlan(id="whoosh", v=1, sha256=tr.SFX[("whoosh", 1)].sha256,
                                  start_smp=84576, skip_smp=0, samples=20160, hit_smp=96096)
    assert join.to_json() == {
        "after": "seg_co", "style": "flash_white", "at_f": 60,
        "alpha_pm": [[58, 333], [59, 666], [60, 1000], [61, 666], [62, 333]],
        "sfx": {"id": "whoosh", "v": 1, "sha256": tr.SFX[("whoosh", 1)].sha256,
                "start_smp": 84576, "skip_smp": 0, "samples": 20160, "hit_smp": 96096}}
    (cut,) = tr.plan_joins(_doc({"after": "seg_co", "style": "cut", "audio_fade_ms": 30}),
                           pieces, fps, 360)
    assert cut.alpha == () and cut.sfx is None and not cut.visible
    assert cut.to_json()["sfx"] is None


def test_a_short_head_skips_the_whoosh_samples_before_the_clip():
    fps = RATES["30/1"]
    spec = tr.SFX[("whoosh", 1)]
    plan = tr.sfx_plan(spec, 3, fps)  # smp(3) = 4800 < 11520
    assert (plan.start_smp, plan.skip_smp, plan.samples, plan.hit_smp) == (0, 6720, 13440, 4800)


def test_plan_joins_rejects_a_join_without_a_following_piece_or_an_unknown_sound():
    fps = RATES["30/1"]
    pieces = _pieces(("seg_co", 1000, 1040), ("seg_b1", 100, 400))
    with pytest.raises(errors.DocSemanticInvalid) as caught:
        tr.plan_joins(_doc({"after": "seg_zz", "style": "cut", "audio_fade_ms": 30}),
                      pieces, fps, 340)
    assert (caught.value.code, caught.value.path) == ("cold_open_invalid", "/main/joins/0")
    with pytest.raises(errors.DocSemanticInvalid):
        tr.plan_joins(_doc({"after": "seg_co", "style": "cut", "audio_fade_ms": 30}),
                      pieces[:1], fps, 40)
    with pytest.raises(errors.DocSemanticInvalid) as caught:
        tr.plan_joins(_doc({"after": "seg_co", "style": "cut", "audio_fade_ms": 30,
                            "sfx": {"id": "whoosh", "v": 2}}), pieces, fps, 340)
    assert (caught.value.code, caught.value.path) == ("sfx_unknown", "/main/joins/0/sfx")


# Spec §4.1, the worked example: 30000/1001, J = 60, flash_white (one line in the graph file).
FLASH_EXAMPLE = (
    ",lutrgb=r=floor((val*667+85415)/1000):g=floor((val*667+85415)/1000):"
    "b=floor((val*667+85415)/1000):enable='between(t,1.918583,1.951950)',"
    "lutrgb=r=floor((val*334+170330)/1000):g=floor((val*334+170330)/1000):"
    "b=floor((val*334+170330)/1000):enable='between(t,1.951950,1.985317)',"
    "lutrgb=r=floor((val*0+255500)/1000):g=floor((val*0+255500)/1000):"
    "b=floor((val*0+255500)/1000):enable='between(t,1.985317,2.018683)',"
    "lutrgb=r=floor((val*334+170330)/1000):g=floor((val*334+170330)/1000):"
    "b=floor((val*334+170330)/1000):enable='between(t,2.018683,2.052050)',"
    "lutrgb=r=floor((val*667+85415)/1000):g=floor((val*667+85415)/1000):"
    "b=floor((val*667+85415)/1000):enable='between(t,2.052050,2.085417)'"
)


def _join(style: str, at_f: int = 60, fps: Fps = RATES["30000/1001"],
          total: int = 400) -> tr.JoinPlan:
    return tr.JoinPlan("seg_co", style, at_f, tr.join_alpha(style, at_f, total, fps), None)


def test_lut_chain_is_the_worked_example():
    fps = RATES["30000/1001"]
    assert tr.lut_chain([_join("flash_white")], fps) == FLASH_EXAMPLE
    dip = tr.lut_chain([_join("dip_black")], fps)
    assert dip.count("lutrgb=") == 9
    assert dip.startswith(",lutrgb=r=floor((val*890+500)/1000):g=floor((val*890+500)/1000):"
                          "b=floor((val*890+500)/1000):enable='between(t,1.851850,1.885217)'")
    assert tr.lut_chain([], fps) == "" and tr.lut_chain([_join("cut")], fps) == ""


def test_lut_chain_windows_are_half_a_frame_around_each_frame():
    for fps in RATES.values():
        chain = tr.lut_chain([_join("dip_black", fps=fps)], fps)
        windows = re.findall(r"between\(t,([0-9.]+),([0-9.]+)\)", chain)
        frames = [frame for frame, _alpha in tr.join_alpha("dip_black", 60, 400, fps)]
        assert len(windows) == len(frames)
        for frame, (low, high) in zip(frames, windows, strict=True):
            t = frame * fps.den / fps.num
            half = fps.den / (2 * fps.num)
            assert float(low) == pytest.approx(t - half, abs=1e-6)
            assert float(high) == pytest.approx(t + half, abs=1e-6)


def test_lut_chain_clamps_the_first_window_at_zero():
    fps = RATES["30/1"]
    chain = tr.lut_chain([_join("dip_black", at_f=2, fps=fps)], fps)
    assert "between(t,0.000000,0.016667)" in chain


def test_lut_chain_refuses_another_composite_only_when_there_is_an_effect():
    fps = RATES["30000/1001"]
    assert tr.lut_chain([_join("cut")], fps, composite="yuv420p") == ""
    with pytest.raises(ValueError):
        tr.lut_chain([_join("flash_white")], fps, composite="yuv420p")


def test_lut_chain_blends_toward_the_colour_exactly():
    """``floor((p·(1000 − a) + C·a + 500)/1000)`` (spec §2.3) for every 8-bit value."""
    fps = RATES["30/1"]
    for style in ("flash_white", "dip_black"):
        colour = tr.RGB[style][0]
        chain = tr.lut_chain([_join(style, fps=fps)], fps)
        for k1, k2 in re.findall(r"r=floor\(\(val\*(\d+)\+(\d+)\)/1000\)", chain):
            alpha = 1000 - int(k1)
            assert int(k2) == colour * alpha + 500
            for p in (0, 1, 127, 128, 254, 255):
                value = (p * int(k1) + int(k2)) // 1000
                assert value == (p * (1000 - alpha) + colour * alpha + 500) // 1000
                assert 0 <= value <= 255


def test_joins_dto():
    fps = RATES["30000/1001"]
    pieces = _pieces(("seg_co", 1000, 1060), ("seg_b1", 100, 400))
    joins = tr.plan_joins(_doc({"after": "seg_co", "style": "flash_white", "audio_fade_ms": 30,
                                "sfx": {"id": "whoosh", "v": 1}}), pieces, fps, 360)
    assert tr.joins_dto(joins) == [{
        "after": "seg_co", "style": "flash_white", "atF": 60, "rgb": [255, 255, 255],
        "alphaPm": [[58, 333], [59, 666], [60, 1000], [61, 666], [62, 333]],
        "sfx": {"id": "whoosh", "v": 1, "startSmp": 84576, "hitSmp": 96096, "samples": 20160}}]
    dip = tr.plan_joins(_doc({"after": "seg_co", "style": "dip_black", "audio_fade_ms": 30}),
                        pieces, fps, 360)
    assert tr.joins_dto(dip)[0]["rgb"] == [0, 0, 0] and tr.joins_dto(dip)[0]["sfx"] is None
    cut = tr.plan_joins(_doc({"after": "seg_co", "style": "cut", "audio_fade_ms": 30}),
                        pieces, fps, 360)
    assert tr.joins_dto(cut) == [{"after": "seg_co", "style": "cut", "atF": 60, "rgb": None,
                                  "alphaPm": [], "sfx": None}]
    assert tr.joins_dto(()) == []


# --- ColdOpenJoin ------------------------------------------------------------------------------


def test_cold_open_join_round_trip_and_doc_join():
    assert tr.AUTO_COLD_OPEN_JOIN == tr.ColdOpenJoin("flash_white", "whoosh")
    assert tr.CUT_JOIN == tr.ColdOpenJoin("cut", None)
    assert tr.AUTO_COLD_OPEN_JOIN.to_json() == {"style": "flash_white",
                                                "sfx": {"id": "whoosh", "v": 1}}
    assert tr.CUT_JOIN.to_json() == {"style": "cut", "sfx": None}
    for style in tr.JOIN_STYLES:
        for sfx in (None, "whoosh"):
            join = tr.ColdOpenJoin(style, sfx)
            assert tr.ColdOpenJoin.from_json(json.loads(json.dumps(join.to_json()))) == join
    assert tr.AUTO_COLD_OPEN_JOIN.doc_join("seg_co", 30) == {
        "after": "seg_co", "style": "flash_white", "audio_fade_ms": 30,
        "sfx": {"id": "whoosh", "v": 1}}
    assert tr.CUT_JOIN.doc_join("seg_co", 30) == {"after": "seg_co", "style": "cut",
                                                  "audio_fade_ms": 30}
    assert "sfx" not in tr.ColdOpenJoin("dip_black", None).doc_join("seg_co", 30)


@pytest.mark.parametrize("value", [
    None, [], "flash_white", {}, {"style": "flash_white"},
    {"style": "flash_white", "sfx": None, "extra": 1},
    {"style": "xfade", "sfx": None}, {"style": "fade", "sfx": None}, {"style": 1, "sfx": None},
    {"style": "cut", "sfx": "whoosh"}, {"style": "cut", "sfx": {"id": "whoosh"}},
    {"style": "cut", "sfx": {"id": "whoosh", "v": 2}}, {"style": "cut", "sfx": {"id": "pop", "v": 1}},
    {"style": "cut", "sfx": {"id": "whoosh", "v": True}},
    {"style": "cut", "sfx": {"id": "whoosh", "v": 1, "gain": 0}},
])
def test_cold_open_join_from_json_is_strict(value):
    assert tr.ColdOpenJoin.from_json(value) is None


def test_cold_open_join_refuses_unknown_values():
    with pytest.raises(ValueError):
        tr.ColdOpenJoin("xfade", None)
    with pytest.raises(ValueError):
        tr.ColdOpenJoin("cut", "pop")


# --- the whoosh --------------------------------------------------------------------------------


def _frames() -> tuple[tuple[int, int, int, int], bytes]:
    with wave.open(str(WAV), "rb") as handle:
        return (handle.getframerate(), handle.getnchannels(), handle.getsampwidth(),
                handle.getnframes()), handle.readframes(handle.getnframes())


def test_the_whoosh_file_is_the_pinned_one():
    meta = json.loads(META.read_text(encoding="utf-8"))
    data = WAV.read_bytes()
    spec = tr.SFX[("whoosh", 1)]
    assert hashlib.sha256(data).hexdigest() == spec.sha256 == meta["sha256"]
    assert len(data) == meta["bytes"] == 80_684
    assert (meta["schema"], meta["id"], meta["v"], meta["file"]) == ("potongin.sfx/1", "whoosh",
                                                                     1, "v1.wav")
    assert (meta["sample_rate"], meta["channels"], meta["sample_format"]) == (48000, 2, "s16le")
    assert meta["samples"] == spec.samples == 20_160
    assert meta["hit_smp"] == spec.hit_smp == 11_520
    assert meta["license"] == "CC0-1.0"
    assert meta["generator"]["script"] == "scripts/sfx/make_whoosh.py"
    assert meta["generator"]["seed"] == 2654435769
    assert meta["loudness"]["measured_with"] == "FFmpeg 5.1.9 ebur128=peak=true"


def test_the_whoosh_shape():
    params, frames = _frames()
    assert params == (48000, 2, 2, 20_160)
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    meta = json.loads(META.read_text(encoding="utf-8"))
    assert max(abs(value) for value in samples) == meta["peak"] == 4370
    # the loudest 10 ms (480 frames) starts within ±480 samples of 11,280
    energy = [samples[2 * n] ** 2 + samples[2 * n + 1] ** 2 for n in range(20_160)]
    window = sum(energy[:480])
    best, best_at = window, 0
    for start in range(1, 20_160 - 480 + 1):
        window += energy[start + 479] - energy[start - 1]
        if window > best:
            best, best_at = window, start
    assert abs(best_at - 11_280) <= 480
    # the first and last 96 frames are ramped: |sample| ≤ peak·n/96
    for n in list(range(96)) + list(range(20_160 - 96, 20_160)):
        ramp = min(n, 20_159 - n)
        for channel in (0, 1):
            assert abs(samples[2 * n + channel]) * 96 <= 4370 * ramp + 96
    assert samples[0] == samples[1] == samples[-1] == samples[-2] == 0


def test_load_sfx_pcm_and_sfx_file_check_the_pin(tmp_path):
    spec = tr.SFX[("whoosh", 1)]
    pcm = tr.load_sfx_pcm(RESOURCES, spec)
    assert pcm == _frames()[1] and len(pcm) == 20_160 * 4
    assert tr.sfx_file(RESOURCES, spec) == WAV
    copy = tmp_path / "sfx" / "whoosh"
    copy.mkdir(parents=True)
    changed = bytearray(WAV.read_bytes())
    changed[-1] ^= 1
    (copy / "v1.wav").write_bytes(bytes(changed))
    for call in (tr.load_sfx_pcm, tr.sfx_file):
        with pytest.raises(errors.RenderFailed) as caught:
            call(tmp_path, spec)
        assert (caught.value.code, caught.value.ref) == ("render_failed", "sfx")
    (copy / "v1.wav").unlink()
    (copy / "v1.wav").symlink_to(WAV)
    with pytest.raises(errors.RenderFailed):
        tr.sfx_file(tmp_path, spec)
    with pytest.raises(errors.RenderFailed):
        tr.load_sfx_pcm(tmp_path / "missing", spec)


def _generator():
    path = ROOT / "scripts" / "sfx" / "make_whoosh.py"
    spec = importlib.util.spec_from_file_location("make_whoosh", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_generator_reproduces_the_committed_file():
    generator = _generator()
    assert generator.check() == []
    assert generator.main(["--check"]) == 0
    assert hashlib.sha256(generator.wav_bytes()).hexdigest() == tr.SFX[("whoosh", 1)].sha256


def test_the_generator_check_fails_on_a_changed_file(tmp_path):
    generator = _generator()
    wav = tmp_path / "v1.wav"
    changed = bytearray(WAV.read_bytes())
    changed[40_000] ^= 1
    wav.write_bytes(bytes(changed))
    assert generator.check(wav, META) == ["v1.wav differs from the generator's bytes"]


@pytest.mark.usefixtures("edit_v2_reference_toolchain")
def test_the_whoosh_level_on_the_pinned_toolchain():
    """Spec §3.2: −29.0 ± 1.0 LUFS integrated and a true peak ≤ −16.0 dBTP (FFmpeg 5.1.9)."""
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", str(WAV), "-af",
         "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
        capture_output=True, text=True, check=True)
    summary = result.stderr[result.stderr.rfind("Summary:"):]
    integrated = float(re.search(r"I:\s+(-?[0-9.]+) LUFS", summary).group(1))
    peak = float(re.search(r"Peak:\s+(-?[0-9.]+) dBFS", summary).group(1))
    assert abs(integrated + 29.0) <= 1.0
    assert peak <= -16.0
    meta = json.loads(META.read_text(encoding="utf-8"))
    assert meta["loudness"]["i_clufs"] == round(integrated * 100)
    assert meta["loudness"]["tp_cdb"] == round(peak * 100)
