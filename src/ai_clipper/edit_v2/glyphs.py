"""Font coverage and advances from the pack fonts' ``cmap``/``hmtx`` tables (plan §5.4).

Owner: T1.2a. Stdlib only (``struct``). The pinned font files live in ``resources/fonts`` and
are listed, with their sha256 and licence, in ``resources/fonts/fonts.json``; FFmpeg's libass
(through ``resources/fontconfig/fonts.conf`` and ``fontsdir``) and JASSUB load the same bytes.

Used for ``glyph_unsupported:U+XXXX`` warnings and the ``box`` line splits. Widths follow
libass: a font of size ``S`` maps ``usWinAscent + usWinDescent`` (OS/2) to ``S`` pixels
(FreeType's REAL_DIM request after libass swaps in the Windows metrics), so a glyph advancing
``a`` font units is ``a · S / (winAscent + winDescent)`` pixels wide. Kerning is ignored.
"""

from __future__ import annotations

import functools
import json
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# src/ai_clipper/edit_v2/glyphs.py -> the repository (or /app in the image) -> resources/
RESOURCES_DIR = Path(__file__).resolve().parents[3] / "resources"
FONTS_DIR = RESOURCES_DIR / "fonts"
FONTS_MANIFEST = FONTS_DIR / "fonts.json"
FALLBACK_FONT = FONTS_DIR / "DejaVuSans.ttf"  # fontconfig's and JASSUB's only fallback (R6)

_SFNT_VERSIONS = (b"\x00\x01\x00\x00", b"true", b"OTTO")


@dataclass(frozen=True)
class _Font:
    cmap: Mapping[int, int]  # code point -> glyph id (non-zero)
    advances: tuple[int, ...]  # advance width per glyph id, in font units
    height_units: int  # the font units libass maps to the font size


def _tables(data: bytes) -> dict[str, tuple[int, int]]:
    if len(data) < 12 or data[:4] not in _SFNT_VERSIONS:
        raise ValueError("not a TrueType/OpenType font")
    count = struct.unpack_from(">H", data, 4)[0]
    tables = {}
    for index in range(count):
        tag, _checksum, offset, length = struct.unpack_from(">4sIII", data, 12 + 16 * index)
        if offset + length > len(data):
            raise ValueError("font table outside the file")
        tables[tag.decode("latin-1")] = (offset, length)
    return tables


def _cmap_format4(data: bytes, offset: int) -> dict[int, int]:
    segments = struct.unpack_from(">H", data, offset + 6)[0] // 2
    ends = struct.unpack_from(f">{segments}H", data, offset + 14)
    starts = struct.unpack_from(f">{segments}H", data, offset + 16 + 2 * segments)
    deltas = struct.unpack_from(f">{segments}h", data, offset + 16 + 4 * segments)
    range_base = offset + 16 + 6 * segments
    range_offsets = struct.unpack_from(f">{segments}H", data, range_base)
    mapping = {}
    for index in range(segments):
        for code in range(starts[index], ends[index] + 1):
            if code == 0xFFFF:
                continue
            if range_offsets[index] == 0:
                glyph = (code + deltas[index]) & 0xFFFF
            else:
                address = (range_base + 2 * index + range_offsets[index]
                           + 2 * (code - starts[index]))
                glyph = struct.unpack_from(">H", data, address)[0]
                if glyph:
                    glyph = (glyph + deltas[index]) & 0xFFFF
            if glyph:
                mapping[code] = glyph
    return mapping


def _cmap_format12(data: bytes, offset: int) -> dict[int, int]:
    groups = struct.unpack_from(">I", data, offset + 12)[0]
    mapping = {}
    for index in range(groups):
        first, last, glyph = struct.unpack_from(">III", data, offset + 16 + 12 * index)
        for code in range(first, min(last, 0x10FFFF) + 1):
            if glyph + code - first:
                mapping[code] = glyph + code - first
    return mapping


def _cmap(data: bytes, table: tuple[int, int]) -> dict[int, int]:
    base = table[0]
    count = struct.unpack_from(">H", data, base + 2)[0]
    by_format: dict[int, int] = {}
    for index in range(count):
        platform, encoding, offset = struct.unpack_from(">HHI", data, base + 4 + 8 * index)
        unicode_table = platform == 0 or (platform == 3 and encoding in (1, 10))
        if not unicode_table:
            continue
        form = struct.unpack_from(">H", data, base + offset)[0]
        by_format.setdefault(form, base + offset)
    if 12 in by_format:  # the full-repertoire table is a superset of the BMP one
        return _cmap_format12(data, by_format[12])
    if 4 in by_format:
        return _cmap_format4(data, by_format[4])
    raise ValueError("font has no Unicode cmap (format 4 or 12)")


def _parse(data: bytes) -> _Font:
    try:
        tables = _tables(data)
        for tag in ("cmap", "hhea", "hmtx", "maxp"):
            if tag not in tables:
                raise ValueError(f"font lacks the {tag} table")
        cmap = _cmap(data, tables["cmap"])
        hhea = tables["hhea"][0]
        ascender, descender = struct.unpack_from(">hh", data, hhea + 4)
        metrics = struct.unpack_from(">H", data, hhea + 34)[0]
        glyphs = struct.unpack_from(">H", data, tables["maxp"][0] + 4)[0]
        if metrics == 0:
            raise ValueError("font has no horizontal metrics")
        hmtx = tables["hmtx"][0]
        advances = [struct.unpack_from(">H", data, hmtx + 4 * index)[0]
                    for index in range(metrics)]
        advances += [advances[-1]] * max(0, glyphs - metrics)
        height = ascender - descender
        if "OS/2" in tables and tables["OS/2"][1] >= 78:
            win_ascent, win_descent = struct.unpack_from(">hh", data, tables["OS/2"][0] + 74)
            if win_ascent + win_descent != 0:
                height = win_ascent + win_descent  # libass' set_font_metrics
    except (struct.error, IndexError) as error:
        raise ValueError("malformed TrueType/OpenType font") from error
    if height <= 0:
        raise ValueError("font has no usable line height")
    return _Font(cmap, tuple(advances), height)


@functools.lru_cache(maxsize=16)
def _load(path: str, size: int, mtime_ns: int) -> _Font:
    data = Path(path).read_bytes()
    if len(data) != size:
        raise ValueError("font file changed while reading")
    return _parse(data)


def _font(font_file: Path) -> _Font:
    path = Path(font_file).resolve()
    stat = path.stat()  # OSError for a missing file
    return _load(str(path), stat.st_size, stat.st_mtime_ns)


def missing_glyphs(text: str, font_file: Path) -> tuple[str, ...]:
    """Characters of ``text`` the font lacks, in first-seen order, without duplicates."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    cmap = _font(font_file).cmap
    missing: dict[str, None] = {}
    for character in text:
        if ord(character) not in cmap:
            missing.setdefault(character)
    return tuple(missing)


def advance_units(text: str, font_file: Path) -> tuple[int, int]:
    """``(sum of the advances of text, font units per font size)``, both in font units.

    A character the font lacks advances like ``.notdef`` (glyph 0). ``text`` is ``width /
    font_size = units / height`` exactly, which the ``box`` line fitting uses in integers.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    font = _font(font_file)
    notdef = font.advances[0]
    units = 0
    for character in text:
        glyph = font.cmap.get(ord(character), 0)
        units += font.advances[glyph] if glyph < len(font.advances) else notdef
    return units, font.height_units


def advance_px(text: str, font_file: Path, font_size: float) -> float:
    """Advance width of ``text`` in pixels at ``font_size`` from ``hmtx`` (box/bold splits)."""
    if isinstance(font_size, bool) or not isinstance(font_size, (int, float)) or font_size < 0:
        raise ValueError("font_size must be a non-negative number")
    units, height = advance_units(text, font_file)
    return units * font_size / height


def fonts_manifest() -> dict[str, Any]:
    """The parsed ``resources/fonts/fonts.json`` (files, sha256, licences, sources)."""
    return json.loads(FONTS_MANIFEST.read_text(encoding="utf-8"))


def font_path(file_name: str) -> Path:
    """Path of a pinned font file listed in ``fonts.json`` (anything else is rejected)."""
    listed = {entry["file"] for entry in fonts_manifest()["fonts"]}
    if file_name not in listed:
        raise ValueError(f"font {file_name!r} is not a pinned font")
    return FONTS_DIR / file_name


__all__ = [
    "FALLBACK_FONT",
    "FONTS_DIR",
    "FONTS_MANIFEST",
    "RESOURCES_DIR",
    "advance_px",
    "advance_units",
    "font_path",
    "fonts_manifest",
    "missing_glyphs",
]
