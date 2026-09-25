"""Derived logo bitmaps: exact box, opacity baked into alpha, ancillary chunks stripped
(plan §5.5, §5.1 ``derive_image``)."""

from __future__ import annotations

import hashlib
import struct
import subprocess
import zlib
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from support import edit_v2_media as media
from test_edit_v2_plan import HARNESS, context_for, load_doc

from ai_clipper.edit_v2 import compile_ffmpeg, execute
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.derive import (
    KEEP_CHUNKS,
    derive_filter,
    derive_image,
    png_size,
    strip_png,
)
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan


def chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def chunk_types(data: bytes) -> list[bytes]:
    types = []
    position = 8
    while position < len(data):
        length = struct.unpack(">I", data[position:position + 4])[0]
        types.append(data[position + 4:position + 8])
        position += 12 + length
    return types


def rgba_pixels(png: bytes, size: tuple[int, int]) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "png_pipe", "-i", "pipe:0", "-f", "rawvideo",
         "-pix_fmt", "rgba", "-"], input=png, capture_output=True, check=True).stdout


def test_derive_filter_bakes_the_opacity():
    assert derive_filter(115, 115, 850) == (
        "scale=115:115:flags=lanczos,format=rgba,colorchannelmixer=aa=0.850")
    assert derive_filter(40, 10, 1000).endswith("aa=1.000")
    assert derive_filter(40, 10, 200).endswith("aa=0.200")
    for bad in ((0, 10, 500), (10, 4097, 500), (10, 10, 1001), (10, 10, -1)):
        with pytest.raises(ValueError):
            derive_filter(*bad)


def test_derive_image_box_alpha_and_chunks(tmp_path, edit_v2_ffmpeg):
    logo = media.make_logo_png(tmp_path / "logo.png", 512, 512)
    png = derive_image(logo, w=115, h=115, opacity_pm=850)
    assert png_size(png) == (115, 115)
    assert set(chunk_types(png)) <= set(KEEP_CHUNKS)
    assert chunk_types(png)[0] == b"IHDR" and chunk_types(png)[-1] == b"IEND"
    color_type = png[8 + 8 + 9]
    assert color_type == 6  # RGBA, 8 bit
    pixels = rgba_pixels(png, (115, 115))
    assert len(pixels) == 115 * 115 * 4

    def pixel(x, y):
        offset = 4 * (y * 115 + x)
        return tuple(pixels[offset:offset + 4])

    scaled = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(logo), "-vf",
         "scale=115:115:flags=lanczos,format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        capture_output=True, check=True).stdout
    for x, y in ((57, 57), (5, 5), (100, 20)):
        offset = 4 * (y * 115 + x)
        assert pixel(x, y)[:3] == tuple(scaled[offset:offset + 3])  # colour untouched
        assert abs(pixel(x, y)[3] - scaled[offset + 3] * 0.85) <= 1  # opacity baked in
    assert pixel(57, 57)[:3] == (255, 204, 0)
    again = derive_image(logo, w=115, h=115, opacity_pm=850)
    assert again == png  # deterministic bytes: both sides draw the same file


def test_derive_image_keeps_the_exact_box_for_wide_logos(tmp_path, edit_v2_ffmpeg):
    logo = media.make_logo_png(tmp_path / "wide.png", 800, 200)
    _x0, _y0, w, h = tm.logo_box(x_e5=50000, y_e5=90000, w_e5=24000, asset_w=800, asset_h=200,
                               out_w=1080, out_h=1920)
    png = derive_image(logo, w=w, h=h, opacity_pm=1000)
    assert png_size(png) == (w, h) == (259, 65)


def test_derive_image_refuses_links_and_missing_files(tmp_path, edit_v2_ffmpeg):
    logo = media.make_logo_png(tmp_path / "logo.png", 64, 64)
    link = tmp_path / "link.png"
    link.symlink_to(logo)
    with pytest.raises(OSError):
        derive_image(link, w=10, h=10, opacity_pm=500)
    with pytest.raises(FileNotFoundError):
        derive_image(tmp_path / "missing.png", w=10, h=10, opacity_pm=500)


def test_strip_png_keeps_only_the_image_chunks():
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
    idat = chunk(b"IDAT", zlib.compress(b"\x00" + b"\x10" * 8))
    plte = chunk(b"PLTE", b"\x00\x00\x00")
    trns = chunk(b"tRNS", b"\x00")
    data = (b"\x89PNG\r\n\x1a\n" + ihdr + chunk(b"gAMA", b"\x00\x00\xb1\x8f")
            + chunk(b"cHRM", b"\x00" * 32) + chunk(b"pHYs", b"\x00" * 9) + plte + trns
            + chunk(b"tEXt", b"Comment\x00secret") + idat + chunk(b"iTXt", b"x\x00\x00\x00\x00\x00y")
            + chunk(b"eXIf", b"MM\x00*") + chunk(b"IEND", b""))
    stripped = strip_png(data)
    assert chunk_types(stripped) == [b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"]
    assert stripped == b"\x89PNG\r\n\x1a\n" + ihdr + plte + trns + idat + chunk(b"IEND", b"")
    assert strip_png(stripped) == stripped
    assert png_size(stripped) == (2, 1)


@pytest.mark.parametrize(
    "broken",
    [
        b"GIF89a....",
        b"\x89PNG\r\n\x1a\n",
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00" * 13)[:-1] + b"\x00",  # bad CRC
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00" * 13) + chunk(b"IDAT", b"x"),  # no IEND
        b"\x89PNG\r\n\x1a\n" + chunk(b"IDAT", b"x") + chunk(b"IEND", b""),  # IHDR not first
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00" * 13) + b"\x00\x00\x10",  # truncated
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00" * 13) + chunk(b"IEND", b"") + b"junk",
    ],
)
def test_strip_png_rejects_broken_files(broken):
    with pytest.raises(ValueError):
        strip_png(broken)


def test_compile_job_derives_the_plans_logo(tmp_path, monkeypatch, edit_v2_ffmpeg):
    for module, name, function in HARNESS.HARNESS_PATCHES:
        monkeypatch.setattr(module, name, function)
    logo = media.make_logo_png(tmp_path / "logo.png", 512, 512)
    digest = fixtures.LOGO.split(":", 1)[1]
    (tmp_path / "assets").mkdir()
    stored = tmp_path / "assets" / f"{digest}.png"
    logo.rename(stored)
    context = context_for("logo__c30")
    plan = build_plan(load_doc("logo__c30"), words=context.words, camera=None,
                      assets=context.assets, resources=Resources(RESOURCES_DIR))
    job = compile_ffmpeg.compile_job(plan, mode="derive_image", source=Path("/unused"),
                                     assets_root=tmp_path / "assets")
    assert [spec.kind for spec in job.inputs] == ["asset"]
    assert job.inputs[0].name == fixtures.LOGO
    assert job.expected["paths"][fixtures.LOGO] == str(stored)
    assert derive_filter(plan.logo.w, plan.logo.h, plan.logo.opacity_pm) in job.filter_script
    result = execute.run(job, output_fd=None, timeout_s=30)
    direct = derive_image(stored, w=plan.logo.w, h=plan.logo.h,
                          opacity_pm=plan.logo.opacity_pm)
    assert result.output == direct
    assert hashlib.sha256(direct).hexdigest()
