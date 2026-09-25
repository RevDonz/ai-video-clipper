"""Waveform peaks of the analysis window (plan §3.6 "Peaks", docs/editor/CONTRACTS.md §5.7).

Mono audio decoded once at 8 kHz by FFmpeg; per 10 ms bin (100 per second) from ``window_ms[0]``
two signed bytes ``(min, max)``: the bin's s16 extremes divided by 256 (floor); ``ceil((b − a) ·
per_sec / 1000)`` bins.
"""

from __future__ import annotations

import array
import hashlib

import pytest
from support import edit_v2_media as media

from ai_clipper.edit_v2.peaks import (
    PEAKS_SAMPLE_RATE,
    bin_count,
    bin_level,
    build_peaks,
    level_cdb,
    peaks_file_name,
    peaks_from_pcm,
)


def _pairs(raw: bytes) -> list[tuple[int, int]]:
    values = array.array("b", raw)
    return list(zip(values[0::2], values[1::2]))


def test_bin_count_is_the_ceiling_of_the_window():
    assert bin_count((0, 1000)) == 100
    assert bin_count((0, 1001)) == 101
    assert bin_count((1234, 1235)) == 1
    assert bin_count((1000, 61_000)) == 6000
    assert bin_count((0, 1000), per_sec=50) == 50
    for window in ((5, 5), (6, 5), (-1, 5)):
        with pytest.raises(ValueError):
            bin_count(window)


def test_peaks_from_pcm_floors_each_extreme():
    samples = array.array("h", [0] * 80 + [300, -1, 255, -256] + [0] * 76 + [32767, -32768] * 40)
    raw = peaks_from_pcm(samples, bins=4, samples_per_bin=80)
    assert len(raw) == 8
    # floor division: -1 // 256 == -1, 300 // 256 == 1, 255 // 256 == 0
    assert _pairs(raw) == [(0, 0), (-1, 1), (-128, 127), (0, 0)]  # the last bin is padding


def test_bin_level_and_level_cdb():
    raw = peaks_from_pcm(array.array("h", [0] * 80 + [16384, -16385] + [0] * 78), bins=2,
                         samples_per_bin=80)
    assert bin_level(raw, 0) == 0
    assert bin_level(raw, 1) == 65  # max(64, -(-65))
    assert level_cdb(0) == -9000
    assert level_cdb(128) == 0
    assert level_cdb(64) == -602
    assert level_cdb(1) == -4214


def test_peaks_file_name_is_content_addressed():
    raw = bytes([1, 2, 3, 4])
    assert peaks_file_name(raw) == f"peaks.{hashlib.sha256(raw).hexdigest()[:16]}.bin"


@pytest.fixture(scope="module")
def burst_source(tmp_path_factory, edit_v2_ffmpeg):
    path = tmp_path_factory.mktemp("peaks") / "burst.mkv"
    spec = media.VideoSpec(
        width=160, height=144, fps=(25, 1), frames=50, container="mkv",
        audio=media.AudioSpec(channels=2, bursts=(media.ToneBurst(400, 640, 1000, -600),),
                              clicks_ms=()),
    )
    return media.make_barcode_video(path, spec)


def test_build_peaks_places_a_tone_burst_in_its_bins(burst_source):
    raw = build_peaks(burst_source, (300, 800))
    pairs = _pairs(raw)
    assert len(pairs) == 50 == bin_count((300, 800))
    assert PEAKS_SAMPLE_RATE == 8000
    # Burst 400–640 ms → bins 10..33 of the window starting at 300 ms. -6 dBFS peaks are
    # 16422 / 256 ≈ 64; the resampler's ringing stays within one bin of the edges.
    for low, high in pairs[11:33]:
        assert high >= 55 and low <= -55
    for low, high in pairs[:9] + pairs[35:]:
        assert abs(low) <= 1 and abs(high) <= 1


def test_build_peaks_pads_past_the_end_of_the_audio(burst_source):
    raw = build_peaks(burst_source, (1500, 3000))  # the audio ends at 2000 ms
    pairs = _pairs(raw)
    assert len(pairs) == 150
    assert all(pair == (0, 0) for pair in pairs[60:])


def test_build_peaks_is_deterministic(burst_source):
    assert build_peaks(burst_source, (0, 2000)) == build_peaks(burst_source, (0, 2000))


def test_build_peaks_on_lossy_audio(tmp_path, edit_v2_ffmpeg):
    path = media.make_barcode_video(
        tmp_path / "burst.mp4",
        media.VideoSpec(width=160, height=144, fps=(30000, 1001), frames=60,
                        audio=media.AudioSpec(bursts=(media.ToneBurst(700, 1100, 800, -600),),
                                              clicks_ms=())),
    )
    pairs = _pairs(build_peaks(path, (500, 1500)))
    loud = [index for index, (low, high) in enumerate(pairs) if max(high, -low) >= 40]
    assert loud and abs(loud[0] - 20) <= 1 and abs(loud[-1] - 59) <= 1


def test_build_peaks_without_audio_is_silent(edit_v2_media_factory):
    path = edit_v2_media_factory(
        media.VideoSpec(width=160, height=144, fps=(25, 1), frames=25, audio=None)
    )
    assert build_peaks(path, (0, 1000)) == bytes(200)


def test_build_peaks_rejects_bad_arguments(burst_source, tmp_path):
    with pytest.raises(ValueError):
        build_peaks(burst_source, (100, 100))
    with pytest.raises(ValueError):
        build_peaks(burst_source, (0, 1000), per_sec=3)  # 8000 is not a multiple of 3
    with pytest.raises(FileNotFoundError):
        build_peaks(tmp_path / "missing.mp4", (0, 1000))
