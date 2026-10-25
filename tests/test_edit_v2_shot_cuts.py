"""Shot cuts on the document grid (``edit_v2.shot_cuts``, rombak 04 §A3).

The videos are drawn here as grey frames, one smooth random texture per shot, so the true cut
frames are known: hard cuts, a 12-frame fade, a one-frame white flash, a VFR source and the
59.94 → 29.97 and 60 → 30 grids. The pure detector is also tested on profiles built by hand.
"""

from __future__ import annotations

import random
import subprocess
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import shot_cuts
from ai_clipper.edit_v2.shot_cuts import LAGS, Profile, ShotCutsError, detect, find_cuts
from ai_clipper.edit_v2.shots import load_rules
from ai_clipper.edit_v2.timemap import Fps

W, H = 160, 90
RULES = load_rules().with_values({"cut.coarse_scene_pm": 300, "cut.refine_diff_pm": 100,
                                  "cut.min_gap_ms": 300})


def texture(seed: int) -> bytes:
    """A smooth grey texture: random 16×9 cells upscaled bilinearly by hand."""
    rng = random.Random(seed)
    cells = [[rng.randint(20, 235) for _x in range(17)] for _y in range(10)]
    rows = []
    for y in range(H):
        gy = y * 9 / H
        y0, fy = int(gy), gy - int(gy)
        for x in range(W):
            gx = x * 16 / W
            x0, fx = int(gx), gx - int(gx)
            top = cells[y0][x0] * (1 - fx) + cells[y0][x0 + 1] * fx
            bottom = cells[y0 + 1][x0] * (1 - fx) + cells[y0 + 1][x0 + 1] * fx
            rows.append(round(top * (1 - fy) + bottom * fy))
    return bytes(rows)


def blend(a: bytes, b: bytes, share: float) -> bytes:
    return bytes(round(x * (1 - share) + y * share) for x, y in zip(a, b, strict=True))


def encode(path: Path, frames: list[bytes], rate: str, *, vfr: bool = False) -> Path:
    argv = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt",
            "gray", "-s", f"{W}x{H}", "-r", rate, "-i", "pipe:0"]
    if vfr:
        # 0–2 ms of jitter on a millisecond time base
        argv += ["-vf", "setpts='(N/30+0.001*mod(N,3))/TB'", "-fps_mode", "vfr"]
    argv += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv420p",
             "-g", "30", str(path)]
    subprocess.run(argv, input=b"".join(frames), check=True, timeout=120)
    return path


def shots(lengths: list[int], *, seed: int = 1) -> list[bytes]:
    frames: list[bytes] = []
    for index, length in enumerate(lengths):
        frames += [texture(seed * 100 + index)] * length
    return frames


def cut_frames(lengths: list[int]) -> list[int]:
    edges, total = [], 0
    for length in lengths[:-1]:
        total += length
        edges.append(total)
    return edges


def window(frames: int, fps: Fps) -> tuple[int, int]:
    return (0, frames * 1000 * fps.den // fps.num)


def close(found: list[int], truth: list[int], tolerance: int = 1) -> bool:
    return len(found) == len(truth) and all(abs(a - b) <= tolerance
                                            for a, b in zip(found, truth, strict=True))


@pytest.fixture
def ffmpeg(edit_v2_ffmpeg):
    return edit_v2_ffmpeg


def test_hard_cuts_are_found_on_their_first_frame(tmp_path, ffmpeg):
    lengths = [40, 33, 52, 25]
    fps = Fps(25, 1)
    video = encode(tmp_path / "hard.mp4", shots(lengths), "25")
    found = find_cuts(video, window(sum(lengths), fps), fps, rules=RULES)
    assert found.source == "shot_cuts"
    assert found.cuts_sf == cut_frames(lengths)


def test_the_window_is_on_the_grid_of_the_document(tmp_path, ffmpeg):
    lengths = [40, 33, 52, 25]
    fps = Fps(25, 1)
    video = encode(tmp_path / "hard.mp4", shots(lengths), "25")
    # a window from 1.0 s (frame 25) to 5.0 s (frame 125): cuts at 40, 73 and 125 → 40 and 73
    found = find_cuts(video, (1000, 5000), fps, rules=RULES)
    assert found.cuts_sf == [40, 73]


def test_a_fade_is_one_cut_in_its_middle(tmp_path, ffmpeg):
    a, b = texture(7), texture(8)
    frames = [a] * 50 + [blend(a, b, (i + 1) / 13) for i in range(12)] + [b] * 50
    fps = Fps(25, 1)
    video = encode(tmp_path / "fade.mp4", frames, "25")
    found = find_cuts(video, window(len(frames), fps), fps, rules=RULES)
    # the first frame where the new picture is at least half: blend share ≥ 0.5 at i = 6
    assert close(found.cuts_sf, [56])


def test_a_white_flash_is_not_a_cut(tmp_path, ffmpeg):
    a = texture(3)
    frames = [a] * 40 + [bytes([250]) * (W * H)] + [a] * 40
    fps = Fps(25, 1)
    video = encode(tmp_path / "flash.mp4", frames, "25")
    assert find_cuts(video, window(len(frames), fps), fps, rules=RULES).cuts_sf == []


def test_a_vfr_source_is_cut_on_the_30_fps_grid(tmp_path, ffmpeg):
    lengths = [45, 38, 50]
    video = encode(tmp_path / "vfr.mkv", shots(lengths, seed=4), "30", vfr=True)
    fps = Fps(30, 1)
    found = find_cuts(video, window(sum(lengths), fps), fps, rules=RULES)
    assert close(found.cuts_sf, cut_frames(lengths))


@pytest.mark.parametrize(("rate", "grid"), [("60000/1001", Fps(30000, 1001)),
                                            ("60", Fps(30, 1))])
def test_a_double_rate_source_is_cut_on_the_half_rate_grid(tmp_path, ffmpeg, rate, grid):
    lengths = [80, 66, 90]  # even source frames: grid frames 40, 73
    video = encode(tmp_path / "double.mp4", shots(lengths, seed=5), rate)
    found = find_cuts(video, window(sum(lengths) // 2, grid), grid, rules=RULES)
    assert close(found.cuts_sf, [40, 73])


def test_ffmpeg_failing_falls_back_to_the_scene_cuts_then_to_one_shot(tmp_path, monkeypatch):
    def fail(*_args, **_kwargs):
        raise ShotCutsError("no")

    monkeypatch.setattr(shot_cuts, "measure", fail)
    fps = Fps(25, 1)
    found = find_cuts(tmp_path / "missing.mp4", (1000, 9000), fps, rules=RULES,
                      scene_cuts_ms=[500, 2000, 4020, 9000])
    assert (found.cuts_sf, found.source) == ([50, 100], "scene_cuts")
    found = find_cuts(tmp_path / "missing.mp4", (1000, 9000), fps, rules=RULES)
    assert (found.cuts_sf, found.source) == ([], "none")


def test_a_source_ffmpeg_cannot_read_falls_back(tmp_path, ffmpeg):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")
    found = find_cuts(broken, (0, 2000), Fps(25, 1), rules=RULES, scene_cuts_ms=[1000])
    assert (found.cuts_sf, found.source) == ([25], "scene_cuts")


def test_a_scan_past_its_timeout_is_stopped(tmp_path, ffmpeg):
    lengths = [40, 40]
    video = encode(tmp_path / "slow.mp4", shots(lengths), "25")
    with pytest.raises(ShotCutsError, match="time"):
        shot_cuts.measure(video, (0, 3200), Fps(25, 1), timeout_s=0.001)


# --- the pure detector -------------------------------------------------------------------------


def profile(diff: list[int], scene: list[int] | None = None, *,
            far: dict[int, list[int]] | None = None) -> Profile:
    """A profile from per-frame consecutive differences (and, optionally, other lags);
    an unspecified lag adds the consecutive differences it spans (pictures that never return)."""
    n = len(diff)
    lags = {lag: tuple((far or {}).get(lag) or [min(sum(diff[max(k - lag + 1, 0):k + 1]),
                                                    100_000) if k >= lag else 0
                                                for k in range(n)]) for lag in LAGS}
    lags[1] = tuple(diff)
    return Profile(0, tuple(scene or [0] * n), {k: tuple(v[:n]) for k, v in lags.items()})


def test_a_candidate_is_refined_to_the_largest_difference_nearby():
    diff = [0] * 60
    diff[30] = 40_000
    diff[31] = 12_000
    scene = [0] * 60
    scene[29] = 50_000  # the coarse pass is a frame early
    assert detect(profile(diff, scene), Fps(25, 1), rules=RULES) == [30]


def test_a_difference_below_the_refine_threshold_is_dropped():
    diff = [0] * 60
    diff[30] = 9_000
    scene = [0] * 60
    scene[30] = 50_000
    assert detect(profile(diff, scene), Fps(25, 1), rules=RULES) == []


def test_camera_plan_flags_only_propose_candidates():
    diff = [0] * 100
    diff[50] = 30_000
    p = profile(diff)
    assert detect(p, Fps(25, 1), rules=RULES) == []  # no scene score: no candidate
    assert detect(p, Fps(25, 1), rules=RULES, coarse_cuts_ms=[1800]) == [50]
    assert detect(p, Fps(25, 1), rules=RULES, coarse_cuts_ms=[200]) == []  # too far


def test_of_two_cuts_closer_than_the_gap_the_stronger_stays():
    diff = [0] * 120
    diff[40], diff[58], diff[100] = 20_000, 35_000, 20_000  # 18 frames = 720 ms apart
    scene = [60_000 if k in (40, 58, 100) else 0 for k in range(120)]
    rules = RULES.with_values({"cut.min_gap_ms": 800})  # 20 frames at 25 fps
    assert detect(profile(diff, scene), Fps(25, 1), rules=rules) == [58, 100]
    rules = RULES.with_values({"cut.min_gap_ms": 300})
    assert detect(profile(diff, scene), Fps(25, 1), rules=rules) == [40, 58, 100]


def test_a_picture_that_returns_within_two_frames_is_a_flash():
    diff = [0] * 60
    diff[30], diff[31] = 60_000, 60_000  # into the flash and back out
    scene = [0] * 60
    scene[30] = scene[31] = 80_000
    back = [0] * 60  # frame 31 against frame 29 (lag 2): the same picture
    assert detect(profile(diff, scene, far={2: back}), Fps(25, 1), rules=RULES) == []


def test_the_profile_round_trips_through_json():
    p = profile([0, 5, 9, 3] * 5)
    assert Profile.from_json(p.to_json()) == p
