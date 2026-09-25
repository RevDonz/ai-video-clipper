"""Loudness measurement, normalisation gain and peak protection (plan §5.6 steps 4–5; T1.4)."""

from __future__ import annotations

import copy

import pytest
from support import edit_v2_audio_harness as harness

from ai_clipper.edit_v2 import errors
from ai_clipper.edit_v2 import loudness as ld
from ai_clipper.edit_v2.doc import Issue
from ai_clipper.edit_v2.loudness import Loudness

# Real stderr tails (``-loglevel info``), FFmpeg 5.1.9 (reference image) and 6.1.1 (local).
STDERR_5_1 = (
    "  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))\n"
    "[Parsed_ebur128_0 @ 0x6027cd6a5480] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     "
    "I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS\n"
    "[Parsed_ebur128_0 @ 0x6027cd6a5480] t: 0.399977   TARGET:-23 LUFS    M: -21.8 S:-120.7     "
    "I: -21.8 LUFS       LRA:   0.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS\n"
    "size=N/A time=00:00:00.50 bitrate=N/A speed=87.8x    \n"
    "video:0kB audio:43kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: "
    "unknown\n"
    "[Parsed_ebur128_0 @ 0x6027cd6a5480] Summary:\n\n"
    "  Integrated loudness:\n    I:         -21.8 LUFS\n    Threshold: -31.8 LUFS\n\n"
    "  Loudness range:\n    LRA:         0.0 LU\n    Threshold:   0.0 LUFS\n"
    "    LRA low:     0.0 LUFS\n    LRA high:    0.0 LUFS\n\n"
    "  True peak:\n    Peak:      -18.1 dBFS\n"
)
STDERR_6_1_SILENCE = (
    "[out#0/null @ 0x595c37e996c0] video:0kB audio:188kB subtitle:0kB other streams:0kB global "
    "headers:0kB muxing overhead: unknown\n"
    "size=N/A time=00:00:00.90 bitrate=N/A speed=87.3x    \n"
    "[Parsed_ebur128_0 @ 0x595c37e9fcc0] Summary:\n\n"
    "  Integrated loudness:\n    I:         -70.0 LUFS\n    Threshold:   0.0 LUFS\n\n"
    "  Loudness range:\n    LRA:         0.0 LU\n    Threshold:   0.0 LUFS\n"
    "    LRA low:     0.0 LUFS\n    LRA high:    0.0 LUFS\n\n"
    "  True peak:\n    Peak:       -inf dBFS\n"
)
HOT = (
    "[Parsed_ebur128_0 @ 0x1] Summary:\n\n"
    "  Integrated loudness:\n    I:          -6.2 LUFS\n    Threshold: -16.4 LUFS\n\n"
    "  Loudness range:\n    LRA:         0.4 LU\n    Threshold: -26.5 LUFS\n"
    "    LRA low:    -6.4 LUFS\n    LRA high:   -6.0 LUFS\n\n"
    "  True peak:\n    Peak:        2.3 dBFS\n"
)


# --- ebur128 summary ------------------------------------------------------------------------------


def test_parse_summary_ignores_the_per_frame_lines():
    assert ld.parse_ebur128(STDERR_5_1) == Loudness(i_clufs=-2180, tp_cdb=-1810)


def test_parse_positive_true_peak():
    assert ld.parse_ebur128(HOT) == Loudness(i_clufs=-620, tp_cdb=230)


def test_parse_silence_maps_minus_inf_to_the_floor():
    assert ld.parse_ebur128(STDERR_6_1_SILENCE) == Loudness(-7000, ld.SILENCE_TP_CDB)
    assert ld.SILENCE_TP_CDB <= -9000


def test_parse_takes_the_last_summary():
    assert ld.parse_ebur128(STDERR_5_1 + HOT) == Loudness(-620, 230)


@pytest.mark.parametrize(
    "stderr",
    [
        "",
        "ffmpeg: error\n",
        STDERR_5_1.split("  True peak:")[0],  # measured without peak=true
        STDERR_5_1.replace("-21.8 LUFS\n    Threshold", "nan LUFS\n    Threshold"),
    ],
)
def test_parse_without_a_usable_summary_is_a_render_failure(stderr):
    with pytest.raises(errors.RenderFailed) as caught:
        ld.parse_ebur128(stderr)
    assert caught.value.code == "render_failed"


# --- normalisation (step 4) ------------------------------------------------------------------------


def test_master_gain_is_target_minus_integrated():
    assert ld.master_gain(Loudness(-2000, -800), -1400, -100) == (600, False)


def test_master_gain_is_clamped_so_that_the_true_peak_stays_at_tp():
    assert ld.master_gain(Loudness(-1600, -50), -1400, -100) == (-50, True)
    assert ld.master_gain(Loudness(-2000, -700), -1400, -100) == (600, False)  # exactly at tp
    assert ld.master_gain(Loudness(-2000, -690), -1400, -100) == (590, True)


# --- documents ----------------------------------------------------------------------------------------


def _seed(contexts) -> dict:
    return copy.deepcopy(contexts["c30"].seed)


def _with_music(doc: dict, **payload) -> dict:
    doc = copy.deepcopy(doc)
    doc["tracks"].append(harness.music_track(**payload))
    doc["assets"][harness.MUSIC_ASSET] = dict(harness.MUSIC_ASSET_META)
    return doc


def _with_master(doc: dict, mode: str, target: int = -1400, tp: int = -100) -> dict:
    doc = copy.deepcopy(doc)
    doc["audio"]["master"] = {"mode": mode, "target_clufs": target, "tp_cdb": tp}
    return doc


def _with_gain(doc: dict, gain_cdb: int) -> dict:
    doc = copy.deepcopy(doc)
    doc["audio"]["source"]["gain_cdb"] = gain_cdb
    return doc


def test_revision_0_is_never_measured(edit_v2_doc_contexts):
    for context in edit_v2_doc_contexts.values():
        assert ld.needs_measurement(context.seed) is False
        assert ld.output_gain(context.seed, None) == (0, ())


def test_measurement_is_needed_with_music_positive_gain_or_normalize(edit_v2_doc_contexts):
    seed = _seed(edit_v2_doc_contexts)
    assert ld.needs_measurement(_with_music(seed)) is True
    assert ld.needs_measurement(_with_gain(seed, 1)) is True
    assert ld.needs_measurement(_with_gain(seed, -600)) is False
    assert ld.needs_measurement(_with_master(seed, "normalize")) is True


def test_output_gain_requires_the_measurement_when_it_is_needed(edit_v2_doc_contexts):
    with pytest.raises(ValueError):
        ld.output_gain(_with_music(_seed(edit_v2_doc_contexts)), None)


def test_a_measurement_is_ignored_when_none_is_needed(edit_v2_doc_contexts):
    seed = _seed(edit_v2_doc_contexts)
    assert ld.output_gain(seed, Loudness(-600, 300)) == (0, ())


# --- peak protection (step 5) --------------------------------------------------------------------------


CEILING = -200  # pre-encode true-peak ceiling: -1.0 dBTP (G3b) minus 1.0 dB encode headroom


def test_peak_constants():
    # G3b threshold (plan §5.6 step 5) and the measured AAC-LC 192k overshoot allowance.
    assert ld.PEAK_CEILING_CDB == -100
    assert ld.ENCODE_HEADROOM_CDB == 100
    assert ld.PEAK_CEILING_CDB - ld.ENCODE_HEADROOM_CDB == CEILING


def test_peak_protection_off_mode_below_the_ceiling_does_nothing(edit_v2_doc_contexts):
    doc = _with_music(_seed(edit_v2_doc_contexts))
    assert ld.output_gain(doc, Loudness(-1800, -600)) == (0, ())
    assert ld.output_gain(doc, Loudness(-1800, CEILING)) == (0, ())


def test_peak_protection_applies_ceiling_minus_tp_and_names_the_reduction(edit_v2_doc_contexts):
    doc = _with_music(_seed(edit_v2_doc_contexts))
    gain, warnings = ld.output_gain(doc, Loudness(-620, 230))
    assert gain == CEILING - 230 == -430
    assert warnings == (Issue("peak_reduced:-4.30 dB", "/audio"),)
    assert errors.message(warnings[0].code).endswith("(-4.30 dB)")


def test_peak_protection_with_positive_source_gain(edit_v2_doc_contexts):
    doc = _with_gain(_seed(edit_v2_doc_contexts), 1200)
    gain, warnings = ld.output_gain(doc, Loudness(-900, -120))
    assert gain == -80
    assert [w.code for w in warnings] == ["peak_reduced:-0.80 dB"]


def test_normalize_unclamped(edit_v2_doc_contexts):
    doc = _with_master(_seed(edit_v2_doc_contexts), "normalize")
    assert ld.output_gain(doc, Loudness(-2000, -800)) == (600, ())


def test_normalize_clamped_within_one_lu_has_no_warning(edit_v2_doc_contexts):
    doc = _with_master(_seed(edit_v2_doc_contexts), "normalize")
    # desired +600; the true-peak clamp allows CEILING - (-700) = 500: costs exactly 1 LU.
    assert ld.output_gain(doc, Loudness(-2000, -700)) == (500, ())


def test_normalize_clamped_by_more_than_one_lu_warns_with_the_achieved_value(edit_v2_doc_contexts):
    doc = _with_master(_seed(edit_v2_doc_contexts), "normalize")
    gain, warnings = ld.output_gain(doc, Loudness(-1600, -50))
    assert gain == CEILING + 50 == -150
    assert warnings == (Issue("loudness_clamped:-17.50 LUFS", "/audio/master"),)


def test_normalize_uses_the_document_target_and_tp(edit_v2_doc_contexts):
    doc = _with_master(_seed(edit_v2_doc_contexts), "normalize", target=-1600, tp=-300)
    # desired -1600 - (-2400) = 800; tp ceiling -300 - 100 → allowed -400 - (-1000) = 600.
    gain, warnings = ld.output_gain(doc, Loudness(-2400, -1000))
    assert gain == 600
    assert [w.code for w in warnings] == ["loudness_clamped:-18.00 LUFS"]


def test_normalize_with_tp_0_is_still_peak_protected(edit_v2_doc_contexts):
    doc = _with_master(_seed(edit_v2_doc_contexts), "normalize", tp=0)
    # desired +400; the document allows TP up to 0 dBTP (-1.0 with headroom) → +250; peak
    # protection (-1.0 dBTP, -2.0 with headroom) lowers it by 1 dB to +150.
    gain, warnings = ld.output_gain(doc, Loudness(-1800, -350))
    assert gain == CEILING + 350 == 150
    assert [w.code for w in warnings] == ["loudness_clamped:-16.50 LUFS", "peak_reduced:-1.00 dB"]


def test_normalize_of_a_silent_mix_does_not_amplify(edit_v2_doc_contexts):
    doc = _with_master(_seed(edit_v2_doc_contexts), "normalize")
    gain, warnings = ld.output_gain(doc, Loudness(-7000, ld.SILENCE_TP_CDB))
    assert gain == 0
    assert [w.code for w in warnings] == ["loudness_clamped:-70.00 LUFS"]


def test_output_gain_is_an_integer_in_centi_db(edit_v2_doc_contexts):
    doc = _with_music(_with_master(_seed(edit_v2_doc_contexts), "normalize"))
    for i in range(-3000, -500, 37):
        for tp in range(-2000, 600, 53):
            gain, _warnings = ld.output_gain(doc, Loudness(i, tp))
            assert type(gain) is int
            assert tp + gain <= CEILING
            assert gain <= -1400 - i


# --- G3 and G3b on synthetic mixes (FFmpeg) -----------------------------------------------------------


@pytest.fixture(scope="module")
def loudness_report(edit_v2_ffmpeg, tmp_path_factory):
    return harness.g3_g3b(tmp_path_factory.mktemp("t14-loudness"))


def test_g3_normalized_mixes_hit_the_target(loudness_report):
    g3, _g3b = loudness_report
    assert len(g3["mixes"]) == 3
    for mix in g3["mixes"]:
        assert mix["pass"], mix
    assert g3["failures"] == 0


def test_g3b_every_mix_with_music_or_gain_stays_below_minus_one_dbtp(loudness_report):
    _g3, g3b = loudness_report
    assert len(g3b["mixes"]) >= 3
    assert any(mix["name"] == "hot" and mix["mode"] == "off" for mix in g3b["mixes"])
    hot = next(m for m in g3b["mixes"] if m["name"] == "hot" and m["mode"] == "off")
    assert hot["pre_master_tp_dbtp"] > 0.0  # deliberately hot: clips without protection
    assert "peak_reduced" in hot["warnings"]
    for mix in g3b["mixes"]:
        assert mix["export_tp_dbtp"] <= -1.0, mix
    assert g3b["failures"] == 0
