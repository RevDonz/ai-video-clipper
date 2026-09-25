"""Fokus klip (docs/plans/2026-09-25-fokus-klip.md): the job option and literal matching."""

from __future__ import annotations

import pytest

from ai_clipper.focus import (
    FOCUS_MODES,
    FOCUS_PARTICLES,
    FOCUS_POSSESSIVES,
    FOCUS_PREFIXES,
    FOCUS_STOPWORDS,
    FOCUS_SUFFIXES,
    FOCUS_WORD_ROOTS,
    MAX_FOCUS_NOTE_CHARS,
    MENTION_CLUSTER_SECONDS,
    MIN_PREFIX_TERM_LETTERS,
    MIN_SUFFIX_TERM_LETTERS,
    FocusHit,
    FocusMatcher,
    FocusSpec,
    focus_term_matchable,
    mention_clusters,
    parse_focus,
)
from ai_clipper.models import TranscriptWord
from ai_clipper.selection_types import MAX_FOCUS_TERM_CHARS, MAX_FOCUS_TERMS
from ai_clipper.sentences import SentenceUnit

# --- the option -------------------------------------------------------------------------------


def test_the_affix_lists_follow_the_spec():
    assert FOCUS_PREFIXES == (
        "di", "ke", "se", "ber", "be", "per", "pe", "ter", "me", "mem", "men", "meng", "meny",
        "peng", "pen", "pem", "peny",
    )  # fmt: skip
    assert FOCUS_SUFFIXES == ("an", "kan", "i", "in")
    assert FOCUS_POSSESSIVES == ("nya", "ku", "mu")
    assert FOCUS_PARTICLES == ("lah", "kah", "pun", "tah")
    assert FOCUS_MODES == ("prefer",)
    assert (MAX_FOCUS_TERMS, MAX_FOCUS_TERM_CHARS, MAX_FOCUS_NOTE_CHARS) == (8, 40, 200)
    assert (MIN_PREFIX_TERM_LETTERS, MIN_SUFFIX_TERM_LETTERS) == (4, 5)


def test_parse_focus_cleans_terms_and_note_like_trend_text():
    focus = parse_focus(
        ["  jomok ", "Jomok\u200bers", "reza\u202e  auditore"], " momen\njomok  lucu "
    )

    assert focus == FocusSpec(
        terms=("jomok", "Jomokers", "reza auditore"), note="momen jomok lucu", mode="prefer"
    )


def test_no_terms_means_no_focus():
    assert parse_focus(None) is None
    assert parse_focus([]) is None
    assert parse_focus(["", "  ", "\u200b"]) is None
    assert parse_focus([], "") is None


@pytest.mark.parametrize(
    ("terms", "note", "mode"),
    [
        ([], "catatan tanpa istilah", "prefer"),
        (["a"], None, "prefer"),  # 1 character
        (["x" * 41], None, "prefer"),
        ([f"istilah{index}" for index in range(9)], None, "prefer"),
        (["jomok", "JOMOK"], None, "prefer"),  # unique by casefold
        (["jomok"], "x" * 201, "prefer"),
        (["jomok"], None, "only"),  # the enum is prepared for "only", not yet accepted
    ],
)
def test_parse_focus_rejects_what_the_spec_forbids(terms, note, mode):
    with pytest.raises(ValueError):
        parse_focus(terms, note, mode)


def test_parse_focus_accepts_the_bounds():
    focus = parse_focus([f"is{index}" for index in range(8)], "x" * 200)
    assert len(focus.terms) == 8 and len(focus.note) == 200
    assert parse_focus(["ok"]).terms == ("ok",)
    assert parse_focus(["x" * 40]).terms == ("x" * 40,)


@pytest.mark.parametrize("value", ["jomok", b"jomok", 5, ["jomok", 5]])
def test_parse_focus_needs_a_list_of_strings(value):
    with pytest.raises(TypeError):
        parse_focus(value)


def test_focus_spec_itself_is_validated():
    with pytest.raises(ValueError):
        FocusSpec(terms=())
    with pytest.raises(ValueError):
        FocusSpec(terms=("jomok\n",))  # not clean
    with pytest.raises(TypeError):
        FocusSpec(terms=["jomok"])  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        FocusSpec(terms=("jomok",), note="a\u202eb")


# --- literal matching -------------------------------------------------------------------------


def mentions(terms, text):
    return FocusMatcher(parse_focus(terms)).mentions(text)


@pytest.mark.parametrize(
    "text",
    [
        "Jadi kita untuk belajar perjomokan di sini.",  # per-...-an
        "Bukan si jomoknya ini loh.",  # -nya
        "makanya gimnya kejomok kan di situ",  # ke-
        "gimiknya kejomokan",  # ke-...-an
        "orang-orang jomok-jomok gitu",  # reduplication
        "Bapak harus berjomok ria.",  # ber-
        "JOMOK!",
        "jomók",  # accents do not matter
        "dijomokin terus",  # di-...-in
        "menjomokkan",  # men-...-kan
        "jomoknyalah",  # -nya + -lah
        "sejomok-jomoknya",
    ],
)
def test_derived_words_of_a_one_word_term_match(text):
    assert mentions(["jomok"], text) == ("jomok",)


@pytest.mark.parametrize(
    "text",
    [
        "dramok drama gitu",  # a blend that only shares letters
        "jomokers",  # the rest after the affixes must be exactly the term
        "jomoks",
        "jojomok",  # "jo" is no prefix
        "majomok",
        "jomokkannyaan",  # suffixes in a wrong order
        "jom ok",
        "",
    ],
)
def test_other_words_that_contain_the_letters_never_match(text):
    assert mentions(["jomok"], text) == ()


def test_short_terms_take_clitics_but_no_prefix():
    assert mentions(["ban"], "bannya bocor") == ("ban",)
    assert mentions(["ban"], "diban dari grup") == ()
    assert mentions(["reza"], "direza terus") == ("reza",)  # four letters: prefixes allowed


@pytest.mark.parametrize(
    ("term", "text"),
    [
        # A derivational suffix (-an, -kan, -i, -in) needs five letters, or a prefix with it.
        ("rap", "Kamarnya rapi banget."),
        ("sen", "Belajar seni tiap hari senin."),
        ("mak", "Makin lama makin enak makan di sana."),
        ("tem", "Ini teman lama gue."),
        ("bul", "Bulan depan kita ke sana."),
        ("bad", "Badannya gede banget."),
        ("dep", "Duduk di depan."),
        ("kir", "Belok kiri."),
        ("per", "Perannya penting."),
        ("sin", "Sini dong."),
        ("din", "Masih dini hari."),
        ("tan", "Hasil tani warga."),
        ("ban", "Bani Israil."),
        ("pas", "Mukanya pucat pasi."),
        ("bus", "Busi motornya mati."),
        ("tang", "Tangannya gemetar."),
        ("Rama", "Pasarnya ramai sekali."),
        ("sela", "Selain itu gue juga main."),
        ("gula", "Makan gulai kambing."),
        # Common words that only look like a prefix + the term (+ an ending).
        ("tang", "Sudah petang."),
        ("rang", "Perang dunia, serang balik, jadi berang."),
        ("tara", "Setara dan ketara."),
        ("panda", "Anaknya pandai banget."),
        ("santa", "Santai aja."),
        ("masa", "Itu masalahnya, dia bermasalah."),
        ("karang", "Sekarang giliran lu."),
        ("rubah", "Dia berubah total, perubahannya besar."),
        ("alam", "Gue pernah mengalami itu, pengalaman pahit."),
        ("buah", "Sebuah cerita."),
        ("lalu", "Selalu begitu, terlalu sering."),
    ],
)
def test_affixes_never_reach_other_common_words(term, text):
    assert mentions([term], text) == ()


@pytest.mark.parametrize(
    ("term", "text"),
    [
        ("rasa", "Perasaannya campur aduk."),  # a confix on a four-letter term
        ("rasa", "Dirasakan banget."),
        ("uang", "Masalah keuangan."),
        ("kerja", "Pekerjaan gue, bekerja tiap hari, dikerjakan bareng."),
        ("lucu", "Lucunya di situ, kelucuan dia."),
        ("drama", "Dramanya panjang."),
        ("ubah", "Dia berubah total, perubahannya besar."),
        ("lain", "Selain itu gue juga main."),
        ("jomok", "jomokan"),  # five letters: a bare suffix is fine
        ("masalah", "Itu masalahnya."),
    ],
)
def test_real_derived_words_still_match(term, text):
    assert mentions([term], text) == (term,)


def test_the_root_words_follow_the_rules_they_override():
    for word, roots in FOCUS_WORD_ROOTS.items():
        assert word.isalpha() and word == word.casefold()
        for root in roots:
            assert mentions([root], word) == (root,), (word, root)


def test_short_or_function_word_terms_never_match_on_their_own():
    assert mentions(["ai"], "pakai ai buat kerja") == ()
    assert mentions(["5G"], "sinyal 5G kenceng") == ()
    assert mentions(["yang"], "yang itu") == ()
    assert mentions(["apa aja"], "apa aja boleh") == ()
    assert mentions(["orang tua"], "Orang tua gue bilang") == ("orang tua",)


@pytest.mark.parametrize(
    "term",
    [
        "tiktok", "sosmed", "uang", "kuliah", "keluarga", "lucu", "netizen", "podcast",
        "Indonesia", "kerja", "orang", "gas", "anak kuliah", "anak-anak",
    ],
)  # fmt: skip
def test_owner_terms_that_are_everyday_trend_words_still_match(term):
    text = (
        "Tiktok dan sosmed, uang kuliah, keluarga yang lucu, netizen podcast Indonesia, "
        "kerja orang, ayo gas, anak kuliah, anak-anak."
    )
    assert mentions([term], text) == (term,)


def test_the_focus_stopwords_are_function_words_and_fillers_only():
    from ai_clipper.trend_context import TREND_STOPWORDS

    assert FOCUS_STOPWORDS < TREND_STOPWORDS
    assert {"yang", "dan", "sih", "wkwk", "the"} <= FOCUS_STOPWORDS
    owner_topics = {"tiktok", "uang", "kuliah", "keluarga", "lucu", "netizen", "indonesia"}
    assert not owner_topics & FOCUS_STOPWORDS


def test_terms_that_can_never_match_literally_are_known():
    matcher = FocusMatcher(parse_focus(["AI", "jomok", "apa aja", "5G", "anak kuliah"]))
    assert matcher.unmatchable == ("AI", "apa aja", "5G")
    assert [focus_term_matchable(term) for term in ("AI", "jomok", "apa aja", "5G")] == [
        False, True, False, False,
    ]  # fmt: skip
    assert FocusMatcher(parse_focus(["jomok"])).unmatchable == ()


def test_terms_that_tokenise_alike_are_one_term():
    assert parse_focus(["jomok", "Jomok!", "k-pop", "K pop", "kpop"]).terms == (
        "jomok", "k-pop", "kpop",
    )  # fmt: skip
    with pytest.raises(ValueError):
        FocusSpec(terms=("jomok", "Jomok!"))  # the checked form never holds both


def test_multi_word_terms_match_as_phrases_with_a_clitic_on_the_last_word():
    assert mentions(["kabur aja dulu"], "Kabur, aja... dulu!") == ("kabur aja dulu",)
    assert mentions(["kabur aja dulu"], "kabur aja dulunya") == ("kabur aja dulu",)
    assert mentions(["kabur aja dulu"], "kaburan aja dulu") == ()
    assert mentions(["kabur aja dulu"], "kabur aja") == ()
    assert mentions(["reza auditore"], "Reza Auditore-nya") == ("reza auditore",)


def test_mentions_keep_the_owner_order_and_spelling():
    assert mentions(["Rusdi", "Jomok"], "jomok dan rusdinya") == ("Rusdi", "Jomok")


def test_hashtags_naming_a_term_are_recognised():
    matcher = FocusMatcher(parse_focus(["jomok", "kabur aja dulu"]))
    assert matcher.names_tag("#Jomok")
    assert matcher.names_tag("#perjomokan")
    assert matcher.names_tag("#KaburAjaDulu")
    assert matcher.names_tag("#kabur_aja_dulu")
    assert not matcher.names_tag("#jomokers")
    assert not matcher.names_tag("#podcast")


def unit(index: int, start: float, text: str, words=()) -> SentenceUnit:
    return SentenceUnit(
        unit_id=f"S{index + 1:04d}",
        index=index,
        start=start,
        end=start + 5.0,
        text=text,
        segment_start=index,
        segment_end=index,
        word_count=len(text.split()),
        is_question=False,
        gap_before=0.0,
        suspect=False,
        words=tuple(words),
    )


def test_hits_are_per_unit_with_the_word_time_when_words_are_known():
    words = (
        TranscriptWord(10.0, 10.4, "Jadi"),
        TranscriptWord(10.4, 10.9, "belajar"),
        TranscriptWord(11.2, 11.9, "perjomokan,"),
        TranscriptWord(12.0, 12.3, "ya."),
    )
    units = [
        unit(0, 0.0, "Pembuka tanpa istilah."),
        unit(1, 10.0, "Jadi belajar perjomokan, ya.", words),
        unit(2, 20.0, "Terus Reza"),
        unit(3, 25.0, "Auditore bilang jomok-jomok."),
    ]
    matcher = FocusMatcher(parse_focus(["jomok", "reza auditore"]))

    hits = matcher.hits(units)

    assert hits == (
        FocusHit(term="jomok", first_unit=1, last_unit=1, time=11.2),
        FocusHit(term="reza auditore", first_unit=2, last_unit=3, time=20.0),
        FocusHit(term="jomok", first_unit=3, last_unit=3, time=25.0),
    )


def test_hits_of_a_reduplication_count_once_per_unit():
    hits = FocusMatcher(parse_focus(["jomok"])).hits([unit(0, 0.0, "jomok-jomok jomok")])
    assert hits == (FocusHit(term="jomok", first_unit=0, last_unit=0, time=0.0),)


def test_mentions_close_together_form_one_cluster():
    def hit(time: float, unit: int) -> FocusHit:
        return FocusHit("jomok", unit, unit, time)

    first, close = hit(10.0, 1), hit(10.0 + MENTION_CLUSTER_SECONDS, 3)
    far, late = hit(10.0 + 2 * MENTION_CLUSTER_SECONDS + 0.1, 5), hit(200.0, 9)

    assert mention_clusters([late, far, close, first]) == [(first, close), (far,), (late,)]
    assert mention_clusters([]) == []


def test_hits_need_units():
    with pytest.raises(TypeError):
        FocusMatcher(parse_focus(["jomok"])).hits("jomok")
    with pytest.raises(TypeError):
        FocusMatcher("jomok")  # type: ignore[arg-type]


def test_konteks_tren_matching_is_unchanged_by_the_focus_affixes():
    from ai_clipper.trend_context import TrendItem, match_trends

    item = TrendItem(id="t1", kind="topic", title="Jomok", keywords=("jomok",))
    assert match_trends([item], "jomoknya")  # the trend clitic rule
    assert not match_trends([item], "perjomokan")  # no focus prefixes or suffixes
    assert not match_trends([item], "kejomok")
