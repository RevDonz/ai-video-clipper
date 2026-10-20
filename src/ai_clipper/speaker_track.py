"""Which face a portrait crop follows: the one who is speaking.

``face_window`` scans a clip window and reports, for every 0.75 s sample, the faces it found and
how much each face's mouth moved until the next sample (``activity``). This module links the
faces of consecutive samples into tracks (never across a scene cut), scores every track by its
mean activity around the sample, and frames the track that moves its mouth the most:

* faces lower than half the sample's tallest face are background people and never framed;
* a single face is framed whatever its activity (there is nobody else to show);
* the framed track is kept until another one leads it by ``Rules.margin``, so the crop does not
  hunt between two people who both move a little;
* without any activity (no face measured, or a source whose frame rate is unknown) the largest
  face is framed, equal areas by position (leftmost, then topmost);
* a move to another track that crosses at least ``Rules.jump`` of the frame width is flagged as
  a switch, which the crop shows as a cut instead of a pan across the frame.

The parameters were measured on the speaker-framing evaluation set
(``docs/evaluation/SPEAKER_FRAMING.md``). Stdlib only; OpenCV stays in ``face_window`` and
``face_model``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Face:
    """A detected face in source pixels; ``activity`` is its mean mouth motion over the sample's
    interval, or ``None`` when nothing was measured."""

    x: float
    y: float
    w: float
    h: float
    activity: float | None = None

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def centre(self) -> float:
        return self.x + self.w / 2


@dataclass(frozen=True, slots=True)
class Sample:
    """One sample of the window: its time (seconds from the window start), whether a scene cut
    precedes it, and its faces."""

    time: float
    cut: bool
    faces: tuple[Face, ...]


@dataclass(frozen=True, slots=True)
class Rules:
    """The choice's parameters."""

    window: int = 3  # samples on either side of the current one in a track's score
    margin: float = 0.03  # the lead another track needs before the crop leaves the framed one
    jump: float = 0.22  # a switch moving the centre this far (share of the width) is a cut
    link_iou: float = 0.3  # the overlap that makes two faces of consecutive samples one track
    min_relative: float = 0.5  # faces lower than this share of the sample's tallest are ignored


RULES = Rules()


def _overlap(a: Face, b: Face) -> float:
    width = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
    height = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
    if width <= 0 or height <= 0:
        return 0.0
    inter = width * height
    return inter / (a.area + b.area - inter)


def link_tracks(samples: Sequence[Sample], *, link_iou: float = RULES.link_iou) -> list[list[int]]:
    """A track id for every face of every sample: a face continues the track of the face of the
    previous sample it overlaps most (at least ``link_iou``), pairs taken by decreasing overlap;
    a scene cut starts every track anew."""
    ids: list[list[int]] = []
    next_id = 0
    previous: Sequence[Face] = ()
    previous_ids: list[int] = []
    for sample in samples:
        if sample.cut:
            previous, previous_ids = (), []
        pairs = sorted(((_overlap(face, before), i, j)
                        for i, face in enumerate(sample.faces)
                        for j, before in enumerate(previous)), key=lambda p: (-p[0], p[1], p[2]))
        current: list[int | None] = [None] * len(sample.faces)
        taken: set[int] = set()
        for overlap, i, j in pairs:
            if overlap < link_iou:
                break
            if current[i] is None and j not in taken:
                current[i] = previous_ids[j]
                taken.add(j)
        resolved: list[int] = []
        for value in current:
            if value is None:
                value = next_id
                next_id += 1
            resolved.append(value)
        ids.append(resolved)
        previous, previous_ids = sample.faces, resolved
    return ids


def _largest(faces: Sequence[tuple[int, Face]]) -> int:
    """The largest face; equal areas by position (leftmost, then topmost)."""
    return min(faces, key=lambda item: (-item[1].area, item[1].x, item[1].y))[0]


def _shots(samples: Sequence[Sample]) -> list[int]:
    """A shot number per sample: a new shot starts at every cut."""
    numbers: list[int] = []
    shot = 0
    for index, sample in enumerate(samples):
        if index > 0 and sample.cut:
            shot += 1
        numbers.append(shot)
    return numbers


def choose(
    samples: Sequence[Sample],
    *,
    width: int,
    rules: Rules = RULES,
) -> tuple[list[float | None], list[bool]]:
    """The framed face's normalised x centre per sample (``None`` without a face) and the
    samples where the crop switches to another speaker far enough to cut (see the module
    docstring). ``width`` is the source width in pixels."""
    if width <= 0:
        raise ValueError("the frame width must be positive")
    tracks = link_tracks(samples, link_iou=rules.link_iou)
    shots = _shots(samples)

    def score(position: int, track: int) -> float | None:
        lo = max(0, position - rules.window)
        hi = min(len(samples) - 1, position + rules.window)
        values = [face.activity
                  for other in range(lo, hi + 1) if shots[other] == shots[position]
                  for face, owner in zip(samples[other].faces, tracks[other], strict=True)
                  if owner == track and face.activity is not None]
        return sum(values) / len(values) if values else None

    centres: list[float | None] = []
    switches: list[bool] = []
    framed: int | None = None  # the track framed at the previous sample
    for position, sample in enumerate(samples):
        if sample.cut:
            framed = None
        tallest = max((face.h for face in sample.faces), default=0.0)
        faces = [(index, face) for index, face in enumerate(sample.faces)
                 if face.h >= rules.min_relative * tallest]
        if not faces:
            centres.append(None)
            switches.append(False)
            framed = None
            continue
        owners = {index: tracks[position][index] for index, _face in faces}
        chosen = faces[0][0]
        if len(faces) > 1:
            scores = {index: score(position, owners[index]) for index, _face in faces}
            measured = [(index, face) for index, face in faces if scores[index] is not None]
            if not measured:
                chosen = _largest(faces)
            else:
                chosen = min(measured, key=lambda item: (-scores[item[0]], -item[1].area,
                                                         item[1].x, item[1].y))[0]
                kept = next((index for index, _face in faces if owners[index] == framed), None)
                kept_score = None if kept is None else scores[kept]
                if kept_score is not None and scores[chosen] - kept_score < rules.margin:
                    chosen = kept
        face = sample.faces[chosen]
        centre = min(max(face.centre / width, 0.0), 1.0)
        previous = centres[-1] if centres else None
        switched = bool(framed is not None and owners[chosen] != framed and previous is not None
                        and abs(centre - previous) >= rules.jump)
        centres.append(centre)
        switches.append(switched)
        framed = owners[chosen]
    return centres, switches


__all__ = ["RULES", "Face", "Rules", "Sample", "choose", "link_tracks"]
