"""Stable clip identity (plan §3.5, FINAL §4.9, Appendix A ``clip_id.py``)."""

from __future__ import annotations

import hashlib

import pytest
from ai_clipper.edit_v2.clip_id import CLIP_ID_PATTERN, clip_id, is_clip_id, ms_from_seconds

from ai_clipper.selection_types import SelectedClip

SOURCE = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
OTHER_SOURCE = "a" * 64

# Golden vectors: (source sha, start_ms, end_ms, cold open, expected id). Any change here means
# every saved edit loses its clip; never regenerate these.
GOLDEN = (
    (SOURCE, 1241930, 1309400, (1275200, 1279700), "clip_28553a41af2ba39affd4dba7"),
    (SOURCE, 1241930, 1309400, None, "clip_bb6e236c66331e7557945e3a"),
    (OTHER_SOURCE, 0, 3000, None, "clip_0a76065e233fd0cf837457e4"),
)


def _reference(source: str, start: int, end: int, cold: tuple[int, int] | None) -> str:
    tail = "-" if cold is None else f"{cold[0]}-{cold[1]}"
    payload = b"potongin-clip-v1\0" + "\0".join((source, str(start), str(end), tail)).encode()
    return "clip_" + hashlib.sha256(payload).hexdigest()[:24]


def test_clip_id_follows_the_documented_preimage():
    for source, start, end, cold, _golden in GOLDEN:
        value = clip_id(source, start, end, cold)
        assert value == _reference(source, start, end, cold)
        assert CLIP_ID_PATTERN.fullmatch(value)
        assert is_clip_id(value)


def test_clip_id_golden_vectors_never_change():
    for source, start, end, cold, golden in GOLDEN:
        assert clip_id(source, start, end, cold) == golden


def test_every_input_changes_the_id():
    base = clip_id(SOURCE, 1241930, 1309400, (1275200, 1279700))
    variants = {
        clip_id(OTHER_SOURCE, 1241930, 1309400, (1275200, 1279700)),
        clip_id(SOURCE, 1241931, 1309400, (1275200, 1279700)),
        clip_id(SOURCE, 1241930, 1309401, (1275200, 1279700)),
        clip_id(SOURCE, 1241930, 1309400, (1275201, 1279700)),
        clip_id(SOURCE, 1241930, 1309400, (1275200, 1279701)),
        clip_id(SOURCE, 1241930, 1309400, None),
    }
    assert base not in variants
    assert len(variants) == 6


def test_field_boundaries_cannot_be_shifted_between_fields():
    # "12" + "3" must not collide with "1" + "23": the NUL separators keep fields apart.
    assert clip_id(SOURCE, 12, 300, None) != clip_id(SOURCE, 1, 2300, None)
    assert clip_id(SOURCE, 1, 23, (5, 6)) != clip_id(SOURCE, 1, 2, (35, 6))


def _selected(rank: int, *, start: float, end: float, cold, title: str, score: float) -> SelectedClip:
    return SelectedClip(
        rank=rank,
        start=start,
        end=end,
        cold_open=cold,
        unit_ids=("S0400", "S0431"),
        hook_unit_id="S0412",
        title=title,
        hook_text="Dia ditahan security di film-nya sendiri",
        description="Cerita lucu di balik layar.",
        hashtags=("podcast",),
        archetype="story",
        score=score,
        scores={"hook": score},
        reasons=("hook",),
        source="llm",
        text="kata kata",
    )


def _clip_id_of(clip: SelectedClip, source: str = SOURCE) -> str:
    cold = None
    if clip.cold_open is not None:
        cold = (ms_from_seconds(clip.cold_open[0]), ms_from_seconds(clip.cold_open[1]))
    return clip_id(source, ms_from_seconds(clip.start), ms_from_seconds(clip.end), cold)


def test_selection_rerun_that_finds_the_same_moment_gives_the_same_id():
    first_run = _selected(3, start=1241.93, end=1309.4, cold=(1275.2, 1279.7),
                          title="Ditahan security", score=0.81)
    second_run = _selected(1, start=1241.93, end=1309.4, cold=(1275.2, 1279.7),
                           title="Security salah orang", score=0.64)
    assert _clip_id_of(first_run) == _clip_id_of(second_run) == GOLDEN[0][4]
    moved = _selected(3, start=1241.94, end=1309.4, cold=(1275.2, 1279.7),
                      title="Ditahan security", score=0.81)
    assert _clip_id_of(moved) != _clip_id_of(first_run)


def test_ms_from_seconds_rounds_the_decimal_value_half_up():
    assert ms_from_seconds(1241.93) == 1241930
    assert ms_from_seconds(1309.4) == 1309400
    assert ms_from_seconds(0) == 0
    assert ms_from_seconds(0.0005) == 1
    assert ms_from_seconds(0.0004999) == 0
    assert ms_from_seconds(2.0015) == 2002
    assert ms_from_seconds(12) == 12000
    # The binary product 0.5005 * 1000 is 500.49999999999994; the decimal value is used.
    assert ms_from_seconds(0.5005) == 501
    for bad in (float("nan"), float("inf"), -0.001, True, "1.0", None):
        with pytest.raises((TypeError, ValueError)):
            ms_from_seconds(bad)


@pytest.mark.parametrize(
    ("source", "start", "end", "cold"),
    [
        (SOURCE.upper(), 0, 10, None),
        (SOURCE[:-1], 0, 10, None),
        ("g" * 64, 0, 10, None),
        (SOURCE, -1, 10, None),
        (SOURCE, 10, 10, None),
        (SOURCE, 10, 5, None),
        (SOURCE, 0.0, 10, None),
        (SOURCE, True, 10, None),
        (SOURCE, 0, 10, (5, 5)),
        (SOURCE, 0, 10, (-1, 5)),
        (SOURCE, 0, 10, (1, 2, 3)),
        (SOURCE, 0, 10, [1, 2]),
        (SOURCE, 0, 10, (1.0, 2)),
    ],
)
def test_clip_id_rejects_malformed_inputs(source, start, end, cold):
    with pytest.raises((TypeError, ValueError)):
        clip_id(source, start, end, cold)


def test_is_clip_id():
    assert not is_clip_id("clip_" + "0" * 23)
    assert not is_clip_id("clip_" + "A" * 24)
    assert not is_clip_id("cand_" + "0" * 24)
    assert not is_clip_id(None)
    assert is_clip_id("clip_" + "0" * 24)
