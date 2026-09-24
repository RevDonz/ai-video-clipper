import itertools
import random
import time

import pytest

from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.sentences import SentenceUnit, build_sentence_units, looks_like_question
from ai_clipper.transcript_quality import TranscriptQuality, assess_transcript


def worded(*segment_texts: str, start: float = 0.0) -> list[TranscriptSegment]:
    """One segment per argument; words last 0.25 s with 0.05 s gaps, `<x>` adds x seconds."""
    moment = start
    segments = []
    for raw in segment_texts:
        words = []
        for token in raw.split():
            if token.startswith("<") and token.endswith(">"):
                moment += float(token[1:-1])
                continue
            words.append(TranscriptWord(round(moment, 3), round(moment + 0.25, 3), token, 0.9))
            moment += 0.3
        text = " ".join(word.text for word in words)
        segments.append(TranscriptSegment(words[0].start, words[-1].end, text, tuple(words)))
    return segments


def texts(units: list[SentenceUnit]) -> list[str]:
    return [unit.text for unit in units]


def test_word_mode_splits_on_terminal_punctuation_and_fills_every_field():
    segments = worded(
        "Gue bukan jambret. Terus kenapa lu nyopet?", "Karena butuh duit banget waktu itu."
    )

    units = build_sentence_units(segments)

    assert texts(units) == [
        "Gue bukan jambret.",
        "Terus kenapa lu nyopet?",
        "Karena butuh duit banget waktu itu.",
    ]
    first, second, third = units
    assert [unit.unit_id for unit in units] == ["S0001", "S0002", "S0003"]
    assert [unit.index for unit in units] == [0, 1, 2]
    assert first.start == segments[0].words[0].start
    assert first.end == segments[0].words[2].end
    assert first.words == segments[0].words[:3]
    assert (second.segment_start, second.segment_end) == (0, 0)
    assert (third.segment_start, third.segment_end) == (1, 1)
    assert [unit.word_count for unit in units] == [3, 4, 6]
    assert [unit.is_question for unit in units] == [False, True, False]
    assert first.gap_before == 0.0
    assert second.gap_before == pytest.approx(0.05)
    assert not any(unit.suspect for unit in units)


def test_units_can_span_segments_when_punctuation_is_missing():
    segments = worded("jadi waktu itu gue", "lagi di pasar sama temen")

    units = build_sentence_units(segments)

    assert texts(units) == ["jadi waktu itu gue lagi di pasar sama temen"]
    assert (units[0].segment_start, units[0].segment_end) == (0, 1)
    assert units[0].words == segments[0].words + segments[1].words


def test_pause_splits_without_punctuation():
    units = build_sentence_units(worded("jadi gue waktu itu <0.7> nggak tau harus ngapain"))

    assert texts(units) == ["jadi gue waktu itu", "nggak tau harus ngapain"]
    assert units[1].gap_before == pytest.approx(0.75)


def test_short_pause_does_not_split_and_pause_split_is_configurable():
    segments = worded("jadi gue waktu itu <0.4> nggak tau harus ngapain")

    assert len(build_sentence_units(segments)) == 1
    assert len(build_sentence_units(segments, pause_split=0.4)) == 2


def test_ellipsis_is_terminal_only_before_a_real_gap():
    split = worded("jadi ya gitu deh... <0.35> terus gue pergi dari situ")
    joined = worded("jadi ya gitu deh... terus gue pergi dari situ")

    assert texts(build_sentence_units(split)) == [
        "jadi ya gitu deh...",
        "terus gue pergi dari situ",
    ]
    assert len(build_sentence_units(joined)) == 1


def test_fullwidth_and_quoted_terminal_marks_split():
    units = build_sentence_units(
        worded('dia bilang "udah!" terus pergi aja gitu？ iya bener banget')
    )

    assert texts(units) == ['dia bilang "udah!"', "terus pergi aja gitu？", "iya bener banget"]
    assert units[1].is_question


def _numbered(count: int, prefix: str = "kata") -> list[str]:
    return [f"{prefix}{index}" for index in range(count)]


def test_long_unit_splits_at_its_largest_internal_gap():
    tokens = _numbered(40)
    tokens.insert(15, "<0.3>")

    units = build_sentence_units(worded(" ".join(tokens)))

    assert [unit.word_count for unit in units] == [15, 25]
    assert units[1].text.startswith("kata15 ")


def test_long_unit_without_cues_splits_near_the_middle():
    units = build_sentence_units(worded(" ".join(_numbered(40))))

    assert [unit.word_count for unit in units] == [20, 20]


def test_soft_punctuation_is_a_split_cue():
    tokens = _numbered(40)
    tokens[9] = "koma,"

    units = build_sentence_units(worded(" ".join(tokens)))

    assert [unit.word_count for unit in units] == [10, 30]


def test_very_long_runs_respect_word_and_second_limits():
    units = build_sentence_units(worded(" ".join(_numbered(500))))

    assert all(unit.word_count <= 32 for unit in units)
    assert all(unit.end - unit.start <= 14.0 for unit in units)
    assert sum(unit.word_count for unit in units) == 500
    assert min(unit.word_count for unit in units) >= 3


def test_slow_speech_splits_on_duration():
    units = build_sentence_units(worded(" <0.45> ".join(_numbered(20))))

    assert [unit.word_count for unit in units] == [10, 10]
    assert all(unit.end - unit.start <= 14.0 for unit in units)


def test_fragment_merges_into_the_closer_neighbour():
    units = build_sentence_units(
        worded(
            "Kemarin gue ke pasar sama nyokap. Iya. <0.9> Terus lu ngapain di sana?",
            "Udah selesai semua urusannya kemarin. <0.8> Nah <0.7> gue pikir itu aman banget.",
        )
    )

    assert texts(units) == [
        "Kemarin gue ke pasar sama nyokap. Iya.",
        "Terus lu ngapain di sana?",
        "Udah selesai semua urusannya kemarin.",
        "Nah gue pikir itu aman banget.",
    ]
    assert units[3].gap_before == pytest.approx(0.85)


def test_isolated_fragment_stays_alone():
    units = build_sentence_units(
        worded("Udah itu aja kemarin. <2.0> Oke. <2.0> Lanjut ke topik berikutnya ya.")
    )

    assert texts(units) == ["Udah itu aja kemarin.", "Oke.", "Lanjut ke topik berikutnya ya."]


def test_answer_fragment_does_not_bury_the_question_mark():
    units = build_sentence_units(
        worded("Lu pernah nyopet juga? Iya. <0.05> Pernah sekali waktu SMA.")
    )

    assert texts(units) == ["Lu pernah nyopet juga?", "Iya. Pernah sekali waktu SMA."]
    assert units[0].is_question


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Oh, udah nggak nyopet lagi?", True),
        ('Dia nanya "serius lu?"', True),
        ("serius lu?)", True),
        ("kenapa lu bisa ketangkep", True),
        ("terus gimana ceritanya", True),
        ("Bang, jadi siapa yang ngajarin", True),
        ("di mana lu pertama kali nyopet", True),
        ("boleh tau umurnya berapa", True),
        ("boleh tahu kenapa", True),
        ("berapa lama lu di penjara", True),
        ("apakah itu legal", True),
        ("why would you do that", True),
        ("so how did it start", True),
        ("apa yang bikin lu berhenti", True),
        ("emang lu pernah ketangkep", True),
        ("pernah nggak lu nyesel", True),
        ("masa sih lu nggak takut", True),
        ("Gue bukan jambret.", False),
        ("apa yang gue lakuin udah lewat.", False),
        ("Emang gitu sih.", False),
        ("Pernah.", False),
        ("pernah", False),
        ("masa kecil gue susah banget", False),
        ("Kenapa? Karena gue butuh duit.", True),
        ("di mana-mana ada copet", False),
        ("kapan-kapan kita ngopi", False),
        ("beberapa kali gue ketangkep", False),
        ("oh eh ah kenapa", False),
        ("", False),
    ],
)
def test_question_rule(text: str, expected: bool):
    assert looks_like_question(text) is expected


def test_segment_mode_uses_segment_bounds():
    segments = [
        TranscriptSegment(0.0, 6.76, "Ini mungkin akan menjadi sejarah pertama kalinya, Ijal."),
        TranscriptSegment(6.76, 7.76, "Mantan, Bang."),
        TranscriptSegment(7.76, 9.64, "Oh, udah nggak nyopet lagi?"),
        TranscriptSegment(9.64, 10.64, "Kok udah gua?"),
    ]

    units = build_sentence_units(segments)

    assert texts(units) == [
        "Ini mungkin akan menjadi sejarah pertama kalinya, Ijal. Mantan, Bang.",
        "Oh, udah nggak nyopet lagi?",
        "Kok udah gua?",
    ]
    assert (units[0].start, units[0].end) == (0.0, 7.76)
    assert (units[0].segment_start, units[0].segment_end) == (0, 1)
    assert units[0].word_count == 10
    assert all(unit.words == () for unit in units)


def test_segment_mode_chunks_unpunctuated_zero_gap_runs():
    segments = [
        TranscriptSegment(index * 2.0, index * 2.0 + 2.0, f"kata{index} lagi terus gitu")
        for index in range(60)
    ]

    units = build_sentence_units(segments)

    assert all(unit.end - unit.start <= 14.0 for unit in units)
    assert all(3 <= unit.word_count <= 32 for unit in units)
    covered = [index for unit in units for index in range(unit.segment_start, unit.segment_end + 1)]
    assert covered == list(range(60))


def test_suspect_segments_are_isolated_and_flagged():
    segments = [
        TranscriptSegment(index * 2.0, index * 2.0 + 2.0, f"kata{index} lagi terus gitu")
        for index in range(10)
    ]
    segments[5] = TranscriptSegment(10.0, 12.0, "森knya dip vibunics")
    quality = assess_transcript(segments)

    units = build_sentence_units(segments, quality=quality)

    suspect = [unit for unit in units if unit.suspect]
    assert [(unit.segment_start, unit.segment_end) for unit in suspect] == [(5, 5)]
    assert all(
        not (unit.segment_start <= 5 <= unit.segment_end) for unit in units if not unit.suspect
    )


def test_suspect_fragment_is_not_merged_into_clean_speech():
    segments = [
        TranscriptSegment(0.0, 2.0, "Jadi gue waktu itu lagi di pasar."),
        TranscriptSegment(2.0, 3.0, "ga wants"),
        TranscriptSegment(3.0, 5.0, "Terus gue lihat ada orang lewat."),
    ]
    quality = TranscriptQuality(0.66, (), 0.0, False, (1,), ("script_mismatch:1",))

    units = build_sentence_units(segments, quality=quality)

    assert [(unit.text, unit.suspect) for unit in units] == [
        ("Jadi gue waktu itu lagi di pasar.", False),
        ("ga wants", True),
        ("Terus gue lihat ada orang lewat.", False),
    ]


def test_mixed_word_and_segment_timing():
    segments = worded("Gue bukan jambret.")
    segments.append(TranscriptSegment(1.0, 3.0, "Terus kenapa lu nyopet?"))

    units = build_sentence_units(segments)

    assert texts(units) == ["Gue bukan jambret.", "Terus kenapa lu nyopet?"]
    assert units[0].words == segments[0].words
    assert units[1].words == ()
    assert units[1].start == 1.0


def test_every_word_lands_in_exactly_one_unit_in_order():
    rng = random.Random(7)
    vocabulary = ["gue", "lu", "kenapa", "iya", "gitu.", "terus", "bang?", "kan", "nah,", "oke..."]
    raw = []
    for _segment in range(80):
        tokens = []
        for _ in range(rng.randint(1, 25)):
            if rng.random() < 0.1:
                tokens.append(f"<{rng.choice([0.2, 0.5, 0.7, 1.6, 3.0])}>")
            tokens.append(rng.choice(vocabulary))
        if tokens[-1].startswith("<"):
            tokens.append("akhir")
        raw.append(" ".join(tokens))
    segments = worded(*raw)

    units = build_sentence_units(segments)

    flattened = [word for unit in units for word in unit.words]
    assert flattened == [word for segment in segments for word in segment.words]
    assert all(later.start >= earlier.end for earlier, later in itertools.pairwise(units))
    assert [unit.index for unit in units] == list(range(len(units)))


def test_sixty_five_minute_transcripts_are_fast():
    rng = random.Random(11)
    raw = []
    for index in range(1000):
        tokens = [f"w{index}_{position}" for position in range(rng.randint(6, 14))]
        if index % 3 == 0:
            tokens[-1] += "."
        if index % 7 == 0:
            tokens.insert(rng.randint(1, len(tokens) - 1), "<0.8>")
        raw.append(" ".join(tokens))
    word_segments = worded(*raw)
    assert word_segments[-1].end > 3000
    plain = [
        TranscriptSegment(index * 1.6, index * 1.6 + 1.6, f"kata{index} lagi terus gitu")
        for index in range(2400)
    ]

    started = time.perf_counter()
    word_units = build_sentence_units(word_segments, quality=assess_transcript(word_segments))
    segment_units = build_sentence_units(plain, quality=assess_transcript(plain))
    elapsed = time.perf_counter() - started

    assert word_units and segment_units
    assert elapsed < 1.0


def test_empty_input_and_parameter_validation():
    assert build_sentence_units([]) == []
    segments = worded("halo semua")
    for options in [
        {"pause_split": 0},
        {"pause_split": float("nan")},
        {"max_words": 0},
        {"max_words": 2.5},
        {"max_seconds": -1},
        {"min_words": 0},
        {"min_words": 40},
        {"min_words": True},
    ]:
        with pytest.raises((TypeError, ValueError)):
            build_sentence_units(segments, **options)
    with pytest.raises(TypeError):
        build_sentence_units(["halo"])
    with pytest.raises(TypeError):
        build_sentence_units(segments, quality="bad")


def _unit(**changes) -> SentenceUnit:
    fields = {
        "unit_id": "S0001",
        "index": 0,
        "start": 0.0,
        "end": 1.0,
        "text": "Halo",
        "segment_start": 0,
        "segment_end": 0,
        "word_count": 1,
        "is_question": False,
        "gap_before": 0.0,
        "suspect": False,
        "words": (),
    }
    fields.update(changes)
    return SentenceUnit(**fields)


def test_sentence_unit_validation():
    assert _unit(unit_id="S10000", index=9999).unit_id == "S10000"
    for changes in [
        {"unit_id": "S1"},
        {"unit_id": "S0002"},
        {"unit_id": "X0001"},
        {"index": -1, "unit_id": "S0000"},
        {"index": True},
        {"start": 2.0},
        {"end": float("inf")},
        {"text": " "},
        {"segment_start": 2},
        {"segment_start": -1},
        {"word_count": 0},
        {"is_question": 1},
        {"suspect": None},
        {"gap_before": -0.1},
        {"words": [TranscriptWord(0.0, 1.0, "Halo")]},
    ]:
        with pytest.raises((TypeError, ValueError)):
            _unit(**changes)


def test_held_word_is_a_split_cue_in_word_mode():
    segment = worded(" ".join(_numbered(40)))[0]
    words = list(segment.words)
    held = words[11]
    words[11] = TranscriptWord(held.start, held.start + 1.2, held.text, held.probability)
    for position in range(12, len(words)):
        word = words[position]
        words[position] = TranscriptWord(word.start + 0.95, word.end + 0.95, word.text, 0.9)
    stretched = TranscriptSegment(words[0].start, words[-1].end, segment.text, tuple(words))

    units = build_sentence_units([stretched])

    assert [unit.word_count for unit in units] == [12, 28]
