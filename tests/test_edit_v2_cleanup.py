"""Rapikan: fillers, repeats and silent gaps (plan §7.3, §11.3 T3.5; ``edit_v2/cleanup.py``).

The review list is a pure function of the words artifact (``potongin.words/1``) and the two
lexicon files under ``resources/lexicon/``. Words artifacts here are built by the production
builder (``words.build_words_artifact``) from small synthetic transcripts, so ids, bounds, gap
classes and laughter events are exactly what the pipeline writes.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path

import pytest
from support import edit_v2_cleanup_gate as cleanup_gate
from test_edit_v2_store import make_clip

from ai_clipper import hook_heuristics
from ai_clipper.audio_timeline import ANALYZER_VERSION, AudioTimeline
from ai_clipper.edit_v2 import DOC_FPS, cleanup, words
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.edit_v2.errors import MESSAGES
from ai_clipper.edit_v2.peaks import bin_count, peaks_file_name
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.models import Transcription, TranscriptSegment, TranscriptWord
from ai_clipper.sound_events import SoundEvent

ROOT = Path(__file__).resolve().parents[1]
LEXICON_DIR = ROOT / "resources" / "lexicon"
LABELLED = ROOT / "tests" / "fixtures" / "edit_v2" / "fillers-labelled.json"
C30_CLEANUP = ROOT / "tests" / "fixtures" / "edit_v2" / "cleanup-c30.json"
CLIP = "clip_" + "ab" * 12
NTSC = Fps(30000, 1001)
ID = re.compile(r"^[a-z]{2,3}_[0-9a-z]{1,16}$")
PARTICLES = ("sih", "dong", "kok", "lho", "loh", "deh", "kan", "ya", "yah", "nih", "tuh", "gitu",
             "kayak", "kaya", "lah", "mah", "toh", "nah", "kek", "heeh")
FILLERS = ("eh", "ee", "eee", "e", "em", "emm", "ehm", "hmm", "hm", "anu")


# --- words artifacts from synthetic transcripts --------------------------------------------------


def build(tokens: Sequence[str | tuple[str, int]], *, start_ms: int = 100_000, word_ms: int = 300,
          gap_ms: int = 100, silences: Sequence[tuple[int, int]] = (),
          silent_before: Sequence[int] = (), laughs: Sequence[int] = (),
          fps: Fps = NTSC, audio: bool = True, events: bool = True) -> dict:
    """A words artifact over ``tokens`` (text, or ``(text, gap before in ms)``).

    ``silent_before`` lists word indices whose preceding gap is wholly silent (an audio-timeline
    silence spans it); ``silences`` adds absolute spans; ``laughs`` are laughter caption tags at
    absolute ms.
    """
    timed = []
    t = start_ms
    for index, token in enumerate(tokens):
        text, gap = (token, gap_ms) if isinstance(token, str) else token
        if index:
            t += gap
        timed.append((t, t + word_ms, text))
        t += word_ms
    spans = [tuple(span) for span in silences]
    for index in silent_before:
        spans.append((timed[index - 1][1], timed[index][0]))
    segments = [TranscriptSegment(
        timed[0][0] / 1000, timed[-1][1] / 1000, " ".join(text for _s, _e, text in timed),
        tuple(TranscriptWord(s / 1000, e / 1000, text, 0.9) for s, e, text in timed))]
    window = (start_ms - 1000, timed[-1][1] + 1000)
    timeline = None
    if audio:
        timeline = AudioTimeline(ANALYZER_VERSION, (window[1] + 5000) / 1000, 0.1, (), (),
                                 tuple(sorted((s / 1000, e / 1000) for s, e in spans)), (), ())
    tags = [SoundEvent(at / 1000, "laughter", "tertawa") for at in laughs] if events else None
    return words.build_words_artifact(
        Transcription("id", segments), clip_id=CLIP, window_ms=window, fps=fps, audio=timeline,
        events=tags, peaks=bytes(2 * bin_count(window)))


def listing(tokens, **kwargs) -> dict:
    return cleanup.build_cleanup(build(tokens, **kwargs))


def texts(artifact: dict, ids: Sequence[str]) -> list[str]:
    by_id = {word["id"]: word["t"] for word in artifact["words"]}
    return [by_id[i] for i in ids]


def items_of(result: dict, kind: str) -> list[dict]:
    return [item for item in result["items"] if item["kind"] == kind]


def listed_words(result: dict) -> set[str]:
    return {word for item in result["items"] for word in item.get("wordIds", ())}


def word_index(artifact: dict, text_or_index) -> str:
    return artifact["words"][text_or_index]["id"]


# --- lexicon -------------------------------------------------------------------------------------


def test_lexicon_files_hold_the_plan_lists():
    lexicon = cleanup.load_lexicon()
    assert set(lexicon.fillers) == set(FILLERS)
    assert lexicon.fillers == hook_heuristics._FILLERS - {"heeh"}
    assert ("apa", "namanya") in lexicon.filler_phrases
    assert set(lexicon.particles) == set(PARTICLES)
    assert "heeh" not in lexicon.fillers
    assert not lexicon.particles & lexicon.fillers
    assert not lexicon.particles & lexicon.stutter_words
    assert {"gua", "yang", "di", "ini", "jadi"} <= lexicon.stutter_words
    for word in ("hati", "pelan", "sama", "masing", "anak", "jalan"):
        assert word in lexicon.reduplication, word
    assert lexicon.filler_precheck is False  # pre-check stays off until the owner confirms


def test_lexicon_version_and_digest_cover_both_files():
    lexicon = cleanup.load_lexicon()
    assert lexicon.version == "id-fillers.v1+id-reduplication.v1"
    digest = hashlib.sha256()
    for name in ("id-fillers.v1.json", "id-reduplication.v1.json"):
        digest.update(name.encode() + b"\0" + (LEXICON_DIR / name).read_bytes() + b"\0")
    assert lexicon.sha256 == digest.hexdigest()


def test_a_malformed_lexicon_is_refused(tmp_path):
    for name in ("id-fillers.v1.json", "id-reduplication.v1.json"):
        (tmp_path / name).write_bytes((LEXICON_DIR / name).read_bytes())
    data = json.loads((tmp_path / "id-fillers.v1.json").read_text())
    data["fillers"].append("sih")  # a protected particle can never be a filler
    (tmp_path / "id-fillers.v1.json").write_text(json.dumps(data))
    with pytest.raises(ValueError):
        cleanup.load_lexicon(tmp_path)


def test_normalize_casefolds_and_strips_edge_punctuation():
    assert cleanup.normalize("Eh,") == "eh"
    assert cleanup.normalize("“Hmm…”") == "hmm"
    assert cleanup.normalize("-bener") == "bener"
    assert cleanup.normalize("E-KTP") == "e-ktp"


# --- fillers -------------------------------------------------------------------------------------


def test_every_hard_filler_is_listed_unchecked():
    tokens = []
    for filler in FILLERS:
        tokens += ["jadi", filler, "kita", "pergi."]
    artifact = build(tokens)
    result = cleanup.build_cleanup(artifact)
    fillers = items_of(result, "filler")
    assert [texts(artifact, item["wordIds"]) for item in fillers] == [[f] for f in FILLERS]
    assert all(item["defaultOn"] is False for item in fillers)


def test_filler_punctuation_and_case_do_not_matter_but_a_question_does():
    result = listing(["Eh,", "jadi", "kita", "Hmm.", "oke", "gitu,", "eh?", "Dr.", "Tirta,", "eh?"])
    artifact = build(["Eh,", "jadi", "kita", "Hmm.", "oke", "gitu,", "eh?", "Dr.", "Tirta,", "eh?"])
    assert [texts(artifact, item["wordIds"]) for item in items_of(result, "filler")] == [
        ["Eh,"], ["Hmm."]]


def test_elongated_fillers_are_listed_but_a_lone_m_is_not():
    tokens = ["jadi", "eeeh", "kita", "hmmm", "ke", "emmm", "situ", "Mm", "18", "M", "katanya", "ehmm"]
    artifact = build(tokens)
    result = cleanup.build_cleanup(artifact)
    listed = [texts(artifact, item["wordIds"])[0] for item in items_of(result, "filler")]
    assert listed == ["eeeh", "hmmm", "emmm", "Mm", "ehmm"]


def test_adjacent_fillers_are_one_item_and_apa_namanya_is_a_phrase():
    artifact = build(["kita", "ee", "ee", "Tirta", "lagi", "apa", "namanya", "ngopi"])
    result = cleanup.build_cleanup(artifact)
    assert [texts(artifact, item["wordIds"]) for item in items_of(result, "filler")] == [
        ["ee", "ee"], ["apa", "namanya"]]


def test_apa_alone_is_not_a_filler():
    assert items_of(listing(["apa", "itu", "namanya", "kamu", "apa"]), "filler") == []


def filler_texts(tokens: Sequence[str]) -> list[list[str]]:
    artifact = build(tokens)
    return [texts(artifact, item["wordIds"])
            for item in items_of(cleanup.build_cleanup(artifact), "filler")]


@pytest.mark.parametrize("quotative", ["kayak", "kayak,", "kaya", "kek", "gini,", "bilang", "mikir"])
def test_eh_after_a_quotative_is_reported_speech_not_a_filler(quotative):
    # "gue langsung kayak, eh tunggu dulu": the "eh" belongs to the thought being quoted
    assert filler_texts(["gue", "langsung", quotative, "eh", "tunggu", "dulu."]) == []
    # a hesitation sound after the same word is still a filler, and so is "eh" elsewhere
    assert filler_texts(["gua", quotative, "ee", "ngasir", "terus", "eh", "pulang."]) == [
        ["ee"], ["eh"]]


@pytest.mark.parametrize("address", ["Bang", "bro,", "mas", "kak", "hei.", "kau?", "lu", "kamu"])
def test_eh_that_addresses_someone_is_not_a_filler(address):
    # "Eh, Bang nanti pas live", "Eh, hei.", "Eh, lu mau nonton": an interjection to a person
    assert filler_texts(["oke.", "Eh,", address, "nanti", "pas", "live."]) == []
    # a restart before a pronoun that addresses nobody stays a filler
    assert filler_texts(["misalnya", "eh", "gua", "lagi", "planning."]) == [["eh"]]


def test_capitals_and_spelled_letters_are_not_fillers():
    # "Copenhagen HM", "A B C D E": an acronym and a spelled letter, not hesitations
    assert filler_texts(["20", "September", "Copenhagen", "HM.", "Oke."]) == []
    assert filler_texts(["kita", "ngomong", "A", "B", "C", "D", "E", "enggak", "mungkin"]) == []
    # a capitalised filler at a sentence start is still a filler
    assert filler_texts(["Iya.", "E", "karena", "habis", "olahraga"]) == [["E"]]
    assert filler_texts(["panas.", "Hm.", "Oke."]) == [["Hm."]]


# --- protected particles --------------------------------------------------------------------------


def test_protected_particles_are_never_listed():
    tokens: list = []
    silent: list[int] = []
    for particle in PARTICLES:
        # alone, doubled with a long silent pause, next to a filler and inside a repeated phrase
        tokens += ["kita", particle]
        silent.append(len(tokens))
        tokens += [(particle, 500), "eh", particle, "ya", "kayak", particle, "kayak", particle,
                   "pergi."]
    artifact = build(tokens, silent_before=silent)
    result = cleanup.build_cleanup(artifact)
    by_id = {word["id"]: word["t"] for word in artifact["words"]}
    listed = {cleanup.normalize(by_id[i]) for i in listed_words(result)}
    assert not listed & set(PARTICLES)
    assert items_of(result, "filler"), "the fillers around the particles are still listed"


def test_particles_include_mah_toh_nah_kek_and_heeh():
    for particle in ("mah", "toh", "nah", "kek", "heeh", "lho"):
        result = listing(["gue", particle, (particle, 500), "pergi"], silent_before=[2])
        assert result["items"] == [], particle


# --- repeats --------------------------------------------------------------------------------------


@pytest.mark.parametrize("word", ["gua", "yang", "di", "ini", "jadi", "saya", "dia", "kalau"])
def test_function_word_stutters_are_listed_unchecked(word):
    artifact = build(["terus", word, word, "bingung", "banget"])
    result = cleanup.build_cleanup(artifact)
    (item,) = items_of(result, "repeat")
    assert item["wordIds"] == [word_index(artifact, 1)]
    assert item["repeatOf"] == [word_index(artifact, 2)]
    assert item["defaultOn"] is False


def test_a_triple_stutter_keeps_the_last_occurrence():
    artifact = build(["terus", "gua", "gua", "gua", "bingung"])
    (item,) = items_of(cleanup.build_cleanup(artifact), "repeat")
    assert item["wordIds"] == [word_index(artifact, 1), word_index(artifact, 2)]
    assert item["repeatOf"] == [word_index(artifact, 3)]


def test_reduplication_is_never_listed_even_after_a_silence():
    lexicon = cleanup.load_lexicon()
    assert len(lexicon.reduplication) >= 20
    tokens: list = []
    silent: list[int] = []
    for word in sorted(lexicon.reduplication):
        tokens += ["kita", word]
        silent.append(len(tokens))
        tokens += [(word, 700), "terus."]
    artifact = build(tokens, silent_before=silent)
    assert items_of(cleanup.build_cleanup(artifact), "repeat") == []


@pytest.mark.parametrize("pair", ["hati hati", "pelan pelan", "sama sama", "masing masing",
                                  "anak anak", "jalan jalan"])
def test_the_plan_reduplication_examples_are_never_listed(pair):
    first, second = pair.split()
    result = listing(["kita", first, (second, 600), "aja"], silent_before=[2])
    assert result["items"] == []


def test_hyphen_split_reduplication_is_never_a_repeat():
    # Whisper writes "bener-bener" as "bener" + "-bener" and "kadang-kadang" alike.
    result = listing(["gue", "bener", ("-bener", 400), "dengerin", "kadang", "-kadang", "gue"],
                     silent_before=[2])
    assert result["items"] == []


def test_contextual_reduplication_depends_on_the_next_word():
    assert items_of(listing(["ya", "itu", "itu", "aja", "terus"]), "repeat") == []
    assert len(items_of(listing(["ya", "itu", "itu", "yang", "terjadi"]), "repeat")) == 1


def test_a_sentence_boundary_is_not_a_stutter():
    assert listing(["gak", "ngerti", "itu.", "Itu", "yang", "terjadi"])["items"] == []
    assert listing(["dia", "pergi", "dia?", "Dia", "nggak", "pulang"])["items"] == []


def test_emphatic_repeats_are_never_listed():
    for word in ("iya", "oke", "enggak", "nggak", "sorry", "sebentar", "udah", "jangan"):
        result = listing(["tadi", word, (word, 700), (word, 700), "pergi"], silent_before=[2, 3])
        assert items_of(result, "repeat") == [], word


def test_content_word_repeats_need_a_silence_of_250_ms():
    assert items_of(listing(["kita", "pergi", ("pergi", 500), "ke", "sana"]), "repeat") == []
    silent = listing(["kita", "pergi", ("pergi", 500), "ke", "sana"], silent_before=[2])
    assert len(items_of(silent, "repeat")) == 1
    # 249 ms of the gap covered by silence is not enough, 250 ms is (audio-timeline silences
    # last at least 250 ms, so these start 10 ms inside the first word)
    start = 100_000 + 300 + 100 + 300  # end of "pergi"
    short = listing(["kita", "pergi", ("pergi", 500), "ke"], silences=[(start - 10, start + 249)])
    exact = listing(["kita", "pergi", ("pergi", 500), "ke"], silences=[(start - 10, start + 250)])
    assert items_of(short, "repeat") == []
    assert len(items_of(exact, "repeat")) == 1


def test_repeated_phrases_within_1_5_s_are_listed():
    artifact = build(["jadi", "kita", "harus", "kita", "harus", "pergi"])
    (item,) = items_of(cleanup.build_cleanup(artifact), "repeat")
    assert texts(artifact, item["wordIds"]) == ["kita", "harus"]
    assert texts(artifact, item["repeatOf"]) == ["kita", "harus"]
    three = build(["gue", "mau", "bilang", "gue", "mau", "bilang", "sesuatu"])
    (item,) = items_of(cleanup.build_cleanup(three), "repeat")
    assert texts(three, item["wordIds"]) == ["gue", "mau", "bilang"]


def test_a_repeated_phrase_starting_later_than_1_5_s_is_not_listed():
    # second occurrence starts 300+100+300+600 = 1,300 ms after the first: listed
    near = listing(["jadi", "kita", "harus", ("kita", 600), "harus", "pergi"])
    assert len(items_of(near, "repeat")) == 1
    # 300+100+300+801 = 1,501 ms: not listed
    far = listing(["jadi", "kita", "harus", ("kita", 801), "harus", "pergi"])
    assert items_of(far, "repeat") == []


def test_a_repeated_phrase_with_a_particle_or_a_boundary_is_not_listed():
    assert listing(["kayak", "gini", "kayak", "gini", "terus"])["items"] == []
    assert listing(["teman", "teman.", "Teman", "teman.", "Mentor."])["items"] == []
    # a sentence ends inside the second occurrence: "nggak tau bang, itu bang. Itu dari drama"
    assert listing(["nggak", "tau", "bang,", "itu", "bang.", "Itu", "dari", "drama"])["items"] == []


def test_a_repetition_that_ends_the_sentence_is_an_echo_not_a_restart():
    # a restart continues the sentence after the kept occurrence; an echo ends it
    assert listing(["susah", "cari", "dia.", "Memang,", "memang.", "Nah,", "ada"])["items"] == []
    assert listing(["nggak", "ada", "masalah.", "Nggak", "ada,", "nggak", "ada.", "Mas"])[
        "items"] == []
    restart = listing(["Sekarang", "aku", "sudah,", "aku", "sudah", "marah", "udah"])
    assert len(items_of(restart, "repeat")) == 1
    assert len(items_of(listing(["Sama", "si,", "si", "pihak", "laki"]), "repeat")) == 1


def test_a_possessive_pronoun_before_the_same_pronoun_as_subject_is_not_a_stutter():
    # "orang yang membutuhkan bantuan gue, gue ngerasa": "my help, I feel"
    assert listing(["membutuhkan", "bantuan", "gue,", "gue", "ngerasa"])["items"] == []
    assert listing(["di", "eksklusif", "gue,", "gue", "bilang"])["items"] == []
    # after a sentence end or a function word the same shape is a restart
    assert len(items_of(listing(["dia.", "Gue,", "gue", "ngerasa"]), "repeat")) == 1
    assert len(items_of(listing(["jadi", "gue,", "gue", "ngerasa"]), "repeat")) == 1
    # without the comma it stays a stutter
    assert len(items_of(listing(["bantuan", "gue", "gue", "ngerasa"]), "repeat")) == 1


# --- laughter lock ---------------------------------------------------------------------------------


def test_items_within_500_ms_of_laughter_are_locked():
    artifact = build(["jadi", "eh", "kita", "pergi"], laughs=[100_000 + 400 + 300 + 500])
    result = cleanup.build_cleanup(artifact)
    assert result["items"] == []
    assert [lock["reason"] for lock in result["locked"]] == ["laughter"]
    far = build(["jadi", "eh", "kita", "pergi"], laughs=[100_000 + 400 + 300 + 501])
    assert len(items_of(cleanup.build_cleanup(far), "filler")) == 1


def test_a_laughter_gap_is_locked_and_transcript_laughter_counts():
    artifact = build(["kita", "ketawa", ("terus", 1200), "pulang"], laughs=[100_000 + 700 + 600])
    result = cleanup.build_cleanup(artifact)
    assert artifact["gaps"][0]["class"] == "laughter"
    assert result["items"] == []
    assert result["locked"][0]["reason"] == "laughter"
    tokens = build(["jadi", "eh", "wkwk", "pulang"])
    assert tokens["events"] and cleanup.build_cleanup(tokens)["items"] == []


# --- gaps ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("fps", [Fps(*rate) for rate in DOC_FPS])
@pytest.mark.parametrize("gap", [601, 700, 1234, 2500])
def test_silent_gaps_shrink_to_200_ms_centred_inside_the_gap(fps, gap):
    artifact = build(["kita", "pergi", ("pulang", gap), "sore"], silent_before=[2], fps=fps)
    result = cleanup.build_cleanup(artifact)
    (item,) = items_of(result, "gap_silent")
    assert item["defaultOn"] is True
    assert item["afterWord"] == word_index(artifact, 1)
    assert item["beforeWord"] == word_index(artifact, 2)
    s, e = item["s"], item["e"]
    assert (s, e) == (artifact["gaps"][0]["s"], artifact["gaps"][0]["e"])
    assert tm.sf_ceil(s, fps) <= item["inSf"] < item["outSf"] <= tm.sf_floor(e, fps)
    frame = Fraction(1000 * fps.den, fps.num)
    left = item["inSf"] * frame - s
    right = e - item["outSf"] * frame
    assert left >= 100 and right >= 100
    assert left + right < 200 + 2 * frame  # the kept pause is 200 ms, up to the frame grid
    assert abs(left - right) <= frame  # centred


def test_voiced_gaps_are_listed_for_audition_only():
    artifact = build(["kita", "pergi", ("pulang", 1500), "sore"])
    (item,) = items_of(cleanup.build_cleanup(artifact), "gap_voiced")
    assert item["defaultOn"] is False and item["applicable"] is False
    assert "inSf" not in item and "outSf" not in item


def test_without_an_audio_timeline_no_gap_is_proposed():
    result = listing(["kita", "pergi", ("pulang", 1500), "sore"], audio=False)
    assert result["items"] == []
    assert result["missing"] == ["audio_timeline"]


# --- quiet cuts (the clip's peaks) --------------------------------------------------------------------


def loud_peaks(artifact: dict, spans: Sequence[tuple[int, int]], level: int = 40) -> bytes:
    """Peaks of the artifact's window: silent, except bins overlapping ``spans`` (source ms)."""
    start = artifact["peaks"]["start_ms"]
    count = bin_count(tuple(artifact["window_ms"]))
    raw = bytearray(2 * count)
    for a, b in spans:
        for index in range(max(0, (a - start) // 10), min(count, -(-(b - start) // 10))):
            raw[2 * index] = (-level) & 0xFF
            raw[2 * index + 1] = level
    return bytes(raw)


def speech(artifact: dict) -> list[tuple[int, int]]:
    return [(word["s"], word["e"]) for word in artifact["words"]]


def test_with_silent_peaks_the_list_is_unchanged():
    artifact = build(["gua", "gua", "eh", "bingung", ("banget", 1400), "pulang"], silent_before=[4])
    quiet = cleanup.build_cleanup(artifact, peaks=loud_peaks(artifact, speech(artifact)))
    assert quiet["items"] == cleanup.build_cleanup(artifact)["items"]


def test_a_silent_gap_edge_moves_out_of_a_speech_tail():
    artifact = build(["kita", "pergi", ("pulang", 1400), "sore"], silent_before=[2])
    gap = artifact["gaps"][0]
    tail = (gap["s"], gap["s"] + 250)  # the word goes on 250 ms after its timestamp
    item = items_of(cleanup.build_cleanup(
        artifact, peaks=loud_peaks(artifact, [*speech(artifact), tail])), "gap_silent")[0]
    plain = items_of(cleanup.build_cleanup(artifact), "gap_silent")[0]
    frame = Fraction(1001, 30)
    assert item["outSf"] == plain["outSf"]
    assert item["inSf"] > plain["inSf"]
    assert item["inSf"] * frame - 10 >= tail[1]  # the ±10 ms around the cut is quiet
    assert (item["inSf"] - 1) * frame - 10 < tail[1]  # and it is the first such frame


def test_a_gap_without_a_quiet_cut_is_not_proposed():
    artifact = build(["kita", "pergi", ("pulang", 1400), "sore"], silent_before=[2])
    gap = artifact["gaps"][0]
    result = cleanup.build_cleanup(artifact, peaks=loud_peaks(artifact, [(gap["s"], gap["e"])]))
    assert items_of(result, "gap_silent") == []
    assert [lock["reason"] for lock in result["locked"]] == ["no_quiet_cut"]


def test_a_word_item_whose_cut_is_not_quiet_is_not_proposed():
    artifact = build(["jadi", "eh", "kita", "pergi"])
    words = artifact["words"]
    # the gap after "eh" carries speech: the cut there would clip it
    result = cleanup.build_cleanup(artifact, peaks=loud_peaks(
        artifact, [(words[0]["s"], words[1]["e"] + 100), *speech(artifact)]))
    assert items_of(result, "filler") == []
    assert result["locked"][0] == {"kind": "filler", "reason": "no_quiet_cut", "s": words[1]["s"],
                                   "e": words[1]["e"], "wordIds": [words[1]["id"]]}


def test_a_word_item_with_a_tight_cut_is_not_proposed():
    # words that touch leave no frame boundary between them: the cut would split a word
    artifact = build(["jadi", "eh", ("kita", 0), "pergi"])
    assert any(entry["tight"] for entry in artifact["bounds"])
    result = cleanup.build_cleanup(artifact, peaks=loud_peaks(artifact, speech(artifact)))
    assert items_of(result, "filler") == []
    assert result["locked"][0]["reason"] == "no_quiet_cut"


def test_the_cli_reads_the_clips_peaks(tmp_path, edit_v2_doc_contexts):
    context = edit_v2_doc_contexts["c30"]
    words = copy.deepcopy(context.words)
    peaks = loud_peaks(words, [(word["s"], word["e"] + 60) for word in words["words"]])
    words["peaks"]["file"] = peaks_file_name(peaks)
    seed = copy.deepcopy(context.seed)
    seed["base"]["words"]["sha256"] = hashlib.sha256(canonical_bytes(words)).hexdigest()
    make_clip(tmp_path, context, seed=seed, words=words)
    clip = tmp_path / seed["base"]["job_id"] / "analysis" / "clips" / seed["clip_id"]
    ids = {"jobId": seed["base"]["job_id"], "clipId": seed["clip_id"]}
    with_peaks = cleanup.build_cleanup(words, peaks=peaks)
    assert with_peaks["items"] != cleanup.build_cleanup(words)["items"]
    (clip / words["peaks"]["file"]).write_bytes(peaks)
    status, payload = call(tmp_path, op="list", **ids)
    assert status == 0
    assert payload["items"] == with_peaks["items"]
    # a peaks file that does not match its name is ignored
    (clip / words["peaks"]["file"]).write_bytes(bytes(len(peaks)))
    assert call(tmp_path, op="list", **ids)[1]["items"] == cleanup.build_cleanup(words)["items"]


def test_the_real_clip_gate_applies_what_the_review_lists(tmp_path, edit_v2_doc_contexts):
    # QG-CLEAN measures the items the editor shows: the CLI's list, quiet cuts included
    context = edit_v2_doc_contexts["c30"]
    words = copy.deepcopy(context.words)
    peaks = loud_peaks(words, [(word["s"], word["e"] + 60) for word in words["words"]])
    words["peaks"]["file"] = peaks_file_name(peaks)
    seed = copy.deepcopy(context.seed)
    seed["base"]["words"]["sha256"] = hashlib.sha256(canonical_bytes(words)).hexdigest()
    make_clip(tmp_path, context, seed=seed, words=words)
    clip = tmp_path / seed["base"]["job_id"] / "analysis" / "clips" / seed["clip_id"]
    (clip / words["peaks"]["file"]).write_bytes(peaks)
    status, payload = call(tmp_path, op="list", jobId=seed["base"]["job_id"],
                           clipId=seed["clip_id"])
    assert status == 0
    listing = cleanup_gate.gate_listing(clip)
    assert listing["items"] == payload["items"]
    assert listing["locked"] == payload["locked"]
    assert listing["items"] != cleanup.build_cleanup(words)["items"]


# --- the list as a whole ----------------------------------------------------------------------------


def test_items_are_in_transcript_order_with_stable_ids():
    tokens = ["gua", "gua", "eh", "bingung", ("banget", 1400), "terus", "ee", "pulang"]
    artifact = build(tokens, silent_before=[4])
    result = cleanup.build_cleanup(artifact)
    assert [item["kind"] for item in result["items"]] == ["repeat", "filler", "gap_silent", "filler"]
    assert [item["id"] for item in result["items"]] == ["cl_1", "cl_2", "cl_3", "cl_4"]
    assert all(ID.fullmatch(item["id"]) for item in result["items"])
    assert [item["s"] for item in result["items"]] == sorted(item["s"] for item in result["items"])
    again = cleanup.build_cleanup(copy.deepcopy(artifact))
    assert json.dumps(again, sort_keys=True) == json.dumps(result, sort_keys=True)
    assert result["schema"] == "potongin.cleanup/1"
    assert result["fillerPrecheck"] is False
    assert result["lexicon"]["version"] == "id-fillers.v1+id-reduplication.v1"


def test_word_items_are_contiguous_runs_of_known_words(edit_v2_doc_contexts):
    for context in edit_v2_doc_contexts.values():
        artifact = context.words
        position = {word["id"]: index for index, word in enumerate(artifact["words"])}
        result = cleanup.build_cleanup(artifact)
        for item in result["items"]:
            if "wordIds" not in item:
                continue
            indexes = [position[i] for i in item["wordIds"]]
            assert indexes == list(range(indexes[0], indexes[0] + len(indexes)))
            first, last = artifact["words"][indexes[0]], artifact["words"][indexes[-1]]
            assert (item["s"], item["e"]) == (first["s"], last["e"])


def test_listed_items_never_overlap():
    artifact = build(["gua", "gua", "gua", "eh", "eh", "kita", "harus", "kita", "harus", "pergi"])
    result = cleanup.build_cleanup(artifact)
    seen: set[str] = set()
    for item in result["items"]:
        assert not seen & set(item["wordIds"])
        seen |= set(item["wordIds"])


# --- the automated cut-edge check (QG-CLEAN) ---------------------------------------------------------


def test_every_cut_edge_lies_inside_its_word_gap_or_is_tight(edit_v2_doc_contexts):
    checked = 0
    for context in edit_v2_doc_contexts.values():
        artifact = context.words
        fps = Fps.from_json(artifact["fps"])
        for item in cleanup.build_cleanup(artifact)["items"]:
            if item["kind"] == "gap_voiced":
                continue
            for edge in cleanup.removal_edges(item, artifact):
                checked += 1
                ms = Fraction(edge["sf"] * 1000 * fps.den, fps.num)
                left, right = edge["gap"]
                assert edge["tight"] or left <= ms <= right, (item, edge)
    assert checked >= 20


def test_removal_edges_follow_the_bounds_table():
    artifact = build(["jadi", "gua", "gua", "bingung", ("banget", 900), "pulang"], silent_before=[4])
    result = cleanup.build_cleanup(artifact)
    repeat = items_of(result, "repeat")[0]
    bounds = {(entry["after"], entry["before"]): entry for entry in artifact["bounds"]}
    first, second = artifact["words"][1]["id"], artifact["words"][2]["id"]
    edges = cleanup.removal_edges(repeat, artifact)
    assert [edge["sf"] for edge in edges] == [
        bounds[(artifact["words"][0]["id"], first)]["sf"], bounds[(first, second)]["sf"]]
    gap = items_of(result, "gap_silent")[0]
    assert [edge["sf"] for edge in cleanup.removal_edges(gap, artifact)] == [gap["inSf"],
                                                                           gap["outSf"]]


# --- QG-CLEAN on the labelled set (plan §7.3, §10.2) ---------------------------------------------------


def test_labelled_set_meets_qg_clean():
    data = json.loads(LABELLED.read_text())
    report = cleanup_gate.evaluate_labelled(data)
    assert report["tokens"] >= 200
    assert report["reduplication_pairs"] >= 20
    assert set(report["particles_covered"]) == set(PARTICLES)
    assert report["sources"]["synthetic"] > 0 and report["sources"]["real"] > 0
    assert report["unlabelled_filler_hits"] == 0  # precision is measured on every hit
    assert report["filler_hits"] >= 50 and report["filler_precision"] is not None
    assert report["particle_false_positives"] == 0
    assert report["reduplication_false_positives"] == 0
    # "filler precision ≥ 0.9 before pre-check" (plan §7.3, §10.2): fillers are pre-checked only
    # once the owner has confirmed the labels (checkpoint 3) and the precision reaches 0.9
    if cleanup.load_lexicon().filler_precheck:
        assert report["owner_confirmed"] is True
        assert report["filler_precision"] >= 0.9


def test_labelled_samples_rebuild_as_words_artifacts():
    data = json.loads(LABELLED.read_text())
    for sample in data["samples"]:
        artifact = cleanup_gate.sample_artifact(sample)
        assert [word["t"] for word in artifact["words"]] == [w[2] for w in sample["words"]]
        assert all(0 <= label["i"][0] <= label["i"][-1] < len(sample["words"])
                   for label in cleanup_gate.labels_of(sample))


# --- the committed c30 list (read by the web tests and the e2e harness) -------------------------------


def c30_fixture(context) -> dict:
    """What the CLI answers for the c30 clip, plus Python's cut edges per item (the web tests
    check that the browser's ApplyCleanup cuts exactly there)."""
    listing_ = {"clipId": context.seed["clip_id"],
                "wordsSha256": context.seed["base"]["words"]["sha256"],
                **cleanup.build_cleanup(context.words)}
    edges = {item["id"]: [edge["sf"] for edge in cleanup.removal_edges(item, context.words)]
             for item in listing_["items"] if item["kind"] != "gap_voiced"}
    return {"schema": "potongin.cleanup-fixture/1", "context": "c30", "listing": listing_,
            "edges": edges}


def test_the_committed_c30_cleanup_list_is_current(edit_v2_doc_contexts):
    """Regenerate with ``POTONGIN_WRITE_FIXTURES=1 uv run pytest tests/test_edit_v2_cleanup.py``."""
    expected = c30_fixture(edit_v2_doc_contexts["c30"])
    if os.environ.get("POTONGIN_WRITE_FIXTURES") == "1":
        C30_CLEANUP.write_text(json.dumps(expected, sort_keys=True, indent=1, ensure_ascii=False)
                               + "\n")
    assert json.loads(C30_CLEANUP.read_text()) == expected
    kinds = {item["kind"] for item in expected["listing"]["items"]}
    assert {"filler", "repeat", "gap_silent", "gap_voiced"} <= kinds
    assert expected["listing"]["locked"]


# --- CLI ----------------------------------------------------------------------------------------------


@pytest.fixture
def c30_clip(tmp_path, edit_v2_doc_contexts) -> tuple[Path, dict]:
    context = edit_v2_doc_contexts["c30"]
    make_clip(tmp_path, context)
    seed = context.seed
    return tmp_path, {"jobId": seed["base"]["job_id"], "clipId": seed["clip_id"]}


def call(jobs_root, **envelope) -> tuple[int, dict]:
    return cleanup.handle(json.dumps(envelope).encode(), jobs_root=jobs_root)


def test_cli_list_returns_the_review_list(c30_clip, edit_v2_doc_contexts):
    jobs_root, ids = c30_clip
    status, payload = call(jobs_root, op="list", **ids)
    assert status == 0, payload
    context = edit_v2_doc_contexts["c30"]
    words_sha = context.seed["base"]["words"]["sha256"]
    assert payload["clipId"] == ids["clipId"]
    assert payload["wordsSha256"] == words_sha
    expected = cleanup.build_cleanup(context.words)
    assert payload["items"] == expected["items"]
    assert payload["locked"] == expected["locked"]
    assert str(jobs_root) not in json.dumps(payload)


@pytest.mark.parametrize("raw", [
    b"", b"[]", b'{"op": "list"}', b'{"op": "delete", "jobId": "x", "clipId": "y"}',
    b'{"op": "list", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "clipId": "clip_1"}',
    b'{"op": "list", "jobId": "../..", "clipId": "clip_abababababababababababab"}',
    (b'{"op": "list", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", '
     b'"clipId": "clip_abababababababababababab", "extra": 1}'),
])
def test_cli_rejects_malformed_envelopes(tmp_path, raw):
    status, payload = cleanup.handle(raw, jobs_root=tmp_path)
    assert status == 2
    assert payload["error"]["code"] == "internal_error"


def test_cli_exit_codes(c30_clip, tmp_path_factory):
    jobs_root, ids = c30_clip
    assert call(jobs_root, op="list", jobId=str(uuid.uuid4()), clipId=ids["clipId"])[0] == 4
    assert call(jobs_root, op="list", jobId=ids["jobId"], clipId="clip_" + "0" * 24)[0] == 4
    status, payload = cleanup.handle(json.dumps({"op": "list", **ids}).encode(), jobs_root=None)
    assert status == 1 and payload["error"]["code"] == "internal_error"
    clip = jobs_root / ids["jobId"] / "analysis" / "clips" / ids["clipId"]
    for words_file in clip.glob("words.*.json"):
        words_file.unlink()
    status, payload = call(jobs_root, op="list", **ids)
    assert status == 8 and payload["error"]["code"] == "analysis_missing"
    assert payload["error"]["messageId"] in {f"edit.{code}" for code in MESSAGES}


def test_cli_process_reads_stdin_and_jobs_root(c30_clip):
    jobs_root, ids = c30_clip
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(jobs_root),
           "PYTHONPATH": str(ROOT / "src")}
    done = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.cleanup"],
                          input=json.dumps({"op": "list", **ids}).encode(), capture_output=True,
                          env=env, timeout=60, check=False)
    assert done.returncode == 0, done.stderr.decode()
    payload = json.loads(done.stdout)
    assert payload["items"] and payload["wordsSha256"]
