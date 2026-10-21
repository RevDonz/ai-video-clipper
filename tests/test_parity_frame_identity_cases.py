"""The frame-identity gate cases (``scripts/parity/frame_identity.py``) can be read at all.

A split case is read band by band (CONTRACTS §5.45): the index through the top band and each
band's ruler against its crop. A band whose crop leaves out the ruler's source rows can never
decode, so every frame would count as a mismatch whatever the render does.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import frame_identity as fi
from support import edit_v2_media as media

SPLIT_CASES = [case for case in (*fi.P_FRAME_CASES, *fi.P_PLATE_CASES) if case.layout == "split"]


@pytest.mark.parametrize("case", SPLIT_CASES, ids=[case.name for case in SPLIT_CASES])
def test_every_split_band_shows_the_whole_ruler(case):
    pattern = media.Pattern.for_size(*case.source_size)
    ruler = (pattern.ruler_top, pattern.ruler_top + pattern.ruler_bits * pattern.band_h)
    for band in ("top", "bottom"):
        _x, y, _w, h = fi.split_band(case, band)["crop"]
        assert y <= ruler[0] and ruler[1] <= y + h, (case.name, band, (y, y + h), ruler)


@pytest.mark.parametrize("case", SPLIT_CASES, ids=[case.name for case in SPLIT_CASES])
def test_the_top_band_shows_the_index(case):
    pattern = media.Pattern.for_size(*case.source_size)
    _x, y, _w, h = fi.split_band(case, "top")["crop"]
    assert y == 0 and pattern.ruler_top <= h
