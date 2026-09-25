"""Tests for the P-ENC measurement tool (plan §10.1, ``scripts/parity/enc_check.py``).

P-ENC compares the delivered MP4, decoded, with the lossless ``reference`` of the same frames:
whole-frame SSIM and SSIM over the union of the text boxes, with FFmpeg's ``ssim`` filter.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import enc_check

STATS = """\
n:1 Y:0.991000 U:0.995000 V:0.996000 All:0.992500 (21.249)
n:2 Y:0.981000 U:0.985000 V:0.986000 All:0.982500 (17.572)
"""


def test_parse_ssim_stats_reads_every_frame() -> None:
    frames = enc_check.parse_ssim_stats(STATS)
    assert [f["n"] for f in frames] == [1, 2]
    assert frames[0]["all"] == pytest.approx(0.9925)
    assert frames[1]["y"] == pytest.approx(0.981)
    with pytest.raises(ValueError):
        enc_check.parse_ssim_stats("garbage")


def test_region_windows_weight_the_combined_text_ssim() -> None:
    # Two boxes: 16×16 (3×3 = 9 windows) and 32×8 (7×1 = 7 windows).
    assert enc_check.box_weight((0, 0, 16, 16)) == 9
    assert enc_check.box_weight((0, 0, 32, 8)) == 7
    combined = enc_check.combine([(0.99, 9), (0.95, 7)])
    assert combined == pytest.approx((0.99 * 9 + 0.95 * 7) / 16)
    assert enc_check.combine([]) is None


def test_boxes_snap_to_even_4x4_aligned_crops_inside_the_frame() -> None:
    assert enc_check.snap_box((3, 5, 101, 67), 720, 1280) == (0, 4, 104, 68)
    assert enc_check.snap_box((700, 1270, 720, 1280), 720, 1280) == (700, 1268, 720, 1280)
    with pytest.raises(ValueError):
        enc_check.snap_box((10, 10, 10, 20), 720, 1280)


def test_thresholds_and_baseline_rule() -> None:
    assert enc_check.P_ENC_THRESHOLDS == {"ssim_all": 0.990, "ssim_text": 0.980}
    ok = {"ssim_all": 0.995, "ssim_text": 0.985}
    assert enc_check.p_enc_pass(ok)
    assert not enc_check.p_enc_pass({**ok, "ssim_text": 0.979})
    assert enc_check.p_enc_pass(ok, baseline={"ssim_all": 0.996, "ssim_text": 0.986})
    assert not enc_check.p_enc_pass(ok, baseline={"ssim_all": 0.9975, "ssim_text": 0.985})


def _video(path: Path, ffmpeg: str, *, codec: list[str], noise: int) -> Path:
    subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         (f"testsrc2=size=64x48:rate=25:duration=0.4,noise=alls={noise}:allf=t+u:all_seed=7,"
          "format=yuv420p"), "-threads", "4", *codec, str(path)],
        check=True,
    )
    return path


def test_measure_whole_and_text_regions(tmp_path: Path, edit_v2_ffmpeg: str) -> None:
    reference = _video(tmp_path / "ref.mkv", edit_v2_ffmpeg, codec=["-c:v", "ffv1"], noise=0)
    same = enc_check.measure(reference, reference, boxes=[(0, 0, 32, 16)], ffmpeg=edit_v2_ffmpeg)
    assert same["frames"] == 10
    assert same["ssim_all"] == pytest.approx(1.0)
    assert same["ssim_text"] == pytest.approx(1.0)
    lossy = _video(tmp_path / "lossy.mp4", edit_v2_ffmpeg,
                   codec=["-c:v", "libx264", "-preset", "veryfast", "-crf", "35"], noise=0)
    result = enc_check.measure(lossy, reference, boxes=[(0, 0, 32, 16), (32, 32, 64, 48)],
                               ffmpeg=edit_v2_ffmpeg)
    assert result["frames"] == 10
    assert 0.5 < result["ssim_all"] < 1.0
    assert 0.5 < result["ssim_text"] < 1.0
    assert len(result["boxes"]) == 2
    assert result["min_frame_ssim_all"] <= result["ssim_all"]
