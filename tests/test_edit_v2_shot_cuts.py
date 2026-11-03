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
            far: dict[int, list[int]] | None = None,
            edges: dict[int, int] | None = None) -> Profile:
    """A profile from per-frame consecutive differences (and, optionally, other lags);
    an unspecified lag adds the consecutive differences it spans (pictures that never return).
    ``edges`` gives the edge change of single frames; the others keep their edges."""
    n = len(diff)
    lags = {lag: tuple((far or {}).get(lag) or [min(sum(diff[max(k - lag + 1, 0):k + 1]),
                                                    100_000) if k >= lag else 0
                                                for k in range(n)]) for lag in LAGS}
    lags[1] = tuple(diff)
    edge_pm = tuple((edges or {}).get(k, 0) for k in range(n))
    return Profile(0, tuple(scene or [0] * n), {k: tuple(v[:n]) for k, v in lags.items()}, edge_pm)


def test_a_candidate_is_refined_to_the_largest_difference_nearby():
    diff = [0] * 60
    diff[30] = 40_000
    diff[31] = 12_000
    scene = [0] * 60
    scene[29] = 50_000  # the coarse pass is a frame early
    assert detect(profile(diff, scene), Fps(25, 1), rules=RULES) == [30]


def test_a_difference_below_the_refine_threshold_is_dropped():
    diff = [0] * 60
    diff[29], diff[30], diff[31] = 3_000, 9_000, 3_000  # not a lone jump either
    scene = [0] * 60
    scene[30] = 50_000
    assert detect(profile(diff, scene), Fps(25, 1), rules=RULES) == []


def test_a_lone_jump_between_similar_pictures_is_a_cut_without_a_scene_score():
    diff = [300] * 100
    diff[50] = 6_000  # under the refine threshold, over half of it, 20× its neighbours
    assert detect(profile(diff, edges={50: 900}), Fps(25, 1), rules=RULES) == [50]
    diff[49] = 2_000  # 3× a neighbour: motion, not a lone jump
    assert detect(profile(diff, edges={50: 900}), Fps(25, 1), rules=RULES) == []


def test_a_lone_jump_that_keeps_the_edges_is_the_same_picture():
    diff = [300] * 100
    diff[50] = 6_000  # a shape changing colour inside its outline
    assert detect(profile(diff, edges={50: 799}), Fps(25, 1), rules=RULES) == []
    assert detect(profile(diff, edges={50: 800}), Fps(25, 1), rules=RULES) == [50]
    diff[50] = 10_000  # from the refine threshold a lone jump needs no edges to confirm it
    assert detect(profile(diff), Fps(25, 1), rules=RULES) == [50]


def test_edges_replaced_at_one_frame_are_a_cut_however_small_the_difference():
    diff = [50] * 100
    diff[50] = 2_500  # two flat pictures: under half the refine threshold
    assert detect(profile(diff, edges={50: 1_099}), Fps(25, 1), rules=RULES) == []
    assert detect(profile(diff, edges={50: 1_100}), Fps(25, 1), rules=RULES) == [50]


def test_edges_changing_on_a_neighbouring_frame_too_are_motion():
    diff = [50] * 100
    diff[50] = 2_500
    near = {49: 800, 50: 1_199}  # not 1.5× its neighbour
    assert detect(profile(diff, edges=near), Fps(25, 1), rules=RULES) == []
    near = {49: 800, 50: 1_200}
    assert detect(profile(diff, edges=near), Fps(25, 1), rules=RULES) == [50]


def test_a_transition_that_ends_in_a_new_settled_picture_is_a_cut():
    diff = [50] * 100
    diff[48], diff[49], diff[50] = 2_000, 3_000, 4_000  # a whip into the new picture
    ramp = {48: 1_200, 49: 1_400, 50: 1_500, 51: 750}  # the edges still move before it
    assert detect(profile(diff, edges=ramp), Fps(25, 1), rules=RULES) == [50]
    assert detect(profile(diff, edges={**ramp, 50: 1_499}), Fps(25, 1), rules=RULES) == []
    assert detect(profile(diff, edges={**ramp, 51: 751}), Fps(25, 1), rules=RULES) == []


def test_edges_that_return_within_two_frames_are_a_flash():
    diff = [50] * 100
    diff[50], diff[51] = 2_500, 2_500
    back = [0] * 100  # frame 51 against frame 49 (lag 2): the same picture
    edges = {50: 2_000, 51: 2_000}
    assert detect(profile(diff, far={2: back}, edges=edges), Fps(25, 1), rules=RULES) == []


def test_the_edge_change_is_the_share_entering_and_the_share_leaving():
    width, height = shot_cuts.EDGE_SIZE

    def frame(*points: tuple[int, int]) -> bytes:
        pixels = bytearray(width * height)
        for x, y in points:
            pixels[y * width + x] = 255
        return bytes(pixels)

    assert shot_cuts.EDGE_FLOOR == width * height // 100
    floor = shot_cuts.EDGE_FLOOR
    run = range(floor // 2)
    line = [(x, y) for y in (20, 30) for x in run]
    same = shot_cuts._Edges(frame(*line))
    # a pixel away is the same edge: encoding moves an edge by that much
    moved = shot_cuts._Edges(frame(*[(x, y + 1) for x, y in line]))
    assert same.change_from(same) == 0
    assert moved.change_from(same) == 0
    # all of it replaced: 1000 entering, 1000 leaving
    away = shot_cuts._Edges(frame(*[(x, y + 70) for x, y in line]))
    assert away.change_from(same) == 2000
    # half of it replaced
    half = shot_cuts._Edges(frame(*[(x, 20) for x in run], *[(x, 90) for x in run]))
    assert half.change_from(same) == 1000
    # under the floor the shares count against the floor, not against a handful of pixels
    few = shot_cuts._Edges(frame(*line[:floor // 4]))
    empty = shot_cuts._Edges(frame())
    assert few.change_from(empty) == 250
    assert empty.change_from(few) == 250


def test_the_first_and_last_column_are_not_neighbours():
    width, height = shot_cuts.EDGE_SIZE
    pixels = bytearray(width * height)
    pixels[width * 10 - 1] = 255  # the end of row 9
    next_row = bytearray(width * height)
    next_row[width * 12] = 255  # the start of row 12: three rows down
    wrapped = bytearray(width * height)
    wrapped[width * 10] = 255  # the start of row 10: the next pixel in memory, not in the picture
    a = shot_cuts._Edges(bytes(pixels))
    assert shot_cuts._Edges(bytes(next_row)).change_from(a) > 0
    assert shot_cuts._Edges(bytes(wrapped)).change_from(a) > 0


def outlined(shapes: list[tuple[int, int, int, int]], *, fill: int = 240) -> bytes:
    """A flat picture: thin dark outlines on a light ground, each shape filled with ``fill``."""
    pixels = bytearray([240]) * (W * H)
    for left, top, right, bottom in shapes:
        for y in range(top, bottom):
            for x in range(left, right):
                border = x in (left, right - 1) or y in (top, bottom - 1)
                pixels[y * W + x] = 40 if border else fill
    return bytes(pixels)


def test_a_cut_between_two_flat_pictures_is_found_by_its_edges(tmp_path, ffmpeg):
    a = outlined([(10, 10, 40, 40), (60, 50, 90, 80), (120, 10, 150, 30)])
    b = outlined([(20, 55, 50, 85), (70, 8, 100, 38), (115, 45, 150, 75)])
    frames = [a] * 40 + [b] * 40
    fps = Fps(25, 1)
    video = encode(tmp_path / "flat.mp4", frames, "25")
    measured = shot_cuts.measure(video, window(len(frames), fps), fps, timeout_s=60)
    assert measured.lag[1][40] < RULES.cut_refine_diff_pm * 100 // 2  # the difference misses it
    assert find_cuts(video, window(len(frames), fps), fps, rules=RULES).cuts_sf == [40]


def test_a_shape_filling_with_colour_inside_its_outline_is_not_a_cut(tmp_path, ffmpeg):
    shapes = [(10, 8, 150, 82)]
    frames = [outlined(shapes)] * 40 + [outlined(shapes, fill=215)] * 40
    fps = Fps(25, 1)
    video = encode(tmp_path / "fill.mp4", frames, "25")
    measured = shot_cuts.measure(video, window(len(frames), fps), fps, timeout_s=60)
    threshold = RULES.cut_refine_diff_pm * 100
    assert threshold // 2 <= measured.lag[1][40] < threshold  # a lone jump by its difference
    assert find_cuts(video, window(len(frames), fps), fps, rules=RULES).cuts_sf == []


def test_camera_plan_flags_only_propose_candidates():
    diff = [0] * 100
    diff[49], diff[50] = 10_000, 30_000  # a cut, but not a lone jump
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


def test_a_dip_through_black_is_one_cut_where_the_new_picture_arrives(tmp_path, ffmpeg):
    a, b, black = texture(11), texture(12), bytes([16]) * (W * H)
    frames = ([a] * 50 + [blend(a, black, (i + 1) / 9) for i in range(8)] + [black] * 2
              + [blend(black, b, (i + 1) / 9) for i in range(8)] + [b] * 50)
    fps = Fps(25, 1)
    video = encode(tmp_path / "dip.mp4", frames, "25")
    found = find_cuts(video, window(len(frames), fps), fps, rules=RULES)
    # the new picture is at least half there from the fourth frame of the fade in (60 + 3)
    assert close(found.cuts_sf, [63])


def test_a_steady_pan_is_not_a_cut():
    diff = [3_000] * 120  # the picture moves the same amount every frame
    far = {2: [6_000] * 120, 3: [9_000] * 120, 12: [36_000] * 120}
    assert detect(profile(diff, far=far), Fps(25, 1), rules=RULES) == []


def test_the_profile_round_trips_through_json():
    p = profile([0, 5, 9, 3] * 5, edges={3: 1500})
    assert Profile.from_json(p.to_json()) == p


def test_a_profile_without_the_edge_change_is_refused():
    stored = profile([0, 5, 9, 3] * 5).to_json()
    del stored["edge_pm"]
    with pytest.raises(KeyError):
        Profile.from_json(stored)
    stored = profile([0, 5, 9, 3] * 5).to_json()
    stored["edge_pm"] = stored["edge_pm"][:-1]
    with pytest.raises(ValueError, match="every frame"):
        Profile.from_json(stored)
