"""Non-speech sound events (laughter, applause, ...) aligned to the source timeline."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from numbers import Real
from pathlib import Path

SOUND_EVENTS_VERSION = "sound-events-v1"
MAX_SOUND_EVENTS = 100_000
MAX_SOUND_EVENTS_BYTES = 8 * 1024 * 1024
KINDS = ("laughter", "applause", "cheer", "shout", "gasp", "music", "cough", "other")
_KIND_BY_LABEL = {
    # Indonesian YouTube auto-caption tags.
    "tertawa": "laughter",
    "tawa": "laughter",
    "ketawa": "laughter",
    "tepuk tangan": "applause",
    "bersorak": "cheer",
    "sorakan": "cheer",
    "berteriak": "shout",
    "teriakan": "shout",
    "terkesiap": "gasp",
    "musik": "music",
    "bernyanyi": "music",
    "batuk": "cough",
    "berdehem": "cough",
    # English tags.
    "laughter": "laughter",
    "laughing": "laughter",
    "laughs": "laughter",
    "applause": "applause",
    "cheering": "cheer",
    "cheers": "cheer",
    "shouting": "shout",
    "gasps": "gasp",
    "music": "music",
    "coughing": "cough",
    "coughs": "cough",
}
_LABEL = re.compile(r"[^\W\d_]+(?:[ -][^\W\d_]+)*", re.UNICODE)


def sound_kind(label: str) -> str:
    """Map a free-form caption tag such as 'tertawa' or '[Laughter]' to a stable kind."""
    if not isinstance(label, str):
        raise TypeError("sound label must be a string")
    normalized = " ".join(label.strip().strip("[]()").casefold().split())
    return _KIND_BY_LABEL.get(normalized, "other")


@dataclass(frozen=True, slots=True)
class SoundEvent:
    """One point-in-time non-speech event; `label` keeps the original tag text."""

    time: float
    kind: str
    label: str

    def __post_init__(self) -> None:
        if not isinstance(self.time, Real) or isinstance(self.time, bool):
            raise TypeError("sound event time must be a number")
        if not math.isfinite(self.time) or self.time < 0:
            raise ValueError("sound event time must be finite and non-negative")
        object.__setattr__(self, "time", float(self.time))
        if self.kind not in KINDS:
            raise ValueError(f"unknown sound event kind: {self.kind}")
        if not isinstance(self.label, str) or not _LABEL.fullmatch(self.label.strip()):
            raise ValueError("sound event label must be a short word label")
        if len(self.label) > 40:
            raise ValueError("sound event label must be at most 40 characters")

    @classmethod
    def from_label(cls, time: float, label: str) -> SoundEvent:
        cleaned = " ".join(label.strip().strip("[]()").split())
        return cls(time, sound_kind(cleaned), cleaned.casefold())


def sort_events(events: Iterable[SoundEvent]) -> tuple[SoundEvent, ...]:
    items = tuple(events)
    if any(not isinstance(item, SoundEvent) for item in items):
        raise TypeError("events must be SoundEvent values")
    return tuple(sorted(items, key=lambda item: (item.time, item.kind, item.label)))


def events_between(
    events: Sequence[SoundEvent], start: float, end: float, *, kind: str | None = None
) -> tuple[SoundEvent, ...]:
    """Return events with start <= time <= end from a time-sorted sequence."""
    times = [item.time for item in events]
    selected = events[bisect_left(times, start) : bisect_right(times, end)]
    return tuple(item for item in selected if kind is None or item.kind == kind)


def events_to_dict(events: Sequence[SoundEvent], *, source: str) -> dict[str, object]:
    return {
        "version": SOUND_EVENTS_VERSION,
        "source": source,
        "events": [
            {"time": round(item.time, 3), "kind": item.kind, "label": item.label}
            for item in sort_events(events)
        ],
    }


def events_from_dict(payload: object) -> tuple[tuple[SoundEvent, ...], str]:
    if type(payload) is not dict or set(payload) != {"version", "source", "events"}:
        raise ValueError("sound events payload must contain exactly version, source, events")
    if payload["version"] != SOUND_EVENTS_VERSION:
        raise ValueError("unsupported sound events version")
    source = payload["source"]
    if not isinstance(source, str) or not source.strip() or len(source) > 64:
        raise ValueError("sound events source must be a short string")
    raw = payload["events"]
    if type(raw) is not list or len(raw) > MAX_SOUND_EVENTS:
        raise ValueError("sound events must be a bounded list")
    events = []
    for item in raw:
        if type(item) is not dict or set(item) != {"time", "kind", "label"}:
            raise ValueError("sound event must contain exactly time, kind, label")
        events.append(SoundEvent(item["time"], item["kind"], item["label"]))
    ordered = sort_events(events)
    if [item.time for item in ordered] != [item.time for item in events]:
        raise ValueError("sound events must be chronological")
    return ordered, source


def write_sound_events(path: str | Path, events: Sequence[SoundEvent], *, source: str) -> None:
    """Atomically publish a sound-events artifact (e.g. analysis/sound-events.json)."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(events_to_dict(events, source=source), ensure_ascii=False) + "\n").encode()
    descriptor, pending = tempfile.mkstemp(
        dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, destination)
    except BaseException:
        Path(pending).unlink(missing_ok=True)
        raise


def read_sound_events(path: str | Path) -> tuple[tuple[SoundEvent, ...], str]:
    source = Path(path)
    if source.stat().st_size > MAX_SOUND_EVENTS_BYTES:
        raise ValueError("sound events artifact is too large")
    return events_from_dict(json.loads(source.read_text(encoding="utf-8")))
