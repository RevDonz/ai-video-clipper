"""Deterministic, network-free Selection V3 fallback: question- and story-anchored clips.

:func:`propose_heuristic` turns sentence units (plus optional sound events and an audio
timeline) into ranked, mutually non-overlapping :class:`ClipProposal` values with
``source="heuristic"``. It runs when no LLM is configured or the LLM fails, so it never touches
the network and returns the same output for the same input.

The rules follow the Phase-1 audit, not the V1/V2 features (keyword counts, absolute filler
thresholds and "topic-shift" boundaries were at chance level):

* **Starts.** A host question with a content word that is answered by at least
  :data:`ANSWER_RUN_SECONDS` of statements before the next real question (a question with
  content: rhetorical tags such as ``Lu ngerti kan?`` do not interrupt an answer, and a
  question asked in up to three parts is answered after its last part); the tight setup line
  just before a very short question; story openers (``waktu itu``, ``pernah``, ``jadi gini``,
  ``ceritanya``, ``gue inget``, ``dulu``); contrast or identity statements (``bukan X tapi
  Y``, ``gue bukan …``); reveal markers (``ternyata``, ``jujur``, ``sebenernya``,
  ``faktanya``); money and magnitudes (``juta``, ``miliar``, ``%``; bare counts and dates are
  not evidence); the first unit of the video; and, with no credit, any other unit after a
  clean boundary that does not open with a pronoun, a connector or a bare reply.
* **Split lines.** Caption lines are cut at pauses and speaker changes, often mid-sentence. In
  a transcript that capitalises sentence starts, a unit opening in lowercase after one without
  terminal punctuation continues that sentence: it never starts a clip, a question in it starts
  where its sentence does (at most :data:`_SENTENCE_WALK_BACK` units back), and the pause
  before it is not a sentence end.
* **Ends.** Every end inside ``[min_duration, max_duration]`` is scored: right after laughter
  or applause (or the short backchannel after it) is best, then terminal punctuation followed
  by a pause of at least 0.6 s (word gaps, or silences from the audio timeline because YouTube
  caption timings are contiguous), then a recap or lesson line (``jadi``, ``akhirnya``,
  ``makanya``, ``intinya``, ``oh gitu``, ``berarti``). Ending on a question (before its
  answer), on a setup, or mid-sentence is penalised. Each start keeps its best short, medium
  and long option so a shorter cut can stand in when the best one overlaps an earlier pick.
* **Scores** (0–10): ``hook`` is the best line in the first ~40% of the longest allowed clip
  (8–24 s; colloquial Jakarta lexicon for confession, insider knowledge, contrast, stakes,
  superlatives, numbers and reported speech, plus laughter right after the line, lines reused
  by a teaser, and a question that gets answered); ``standalone`` rewards clean openers and
  penalises pronoun-led or reply-led openings and references to earlier context; ``payoff``
  is the end quality; ``emotion`` is laughter/cheer density (laughter after fragments counts
  little, dense clusters of it are capped) plus emotional words; ``shareability`` counts
  numbers, relatable or taboo topics and episode-specific words. A higher silence ratio from
  the audio timeline is a mild positive.
* **Laughter** decides where to cut more than what to pick: the payoff dimension keeps the
  full laugh-end credit and chooses the end, but only :data:`LAUGH_RANK_SHARE` of it counts
  when different moments are ranked, because banter is full of laughs. A track without any
  laughter tag (Whisper, automatic captions) still marks laughs in text: a spelled-out laugh
  (``Hahaha``, ``Wkwk``) or a short remark (``Lucu banget.``) counts as one laugh after the
  line it follows. A track that tags laughter is trusted as it is.
* **Banter.** Host reactions (``Hah? Serius?``, ``Masa sih?``, ``Serius lu?``, ``Gila!``)
  react to the line before: they do not end an answer, do not count as small-talk questions
  and never start a clip, and a unit that opens with one is reply-led. Rewarding laughter or
  banter words when ranking (roast words, reaction density, callbacks, laughs early in the
  clip or after a setup line, bursts of short turns before a laugh, laughing runs exempt from
  the small-talk penalty) was measured on the tuning episodes and rejected: every variant
  added traps or lost gold moments.
* **Penalties:** suspect (garbled) units, sponsor reads, segues inside the clip (including a
  host moving to the next viewer question: ``Oke, terakhir dari X``, ``Satu pertanyaan dari
  X``; a unit that reads the viewer's question itself may still open a clip), channel
  greetings at the very start and outros only near the end (a guest welcome at 00:00 is a cold
  open), small talk (runs of short Q/A turns with bare replies), a filler rate well above the
  episode median, dense laughter over fragments, and a pre-roll teaser montage (early lines
  that recur verbatim later; the recurring originals get hook credit instead).
* **Diversity:** windows are picked greedily (maximal marginal relevance): they never overlap,
  and each pick is penalised by its content-word similarity to earlier picks. Among
  near-duplicates of the picked moment the best cut wins. Proposal scores are these
  diversity-adjusted scores, so they never increase down the list.
* **Packaging.** The hook text (at most :data:`HOOK_TEXT_MAX_CHARS`) is the best clean
  sentence of the hook line: fillers, verbal tics (``ya``, ``sih``, a stray ``gitu``),
  vocatives, stutters (``gua gua``, ``yang yang``) and Whisper artifacts (``lama -lama``)
  are removed, and a long sentence is cut to its hookiest stretch on a word boundary that
  closes a phrase, never with an ellipsis. A garbled or filler-only hook line falls back to
  the next strongest line of the hook zone (the proposal's ``hook_unit`` follows it). The
  title (at most :data:`TITLE_MAX_CHARS`) is the host question for a question-led clip with
  no stronger archetype, otherwise an archetype prefix (``Pengakuan: …``) and a headline:
  the hook sentence without its leading pronoun, marker, connector or ``gua bilang``.
  ``humor`` needs laughter well above the episode's own rate
  (:data:`HUMOR_LAUGH_EXCESS`), so a banter-heavy episode does not call everything funny.

The weights were set on the two tuning episodes only (``Ive926sC6mc``, ``0dzvz9JZFIM``); the
comments on the constants note the few choices the benchmark moved. The split-line, question
and number rules were re-checked on the production caption parser (``yt/transcript.json``,
segments split at speaker changes) and on Whisper word transcripts of the same two episodes.
"""

from __future__ import annotations

import math
import re
from bisect import bisect_left, bisect_right
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from numbers import Real

from .audio_timeline import AudioTimeline
from .selection_types import ClipProposal
from .sentences import SentenceUnit
from .sound_events import SoundEvent, sort_events

HEURISTIC_VERSION = "heuristic-v3.1"
MIN_PROPOSALS = 15
HOOK_TEXT_MAX_CHARS = 60
TITLE_MAX_CHARS = 70
ANSWER_RUN_SECONDS = 12.0
HOOK_ZONE_SHARE = 0.4
HOOK_ZONE_MIN_SECONDS = 8.0
HOOK_ZONE_MAX_SECONDS = 24.0
DURATION_BUCKETS = 3
MIN_HASHTAGS = 3
MAX_HASHTAGS = 6

# Dimension weights of the combined score; they sum to 1 so a perfect clip scores 10.
W_HOOK = 0.30
W_STANDALONE = 0.15
W_PAYOFF = 0.25
W_EMOTION = 0.15
W_SHAREABILITY = 0.15
DIVERSITY_WEIGHT = 3.0
SAME_MOMENT_IOU = 0.5
LAUGH_END_BONUS = 2.0
# Laughter says where to cut much more than what to pick: banter is full of laughs, so only
# this share of the laugh-end bonus counts when windows from different starts are ranked.
LAUGH_RANK_SHARE = 0.25
RECAP_END_BONUS = 1.5
PRONOUN_LEAD_PENALTY = 2.5
# One content word is enough: the stop list is broad ("Artinya orang tahu enggak?") and caption
# lines split questions; the answer run (ANSWER_RUN_SECONDS) is what filters small talk.
QUESTION_MIN_CONTENT = 1
HOOK_LINE_SLOPE = 1.25
ANSWERED_QUESTION_BONUS = 0.5
SILENCE_BONUS = 0.6
SALIENT_SATURATION = 12.0
TEASER_PENALTY = 4.0
SPONSOR_PENALTY = 3.0
SEGUE_PENALTY = 2.5
OUTRO_PENALTY = 3.0
GREETING_PENALTY = 1.5
# How long an opening greeting lasts for :func:`opening_end`: the welcome, the guest's
# introduction and the topic of the day (rBg0ZcwjVKQ: "selamat datang" at 00:00, "belajar
# perjomokan di sini" at 00:54, the first real question at 01:02).
GREETING_REACH_SECONDS = 60.0
SMALL_TALK_PENALTY = 2.5
SMALL_TALK_SHARE = 0.5
SUSPECT_PENALTY = 4.0
FILLER_PENALTY_MAX = 1.5
DENSE_LAUGH_PENALTY = 0.8
# "Humor" needs this many times the laughter the episode has on average (plus one laugh):
# banter-heavy episodes laugh everywhere, and a title must stay faithful to the moment.
HUMOR_LAUGH_EXCESS = 1.5

_EPSILON = 1e-6
_PAUSE_SECONDS = 0.6
_TIGHT_SETUP_SECONDS = 0.35
_ANSWER_BREAK_GAP = 3.0
_ANSWER_HORIZON_SECONDS = 120.0
_SHORT_QUESTION_TOKENS = 4
_QUESTION_PARTS = 3  # a question plus up to two parts asked right after it, before any answer
_SENTENCE_WALK_BACK = 2  # caption lines a split question may reach back to its sentence start
_CASED_SHARE = 0.5  # share of capitalised units above which a lowercase start means "continues"
_SMALL_TALK_TOKENS = 6
_SMALL_TALK_RUN = 5
_SMALL_TALK_QUESTIONS = 3
_SUBSTANTIVE_TOKENS = 5
_DENSE_LAUGHS_PER_MINUTE = 5.0
_INTRO_SECONDS, _INTRO_SHARE = 90.0, 0.03
_OUTRO_SECONDS, _OUTRO_SHARE = 120.0, 0.04
_TEASER_SECONDS, _TEASER_SHARE = 180.0, 0.15
_TEASER_GRAM = 4
_TEASER_MIN_UNITS = 3
_TEASER_FIRST_ECHO_SECONDS = 60.0
_FILLER_FLOOR = 0.04
_SALIENT_SHARE = 0.02
_WORD = re.compile(r"[^\W_]+(?:[-'’][^\W_]+)*")
_CLOSERS = "\"'”’»)]}"
_SENTENCE = re.compile(r"[^.?!…]+")

# --- lexicons (casefolded, matched on the filler-free token string) ----------------------------


def _set(spec: str) -> frozenset[str]:
    return frozenset(spec.split())


def _alternation(spec: str) -> re.Pattern[str]:
    """Compile ``|``-separated regex terms so that each matches whole words only."""
    return re.compile(r"(?<![\w-])(?:" + spec + r")(?![\w-])")


_FILLERS = _set("eh ee eee e em emm ehm hmm hm anu heeh")
_SOFT_FILLERS = _set("gitu kayak kaya ya kan sih tuh deh dong lah nih loh lho yah maksudnya apa")
_BACKCHANNEL = _set(
    "iya ya oke ok okay okey heeh he hm hmm oh ah eh ih hah betul benar bener nah wah wow "
    "gitu gini begitu sip siap mantap anjir buset ooh yoi yes yup sih deh dong kan loh lho "
    "nih tuh haha hahaha hehe wkwk wkwkwk enggak nggak gak kagak bang bro kak mas setuju "
    "sepakat masuk aja banget juga iyaa yaudah iyalah"
)
# Host reactions ("Hah? Serius?", "Masa sih?", "Serius lu?", "Gila!"): surprise or disbelief at
# the line before, never a new topic. A reaction is a short unit made only of these words and
# backchannels, with at least one word from the core set.
_REACTION = _set(
    "hah serius seriusan masa masak mosok beneran yakin sumpah demi apa anjir anjay njir anjrit "
    "anjing buset busyet gila astaga astagfirullah waduh wadaw aduh ampun gimana terus trus kok "
    "bisa bener benar lu lo elu gue gua ha he"
)
_REACTION_CORE = _set(
    "hah serius seriusan masa masak mosok beneran yakin sumpah demi anjir anjay njir anjrit "
    "buset busyet gila astaga astagfirullah waduh wadaw"
)
# Laughter spelled out by Whisper ("Hahaha", "Wkwk") and short remarks that a line was funny.
_LAUGH_TOKEN = re.compile(r"(?:ha){2,}h?|(?:he){2,}|(?:hi){2,}|(?:wk){2,}\w*")
_STOPWORDS = (
    _FILLERS
    | _SOFT_FILLERS
    | _BACKCHANNEL
    | _set(
        "yang dan di ke dari itu ini ada udah sudah gue gua gw lu lo loe elu kamu aku saya "
        "kita kami mereka dia beliau nya ga engga tidak bukan jadi terus trus tapi kalau kalo "
        "karena soalnya sama buat untuk dengan dalam pada lagi masih bisa mau pengen pengin "
        "harus emang memang sangat lebih paling siapa gimana kenapa kapan mana berapa tau "
        "tahu begini hal cuma cuman doang abis habis pas waktu sekarang nanti tadi dulu biar "
        "supaya atau sampai sampe kayaknya mungkin pasti orang semua semuanya sesuatu punya "
        "kalian pun si sang para akan bakal belum pernah sendiri lain mulai kali satu dua tiga "
        "ngomong bilang kata katanya seperti banyak sedikit agak baru lama makanya berarti "
        "apakah adalah ialah tersebut oleh bagi antara setelah sebelum saat ketika sini situ "
        "sana dah ntar entar mah kek sebenernya sebenarnya ternyata ngapain apaan udahlah "
        "segala setiap tiap lalu kemudian sambil tetap tetep malah justru jujur sumpah "
        "akhirnya intinya pokoknya hari ngerti mikir rasanya sempet sempat bikin dapet dapat "
        "kasih liat lihat denger dengar cerita ceritanya misalnya contoh emangnya gede kecil "
        "baik bagus mbak pak bu biasa biasanya yaitu yakni namanya apapun siapapun diri tahun "
        "bulan minggu jam menit detik kemarin besok the and you is it to of so that this"
    )
)

_I = r"(?:gue|gua|gw|aku|saya)"
_HOOK_LEXICON: dict[str, tuple[float, re.Pattern[str]]] = {
    "confession": (
        2.0,
        _alternation(
            r"jujur(?:ly)?|sumpah|ngaku(?:in)?|mengaku|akuin|aib|malu|nyesel|menyesal|dosa|"
            r"kelam|(?:gak|nggak|enggak|belum) pernah (?:cerita|ngomong)"
        ),
    ),
    "insider": (
        2.0,
        _alternation(
            r"rahasia(?:nya)?|trik(?:nya)?|kode|istilah(?:nya)?|modus(?:nya)?|balik layar|"
            r"behind the scenes?|(?:orang|banyak yang) (?:gak|nggak|enggak|ga) (?:tahu|tau)|"
            r"jarang (?:orang )?(?:yang )?(?:tahu|tau)"
        ),
    ),
    "reveal": (1.5, _alternation(r"ternyata|sebe?n[ae]rnya|faktanya|aslinya|padahal")),
    "contrast": (
        1.5,
        _alternation(rf"bukan \S+(?: \S+){{0,6}} tapi|{_I} (?:mah |tuh |itu )?bukan|justru|malah"),
    ),
    "stakes": (
        1.5,
        _alternation(
            r"mati|meninggal|hampir|nyaris|ditahan|ketangkep|ketangkap|ditangkap|dipecat|"
            r"ditutup|bangkrut|utang|hutang|cerai|penjara|polisi|bahaya|kanker|trauma|nangis|"
            r"menangis|di-?cancel|burnout|diancam|kecelakaan|dibohong(?:in|i)|kehilangan|"
            r"dipukul(?:in)?|digebukin"
        ),
    ),
    "superlative": (
        1.0,
        _alternation(
            r"pertama kali(?:nya)?|satu-satunya|nomor satu|luar biasa|seumur hidup|"
            r"ter(?:baik|besar|parah|berat|gila|sulit|mahal|takut|kaya)"
        ),
    ),
    # Money and magnitudes only: bare digits in talk are mostly dates, ages and counts
    # ("3 tahun", "27 kali"), which were no more frequent in gold moments than elsewhere.
    "number": (
        1.0,
        _alternation(
            r"juta|jutaan|miliar|milyar|triliun|ribu|ribuan|persen|rupiah|dolar|dollar|rp"
        ),
    ),
    "reported": (
        1.0,
        _alternation(
            rf"(?:{_I}|dia|mereka|lu|lo|beliau) (?:bilang|ngomong|nanya|tanya|jawab)|katanya|"
            r"kata (?:dia|gue|gua|mereka|orang|beliau)"
        ),
    ),
    "story": (
        1.0,
        _alternation(
            rf"waktu itu|jadi gini|ceritanya|{_I} (?:inget|ingat)|suatu (?:hari|saat|ketika)|"
            rf"pas {_I}"
        ),
    ),
}
_STORY_OPENER = _alternation(
    rf"waktu itu|pernah|jadi gini|ceritanya|{_I} (?:inget|ingat)|dulu|suatu (?:hari|saat|ketika)"
)
_REVEAL_OPENER = _alternation(r"ternyata|jujur(?:ly)?|sebe?n[ae]rnya|faktanya|sumpah|aslinya")
_CONTRAST_OPENER = _alternation(rf"bukan \S+(?: \S+){{0,6}} tapi|{_I} (?:mah |tuh )?bukan")
_RECAP = _alternation(
    r"jadi|akhirnya|makanya|intinya|berarti|pokoknya|kesimpulannya|pelajarannya|yang penting"
)
_OH_GITU = _alternation(r"oh gitu|oh begitu|oh pantes")
_SPONSOR = _alternation(
    r"disponsori|sponsor(?:ed)?|promo|kode (?:voucher|promo|diskon)|voucher|"
    r"link (?:ada )?di (?:bio|deskripsi)|diskon|cashback|endorse|(?:pakai|pake|gunakan) kode|"
    r"(?:download|unduh) aplikasi|paid promote"
)
# "Pertanyaan dari gua/dia" is a reported question, not a host reading the next viewer's one.
_PERSONAL = r"(?:gua|gue|gw|aku|saya|lu|lo|elu|kamu|dia|beliau|mereka|kita|kami)"
_SEGUE = _alternation(
    r"(?:oke|ok|oke deh|baik|nah|yuk) (?:kita )?(?:lanjut|next|masuk)|kita lanjut|"
    r"lanjut ke (?:pertanyaan|segmen|topik|sesi)|pertanyaan-pertanyaan dari|"
    r"pertanyaan (?:dari |dari para )?(?:member|temen-temen|teman-teman|netizen|penonton|"
    r"pendengar|warganet)|pertanyaan (?:berikutnya|selanjutnya)|next question|"
    r"segmen (?:berikutnya|selanjutnya)|kita masuk ke (?:segmen|pertanyaan|sesi)|"
    r"kita break dulu|jeda (?:iklan|sebentar)|pertanyaan terakhir|"
    r"(?:satu|dua|tiga|\d+) pertanyaan (?:lagi|terakhir)|(?:kita )?(?:terakhir )?ke pertanyaan|"
    rf"pertanyaan dari (?!{_PERSONAL}(?![\w-]))[^\W\d_][\w-]*"
)
# "Oke, terakhir dari Gelipot." reads the next viewer question; only as the opening words.
_SEGUE_HEAD = re.compile(
    r"^(?:(?:oke|ok|nah|ya|baik) )*(?:terakhir|selanjutnya|berikutnya|next) dari "
    rf"(?!{_PERSONAL}(?![\w-]))[^\W\d_]"
)
_GREETING = _alternation(
    r"selamat datang|welcome (?:back|to)|"
    r"(?:halo|hai|hi|hello) (?:semua|semuanya|guys|gaes|teman-teman|temen-temen|sobat)|"
    r"(?:balik|kembali) lagi (?:di|bersama|sama|ke|dengan)|assalamualaikum"
)
_OUTRO = _alternation(
    r"terima ?kasih (?:sudah|udah|telah) (?:nonton|menonton|mendengarkan|dengerin|nyimak|"
    r"menyaksikan|datang|dateng|hadir|mampir)|"
    r"makasih (?:ya )?(?:sudah|udah) (?:nonton|dateng|datang|mampir)|sampai jumpa|see you|"
    r"jangan lupa (?:subscribe|like|follow|share|komen|comment)|"
    r"(?:like|subscribe)(?: dan| and|,)? (?:subscribe|share|comment|komen)|wassalamualaikum|"
    r"bye bye"
)
_PRONOUN_LEAD = _set(
    "dia itu yang tadi nya mereka beliau terus trus dan tapi cuma sama atau abis habis makanya "
    "soalnya karena gitu begitu kayak iya heeh juga"
)
_BACKREF = _alternation(r"tadi|barusan|sebelumnya|yang kemarin")
_CONNECTORS = _set(
    "dan terus trus tapi karena soalnya yang kalau kalo sama atau sampai sampe buat untuk "
    "sambil biar supaya di ke dari nya dengan tanpa bahwa kayak seperti padahal sehingga"
)
_DANGLING = _alternation(r"jadi gini|gini|begini|yaitu|contohnya|misalnya")
_HUMOR_REMARK = _alternation(r"lucu|ngakak|kocak|ngelawak|jayus")
_EMOTIONAL = _alternation(
    r"gila|anjir|anjing|bangsat|nangis|menangis|sedih|marah|kesel|kesal|takut|seneng|senang|"
    r"bahagia|kaget|syok|shock|merinding|parah|sakit|cinta|kangen|bangga|terharu|kecewa|stres|"
    r"capek|ngakak|lucu|astaga|ya ampun|waduh"
)
_RELATABLE = _alternation(
    r"uang|duit|cuan|gaji|utang|hutang|kaya|miskin|harga|mahal|bayar|cicilan|cinta|"
    r"pacar(?:an)?|nikah(?:an)?|menikah|istri|suami|mantan|cerai|selingkuh|jodoh|dating|anak|"
    r"orang ?tua|ortu|ibu|ayah|nyokap|bokap|mama|papa|keluarga|kerja(?:an)?|kantor|bos|"
    r"karyawan|kuliah|sekolah|tuhan|agama|dosa|doa|polisi|penjara|kasus|korban|kanker|mental|"
    r"depresi|burnout|trauma|viral|netizen|tiktok|hantu|mistis|narkoba|judi|rokok"
)
_CONFLICT = _alternation(
    r"debat|berantem|ribut|marah|kesel|musuh|benci|fitnah|di-?cancel|protes|konflik|"
    r"(?:ber)?tengkar|nyindir|sindir"
)
_PAIN = _alternation(
    r"capek|lelah|gaji|macet|stres|jomblo|galau|burnout|cicilan|utang|hutang|lembur|insecure|"
    r"overthinking|susah|sulit|kerja(?:an)?|kantor"
)
_TIPS = _alternation(r"tips|caranya|jangan|supaya|sebaiknya|mending|kuncinya|langkah(?:nya)?")
_SAD = _alternation(
    r"nangis|menangis|sedih|meninggal|terharu|kangen|rindu|kehilangan|takut|trauma|sakit|"
    r"bersyukur"
)
_MARKER_WORDS = _set(
    "jujur sumpah ternyata sebenernya sebenarnya faktanya aslinya padahal justru malah pernah "
    "rahasia kode istilah gila parah anjir anjing bangsat malu nyesel hampir nyaris katanya "
    "bilang ngomong haha hahaha wkwk akhirnya makanya intinya pokoknya tertawa ketawa"
)

_TAG_LABELS = {
    "confession": "pengakuan",
    "insider": "rahasia orang dalam",
    "reveal": "pengungkapan",
    "contrast": "kontras",
    "stakes": "taruhan besar",
    "superlative": "superlatif",
    "number": "angka/uang",
    "reported": "kutipan ucapan",
    "story": "cerita",
}
_ARCHETYPE_LABELS = {
    "curiosity_gap": "Pertanyaan menarik",
    "controversial_claim": "Pernyataan berani",
    "confession": "Pengakuan jujur",
    "insider_secret": "Rahasia orang dalam",
    "story_twist": "Cerita tak terduga",
    "number_proof": "Fakta angka",
    "conflict": "Beda pendapat",
    "humor": "Momen lucu",
    "relatable_pain": "Curhat relate",
    "emotional": "Momen emosional",
    "practical_tip": "Tips praktis",
    "other": "Obrolan pilihan",
}
_OPENER_REASONS = {
    "question": "Dibuka dengan pertanyaan yang langsung dijawab {run:.0f} detik tanpa disela "
    "pertanyaan lain.",
    "setup": "Dibuka dari kalimat pengantar sebelum pertanyaan singkat, lalu dijawab {run:.0f} "
    "detik.",
    "story": "Dibuka dengan penanda cerita/anekdot sehingga penonton langsung masuk ke kisahnya.",
    "contrast": "Dibuka dengan pernyataan kontras/identitas (bukan … tapi …).",
    "reveal": "Dibuka dengan penanda pengakuan/pengungkapan (jujur, ternyata, sebenernya).",
    "number": "Dibuka dengan angka/uang yang konkret.",
    "cold_open": "Kalimat pertama video, cocok sebagai pembuka (cold open).",
    "plain": "Dimulai di batas kalimat yang bersih.",
}


# --- per-unit analysis -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Unit:
    start: float
    end: float
    gap_before: float
    text: str
    tokens: tuple[str, ...]  # casefolded words without pure fillers
    content: tuple[str, ...]
    raw_tokens: int
    fillers: int
    question: bool
    breaks_answer: bool
    backchannel: bool
    reaction: bool
    text_laughs: int  # spelled-out laughs ("Hahaha")
    laugh_first: bool  # the unit opens with one, so it follows the unit before
    remark: bool  # a short "Lucu banget." about the unit before
    tags: frozenset[str]
    strength: float
    opener: str | None
    recap: bool
    sponsor: bool
    segue: bool
    greeting: bool
    outro: bool
    pronoun_led: bool
    backref: bool
    terminal: bool
    connector_start: bool
    dangling: bool
    emotional: int
    numbers: int
    relatable: int
    suspect: bool

    @property
    def duration(self) -> float:
        return self.end - self.start


def _words(text: str) -> list[str]:
    return _WORD.findall(text.casefold())


def _count(pattern: re.Pattern[str], joined: str) -> int:
    return len(pattern.findall(joined))


def _terminal(text: str) -> bool:
    stripped = text.rstrip().rstrip(_CLOSERS).rstrip()
    return bool(stripped) and stripped[-1] in ".!?…。！？"


def _reply_led(text: str, tokens: Sequence[str]) -> bool:
    """True when a unit opens with a bare reply ("Nggak, nggak ya. Oke. Asal dari?")."""
    sentences = [_words(part) for part in _SENTENCE.findall(text)]
    sentences = [words for words in sentences if words]
    if len(sentences) < 2:
        return False
    replies = _BACKCHANNEL | _REACTION_CORE
    return all(word in replies for word in sentences[0]) and len(tokens) > len(sentences[0])


def _analyse_unit(unit: SentenceUnit) -> _Unit:
    raw = _words(unit.text)
    tokens = tuple(token for token in raw if token not in _FILLERS)
    joined = " ".join(tokens)
    head = " ".join(tokens[:6])
    tags = frozenset(
        name for name, (_w, pattern) in _HOOK_LEXICON.items() if pattern.search(joined)
    )
    if any(mark in unit.text for mark in ('"', "“", "”")):
        tags = tags | {"reported"}
    percents = unit.text.count("%")
    if percents:
        tags = tags | {"number"}
    content = tuple(
        token
        for token in tokens
        if token not in _STOPWORDS and len(token) >= 3 and not token.isdigit()
    )
    weight = min(5.0, sum(_HOOK_LEXICON[name][0] for name in tags))
    substance = 1.0 if len(tokens) >= 6 else 0.7 if len(tokens) >= 4 else 0.4
    strength = weight * substance * (0.3 if unit.suspect else 1.0)
    opener = None
    if _STORY_OPENER.search(head):
        opener = "story"
    elif _CONTRAST_OPENER.search(joined):
        opener = "contrast"
    elif _REVEAL_OPENER.search(head):
        opener = "reveal"
    elif "number" in tags:
        opener = "number"
    first = tokens[0] if tokens else ""
    backchannel = len(tokens) <= 4 and all(token in _BACKCHANNEL for token in tokens)
    reaction = (
        0 < len(tokens) <= 5
        and all(token in _REACTION or token in _BACKCHANNEL for token in tokens)
        and any(token in _REACTION_CORE for token in tokens)
    )
    return _Unit(
        start=float(unit.start),
        end=float(unit.end),
        gap_before=float(unit.gap_before),
        text=unit.text,
        tokens=tokens,
        content=content,
        raw_tokens=len(raw),
        fillers=sum(1 for token in raw if token in _FILLERS),
        question=unit.is_question,
        # A tag question without content ("Lu ngerti kan?", "Siapa coba?") is rhetorical and
        # does not interrupt an answer.
        # A host reaction ("Hah? Serius?") does not either.
        breaks_answer=unit.is_question and bool(content) and not reaction,
        backchannel=backchannel,
        reaction=reaction,
        text_laughs=sum(1 for token in raw if _LAUGH_TOKEN.fullmatch(token)),
        laugh_first=bool(raw) and bool(_LAUGH_TOKEN.fullmatch(raw[0])),
        remark=len(tokens) <= 5 and bool(_HUMOR_REMARK.search(joined)),
        tags=tags,
        strength=strength,
        opener=opener,
        recap=bool(_RECAP.match(" ".join(tokens[1:] if first in {"oh", "nah"} else tokens)))
        or bool(_OH_GITU.search(joined)),
        sponsor=bool(_SPONSOR.search(joined)),
        segue=bool(_SEGUE.search(joined) or _SEGUE_HEAD.match(joined)),
        greeting=bool(_GREETING.search(joined)),
        outro=bool(_OUTRO.search(joined)),
        pronoun_led=first in _PRONOUN_LEAD
        or tokens[:2] == ("nah", "itu")
        or _reply_led(unit.text, tokens),
        backref=bool(_BACKREF.search(joined)),
        terminal=_terminal(unit.text),
        connector_start=first in _CONNECTORS,
        dangling=bool(_DANGLING.search(" ".join(tokens[-2:]))) or unit.text.rstrip().endswith(":"),
        emotional=_count(_EMOTIONAL, joined),
        numbers=_count(_HOOK_LEXICON["number"][1], joined) + percents,
        relatable=_count(_RELATABLE, joined),
        suspect=unit.suspect,
    )


# --- episode context --------------------------------------------------------------------------


def _prefix(values: Sequence[float]) -> list[float]:
    total = [0.0]
    for value in values:
        total.append(total[-1] + value)
    return total


@dataclass(slots=True)
class _Context:
    units: list[_Unit]
    duration: float
    laughs: list[int]
    cheers: list[int]
    small_talk: list[bool]
    echo: list[bool]
    teaser_end: float | None
    line_value: list[float]
    answer_run: list[float]
    pause_after: list[float]
    intro_end: float
    outro_start: float
    filler_reference: float
    idf: dict[str, float]
    silence_starts: list[float] = field(default_factory=list)
    silence_ends: list[float] = field(default_factory=list)
    silence_prefix: list[float] = field(default_factory=list)
    silence_reference: float | None = None
    p_laughs: list[float] = field(default_factory=list)
    p_strong: list[float] = field(default_factory=list)
    p_cheers: list[float] = field(default_factory=list)
    p_emotional: list[float] = field(default_factory=list)
    p_numbers: list[float] = field(default_factory=list)
    p_relatable: list[float] = field(default_factory=list)
    p_salient: list[float] = field(default_factory=list)
    p_raw: list[float] = field(default_factory=list)
    p_fillers: list[float] = field(default_factory=list)
    p_suspect: list[float] = field(default_factory=list)
    p_small_talk: list[float] = field(default_factory=list)
    p_sponsor: list[float] = field(default_factory=list)
    p_segue: list[float] = field(default_factory=list)
    p_outro: list[float] = field(default_factory=list)
    p_echo: list[float] = field(default_factory=list)
    continued: list[bool] = field(default_factory=list)

    def between(self, prefix: list[float], first: int, last: int) -> float:
        return prefix[last + 1] - prefix[first]

    def quiet(self, start: float, end: float) -> float:
        """Seconds of silence inside ``[start, end]`` from the audio timeline."""
        if not self.silence_starts or end <= start:
            return 0.0
        first = bisect_right(self.silence_ends, start)
        last = bisect_left(self.silence_starts, end)
        if first >= last:
            return 0.0
        total = self.silence_prefix[last] - self.silence_prefix[first]
        total -= max(0.0, start - self.silence_starts[first])
        total -= max(0.0, self.silence_ends[last - 1] - end)
        return max(0.0, total)


def _laughter(units: list[_Unit], events: Sequence[SoundEvent]) -> tuple[list[int], list[int]]:
    """Laughter and applause counts per unit; an event belongs to the unit it follows."""
    starts = [unit.start for unit in units]
    laughs = [0] * len(units)
    cheers = [0] * len(units)
    for event in events:
        if event.kind not in ("laughter", "applause", "cheer", "shout"):
            continue
        owner = max(0, bisect_right(starts, event.time - 0.4) - 1)
        if event.kind == "laughter":
            laughs[owner] += 1
        else:
            cheers[owner] += 1
    if not any(laughs):
        # Without laughter tags (Whisper, automatic captions) the transcript may still spell a
        # laugh out ("Hahaha") or remark on the joke ("Lucu banget."). Either counts as one laugh
        # after the line it follows. A track that tags laughter is trusted as it is.
        for index, unit in enumerate(units):
            if not unit.text_laughs and not unit.remark:
                continue
            follows = unit.laugh_first or not unit.text_laughs
            laughs[index - 1 if follows and index > 0 else index] = 1
    return laughs, cheers


def _choppy(unit: _Unit) -> bool:
    """A very short turn, or a unit made of several one-to-three-word sentences."""
    if len(unit.tokens) <= _SMALL_TALK_TOKENS:
        return True
    sentences = [len(_words(part)) for part in _SENTENCE.findall(unit.text) if _words(part)]
    return len(sentences) >= 2 and sum(sentences) / len(sentences) <= 3.5


def _small_talk(units: list[_Unit]) -> list[bool]:
    """Units inside runs of very short Q/A turns (names, origins, logistics).

    Sentence units merge short turns, so a unit of several tiny sentences counts as short too,
    and a host question of up to ten words may sit inside the run. Any line with real hook
    evidence breaks the run: punchy banter with content is not small talk.
    """
    flags = [False] * len(units)
    index = 0

    def asks(unit: _Unit) -> bool:
        # A host reaction ("Hah? Serius?") is banter, not a small-talk question.
        return not unit.reaction and (unit.question or "?" in unit.text)

    def member(unit: _Unit) -> bool:
        asking = asks(unit)
        short = _choppy(unit) or (asking and len(unit.tokens) <= 10)
        return short and unit.strength < 1.5

    while index < len(units):
        stop = index
        while stop < len(units) and member(units[stop]):
            stop += 1
        run = units[index:stop]
        questions = sum(asks(unit) for unit in run)
        if len(run) >= _SMALL_TALK_RUN and questions >= _SMALL_TALK_QUESTIONS:
            for position in range(index, stop):
                flags[position] = True
        index = max(stop, index + 1)
    return flags


def _teaser(units: list[_Unit], duration: float) -> tuple[float | None, list[bool]]:
    """Detect a pre-roll teaser montage: early lines that recur verbatim later in the video.

    Returns the teaser end time (or None) and flags for the later originals.
    """
    limit = min(_TEASER_SECONDS, _TEASER_SHARE * duration)
    grams: dict[tuple[str, ...], list[int]] = {}
    for index, unit in enumerate(units):
        if unit.start < limit:
            continue
        tokens = unit.tokens
        for offset in range(len(tokens) - _TEASER_GRAM + 1):
            grams.setdefault(tokens[offset : offset + _TEASER_GRAM], []).append(index)
    echoes: list[int] = []
    targets: Counter[int] = Counter()
    for index, unit in enumerate(units):
        if unit.start >= limit:
            break
        tokens = unit.tokens
        own = [
            tokens[offset : offset + _TEASER_GRAM]
            for offset in range(len(tokens) - _TEASER_GRAM + 1)
        ]
        matched = [gram for gram in own if 1 <= len(grams.get(gram, ())) <= 2]
        if len(matched) >= 2 and len(matched) >= 0.4 * len(own):
            echoes.append(index)
            for gram in matched:
                targets.update(set(grams[gram]))
    flags = [False] * len(units)
    if len(echoes) < _TEASER_MIN_UNITS or units[echoes[0]].start > _TEASER_FIRST_ECHO_SECONDS:
        return None, flags
    if len(echoes) < 0.5 * (echoes[-1] + 1):
        return None, flags
    for index, hits in targets.items():
        if hits >= 2:
            flags[index] = True
    return units[echoes[-1]].end, flags


def teaser_end(units: Sequence[SentenceUnit]) -> float | None:
    """Where the pre-roll teaser montage the heuristic skips ends (early lines that recur
    verbatim later in the video), or ``None`` when the episode opens without one."""
    analysed = [_analyse_unit(unit) for unit in units]
    if not analysed:
        return None
    return _teaser(analysed, analysed[-1].end)[0]


def opening_end(units: Sequence[SentenceUnit]) -> float | None:
    """Where the episode's opening ends: the later of the teaser montage's end
    (:func:`teaser_end`) and :data:`GREETING_REACH_SECONDS` after the last channel greeting
    said in the intro (the greetings the heuristic penalises: ``selamat datang``, ``halo
    semuanya``, ``kembali lagi di``, ... in the first ``max(90 s, 3%)`` of the episode), or
    ``None`` when the episode opens with neither."""
    analysed = [_analyse_unit(unit) for unit in units]
    if not analysed:
        return None
    duration = analysed[-1].end
    intro_end = max(_INTRO_SECONDS, _INTRO_SHARE * duration)
    ends = [end for end in (_teaser(analysed, duration)[0],) if end is not None]
    greetings = [unit.start for unit in analysed if unit.greeting and unit.start < intro_end]
    if greetings:
        ends.append(max(greetings) + GREETING_REACH_SECONDS)
    return max(ends, default=None)


def _pauses(units: list[_Unit], audio: AudioTimeline | None) -> list[float]:
    """Pause after each unit: the word gap, or a silence from the audio timeline.

    YouTube caption timings are contiguous, so their gaps hide real pauses; the relative
    silences of the audio timeline recover them.
    """
    pauses = [units[index + 1].gap_before for index in range(len(units) - 1)] + [2.0]
    if audio is None or not audio.silences:
        return pauses
    starts = [start for start, _end in audio.silences]
    ends = [end for _start, end in audio.silences]
    for index, unit in enumerate(units):
        position = bisect_left(ends, unit.end - 0.3)
        if position < len(starts) and starts[position] <= unit.end + 0.8:
            quiet = ends[position] - max(starts[position], unit.end - 0.3)
            pauses[index] = max(pauses[index], quiet)
    return pauses


def _answer_runs(units: list[_Unit]) -> list[float]:
    """Seconds of substantive answer after each unit, until the next real question.

    Only statements of at least four words count, so a run of one-word replies to quick
    questions (small talk) never looks like an answer. Questions without a content word
    ("Kenapa?", "Terus?", "Lu ngerti kan?") are follow-ups or rhetorical and do not end the run;
    a question with content, a segue or a long silence does. A question asked in parts ("Apa
    ketakutan lu? Keras atau lembut?") is answered after its last part, so up to two question
    units right after a question are skipped.
    """
    runs = [0.0] * len(units)
    for index in range(len(units)):
        total = 0.0
        asking = units[index].question
        for position in range(index + 1, len(units)):
            unit = units[position]
            asking = (
                asking
                and unit.question
                and position - index < _QUESTION_PARTS
                and unit.gap_before < _ANSWER_BREAK_GAP
            )
            if asking:
                continue
            if unit.breaks_answer or unit.segue or unit.gap_before >= _ANSWER_BREAK_GAP:
                break
            if unit.start - units[index].end > _ANSWER_HORIZON_SECONDS:
                break
            if not unit.question and len(unit.tokens) >= 4:
                total += unit.duration + min(unit.gap_before, 1.0)
            if total >= 4 * ANSWER_RUN_SECONDS:
                break
        runs[index] = total
    return runs


def _continuations(units: list[_Unit]) -> list[bool]:
    """Units that continue the previous unit's sentence.

    Caption and ASR lines are cut at pauses and speaker changes, often mid-sentence. In a
    transcript that capitalises sentence starts, a unit that opens in lowercase right after a
    unit without terminal punctuation is the rest of that sentence, however long the pause.
    All-lowercase transcripts carry no such signal, so nothing counts as a continuation.
    """
    letters = [next((char for char in unit.text if char.isalpha()), "") for unit in units]
    if sum(1 for letter in letters if letter.isupper()) < _CASED_SHARE * len(units):
        return [False] * len(units)
    return [
        index > 0 and not units[index - 1].terminal and letter.islower()
        for index, letter in enumerate(letters)
    ]


def _context(
    units: list[_Unit], events: Sequence[SoundEvent], audio: AudioTimeline | None
) -> _Context:
    duration = units[-1].end
    laughs, cheers = _laughter(units, events)
    strong = [
        count * (1.0 if len(unit.tokens) >= _SUBSTANTIVE_TOKENS else 0.35)
        for count, unit in zip(laughs, units, strict=True)
    ]
    teaser_end, echo = _teaser(units, duration)
    line_value = []
    for index, unit in enumerate(units):
        after = laughs[index] > 0 or (
            index + 1 < len(units) and laughs[index + 1] > 0 and len(units[index + 1].tokens) <= 3
        )
        value = unit.strength + (1.2 if after and len(unit.tokens) >= 4 else 0.0)
        value += 1.5 if echo[index] else 0.0
        value += 0.05 * min(len(unit.content), 10)
        line_value.append(min(value, 7.0))
    rates = sorted(
        unit.fillers / unit.raw_tokens for unit in units if unit.raw_tokens >= _SUBSTANTIVE_TOKENS
    )
    median = rates[len(rates) // 2] if rates else 0.0
    documents = Counter(token for unit in units for token in set(unit.content))
    count = len(units)
    idf = {token: math.log((count + 1) / (df + 1)) + 1.0 for token, df in documents.items()}
    salient_limit = max(3, _SALIENT_SHARE * count)
    ctx = _Context(
        units=units,
        duration=duration,
        laughs=laughs,
        cheers=cheers,
        small_talk=_small_talk(units),
        echo=echo,
        teaser_end=teaser_end,
        line_value=line_value,
        answer_run=_answer_runs(units),
        pause_after=_pauses(units, audio),
        intro_end=max(_INTRO_SECONDS, _INTRO_SHARE * duration),
        outro_start=duration - max(_OUTRO_SECONDS, _OUTRO_SHARE * duration),
        filler_reference=max(median, _FILLER_FLOOR),
        idf=idf,
    )
    if audio is not None and audio.silences:
        ctx.silence_starts = [start for start, _end in audio.silences]
        ctx.silence_ends = [end for _start, end in audio.silences]
        ctx.silence_prefix = _prefix([end - start for start, end in audio.silences])
        ctx.silence_reference = ctx.silence_prefix[-1] / max(audio.duration, _EPSILON)
    elif audio is not None:
        ctx.silence_reference = 0.0
    ctx.p_laughs = _prefix(laughs)
    ctx.p_strong = _prefix(strong)
    ctx.p_cheers = _prefix(cheers)
    ctx.p_emotional = _prefix([unit.emotional for unit in units])
    ctx.p_numbers = _prefix([unit.numbers for unit in units])
    ctx.p_relatable = _prefix([unit.relatable for unit in units])
    ctx.p_salient = _prefix(
        [sum(1 for token in unit.content if documents[token] <= salient_limit) for unit in units]
    )
    ctx.p_raw = _prefix([unit.raw_tokens for unit in units])
    ctx.p_fillers = _prefix([unit.fillers for unit in units])
    ctx.p_suspect = _prefix([unit.duration if unit.suspect else 0.0 for unit in units])
    ctx.p_small_talk = _prefix([float(flag) for flag in ctx.small_talk])
    ctx.p_sponsor = _prefix([float(unit.sponsor) for unit in units])
    ctx.p_segue = _prefix([float(unit.segue) for unit in units])
    ctx.p_outro = _prefix([float(unit.outro and unit.end >= ctx.outro_start) for unit in units])
    ctx.p_echo = _prefix([float(flag) for flag in echo])
    ctx.continued = _continuations(units)
    return ctx


# --- starts, ends and window scores -----------------------------------------------------------


def _sentence_start(ctx: _Context, index: int) -> int:
    """The unit where the sentence of ``units[index]`` begins (at most a few units back)."""
    units = ctx.units
    begin = index
    while begin > 0 and index - begin < _SENTENCE_WALK_BACK and ctx.continued[begin]:
        previous = units[begin - 1]
        if previous.suspect or previous.backchannel or previous.segue:
            break
        begin -= 1
    return begin


def _starts(ctx: _Context) -> list[tuple[int, str]]:
    units = ctx.units
    kinds: dict[int, str] = {}
    for index, unit in enumerate(units):
        if unit.suspect or unit.backchannel or not unit.tokens:
            continue
        if unit.reaction:
            continue  # "Hah? Serius?" reacts to the line before it
        if (
            unit.question
            and len(unit.content) >= QUESTION_MIN_CONTENT
            and ctx.answer_run[index] >= ANSWER_RUN_SECONDS
        ):
            # A question cut at a pause or a speaker change starts where its sentence starts;
            # a host reading a viewer's question ("Satu pertanyaan dari X, …?") is one too.
            kinds[_sentence_start(ctx, index)] = "question"
            continue
        if unit.segue or ctx.continued[index]:
            continue  # never start on a segue or mid-sentence
        following = units[index + 1] if index + 1 < len(units) else None
        kind: str | None = None
        if (
            following is not None
            and following.question
            and len(following.tokens) <= _SHORT_QUESTION_TOKENS
            and following.gap_before <= _TIGHT_SETUP_SECONDS
            and ctx.answer_run[index + 1] >= ANSWER_RUN_SECONDS
            and not unit.question
            and len(unit.tokens) >= 4
        ):
            kind = "setup"
        elif unit.opener is not None:
            kind = unit.opener
        elif index == 0 and not unit.greeting:
            kind = "cold_open"
        elif (
            (
                index == 0
                or units[index - 1].terminal
                or ctx.pause_after[index - 1] >= _PAUSE_SECONDS
            )
            and not unit.pronoun_led
            and len(unit.tokens) >= 4
        ):
            kind = "plain"
        if kind is not None:
            kinds[index] = kind
    return sorted(kinds.items())


# Questions open 67-75% of gold moments but also almost half of all 16 s stretches, so the
# credit is deliberately small (larger credits lowered recall on the tuning episodes).
_OPENER_CREDIT = {
    "question": 1.0,
    "setup": 1.0,
    "story": 0.75,
    "contrast": 0.75,
    "reveal": 0.75,
    "number": 0.5,
    "cold_open": 0.75,
    "plain": 0.0,
}


def _standalone(ctx: _Context, start: int, kind: str) -> float:
    units = ctx.units
    unit = units[start]
    score = 6.0 + _OPENER_CREDIT[kind]
    if unit.pronoun_led:
        score -= PRONOUN_LEAD_PENALTY
    if unit.backchannel:
        score -= 4.0
    if any(item.backref for item in units[start : start + 2]):
        score -= 1.5
    if kind == "question" and unit.question and len(unit.tokens) <= _SHORT_QUESTION_TOKENS - 1:
        score -= 1.0
    if start == 0 or ctx.pause_after[start - 1] >= _PAUSE_SECONDS or units[start - 1].terminal:
        score += 0.5
    return _clip(score)


def _laugh_end(ctx: _Context, start: int, end: int) -> int | None:
    """The unit whose laughter/applause the clip ends on, if it ends right after one.

    That is the last unit, or the one before it when the last unit is only a short
    backchannel ("Iya, bener.") after the laugh.
    """
    if ctx.laughs[end] or ctx.cheers[end]:
        return end
    unit = ctx.units[end]
    if end > start and (ctx.laughs[end - 1] or ctx.cheers[end - 1]) and len(unit.tokens) <= 4:
        return end - 1
    return None


def _payoff(ctx: _Context, start: int, end: int) -> float:
    units = ctx.units
    unit = units[end]
    following = units[end + 1] if end + 1 < len(units) else None
    gap_after = ctx.pause_after[end]
    continues = following is not None and ctx.continued[end + 1]  # a pause, not a sentence end
    score = 3.0
    laughed = _laugh_end(ctx, start, end) is not None
    if laughed:
        score += LAUGH_END_BONUS
    if unit.terminal and gap_after >= _PAUSE_SECONDS:
        score += 2.5
    elif gap_after >= _PAUSE_SECONDS and not continues:
        score += 1.5
    elif unit.terminal:
        score += 1.0
    if unit.recap or (end > start and len(unit.tokens) <= 4 and units[end - 1].recap):
        score += RECAP_END_BONUS
    if unit.question and not unit.backchannel:
        score -= 4.0
    if unit.dangling:
        score -= 2.0
    if (
        following is not None
        and not laughed
        and not unit.terminal
        and (continues or (gap_after < 0.3 and following.connector_start))
    ):
        score -= 2.5
    if unit.segue:
        score -= 3.0
    elif following is not None and following.segue:
        score += 1.0
    return _clip(score)


def _clip(value: float) -> float:
    return min(10.0, max(0.0, value))


@dataclass(slots=True)
class _Window:
    start: int
    end: int
    kind: str
    hook_unit: int
    score: float
    dims: dict[str, float]
    penalties: dict[str, float]
    silence: float | None
    choice: float  # the score used to pick the end for one start (full laugh-end credit)
    zone_end: int = -1  # last unit of the hook zone (for packaging fallbacks)


def _assess(
    ctx: _Context, start: int, end: int, kind: str, hook_unit: int, hook_value: float
) -> _Window:
    units = ctx.units
    first, last = units[start], units[end]
    duration = max(last.end - first.start, _EPSILON)
    minutes = duration / 60.0

    hook = 2.0 + HOOK_LINE_SLOPE * hook_value
    if kind in ("question", "setup"):
        hook += ANSWERED_QUESTION_BONUS
    standalone = _standalone(ctx, start, kind)
    payoff = _payoff(ctx, start, end)

    penalties: dict[str, float] = {}
    laughs = ctx.between(ctx.p_laughs, start, end)
    strong = ctx.between(ctx.p_strong, start, end)
    cheers = ctx.between(ctx.p_cheers, start, end)
    emotional = ctx.between(ctx.p_emotional, start, end)
    emotion = 2.0 + 1.6 * min(strong, 3.0) + 1.5 * min(cheers, 2.0) + 0.4 * min(emotional, 4.0)
    # Dense laughter is a trap when it follows fragments or garbled ASR, not full lines.
    weak = laughs > 0 and strong < 0.5 * laughs
    garbled = ctx.between(ctx.p_suspect, start, end) / duration >= 0.2
    if laughs / minutes >= _DENSE_LAUGHS_PER_MINUTE and (weak or garbled):
        emotion = min(emotion, 6.0)
        penalties["dense_laughs"] = DENSE_LAUGH_PENALTY

    numbers = ctx.between(ctx.p_numbers, start, end)
    relatable = ctx.between(ctx.p_relatable, start, end)
    salient = ctx.between(ctx.p_salient, start, end)
    shareability = 2.0 + 0.8 * min(numbers, 3.0) + 0.7 * min(relatable, 4.0)
    shareability += 2.0 * min(salient / SALIENT_SATURATION, 1.0)

    dims = {
        "hook": _clip(hook),
        "standalone": standalone,
        "payoff": payoff,
        "emotion": _clip(emotion),
        "shareability": _clip(shareability),
    }

    suspect = ctx.between(ctx.p_suspect, start, end) / duration
    if suspect > 0:
        penalties["suspect"] = SUSPECT_PENALTY * min(suspect, 1.0)
    if ctx.between(ctx.p_sponsor, start, end) > 0:
        penalties["sponsor"] = SPONSOR_PENALTY
    if end > start and ctx.between(ctx.p_segue, start + 1, end) > 0:
        penalties["segue"] = SEGUE_PENALTY
    if ctx.between(ctx.p_outro, start, end) > 0:
        penalties["outro"] = OUTRO_PENALTY
    if first.start < ctx.intro_end and any(item.greeting for item in units[start : start + 2]):
        penalties["greeting"] = GREETING_PENALTY
    if ctx.teaser_end is not None and first.start < ctx.teaser_end:
        penalties["teaser"] = TEASER_PENALTY
    small_talk = ctx.between(ctx.p_small_talk, start, end) / (end - start + 1)
    if small_talk >= SMALL_TALK_SHARE:
        penalties["small_talk"] = SMALL_TALK_PENALTY * min(small_talk, 1.0)
    raw = ctx.between(ctx.p_raw, start, end)
    if raw >= 20:
        ratio = ctx.between(ctx.p_fillers, start, end) / raw / ctx.filler_reference
        if ratio > 1.5:
            penalties["fillers"] = min(FILLER_PENALTY_MAX, 0.75 * (ratio - 1.5))

    bonus = 0.0
    silence = None
    if ctx.silence_reference is not None:
        silence = ctx.quiet(first.start, last.end) / duration
        reference = max(ctx.silence_reference, 0.05)
        bonus = SILENCE_BONUS * min(1.0, max(0.0, (silence - ctx.silence_reference) / reference))

    combined = (
        W_HOOK * dims["hook"]
        + W_STANDALONE * dims["standalone"]
        + W_PAYOFF * dims["payoff"]
        + W_EMOTION * dims["emotion"]
        + W_SHAREABILITY * dims["shareability"]
        + bonus
        - sum(penalties.values())
    )
    ranked = combined
    if _laugh_end(ctx, start, end) is not None:
        ranked -= W_PAYOFF * LAUGH_END_BONUS * (1.0 - LAUGH_RANK_SHARE)
    return _Window(
        start, end, kind, hook_unit, _clip(ranked), dims, penalties, silence, choice=combined
    )


def _search(ctx: _Context, min_duration: float, max_duration: float) -> list[_Window]:
    """The best-scoring end for every candidate start, per third of the duration range.

    Keeping a short, a medium and a long option per start lets the diversity pass fall back
    to a shorter clip when the best one overlaps an earlier pick.

    The hook zone depends on the start only (the first ~40% of the longest allowed clip,
    between 8 and 24 s), so choosing a later end never "buys" a better hook. Lines inside the
    zone are not discounted by their offset: the strongest line usually comes seconds after
    the natural start, and the cold open can move it to the front.
    """
    units = ctx.units
    reach = min(HOOK_ZONE_MAX_SECONDS, max(HOOK_ZONE_MIN_SECONDS, HOOK_ZONE_SHARE * max_duration))
    span = max(max_duration - min_duration, _EPSILON)
    best: list[_Window] = []
    for start, kind in _starts(ctx):
        origin = units[start].start
        zone = start
        hook_unit, hook_value = start, -1.0
        chosen: list[_Window | None] = [None] * DURATION_BUCKETS
        for end in range(start, len(units)):
            duration = units[end].end - origin
            if duration > max_duration + _EPSILON:
                break
            while zone <= end and (zone == start or units[zone].start <= origin + reach):
                if ctx.line_value[zone] > hook_value + _EPSILON:
                    hook_unit, hook_value = zone, ctx.line_value[zone]
                zone += 1
            if duration < min_duration - _EPSILON:
                continue
            window = _assess(ctx, start, end, kind, hook_unit, hook_value)
            window.zone_end = zone - 1
            bucket = min(
                DURATION_BUCKETS - 1, int(DURATION_BUCKETS * (duration - min_duration) / span)
            )
            current = chosen[bucket]
            if current is None or window.choice > current.choice + _EPSILON:
                chosen[bucket] = window
        options = [window for window in chosen if window is not None]
        if options:
            # The end preferred with full laugh credit must also rank first for this start;
            # the other lengths stay available as fallbacks when it overlaps an earlier pick.
            preferred = max(options, key=lambda window: (window.choice, -window.end))
            for window in options:
                if window is not preferred:
                    window.score = min(window.score, max(0.0, preferred.score - _EPSILON))
            best.extend(options)
    return best


# --- diversity --------------------------------------------------------------------------------


def _topic(ctx: _Context, window: _Window) -> frozenset[str]:
    return frozenset(
        token
        for unit in ctx.units[window.start : window.end + 1]
        for token in unit.content
        if len(token) >= 4
    )


def _similarity(first: frozenset[str], second: frozenset[str]) -> float:
    if not first or not second:
        return 0.0
    return len(first & second) / math.sqrt(len(first) * len(second))


def _overlap_ratio(first: _Window, second: _Window, units: list[_Unit]) -> float:
    """Temporal intersection over union of two windows."""
    low = max(units[first.start].start, units[second.start].start)
    high = min(units[first.end].end, units[second.end].end)
    if high <= low:
        return 0.0
    union = max(units[first.end].end, units[second.end].end) - min(
        units[first.start].start, units[second.start].start
    )
    return (high - low) / union


def _diverse(
    ctx: _Context, windows: list[_Window], limit: int
) -> list[tuple[_Window, float, float]]:
    """Greedy non-overlapping picks with a topic-similarity penalty (MMR).

    The ranking score picks the moment; among near-duplicate windows of that moment (time IoU of
    at least :data:`SAME_MOMENT_IOU`) the one with the best cut (full laugh-end credit) is kept.
    """
    ordered = sorted(windows, key=lambda item: (-item.score, item.start, item.end))
    topics = [_topic(ctx, window) for window in ordered]
    similarity = [0.0] * len(ordered)
    alive = list(range(len(ordered)))
    picked: list[tuple[_Window, float, float]] = []
    while alive and len(picked) < limit:
        best_position = -1
        best_value = -math.inf
        for position, index in enumerate(alive):
            window = ordered[index]
            if window.score <= best_value:
                break
            value = window.score - DIVERSITY_WEIGHT * similarity[index]
            if value > best_value + _EPSILON:
                best_value, best_position = value, position
        region = ordered[alive[best_position]]
        best_cut = region.choice - DIVERSITY_WEIGHT * similarity[alive[best_position]]
        for position, index in enumerate(alive):
            window = ordered[index]
            if _overlap_ratio(window, region, ctx.units) < SAME_MOMENT_IOU:
                continue
            cut = window.choice - DIVERSITY_WEIGHT * similarity[index]
            if cut > best_cut + _EPSILON:
                best_cut, best_position = cut, position
        index = alive.pop(best_position)
        window = ordered[index]
        picked.append((window, _clip(best_value), similarity[index]))
        survivors = []
        for other in alive:
            candidate = ordered[other]
            if candidate.start <= window.end and window.start <= candidate.end:
                continue
            similarity[other] = max(similarity[other], _similarity(topics[other], topics[index]))
            survivors.append(other)
        alive = survivors
    return picked


# --- packaging --------------------------------------------------------------------------------

_LEADING_NOISE = _set(
    "oh oke ok iya ya nah yah heeh he eh ee terus trus dan tapi aja sih kan gitu deh lah"
)
_TRAILING_NOISE = _set(
    "iya ya oke ok heeh he oh hmm gitu sih deh dong kan tuh nih bang kok lah loh"
)
_COMMON = _set(
    "menurut terlalu beberapa datang dateng bareng jangan bawa beda bikin dibikin pakai pake "
    "ngasih ambil suka main masuk keluar pergi pulang tinggal ketemu nyari cari tanya nanya "
    "jawab ngerasa merasa rasa kenal inget lupa paham coba langsung sering jarang pertama kedua "
    "ketiga terakhir sekali selalu sekitar teman temen abang kakak adik beneran bener betul "
    "puluh belas ratus ribu juta miliar cara bagian tempat besar penting enak gampang mudah "
    "kurang misal ibaratnya maksud kira sebentar bentar perlu ngeliat ngelihat dengerin "
    "ngobrol ngobrolin bahas ngebahas omong omongan jalan jalanin kerjain ngerjain lakukan "
    "melakukan membuat kasih dikasih mikirin pikiran kayanya kalo gimana makasih terima kasih "
    "banget orangnya dianya guanya guenya lunya sesuatu segitu begitu gitu-gitu semacam "
    "apalagi terutama tentang soal sebagai secara semua setiap memang emang sendiri doang "
    "bilangin ngomongin nonton ngeliatin liatin tanyain nanyain pikir kaget nomor"
)


_PARTICLES = _set("ya yah sih deh dong nih tuh loh lho")
_VOCATIVES = _set("bang bro brader cuy guys gaes gais bosku")
_TAIL_VOCATIVES = _set("kak mas mbak om pak bu bos")
_SELF = _set("gua gue gw aku saya lu lo loe elu kamu")
# "Kayak gitu" means "like that"; any other "gitu"/"gini" is a verbal tic.
_GITU_KEEP = _set("kayak kaya kek seperti kalau kalo udah emang memang bukan enggak nggak gak ga")
_QUOTE_LEAD = _LEADING_NOISE | _set("karena soalnya jadi makanya nah pas")
_MARKER_LEADS = _set(
    "jujur sumpah ternyata sebenernya sebenarnya faktanya aslinya padahal justru malah katanya "
    "pokoknya intinya"
)
_HEADLINE_LEAD = (
    _QUOTE_LEAD | _MARKER_LEADS | _set("kalau kalo terus trus dan tapi yang adalah bahwa")
)
# A pronoun right after these is a clause subject, so a headline can drop it.
_SUBJECT_AFTER = _set(
    "dan terus trus tapi jadi pas waktu karena soalnya kalau kalo makanya padahal sehingga biar "
    "supaya"
)
_REPORTED_LEAD = re.compile(
    r"^(?:(?:gua|gue|gw|aku|saya|dia|beliau|mereka|lu|lo|elu|kamu) (?:bilang|ngomong)|"
    r"kata (?:dia|gua|gue|orang|mereka|beliau)|katanya) "
)
_SPAN_BAD_START = (
    _CONNECTORS
    | _QUOTE_LEAD
    | _set("adalah yaitu yakni bahwa oleh bagi agar pun juga kan kok sih tuh nih nya")
)
# A cut line must not end on a word that needs a continuation ("…dicopet karena", "…gua enggak").
_OPEN_END = (
    _CONNECTORS
    | _SELF
    | _set(
        "itu ini ada dia kita kami mereka jadi pas waktu lagi mau udah sudah akan bakal harus emang "
        "memang adalah yaitu bahwa si sang para agar oleh bagi antara juga pun paling lebih sangat "
        "cuma cuman kan kok apa mana gimana kenapa enggak nggak gak ga engga tidak bukan belum "
        "sih tuh nih ya the a an of to and or coba bikin kasih cek pakai pake bisa pengen pengin "
        "bilang ngomong tanya nanya ambil cari nyari liat lihat denger dengar ngajak ajak tahu tau "
        "punya dapat dapet buka beli jual minta"
    )
    | _MARKER_LEADS
)
_QUOTE_MARKS = "\"'“”‘’«»"
_FUNCTION = _STOPWORDS | _CONNECTORS | _SELF
_WHISPER_HYPHEN = re.compile(r"(?<=[^\W_]) -(?=[^\W\d_])")
_TERMINALS = ".?!…"

_TITLE_PREFIX = {
    "curiosity_gap": "Obrolan",
    "controversial_claim": "Pendapat berani",
    "confession": "Pengakuan",
    "insider_secret": "Rahasia",
    "story_twist": "Cerita tak terduga",
    "number_proof": "Fakta angka",
    "conflict": "Beda pendapat",
    "humor": "Momen lucu",
    "relatable_pain": "Curhat",
    "emotional": "Momen haru",
    "practical_tip": "Tips",
    "other": "Obrolan",
}


def _norm(word: str) -> str:
    return "".join(_words(word))


def _span_weight(words: Sequence[str]) -> float:
    joined = " ".join(token for word in words for token in _words(word) if token not in _FILLERS)
    return sum(weight for weight, pattern in _HOOK_LEXICON.values() if pattern.search(joined))


def _content_count(words: Sequence[str]) -> int:
    tokens = [token for word in words for token in _words(word)]
    return sum(
        1 for token in tokens if token not in _STOPWORDS and len(token) >= 3 and token.isalpha()
    )


def _move_end(kept: list[str], removed: str) -> None:
    """Carry the terminal punctuation of a removed word over to the word before it."""
    mark = removed[-1:]
    if kept and mark in _TERMINALS + "," and kept[-1][-1:] not in _TERMINALS:
        kept[-1] = kept[-1].rstrip(",;:") + mark


def _drop_repeats(words: Sequence[str]) -> list[str]:
    """Remove stutters: one to three words said again right away ("gua gua", "yang yang")."""
    kept = list(words)
    changed = True
    while changed:
        changed = False
        for size in (3, 2, 1):
            index = 0
            while index + 2 * size <= len(kept):
                first = [_norm(word) for word in kept[index : index + size]]
                second = [_norm(word) for word in kept[index + size : index + 2 * size]]
                if first != second:
                    index += 1
                    continue
                mark = kept[index + 2 * size - 1][-1:]
                del kept[index + size : index + 2 * size]
                last = kept[index + size - 1]
                if mark in _TERMINALS + "," and last[-1:] not in _TERMINALS:
                    kept[index + size - 1] = last.rstrip(",;:") + mark
                changed = True
    return kept


def _tidy(words: Sequence[str]) -> list[str]:
    """One sentence without fillers, verbal tics, vocatives, stutters and edge backchannels."""
    kept: list[str] = []
    for word in words:
        norm = _norm(word)
        if not norm:
            continue
        like = bool(kept) and _norm(kept[-1]) in _GITU_KEEP
        if (
            norm in _FILLERS
            or norm in _PARTICLES
            or norm in _VOCATIVES
            or (norm in ("gitu", "gini") and not like)
        ):
            _move_end(kept, word)
            continue
        if len(norm) == 1 and not norm.isdigit():
            continue  # a stray caption letter ("K lu kayak …")
        if kept and word[:1].isupper() and word[1:] == word[1:].lower() and norm in _FUNCTION:
            word = word[:1].lower() + word[1:]  # a Whisper segment start inside the sentence
        kept.append(word)
    kept = _drop_repeats(kept)
    while len(kept) > 1 and _norm(kept[0]) in _LEADING_NOISE:
        kept.pop(0)
    while len(kept) > 1 and _norm(kept[-1]) in _TRAILING_NOISE | _TAIL_VOCATIVES:
        removed = kept.pop()
        _move_end(kept, removed)
    if kept:
        kept[0] = kept[0].lstrip("-–—,.;:")
    return [word for word in kept if _norm(word)]


def _clauses(text: str) -> list[tuple[list[str], bool]]:
    """Tidied sentences of one line, each with whether it ends on terminal punctuation."""
    text = _WHISPER_HYPHEN.sub("-", text.replace("...", "…"))
    sentences: list[tuple[list[str], bool]] = []
    current: list[str] = []
    for raw in text.split():
        word = raw.strip(_QUOTE_MARKS)
        if word.startswith(("-", "–")) and not current:
            word = word.lstrip("-–")
        if not word:
            continue
        current.append(word)
        stripped = word.rstrip(_CLOSERS)
        if stripped[-1:] in _TERMINALS:
            sentences.append((current, True))
            current = []
    if current:
        sentences.append((current, False))
    result = []
    for words, closed in sentences:
        tidy = _tidy(words)
        if not tidy:
            continue
        if tidy[-1].endswith("…"):  # trailing off is not a sentence end
            tidy[-1] = tidy[-1].rstrip("…. ")
            closed = False
        if tidy[-1]:
            result.append((tidy, closed and tidy[-1][-1:] in _TERMINALS))
    return result


def _finish(words: Sequence[str], closed: bool, max_chars: int) -> str:
    """Join, cut on a word boundary within ``max_chars`` and end on a word that closes a phrase.

    A cut or unfinished line never gets an ellipsis: it ends on its last complete phrase.
    """
    kept = list(words)
    cut = False
    while kept and len(" ".join(kept)) > max_chars:
        kept.pop()
        cut = True
    if kept and (cut or not closed):
        kept[-1] = kept[-1].rstrip(_TERMINALS + ",;:")
        while len(kept) > 1 and _norm(kept[-1]) in _OPEN_END:
            kept.pop()
            kept[-1] = kept[-1].rstrip(_TERMINALS + ",;:")
    line = " ".join(kept).strip(" ,;:-–—")
    if not line:
        return ""
    return line[0].upper() + line[1:]


def _fit_span(words: Sequence[str], closed: bool, max_chars: int) -> str:
    """The hookiest stretch of a sentence that fits ``max_chars``, finished on a whole phrase.

    Caption run-ons have no punctuation to split on, so every stretch that fits is scored by
    its hook words and content; stretches that open on a hook word, at a clause start or at
    the sentence end are preferred. The first finished stretch with two content words wins.
    """
    candidates: list[tuple[float, int, int]] = []
    for first in range(len(words)):
        last, length = first, len(words[first])
        while last + 1 < len(words) and length + 1 + len(words[last + 1]) <= max_chars:
            last += 1
            length += 1 + len(words[last])
        clause = first == 0 or words[first - 1][-1:] in ",;:"
        # The span opens on the hook words themselves (not one word before them).
        leads = _span_weight(words[first : first + 2]) > _span_weight(words[first + 1 : first + 2])
        value = _span_weight(words[first : last + 1]) - 0.01 * first
        value += 0.1 * min(_content_count(words[first : last + 1]), 6)
        value += (0.5 if clause else 0.0) + (0.8 if leads else 0.0)
        value += 0.3 if last == len(words) - 1 else 0.0
        if _norm(words[first]) in _SPAN_BAD_START:
            value -= 1.0
        candidates.append((value, first, last))
        if last == len(words) - 1:
            break
    for _value, first, last in sorted(candidates, key=lambda item: (-item[0], item[1])):
        line = _finish(words[first : last + 1], closed and last == len(words) - 1, max_chars)
        if _content_count(line.split()) >= 2:
            return line
    return ""


def _quote(text: str, max_chars: int = HOOK_TEXT_MAX_CHARS) -> tuple[str, list[str]]:
    """The best clean sentence of one line as on-screen text, plus that sentence's words.

    Sentences need at least three words and two content words, so a garbled or filler-only
    line gives ``("", [])`` and the caller falls back to another line.
    """
    best: tuple[float, list[str], bool] | None = None
    for words, closed in _clauses(text):
        while len(words) > 1 and _norm(words[0]) in _QUOTE_LEAD:
            words = words[1:]
        content = _content_count(words)
        if len(words) < 3 or content < 2:
            continue
        value = _span_weight(words) + 0.3 * min(content, 6) + (0.3 if closed else 0.0)
        if best is None or value > best[0] + _EPSILON:
            best = (value, words, closed)
    if best is None:
        return "", []
    _value, words, closed = best
    line = _fit_span(words, closed, max_chars)
    return (line, words) if line else ("", [])


def _clean_line(text: str, max_chars: int = HOOK_TEXT_MAX_CHARS) -> str:
    """One transcript line as clean on-screen text within ``max_chars`` (``""`` when unusable)."""
    return _quote(text, max_chars)[0]


def _headline(words: Sequence[str], max_chars: int) -> str:
    """A title phrase from one sentence: no leading pronoun, marker, connector or "gua bilang"."""
    kept = list(words)
    closed = bool(kept) and kept[-1][-1:] in _TERMINALS
    changed = True
    while changed and len(kept) > 2:
        changed = False
        reported = _REPORTED_LEAD.match(" ".join(_norm(word) for word in kept[:3]) + " ")
        if reported:
            del kept[: len(reported.group(0).split())]
            changed = True
        elif _norm(kept[0]) in _HEADLINE_LEAD | _SELF:
            kept.pop(0)
            changed = True
    result: list[str] = []
    for index, word in enumerate(kept):
        previous = kept[index - 1] if index else ""
        subject = previous[-1:] == "," or _norm(previous) in _SUBJECT_AFTER
        if _norm(word) in _SELF and subject and index + 1 < len(kept):
            continue
        result.append(word)
    # A trailing possessive ("band lama lu?") goes; an object ("tanpa gua") stays.
    while len(result) > 2 and _norm(result[-1]) in _SELF and _norm(result[-2]) not in _OPEN_END:
        removed = result.pop()
        _move_end(result, removed)
    if _content_count(result) < 2:
        return ""
    return _fit_span(result, closed, max_chars)


def _keywords(ctx: _Context, window: _Window, limit: int) -> list[str]:
    counts: Counter[str] = Counter(
        token
        for unit in ctx.units[window.start : window.end + 1]
        for token in unit.content
        if token.isalpha()
        and 4 <= len(token) <= 20
        and token not in _MARKER_WORDS
        and token not in _COMMON
    )

    def weight(token: str) -> tuple[float, str]:
        repeated = 1.0 if counts[token] >= 2 else 0.5
        return (-repeated * math.sqrt(counts[token]) * ctx.idf.get(token, 1.0), token)

    return sorted(counts, key=weight)[:limit]


def _funny(ctx: _Context, window: _Window, strong: float) -> bool:
    """Laughter well above the episode's own rate: banter-heavy episodes laugh everywhere."""
    minutes = (ctx.units[window.end].end - ctx.units[window.start].start) / 60.0
    expected = ctx.p_strong[-1] / max(ctx.duration / 60.0, _EPSILON) * minutes
    return strong >= 2 and strong >= HUMOR_LAUGH_EXCESS * expected + 1.0


def _archetype(ctx: _Context, window: _Window) -> str:
    units = ctx.units[window.start : window.end + 1]
    joined = " ".join(" ".join(unit.tokens) for unit in units)

    def tagged(name: str) -> int:
        return sum(1 for unit in units if name in unit.tags)

    strong = ctx.between(ctx.p_strong, window.start, window.end)
    evidence = {
        "confession": 2.0 * tagged("confession"),
        "insider_secret": 2.0 * tagged("insider"),
        "story_twist": 1.5 * tagged("reveal") + (1.0 if window.kind == "story" else 0.0),
        "number_proof": 1.2 * (tagged("number") - 1),
        "controversial_claim": 1.5 * tagged("contrast"),
        "conflict": 1.5 * _count(_CONFLICT, joined),
        "humor": 1.3 * strong if _funny(ctx, window, strong) else 0.0,
        "relatable_pain": 0.8 * _count(_PAIN, joined),
        "emotional": 1.0 * _count(_SAD, joined),
        "practical_tip": 0.8 * _count(_TIPS, joined),
    }
    order = list(evidence)
    best = max(order, key=lambda name: (evidence[name], -order.index(name)))
    if evidence[best] >= 1.5:
        return best
    return "curiosity_gap" if window.kind in ("question", "setup") else "other"


_OPENER_SUMMARY = {
    "question": "Dibuka dengan pertanyaan",
    "setup": "Dibuka dengan pengantar dan pertanyaan",
    "story": "Dibuka dengan cerita",
    "contrast": "Dibuka dengan pernyataan kontras",
    "reveal": "Dibuka dengan pengakuan",
    "number": "Dibuka dengan angka",
    "cold_open": "Dibuka dari kalimat pertama video",
    "plain": "Dibuka di awal kalimat",
}


def _ending_summary(ctx: _Context, window: _Window) -> str:
    last = ctx.units[window.end]
    if _laugh_end(ctx, window.start, window.end) is not None:
        return "ditutup tepat setelah tawa"
    if last.recap:
        return "ditutup dengan kesimpulan"
    return "ditutup di akhir kalimat" if last.terminal else "ditutup di jeda bicara"


def _clock(seconds: float) -> str:
    minutes, rest = divmod(round(seconds), 60)
    return f"{minutes:02d}:{rest:02d}"


def _reasons(
    ctx: _Context, window: _Window, hook_unit: int, hook_text: str, similarity: float
) -> list[str]:
    units = ctx.units
    first, last = units[window.start], units[window.end]
    # The anchoring question is the first one at or just after the start (setup, split line).
    anchor = range(window.start, min(window.start + _SENTENCE_WALK_BACK, window.end) + 1)
    run = next(
        (ctx.answer_run[index] for index in anchor if units[index].question),
        ctx.answer_run[window.start],
    )
    reasons = [_OPENER_REASONS[window.kind].format(run=run)]
    hook = units[hook_unit]
    labels = [_TAG_LABELS[name] for name in _HOOK_LEXICON if name in hook.tags]
    offset = hook.start - first.start
    detail = f" ({', '.join(labels)})" if labels else ""
    reasons.append(f"Kalimat hook terkuat di detik ke-{offset:.0f}: “{hook_text}”{detail}.")
    if ctx.echo[hook_unit] or ctx.between(ctx.p_echo, window.start, window.end) > 0:
        reasons.append("Kalimatnya juga dipakai di teaser pembuka video (dipilih editor kanal).")
    laughed = _laugh_end(ctx, window.start, window.end)
    gap_after = ctx.pause_after[window.end]
    if laughed is not None:
        reasons.append("Ditutup tepat setelah tawa/tepuk tangan, jadi payoff-nya utuh.")
    elif last.recap:
        reasons.append("Ditutup dengan kalimat kesimpulan (jadi/akhirnya/makanya).")
    elif last.terminal and gap_after >= _PAUSE_SECONDS:
        reasons.append(f"Ditutup di akhir kalimat dengan jeda {gap_after:.1f} detik.")
    elif last.question:
        reasons.append("Catatan: berakhir di pertanyaan, jawabannya di luar klip.")
    laughs = int(ctx.between(ctx.p_laughs, window.start, window.end))
    if laughs:
        reasons.append(f"Ada {laughs} tawa di dalam klip.")
    if window.silence is not None and window.silence > (ctx.silence_reference or 0.0):
        reasons.append(
            f"Ritme bicara lega: rasio hening {window.silence:.0%} di atas rata-rata episode."
        )
    penalty_text = {
        "teaser": "Penalti: tumpang-tindih dengan teaser pembuka (potongan berulang).",
        "sponsor": "Penalti: memuat iklan/sponsor (promo, kode voucher, diskon).",
        "segue": "Penalti: memuat peralihan segmen di tengah klip.",
        "outro": "Penalti: memuat salam penutup di akhir video.",
        "greeting": "Penalti: dibuka dengan salam pembuka kanal.",
        "small_talk": "Penalti: basa-basi tanya-jawab pendek.",
        "suspect": "Penalti: memuat bagian transkrip yang meragukan (ASR rusak).",
        "fillers": "Penalti ringan: kata pengisi jauh di atas rata-rata episode.",
        "dense_laughs": "Tawa padat di obrolan pendek dibatasi (sering jebakan).",
    }
    reasons.extend(text for name, text in penalty_text.items() if name in window.penalties)
    if similarity >= 0.05:
        reasons.append("Topiknya mirip klip lain yang lebih tinggi; skornya dikurangi.")
    return [reason[:300] for reason in reasons[:8]]


def _question_headline(ctx: _Context, window: _Window) -> str:
    """The anchoring host question as a title ("Kenapa lu keluar dari band lama?"), or ``""``.

    The question is the first one at or just after the start (a setup line or a split caption
    line may come first); its last asked sentence that still ends on "?" once fitted wins.
    """
    units = ctx.units
    last = min(window.start + _SENTENCE_WALK_BACK, window.end)
    for index in range(window.start, last + 1):
        if not units[index].question:
            continue
        text = " ".join(unit.text for unit in units[window.start : index + 1])
        asked = [words for words, _closed in _clauses(text) if words[-1].endswith("?")]
        for words in reversed(asked):
            headline = _headline(words, TITLE_MAX_CHARS)
            if headline.endswith("?"):
                return headline
        return ""
    return ""


def _packaging(
    ctx: _Context, window: _Window, archetype: str, keywords: Sequence[str]
) -> tuple[str, str, int]:
    """Title, on-screen hook text and the unit the hook text quotes.

    The hook text is the best clean sentence of the hook line, or of the next strongest line in
    the hook zone when that line is garbled or filler only. The title is the archetype prefix
    plus a headline: the host question for question-led curiosity clips, otherwise the hook
    sentence without its leading pronoun, marker or connector (keywords as a last resort).
    Nothing is cut with an ellipsis, the hook text stays within HOOK_TEXT_MAX_CHARS and the
    title within TITLE_MAX_CHARS.
    """
    units = ctx.units
    label = _ARCHETYPE_LABELS[archetype]
    zone_end = min(max(window.zone_end, window.hook_unit), window.end)
    others = sorted(
        (
            index
            for index in range(window.start, zone_end + 1)
            if index != window.hook_unit and not units[index].suspect
        ),
        key=lambda index: (-ctx.line_value[index], index),
    )
    hook_text, hook_words, hook_unit = "", [], window.hook_unit
    for index in [window.hook_unit, *others]:
        text, words = _quote(units[index].text)
        if text:
            hook_text, hook_words, hook_unit = text, words, index
            break
    if archetype in ("curiosity_gap", "other") and window.kind in ("question", "setup"):
        question = _question_headline(ctx, window)
        if question:
            return question, hook_text or label, hook_unit
    prefix = _TITLE_PREFIX[archetype]
    budget = TITLE_MAX_CHARS - len(prefix) - 2
    headline = ""
    if hook_words:
        headline = _headline(hook_words, budget)
    for index in others:
        if headline:
            break
        headline = _headline(_quote(units[index].text)[1], budget)
    if not headline and keywords:
        headline = _finish(", ".join(keywords[:3]).split(), False, budget)
    title = f"{prefix}: {headline}" if headline else label
    return title, hook_text or label, hook_unit


def _proposal(ctx: _Context, window: _Window, adjusted: float, similarity: float) -> ClipProposal:
    units = ctx.units
    archetype = _archetype(ctx, window)
    label = _ARCHETYPE_LABELS[archetype]
    keywords = _keywords(ctx, window, MAX_HASHTAGS - 1)
    title, hook_text, hook_unit = _packaging(ctx, window, archetype, keywords)
    hashtags = [f"#{word}" for word in keywords]
    for extra in ("#podcastindonesia", "#fyp", "#podcast"):
        if len(hashtags) >= MIN_HASHTAGS:
            break
        hashtags.append(extra)
    first, last = units[window.start], units[window.end]
    laughed = _laugh_end(ctx, window.start, window.end)
    payoff_unit = laughed
    if payoff_unit is None:
        previous_recap = window.end > window.start and units[window.end - 1].recap
        if not last.recap and previous_recap and len(last.tokens) <= 4:
            payoff_unit = window.end - 1
        else:
            payoff_unit = window.end
    topics = ", ".join(keywords[:3])
    description = (
        f"{label} ({last.end - first.start:.0f} detik, mulai {_clock(first.start)})"
        + (f" tentang {topics}" if topics else "")
        + f". {_OPENER_SUMMARY[window.kind]}, {_ending_summary(ctx, window)}."
    )
    return ClipProposal(
        start_unit=window.start,
        end_unit=window.end,
        hook_unit=hook_unit,
        payoff_unit=payoff_unit,
        archetype=archetype,
        title=title,
        hook_text=hook_text,
        description=description[:600],
        hashtags=tuple(hashtags[:MAX_HASHTAGS]),
        reasons=tuple(_reasons(ctx, window, hook_unit, hook_text, similarity)),
        scores={name: round(value, 3) for name, value in window.dims.items()},
        score=round(adjusted, 3),
        source="heuristic",
    )


# --- public API -------------------------------------------------------------------------------


def clean_hook_line(text: str) -> str:
    """``text`` (one transcript line) as clean on-screen hook text, ``""`` when unusable.

    The heuristic's own hook text rule (see *Packaging* in the module docstring): the best clean
    sentence within :data:`HOOK_TEXT_MAX_CHARS`, never cut with an ellipsis.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    return _clean_line(text)


def archetype_label(archetype: str) -> str:
    """The plain Indonesian label of an archetype ("Momen lucu"); unknown ones read as "other"."""
    return _ARCHETYPE_LABELS.get(archetype, _ARCHETYPE_LABELS["other"])


def _duration(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return result


def _validate_units(units: object) -> list[SentenceUnit]:
    if isinstance(units, (str, bytes)) or not isinstance(units, Sequence):
        raise TypeError("units must be a sequence of SentenceUnit values")
    items = list(units)
    for position, unit in enumerate(items):
        if not isinstance(unit, SentenceUnit):
            raise TypeError("units must be SentenceUnit values")
        if unit.index != position:
            raise ValueError("unit indices must match their positions")
        if position and unit.start < items[position - 1].start:
            raise ValueError("units must be chronological")
    return items


def propose_heuristic(
    units: Sequence[SentenceUnit],
    *,
    min_duration: float,
    max_duration: float,
    k: int,
    events: Sequence[SoundEvent] = (),
    audio: AudioTimeline | None = None,
) -> tuple[ClipProposal, ...]:
    """Rank up to ``max(3 * k, 15)`` non-overlapping clip proposals, best first.

    ``units`` must come from :func:`ai_clipper.sentences.build_sentence_units` (index equals
    position). ``events`` are optional laughter/applause tags and ``audio`` an optional
    whole-file timeline. Proposal indices refer to ``units``; boundary snapping is left to the
    caller.
    """
    items = _validate_units(units)
    low = _duration(min_duration, "min_duration")
    high = _duration(max_duration, "max_duration")
    if high < low:
        raise ValueError("max_duration must not be below min_duration")
    if not isinstance(k, int) or isinstance(k, bool):
        raise TypeError("k must be an integer")
    if k < 1:
        raise ValueError("k must be positive")
    if isinstance(events, (str, bytes)) or not isinstance(events, Sequence):
        raise TypeError("events must be a sequence of SoundEvent values")
    ordered_events = sort_events(events)
    if audio is not None and not isinstance(audio, AudioTimeline):
        raise TypeError("audio must be an AudioTimeline or None")
    if not items:
        return ()

    ctx = _context([_analyse_unit(unit) for unit in items], ordered_events, audio)
    windows = _search(ctx, low, high)
    limit = max(3 * k, MIN_PROPOSALS)
    return tuple(
        _proposal(ctx, window, adjusted, similarity)
        for window, adjusted, similarity in _diverse(ctx, windows, limit)
    )
