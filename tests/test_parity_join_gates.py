"""The cold-open transition's gates (``scripts/parity/join_gates.py``; spec 2026-10-02 §5.4).

The renders run in CI (``run_all.sh`` section ``join``); what is tested here is the part that
decides: the cases, the per-frame blend and alpha estimate, the text-on-top check, the whoosh
window and onset, and the shape comparison of the two engines.
"""

from __future__ import annotations

import array
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import frame_identity as fi
import join_gates as jg

from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2 import transitions


def test_the_cases_cover_five_rates_and_both_styles():
    full = jg.p_join_cases(smoke=False)
    assert len(full) == 10
    assert {(fps, style) for fps, style, _w in full} == {
        (fps, style) for fps in jg.RATES for style in ("flash_white", "dip_black")}
    assert {(fps, style) for fps, style, whoosh in full if whoosh} == jg.WHOOSH_CASES
    assert jg.p_join_cases(smoke=True) == [((30000, 1001), "flash_white", True)]


def test_a_join_case_is_a_frame_identity_document_with_its_transition():
    joined = jg.case((30000, 1001), "flash_white", whoosh=True)
    cut, notext = jg.case((30000, 1001)), jg.case((30000, 1001), text=False)
    assert (joined.join_style, joined.whoosh, joined.hook, joined.cuts) == (
        "flash_white", True, True, 20)
    assert (cut.join_style, cut.whoosh) == ("cut", False)
    assert (notext.captions, notext.hook) == (False, False)
    assert len({joined.name, cut.name, notext.name}) == 3
    edges = fi.case_edges(joined)
    doc = fi.make_doc(fi.SourceInfo(640, 360, (30000, 1001), False, 20_000, True),
                      fps=joined.fps, body=edges["body"], cold_open=edges["cold_open"],
                      removals=edges["removals"], join_style="flash_white", whoosh=True)
    assert doc["main"]["joins"] == [{"after": "seg_co", "style": "flash_white",
                                     "audio_fade_ms": 30, "sfx": {"id": "whoosh", "v": 1}}]
    plain = fi.make_doc(fi.SourceInfo(640, 360, (30000, 1001), False, 20_000, True),
                        fps=joined.fps, body=edges["body"], cold_open=edges["cold_open"])
    assert plain["main"]["joins"] == [{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}]


def test_g_det_covers_a_transition_document():
    (case,) = fi.JOIN_DET_CASES
    assert (case.fps, case.join_style, case.whoosh) == ((30000, 1001), "flash_white", True)
    defaults = fi.g_det.__defaults__[0]
    assert case in defaults


def _rgb(*pixels: tuple[int, int, int]) -> bytes:
    return bytes(value for pixel in pixels for value in pixel)


def test_compare_frame_blends_the_video_and_skips_the_text():
    cut = _rgb((10, 20, 30), (200, 100, 0), (255, 255, 255))
    mask = bytes((0, 0, 1))  # the third pixel is text
    alpha = 666
    blend = bytes((v * (1000 - alpha) + 255 * alpha + 500) // 1000 for v in cut[:6])
    joined = blend + cut[6:]
    row = jg.compare_frame(cut, joined, mask, alpha, 255)
    assert (row["max_abs"], row["mean_abs"], row["text_pixels"], row["pixels_compared"]) == (
        0, 0.0, 1, 2)
    assert abs(row["alpha_estimate_pm"] - alpha) <= 2
    off = bytearray(joined)
    off[0] += 4
    assert jg.compare_frame(cut, bytes(off), mask, alpha, 255)["max_abs"] == 4


def _yuv(size, luma, chroma=128):
    width, height = size
    return bytes(luma) + bytes([chroma]) * (width * height // 2)


def test_the_text_mask_follows_luma_and_the_reach_of_chroma():
    size = (32, 16)
    plain = _yuv(size, [16] * (32 * 16))
    text = bytearray(plain)
    text[5 * 32 + 3] = 200  # one luma sample
    chroma_at = 32 * 16 + 4 * 16 + 10  # U sample (x 10, y 4): luma x 20–21, y 8–9
    text[chroma_at] = 90
    mask = jg.text_mask(bytes(text), plain, size)
    assert mask[5 * 32 + 3] == 1 and mask[5 * 32 + 4] == 0
    reach = jg.CHROMA_REACH
    for y in range(16):
        for x in range(32):
            inside = abs(x // 2 - 10) <= reach and abs(y // 2 - 4) <= reach
            if (x, y) != (3, 5):
                assert mask[y * 32 + x] == inside, (x, y)


def test_the_text_share_tells_text_over_the_effect_from_text_under_it():
    cut = [16] * 200 + [100] * 200  # dark text over a mid-grey picture
    notext = [100] * 400
    alpha, white = 1000, 235
    over = [16] * 200 + [235] * 200  # opaque text kept, picture whitened
    under = [235] * 400  # everything whitened: text under the effect
    result = jg.text_share(bytes(cut), bytes(over), bytes(notext), alpha, white)
    assert result["text_share_pixels"] == 200 and result["text_share"] == 1.0
    assert jg.text_share(bytes(cut), bytes(under), bytes(notext), alpha, white)[
        "text_share"] == 0.0
    # a 65 % box (the hook's): its opacity
    box = [round(0.65 * 16 + 0.35 * 235)] * 200 + [235] * 200
    share = jg.text_share(bytes(cut), bytes(box), bytes(notext), alpha, white)["text_share"]
    assert 0.6 <= share <= 0.7
    assert jg.text_share(bytes(cut[:50] + notext[50:]), bytes(over), bytes(notext), alpha,
                         white)["text_share"] is None  # too few text pixels to judge


def test_the_loudest_window_and_the_onset_find_the_whoosh():
    wav = jg.whoosh_samples()
    assert len(wav) == 2 * 20_160
    start = 30_000
    diff = array.array("h", [0] * (2 * 80_000))
    diff[2 * start:2 * start + len(wav)] = wav
    peak = jg.loudest_window(diff)
    assert abs(peak - (start + 11_520 - 240)) <= jg.WHOOSH_PEAK_SAMPLES
    assert jg._onset(diff, wav, start + 2_000) == start


def test_the_engine_shapes_are_compared_around_their_own_joins():
    fps = tm.Fps(30, 1)
    table = [transitions.alpha_pm("flash_white", k, fps) for k in range(-6, 6)]
    new = {"fps": 30.0, "alpha_pm": table, "peak_index": 6}
    # legacy at 60 fps: the same triangle twice as densely sampled, peak elsewhere in its window
    legacy_alphas = [max(0, round(1000 * (1 - abs(k) / 60 / 0.1))) for k in range(-10, 14)]
    legacy = {"fps": 60.0, "alpha_pm": legacy_alphas, "peak_index": 10}
    result = jg._compare_alphas(new, legacy)
    assert result["best_offset"] == 0 and result["max_abs_alpha_pm"] <= 1
    shifted = {**legacy, "peak_index": 11}  # a peak found one frame late
    assert jg._compare_alphas(new, shifted)["max_abs_alpha_pm"] <= 1
    broken = {**legacy, "alpha_pm": [0] * len(legacy_alphas)}
    assert jg._compare_alphas(new, broken)["max_abs_alpha_pm"] == 1000
