import json
from pathlib import Path

import pytest

from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.transcript_quality import (
    QUALITY_VERSION,
    TranscriptQuality,
    assess_transcript,
    is_warning_code,
    write_transcript_quality_json,
)


def _timeline(texts_by_block: list[list[str]], *, block: float = 300.0, step: float = 2.0):
    """Segments laid out block by block, each block filled from its own text list."""
    segments = []
    for number, texts in enumerate(texts_by_block):
        start = number * block
        for offset, text in enumerate(texts):
            segments.append(
                TranscriptSegment(start + offset * step, start + offset * step + step - 0.5, text)
            )
    return segments


def _distinct(prefix: str, count: int, *, end: str = "") -> list[str]:
    return [f"{prefix} kalimat nomor {index} beda{end}" for index in range(count)]


def test_detects_punctuation_collapse_and_merges_adjacent_blocks():
    segments = _timeline(
        [
            _distinct("awal", 20, end="."),
            _distinct("tengah", 20),
            _distinct("lanjut", 20, end=".")[:2] + _distinct("lanjut", 18),
            _distinct("akhir", 20, end="?"),
        ]
    )

    quality = assess_transcript(segments)

    assert "punctuation_collapse:300-900" in quality.warnings
    assert [block[:2] for block in quality.punctuation_blocks] == [
        (0.0, 300.0),
        (300.0, 600.0),
        (600.0, 900.0),
        (900.0, 939.5),
    ]
    assert [round(block[2], 2) for block in quality.punctuation_blocks] == [1.0, 0.0, 0.1, 1.0]
    assert quality.punctuated_ratio == pytest.approx(42 / 80)
    assert not quality.suspect_segment_indices


def test_no_collapse_warning_without_a_well_punctuated_block():
    segments = _timeline(
        [_distinct("a", 20), _distinct("b", 20, end=".")[:10] + _distinct("b", 10)]
    )

    quality = assess_transcript(segments)

    assert not any(code.startswith("punctuation_collapse") for code in quality.warnings)


def test_whole_file_without_punctuation_gets_a_file_level_warning():
    # A fully collapsed file has no good block, so the collapse rule alone stays silent.
    segments = _timeline([_distinct("a", 20), _distinct("b", 20)])

    quality = assess_transcript(segments)

    assert quality.punctuated_ratio == 0.0
    assert quality.warnings == ("no_word_timestamps", "no_punctuation")


def test_no_punctuation_needs_twenty_segments_and_a_ratio_below_point_two():
    def run(texts: list[str]) -> tuple[str, ...]:
        segments = [TranscriptSegment(i, i + 0.5, text) for i, text in enumerate(texts)]
        return assess_transcript(segments).warnings

    assert "no_punctuation" not in run(_distinct("sedikit", 19))
    texts = _distinct("pas", 20)
    one_in_five = [text + ("." if index % 5 == 0 else "") for index, text in enumerate(texts)]
    assert "no_punctuation" not in run(one_in_five)  # exactly 0.2 is not below 0.2
    one_in_five[0] = one_in_five[0].rstrip(".")
    assert "no_punctuation" in run(one_in_five)


def test_no_punctuation_coexists_with_collapse_and_keeps_file_level_order():
    segments = _timeline(
        [_distinct("awal", 20, end=".")] + [_distinct(f"blok{n}", 20) for n in range(5)]
    )
    segments = [
        TranscriptSegment(segment.start, segment.start + 2.0, segment.text) for segment in segments
    ]

    quality = assess_transcript(segments)

    assert quality.punctuated_ratio == pytest.approx(20 / 120, abs=1e-4)
    assert quality.warnings == (
        "no_word_timestamps",
        "quantized_timestamps",
        "no_punctuation",
        "punctuation_collapse:300-1540",
    )


def test_no_punctuation_is_a_documented_code():
    assert is_warning_code("no_punctuation")
    assert not is_warning_code("no_punctuation:1")


def test_terminal_punctuation_ignores_closing_quotes_and_counts_fullwidth_marks():
    segments = [
        TranscriptSegment(0, 1, 'Dia bilang "udah."'),
        TranscriptSegment(1, 2, "Beneran？"),
        TranscriptSegment(2, 3, "terus,"),
        TranscriptSegment(3, 4, "Gila!)"),
    ]

    assert assess_transcript(segments).punctuated_ratio == 0.75


def test_detects_identical_segment_loops():
    texts = (
        ["Kita mau tiga hari."] + ["Ya, tiga hari."] * 5 + ["Jadi gitu.", "Iya.", "Iya.", "Iya."]
    )
    segments = [TranscriptSegment(index, index + 1.0, text) for index, text in enumerate(texts)]

    quality = assess_transcript(segments)

    assert "repetition_loop:1-5" in quality.warnings
    assert not any(code.startswith("repetition_loop:7") for code in quality.warnings)
    assert quality.suspect_segment_indices == (1, 2, 3, 4, 5)


def test_detects_back_to_back_phrase_repetition_inside_and_across_segments():
    segments = [
        TranscriptSegment(0, 1, "Oke kita mulai."),
        TranscriptSegment(1, 5, "ya tiga hari ya tiga hari ya tiga hari ya tiga hari"),
        TranscriptSegment(5, 6, "Nah gitu."),
        TranscriptSegment(6, 7, "gue mau pulang gue mau"),
        TranscriptSegment(7, 8, "pulang gue mau pulang gue mau pulang"),
        TranscriptSegment(8, 9, "Selesai."),
    ]

    quality = assess_transcript(segments)

    assert "repetition_loop:1-1" in quality.warnings
    assert "repetition_loop:3-4" in quality.warnings
    assert quality.suspect_segment_indices == (1, 3, 4)


def test_short_natural_repetition_and_laughter_are_not_loops():
    segments = [
        TranscriptSegment(0, 1, "iya iya iya iya iya bener"),
        TranscriptSegment(1, 2, "ya tiga hari ya tiga hari ya tiga hari"),
        TranscriptSegment(2, 3, "hahaha hahaha hahaha hahaha hahaha hahaha hahaha"),
        TranscriptSegment(3, 4, "Hahaha."),
        TranscriptSegment(4, 5, "Hahaha."),
        TranscriptSegment(5, 6, "Hahaha."),
        TranscriptSegment(6, 7, "Hahaha."),
    ]

    quality = assess_transcript(segments)

    assert not any(code.startswith("repetition_loop") for code in quality.warnings)


def test_single_word_repeated_six_times_is_a_loop():
    segments = [TranscriptSegment(0, 3, "iya iya iya iya iya iya")]

    assert "repetition_loop:0-0" in assess_transcript(segments).warnings


@pytest.mark.parametrize(
    "text",
    ["森knya dip vibunics", "ga tuh 나는", "ありがとう", "привет bang", "الحمد لله", "สวัสดี"],
)
def test_detects_foreign_script_for_latin_languages(text: str):
    segments = [TranscriptSegment(0, 1, "Halo."), TranscriptSegment(1, 2, text)]

    quality = assess_transcript(segments, language="id")

    assert "script_mismatch:1" in quality.warnings
    assert quality.suspect_segment_indices == (1,)


def test_script_check_allows_latin_diacritics_and_skips_non_latin_languages():
    segments = [TranscriptSegment(0, 1, "Café résumé señor. “Oke” — naïve…")]
    assert not assess_transcript(segments, language="id").warnings[1:]
    assert "script_mismatch:0" not in assess_transcript(segments, language="en-US").warnings
    cjk = [TranscriptSegment(0, 1, "大丈夫です")]
    assert "script_mismatch:0" not in assess_transcript(cjk, language="ja").warnings
    assert "script_mismatch:0" in assess_transcript(cjk, language="ID").warnings


def _worded(start: float, probabilities: list[float | None]) -> TranscriptSegment:
    words = tuple(
        TranscriptWord(
            start + index * 0.3, start + index * 0.3 + 0.25, f"k{start:g}x{index}", probability
        )
        for index, probability in enumerate(probabilities)
    )
    text = " ".join(word.text for word in words)
    return TranscriptSegment(start, start + len(words) * 0.3, text, words)


def test_low_confidence_needs_three_scored_words():
    segments = [
        _worded(0.0, [0.9, 0.95, 0.9]),
        _worded(2.0, [0.1, 0.2, 0.3, 0.4]),
        _worded(4.0, [0.1, 0.1, None, None]),
    ]

    quality = assess_transcript(segments)

    assert quality.has_word_timestamps is True
    assert "no_word_timestamps" not in quality.warnings
    assert "low_confidence:1" in quality.warnings
    assert "low_confidence:2" not in quality.warnings
    assert quality.suspect_segment_indices == (1,)


def test_quantized_segment_durations_and_missing_words_are_reported():
    segments = [
        TranscriptSegment(index * 2.13, index * 2.13 + 2.0, f"kata {index}.") for index in range(9)
    ]
    segments.append(TranscriptSegment(30.0, 31.37, "kata akhir."))

    quality = assess_transcript(segments)

    assert quality.integer_duration_ratio == pytest.approx(0.9)
    assert quality.warnings[:2] == ("no_word_timestamps", "quantized_timestamps")
    assert quality.has_word_timestamps is False


def test_few_segments_are_not_called_quantized():
    segments = [TranscriptSegment(0, 1, "Halo."), TranscriptSegment(1, 2, "Iya.")]

    assert "quantized_timestamps" not in assess_transcript(segments).warnings


def test_segments_without_letters_are_suspect_without_a_warning_code():
    segments = [TranscriptSegment(0, 1, "Halo."), TranscriptSegment(1, 2, "♪ ... ♪")]

    quality = assess_transcript(segments)

    assert quality.suspect_segment_indices == (1,)
    assert quality.warnings == ("no_word_timestamps",)


def test_empty_transcript_is_neutral():
    quality = assess_transcript([])

    assert quality.punctuated_ratio == 0.0
    assert quality.punctuation_blocks == ()
    assert quality.warnings == ("no_word_timestamps",)


def test_rejects_non_segments_and_bad_language():
    with pytest.raises(TypeError):
        assess_transcript(["Halo"])
    with pytest.raises(ValueError):
        assess_transcript([], language="")


def test_warning_order_is_stable():
    segments = [
        TranscriptSegment(0, 0.7, "森"),
        TranscriptSegment(1, 1.7, "Ya."),
        TranscriptSegment(2, 2.7, "Ya."),
        TranscriptSegment(3, 3.7, "Ya."),
        TranscriptSegment(4, 4.7, "Ya."),
    ]

    assert assess_transcript(segments).warnings == (
        "no_word_timestamps",
        "script_mismatch:0",
        "repetition_loop:1-4",
    )


def test_quality_validates_its_fields():
    good = {
        "punctuated_ratio": 0.5,
        "punctuation_blocks": ((0.0, 300.0, 0.5),),
        "integer_duration_ratio": 0.1,
        "has_word_timestamps": True,
        "suspect_segment_indices": (1, 4),
        "warnings": ("repetition_loop:1-4",),
    }
    TranscriptQuality(**good)
    for field, value in [
        ("punctuated_ratio", 1.5),
        ("punctuated_ratio", float("nan")),
        ("integer_duration_ratio", -0.1),
        ("punctuation_blocks", [(0.0, 300.0, 0.5)]),
        ("punctuation_blocks", ((300.0, 0.0, 0.5),)),
        ("punctuation_blocks", ((0.0, 300.0, 2.0),)),
        ("has_word_timestamps", 1),
        ("suspect_segment_indices", (4, 1)),
        ("suspect_segment_indices", (1, 1)),
        ("suspect_segment_indices", (-1,)),
        ("warnings", ["x"]),
        ("warnings", ("",)),
    ]:
        with pytest.raises((TypeError, ValueError)):
            TranscriptQuality(**{**good, field: value})


def test_quality_artifact_round_trip(tmp_path: Path):
    segments = [TranscriptSegment(0, 1, "森"), TranscriptSegment(1, 2.5, "Halo.")]
    quality = assess_transcript(segments)
    path = tmp_path / "analysis" / "transcript-quality.json"

    write_transcript_quality_json(path, quality)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == QUALITY_VERSION
    assert payload["warnings"] == list(quality.warnings)
    assert payload["punctuation_blocks"] == [{"start": 0.0, "end": 2.5, "ratio": 0.5}]
    assert TranscriptQuality.from_dict(payload) == quality
    assert quality.to_dict() == payload


def test_loop_must_dominate_a_segment_and_reduplication_is_one_token():
    segments = [
        TranscriptSegment(0, 5, "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh"),
        TranscriptSegment(
            5,
            12,
            "itu tangan gua tuh bergerak terus, bergerak terus, bergerak terus, bergerak terus "
            "sampai akhirnya selesai juga",
        ),
        TranscriptSegment(12, 15, "karena gara-gara gara gara-gara gara-gara konten sensitif"),
        TranscriptSegment(15, 18, "terus iya iya iya iya iya iya"),
    ]

    quality = assess_transcript(segments)

    assert [code for code in quality.warnings if code.startswith("repetition")] == [
        "repetition_loop:3-3"
    ]
    assert quality.suspect_segment_indices == (3,)
