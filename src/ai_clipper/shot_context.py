"""The evidence of each shot for the automatic layout (rombak 04 §A4).

The window is scanned once by ``face_window.scan_window`` with ``frame_diff=True``: every 0.75 s
sample has all of its YuNet faces with their mouth motion (``activity``) and the thumbnail
difference from the previous sample. The camera plan can be built from the same scan
(``camera.build_camera_plan(scan=)``), so a clip is decoded once for both.

Per sample (:class:`Context`):

* ``motion_pm`` is the thumbnail difference in per mille (also where no face was found);
* faces lower than ``speaker_track.Rules.min_relative`` of the sample's tallest are background
  and left out of everything below, like the camera's choice of face;
* tracks are ``speaker_track.link_tracks`` (never across a scan cut);
* the speaking track is the one with the highest ``activity`` among the measured faces; a
  sample with a single face counts that face as speaking, and a sample with several unmeasured
  faces has no speaker. Only the ranking of ``activity`` is used, never its scale.

:meth:`Context.summarize` reduces the samples of one shot ``[in_sf, out_sf)`` (a sample belongs
to the shot holding its source-grid frame) to ``edit_v2.shots.ShotEvidence``. Medians are the
lower median and the 90th percentile is nearest-rank, so every value is an integer of the
samples. ``talk_share_pm`` divides by the shot's samples that have a speaker.

OpenCV is reached only through ``face_window`` (the ``vision`` extra); this module is plain
Python.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from .edit_v2 import timemap as tm
from .edit_v2.clip_id import ms_from_seconds
from .edit_v2.shots import Rules, ShotEvidence, SplitHint
from .edit_v2.timemap import Fps
from .face_window import Scan, scan_window
from .speaker_track import RULES as TRACK_RULES
from .speaker_track import Face, link_tracks

SAMPLE_MS = 750  # edit_v2.camera.SAMPLE_MS: the evidence and the camera plan share samples


def scan_evidence(source: Path, window_ms: tuple[int, int], *,
                  progress: Callable[[int, int], None] | None = None) -> Scan:
    """One scan of the window at the camera plan's samples, with the frame differences."""
    a, b = window_ms
    return scan_window(Path(source), start=a / 1000, end=b / 1000,
                       sample_interval=SAMPLE_MS / 1000, progress=progress, frame_diff=True)


def _lower_median(values: Sequence[int]) -> int:
    ordered = sorted(values)
    return ordered[(len(ordered) - 1) // 2] if ordered else 0


def _p90(values: Sequence[int]) -> int:
    """Nearest-rank 90th percentile: the value at rank ``ceil(0.9·n)``."""
    ordered = sorted(values)
    if not ordered:
        return 0
    return ordered[-(-9 * len(ordered) // 10) - 1]


def _pm(numerator: float, denominator: float) -> int:
    """``numerator / denominator`` in per mille, rounded half up and clamped to 0–1000."""
    if denominator <= 0:
        return 0
    value = int(numerator * 1000 / denominator + 0.5)
    return min(max(value, 0), 1000)


@dataclass(frozen=True, slots=True)
class _Point:
    sf: int
    faces: tuple[Face, ...]  # the framed-sized faces (background left out)
    tracks: tuple[int, ...]  # one track id per face of ``faces``
    speaker: int | None  # index into ``faces`` of the speaking face
    motion_pm: int


@dataclass(frozen=True)
class Context:
    """The per-sample evidence of one scanned window (module notes)."""

    points: tuple[_Point, ...]
    width: int
    height: int

    @classmethod
    def of(cls, scan: Scan, *, window_ms: tuple[int, int], fps: Fps,
           min_relative: float = TRACK_RULES.min_relative) -> Context:
        if scan.frame_diff is None:
            raise ValueError("the evidence needs a scan with frame differences")
        fps = Fps.from_json(fps)
        tracks = link_tracks(scan.samples, link_iou=TRACK_RULES.link_iou)
        points = []
        for sample, ids, diff in zip(scan.samples, tracks, scan.frame_diff, strict=True):
            tallest = max((face.h for face in sample.faces), default=0.0)
            kept = [(face, track) for face, track in zip(sample.faces, ids, strict=True)
                    if face.h >= min_relative * tallest]
            faces = tuple(face for face, _track in kept)
            measured = [index for index, face in enumerate(faces) if face.activity is not None]
            speaker = None
            if measured:
                speaker = min(measured, key=lambda i: (-faces[i].activity, -faces[i].area,
                                                       faces[i].x, faces[i].y))
            elif len(faces) == 1:
                speaker = 0
            ms = window_ms[0] + ms_from_seconds(float(sample.time))
            points.append(_Point(sf=tm.sf_floor(ms, fps), faces=faces,
                                 tracks=tuple(track for _face, track in kept), speaker=speaker,
                                 motion_pm=_pm(diff, 1)))
        return cls(tuple(points), scan.width, scan.height)

    def _inside(self, shot: tuple[int, int]) -> list[_Point]:
        return [point for point in self.points if shot[0] <= point.sf < shot[1]]

    def summarize(self, shot: tuple[int, int], *, rules: Rules) -> ShotEvidence:
        """The evidence of the samples inside ``shot`` (``[in_sf, out_sf)``)."""
        points = self._inside(shot)
        with_face = [point for point in points if point.faces]
        talking: dict[int, int] = {}
        spoken = 0
        for point in points:
            if point.speaker is not None:
                spoken += 1
                track = point.tracks[point.speaker]
                talking[track] = talking.get(track, 0) + 1
        shares = sorted((_pm(count, spoken) for count in talking.values()), reverse=True)
        active = [share for share in shares if share >= rules.speakers_active_pm]
        width = self.width
        spread = [_pm(max(f.x + f.w for f in p.faces) - min(f.x for f in p.faces), width)
                  for p in with_face]
        largest = [_pm(max(f.w for f in p.faces), width) for p in with_face]
        centres = []
        for point in with_face:
            face = (point.faces[point.speaker] if point.speaker is not None
                    else min(point.faces, key=lambda f: (-f.area, f.x, f.y)))
            centres.append(abs(_pm(face.centre, width) - 500))
        return ShotEvidence(
            samples=len(points),
            face_share_pm=_pm(len(with_face), len(points)),
            faces_p90=_p90([len(point.faces) for point in points]),
            face_w_med_pm=_lower_median(largest),
            speakers=len(active),
            talk_share_pm=tuple(active),
            spread_pm=_lower_median(spread),
            centre_dev_pm=_lower_median(centres),
            motion_med_pm=_lower_median([point.motion_pm for point in points]),
        )

    def split_hint(self, shot: tuple[int, int]) -> SplitHint | None:
        """The two most speaking tracks of the shot, the first to speak on top: each one's
        median face centre (per mille of the source). ``None`` without two speakers."""
        points = self._inside(shot)
        counts: dict[int, int] = {}
        first: dict[int, int] = {}
        centres: dict[int, list[tuple[int, int]]] = {}
        for order, point in enumerate(points):
            for face, track in zip(point.faces, point.tracks, strict=True):
                centres.setdefault(track, []).append(
                    (_pm(face.centre, self.width), _pm(face.y + face.h / 2, self.height)))
            if point.speaker is not None:
                track = point.tracks[point.speaker]
                counts[track] = counts.get(track, 0) + 1
                first.setdefault(track, order)
        top_two = sorted(counts, key=lambda t: (-counts[t], first[t]))[:2]
        if len(top_two) < 2:
            return None
        top, bottom = sorted(top_two, key=lambda t: first[t])

        def middle(track: int) -> tuple[int, int]:
            xs = [x for x, _y in centres[track]]
            ys = [y for _x, y in centres[track]]
            return _lower_median(xs), _lower_median(ys)

        return SplitHint(top=middle(top), bottom=middle(bottom))


__all__ = ["SAMPLE_MS", "Context", "scan_evidence"]
