from __future__ import annotations

import json

import pytest

from ai_clipper.selection_types import TREND_KINDS, TrendRef
from ai_clipper.sentences import SentenceUnit
from ai_clipper.trend_context import (
    MAX_RELEVANT_TRENDS,
    MAX_TREND_CONTEXT_BYTES,
    MAX_TREND_ITEMS,
    TREND_CONTEXT_VERSION,
    TREND_STOPWORDS,
    RelevantTrend,
    TrendContextError,
    TrendItem,
    TrendMatch,
    clean_trend_text,
    fold_hashtag,
    load_trend_context,
    match_trends,
    read_trend_context,
    relevant_trends,
    trend_context_from_dict,
    trend_tag_keys,
)

GENERATED = "2026-09-25T06:00:00Z"


def raw_item(index: int = 1, **overrides) -> dict:
    data = {
        "id": f"0b6f2c1e-0000-4000-8000-{index:012d}",
        "externalId": f"tiktok:tag:item-{index}",
        "kind": "topic",
        "title": "Kabur Aja Dulu",
        "summary": "Tagar ajakan merantau ke luar negeri.",
        "keywords": ["kabur aja dulu", "#KaburAjaDulu"],
        "hashtags": ["#KaburAjaDulu"],
        "platforms": ["tiktok", "x"],
        "region": "ID",
        "score": 72,
        "sensitivity": "normal",
        "firstSeenAt": "2026-09-24T08:00:00Z",
        "expiresAt": "2026-10-05T00:00:00Z",
        "enabled": True,
    }
    data.update(overrides)
    return data


def snapshot(*items: dict, **overrides) -> dict:
    data = {"version": TREND_CONTEXT_VERSION, "generatedAt": GENERATED, "items": list(items)}
    data.update(overrides)
    return data


def write(tmp_path, payload) -> object:
    path = tmp_path / "trend-context.json"
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return path


def item(title: str = "Kabur Aja Dulu", keywords=("kabur aja dulu",), **options) -> TrendItem:
    options.setdefault("id", f"id-{abs(hash((title, keywords))) % 10**8}")
    options.setdefault("kind", "topic")
    return TrendItem(title=title, keywords=tuple(keywords), **options)


def units(*texts: str, seconds: float = 5.0) -> list[SentenceUnit]:
    return [
        SentenceUnit(
            unit_id=f"S{index + 1:04d}",
            index=index,
            start=index * seconds,
            end=(index + 1) * seconds,
            text=text,
            segment_start=index,
            segment_end=index,
            word_count=len(text.split()),
            is_question=text.endswith("?"),
            gap_before=0.0,
            suspect=False,
            words=(),
        )
        for index, text in enumerate(texts)
    ]


# --- reading ----------------------------------------------------------------------------------


def test_read_trend_context_parses_items_with_defaults(tmp_path):
    minimal = {"id": "manual-1", "kind": "person", "title": "Habib Ja'far",
               "keywords": ["habib ja'far"]}
    path = write(tmp_path, snapshot(raw_item(), minimal))

    items = read_trend_context(path)

    assert len(items) == 2
    first, second = items
    assert first.id == "0b6f2c1e-0000-4000-8000-000000000001"
    assert first.external_id == "tiktok:tag:item-1"
    assert first.kind == "topic" and first.title == "Kabur Aja Dulu"
    assert first.keywords == ("kabur aja dulu", "#KaburAjaDulu")
    assert first.hashtags == ("#KaburAjaDulu",)
    assert first.platforms == ("tiktok", "x")
    assert first.score == 72.0 and first.sensitivity == "normal" and not first.sensitive
    assert first.first_seen_at == "2026-09-24T08:00:00Z"
    assert first.expires_at == "2026-10-05T00:00:00Z"
    assert second.summary == "" and second.hashtags == () and second.platforms == ()
    assert second.region == "ID" and second.score == 50.0 and second.sensitivity == "normal"
    assert second.external_id is None
    assert first.ref() == TrendRef(id=first.id, title="Kabur Aja Dulu", kind="topic")


def test_load_trend_context_reports_generated_at_and_ignores_extra_fields(tmp_path):
    extra = raw_item(examples=[{"url": "https://example.com/v/1", "note": "contoh"}],
                     source="hermes", createdAt=GENERATED, updatedAt=GENERATED, future=1)
    context = load_trend_context(write(tmp_path, snapshot(extra, note="ignored")))

    assert context.generated_at == GENERATED
    assert context.skipped == 0
    assert len(context.items) == 1
    assert not hasattr(context.items[0], "examples")


def test_text_is_normalized_like_the_server():
    assert clean_trend_text("Cafe\u0301  \u202eKabur\u200b aja\n dulu\x07") == "Café Kabur aja dulu"
    assert clean_trend_text("baris satu\r\nbaris dua\u2028tiga", multiline=True) == (
        "baris satu\nbaris dua\ntiga"
    )
    six = "\n".join(f"baris {index}" for index in range(1, 7))
    assert clean_trend_text(six, multiline=True).split("\n") == [
        f"baris {index}" for index in range(1, 6)
    ]


def test_titles_and_keywords_are_cleaned_before_their_length_is_checked(tmp_path):
    loud = raw_item(title="\u2066Kabur\n Aja   Dulu\u2069", keywords=["  kabur\u200baja  "])
    [parsed] = read_trend_context(write(tmp_path, snapshot(loud)))

    assert parsed.title == "Kabur Aja Dulu"
    assert parsed.keywords == ("kaburaja",)


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "rumor"},
        {"title": ""},
        {"title": "x" * 81},
        {"summary": "x" * 501},
        {"keywords": []},
        {"keywords": ["k"]},
        {"keywords": ["x" * 41]},
        {"keywords": [f"kata{index}" for index in range(13)]},
        {"keywords": "kabur aja dulu"},
        {"hashtags": ["KaburAjaDulu"]},
        {"hashtags": ["#kabur aja"]},
        {"hashtags": ["#" + "x" * 51]},
        {"hashtags": [f"#tag{index}" for index in range(11)]},
        {"platforms": ["myspace"]},
        {"region": "Indonesia"},
        {"score": 101},
        {"score": -1},
        {"score": True},
        {"score": "72"},
        {"sensitivity": "maybe"},
        {"firstSeenAt": "kemarin"},
        {"expiresAt": "2026-10-05T00:00:00"},
        {"externalId": "bad id with spaces"},
        {"id": ""},
        {"id": "../etc/passwd"},
        {"enabled": "yes"},
        {"title": 5},
    ],
)
def test_malformed_items_are_skipped_and_counted(tmp_path, overrides):
    good = raw_item(2, title="Timnas Garuda", keywords=["timnas garuda"])
    context = load_trend_context(write(tmp_path, snapshot(raw_item(**overrides), good)))

    assert [entry.title for entry in context.items] == ["Timnas Garuda"]
    assert context.skipped == 1


def test_non_object_items_and_duplicate_ids_are_skipped(tmp_path):
    payload = snapshot(raw_item(1), "teks", raw_item(1, title="Salinan"), raw_item(2))
    context = load_trend_context(write(tmp_path, payload))

    assert [entry.id[-1] for entry in context.items] == ["1", "2"]
    assert context.skipped == 2


def test_disabled_and_expired_items_are_inactive_not_broken(tmp_path):
    payload = snapshot(
        raw_item(1, enabled=False),
        raw_item(2, expiresAt="2026-09-25T05:59:59Z"),
        raw_item(3),
    )
    context = load_trend_context(write(tmp_path, payload))

    assert [entry.id[-1] for entry in context.items] == ["3"]
    assert context.skipped == 0


def test_only_the_first_items_up_to_the_limit_are_kept(tmp_path):
    payload = snapshot(*(raw_item(index, title=f"Tren {index}", keywords=[f"tren nomor{index}"])
                         for index in range(MAX_TREND_ITEMS + 2)))
    context = load_trend_context(write(tmp_path, payload))

    assert len(context.items) == MAX_TREND_ITEMS
    assert context.skipped == 2


@pytest.mark.parametrize(
    "payload",
    [
        "bukan json",
        "[]",
        json.dumps(snapshot(version=2)),
        json.dumps(snapshot(version="1")),
        json.dumps(snapshot(items={})),
        json.dumps({"version": 1, "items": []}),
        json.dumps(snapshot(generatedAt="kemarin")),
        '{"version": 1, "version": 1, "generatedAt": "2026-09-25T06:00:00Z", "items": []}',
        '{"version": 1, "generatedAt": "2026-09-25T06:00:00Z", "items": [{"score": NaN}]}',
    ],
)
def test_a_broken_file_is_a_clear_error(tmp_path, payload):
    with pytest.raises(TrendContextError):
        read_trend_context(write(tmp_path, payload))


def test_extreme_dates_are_malformed_items_not_crashes(tmp_path):
    payload = snapshot(
        raw_item(1, firstSeenAt="9999-12-31T23:59:59Z", expiresAt=None),
        raw_item(2, firstSeenAt="0001-01-01T00:00:00+05:00"),
        raw_item(3),
    )
    context = load_trend_context(write(tmp_path, payload))
    assert [entry.id[-1] for entry in context.items] == ["3"]
    assert context.skipped == 2
    with pytest.raises(TrendContextError):
        trend_context_from_dict(snapshot(generatedAt="0001-01-01T00:00:00+05:00"))
    early = trend_context_from_dict(
        snapshot(raw_item(4, firstSeenAt="0999-01-01T00:00:00Z", expiresAt="9999-01-01T00:00:00Z"),
                 generatedAt="0999-06-01T00:00:00Z")
    )
    assert early.generated_at == "0999-06-01T00:00:00Z"
    assert early.items[0].first_seen_at == "0999-01-01T00:00:00Z"


def test_unparseable_numbers_are_a_trend_context_error(tmp_path):
    huge = '{"version": 1, "generatedAt": "2026-09-25T06:00:00Z", "items": [{"score": ' + (
        "9" * 5000
    ) + "}]}"
    with pytest.raises(TrendContextError):
        read_trend_context(write(tmp_path, huge))


def test_errors_never_echo_item_text(tmp_path):
    secret = "RAHASIA-TIDAK-BOLEH-MUNCUL"
    path = write(tmp_path, '{"version": 1, "items": ["' + secret + '"], ')
    with pytest.raises(TrendContextError) as caught:
        read_trend_context(path)
    assert secret not in str(caught.value)
    assert str(tmp_path) not in str(caught.value)


def test_oversized_and_missing_files_are_rejected(tmp_path):
    big = tmp_path / "big.json"
    big.write_bytes(b" " * (MAX_TREND_CONTEXT_BYTES + 1))
    with pytest.raises(TrendContextError):
        read_trend_context(big)
    with pytest.raises(FileNotFoundError):
        read_trend_context(tmp_path / "missing.json")


def test_from_dict_matches_the_file_reader():
    context = trend_context_from_dict(snapshot(raw_item()))
    assert [entry.title for entry in context.items] == ["Kabur Aja Dulu"]


def test_trend_items_validate_on_construction():
    with pytest.raises(ValueError):
        TrendItem(id="a", kind="rumor", title="X", keywords=("abc",))
    with pytest.raises(ValueError):
        TrendItem(id="a", kind="topic", title="Baris\nbaru", keywords=("abc",))
    with pytest.raises(ValueError):
        TrendItem(id="a", kind="topic", title="X", keywords=())
    assert set(TREND_KINDS) >= {"topic", "person", "joke", "meme", "sound", "hashtag",
                                "format", "event"}


# --- matching ---------------------------------------------------------------------------------


def matched(items, text) -> list[str]:
    return [match.item.title for match in match_trends(items, text)]


def test_matching_is_casefolded_accent_free_and_whitespace_tidy():
    trend = item("Kabur Aja Dulu", ("kabur aja dulu",))
    assert matched([trend], "Pokoknya KABUR   aja, dulu! gitu") == ["Kabur Aja Dulu"]
    cafe = item("Café Viral", ("kafe café",))
    assert matched([cafe], "ke kafe CAFE bareng teman") == ["Café Viral"]


def test_matching_respects_unicode_word_boundaries():
    trend = item("Kabur", ("kabur aja",))
    assert matched([trend], "kaburan aja") == []
    assert matched([trend], "dikabur aja") == []
    assert matched([trend], "kabur-aja") == ["Kabur"]
    assert matched([item("Ulang tahun", ("ultah ke17",))], "ultah ke17an") == []


def test_multi_word_keywords_match_only_as_a_phrase():
    trend = item("Makan Siang Gratis", ("makan siang gratis",))
    assert matched([trend], "makan gratis siang") == []
    assert matched([trend], "program makan siang gratis itu") == ["Makan Siang Gratis"]


def test_hashtags_match_without_the_hash_and_split_at_case_changes():
    trend = item("Tagar", ("tagar lama",), hashtags=("#KaburAjaDulu",))
    assert matched([trend], "gue sih kabur aja dulu") == ["Tagar"]
    assert matched([trend], "tagarnya kaburajadulu") == ["Tagar"]
    keyword_tag = item("Kata kunci", ("#IndonesiaGelap",))
    assert matched([keyword_tag], "katanya indonesia gelap") == ["Kata kunci"]


def test_the_title_is_a_match_term():
    assert matched([item("Timnas Garuda", ("sepak bola nasional",))], "timnas garuda menang") == [
        "Timnas Garuda"
    ]


def test_short_and_common_keywords_never_match_alone():
    assert matched([item("AI", ("AI",))], "pakai AI terus") == []
    assert matched([item("Ok", ("ok",))], "ok ok ok") == []
    assert "viral" in TREND_STOPWORDS and "aja" in TREND_STOPWORDS
    assert matched([item("Viral", ("viral",))], "videonya viral banget") == []
    assert matched([item("Aja dulu", ("aja dulu",))], "aja dulu deh") == []
    assert matched([item("AI Act", ("AI act",))], "soal AI act eropa") == ["AI Act"]


def test_trend_tag_keys_are_the_trend_written_as_one_hashtag_word():
    trend = item("Kabur Aja Dulu", ("kabur aja dulu", "AI", "Café gaul"), hashtags=("#Merantau_ID",))
    assert fold_hashtag("#Kabur_Aja Dulu") == "kaburajadulu"
    assert fold_hashtag("#CaféGaul") == "cafegaul"
    assert trend_tag_keys(trend) == frozenset({"kaburajadulu", "cafegaul", "merantauid"})
    assert "ai" not in trend_tag_keys(trend)  # never a match on its own, so never a tag key


def test_matches_are_ordered_by_count_then_score_and_report_terms():
    once = item("Sekali", ("gajah terbang",), score=90)
    twice = item("Dua kali", ("kuda laut",), score=10)
    also_twice = item("Dua kali juga", ("ikan pari",), score=40)
    text = "kuda laut ikan pari gajah terbang kuda laut ikan pari"

    matches = match_trends([once, twice, also_twice], text)

    assert [match.item.title for match in matches] == ["Dua kali juga", "Dua kali", "Sekali"]
    assert [match.count for match in matches] == [2, 2, 1]
    assert isinstance(matches[0], TrendMatch)
    assert matches[0].terms == ("ikan pari",)


def test_overlapping_terms_of_one_item_count_once_per_position():
    trend = item("Kabur Aja Dulu", ("kabur aja dulu", "kabur aja"), hashtags=("#KaburAjaDulu",))
    [match] = match_trends([trend], "kabur aja dulu, serius kabur aja dulu")
    assert match.count == 2


def test_no_items_or_no_text_give_no_matches():
    assert match_trends([], "kabur aja dulu") == ()
    assert match_trends([item()], "") == ()


# --- relevance --------------------------------------------------------------------------------


def test_relevant_trends_counts_occurrences_with_their_times():
    trend = item("Kabur Aja Dulu", ("kabur aja dulu",), score=60)
    other = item("Timnas", ("timnas garuda",), score=99)
    absent = item("Tidak ada", ("gunung meletus",))
    transcript = units(
        "Halo semua.",
        "Gue mau kabur aja dulu.",
        "Timnas garuda main.",
        "Ya kabur aja dulu lah.",
    )

    relevant = relevant_trends([other, absent, trend], transcript)

    assert [entry.item.title for entry in relevant] == ["Kabur Aja Dulu", "Timnas"]
    assert isinstance(relevant[0], RelevantTrend)
    assert relevant[0].count == 2 and relevant[0].times == (5.0, 15.0)
    assert relevant[1].count == 1 and relevant[1].times == (10.0,)


def test_relevant_trends_match_a_phrase_across_unit_boundaries():
    transcript = units("Pokoknya kabur", "aja dulu.")
    [entry] = relevant_trends([item()], transcript)
    assert entry.times == (0.0,)


def test_relevant_trends_are_limited_and_ordered_by_count_then_score():
    items = [item(f"Tren {index}", (f"topik nomor{index}",), score=index) for index in range(25)]
    text = " ".join(f"topik nomor{index}." for index in range(25))

    relevant = relevant_trends(items, units(text))

    assert len(relevant) == MAX_RELEVANT_TRENDS == 20
    assert [entry.item.score for entry in relevant] == [float(value) for value in
                                                        range(24, 4, -1)]
    assert len(relevant_trends(items, units(text), limit=3)) == 3
    assert relevant_trends([], units(text)) == ()
