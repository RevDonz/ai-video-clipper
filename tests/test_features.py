import math
from dataclasses import fields

import pytest

from ai_clipper.candidates import BoundaryCandidate
from ai_clipper.features import FeatureEvidence, FeatureExtractionResult, extract_features
from ai_clipper.models import CandidateFeatures


def candidate(
    text: str,
    *,
    start_kinds: tuple[str, ...] = ("segment",),
    end_kinds: tuple[str, ...] = ("segment",),
) -> BoundaryCandidate:
    return BoundaryCandidate(1, 3, 10.0, 40.0, text, start_kinds, end_kinds)


def tags(result: FeatureExtractionResult) -> set[str]:
    return {evidence.tag for evidence in result.evidence}


@pytest.mark.parametrize(
    "text",
    [
        "“Kenapa biaya cloud membengkak?” Karena server idle tetap berjalan.",
        "Mau tahu caranya？） Matikan server idle setiap malam.",
    ],
)
def test_direct_questions_with_quoted_unicode_punctuation_raise_hook_strength(text: str):
    result = extract_features(candidate(text))

    assert result.features.hook_strength >= 6.0
    assert "hook.direct_question" in tags(result)


@pytest.mark.parametrize(
    "text",
    [
        "Orang jangan terlalu baik. Batas sehat mencegah kelelahan.",
        "Bukan harga yang menjadi masalah, justru distribusi. Distribusi menentukan akses.",
    ],
)
def test_explicit_contradiction_or_bold_claim_is_hook_evidence(text: str):
    result = extract_features(candidate(text))

    assert result.features.hook_strength >= 6.0
    assert "hook.bold_claim" in tags(result)


@pytest.mark.parametrize(
    "text",
    [
        "Menurut dokter Andi, 73 persen pasien membaik. Data itu dicatat selama sebulan.",
        "Dokter Andi melaporkan 73 persen pasien membaik. Data itu dicatat selama sebulan.",
    ],
)
def test_attributed_numeric_claim_records_literal_role_and_number(text: str):
    result = extract_features(candidate(text))
    evidence = next(item for item in result.evidence if item.tag == "hook.attributed_numeric_claim")

    assert result.features.hook_strength == 5.5
    assert "dokter" in evidence.reason.casefold()
    assert "73 persen" in evidence.reason.casefold()
    assert "credible" not in evidence.reason.casefold()
    assert "proof" not in evidence.reason.casefold()


@pytest.mark.parametrize(
    "text",
    [
        "Menurut Dr. Andi, 73 persen pasien membaik. Data dicatat selama sebulan.",
        "Dr. Andi melaporkan 73 persen pasien membaik. Data dicatat selama sebulan.",
        "Menurut PROF. Sari, 73 persen peserta membaik. Data dicatat selama sebulan.",
    ],
)
def test_title_abbreviation_period_stays_inside_numeric_hook(text: str):
    result = extract_features(candidate(text))
    evidence = next(item for item in result.evidence if item.tag == "hook.attributed_numeric_claim")

    assert "73 persen" in evidence.reason.casefold()
    assert evidence.reason.casefold().count("dr") + evidence.reason.casefold().count("prof") >= 1


def test_title_abbreviation_period_does_not_hide_later_question_mark():
    result = extract_features(candidate("Dr. Andi, kenapa biaya cloud naik? Audit segera dimulai."))

    assert "hook.direct_question" in tags(result)
    assert "hook.pain_point" in tags(result)


@pytest.mark.parametrize("number", ["73.5", "73,5"])
def test_decimal_point_or_comma_stays_inside_attributed_numeric_hook(number: str):
    result = extract_features(
        candidate(f"Menurut Dr. Andi, {number} persen pasien membaik. Faktanya dicatat terpisah.")
    )
    evidence = next(item for item in result.evidence if item.tag == "hook.attributed_numeric_claim")

    assert f"{number} persen" in evidence.reason
    assert "hook.bold_claim" not in tags(result)


@pytest.mark.parametrize(
    "text",
    [
        "Sebanyak 73 persen peserta membaik. Hasilnya tercatat.",
        "Dokter Andi menghadiri rapat. Hasilnya tercatat.",
        "Dokter Andi hadir dan ruangan punya 73 kursi. Rapat lalu dimulai.",
    ],
)
def test_numeric_claim_requires_local_explicit_role_attribution(text: str):
    result = extract_features(candidate(text))

    assert "hook.attributed_numeric_claim" not in tags(result)
    assert result.features.hook_strength == 3.0
    assert all("credible" not in reason.casefold() for reason in result.reasons)
    assert all("proof" not in reason.casefold() for reason in result.reasons)


def test_pain_point_raises_hook_strength_without_open_loop_evidence():
    result = extract_features(
        candidate("Sulit mendapatkan pelanggan. Pesan produk sering tidak jelas.")
    )

    assert "hook.pain_point" in tags(result)
    assert "hook.open_loop" not in tags(result)
    assert result.features.hook_strength == 5.0


def test_open_loop_in_first_hook_sentence_raises_hook_strength():
    result = extract_features(
        candidate("Ada tiga alasan pelanggan pergi. Alasan pertama adalah pesan yang kabur.")
    )

    assert "hook.open_loop" in tags(result)
    assert "hook.pain_point" not in tags(result)
    assert result.features.hook_strength == 5.0


def test_open_loop_phrase_only_in_body_does_not_raise_hook_strength():
    result = extract_features(
        candidate("Pelanggan terus pergi. Ada tiga alasan pelanggan memilih produk lain.")
    )

    assert "hook.open_loop" not in tags(result)
    assert "hook.pain_point" not in tags(result)
    assert result.features.hook_strength == 3.0


def test_hook_relevance_requires_meaningful_hook_body_overlap():
    relevant = extract_features(
        candidate("Kenapa biaya cloud membengkak? Jawabannya, server cloud idle tetap ditagih.")
    )
    unrelated = extract_features(
        candidate("Kenapa biaya cloud membengkak? Jawabannya, resep rendang memakai santan.")
    )

    assert "relevance.topic_overlap" in tags(relevant)
    assert "relevance.topic_overlap" not in tags(unrelated)
    assert relevant.features.hook_relevance > unrelated.features.hook_relevance


def test_english_function_words_do_not_create_unrelated_topic_overlap():
    result = extract_features(candidate("How can cameras focus? How can taxes rise."))

    assert "relevance.topic_overlap" not in tags(result)


def test_substantive_topical_answer_marker_completes_payoff():
    complete = extract_features(
        candidate(
            "Mau tahu cara mengurangi biaya cloud? Jawabannya: matikan server cloud untuk kurangi biaya malam."
        )
    )
    unresolved = extract_features(
        candidate("Mau tahu cara mengurangi biaya cloud? Ada tiga alasan...")
    )

    assert {"payoff.answer_marker", "payoff.complete_answer"} <= tags(complete)
    assert "relevance.answer_resolution" in tags(complete)
    assert complete.features.payoff_completeness > unresolved.features.payoff_completeness


def test_length_changing_casefold_before_answer_marker_preserves_answer_slice():
    result = extract_features(
        candidate(
            "Why do cloud costs rise? ẞ The answer is: reduce cloud costs using budget controls."
        )
    )

    assert {
        "payoff.answer_marker",
        "payoff.complete_answer",
        "relevance.answer_resolution",
    } <= tags(result)


def test_bare_answer_marker_has_no_success_evidence_or_score_benefit():
    result = extract_features(candidate("Kenapa biaya cloud naik? Jawabannya."))

    assert "payoff.answer_marker" not in tags(result)
    assert "payoff.complete_answer" not in tags(result)
    assert "relevance.answer_resolution" not in tags(result)
    assert result.features.payoff_completeness == 3.0


def test_low_information_post_marker_is_not_a_complete_payoff():
    result = extract_features(
        candidate("Kenapa biaya cloud naik? Karena mungkin entahlah pokoknya begitu.")
    )

    assert "payoff.answer_marker" not in tags(result)
    assert "payoff.complete_answer" not in tags(result)
    assert "relevance.answer_resolution" not in tags(result)
    assert result.features.payoff_completeness == 3.0


@pytest.mark.parametrize(
    "post_marker",
    [
        "biaya banget deh dong.",
        "biaya blabla wkwkwk asdf.",
        "cloud haha haha qwerty.",
        "matikan biaya nih sih gitu banget deh.",
        "matikan biaya flarble zort quux.",
    ],
)
def test_filler_or_gibberish_post_marker_is_not_substantive(post_marker: str):
    result = extract_features(candidate(f"Kenapa biaya cloud naik? Jawabannya: {post_marker}"))

    assert "payoff.complete_answer" not in tags(result)
    assert "relevance.answer_resolution" not in tags(result)
    assert result.features.payoff_completeness < 9.0


@pytest.mark.parametrize(
    ("text", "predicate"),
    [
        (
            "Kenapa biaya cloud naik? Jawabannya: matikan server cloud untuk kurangi biaya malam.",
            "matikan",
        ),
        (
            "Bagaimana mengurangi tagihan cloud? Solusinya: audit tagihan cloud lalu kurangi kapasitas idle.",
            "audit",
        ),
        (
            "Why do cloud costs rise? Because idle cloud servers cause cloud costs to increase.",
            "cause",
        ),
    ],
)
def test_complete_payoff_requires_and_reports_lexical_answer_predicate(text: str, predicate: str):
    result = extract_features(candidate(text))
    marker_evidence = next(item for item in result.evidence if item.tag == "payoff.answer_marker")

    assert "payoff.complete_answer" in tags(result)
    assert predicate in marker_evidence.reason.casefold()
    assert "istilah substantif" in marker_evidence.reason.casefold()


@pytest.mark.parametrize(
    "predicate",
    [
        "nonaktifkan",
        "menonaktifkan",
        "matikan",
        "mematikan",
        "optimalkan",
        "mengoptimalkan",
        "gunakan",
        "menggunakan",
        "lakukan",
        "melakukan",
        "kurangi",
        "mengurangi",
        "tambahkan",
        "menambahkan",
        "periksa",
        "memeriksa",
        "hindari",
        "menghindari",
        "pilih",
        "memilih",
        "menyebabkan",
        "membuat",
        "terjadi",
        "naik",
        "turun",
    ],
)
def test_indonesian_predicate_morphology_completes_two_topic_term_payoff(predicate: str):
    result = extract_features(
        candidate(
            f"Kenapa biaya cloud bermasalah? Jawabannya: {predicate} cloud agar biaya terkendali."
        )
    )

    assert "payoff.complete_answer" in tags(result)
    assert "relevance.answer_resolution" in tags(result)
    marker_evidence = next(item for item in result.evidence if item.tag == "payoff.answer_marker")
    assert predicate in marker_evidence.reason.casefold()


@pytest.mark.parametrize(
    "predicate",
    [
        "disable",
        "shut down",
        "turn off",
        "use",
        "reduce",
        "check",
        "avoid",
        "choose",
        "causes",
        "makes",
        "increase",
        "decrease",
    ],
)
def test_english_predicate_patterns_complete_two_topic_term_payoff(predicate: str):
    result = extract_features(
        candidate(
            f"Why are cloud costs unstable? The answer is: {predicate} cloud resources so costs stabilize."
        )
    )

    assert "payoff.complete_answer" in tags(result)
    assert "relevance.answer_resolution" in tags(result)
    marker_evidence = next(item for item in result.evidence if item.tag == "payoff.answer_marker")
    assert predicate in marker_evidence.reason.casefold()


def test_generic_predicate_overlap_does_not_resolve_hook():
    result = extract_features(
        candidate("Kenapa resep rendang naik? Jawabannya: biaya santan naik setiap pekan.")
    )

    assert "payoff.complete_answer" not in tags(result)
    assert "relevance.answer_resolution" not in tags(result)


def test_complete_payoff_reason_reports_literal_overlap_count_terms_and_terminal():
    result = extract_features(
        candidate("Kenapa biaya cloud bermasalah? Jawabannya: matikan cloud agar biaya terkendali.")
    )
    evidence = next(item for item in result.evidence if item.tag == "payoff.complete_answer")

    reason = evidence.reason.casefold()
    assert "2" in reason
    assert "biaya" in reason
    assert "cloud" in reason
    assert "terminal" in reason
    assert "gibberish" not in reason


def test_post_marker_terms_without_answer_predicate_do_not_complete_payoff():
    result = extract_features(
        candidate("Kenapa biaya cloud naik? Jawabannya: biaya cloud server kapasitas malam.")
    )

    assert "payoff.answer_marker" not in tags(result)
    assert "payoff.complete_answer" not in tags(result)
    assert "relevance.answer_resolution" not in tags(result)


@pytest.mark.parametrize(
    "text",
    [
        "Kenapa biaya cloud naik? Jawabannya: server cloud idle terus ditagih",
        "Kenapa biaya cloud naik? Jawabannya: resep rendang memakai santan kelapa.",
    ],
)
def test_complete_payoff_requires_terminal_punctuation_and_topical_overlap(text: str):
    result = extract_features(candidate(text))

    assert "payoff.complete_answer" not in tags(result)
    assert "relevance.answer_resolution" not in tags(result)


def test_pronoun_led_opening_lowers_standalone_context_and_adds_penalty():
    missing = extract_features(
        candidate("Nah itu sebabnya dia gagal. Solusinya adalah audit mingguan.")
    )
    standalone = extract_features(
        candidate(
            "Audit biaya cloud gagal karena tag tidak lengkap. Solusinya adalah audit mingguan."
        )
    )

    context_evidence = next(item for item in missing.evidence if item.tag == "context.pronoun_led")
    penalty_evidence = next(
        item for item in missing.evidence if item.tag == "context.pronoun_led_penalty"
    )
    assert missing.features.standalone_context < standalone.features.standalone_context
    assert missing.features.penalty > standalone.features.penalty
    assert "nah itu sebabnya" in context_evidence.reason.casefold()
    assert "tanpa anteseden" not in context_evidence.reason.casefold()
    assert penalty_evidence.dimension == "penalty"
    assert penalty_evidence.impact == "negative"
    assert "nah itu sebabnya" in penalty_evidence.reason.casefold()
    assert "2.5" in penalty_evidence.reason


@pytest.mark.parametrize(
    "text",
    [
        "Ini tiga alasan biaya cloud naik. Server idle adalah alasan pertama.",
        "Ini cara audit biaya cloud. Periksa semua server idle.",
        "Ini masalah utama tagihan cloud. Kapasitas idle tetap aktif.",
        "Ini alasan biaya cloud naik. Server idle tetap aktif.",
    ],
)
def test_self_contained_demonstrative_noun_or_list_opening_is_not_penalized(text: str):
    result = extract_features(candidate(text))

    assert "context.pronoun_led" not in tags(result)
    assert result.features.standalone_context == 7.0


def test_only_ini_gets_self_contained_demonstrative_noun_exemption():
    self_contained = extract_features(candidate("Ini cara audit biaya cloud. Periksa server idle."))
    anaphoric = extract_features(candidate("Itu cara audit biaya cloud. Periksa server idle."))

    assert "context.pronoun_led" not in tags(self_contained)
    assert "context.pronoun_led" in tags(anaphoric)
    assert self_contained.features.standalone_context == 7.0
    assert anaphoric.features.standalone_context == 3.0


@pytest.mark.parametrize(
    "text",
    [
        "Ini sebabnya biaya cloud naik. Server idle tetap aktif.",
        "Itu sebabnya biaya cloud naik. Server idle tetap aktif.",
        "Dia mengubah konfigurasi. Biaya cloud kemudian naik.",
    ],
)
def test_genuinely_anaphoric_demonstrative_or_pronoun_opening_is_penalized(text: str):
    result = extract_features(candidate(text))

    assert "context.pronoun_led" in tags(result)
    assert result.features.standalone_context == 3.0


@pytest.mark.parametrize(
    "text",
    [
        "Makanya biaya itu naik. Audit menemukan server idle.",
        "“Jadi itu sebabnya biaya naik.” Audit menemukan server idle.",
        "‘Itulah sebabnya biaya naik.’ Audit menemukan server idle.",
        "Jadi, itu sebabnya biaya naik. Audit menemukan server idle.",
        "Nah, itu sebabnya biaya naik. Audit menemukan server idle.",
        "  “Jadi,   itu sebabnya biaya naik.” Audit menemukan server idle.",
        "‘Nah, itu sebabnya biaya naik.’ Audit menemukan server idle.",
    ],
)
def test_anaphoric_missing_context_variants_are_penalized(text: str):
    result = extract_features(candidate(text))

    assert "context.pronoun_led" in tags(result)
    assert result.features.standalone_context == 3.0


@pytest.mark.parametrize(
    "text",
    [
        "Jadi audit cloud dimulai hari ini. Tim memeriksa semua server.",
        "Jadi biaya cloud turun setelah audit. Tim mematikan server idle.",
    ],
)
def test_normal_standalone_jadi_opening_is_not_missing_context(text: str):
    result = extract_features(candidate(text))

    assert "context.pronoun_led" not in tags(result)
    assert result.features.standalone_context == 7.0


@pytest.mark.parametrize(
    ("text", "expected_tag"),
    [
        ("Halo semuanya, selamat datang. Hari ini kita membahas pajak.", "penalty.intro"),
        ("Terima kasih sudah menonton, sampai jumpa.", "penalty.outro"),
        (
            "Video ini disponsori oleh Acme. Setelah itu kita membahas pajak.",
            "penalty.sponsor_first",
        ),
    ],
)
def test_intro_outro_and_sponsor_first_create_only_present_penalty_evidence(
    text: str, expected_tag: str
):
    result = extract_features(candidate(text))

    penalty_tags = {evidence.tag for evidence in result.evidence if evidence.dimension == "penalty"}
    assert penalty_tags == {expected_tag}
    assert result.features.penalty > 0.0


@pytest.mark.parametrize(
    ("text", "expected_tag"),
    [
        ("“Halo semuanya, selamat datang.” Hari ini kita membahas pajak.", "penalty.intro"),
        (
            "‘Video ini disponsori oleh Acme.’ Setelah itu kita membahas pajak.",
            "penalty.sponsor_first",
        ),
    ],
)
def test_quoted_intro_and_sponsor_first_are_penalized(text: str, expected_tag: str):
    result = extract_features(candidate(text))

    assert expected_tag in tags(result)
    assert result.features.penalty > 0.0


def test_repetition_and_filler_reduce_information_density_with_evidence():
    dense = extract_features(
        candidate(
            "Audit cloud menemukan 18 server idle. Tim mematikannya dan biaya turun 32 persen."
        )
    )
    repetitive = extract_features(
        candidate("Jadi ya jadi ya server itu itu server, gitu, jadi ya server itu.")
    )

    assert "density.repetition_filler" in tags(repetitive)
    assert repetitive.features.information_density < dense.features.information_density
    assert repetitive.features.penalty > dense.features.penalty
    penalty_evidence = next(
        item for item in repetitive.evidence if item.tag == "density.repetition_filler_penalty"
    )
    assert penalty_evidence.dimension == "penalty"
    assert penalty_evidence.impact == "negative"
    assert "filler=4" in penalty_evidence.reason.casefold()
    assert "2.0" in penalty_evidence.reason


def test_structured_start_independently_raises_boundary_quality():
    result = extract_features(
        candidate(
            "Biaya cloud turun setelah server idle dimatikan",
            start_kinds=("segment", "pause"),
        )
    )

    assert tags(result) & {
        "boundary.structured_start",
        "boundary.structured_end",
        "boundary.terminal",
    } == {"boundary.structured_start"}
    assert result.features.boundary_quality == 5.0


def test_structured_end_independently_raises_boundary_quality():
    result = extract_features(
        candidate(
            "Biaya cloud turun setelah server idle dimatikan",
            end_kinds=("segment", "topic-shift"),
        )
    )

    assert tags(result) & {
        "boundary.structured_start",
        "boundary.structured_end",
        "boundary.terminal",
    } == {"boundary.structured_end"}
    assert result.features.boundary_quality == 5.0


def test_terminal_punctuation_independently_raises_boundary_quality():
    result = extract_features(candidate("Biaya cloud turun setelah server idle dimatikan."))

    assert tags(result) & {
        "boundary.structured_start",
        "boundary.structured_end",
        "boundary.terminal",
    } == {"boundary.terminal"}
    assert result.features.boundary_quality == 5.0


def test_topic_terms_are_filtered_unique_and_stable_in_first_seen_order():
    result = extract_features(
        candidate(
            "Kamera yang tajam dan lensa kamera untuk potret. Cloud and server cloud latency."
        )
    )

    assert result.topic_terms == (
        "kamera",
        "tajam",
        "lensa",
        "potret",
        "cloud",
        "server",
        "latency",
    )
    assert all(result.topic_terms)
    assert "topic.extracted_terms" in tags(result)
    assert result.features.topic_value > 5.0


def test_text_only_multimodal_dimensions_use_documented_neutral_defaults():
    result = extract_features(
        candidate("Saya sangat marah! Alice menjawab Bob sambil kamera bergerak cepat.")
    )

    assert result.features.emotion_energy == 5.0
    assert result.features.dialogue_dynamics == 5.0
    assert result.features.visual_activity == 5.0
    assert not any(
        forbidden in evidence.tag
        for evidence in result.evidence
        for forbidden in ("emotion", "speaker", "visual")
    )


def test_result_is_typed_auditable_bounded_and_has_no_rank_or_global_score():
    result = extract_features(
        candidate("Kenapa pajak usaha naik? Jawabannya: omzet melewati batas.")
    )

    assert isinstance(result, FeatureExtractionResult)
    assert isinstance(result.features, CandidateFeatures)
    assert result.reasons == tuple(evidence.reason for evidence in result.evidence)
    assert result.evidence
    assert not hasattr(result, "score")
    assert not hasattr(result, "rank")
    for model_field in fields(result.features):
        value = getattr(result.features, model_field.name)
        assert math.isfinite(value)
        assert 0.0 <= value <= 10.0


def test_extract_features_strictly_rejects_wrong_candidate_type():
    with pytest.raises(TypeError, match="BoundaryCandidate"):
        extract_features(object())


def test_feature_evidence_rejects_unknown_tag():
    with pytest.raises(ValueError, match="unknown evidence tag"):
        FeatureEvidence("unknown.tag", "hook_strength", "positive", "Literal reason.")


def test_feature_evidence_rejects_wrong_dimension_for_known_tag():
    with pytest.raises(ValueError, match="dimension"):
        FeatureEvidence("hook.direct_question", "topic_value", "positive", "Literal reason.")


def test_feature_evidence_rejects_wrong_impact_for_known_tag():
    with pytest.raises(ValueError, match="impact"):
        FeatureEvidence("penalty.intro", "penalty", "positive", "Literal reason.")
