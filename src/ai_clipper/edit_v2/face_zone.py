"""The caption over the speaker's face: the ``caption_over_face`` warning (CONTRACTS §5.50).

The camera plan's ``faces`` holds the framed face per sample (``[x_pm, y_pm, w_pm, h_pm]`` of
the source frame, or ``None``). Each sample whose source frame is kept and shows a caption is
mapped through the clip's layout into the output (:func:`face_rects`) and compared with the
caption block (:func:`caption_box`, the box the editor's caption gizmo draws):

* a sample is over the face when their overlap is at least ``OVERLAP_PM`` of the smaller of the
  two areas: of the face, or of the block when a close-up face is larger than it (a block that
  only grazes the chin does not count);
* the clip gets the warning when at least ``SHARE_PM`` of its captioned samples, and at least
  ``MIN_SAMPLES`` of them, are over the face. Its frame is the earliest output frame of
  those samples;
* its ``ref`` is the fix: the nearest of Atas, Tengah and Bawah (``CAPTION_PRESETS``) other than
  the caption's own spot where the clip would not get the warning, or ``None`` when none clears.

Without ``faces`` (an older plan, a detector without boxes, no camera plan at all) nothing is
reported. Geometry in floats: this is a warning, not a pixel rule.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..captions_ass import load_pack
from . import CAPTION_PRESETS, PACK_IDS
from . import layouts as _layouts
from . import shots as _shots
from . import timemap as tm
from .doc import Issue

CODE = "caption_over_face"
PATH = "/captions/overrides/y_e5"
OVERLAP_PM = 150  # ≥ 15 % of the face's area (or the block's, when smaller)
SHARE_PM = 250  # ≥ 25 % of the captioned samples
MIN_SAMPLES = 2  # and at least 1.5 s of them
_E5 = 100_000
# A font's line height per em (the caption gizmo's table, CONTRACTS §5.47).
_LINE_EM_PM = (("DejaVuSans", 1164), ("Montserrat", 1219))

Rect = tuple[float, float, float, float]  # x0, y0, x1, y1 in output pixels


@dataclass(frozen=True)
class PackMetrics:
    size_ratio: tuple[int, int]
    scale_pm: int
    outline_ratio: tuple[int, int]
    line_em_pm: int
    lines: int  # one for packs that split wide cues (max_width_pm), else two
    margin_side_pm: int


def pack_metrics(pack_id: str, version: int) -> PackMetrics:
    """What the caption block's size comes from, read from the pack file."""
    pack = load_pack(pack_id, version)
    line_em = next(value for prefix, value in _LINE_EM_PM if pack.font_file.startswith(prefix))
    return PackMetrics(pack.size_ratio, pack.size_scale_pm, pack.outline_ratio, line_em,
                       1 if pack.max_width_pm is not None else 2, pack.margin_side_pm)


def caption_box(captions: Mapping[str, Any], output: tuple[int, int],
                y_e5: int | None = None) -> tuple[int, int, int, int]:
    """``(x, y, w, h)`` of the caption block in output pixels (``captions`` is ``doc.captions``;
    ``y_e5`` puts its bottom elsewhere): the bottom is the ASS one, the box above it the pack's
    font size times the line height and the lines of a cue, plus the outline. The same integers
    as ``captionBox`` in ``web/components/editor/gizmos/caption-geometry.mjs``."""
    width, height = output
    pack = captions["pack"]
    metrics = pack_metrics(pack["id"], pack["v"]) if pack["id"] in PACK_IDS else \
        pack_metrics("classic", 1)
    overrides = captions["overrides"]
    bottom_e5 = overrides["y_e5"] if y_e5 is None else y_e5
    num, den = metrics.size_ratio
    font = max(1, tm.div_round_half_up(height * num * metrics.scale_pm * overrides["size_pm"],
                                       den * 1_000_000))
    pitch = tm.div_round_half_up(font * metrics.line_em_pm, 1000)
    outline = tm.div_round_half_up(height * metrics.outline_ratio[0], metrics.outline_ratio[1])
    side = tm.div_round_half_up(width * metrics.margin_side_pm, 1000)
    bottom = height - tm.div_round_half_up((_E5 - bottom_e5) * height, _E5)
    top = max(0, bottom - metrics.lines * pitch - outline)
    return side, top, width - 2 * side, bottom - top


def _valid_faces(plan: Mapping[str, Any]) -> list | None:
    faces, samples = plan.get("faces"), plan.get("samples")
    if not isinstance(faces, list) or not isinstance(samples, list) or len(faces) != len(samples):
        return None
    for face in faces:
        if face is None:
            continue
        if not (isinstance(face, list) and len(face) == 4
                and all(type(value) is int and 0 <= value <= 1000 for value in face)):
            return None
    return faces


def _source(plan: Mapping[str, Any]) -> tuple[int, int] | None:
    source = plan.get("source")
    if not isinstance(source, Mapping):
        return None
    width, height = source.get("w"), source.get("h")
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        return None
    return width, height


def _clip(rect: Rect, box: Rect) -> Rect | None:
    x0, y0 = max(rect[0], box[0]), max(rect[1], box[1])
    x1, y1 = min(rect[2], box[2]), min(rect[3], box[3])
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def _crop_x(doc: Mapping[str, Any], plan: Mapping[str, Any], source: tuple[int, int],
            output: tuple[int, int], sf: int) -> int | None:
    """The crop x of source frame ``sf`` in the scaled source, or ``None`` where face-track
    shows the frame with latar blur."""
    layout = doc["layout"]
    mode = _shots.mode_of(doc, sf)  # a range's mode under the automatic layout (§5.63)
    if layout.get("keyframes"):
        return _layouts.keyframe_positions(layout["keyframes"], source=source, output=output,
                                           first_sf=sf, count=1)[0]
    if mode == "fill_center":
        return _layouts.centre_x(source, output)
    fps = tm.Fps.from_json(doc["output"]["fps"])
    if layout["default"]["no_face"] == "fit_blur" and _layouts.no_face_frames(
            plan, fps, first_sf=sf, count=1)[0]:
        return None
    return _layouts.crop_positions(plan, fps, source=source, output=output, first_sf=sf,
                                   count=1)[0]


def face_rects(face: Sequence[int], doc: Mapping[str, Any], plan: Mapping[str, Any], *, sf: int,
               output: tuple[int, int]) -> list[Rect]:
    """Where the face ``[x_pm, y_pm, w_pm, h_pm]`` of source frame ``sf`` is in the output: one
    rectangle (clipped to the picture), two for layar terbagi when both bands show it, none
    when the crop leaves it out."""
    source = _source(plan)
    if source is None:
        return []
    src_w, src_h = source
    out_w, out_h = output
    fx0, fy0 = face[0] * src_w / 1000, face[1] * src_h / 1000
    fx1, fy1 = fx0 + face[2] * src_w / 1000, fy0 + face[3] * src_h / 1000
    mode = doc["layout"]["default"]["mode"]
    if mode == "split":
        geometry = _layouts.split_geometry(doc["layout"]["split"], source=source, output=output)
        rects = []
        for band in ("top", "bottom"):
            x, y, w, h = geometry[band]["crop"]
            (band_w, band_h), band_y = geometry[band]["size"], geometry[band]["y"]
            sx, sy = band_w / w, band_h / h
            rect = _clip(((fx0 - x) * sx, band_y + (fy0 - y) * sy,
                          (fx1 - x) * sx, band_y + (fy1 - y) * sy),
                         (0, band_y, band_w, band_y + band_h))
            if rect is not None:
                rects.append(rect)
        return rects
    mode = _shots.mode_of(doc, sf)  # a range's mode under the automatic layout (§5.63)
    crop_x = None if mode == "fit_blur" else _crop_x(doc, plan, source, output, sf)
    if crop_x is None:  # fit-blur, or face-track's latar blur fallback: the whole picture
        fit = min(out_w / src_w, out_h / src_h)
        left, top = (out_w - src_w * fit) / 2, (out_h - src_h * fit) / 2
        rect = (left + fx0 * fit, top + fy0 * fit, left + fx1 * fit, top + fy1 * fit)
    else:
        scaled_w, scaled_h = _layouts.scaled_size(source, output)
        sx, sy = scaled_w / src_w, scaled_h / src_h
        crop_y = (scaled_h - out_h) // 2
        rect = (fx0 * sx - crop_x, fy0 * sy - crop_y, fx1 * sx - crop_x, fy1 * sy - crop_y)
    clipped = _clip(rect, (0, 0, out_w, out_h))
    return [] if clipped is None else [clipped]


def _area(rect: Rect) -> float:
    return (rect[2] - rect[0]) * (rect[3] - rect[1])


def _covers(block: Rect, rects: Sequence[Rect]) -> bool:
    for rect in rects:
        inside = _clip(rect, block)
        if inside is not None and _area(inside) * 1000 >= OVERLAP_PM * min(_area(rect),
                                                                             _area(block)):
            return True
    return False


def _flagged(over: int, counted: int) -> bool:
    return over >= MIN_SAMPLES and over * 1000 >= SHARE_PM * counted


def caption_over_face_issues(doc: Mapping[str, Any], plan: Mapping[str, Any] | None,
                             pieces: Sequence[tm.Piece], cues: Sequence[Any],
                             output: tuple[int, int]) -> tuple[Issue, ...]:
    """The ``caption_over_face`` warning of ``doc`` (at most one), from the camera plan's
    ``faces``; ``cues`` are the caption cues (``f0``/``f1`` output frames). See the module
    docstring. A camera plan this cannot read (a face-only plan whose samples the crop
    rejects) gives no warning: a warning never stops the plan."""
    try:
        return _issues(doc, plan, pieces, cues, output)
    except (ValueError, TypeError, KeyError, IndexError):
        return ()


def _issues(doc: Mapping[str, Any], plan: Mapping[str, Any] | None, pieces: Sequence[tm.Piece],
            cues: Sequence[Any], output: tuple[int, int]) -> tuple[Issue, ...]:
    captions = doc["captions"]
    if plan is None or not captions["enabled"] or not cues:
        return ()
    faces = _valid_faces(plan)
    samples = plan["samples"]
    if faces is None or _source(plan) is None:
        return ()
    fps = tm.Fps.from_json(doc["output"]["fps"])
    shown = sorted((cue.f0, cue.f1) for cue in cues)
    # the samples the clip shows with a caption: (output frame, the face where it is)
    counted: list[tuple[int, list[Rect]]] = []
    for sample, face in zip(samples, faces, strict=True):
        if not isinstance(sample, list) or not sample or type(sample[0]) is not int:
            return ()
        sf = tm.sf_floor(sample[0], fps)
        piece = next((p for p in pieces if p.in_sf <= sf < p.out_sf), None)
        if piece is None:
            continue
        frame = piece.out_f0 + sf - piece.in_sf
        if not any(f0 <= frame < f1 for f0, f1 in shown):
            continue
        counted.append((frame, [] if face is None else
                        face_rects(face, doc, plan, sf=sf, output=output)))
    if not counted:
        return ()

    def over_at(y_e5: int) -> list[int]:
        x, y, w, h = caption_box(captions, output, y_e5)
        block = (x, y, x + w, y + h)
        return [frame for frame, rects in counted if _covers(block, rects)]

    current = captions["overrides"]["y_e5"]
    over = over_at(current)
    if not _flagged(len(over), len(counted)):
        return ()
    fix = None
    for name, value in sorted(CAPTION_PRESETS, key=lambda preset: abs(preset[1] - current)):
        if value != current and not _flagged(len(over_at(value)), len(counted)):
            fix = name
            break
    return (Issue(CODE, PATH, fix, min(over)),)


__all__ = ["CODE", "MIN_SAMPLES", "OVERLAP_PM", "SHARE_PM", "PackMetrics", "caption_box",
           "caption_over_face_issues", "face_rects", "pack_metrics"]
