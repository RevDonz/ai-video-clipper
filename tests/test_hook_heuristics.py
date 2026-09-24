import itertools
import random
from dataclasses import dataclass

import pytest

from ai_clipper.audio_timeline import build_audio_timeline
from ai_clipper.hook_heuristics import (
    HEURISTIC_VERSION,
    _analyse_unit,
    _clean_line,
    propose_heuristic,
)
from ai_clipper.llm_selection import packaging_problem
from ai_clipper.selection_types import ARCHETYPES, SCORE_DIMENSIONS, ClipProposal
from ai_clipper.sentences import SentenceUnit, looks_like_question
from ai_clipper.sound_events import SoundEvent


@dataclass(frozen=True)
class L:
    """One synthetic unit: text, spoken length (default 0.4 s per word), gap before it."""

    text: str
    seconds: float | None = None
    gap: float = 0.2
    suspect: bool = False
    laugh: bool = False  # a laughter event right after this unit


def build(lines):
    """Build chronological SentenceUnits plus the laughter events the lines ask for."""
    units, events = [], []
    moment = 0.0
    previous_end = None
    for index, raw in enumerate(lines):
        line = raw if isinstance(raw, L) else L(raw)
        begin = 0.0 if previous_end is None else previous_end + line.gap
        end = begin + (line.seconds or max(0.8, 0.4 * len(line.text.split())))
        units.append(
            SentenceUnit(
                unit_id=f"S{index + 1:04d}",
                index=index,
                start=round(begin, 3),
                end=round(end, 3),
                text=line.text,
                segment_start=index,
                segment_end=index,
                word_count=len(line.text.split()),
                is_question=looks_like_question(line.text),
                gap_before=0.0 if previous_end is None else round(begin - previous_end, 3),
                suspect=line.suspect,
                words=(),
            )
        )
        if line.laugh:
            events.append(SoundEvent.from_label(round(end + 0.2, 3), "tertawa"))
        previous_end = end
        moment = end
    assert moment >= 0
    return units, tuple(events)


_SUBJECTS = ("Kru", "Tim kamera", "Produser", "Penata lampu", "Editor", "Operator suara")
_VERBS = ("menyiapkan", "merapikan", "mengecek", "memindahkan", "menyusun", "membersihkan")
_OBJECTS = ("kabel", "meja", "kursi", "lampu", "mikrofon", "karpet", "tirai")
_PLACES = ("ruang depan", "lorong", "gudang", "panggung kecil", "sudut studio")


def neutral(count, *, offset=0):
    """Distinct, lexicon-free statements with no questions and no clean hook."""
    lines = []
    combos = itertools.islice(
        itertools.product(_SUBJECTS, _VERBS, _OBJECTS, _PLACES), offset, offset + count
    )
    for subject, verb, obj, place in combos:
        lines.append(L(f"{subject} {verb} {obj} di {place} sebelum rekaman berjalan lancar."))
    return lines


def qa_moment(question="Kenapa lu akhirnya berhenti nyopet di konser?", *, topic="copet"):
    """A host question answered by a long, hooky guest answer that ends on a laugh."""
    return [
        L(question, gap=0.8),
        L(f"Jujur gua pernah ketangkap polisi waktu {topic} di festival musik.", seconds=4.5),
        L(f"Ternyata yang nangkep gua itu korban {topic} gua sendiri tahun lalu.", seconds=4.5),
        L(f"Gua bukan jambret, tapi tetap aja rasanya malu banget soal {topic}.", seconds=4.5),
        L(f"Dia bilang ke gua jangan pernah balik lagi ke dunia {topic} itu.", seconds=4.5),
        L(f"Sejak itu gua insaf dan kerja jadi tukang parkir buat {topic} konser.", seconds=4.5),
        L("Akhirnya gua malah dikasih hadiah tiket nonton gratis sama dia.", laugh=True),
    ]


def kitchen_moment():
    """A moment with the same kinds of evidence as qa_moment() but different content words."""
    return [
        L("Gimana ceritanya lu bisa jadi koki di kapal pesiar?", gap=0.8),
        L("Jujur gua pernah dipecat dari restoran waktu magang di Bali.", seconds=4.5),
        L("Ternyata yang mecat gua itu chef terkenal dari Prancis.", seconds=4.5),
        L("Gua bukan koki jago, tapi tetap aja rasanya malu banget dipecat.", seconds=4.5),
        L("Dia bilang ke gua jangan pernah masak pakai perasaan doang.", seconds=4.5),
        L("Sejak itu gua belajar serius tiap malam sampai subuh di dapur.", seconds=4.5),
        L("Akhirnya gua malah jadi kepala dapur di kapal pesiar itu.", laugh=True),
    ]


def span(units, proposal):
    return units[proposal.start_unit].start, units[proposal.end_unit].end


def covers(units, proposal, index):
    return proposal.start_unit <= index <= proposal.end_unit


# --- contract ---------------------------------------------------------------------------------


def test_version_is_published():
    assert HEURISTIC_VERSION == "heuristic-v3.1"


def test_returns_valid_ranked_non_overlapping_heuristic_proposals():
    lines = neutral(12) + qa_moment() + neutral(12, offset=40)
    lines += qa_moment("Gimana rasanya pertama kali main film?", topic="film") + neutral(
        12, offset=80
    )
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=60, k=3, events=events)

    assert proposals
    assert len(proposals) <= 15
    assert all(isinstance(item, ClipProposal) for item in proposals)
    intervals = sorted((item.start_unit, item.end_unit) for item in proposals)
    for (_first_start, first_end), (second_start, _second_end) in itertools.pairwise(intervals):
        assert first_end < second_start
    scores = [item.score for item in proposals]
    assert scores == sorted(scores, reverse=True)
    for item in proposals:
        start, end = span(units, item)
        assert 20 <= end - start <= 60
        assert item.source == "heuristic"
        assert item.archetype in ARCHETYPES
        assert set(item.scores) == set(SCORE_DIMENSIONS)
        assert all(0 <= value <= 10 for value in item.scores.values())
        assert 0 <= item.score <= 10
        assert item.hook_text.strip() and len(item.hook_text) <= 60
        assert item.title.strip() and len(item.title) <= 100
        assert item.description.strip()
        assert 3 <= len(item.hashtags) <= 6
        assert all(tag.startswith("#") and tag[1:].isalnum() for tag in item.hashtags)
        assert 1 <= len(item.reasons) <= 8
        assert item.start_unit <= item.hook_unit <= item.end_unit
        assert item.payoff_unit is None or item.start_unit <= item.payoff_unit <= item.end_unit


def test_empty_or_too_short_transcripts_give_no_proposals():
    assert propose_heuristic([], min_duration=20, max_duration=60, k=5) == ()
    units, _ = build(neutral(3))
    assert propose_heuristic(units, min_duration=20, max_duration=60, k=5) == ()


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"min_duration": 0, "max_duration": 60, "k": 5}, ValueError),
        ({"min_duration": 30, "max_duration": 20, "k": 5}, ValueError),
        ({"min_duration": float("nan"), "max_duration": 60, "k": 5}, ValueError),
        ({"min_duration": "20", "max_duration": 60, "k": 5}, TypeError),
        ({"min_duration": 20, "max_duration": 60, "k": 0}, ValueError),
        ({"min_duration": 20, "max_duration": 60, "k": True}, TypeError),
        ({"min_duration": 20, "max_duration": 60, "k": 5, "events": ["tertawa"]}, TypeError),
        ({"min_duration": 20, "max_duration": 60, "k": 5, "audio": object()}, TypeError),
    ],
)
def test_invalid_arguments_are_rejected(kwargs, error):
    units, _ = build(neutral(30))
    with pytest.raises(error):
        propose_heuristic(units, **kwargs)


def test_units_must_be_positional_and_chronological():
    units, _ = build(neutral(30))
    with pytest.raises(ValueError):
        propose_heuristic(units[1:], min_duration=20, max_duration=60, k=5)
    swapped = list(units)
    swapped[3], swapped[4] = swapped[4], swapped[3]
    with pytest.raises(ValueError):
        propose_heuristic(swapped, min_duration=20, max_duration=60, k=5)
    with pytest.raises(TypeError):
        propose_heuristic(["not a unit"], min_duration=20, max_duration=60, k=5)


def test_proposal_count_is_capped_at_three_k_or_fifteen():
    lines = []
    for index in range(24):
        lines += neutral(4, offset=index * 7) + qa_moment(topic=f"kasus{index}")
    units, events = build(lines)

    few = propose_heuristic(units, min_duration=20, max_duration=45, k=2, events=events)
    many = propose_heuristic(units, min_duration=20, max_duration=45, k=6, events=events)

    assert len(few) == 15
    assert len(many) == 18
    assert [(item.start_unit, item.end_unit) for item in few] == [
        (item.start_unit, item.end_unit) for item in many[:15]
    ]


def test_output_is_deterministic_and_ignores_event_order():
    lines = neutral(10) + qa_moment() + neutral(10, offset=30) + qa_moment(topic="film")
    units, events = build(lines)
    extra = (SoundEvent.from_label(3.0, "tepuk tangan"),)
    shuffled = list(events + extra)
    random.Random(7).shuffle(shuffled)

    first = propose_heuristic(units, min_duration=20, max_duration=60, k=5, events=events + extra)
    second = propose_heuristic(units, min_duration=20, max_duration=60, k=5, events=shuffled)

    assert first == second


def test_every_proposal_respects_the_duration_bounds():
    lines = neutral(8) + qa_moment() + neutral(20, offset=20) + qa_moment(topic="konser")
    units, events = build(lines)
    for low, high in ((20, 30), (25, 60), (40, 90)):
        for item in propose_heuristic(
            units, min_duration=low, max_duration=high, k=5, events=events
        ):
            start, end = span(units, item)
            assert low <= end - start <= high


# --- starts -----------------------------------------------------------------------------------


def test_host_question_followed_by_a_long_answer_is_the_start():
    lines = neutral(15) + qa_moment() + neutral(15, offset=40)
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=20, max_duration=60, k=3, events=events)[0]

    assert best.start_unit == 15
    assert units[best.start_unit].is_question
    assert any("pertanyaan" in reason.casefold() for reason in best.reasons)


def test_a_very_short_question_starts_one_unit_earlier_at_its_tight_setup():
    answer = qa_moment()[1:]
    lines = (
        neutral(15)
        + [
            L("Gue denger lu keluar dari kantor lama lu minggu kemarin.", gap=0.9),
            L("Kenapa tuh?", gap=0.1),
            *answer,
        ]
        + neutral(15, offset=40)
    )
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=20, max_duration=60, k=3, events=events)[0]

    assert best.start_unit == 15


def test_story_opener_starts_a_clip_without_any_question():
    story = [
        L("Jadi gini, waktu itu gue pernah nyasar di hutan sendirian semalaman.", gap=0.9),
        L("Hape gue mati dan senter satu-satunya jatuh ke jurang.", seconds=4.0),
        L("Gue denger suara langkah kaki di belakang gue terus-terusan.", seconds=4.0),
        L("Setelah gue senterin, itu cuma kambing warga yang ikut nyasar.", 4.0, laugh=True),
        L("Makanya sekarang gue selalu bawa dua senter kalau naik gunung.", seconds=4.0),
    ]
    units, events = build(neutral(15) + story + neutral(15, offset=40))

    best = propose_heuristic(units, min_duration=15, max_duration=60, k=3, events=events)[0]

    assert best.start_unit == 15
    assert any("cerita" in reason.casefold() for reason in best.reasons)


# --- ends -------------------------------------------------------------------------------------


def test_end_lands_right_after_the_laughter():
    lines = (
        neutral(12)
        + [
            L("Kenapa lu dipecat dari kantor lama lu?", gap=0.8),
            L(
                "Jujur gua dipecat gara-gara ketiduran pas rapat sama direktur",
                seconds=5.0,
                gap=0.0,
            ),
            L(
                "dan direkturnya ternyata juga ketiduran di sebelah gua waktu itu",
                seconds=5.0,
                gap=0.0,
            ),
            L("terus kita berdua dibangunin sama office boy yang bawa kopi", seconds=5.0, gap=0.0),
            L(
                "dan office boy itu sekarang malah jadi bos gua di kantor baru",
                seconds=5.0,
                laugh=True,
            ),
            L("terus kita ngobrolin kerjaan yang lain di kantor itu", seconds=5.0, gap=0.0),
            L("dan kerjaannya lumayan banyak juga setiap minggu di sana", seconds=5.0, gap=0.0),
        ]
        + neutral(12, offset=40)
    )
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events)[0]

    assert best.start_unit == 12
    assert best.end_unit == 16
    assert best.payoff_unit == 16
    assert any("tawa" in reason.casefold() for reason in best.reasons)


def test_end_prefers_terminal_punctuation_followed_by_a_pause_over_mid_sentence():
    lines = (
        neutral(12)
        + [
            L("Kenapa lu pindah kerja ke luar negeri?", gap=0.8),
            L(
                "Soalnya gaji gua di sini dulu kecil banget dan cicilan numpuk",
                seconds=5.0,
                gap=0.0,
            ),
            L("terus gua coba daftar kerja di kapal pesiar lewat agen", seconds=5.0, gap=0.0),
            L("dan ternyata keterima cuma dalam waktu dua minggu saja.", seconds=5.0, gap=0.0),
            L("Terus gua berangkat dan kerja di dapur kapal itu", seconds=5.0, gap=1.2),
            L("sambil belajar masak dari koki yang galak banget", seconds=5.0, gap=0.0),
            L("dan kokinya itu", seconds=3.0, gap=0.0),
        ]
        + neutral(12, offset=40)
    )
    units, _ = build(lines)

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3)[0]

    assert best.start_unit == 12
    assert best.end_unit == 15


def test_end_prefers_a_recap_marker():
    lines = (
        neutral(12)
        + [
            L("Kenapa lu berhenti main saham?", gap=0.8),
            L("Soalnya gua rugi terus hampir tiap bulan waktu itu", seconds=5.0, gap=0.0),
            L("dan uang tabungan gua habis buat nutup kerugian", seconds=5.0, gap=0.0),
            L("sampai gua harus jual motor buat bayar kontrakan", seconds=5.0, gap=0.0),
            L("makanya sekarang gua cuma nabung emas tiap bulan aja", seconds=5.0, gap=0.0),
            L("Emasnya gua simpen di brankas kecil di rumah", seconds=5.0, gap=0.4),
            L("biar aman dari maling", seconds=3.0, gap=0.0),
        ]
        + neutral(12, offset=40)
    )
    units, _ = build(lines)

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3)[0]

    assert best.end_unit == 16


def test_clips_do_not_end_on_a_question_before_its_answer():
    lines = (
        neutral(12)
        + [
            L("Kenapa lu berhenti jadi pembalap liar?", gap=0.8),
            L("Jujur gua hampir mati waktu motor gua nabrak pembatas jalan.", seconds=5.0),
            L("Tulang kaki gua patah dan gua dirawat tiga bulan di rumah sakit.", seconds=5.0),
            L("Nyokap gua nangis tiap hari nungguin gua di rumah sakit.", seconds=5.0),
            L("Terus apa yang bikin lu yakin buat berhenti total?", seconds=4.0, gap=0.9),
            L("Pas gua liat nyokap gua tidur di lantai rumah sakit itu.", seconds=5.0, laugh=True),
        ]
        + neutral(12, offset=40)
    )
    units, events = build(lines)

    for item in propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events):
        if item.start_unit <= 16 <= item.end_unit:
            assert item.end_unit != 16


# --- penalties --------------------------------------------------------------------------------


def mostly_inside(proposal, first, last):
    inside = range(max(first, proposal.start_unit), min(last, proposal.end_unit) + 1)
    return len(inside) * 2 > proposal.end_unit - proposal.start_unit + 1


def _overlapping(units, proposals, first, last):
    return [item for item in proposals if item.start_unit <= last and first <= item.end_unit]


def test_sponsor_reads_rank_below_clean_moments():
    sponsored = qa_moment(topic="skincare")
    sponsored[3] = L("Pakai kode voucher PODCAST buat diskon skincare lima puluh persen ya.")
    lines = neutral(10) + sponsored + neutral(10, offset=30) + qa_moment(topic="skate")
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)

    assert covers(units, proposals[0], 30)
    flagged = [item for item in proposals if covers(units, item, 13)]
    assert all(any("sponsor" in reason.casefold() for reason in item.reasons) for item in flagged)


def test_segues_are_not_crossed():
    lines = (
        neutral(10)
        + qa_moment()
        + [
            L("Oke kita lanjut ke pertanyaan dari temen-temen member.", gap=0.5),
        ]
        + neutral(10, offset=30)
    )
    units, events = build(lines)
    segue = 17

    best = propose_heuristic(units, min_duration=20, max_duration=60, k=3, events=events)[0]

    assert not best.start_unit < segue <= best.end_unit


def test_a_welcome_at_the_start_is_a_cold_open_not_an_outro():
    opening = [
        L("Ini pertama kalinya podcast ini ngundang mantan copet paling dicari di Jakarta."),
        L("Terima kasih sudah datang ke sini."),
        L("Mantan, Bang, sekarang gua udah insaf total.", laugh=True),
    ]
    units, events = build(opening + neutral(6) + qa_moment() + neutral(40))

    proposals = propose_heuristic(units, min_duration=20, max_duration=60, k=5, events=events)

    welcomed = _overlapping(units, proposals, 1, 1)
    assert welcomed
    assert not any("penutup" in reason for item in welcomed for reason in item.reasons)


def test_an_outro_is_penalised_only_near_the_end_of_the_video():
    outro = L("Terima kasih sudah datang, sampai jumpa minggu depan ya.", laugh=True)
    closing = kitchen_moment()[:4] + [outro]

    units, events = build(neutral(40) + closing)
    proposals = propose_heuristic(units, min_duration=20, max_duration=60, k=5, events=events)
    last = len(units) - 1
    assert not covers(units, proposals[0], last)
    assert all(
        any("penutup" in reason for reason in item.reasons)
        for item in _overlapping(units, proposals, last, last)
    )

    units, events = build(neutral(20) + closing + neutral(60, offset=40))
    proposals = propose_heuristic(units, min_duration=20, max_duration=60, k=5, events=events)
    assert covers(units, proposals[0], 24)
    assert not any("penutup" in reason for item in proposals for reason in item.reasons)


def test_small_talk_runs_rank_below_a_real_answer():
    small_talk = [
        L("Boleh tahu nama lengkap lu siapa?"),
        L("Ijal aja, Bang."),
        L("Asli dari mana?"),
        L("Cirebon, Bang."),
        L("Tinggal di mana sekarang?"),
        L("Petamburan aja."),
        L("Suka nonton film?"),
        L("Suka, Bang."),
        L("Udah nikah belum?"),
        L("Belum, Bang."),
        L("Hobinya apa?"),
        L("Main bola aja."),
        L("Kerja di mana?"),
        L("Serabutan aja."),
        L("Makanan favorit?"),
        L("Nasi padang."),
    ]
    units, events = build(small_talk + neutral(6) + qa_moment() + neutral(6, offset=30))

    proposals = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events)

    assert covers(units, proposals[0], 23)
    chatty = [item for item in proposals if mostly_inside(item, 0, 15)]
    assert chatty
    assert all(any("basa-basi" in reason for reason in item.reasons) for item in chatty)


def test_suspect_units_are_penalised():
    garbled = [
        L(line.text, seconds=line.seconds, gap=line.gap, suspect=True, laugh=line.laugh)
        for line in qa_moment(topic="dompet")
    ]
    lines = neutral(10) + garbled + neutral(10, offset=30) + qa_moment(topic="dompet")
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)

    assert covers(units, proposals[0], 30)


def _with_fillers(line, dense=False):
    words = line.text.split()
    text = "eh ee hmm " + " ee ".join(words) if dense else "eh " + " ee ".join(words[:4])
    if not dense:
        text += " " + " ".join(words[4:])
    seconds = line.seconds or max(0.8, 0.4 * len(words))
    return L(text.strip(), seconds=seconds, gap=line.gap, laugh=line.laugh)


def test_filler_rate_penalty_is_relative_to_the_episode_and_mild():
    chatty = [_with_fillers(line) for line in neutral(40)]
    moment = [_with_fillers(line) for line in qa_moment(topic="band")]
    units, events = build(chatty[:10] + qa_moment(topic="band") + chatty[10:20] + moment)
    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)
    assert not any("pengisi" in reason for item in proposals for reason in item.reasons)

    def best_for(lines):
        units, events = build(neutral(10) + lines + neutral(10, offset=30))
        found = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)
        return next(item for item in found if covers(units, item, 11))

    clean = best_for(qa_moment(topic="band"))
    noisy = best_for([_with_fillers(line, dense=True) for line in qa_moment(topic="band")])
    assert not any("pengisi" in reason for reason in clean.reasons)
    assert any("pengisi" in reason for reason in noisy.reasons)
    assert 0 < clean.score - noisy.score <= 1.5


def test_dense_laughter_over_short_garbled_lines_is_capped():
    cluster = [
        L(text, seconds=1.0, gap=0.3, laugh=True)
        for text in (
            "Haha iya anjir.",
            "Wkwk gila lu.",
            "Aduh parah.",
            "Hahaha iya.",
            "Gila gila.",
            "Wkwk anjir.",
            "Iya iya parah.",
            "Haha aduh.",
            "Anjir lah.",
            "Wkwk iya.",
            "Haha gila.",
            "Aduh anjir.",
            "Parah parah.",
            "Iya haha.",
            "Gila lu.",
        )
    ]
    lines = neutral(10) + cluster + neutral(12, offset=30) + qa_moment()
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events)

    assert covers(units, proposals[0], 37)
    noisy = _overlapping(units, proposals, 10, 24)
    assert all(item.scores["emotion"] <= 6.0 for item in noisy)


def test_teaser_montage_is_skipped_and_its_originals_are_credited():
    moment = qa_moment(topic="adsense")
    teaser = [L(line.text, seconds=line.seconds, gap=0.3) for line in moment[1:5]]
    lines = teaser + [L("Kejar setoran bersama kita semua.", gap=3.0)] + neutral(30)
    lines += moment + neutral(30, offset=50)
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)

    assert all(item.start_unit >= 4 for item in proposals[:3])
    original = next(item for item in proposals if covers(units, item, 38))
    assert any("teaser" in reason for reason in original.reasons)


# --- scores, audio, diversity -----------------------------------------------------------------


def _audio_with_quiet(units, first, last):
    """Speech with a short pause every 2 s, and longer pauses between two units."""
    duration = units[-1].end + 1.0
    rms = []
    for frame in range(int(duration / 0.1)):
        moment = frame * 0.1
        inside = units[first].start <= moment <= units[last].end
        pause = 0.8 if inside else 0.3
        rms.append(-80.0 if moment % 2.0 < pause else -20.0)
    return build_audio_timeline(rms, duration=duration)


def test_silence_ratio_is_a_mild_positive():
    units, events = build(neutral(10) + qa_moment(topic="kopi") + neutral(10, offset=30))
    audio = _audio_with_quiet(units, 10, 16)

    plain = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)
    heard = propose_heuristic(
        units, min_duration=20, max_duration=45, k=3, events=events, audio=audio
    )

    before = next(item for item in plain if covers(units, item, 12))
    quiet = next(item for item in heard if covers(units, item, 12))
    assert 0 < quiet.score - before.score <= 1.0
    assert any("hening" in reason for reason in quiet.reasons)


def test_silence_breaks_a_tie_between_identical_moments():
    lines = neutral(10) + qa_moment(topic="kopi") + neutral(10, offset=30)
    lines += qa_moment(topic="kopi") + neutral(10, offset=60)
    units, events = build(lines)

    plain = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)
    heard = propose_heuristic(
        units,
        min_duration=20,
        max_duration=45,
        k=3,
        events=events,
        audio=_audio_with_quiet(units, 27, 33),
    )

    assert covers(units, plain[0], 12)
    assert covers(units, heard[0], 30)


def test_similar_topics_are_spread_out():
    repeat = qa_moment(topic="copet")
    lines = neutral(8) + repeat + neutral(8, offset=20) + repeat + neutral(8, offset=40)
    lines += kitchen_moment() + neutral(8, offset=60)
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=40, k=3, events=events)

    top_two = proposals[:2]
    assert any(covers(units, item, 40) for item in top_two)
    assert sum(covers(units, item, 10) or covers(units, item, 25) for item in top_two) == 1
    twin = next(
        item for item in proposals[2:] if covers(units, item, 10) or covers(units, item, 25)
    )
    assert any("mirip" in reason for reason in twin.reasons)
    assert twin.score < min(item.score for item in top_two)


# --- packaging --------------------------------------------------------------------------------


def test_hook_text_comes_from_the_best_line_cleaned_of_fillers_and_stutters():
    lines = (
        neutral(12)
        + [
            L("Kenapa lu keluar dari band lama lu?", gap=0.8),
            L("Eh gua gua gua jujur ee pernah dipecat gara-gara gara-gara telat manggung.", 6.0),
            L("Waktu itu kita main di acara kampus di Bandung.", seconds=5.0),
            L("Semua personel udah siap di atas panggung dari sore.", seconds=5.0),
            L("Gua masih di jalan kena macet di tol dalam kota.", seconds=5.0),
            L(
                "Pas gua sampai, acaranya udah selesai dan penonton pulang.",
                seconds=5.0,
                laugh=True,
            ),
        ]
        + neutral(12, offset=40)
    )
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]

    assert best.hook_unit == 13
    assert best.hook_text == "Gua jujur pernah dipecat gara-gara telat manggung."


def test_clean_line_trims_to_the_limit_on_a_word_boundary():
    text = "ee jadi gini sebenernya gua itu udah lama banget pengen cerita soal kejadian di kantor"
    cleaned = _clean_line(text, 40)
    assert len(cleaned) <= 40
    assert "…" not in cleaned
    assert cleaned.casefold() in text
    assert cleaned.split()[-1] not in {"soal", "di", "yang", "gua", "itu", "pengen"}
    assert cleaned[0].isupper()
    assert "ee" not in cleaned.split()
    assert _clean_line("  ", 40) == ""


def test_hashtags_come_from_salient_content_words():
    lines = neutral(12) + qa_moment(topic="copet") + neutral(12, offset=40)
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]

    assert "#copet" in best.hashtags
    assert not {"#gua", "#yang", "#itu", "#banget", "#jujur"} & set(best.hashtags)
    assert len(set(best.hashtags)) == len(best.hashtags)


@pytest.mark.parametrize(
    ("lines", "archetype"),
    [
        (
            [
                L("Kenapa lu malu cerita soal masa lalu lu?", gap=0.8),
                L("Jujur gua ngaku dulu pernah nyuri uang nyokap buat main game.", 5.0),
                L("Sumpah gua malu banget dan nyesel sampai sekarang soal itu.", 5.0),
                L("Gua belum pernah cerita ini ke siapa pun sebelumnya.", 5.0),
                L("Dosa gua ke nyokap tuh gede banget rasanya.", 5.0),
            ],
            "confession",
        ),
        (
            [
                L("Berapa sih modal buka warung kopi sekarang?", gap=0.8),
                L("Modal awal gua 25 juta buat mesin sama renovasi.", 5.0),
                L("Sebulan omzetnya bisa 40 juta kalau lagi rame.", 5.0),
                L("Untung bersihnya sekitar 30 persen dari omzet itu.", 5.0),
                L("Balik modal dalam 6 bulan kurang lebih.", 5.0),
            ],
            "number_proof",
        ),
        (
            [
                L("Kenapa lu dipanggil si raja telat sama temen-temen?", gap=0.8),
                L("Gua pernah telat ke nikahan gua sendiri satu jam.", 5.0, laugh=True),
                L("Penghulunya sampai ketiduran nungguin gua dateng.", 5.0, laugh=True),
                L("Pas gua dateng dia bangun terus nanya gua siapa.", 5.0, laugh=True),
                L("Mertua gua sampai sekarang masih ngeledekin soal itu.", 5.0, laugh=True),
            ],
            "humor",
        ),
    ],
)
def test_archetype_follows_the_dominant_evidence(lines, archetype):
    units, events = build(neutral(10) + lines + neutral(10, offset=30))

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events)[0]

    assert covers(units, best, 11)
    assert best.archetype == archetype


def test_audio_silences_mark_pauses_when_caption_timings_are_contiguous():
    lines = (
        neutral(12)
        + [
            L("Kenapa lu pindah kerja ke luar negeri?", gap=0.8),
            L("Soalnya gaji gua di sini dulu kecil banget dan cicilan numpuk.", 5.0, gap=0.0),
            L("Terus gua coba daftar kerja di kapal pesiar lewat agen.", 5.0, gap=0.0),
            L("Dan ternyata keterima cuma dalam waktu dua minggu saja.", 5.0, gap=0.0),
            L("Terus gua berangkat dan kerja di dapur kapal itu.", 5.0, gap=0.0),
            L("Sambil belajar masak dari koki yang galak banget.", 5.0, gap=0.0),
            L("Dan kokinya itu orang Italia.", 3.0, gap=0.0),
        ]
        + neutral(12, offset=40)
    )
    units, _ = build(lines)
    pause_at = units[15].end
    duration = units[-1].end + 1.0
    rms = [  # short breaths every 2 s everywhere, one long pause after unit 15
        -80.0 if pause_at <= frame * 0.1 < pause_at + 1.0 or frame % 20 < 3 else -20.0
        for frame in range(int(duration / 0.1))
    ]
    audio = build_audio_timeline(rms, duration=duration)

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3, audio=audio)[0]

    assert best.start_unit == 12
    assert best.end_unit == 15


def test_a_question_needs_content_to_anchor_a_clip():
    answer = qa_moment()[1:]
    empty = neutral(12) + [L("Ya kenapa enggak, Bang?", gap=0.8), *answer] + neutral(12, offset=40)
    units, events = build(empty)
    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)
    assert not any(item.start_unit == 12 and "pertanyaan" in item.reasons[0] for item in proposals)

    real = neutral(12) + qa_moment() + neutral(12, offset=40)
    units, events = build(real)
    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]
    assert best.start_unit == 12
    assert "pertanyaan" in best.reasons[0]


def test_openings_with_a_bare_reply_or_a_connector_are_not_clean_starts():
    moment = qa_moment()
    moment[0] = L("Nggak, nggak ya. Oke. Terus kenapa lu berhenti nyopet di konser?", gap=0.8)
    units, events = build(neutral(12) + moment + neutral(12, offset=40))

    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)

    assert all(item.start_unit != 12 for item in proposals)
    assert covers(units, proposals[0], 14)


def test_hook_text_is_the_hookiest_stretch_of_a_long_run_on_line():
    run_on = (
        "terus gue pikir pikir udahlah kita terus aja jujur gue pernah dapat dua apa tiga "
        "teguran channel gue mau ditutup karena konten sensitif yang terlalu banyak gitu"
    )
    excerpt = _clean_line(run_on, 60)
    assert len(excerpt) <= 60

    lines = (
        neutral(12)
        + [
            L("Kenapa YouTube begitu sama channel lu?", gap=0.8),
            L(run_on, seconds=12.0),
            L("Padahal kontennya buat nolong korban anak kecil biar pelakunya ketangkap.", 6.0),
            L("Jadi gua dilema banget waktu itu antara cuan sama nolong orang.", 6.0, laugh=True),
        ]
        + neutral(12, offset=40)
    )
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]

    assert best.hook_unit == 13
    assert len(best.hook_text) <= 60
    assert "teguran" in best.hook_text or "ditutup" in best.hook_text
    assert not best.hook_text.casefold().startswith("terus")


def test_dense_laughter_after_full_lines_is_not_capped():
    lines = (
        neutral(10)
        + [
            L("Kenapa lu dipanggil si raja telat sama temen-temen?", gap=0.8),
            L("Gua pernah telat ke nikahan gua sendiri satu jam lebih.", 4.0, laugh=True),
            L("Penghulunya sampai ketiduran di kursi nungguin gua dateng.", 4.0, laugh=True),
            L("Pas gua dateng dia bangun terus nanya gua ini siapa.", 4.0, laugh=True),
            L("Mertua gua sampai sekarang masih ngeledekin gua soal itu.", 4.0, laugh=True),
            L("Makanya sekarang gua selalu dateng satu jam lebih awal.", 4.0, laugh=True),
        ]
        + neutral(10, offset=30)
    )
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events)[0]

    assert covers(units, best, 12)
    assert best.scores["emotion"] > 6.0
    assert not any("Tawa padat" in reason for reason in best.reasons)


def test_repeated_boilerplate_is_not_mistaken_for_a_teaser():
    tagline = L("Jangan lupa dengerin terus podcast kejar setoran setiap minggu ya.")
    lines = [tagline] + neutral(8) + [tagline] + qa_moment() + neutral(20, offset=30)
    lines += [tagline] + neutral(20, offset=60) + [tagline] + neutral(8, offset=90)
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=5, events=events)

    assert not any("teaser" in reason for item in proposals for reason in item.reasons)


def test_laughter_picks_the_cut_but_counts_only_partly_in_the_ranking():
    lines = neutral(12) + qa_moment() + neutral(12, offset=40)
    units, events = build(lines)
    weights = {"hook": 0.30, "standalone": 0.15, "payoff": 0.25, "emotion": 0.15}
    weights["shareability"] = 0.15

    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]

    assert best.end_unit == 18
    weighted = sum(weights[name] * value for name, value in best.scores.items())
    assert best.score < weighted - 0.2


def test_a_single_long_unit_after_a_laugh_keeps_its_payoff_inside_the_clip():
    lines = (
        neutral(5)
        + [
            L("Jujur gua pernah dipecat gara-gara ketiduran.", laugh=True),
            L("Rp 25 juta!", seconds=25.0),
        ]
        + neutral(5, offset=20)
    )
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=26, k=3, events=events)

    single = [item for item in proposals if item.start_unit == item.end_unit == 6]
    assert single
    assert all(item.payoff_unit == 6 for item in single)


# --- production captions: split questions, continuations, segues ------------------------------


def _answer(topic="copet"):
    """The long, hooky guest answer of qa_moment() without its question."""
    return qa_moment(topic=topic)[1:]


def _first(lines, *, low=20, high=45):
    units, events = build(lines)
    return units, propose_heuristic(units, min_duration=low, max_duration=high, k=3, events=events)


def test_a_question_with_one_content_word_anchors_a_clip():
    lines = neutral(12) + [L("Artinya orang tahu enggak?", gap=0.8), *_answer()]

    _units, proposals = _first(lines + neutral(12, offset=40))

    assert proposals[0].start_unit == 12
    assert "pertanyaan" in proposals[0].reasons[0]


def test_a_rhetorical_question_inside_the_answer_does_not_end_it():
    answer = _answer()
    lines = (
        neutral(12)
        + [L("Kenapa lu akhirnya berhenti nyopet di konser?", gap=0.8), *answer[:2]]
        + [L("Lu ngerti kan?", gap=0.2), *answer[2:]]
        + neutral(12, offset=40)
    )

    _units, proposals = _first(lines)

    assert proposals[0].start_unit == 12
    assert "pertanyaan" in proposals[0].reasons[0]


def test_a_multi_part_question_anchors_at_its_first_part():
    lines = (
        neutral(12)
        + [
            L("Bang, apa ketakutan terbesar lu soal konser musik?", gap=0.8),
            L("Kira-kira bakal balik nyopet lagi atau enggak?", gap=0.3),
            *_answer(),
        ]
        + neutral(12, offset=40)
    )

    _units, proposals = _first(lines)

    assert proposals[0].start_unit == 12
    assert "pertanyaan" in proposals[0].reasons[0]


def test_a_question_split_mid_sentence_starts_where_its_sentence_starts():
    lines = (
        neutral(12)
        + [
            L("Kalau penontonnya sampai", gap=0.8),
            L("dua juta, lu mau ngapain?", gap=0.7),  # the caption line continues the question
            *_answer(),
        ]
        + neutral(12, offset=40)
    )

    _units, proposals = _first(lines)

    assert proposals[0].start_unit == 12
    assert "pertanyaan" in proposals[0].reasons[0]
    assert "0 detik" not in proposals[0].reasons[0]  # the answer is measured from the question


def test_clips_never_start_on_a_lowercase_continuation_after_a_pause():
    story = [  # caption lines split at pauses; only the lowercase halves carry hook words
        L("Terus pas di konser itu", gap=0.9),
        L("jujur gua ketangkep polisi pas lagi nyopet.", gap=0.9),
        L("Terus yang nangkep gua itu", gap=0.9),
        L("ternyata korban copet gua sendiri minggu lalu.", gap=0.9),
        L("Dan gua bilang ke dia", gap=0.9),
        L("sumpah gua bukan jambret apalagi begal.", gap=0.9),
        L("Terus dia malah ngasih", gap=0.9),
        L("tiket nonton gratis buat konser berikutnya.", gap=0.9, laugh=True),
    ]
    units, events = build(neutral(12) + story + neutral(12, offset=40))

    proposals = propose_heuristic(units, min_duration=5, max_duration=30, k=8, events=events)

    assert proposals
    assert all(item.start_unit not in {13, 15, 17, 19} for item in proposals)


def test_a_pause_before_a_lowercase_continuation_is_not_a_sentence_end():
    def payoff(following):
        lines = [
            L("Gua dulu kerja jadi tukang parkir di konser musik", seconds=10.0),
            L(following, seconds=10.0, gap=0.9),
            L("Terus gua pulang ke rumah.", seconds=10.0, gap=0.9),
        ]
        units, _events = build(lines)
        proposals = propose_heuristic(units, min_duration=10, max_duration=10, k=3)
        return next(item for item in proposals if item.end_unit == 0).scores["payoff"]

    assert payoff("sampai akhirnya ketahuan polisi.") < payoff("Sampai akhirnya ketahuan polisi.")


def test_lowercase_transcripts_keep_their_question_starts():
    lines = [
        L(line.text.lower(), line.seconds, line.gap, line.suspect, line.laugh)
        for line in neutral(12) + qa_moment() + neutral(12, offset=40)
    ]

    _units, proposals = _first(lines)

    assert proposals[0].start_unit == 12
    assert "pertanyaan" in proposals[0].reasons[0]


def test_counts_and_dates_are_not_number_evidence_but_money_and_percentages_are():
    def analysed(text):
        units, _events = build([L(text)])
        return _analyse_unit(units[0])

    for text in (
        "Wibi udah 3 tahun kerja bareng gua.",
        "Tanggal 3 September filmnya keluar.",
        "Gua nonton film itu 27 kali.",
    ):
        item = analysed(text)
        assert "number" not in item.tags
        assert item.numbers == 0
        assert item.opener != "number"
    for text in (
        "Gajinya cuma 20 juta setahun.",
        "Hampir 70% kru udah lama sama gua.",
        "Ruginya Rp 500 ribu sehari.",
    ):
        item = analysed(text)
        assert "number" in item.tags
        assert item.numbers >= 1


def test_viewer_question_segues_are_segues():
    def analysed(text):
        units, _events = build([L(text)])
        return _analyse_unit(units[0])

    for text in (
        "Oke, terakhir dari Gelipot.",
        "Satu pertanyaan dari Gerald Mandor.",
        "Oke, kita ke pertanyaan dari Hamba Melon.",
        "Ada 3 pertanyaan terakhir.",
    ):
        assert analysed(text).segue, text
    for text in (
        'Mungkin pertanyaan dari gua, "Bang, gimana cara lu tetap baik?"',
        "Itu yang terakhir dari gua soal copet.",
    ):
        assert not analysed(text).segue, text


def test_a_viewer_question_read_by_the_host_can_open_a_clip():
    question = L("Satu pertanyaan dari Gerald, kenapa lu berhenti nyopet di konser?", gap=0.8)

    _units, proposals = _first(neutral(12) + [question, *_answer()] + neutral(12, offset=40))

    assert proposals[0].start_unit == 12
    assert "pertanyaan" in proposals[0].reasons[0]


def test_a_viewer_question_segue_is_not_crossed():
    lines = qa_moment() + [L("Oke, terakhir dari Gelipot.", gap=0.5)] + neutral(10, offset=30)
    units, events = build(lines)
    segue = 7

    best = propose_heuristic(units, min_duration=40, max_duration=60, k=3, events=events)[0]

    # Every window over the Q&A is too short unless it crosses the segue; crossing costs more
    # than starting in the plain talk after it.
    assert not best.start_unit < segue <= best.end_unit


_VOCABULARY = (  # split in _random_episode
    "gua lu jujur ternyata pernah dulu waktu itu bukan tapi kerja uang 25 juta polisi nangis "
    "ketawa iya oke heeh eh ee kenapa gimana apa siapa kode voucher diskon kita lanjut terima "
    "kasih sudah nonton sampai jumpa anak istri kantor makanya jadi akhirnya gitu kayak sih "
    "banget gila parah rahasia istilah konser festival copet mutus ngambang"
)


def _random_episode(seed):
    rng = random.Random(seed)
    vocabulary = _VOCABULARY.split()
    lines = []
    for _ in range(rng.randint(1, 90)):
        words = [rng.choice(vocabulary) for _ in range(rng.randint(1, 18))]
        text = " ".join(words) + rng.choice(("", ".", "?", "!", ",", "..."))
        lines.append(
            L(
                text,
                seconds=rng.choice((None, rng.uniform(0.3, 16.0))),
                gap=rng.choice((0.0, 0.1, 0.4, 0.8, 2.5, 5.0)),
                suspect=rng.random() < 0.08,
                laugh=rng.random() < 0.2,
            )
        )
    units, events = build(lines)
    extra = tuple(
        SoundEvent.from_label(rng.uniform(0, units[-1].end + 5), rng.choice(("bersorak", "musik")))
        for _ in range(rng.randint(0, 3))
    )
    return rng, units, events + extra


@pytest.mark.parametrize("seed", range(40))
def test_random_episodes_always_satisfy_the_contract(seed):
    rng, units, events = _random_episode(seed)
    low = rng.choice((5.0, 15.0, 20.0, 30.0))
    high = low + rng.choice((0.0, 10.0, 40.0, 70.0))
    k = rng.randint(1, 8)
    duration = units[-1].end + 1.0
    audio = None
    if rng.random() < 0.5:
        rms = [rng.choice((-80.0, -30.0, -20.0)) for _ in range(int(duration / 0.1))]
        audio = build_audio_timeline(rms, duration=duration)

    proposals = propose_heuristic(
        units, min_duration=low, max_duration=high, k=k, events=events, audio=audio
    )

    assert len(proposals) <= max(3 * k, 15)
    taken = set()
    for item in proposals:
        start, end = span(units, item)
        assert low - 1e-6 <= end - start <= high + 1e-6
        indices = set(range(item.start_unit, item.end_unit + 1))
        assert not indices & taken
        taken |= indices
        assert 0 < len(item.hook_text) <= 60
        assert 0 < len(item.title) <= 70
        assert "…" not in item.hook_text + item.title
        assert 3 <= len(item.hashtags) <= 6
    assert [item.score for item in proposals] == sorted(
        (item.score for item in proposals), reverse=True
    )
    again = propose_heuristic(
        units, min_duration=low, max_duration=high, k=k, events=events, audio=audio
    )
    assert again == proposals


# --- banter and comedy ------------------------------------------------------------------------


def _answer_lines(topic="copet", count=6):
    lines = [
        f"Jujur gua pernah ketangkap polisi waktu {topic} di festival musik.",
        f"Ternyata yang nangkep gua itu korban {topic} gua sendiri tahun lalu.",
        f"Gua bukan jambret, tapi tetap aja rasanya malu banget soal {topic}.",
        f"Dia bilang ke gua jangan pernah balik lagi ke dunia {topic} itu.",
        f"Sejak itu gua insaf dan kerja jadi tukang parkir buat {topic} konser.",
        "Akhirnya gua malah dikasih hadiah tiket nonton gratis sama dia.",
    ]
    return [L(text, seconds=4.5) for text in lines[:count]]


@pytest.mark.parametrize("reaction", ["Hah? Serius?", "Masa sih?", "Serius lu?", "Gila!"])
def test_a_host_reaction_does_not_end_the_answer(reaction):
    answer = _answer_lines()
    lines = (
        neutral(12)
        + [L("Kenapa lu akhirnya berhenti nyopet di konser?", gap=0.8)]
        + answer[:2]
        + [L(reaction, seconds=1.0, gap=0.2)]
        + answer[2:]
        + neutral(12, offset=40)
    )
    units, events = build(lines)

    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]

    assert best.start_unit == 12
    assert best.end_unit >= 17
    assert any("pertanyaan" in reason.casefold() for reason in best.reasons)


def test_a_clip_never_starts_on_a_host_reaction():
    lines = (
        neutral(12)
        + [L("dan gua kerja jadi tukang parkir di konser gede", gap=0.0)]
        + [L("Serius lu?", seconds=1.0, gap=0.9)]
        + _answer_lines()
        + neutral(12, offset=40)
    )
    units, events = build(lines)

    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)

    assert all(item.start_unit != 13 for item in proposals)
    assert proposals[0].start_unit == 14


def test_host_reactions_do_not_make_banter_small_talk():
    banter = [
        L("Gua pernah disangka maling sama satpam kompleks sendiri.", gap=0.8),
        L("Hah? Serius?", seconds=1.0, gap=0.2),
        L("Sumpah, gara-gara gua pakai sarung.", seconds=2.0, gap=0.2),
        L("Masa sih?", seconds=1.0, gap=0.2),
        L("Iya, dikejar sampai pos.", seconds=1.6, gap=0.2),
        L("Gila!", seconds=0.8, gap=0.2),
        L("Terus dia minta maaf.", seconds=1.6, gap=0.2),
        L("Serius lu?", seconds=1.0, gap=0.2),
        L("Dia ngasih gua kopi gratis tiap pagi sampai sekarang.", seconds=4.0),
        L("Sejak itu gua malah jadi temen deket sama satpam itu.", seconds=4.0),
        L("Akhirnya tiap malam kita ronda bareng keliling kompleks.", seconds=4.0),
    ]
    units, events = build(neutral(12) + banter + neutral(12, offset=40))

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=events)[0]

    assert covers(units, best, 14) and covers(units, best, 20)
    assert not any("basa-basi" in reason for reason in best.reasons)


def _whisper_joke(laugh_text):
    return [
        L("Kenapa lu dipanggil si raja telat sama temen-temen?", gap=0.8),
        L("Gua pernah telat ke nikahan gua sendiri satu jam lebih.", seconds=4.0),
        L("Penghulunya sampai ketiduran di kursi nungguin gua dateng.", seconds=4.0),
        L("Pas gua dateng dia bangun terus nanya gua ini siapa.", seconds=4.0),
        L(laugh_text, seconds=1.2, gap=0.3),
        L("terus kita lanjut ngobrolin soal kerjaan kantor yang biasa aja", seconds=4.5, gap=0.0),
        L("dan kerjaannya lumayan banyak juga setiap minggu di kantor", seconds=4.5, gap=0.0),
    ]


@pytest.mark.parametrize("laugh_text", ["Hahaha", "Wkwkwk", "Lucu banget."])
def test_spelled_out_laughter_counts_without_laugh_tags(laugh_text):
    lines = neutral(12) + _whisper_joke(laugh_text) + neutral(12, offset=40)
    units, _events = build(lines)

    best = propose_heuristic(units, min_duration=15, max_duration=40, k=3)[0]

    assert best.start_unit == 12
    assert best.end_unit in (15, 16)
    assert best.payoff_unit == 15
    assert any("tawa" in reason.casefold() for reason in best.reasons)


def test_spelled_out_laughter_is_ignored_when_the_track_tags_laughter():
    lines = neutral(12) + _whisper_joke("Hahaha") + neutral(12, offset=40)
    units, _events = build(lines)
    tagged = (SoundEvent.from_label(units[-1].end + 0.2, "tertawa"),)

    proposals = propose_heuristic(units, min_duration=15, max_duration=40, k=3, events=tagged)
    joke = next(item for item in proposals if covers(units, item, 15))

    assert not any("tawa" in reason.casefold() for reason in joke.reasons)


def test_humor_needs_more_laughter_than_the_episode_usually_has():
    chatty = [L(line.text, seconds=line.seconds, laugh=True) for line in neutral(24)]
    answer = [
        L("Gua kerja jadi tukang parkir di konser gede tiap minggu.", seconds=4.5),
        L("Tiap malam gua pegang karcis sama peluit di pintu masuk.", 4.5, laugh=True),
        L("Mobil yang masuk bisa sampai ratusan kalau lagi rame.", seconds=4.5),
        L("Kadang gua juga bantuin panitia angkat kursi ke panggung.", 4.5, laugh=True),
        L("Pulangnya gua naik ojek bareng temen-temen parkir yang lain.", seconds=4.5),
    ]
    lines = chatty[:12] + [L("Kenapa lu kerja jadi tukang parkir di konser?", gap=0.8)] + answer
    units, events = build(lines + chatty[12:])

    proposals = propose_heuristic(units, min_duration=20, max_duration=40, k=3, events=events)

    assert covers(units, proposals[0], 14)
    assert all(item.archetype != "humor" for item in proposals)
    assert not any(item.title.startswith("Momen lucu") for item in proposals)


# --- packaging (titles and hook texts) --------------------------------------------------------


def _packaged(line, *, question="Kenapa lu keluar dari band lama lu?", seconds=6.0):
    lines = (
        neutral(12)
        + [
            L(question, gap=0.8),
            L(line, seconds=seconds),
            L("Waktu itu kita main di acara kampus di Bandung.", seconds=5.0),
            L("Semua personel udah siap di atas panggung dari sore.", seconds=5.0),
            L("Gua masih di jalan kena macet di tol dalam kota.", seconds=5.0),
            L("Pas gua sampai, acaranya udah selesai dan penonton pulang.", 5.0, laugh=True),
        ]
        + neutral(12, offset=40)
    )
    units, events = build(lines)
    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]
    return units, best


_TICS = {"ya", "sih", "deh", "dong", "nih", "ee", "eh", "gitu"}


def _assert_clean(text, limit):
    assert text and len(text) <= limit
    assert "…" not in text and "..." not in text
    assert text[0].isupper()
    words = [word.strip(".,?!").casefold() for word in text.split()]
    assert not _TICS & set(words[1:])
    assert all(first != second for first, second in itertools.pairwise(words))


def test_packaging_drops_filler_runs_and_never_ends_on_an_ellipsis():
    run_on = (
        "Sumpah gua gua awalnya yang yang pertama ya gua kaget ya ya lama-lama gua coba cek "
        "adsense gitu terus ternyata duitnya dibalikin semua sama YouTube"
    )
    _units, best = _packaged(run_on, seconds=9.0)

    assert best.hook_unit == 13
    _assert_clean(best.hook_text, 60)
    _assert_clean(best.title, 70)
    last = best.hook_text.rstrip(".?!").split()[-1].casefold()
    assert last not in {"yang", "gua", "dan", "ke", "di", "ya", "terus", "coba"}


def test_title_is_the_archetype_label_and_a_headline_from_the_hook_line():
    _units, best = _packaged(
        "Eh gua gua jujur ee pernah dipecat gara-gara gara-gara telat manggung."
    )

    assert best.hook_text == "Gua jujur pernah dipecat gara-gara telat manggung."
    assert best.archetype == "confession"
    assert best.title == "Pengakuan: Pernah dipecat gara-gara telat manggung."


def test_a_question_led_clip_without_other_evidence_is_titled_with_the_question():
    answer = [
        L("Kita main di acara kampus di Bandung dari sore sampai malam.", seconds=3.5),
        L("Semua personel udah siap di atas panggung dari sore.", seconds=3.5),
        L("Gua masih di jalan kena macet di tol dalam kota.", seconds=3.5),
        L("Personel yang lain milih lanjut manggung tanpa gua.", seconds=3.5, laugh=True),
    ]
    lines = neutral(12) + [L("Kenapa lu keluar dari band lama lu?", gap=0.8)] + answer
    units, events = build(lines + neutral(12, offset=40))

    best = propose_heuristic(units, min_duration=20, max_duration=45, k=3, events=events)[0]

    assert best.start_unit == 12
    assert best.archetype == "curiosity_gap"
    assert best.title == "Kenapa lu keluar dari band lama?"
    assert best.hook_text == "Personel yang lain milih lanjut manggung tanpa gua."


def test_a_garbled_hook_line_falls_back_to_a_line_with_content():
    units, best = _packaged("Yakin gue gua banget itu, jujur jujur.", seconds=3.0)

    assert "banget itu" not in best.hook_text
    _assert_clean(best.hook_text, 60)
    assert units[best.hook_unit].text.casefold().split()[0] != "yakin"


def test_clean_line_repairs_caption_and_whisper_artifacts():
    assert (
        _clean_line("Jarang yang ada dipecat di sini. Jujur") == "Jarang yang ada dipecat di sini."
    )
    assert (
        _clean_line("K lu kayak anjing kok dia baik banget ya")
        == "Lu kayak anjing kok dia baik banget"
    )
    assert _clean_line("gua kaget lama -lama Terus gua coba cek adsense") == (
        "Gua kaget lama-lama terus gua coba cek adsense"
    )
    assert (
        _clean_line("ekstrasnya dibuat sedemikian rupa...") == "Ekstrasnya dibuat sedemikian rupa"
    )
    assert _clean_line("iya iya oke") == ""


def test_heuristic_packaging_passes_the_llm_packaging_check():
    lines = neutral(12) + qa_moment() + neutral(12, offset=40) + kitchen_moment()
    units, events = build(lines + neutral(12, offset=80))
    proposals = propose_heuristic(units, min_duration=20, max_duration=45, k=5, events=events)

    for item in proposals:
        source = " ".join(unit.text for unit in units[item.start_unit : item.end_unit + 1])
        assert packaging_problem(item.hook_text, source, title=False) is None
        assert packaging_problem(item.title, source, title=False) is None
