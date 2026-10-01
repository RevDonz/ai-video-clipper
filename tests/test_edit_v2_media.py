"""Synthetic Editor V3 test media (tests/support/edit_v2_media.py, plan §11.1 T1.0).

The barcode source carries its frame index as a 24-bit band code plus a column ruler (the source
column index, Gray-coded in vertical bits) so that the frame index and the crop x can be read
back from any rendered frame. Audio is tone bursts with single-sample click markers.
"""

from __future__ import annotations

from itertools import pairwise

import pytest
from support import edit_v2_media as media


def test_pattern_geometry_fits_the_frame():
    pattern = media.Pattern.for_size(640, 360)
    assert pattern.band_h % 2 == 0 and pattern.band_h >= 2
    assert pattern.ruler_bits == 10  # columns 0..639
    assert pattern.index_top == 0
    assert pattern.ruler_top == media.INDEX_BANDS * pattern.band_h
    assert pattern.bg_top == pattern.ruler_top + pattern.ruler_bits * pattern.band_h
    assert pattern.bg_top < 360
    assert media.Pattern.for_size(1920, 1080).ruler_bits == 11
    with pytest.raises(ValueError):
        media.Pattern.for_size(641, 360)


def test_synthetic_frame_round_trips_through_the_decoders():
    pattern = media.Pattern.for_size(320, 180)
    for index in (0, 1, 2, 5, 1000, 2**24 - 1, 0xA5A5A5):
        plane = media.render_luma(pattern, index)
        assert len(plane) == 320 * 180
        assert media.decode_index(plane, 320, 180, pattern) == index
        assert media.decode_ruler(plane, 320, 180, pattern) == list(range(320))
    assert media.decode_index(bytes(320 * 180), 320, 180, pattern) is None


@pytest.fixture(scope="module")
def cfr_clip(tmp_path_factory, edit_v2_ffmpeg):
    path = tmp_path_factory.mktemp("media") / "cfr.mkv"
    spec = media.VideoSpec(width=320, height=180, fps=(30000, 1001), frames=45, container="mkv",
                           audio=media.AudioSpec(channels=2, bursts=media.default_bursts(1600),
                                                 clicks_ms=(250, 1250)))
    media.make_barcode_video(path, spec)
    return path, spec


def test_cfr_barcode_video_decodes_every_frame(cfr_clip):
    path, spec = cfr_clip
    width, height, frames = media.read_gray_frames(path)
    assert (width, height) == (spec.width, spec.height)
    pattern = media.Pattern.for_size(width, height)
    assert [media.decode_index(frame, width, height, pattern) for frame in frames] == list(
        range(spec.frames)
    )
    for frame in frames[:3]:
        assert media.decode_ruler(frame, width, height, pattern) == list(range(width))
    info = media.probe(path)
    assert info["video"]["r_frame_rate"] == "30000/1001"
    assert info["video"]["color_space"] == "bt709"


def test_whole_file_grid_matches_generation_indices(cfr_clip):
    path, spec = cfr_clip
    assert media.grid_indices(path, spec.fps) == list(range(spec.frames))


def test_clicks_land_on_their_samples_and_bursts_are_audible(cfr_clip):
    path, spec = cfr_clip
    samples = media.read_pcm(path, sample_rate=48000, channels=2)
    assert len(samples) // 2 == media.audio_samples(spec.frames, spec.fps, 48000)
    assert media.find_clicks(samples, channels=2) == [12000, 60000]
    burst = spec.audio.bursts[0]
    start = burst.start_ms * 48 + 480
    window = samples[start * 2 : (start + 480) * 2]
    assert max(abs(value) for value in window) > 4000
    quiet = samples[(burst.end_ms * 48 + 480) * 2 : (burst.end_ms * 48 + 960) * 2]
    assert max(abs(value) for value in quiet) == 0


def test_vfr_variant_has_jittered_timestamps_and_dropped_frames(tmp_path, edit_v2_ffmpeg):
    path = tmp_path / "vfr.mkv"
    spec = media.VideoSpec(width=320, height=180, fps=(30, 1), frames=40, vfr=True, drop_every=7,
                           container="mkv", audio=None)
    media.make_barcode_video(path, spec)
    width, height, frames = media.read_gray_frames(path)
    pattern = media.Pattern.for_size(width, height)
    indices = [media.decode_index(frame, width, height, pattern) for frame in frames]
    assert indices == [n for n in range(40) if n % 7 != 6]
    times = media.frame_times_ms(path)
    assert len(times) == len(indices)
    steps = {round(b - a) for a, b in pairwise(times)}
    assert len(steps) >= 3  # 33/34/35 ms jitter plus the doubled step at each drop


def test_scene_cut_variant_flashes_the_background(tmp_path, edit_v2_ffmpeg):
    path = tmp_path / "cuts.mp4"
    spec = media.VideoSpec(width=320, height=180, fps=(25, 1), frames=20, scene_cut_every=5,
                           audio=None)
    media.make_barcode_video(path, spec)
    width, height, frames = media.read_gray_frames(path)
    pattern = media.Pattern.for_size(width, height)
    row = (pattern.bg_top + height) // 2
    levels = [frame[row * width + width // 2] for frame in frames]
    assert [level > 200 for level in levels] == [(n // 5) % 2 == 1 for n in range(20)]


def test_index_survives_fit_blur_style_downscaling(cfr_clip, edit_v2_ffmpeg):
    path, _spec = cfr_clip
    # fit_blur foreground: scale to the output width and centre vertically in 720x1280.
    width, height, frames = media.read_gray_frames(
        path, vf="scale=720:-2,pad=720:1280:0:(oh-ih)/2", size=(720, 1280)
    )
    pattern = media.Pattern.for_size(320, 180)
    scale = 720 / 320
    top = (1280 - 180 * scale) / 2
    decoded = [media.decode_index(f, width, height, pattern, scale=scale, top=top) for f in frames]
    assert decoded == list(range(len(frames)))


@pytest.mark.parametrize("crop_x", [0, 1, 137, 250, 311])
def test_crop_x_is_recovered_exactly_from_the_column_ruler(cfr_clip, edit_v2_ffmpeg, crop_x):
    path, _spec = cfr_clip
    # fill_center/camera: scale to the output height, then crop the output width at crop_x.
    scaled_w = 569  # 320x180 -> 569x320 (force_original_aspect_ratio=increase, even-rounded)
    width, height, frames = media.read_gray_frames(
        path, vf=f"scale={scaled_w}:320,crop=256:320:{crop_x}:0", size=(256, 320)
    )
    pattern = media.Pattern.for_size(320, 180)
    scale = scaled_w / 320
    for frame in frames[:5]:
        assert media.decode_crop_x(frame, width, height, pattern, scale=scale) == crop_x
        assert media.decode_index(frame, width, height, pattern, scale=320 / 180) is not None


def test_audio_file_generator_and_logo(tmp_path, edit_v2_ffmpeg):
    wav = media.make_audio(tmp_path / "music.wav", media.AudioSpec(
        sample_rate=44100, channels=1,
        bursts=(media.ToneBurst(0, 900, freq_hz=441, level_cdb=-600),), clicks_ms=()),
        duration_ms=1000)
    info = media.probe(wav)
    assert info["audio"]["sample_rate"] == "44100" and info["audio"]["channels"] == 1
    samples = media.read_pcm(wav, sample_rate=44100, channels=1)
    assert len(samples) == 44100
    assert 16000 < max(samples) < 16500  # -6 dBFS
    png = media.make_logo_png(tmp_path / "logo.png", 64, 32)
    info = media.probe(png)
    assert (info["video"]["width"], info["video"]["height"]) == (64, 32)
    assert info["video"]["pix_fmt"] == "rgba"


def test_reference_toolchain_detection_reports_a_reason_off_the_image():
    problem = media.reference_toolchain_problem()
    assert problem is None or "5.1.9" in problem or "libass" in problem or "dpkg" in problem
