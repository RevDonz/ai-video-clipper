"""Konteks Tren contract with the web app.

``tests/fixtures/trend-context-snapshot.v1.json`` is byte for byte what the worker writes as
``analysis/trend-context.json`` (``web/tests/trend-contract.test.mjs`` regenerates it from the
real store code and fails when the two drift). The engine must read every item of it, and the
clip trends it derives must have the shape the job API sanitizer keeps.
"""

from __future__ import annotations

import re
from pathlib import Path

from ai_clipper.trend_context import load_trend_context, match_trends

FIXTURE = Path(__file__).parent / "fixtures" / "trend-context-snapshot.v1.json"
UUID_V4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def test_the_engine_reads_every_item_of_the_worker_snapshot() -> None:
    context = load_trend_context(FIXTURE)

    assert context.skipped == 0
    assert context.generated_at == "2026-09-25T06:00:00Z"
    assert [(item.kind, item.title, item.sensitivity) for item in context.items] == [
        ("topic", "Kabur Aja Dulu", "normal"),
        ("meme", "Café Gaul", "normal"),
        ("person", "Tokoh Bencana", "sensitive"),
    ]
    kabur, cafe, tokoh = context.items
    assert kabur.external_id == "tiktok:tag:kabur-aja-dulu"
    assert kabur.summary == "Tagar ajakan merantau ke luar negeri.\nRamai di TikTok dan X."
    assert kabur.keywords == ("kabur aja dulu", "#KaburAjaDulu")
    assert kabur.hashtags == ("#KaburAjaDulu",)
    assert kabur.platforms == ("tiktok", "x")
    assert (kabur.score, cafe.score, tokoh.score) == (72.0, 64.0, 50.0)
    assert kabur.expires_at == "2026-10-05T00:00:00Z"
    assert cafe.external_id is None and cafe.hashtags == ("#CaféGaul",)
    assert tokoh.sensitive


def test_snapshot_items_match_transcripts_and_become_job_api_trend_refs() -> None:
    items = load_trend_context(FIXTURE).items
    found = match_trends(items, "Ya udah, kabur aja dulu. Terus nongkrong di cafe gaul.")

    assert [match.item.title for match in found] == ["Kabur Aja Dulu", "Café Gaul"]
    for item in items:
        ref = item.ref().to_dict()
        assert list(ref) == ["id", "title", "kind"]  # the manifest shape web/lib/jobs.mjs keeps
        assert UUID_V4.fullmatch(ref["id"])  # jobs.mjs keeps store UUIDs only
        assert 1 <= len(ref["title"]) <= 80
