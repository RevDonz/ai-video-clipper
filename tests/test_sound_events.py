import json

import pytest

from ai_clipper.sound_events import (
    SoundEvent,
    events_between,
    events_from_dict,
    events_to_dict,
    read_sound_events,
    sort_events,
    sound_kind,
    write_sound_events,
)


@pytest.mark.parametrize(
    ("label", "kind"),
    [
        ("tertawa", "laughter"),
        ("[Tertawa]", "laughter"),
        ("tepuk  tangan", "applause"),
        ("bersorak", "cheer"),
        ("berteriak", "shout"),
        ("terkesiap", "gasp"),
        ("musik", "music"),
        ("berdehem", "cough"),
        ("Laughter", "laughter"),
        ("mendengus", "other"),
    ],
)
def test_sound_kind_maps_caption_tags(label, kind):
    assert sound_kind(label) == kind


def test_from_label_normalizes_and_keeps_original_label():
    event = SoundEvent.from_label(12.5, "[Tepuk Tangan]")
    assert (event.time, event.kind, event.label) == (12.5, "applause", "tepuk tangan")


@pytest.mark.parametrize(
    "args",
    [(-1.0, "laughter", "tertawa"), (float("nan"), "laughter", "tertawa"), (1.0, "boo", "x"),
     (1.0, "laughter", "{\\an8}"), (True, "laughter", "tertawa"), (1.0, "other", "x" * 41)],
)
def test_sound_event_validation(args):
    with pytest.raises((TypeError, ValueError)):
        SoundEvent(*args)


def test_events_between_is_inclusive_and_filters_kind():
    events = sort_events(
        [SoundEvent.from_label(t, label) for t, label in
         [(5.0, "tertawa"), (1.0, "tertawa"), (3.0, "tepuk tangan"), (7.0, "tertawa")]]
    )
    assert [item.time for item in events] == [1.0, 3.0, 5.0, 7.0]
    assert [item.time for item in events_between(events, 3.0, 7.0)] == [3.0, 5.0, 7.0]
    assert [item.time for item in events_between(events, 0, 10, kind="laughter")] == [1.0, 5.0, 7.0]


def test_artifact_round_trip_and_strict_reader(tmp_path):
    events = [SoundEvent.from_label(2.0, "tertawa"), SoundEvent.from_label(1.0, "bersorak")]
    path = tmp_path / "analysis" / "sound-events.json"
    write_sound_events(path, events, source="youtube-json3")
    loaded, source = read_sound_events(path)
    assert source == "youtube-json3"
    assert loaded == sort_events(events)
    assert not list(path.parent.glob(".*.tmp"))
    payload = events_to_dict(events, source="x")
    with pytest.raises(ValueError):
        events_from_dict({**payload, "extra": 1})
    with pytest.raises(ValueError):
        events_from_dict({**payload, "version": "sound-events-v0"})
    reversed_payload = {**payload, "events": list(reversed(payload["events"]))}
    with pytest.raises(ValueError):
        events_from_dict(reversed_payload)
    json.dumps(payload)
