"""The logo or the text watermark over the caption: ``logo_over_caption`` (CONTRACTS §5.51).

The logo is drawn above the caption and the watermark line beside it, both for the whole clip, so
a box on the caption block hides words for as long as captions show. Each is compared with the
caption block (``face_zone.caption_box``, the box the caption gizmo draws) by the face check's
rule: covered when the overlap is at least ``face_zone.OVERLAP_PM`` of the smaller box.

One issue per part, at the first caption cue's frame:

* the logo (``path`` its transform): ``ref`` is the nearest SnapLogo corner, by box centre,
  where it would not cover the block (ties go to the top, then the left);
* the watermark (``path`` ``/watermark/pos``): ``ref`` is the nearest of the nine places on the
  grid (fewest steps, the same column first, then upward) that clears the block.

``ref`` is absent when nothing clears. A caption that is off or shows no cue gives no warning,
and a document this cannot read gives none either: a warning never stops the plan.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ..captions_ass import WatermarkSpec, watermark_box
from . import UI_ZONE_720, WATERMARK_POSITIONS
from . import face_zone as _face_zone
from . import timemap as tm
from .doc import Issue

CODE = "logo_over_caption"
WATERMARK_PATH = "/watermark/pos"
CORNERS = ("top_left", "top_right", "bottom_left", "bottom_right")
WATERMARK_ROWS = ("top", "middle", "bottom")
WATERMARK_COLUMNS = ("left", "center", "right")

Rect = tuple[float, float, float, float]  # x0, y0, x1, y1 in output pixels


def corner_box(size: tuple[int, int], corner: str,
               output: tuple[int, int]) -> tuple[int, int, int, int]:
    """``(x, y, w, h)`` of a ``size`` logo at a SnapLogo corner (``snapTarget`` in
    ``web/lib/editor/commands.mjs``): 4 % from the left edge, against the TikTok zone's right,
    top and bottom edges, at the frame edge when it does not fit."""
    width, height = output
    w, h = size
    margin = tm.div_round_half_up(4 * width, 100)
    top = tm.div_round_half_up(UI_ZONE_720[0] * height, 1280)
    bottom = tm.div_round_half_up(UI_ZONE_720[1] * height, 1280)
    right = tm.div_round_half_up(UI_ZONE_720[2] * width, 720)
    x = min(max(margin if corner.endswith("left") else width - right - w, 0), max(0, width - w))
    y = min(max(top if corner.startswith("top") else height - bottom - h, 0), max(0, height - h))
    # SnapLogo stores the centre in e5; the box comes back from it (exact for every pixel)
    x_e5 = tm.div_round_half_up((2 * x + w) * 100_000, 2 * width)
    y_e5 = tm.div_round_half_up((2 * y + h) * 100_000, 2 * height)
    return (tm.div_round_half_up(2 * x_e5 * width - w * 100_000, 200_000),
            tm.div_round_half_up(2 * y_e5 * height - h * 100_000, 200_000), w, h)


def _rect(box: Sequence[float]) -> Rect:
    x, y, w, h = box
    return (x, y, x + w, y + h)


def _area(rect: Rect) -> float:
    return (rect[2] - rect[0]) * (rect[3] - rect[1])


def _covers(block: Rect, rect: Rect) -> bool:
    x0, y0 = max(block[0], rect[0]), max(block[1], rect[1])
    x1, y1 = min(block[2], rect[2]), min(block[3], rect[3])
    if x1 <= x0 or y1 <= y0:
        return False
    return (x1 - x0) * (y1 - y0) * 1000 >= _face_zone.OVERLAP_PM * min(_area(block), _area(rect))


def _centre(rect: Rect) -> tuple[float, float]:
    return (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2


def _logo_issue(doc: Mapping[str, Any], assets: Mapping[str, Mapping], block: Rect,
                output: tuple[int, int], frame: int) -> Issue | None:
    found = next(((index, track["items"][0]) for index, track in enumerate(doc["tracks"])
                  if track["kind"] == "visual" and track["items"]), None)
    if found is None:
        return None
    index, item = found
    transform = item["transform"]
    meta = assets[item["payload"]["asset"]]
    box = tm.logo_box(x_e5=transform["x_e5"], y_e5=transform["y_e5"], w_e5=transform["w_e5"],
                      asset_w=meta["w"], asset_h=meta["h"], out_w=output[0], out_h=output[1])
    current = _rect(box)
    if not _covers(block, current):
        return None
    here = _centre(current)

    def distance(corner: str) -> float:
        x, y = _centre(_rect(corner_box(box[2:], corner, output)))
        return (x - here[0]) ** 2 + (y - here[1]) ** 2

    fix = None
    for corner in sorted(CORNERS, key=lambda name: (distance(name), CORNERS.index(name))):
        target = corner_box(box[2:], corner, output)
        if tuple(target) != tuple(box) and not _covers(block, _rect(target)):
            fix = corner
            break
    return Issue(CODE, f"/tracks/{index}/items/0/transform", fix, frame)


def _watermark_issue(doc: Mapping[str, Any], block: Rect, output: tuple[int, int],
                     frame: int) -> Issue | None:
    mark = doc.get("watermark")
    if mark is None:
        return None

    def at(pos: str) -> Rect:
        spec = WatermarkSpec(mark["text"], pos, mark["size_pm"], mark["opacity_pm"])
        return watermark_box(spec, play_res=output)

    if not _covers(block, at(mark["pos"])):
        return None
    row, column = mark["pos"].split("_")
    r, c = WATERMARK_ROWS.index(row), WATERMARK_COLUMNS.index(column)

    def order(pos: str) -> tuple[int, int, int]:
        pr, pc = (names.index(part) for names, part in
                  zip((WATERMARK_ROWS, WATERMARK_COLUMNS), pos.split("_"), strict=True))
        return abs(pr - r) + abs(pc - c), abs(pc - c), pr

    fix = next((pos for pos in sorted(WATERMARK_POSITIONS, key=order)
                if pos != mark["pos"] and not _covers(block, at(pos))), None)
    return Issue(CODE, WATERMARK_PATH, fix, frame)


def logo_over_caption_issues(doc: Mapping[str, Any], assets: Mapping[str, Mapping],
                             cues: Sequence[Any], output: tuple[int, int]) -> tuple[Issue, ...]:
    """The ``logo_over_caption`` warnings of ``doc``: the logo's, then the watermark's. ``cues``
    are the caption cues (``f0``/``f1`` output frames). See the module docstring."""
    try:
        captions = doc["captions"]
        if not captions["enabled"] or not cues:
            return ()
        block = _rect(_face_zone.caption_box(captions, output))
        frame = min(cue.f0 for cue in cues)
        found = (_logo_issue(doc, assets, block, output, frame),
                 _watermark_issue(doc, block, output, frame))
    except (ValueError, TypeError, KeyError, IndexError, OSError):
        return ()
    return tuple(issue for issue in found if issue is not None)


__all__ = ["CODE", "CORNERS", "WATERMARK_PATH", "corner_box", "logo_over_caption_issues"]
