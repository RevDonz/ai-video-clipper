"""PNG ancillary-chunk stripping for the job asset store (plan §9.2 "Normalise"; T3.1).

Stdlib only. :func:`strip_png` keeps exactly the critical chunks a static image needs, IHDR,
PLTE, tRNS, IDAT and IEND, each copied byte for byte, and drops every other chunk: text and XMP
(``tEXt``/``zTXt``/``iTXt``), EXIF (``eXIf``), colour metadata (``iCCP``, ``gAMA``, ``cHRM``,
``sRGB``, …), animation (``acTL``/``fcTL``/``fdAT``, so an APNG becomes its default image) and
private chunks. The normalised logo is then plain sRGB RGBA pixels with nothing else in it.

Anything that is not a well-formed PNG raises :class:`PngError` (a ``ValueError``): a bad
signature, a truncated chunk, a CRC mismatch (checked on every chunk, kept or not), IHDR that is
not first or not valid, PLTE/tRNS/IDAT out of order, an unknown critical chunk, or any byte after
IEND (the PNG+ZIP polyglot). The input size is capped before anything is parsed.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
KEEP_CHUNKS = (b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND")
MAX_PNG_BYTES = 64 << 20
MAX_CHUNK_LENGTH = (1 << 31) - 1
MAX_DIMENSION = (1 << 31) - 1
# Allowed bit depths per colour type (PNG spec, table 11.1).
_DEPTHS = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}


class PngError(ValueError):
    """The bytes are not a well-formed PNG (the message never contains the input)."""


@dataclass(frozen=True)
class PngInfo:
    width: int
    height: int
    bit_depth: int
    color_type: int
    interlace: int


def _chunks(data: bytes):
    """Yield ``(kind, body, raw)`` for every chunk, CRC verified; trailing bytes are an error."""
    position = len(PNG_SIGNATURE)
    end = len(data)
    while position < end:
        if position + 12 > end:
            raise PngError("truncated chunk")
        (length,) = struct.unpack_from(">I", data, position)
        if length > MAX_CHUNK_LENGTH:
            raise PngError("chunk length out of range")
        kind = data[position + 4:position + 8]
        if not all(65 <= byte <= 90 or 97 <= byte <= 122 for byte in kind):
            raise PngError("invalid chunk type")
        stop = position + 12 + length
        if stop > end:
            raise PngError("truncated chunk")
        body = data[position + 8:stop - 4]
        (crc,) = struct.unpack_from(">I", data, stop - 4)
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise PngError("chunk CRC mismatch")
        yield kind, body, data[position:stop]
        position = stop


def _ihdr(body: bytes) -> PngInfo:
    if len(body) != 13:
        raise PngError("IHDR must be 13 bytes")
    width, height, depth, colour, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
    if not (1 <= width <= MAX_DIMENSION and 1 <= height <= MAX_DIMENSION):
        raise PngError("image size out of range")
    if depth not in _DEPTHS.get(colour, ()):
        raise PngError("invalid colour type or bit depth")
    if compression != 0 or filtering != 0 or interlace not in (0, 1):
        raise PngError("invalid compression, filter or interlace method")
    return PngInfo(width, height, depth, colour, interlace)


def png_info(data: bytes) -> PngInfo:
    """The IHDR fields of ``data`` (only the signature and the first chunk are read)."""
    if not isinstance(data, (bytes, bytearray)) or not bytes(data[:8]) == PNG_SIGNATURE:
        raise PngError("not a PNG file")
    data = bytes(data[:8 + 12 + 13])
    first = next(_chunks(data), None)
    if first is None or first[0] != b"IHDR":
        raise PngError("PNG must start with IHDR")
    return _ihdr(first[1])


def strip_png(data: bytes, *, max_bytes: int = MAX_PNG_BYTES) -> bytes:
    """``data`` with only IHDR, PLTE, tRNS, IDAT and IEND, copied byte for byte.

    Raises :class:`PngError` for anything that is not a well-formed PNG (see the module text).
    """
    if not isinstance(data, (bytes, bytearray)):
        raise PngError("not a PNG file")
    if len(data) > max_bytes:
        raise PngError("PNG too large")
    data = bytes(data)
    if not data.startswith(PNG_SIGNATURE):
        raise PngError("not a PNG file")
    kept: list[bytes] = []
    info: PngInfo | None = None
    seen_plte = seen_trns = False
    idat_state = "before"  # before → inside → after
    ended = False
    for kind, body, raw in _chunks(data):
        if ended:
            raise PngError("data after IEND")
        if info is None:
            if kind != b"IHDR":
                raise PngError("PNG must start with IHDR")
            info = _ihdr(body)
            kept.append(raw)
            continue
        if kind == b"IHDR":
            raise PngError("more than one IHDR")
        if idat_state == "inside" and kind != b"IDAT":
            idat_state = "after"
        if kind == b"PLTE":
            if seen_plte or idat_state != "before" or seen_trns:
                raise PngError("PLTE out of order")
            if info.color_type in (0, 4) or len(body) == 0 or len(body) % 3 or len(body) > 768:
                raise PngError("invalid PLTE")
            seen_plte = True
        elif kind == b"tRNS":
            if seen_trns or idat_state != "before" or info.color_type in (4, 6):
                raise PngError("tRNS out of order or not allowed")
            if info.color_type == 3 and not seen_plte:
                raise PngError("tRNS before PLTE")
            seen_trns = True
        elif kind == b"IDAT":
            if idat_state == "after":
                raise PngError("IDAT chunks must be consecutive")
            if info.color_type == 3 and not seen_plte:
                raise PngError("palette image without PLTE")
            idat_state = "inside"
        elif kind == b"IEND":
            if body:
                raise PngError("IEND must be empty")
            ended = True
        elif 65 <= kind[0] <= 90:  # an unknown critical chunk: the image cannot be trusted
            raise PngError("unknown critical chunk")
        else:
            continue  # ancillary: dropped
        kept.append(raw)
    if info is None:
        raise PngError("PNG must start with IHDR")
    if idat_state == "before":
        raise PngError("PNG has no IDAT")
    if not ended:
        raise PngError("PNG must end with IEND")
    return PNG_SIGNATURE + b"".join(kept)


__all__ = ["KEEP_CHUNKS", "MAX_PNG_BYTES", "PngError", "PngInfo", "png_info", "strip_png"]
