"""Derived logo bitmaps: the exact pixel box with the opacity baked in (plan §5.5, §5.1).

``derive_image`` scales a normalised logo to exactly ``w×h``
(``scale=w:h:flags=lanczos,format=rgba,colorchannelmixer=aa=<opacity>``) and returns PNG bytes
with every ancillary chunk stripped. The browser draws these bytes 1:1 at ``(x0, y0)``; the
compiler overlays the same chain applied to the same asset inside the final graph
(``derive_filter``), which yields the same RGBA pixels, because PNG is lossless and both run the
same deterministic filters. The preview lane stores the bytes as
``preview/derived/<asset_sha16>@<w>x<h>.png``.
"""

from __future__ import annotations

import os
import stat
import struct
import zlib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .compile_ffmpeg import (
    DERIVED_PNG,
    GRAPH_FILE,
    INPUT_TOKEN,
    PROGRESS_TOKEN,
    FfmpegJob,
    InputSpec,
)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
KEEP_CHUNKS = (b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND")
MAX_SIDE = 4096
MAX_ASSET_BYTES = 16 << 20  # normalised logos are ≤ 1024 px PNGs (plan §9.2)


def derive_filter(w: int, h: int, opacity_pm: int) -> str:
    """The derive chain: exact box, RGBA, alpha multiplied by ``opacity_pm/1000``."""
    for name, value in (("w", w), ("h", h)):
        if type(value) is not int or not 1 <= value <= MAX_SIDE:
            raise ValueError(f"{name} must be an integer pixel size between 1 and {MAX_SIDE}")
    if type(opacity_pm) is not int or not 0 <= opacity_pm <= 1000:
        raise ValueError("opacity_pm must be between 0 and 1000")
    opacity = f"{opacity_pm // 1000}.{opacity_pm % 1000:03d}"
    return f"scale={w}:{h}:flags=lanczos,format=rgba,colorchannelmixer=aa={opacity}"


def _chunks(data: bytes):
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG file")
    position = len(PNG_SIGNATURE)
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError("truncated PNG chunk")
        (length,) = struct.unpack(">I", data[position:position + 4])
        kind = data[position + 4:position + 8]
        end = position + 12 + length
        if end > len(data):
            raise ValueError("truncated PNG chunk")
        body = data[position + 8:end - 4]
        (crc,) = struct.unpack(">I", data[end - 4:end])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise ValueError("PNG chunk CRC mismatch")
        yield kind, data[position:end]
        position = end


def strip_png(data: bytes) -> bytes:
    """Keep only IHDR, PLTE, tRNS, IDAT and IEND (plan §5.5, §9.2); the kept chunks are copied
    byte for byte. Raises ``ValueError`` for anything that is not a well-formed PNG."""
    kept = []
    kinds = []
    ended = False
    for kind, raw in _chunks(data):
        if ended:
            raise ValueError("data after IEND")
        kinds.append(kind)
        if kind in KEEP_CHUNKS:
            kept.append(raw)
        ended = kind == b"IEND"
    if not kinds or kinds[0] != b"IHDR" or not ended or b"IDAT" not in kinds:
        raise ValueError("PNG must start with IHDR, contain IDAT and end with IEND")
    return PNG_SIGNATURE + b"".join(kept)


def png_size(data: bytes) -> tuple[int, int]:
    """``(width, height)`` from the IHDR chunk."""
    if not data.startswith(PNG_SIGNATURE) or data[12:16] != b"IHDR":
        raise ValueError("not a PNG file")
    return struct.unpack(">II", data[16:24])


def derive_job(spec: InputSpec, *, w: int, h: int, opacity_pm: int,
               expected: Mapping[str, Any] | None = None,
               sidecars: Mapping[str, bytes] | None = None) -> FfmpegJob:
    """The FFmpeg job of one derived bitmap; ``execute.run`` returns the stripped PNG."""
    chain = derive_filter(w, h, opacity_pm)
    argv = ("ffmpeg", "-nostdin", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-progress", PROGRESS_TOKEN, "-threads", "2", "-protocol_whitelist", "file,pipe",
            *spec.options, "-i", INPUT_TOKEN.format(0), "-filter_complex_script", GRAPH_FILE,
            "-map", "[out]", "-frames:v", "1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
            "-f", "image2", "-c:v", "png", "-pix_fmt", "rgba", DERIVED_PNG)
    return FfmpegJob(argv=argv, filter_script=f"[0:v]{chain}[out]\n", inputs=(spec,),
                     sidecars=dict(sidecars or {}),
                     expected={"mode": "derive_image", "output": "png", "result": DERIVED_PNG,
                               "size": [w, h], **dict(expected or {})})


def _read_asset(asset: Path) -> bytes:
    fd = os.open(asset, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ASSET_BYTES:
            raise ValueError("asset is not a regular file of an accepted size")
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def derive_image(
    asset: Path, *, w: int, h: int, opacity_pm: int, timeout_s: float = 20.0
) -> bytes:
    """PNG bytes of ``asset`` scaled to exactly ``w``×``h`` (``scale=w:h:flags=lanczos,
    format=rgba,colorchannelmixer=aa=<opacity>``), ancillary chunks stripped.

    ``w``/``h`` come from ``timemap.logo_box``; both FFmpeg and the browser draw these bytes
    1:1 at ``(x0, y0)``. The preview lane stores them as
    ``preview/derived/<asset_sha16>@<w>x<h>.png``. The asset is opened without following a
    symbolic link and read into the private directory of the run.
    """
    from . import execute

    data = _read_asset(Path(asset))
    job = derive_job(InputSpec("sidecar", "asset.png", ("-f", "png_pipe")), w=w, h=h,
                     opacity_pm=opacity_pm, sidecars={"asset.png": data})
    result = execute.run(job, output_fd=None, timeout_s=timeout_s)
    assert result.output is not None
    if png_size(result.output) != (w, h):
        raise ValueError("derived bitmap has the wrong size")
    return result.output


__all__ = ["KEEP_CHUNKS", "derive_filter", "derive_image", "derive_job", "png_size", "strip_png"]
