"""``edit_v2.png_strip``: ancillary PNG chunks removed, critical chunks kept byte for byte (§9.2).

Owner: T3.1. The normalised logo of the asset store keeps only IHDR, PLTE, tRNS, IDAT and IEND
(stdlib only). Anything that is not a well-formed PNG is refused with ``PngError`` (a
``ValueError``), so a malformed upload can never reach the store as "stripped".
"""

from __future__ import annotations

import ast
import struct
import subprocess
import zlib
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import png_strip
from ai_clipper.edit_v2.png_strip import KEEP_CHUNKS, PngError, png_info, strip_png

SIGNATURE = b"\x89PNG\r\n\x1a\n"
MODULE = Path(png_strip.__file__)


def chunk(kind: bytes, body: bytes = b"", *, crc: int | None = None,
          length: int | None = None) -> bytes:
    value = zlib.crc32(kind + body) & 0xFFFFFFFF if crc is None else crc
    size = len(body) if length is None else length
    return struct.pack(">I", size) + kind + body + struct.pack(">I", value)


def ihdr(width: int = 2, height: int = 2, depth: int = 8, colour: int = 6,
         compression: int = 0, filtering: int = 0, interlace: int = 0) -> bytes:
    return chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, colour, compression,
                                      filtering, interlace))


def idat(width: int = 2, height: int = 2, channels: int = 4) -> bytes:
    raw = b"".join(b"\x00" + bytes(range(width * channels)) for _ in range(height))
    return chunk(b"IDAT", zlib.compress(raw))


def png(*chunks: bytes) -> bytes:
    return SIGNATURE + b"".join(chunks)


def basic(*extra_before_idat: bytes, after: tuple[bytes, ...] = ()) -> bytes:
    return png(ihdr(), *extra_before_idat, idat(), *after, chunk(b"IEND"))


def kinds(data: bytes) -> list[bytes]:
    out = []
    position = 8
    while position < len(data):
        (length,) = struct.unpack(">I", data[position:position + 4])
        out.append(data[position + 4:position + 8])
        position += 12 + length
    return out


def test_only_the_five_critical_chunks_are_kept():
    assert KEEP_CHUNKS == (b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND")


def test_ancillary_chunks_are_removed_and_the_kept_ones_are_copied_byte_for_byte():
    ancillary = [
        chunk(b"tEXt", b"Comment\x00<script>alert(1)</script>"),
        chunk(b"zTXt", b"Title\x00\x00" + zlib.compress(b"x" * 1000)),
        chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00<x:xmpmeta/>"),
        chunk(b"eXIf", b"MM\x00*\x00\x00\x00\x08\x00\x00"),
        chunk(b"iCCP", b"icc\x00\x00" + zlib.compress(b"profile")),
        chunk(b"gAMA", struct.pack(">I", 45455)),
        chunk(b"cHRM", bytes(32)),
        chunk(b"sRGB", b"\x00"),
        chunk(b"pHYs", bytes(9)),
        chunk(b"tIME", bytes(7)),
        chunk(b"acTL", bytes(8)),
        chunk(b"fcTL", bytes(26)),
        chunk(b"prVW", b"private ancillary"),
    ]
    source = png(ihdr(), *ancillary, idat(), chunk(b"fdAT", bytes(8)), chunk(b"IEND"))
    stripped = strip_png(source)
    assert kinds(stripped) == [b"IHDR", b"IDAT", b"IEND"]
    assert stripped == png(ihdr(), idat(), chunk(b"IEND"))
    assert b"<script>" not in stripped and b"xmpmeta" not in stripped


def test_palette_and_transparency_survive():
    palette = chunk(b"PLTE", bytes(range(12)))
    trns = chunk(b"tRNS", b"\x00\xff\x80")
    source = png(ihdr(colour=3), chunk(b"gAMA", bytes(4)), palette, trns,
                 chunk(b"bKGD", b"\x00"), idat(channels=1), chunk(b"IEND"))
    stripped = strip_png(source)
    assert kinds(stripped) == [b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"]
    assert palette in stripped and trns in stripped


def test_several_idat_chunks_stay_in_order():
    raw = b"".join(b"\x00" + bytes(8) for _ in range(2))
    body = zlib.compress(raw)
    first, second = chunk(b"IDAT", body[:5]), chunk(b"IDAT", body[5:])
    stripped = strip_png(png(ihdr(), first, second, chunk(b"IEND")))
    assert stripped == png(ihdr(), first, second, chunk(b"IEND"))


def test_stripping_is_idempotent():
    source = basic(chunk(b"tEXt", b"a\x00b"))
    once = strip_png(source)
    assert strip_png(once) == once


def test_png_info_reads_ihdr():
    info = png_info(png(ihdr(640, 360, 16, 2, interlace=1), idat(), chunk(b"IEND")))
    assert (info.width, info.height, info.bit_depth, info.color_type, info.interlace) == (
        640, 360, 16, 2, 1)


@pytest.mark.parametrize("data", [
    b"",
    b"GIF89a" + bytes(40),
    b"<svg xmlns='http://www.w3.org/2000/svg'/>",
    SIGNATURE,
    SIGNATURE[:7] + b"\x00" + ihdr()[8:],
])
def test_non_png_input_is_refused(data):
    with pytest.raises(PngError):
        strip_png(data)
    with pytest.raises(ValueError):  # PngError is a ValueError
        strip_png(data)


@pytest.mark.parametrize("name,data", [
    ("truncated chunk", basic()[:-3]),
    ("truncated length field", basic()[:-10]),
    ("crc mismatch", png(ihdr(), chunk(b"IDAT", b"x", crc=0), chunk(b"IEND"))),
    ("ancillary crc mismatch", png(ihdr(), chunk(b"tEXt", b"a\x00b", crc=1), idat(),
                                   chunk(b"IEND"))),
    ("ihdr not first", png(idat(), ihdr(), chunk(b"IEND"))),
    ("ihdr wrong length", png(chunk(b"IHDR", bytes(12)), idat(), chunk(b"IEND"))),
    ("two ihdr", png(ihdr(), ihdr(), idat(), chunk(b"IEND"))),
    ("zero width", png(ihdr(width=0), idat(), chunk(b"IEND"))),
    ("zero height", png(ihdr(height=0), idat(), chunk(b"IEND"))),
    ("width over 2^31-1", png(ihdr(width=1 << 31), idat(), chunk(b"IEND"))),
    ("bad depth for rgba", png(ihdr(depth=4, colour=6), idat(), chunk(b"IEND"))),
    ("bad colour type", png(ihdr(colour=5), idat(), chunk(b"IEND"))),
    ("bad compression", png(ihdr(compression=1), idat(), chunk(b"IEND"))),
    ("bad filter method", png(ihdr(filtering=1), idat(), chunk(b"IEND"))),
    ("bad interlace", png(ihdr(interlace=2), idat(), chunk(b"IEND"))),
    ("no idat", png(ihdr(), chunk(b"IEND"))),
    ("idat not consecutive", png(ihdr(), idat(), chunk(b"tEXt", b"a\x00b"), idat(),
                                 chunk(b"IEND"))),
    ("plte after idat", png(ihdr(colour=3), idat(channels=1), chunk(b"PLTE", bytes(3)),
                            chunk(b"IEND"))),
    ("palette image without plte", png(ihdr(colour=3), idat(channels=1), chunk(b"IEND"))),
    ("plte for greyscale", png(ihdr(colour=0), chunk(b"PLTE", bytes(3)), idat(channels=1),
                               chunk(b"IEND"))),
    ("plte length not a multiple of 3", png(ihdr(colour=3), chunk(b"PLTE", bytes(4)),
                                            idat(channels=1), chunk(b"IEND"))),
    ("two plte", png(ihdr(colour=3), chunk(b"PLTE", bytes(3)), chunk(b"PLTE", bytes(3)),
                     idat(channels=1), chunk(b"IEND"))),
    ("trns after idat", png(ihdr(), idat(), chunk(b"tRNS", bytes(6)), chunk(b"IEND"))),
    ("missing iend", png(ihdr(), idat())),
    ("iend with data", png(ihdr(), idat(), chunk(b"IEND", b"x"))),
    ("data after iend", basic() + b"PK\x03\x04 zip polyglot"),
    ("chunk after iend", basic() + chunk(b"tEXt", b"a\x00b")),
    ("unknown critical chunk", png(ihdr(), chunk(b"ABCD", b"x"), idat(), chunk(b"IEND"))),
    ("chunk type with a digit", png(ihdr(), chunk(b"tEX1", b"x"), idat(), chunk(b"IEND"))),
    ("chunk length over 2^31-1", png(ihdr(), chunk(b"tEXt", b"", length=1 << 31), idat(),
                                     chunk(b"IEND"))),
])
def test_malformed_png_is_refused(name, data):
    with pytest.raises(PngError):
        strip_png(data)


def test_the_input_size_is_capped():
    source = basic(chunk(b"tEXt", b"a\x00" + bytes(4096)))
    with pytest.raises(PngError):
        strip_png(source, max_bytes=len(source) - 1)
    assert kinds(strip_png(source, max_bytes=len(source))) == [b"IHDR", b"IDAT", b"IEND"]


def test_a_real_encoder_output_is_stripped_and_still_decodes(tmp_path, edit_v2_ffmpeg):
    target = tmp_path / "logo.png"
    subprocess.run([edit_v2_ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=s=97x61,format=rgba", "-frames:v", "1",
                    "-metadata", "comment=secret-metadata", str(target)], check=True)
    source = target.read_bytes()
    stripped = strip_png(source)
    assert set(kinds(stripped)) <= set(KEEP_CHUNKS)
    assert png_info(stripped).width == 97 and png_info(stripped).height == 61

    def rgba(data: bytes) -> bytes:
        return subprocess.run([edit_v2_ffmpeg, "-nostdin", "-loglevel", "error", "-f", "png_pipe",
                               "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
                              input=data, capture_output=True, check=True).stdout

    assert rgba(stripped) == rgba(source)


def test_the_module_uses_the_standard_library_only():
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            imported.add((node.module or "").split(".")[0])
    assert imported <= {"__future__", "dataclasses", "struct", "zlib"}
