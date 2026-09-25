#!/usr/bin/env python3
"""The synthetic V3 job for Editor V3 (plan §11.1 T1.5). Generated on demand, never committed.

``build`` writes, under ``OUT/jobs/<uuid>/``, jobs in exactly the layout the dashboard and the
pipeline produce today (``job.json``, ``input/``, ``output/manifest.json``,
``output/transcript.json``, ``analysis/…``), without renders, plus ``OUT/fixture.json`` (the
index: job ids, clips, labelled words, events and expected gap classes) and ``OUT/media/`` (the
sources, hard-linked into each job):

* ``main``: a 180 s barcode + column-ruler source (``tests/support/edit_v2_media``) at 29.97
  CFR with the tone-burst audio of the transcript, fit-blur, karaoke, cold open and hook;
* ``fps25`` (center-crop, classic, no hook), ``fps60`` (face-track) and ``vfr`` (Matroska,
  every 9th frame dropped, no cold open): the same transcript over other sources;
* ``old``: the ``main`` media without ``sound-events.json`` (a Whisper-style job) and with a
  leftover ``.attempts/orphan.analysis.<uuid>/`` directory; it opens after prepare;
* ``stranded``: ``analysis/`` exists only under ``.attempts/<sha>/analysis/`` (a job completed
  before the web published attempt analysis): ``analysis_incomplete``;
* ``v1``: a Selection V1 job: ``not_v3``.

The transcript is Indonesian with word timings on the tone bursts. It includes the fillers
"eh" and "anu", the particles "sih", "dong" and "mah", the stutter "gua gua", the
reduplications "pelan pelan" and "hati hati", a pair of overlapping words, a zero-length word, a
segment without word timestamps (split proportionally), a "wkwk" token followed by a laughter
gap with a ``[tertawa]`` caption tag and "ha ha ha" bursts, a voiced long gap (a quiet burst
between words) and silent long gaps. ``selection.v3.json`` holds 3 clips, the first with a cold
open (a question). Every artifact is deterministic; only the H.264 bits depend on the encoder.

``gates`` measures the T1.5 performance gates and merges them into the evidence files
``docs/editor/evidence/W1/T1.5-words_peaks.json`` and ``T1.5-camera.json``.

Usage::

    python scripts/editor_fixture/make_job.py build OUT [--size 1280x720] [--only main,old]
        [--force] [--prepare] [--stub-camera]
    python scripts/editor_fixture/make_job.py gates EVIDENCE_DIR --label NAME [--work DIR]
        [--size 1280x720] [--repeat 5]
"""

from __future__ import annotations

import argparse
import array
import json
import math
import operator
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from support import edit_v2_media as media

from ai_clipper import subtitles
from ai_clipper.audio_timeline import build_audio_timeline, write_audio_timeline
from ai_clipper.models import Transcription, TranscriptSegment, TranscriptWord
from ai_clipper.selection_types import (
    SCORE_DIMENSIONS,
    SelectedClip,
    SelectionResult,
)
from ai_clipper.selection_v3 import write_selection_artifact
from ai_clipper.sentences import build_sentence_units
from ai_clipper.sound_events import SoundEvent, write_sound_events
from ai_clipper.transcript_io import write_transcript_json
from ai_clipper.transcript_quality import (
    assess_transcript,
    write_transcript_quality_json,
)

SCHEMA = "potongin.editor-fixture/1"
DURATION_MS = 180_000
DEFAULT_SIZE = (1280, 720)
START_MS = 700
WORD_LEVEL_CDB = -1200
WORD_FREQS = (600, 750, 800, 1000, 1200)
INTRA_GAPS_MS = (70, 110, 90, 130, 80, 150, 100)
INTER_GAPS_MS = (420, 520, 380, 470, 350, 560)
OVERLAP_MS = 40
PRE_ROLL_MS = 150
TAIL_MS = 400
COLD_OPEN_PRE_MS = 80
COLD_OPEN_TAIL_MS = 120
SCENE_CUT_SECONDS = 15
CREATED_AT = "2026-09-24T08:00:00.000Z"
COMPLETED_AT = "2026-09-24T08:04:30.000Z"
_NAMESPACE = uuid.UUID("5e0c3f63-2a0f-4d8e-9b8e-0f5c1b7d2a41")


@dataclass(frozen=True)
class Sentence:
    text: str
    gap_before: int | None = None  # ms of silence (or a marked gap) before the sentence
    labels: tuple[tuple[str, tuple[int, ...]], ...] = ()  # (label, word positions)
    overlap_at: int | None = None  # this word starts 40 ms before the previous one ends
    zero_at: int | None = None  # zero-length word (s == e), as YouTube captions produce
    no_words: bool = False  # a segment without word timestamps (split proportionally)
    gap_kind: str | None = None  # "silent", "voiced" or "laughter" gap before the sentence
    tag_before: str | None = None  # a caption sound tag in the middle of the gap before


S = Sentence
SCRIPT: tuple[Sentence, ...] = (
    S("Halo semuanya, selamat datang lagi di obrolan santai kita."),
    S("Hari ini gue mau cerita soal syuting film pertama."),
    S("Ceritanya lumayan panjang tapi seru banget."),
    # clip 1 (units S0004–S0013; cold open S0011)
    S("Jadi waktu itu kita datang subuh ke lokasi syuting."),
    S("Semua kru sudah siap dengan kamera dan lampu."),
    S("Terus gue jalan ke pintu masuk sambil bawa naskah."),
    S("Mendadak ada security yang nahan gue di depan."),
    S("Dia bilang orang luar nggak boleh masuk area itu."),
    S("Gue jelasin kalau gue sutradara film ini."),
    S("Dia cuma lihat muka gue terus geleng kepala."),
    S("Kenapa security nahan sutradara di film sendiri?"),
    S("Ternyata nama gue belum masuk daftar tamu."),
    S("Produser lupa kirim daftar kru yang terbaru."),
    S("Akhirnya gue nunggu hampir satu jam di parkiran.", gap_before=1500, gap_kind="silent"),
    S("Untung ada tukang kopi yang nemenin ngobrol."),
    S("Dia malah lebih paham jadwal syuting daripada gue."),
    S("Katanya dia sudah kerja di sana sepuluh tahun."),
    # clip 2 (units S0018–S0027): the Rapikan cases
    S("Eh jadi gua gua bingung sih waktu itu.",
      labels=(("filler", (0,)), ("stutter", (2, 3)), ("particle", (5,)))),
    S("Anu, pokoknya kita harus pelan pelan dong.",
      labels=(("filler", (0,)), ("reduplication", (4, 5)), ("particle", (6,)))),
    S("Kata produser hati hati mah kalau lewat pintu belakang.",
      labels=(("reduplication", (2, 3)), ("particle", (4,)))),
    S("Gue masuk lewat dapur bareng tukang katering.", overlap_at=4,
      labels=(("overlap", (3, 4)),)),
    S("Semua orang ngelihatin gue kayak maling."),
    S("Pas sampai di set semua kru langsung ketawa wkwk.",
      labels=(("laughter_token", (8,)),)),
    S("Produser minta maaf sambil nahan malu.", gap_before=1600, gap_kind="laughter",
      tag_before="tertawa"),
    S("Dia janji besok nama gue ditulis paling atas.", gap_before=1100, gap_kind="voiced"),
    S("Security itu sekarang jadi teman baik gue."),
    S("Tiap ketemu dia selalu salam duluan."),
    S("Pelajaran buat kalian yang mau bikin film sendiri."),
    S("Selalu cek daftar tamu sehari sebelum syuting."),
    S("Simpan nomor produser di ponsel kalian."),
    S("Bawa kartu identitas kru ke mana pun."),
    S("Dan jangan lupa kenalan sama security lokasi."),
    S("Mereka bisa jadi penyelamat kalian nanti.", gap_before=1400, gap_kind="silent"),
    # clip 3 (units S0034–S0044)
    S("Terus dia bilang semua orang harus pulang sekarang juga.", no_words=True),
    S("Kita semua langsung merapikan alat syuting.", zero_at=1,
      labels=(("zero_length", (1,)),)),
    S("Lampu dimatikan satu per satu dengan tenang."),
    S("Kamera dimasukkan ke koper paling besar."),
    S("Sutradara kedua menghitung semua kabel."),
    S("Ternyata ada satu kabel yang hilang."),
    S("Kita cari sampai ke belakang panggung."),
    S("Kabel itu ternyata dipakai buat jemuran."),
    S("Semua orang tepuk tangan waktu kabelnya ketemu."),
    S("Akhirnya kita pulang hampir tengah malam.", gap_before=1200, gap_kind="silent",
      tag_before="tepuk tangan"),
    S("Besoknya syuting jalan lancar tanpa drama."),
    S("Oke sekian cerita hari ini, sampai jumpa."),
    S("Jangan lupa bagikan cerita kalian di kolom komentar."),
    S("Terima kasih sudah menonton sampai habis."),
)
del S

CLIPS = (
    # (first sentence, last sentence, hook sentence, cold open, source, title, hook text)
    (3, 12, 10, True, "llm", "Sutradara ditahan security di film sendiri",
     "Kenapa sutradara ditahan di film sendiri?"),
    (17, 26, 22, False, "llm", "Masuk lewat dapur bareng tukang katering",
     "Satu kru langsung ketawa wkwk"),
    (33, 43, 38, False, "heuristic", "Kabel hilang dipakai buat jemuran",
     "Kabel syuting dipakai buat jemuran"),
)


@dataclass(frozen=True)
class Variant:
    media: str
    fps: tuple[int, int]
    container: str = "mp4"
    vfr: bool = False
    render_mode: str = "fit-blur"
    caption_style: str = "karaoke"
    cold_open: bool = True
    hook_overlay: bool = True
    sound_events: bool = True
    layout: str = "published"  # "published", "orphan_attempt" or "stranded"
    selection_mode: str = "v3"
    expect: str = "openable"


VARIANTS: dict[str, Variant] = {
    "main": Variant("main", (30000, 1001)),
    "fps25": Variant("fps25", (25, 1), render_mode="center-crop", caption_style="classic",
                     hook_overlay=False),
    "fps60": Variant("fps60", (60, 1), render_mode="face-track"),
    "vfr": Variant("vfr", (30000, 1001), container="mkv", vfr=True, caption_style="classic",
                   cold_open=False),
    "old": Variant("main", (30000, 1001), sound_events=False, layout="orphan_attempt"),
    "stranded": Variant("main", (30000, 1001), layout="stranded", expect="analysis_incomplete"),
    "v1": Variant("main", (30000, 1001), selection_mode="v1", expect="not_v3"),
}


# --- the script ----------------------------------------------------------------------------------


def _letters(token: str) -> int:
    return sum(character.isalnum() for character in token)


def _word_ms(token: str) -> int:
    return min(520, max(180, 140 + 38 * _letters(token)))


def split_segment(segment: TranscriptSegment) -> list[tuple[float, float, str]]:
    """``subtitles._segment_words`` (the proportional split every reader uses)."""
    return subtitles._segment_words(segment)


@dataclass
class FixtureScript:
    transcription: Transcription
    bursts: tuple[media.ToneBurst, ...]
    labels: dict[str, list[Any]]
    sentences: list[tuple[int, int, int, int]]  # (first word index, last, s_ms, e_ms)
    gaps: list[dict[str, Any]]
    tags: list[tuple[int, str]]  # (ms, label)
    end_ms: int
    extra: dict[str, Any] = field(default_factory=dict)


def _probability(index: int) -> float | None:
    if index % 19 == 7:
        return None
    return round(0.6 + 0.35 * ((index * 37) % 100) / 100, 3)


def script() -> FixtureScript:
    """The deterministic transcript, its tone bursts and its labels."""
    segments: list[TranscriptSegment] = []
    bursts: list[media.ToneBurst] = []
    labels: dict[str, list[Any]] = {"filler": [], "particle": [], "stutter": [],
                                    "reduplication": [], "overlap": [], "laughter_token": [],
                                    "zero_length": [], "split_segment_words": []}
    sentences: list[tuple[int, int, int, int]] = []
    gaps: list[dict[str, Any]] = []
    tags: list[tuple[int, str]] = []
    t = START_MS
    word_index = 0
    intra = 0
    previous_end: int | None = None
    for number, sentence in enumerate(SCRIPT):
        if previous_end is not None:
            gap = sentence.gap_before or INTER_GAPS_MS[number % len(INTER_GAPS_MS)]
            t = previous_end + gap
            if sentence.gap_kind is not None:
                middle = previous_end + gap // 2
                gaps.append({"after_index": word_index - 1, "s": previous_end, "e": t,
                             "class": sentence.gap_kind})
                if sentence.gap_kind == "voiced":
                    bursts.append(media.ToneBurst(middle - 175, middle + 175, 300, -3000))
                if sentence.gap_kind == "laughter":
                    for offset in (-300, 0, 300):
                        bursts.append(media.ToneBurst(middle + offset - 75,
                                                      middle + offset + 75, 1500, -1800))
            if sentence.tag_before is not None:
                tags.append((previous_end + gap // 2, sentence.tag_before))
        tokens = sentence.text.split()
        timings: list[tuple[int, int]] = []
        for position, token in enumerate(tokens):
            start = t
            if position == sentence.overlap_at:
                start = timings[-1][1] - OVERLAP_MS
            end = start if position == sentence.zero_at else start + _word_ms(token)
            timings.append((start, end))
            t = max(end, start) + INTRA_GAPS_MS[intra % len(INTRA_GAPS_MS)]
            intra += 1
        seg_start, seg_end = timings[0][0], max(end for _start, end in timings)
        first_index = word_index
        if sentence.no_words:
            segment = TranscriptSegment(seg_start / 1000, seg_end / 1000, sentence.text)
            for start, end, _text in split_segment(segment):
                s_ms, e_ms = round(start * 1000), round(end * 1000)
                bursts.append(media.ToneBurst(s_ms + 25, e_ms - 25,
                                              WORD_FREQS[word_index % 5], WORD_LEVEL_CDB))
                labels["split_segment_words"].append(f"w{word_index:06d}")
                word_index += 1
        else:
            words = []
            for position, (token, (start, end)) in enumerate(zip(tokens, timings)):
                words.append(TranscriptWord(start / 1000, end / 1000, token,
                                            _probability(word_index + position)))
                if end > start:
                    bursts.append(media.ToneBurst(start, end,
                                                  WORD_FREQS[(word_index + position) % 5],
                                                  WORD_LEVEL_CDB))
            segment = TranscriptSegment(seg_start / 1000, seg_end / 1000, sentence.text,
                                        tuple(words))
            word_index += len(tokens)
        for label, positions in sentence.labels:
            ids = [f"w{first_index + position:06d}" for position in positions]
            if label in ("stutter", "reduplication", "overlap"):
                labels[label].append(ids)
            else:
                labels[label].extend(ids)
        segments.append(segment)
        sentences.append((first_index, word_index - 1, seg_start, seg_end))
        previous_end = seg_end
    if previous_end is None or previous_end > DURATION_MS - 1500:
        raise AssertionError("the fixture script must end before the source")
    for gap in gaps:
        gap["after"] = f"w{gap.pop('after_index'):06d}"
    return FixtureScript(Transcription("id", segments), tuple(bursts), labels, sentences, gaps,
                         tags, previous_end)


# --- selection -----------------------------------------------------------------------------------


def selection(fixture: FixtureScript) -> SelectionResult:
    """The 3 clips of ``CLIPS``, snapped like Selection V3 (pre-roll, tail, cold open)."""
    units = build_sentence_units(
        fixture.transcription.segments,
        quality=assess_transcript(fixture.transcription.segments, language="id"),
    )
    if len(units) != len(SCRIPT):
        raise AssertionError("every fixture sentence must be one sentence unit")
    clips = []
    for rank, (first, last, hook, cold, source, title, hook_text) in enumerate(CLIPS, start=1):
        start_ms = fixture.sentences[first][2] - PRE_ROLL_MS
        next_start = fixture.sentences[last + 1][2] if last + 1 < len(SCRIPT) else DURATION_MS
        end_ms = fixture.sentences[last][3] + min(TAIL_MS, (next_start - fixture.sentences[last][3]) // 2)
        teaser = None
        if cold:
            teaser = ((fixture.sentences[hook][2] - COLD_OPEN_PRE_MS) / 1000,
                      (fixture.sentences[hook][3] + COLD_OPEN_TAIL_MS) / 1000)
        text = " ".join(SCRIPT[index].text for index in range(first, last + 1))
        score = round(8.4 - 0.6 * rank, 2)
        clips.append(SelectedClip(
            rank=rank, start=start_ms / 1000, end=end_ms / 1000, cold_open=teaser,
            unit_ids=(units[first].unit_id, units[last].unit_id),
            hook_unit_id=units[hook].unit_id, title=title, hook_text=hook_text,
            description=f"{title}. Cerita lucu dari lokasi syuting.",
            hashtags=("#film", "#syuting", "#ceritalucu"),
            archetype=("story_twist", "humor", "relatable_pain")[rank - 1], score=score,
            scores={name: round(score - 0.3 * position, 2)
                    for position, name in enumerate(SCORE_DIMENSIONS)},
            reasons=("Hook kuat di detik awal", "Payoff jelas"), source=source, text=text,
        ))
    return SelectionResult(clips=tuple(clips), source="llm", status="completed",
                           provider="fixture", model="fixture-model", prompt_version="fixture-v1")


# --- audio timeline --------------------------------------------------------------------------------


def _frames(fps: tuple[int, int]) -> int:
    return round(DURATION_MS * fps[0] / (1000 * fps[1]))


def audio_spec(fixture: FixtureScript, channels: int = 2) -> media.AudioSpec:
    return media.AudioSpec(sample_rate=48_000, channels=channels, bursts=fixture.bursts,
                           clicks_ms=())


def audio_timeline(fixture: FixtureScript, variant: Variant) -> Any:
    """The audio timeline the analyzer would write: 100 ms RMS frames of the exact PCM."""
    frames = _frames(variant.fps)
    samples = media.audio_samples(frames, variant.fps, 48_000)
    mono = array.array("h")
    mono.frombytes(media.render_pcm(audio_spec(fixture, channels=1), samples))
    step = 4800
    rms: list[float | None] = []
    for start in range(0, samples, step):
        chunk = mono[start : start + step]
        power = sum(map(operator.mul, chunk, chunk)) / len(chunk)
        rms.append(10 * math.log10(power / 32768**2) if power > 0 else None)
    duration = samples / 48_000
    period = round(SCENE_CUT_SECONDS * variant.fps[0] / variant.fps[1])
    cuts = [k * period * variant.fps[1] / variant.fps[0]
            for k in range(1, frames // period + 1) if k * period < frames]
    return build_audio_timeline(rms, duration=duration, step=0.1, scene_cuts=cuts)


# --- jobs ----------------------------------------------------------------------------------------


def job_id(name: str) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"editor-fixture/{name}"))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _media_path(out: Path, variant: Variant, size: tuple[int, int]) -> Path:
    return out / "media" / f"{variant.media}-{size[0]}x{size[1]}.{variant.container}"


def _make_media(out: Path, variant: Variant, fixture: FixtureScript,
                size: tuple[int, int]) -> Path:
    path = _media_path(out, variant, size)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    fps = variant.fps
    spec = media.VideoSpec(
        width=size[0], height=size[1], fps=fps, frames=_frames(fps), vfr=variant.vfr,
        drop_every=9 if variant.vfr else 0,
        scene_cut_every=round(SCENE_CUT_SECONDS * fps[0] / fps[1]),
        gop=round(4 * fps[0] / fps[1]), container=variant.container,
        audio=audio_spec(fixture),
    )
    temp = path.with_name(f".{path.name}.tmp{path.suffix}")
    media.make_barcode_video(temp, spec)
    os.replace(temp, path)
    return path


def _link(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def _manifest_clip(index: int, clip: SelectedClip, cold: bool, output: Path) -> dict[str, Any]:
    teaser = clip.cold_open if cold else None
    duration = clip.end - clip.start + (0 if teaser is None else teaser[1] - teaser[0])
    return {
        "index": index, "start": round(clip.start, 3), "end": round(clip.end, 3),
        "duration": round(duration, 3), "score": round(clip.score, 2), "text": clip.text,
        "output": str(output / f"clip-{index:02d}.mp4"),
        "subtitles": str(output / f"clip-{index:02d}.srt"),
        "title": clip.title, "hook_text": clip.hook_text, "description": clip.description,
        "hashtags": list(clip.hashtags), "archetype": clip.archetype,
        "selection_source": clip.source, "reasons": list(clip.reasons),
        "scores": dict(clip.scores),
        "cold_open": None if teaser is None else {"start": teaser[0], "end": teaser[1]},
        "source_start": round(clip.start, 3), "source_end": round(clip.end, 3),
        "thumbnail": None,
    }


def _job_clip(job: str, clip: dict[str, Any]) -> dict[str, Any]:
    """``web/scripts/run-job.mjs`` ``jobClipFromManifest`` for a clip without files."""
    name = Path(clip["output"]).name
    entry = {
        "index": clip["index"], "score": clip["score"], "start": clip["start"],
        "end": clip["end"], "duration": clip["duration"], "text": clip["text"],
        "videoUrl": f"/api/jobs/{job}/files/output/{name}",
        "downloadUrl": f"/api/jobs/{job}/files/output/{name}?download=1",
        "subtitleUrl": f"/api/jobs/{job}/files/output/{Path(clip['subtitles']).name}?download=1",
    }
    if "title" in clip:
        entry.update({
            "title": clip["title"], "hookText": clip["hook_text"],
            "description": f"{clip['description']}\n\n{' '.join(clip['hashtags'])}",
            "hashtags": clip["hashtags"], "archetype": clip["archetype"],
            "selectionSource": clip["selection_source"], "reasons": clip["reasons"],
            "scores": clip["scores"], "sourceStart": clip["source_start"],
            "sourceEnd": clip["source_end"], "metadataVersion": 5,
        })
        if clip["cold_open"] is not None:
            entry["coldOpen"] = clip["cold_open"]
    return entry


def _write_job(out: Path, name: str, variant: Variant, fixture: FixtureScript,
               result: SelectionResult, source_media: Path) -> dict[str, Any]:
    identity = job_id(name)
    job_dir = out / "jobs" / identity
    input_path = job_dir / "input" / f"source.{variant.container}"
    _link(source_media, input_path)
    output = job_dir / "output"
    analysis_root = job_dir
    if variant.layout == "stranded":
        analysis_root = job_dir / ".attempts" / uuid.uuid5(_NAMESPACE, name).hex
    analysis = analysis_root / "analysis"
    write_transcript_json(output / "transcript.json", fixture.transcription)
    transcript_source = "youtube-captions" if variant.sound_events else "whisper"
    if variant.selection_mode == "v3":
        write_transcript_quality_json(
            analysis / "transcript-quality.json",
            assess_transcript(fixture.transcription.segments, language="id"),
        )
        write_audio_timeline(audio_timeline(fixture, variant), analysis / "audio-timeline.json")
        if variant.sound_events:
            events = [SoundEvent.from_label(ms / 1000, label) for ms, label in fixture.tags]
            write_sound_events(analysis / "sound-events.json", events, source="youtube-json3")
        write_selection_artifact(analysis / "selection.v3.json", result)
        clips = [_manifest_clip(index, clip, variant.cold_open, output)
                 for index, clip in enumerate(result.clips, start=1)]
        summary = {"mode": "v3", "status": "completed", "source": result.source,
                   "provider": result.provider, "model": result.model,
                   "prompt_version": result.prompt_version, "warnings": [],
                   "artifact": "analysis/selection.v3.json",
                   "transcript_source": transcript_source}
        options = {"renderMode": variant.render_mode, "limit": 3, "minDuration": 20,
                   "maxDuration": 60, "selectionMode": "v3", "llmMode": "auto",
                   "coldOpen": variant.cold_open, "hookOverlay": variant.hook_overlay,
                   "captionStyle": variant.caption_style}
    else:
        clips = [{"index": index, "start": round(clip.start, 3), "end": round(clip.end, 3),
                  "duration": round(clip.end - clip.start, 3), "score": 0.5,
                  "text": clip.text, "output": str(output / f"clip-{index:02d}.mp4"),
                  "subtitles": str(output / f"clip-{index:02d}.srt")}
                 for index, clip in enumerate(result.clips, start=1)]
        summary = None
        options = {"renderMode": variant.render_mode, "limit": 3, "minDuration": 20,
                   "maxDuration": 60, "selectionMode": "v1"}
    manifest = {"source": str(input_path), "render_mode": variant.render_mode,
                "status": "completed", "language": "id",
                "transcript": str(output / "transcript.json"), "clips": clips}
    if summary is not None:
        manifest["selection_v3"] = summary
    _write_json(output / "manifest.json", manifest)
    if variant.layout == "orphan_attempt":
        orphan = job_dir / ".attempts" / f"orphan.analysis.{uuid.uuid5(_NAMESPACE, name)}"
        _write_json(orphan / ".attempt-owner.json", {"version": 1, "id": identity})
    job = {
        "id": identity, "status": "completed", "progress": 100, "createdAt": CREATED_AT,
        "updatedAt": COMPLETED_AT, "completedAt": COMPLETED_AT,
        "source": {"type": "upload", "name": f"fixture-{variant.media}.{variant.container}",
                   "size": input_path.stat().st_size},
        "sourcePath": str(input_path.resolve()), "options": options,
        "clips": [_job_clip(identity, clip) for clip in clips],
        "stage": "completed", "stageDetail": "Semua klip siap digunakan",
    }
    if summary is not None:
        job["selectionV3"] = summary
    _write_json(job_dir / "job.json", job)
    return {
        "id": identity, "dir": f"jobs/{identity}", "source": f"jobs/{identity}/input/"
        f"{input_path.name}", "fps": list(variant.fps), "vfr": variant.vfr,
        "render_mode": variant.render_mode, "caption_style": variant.caption_style,
        "cold_open": variant.cold_open, "hook_overlay": variant.hook_overlay,
        "sound_events": variant.sound_events, "selection_mode": variant.selection_mode,
        "expect": variant.expect,
    }


def build(out: Path, *, size: tuple[int, int] = DEFAULT_SIZE, only: Sequence[str] | None = None,
          force: bool = False) -> dict[str, Any]:
    """Write the fixture jobs (all, or ``only`` these names) under ``out``; returns the index."""
    names = list(VARIANTS) if only is None else list(only)
    unknown = [name for name in names if name not in VARIANTS]
    if unknown:
        raise ValueError(f"unknown fixture jobs: {', '.join(unknown)}")
    out = Path(out)
    fixture = script()
    result = selection(fixture)
    index_path = out / "fixture.json"
    index: dict[str, Any] = {
        "schema": SCHEMA, "size": list(size), "duration_ms": DURATION_MS, "jobs": {},
        "clips": [
            {"rank": clip.rank, "start_ms": round(clip.start * 1000),
             "end_ms": round(clip.end * 1000),
             "cold_open_ms": None if clip.cold_open is None else
             [round(clip.cold_open[0] * 1000), round(clip.cold_open[1] * 1000)],
             "unit_ids": list(clip.unit_ids), "hook_unit_id": clip.hook_unit_id}
            for clip in result.clips
        ],
        "labels": fixture.labels,
        "events": [{"kind": SoundEvent.from_label(0.0, label).kind, "label": label,
                    "time_ms": ms} for ms, label in fixture.tags],
        "long_gaps": fixture.gaps,
    }
    if index_path.exists():
        previous = json.loads(index_path.read_text(encoding="utf-8"))
        if previous.get("size") == list(size):
            index["jobs"].update(previous.get("jobs", {}))
    for name in names:
        variant = VARIANTS[name]
        job_dir = out / "jobs" / job_id(name)
        if job_dir.exists():
            if not force:
                raise FileExistsError(f"{job_dir} exists (use --force)")
            shutil.rmtree(job_dir)
        source = _make_media(out, variant, fixture, size)
        index["jobs"][name] = _write_job(out, name, variant, fixture, result, source)
    _write_json(index_path, index)
    return index


def prepare_all(out: Path, index: dict[str, Any], *, stub_camera: bool) -> dict[str, Any]:
    """Run ``seed.prepare_legacy_job`` on every generated job (optionally with a stub camera)."""
    from ai_clipper.edit_v2 import camera, seed

    if stub_camera:
        camera.detect_face_track = _stub_detector
    return {name: seed.prepare_legacy_job(out / entry["dir"])
            for name, entry in index["jobs"].items()}


def _stub_detector(source: Path, *, start: float, end: float, sample_interval: float = 0.75):
    """A deterministic face track: centre drifting 0.40 → 0.60, no face every 11th sample."""
    times = []
    t = 0.0
    while t < end - start:
        times.append(t)
        t += sample_interval
    centres = [None if i % 11 == 10 else 0.4 + 0.2 * i / max(1, len(times) - 1)
               for i in range(len(times))]
    probe = media.probe(source)["video"]
    return times, centres, [False] * len(times), int(probe["width"]), int(probe["height"])


# --- gates ---------------------------------------------------------------------------------------


def _merge_evidence(path: Path, gate: str, threshold: float, label: str,
                    run: dict[str, Any]) -> None:
    document = {"gate": gate, "threshold_s": threshold, "runs": {}}
    if path.exists():
        document = json.loads(path.read_text(encoding="utf-8"))
    document["gate"], document["threshold_s"] = gate, threshold
    document.setdefault("runs", {})[label] = run
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _toolchain() -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    line = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True,
                          check=False).stdout.splitlines()[0] if ffmpeg else None
    return {"ffmpeg": line, "python": platform.python_version(),
            "reference_toolchain_problem": media.reference_toolchain_problem(),
            "cpu_count": os.cpu_count()}


def _long_transcript(fixture: FixtureScript, copies: int) -> Transcription:
    segments = []
    for copy_index in range(copies):
        offset = copy_index * DURATION_MS / 1000
        for segment in fixture.transcription.segments:
            words = tuple(TranscriptWord(w.start + offset, w.end + offset, w.text, w.probability)
                          for w in segment.words)
            segments.append(TranscriptSegment(segment.start + offset, segment.end + offset,
                                              segment.text, words))
    return Transcription("id", segments)


def gates(evidence_dir: Path, *, label: str, work: Path | None, size: tuple[int, int],
          repeat: int) -> dict[str, Any]:
    """Measure the T1.5 gates on the ``main`` fixture job and merge them into the evidence."""
    from ai_clipper.audio_timeline import read_audio_timeline
    from ai_clipper.edit_v2 import camera, words
    from ai_clipper.edit_v2.clip_id import clip_id
    from ai_clipper.edit_v2.peaks import bin_count, build_peaks
    from ai_clipper.edit_v2.timemap import Fps
    from ai_clipper.sound_events import read_sound_events
    from ai_clipper.transcript_io import read_transcript_json

    temp = None
    if work is None:
        temp = tempfile.TemporaryDirectory(prefix="editor-fixture-gates-")
        work = Path(temp.name)
    try:
        index = build(work, size=size, only=("main",), force=True)
        job_dir = work / index["jobs"]["main"]["dir"]
        source = job_dir / "input" / "source.mp4"
        fps = Fps(30000, 1001)
        window = (0, DURATION_MS)  # a 60 s clip [60 s, 120 s] plus 60 s on each side
        identity = clip_id("0" * 64, 60_000, 120_000, None)
        audio = read_audio_timeline(job_dir / "analysis" / "audio-timeline.json")
        events, _tags_source = read_sound_events(job_dir / "analysis" / "sound-events.json")
        timings: list[dict[str, float]] = []
        count = 0
        for _ in range(repeat):
            words._cache = None  # cold: flatten + units + quality every run
            began = time.perf_counter()
            transcription = read_transcript_json(job_dir / "output" / "transcript.json")
            read_s = time.perf_counter() - began
            began = time.perf_counter()
            peaks = build_peaks(source, window)
            peaks_s = time.perf_counter() - began
            began = time.perf_counter()
            artifact = words.build_words_artifact(transcription, clip_id=identity,
                                                  window_ms=window, fps=fps, audio=audio,
                                                  events=events, peaks=peaks)
            words.encode_words(artifact)
            words_s = time.perf_counter() - began
            count = len(artifact["words"])
            timings.append({"transcript_read_s": read_s, "peaks_s": peaks_s, "words_s": words_s,
                            "total_s": read_s + peaks_s + words_s})
        fixture = script()
        long_timings = []
        long = _long_transcript(fixture, 20)  # one hour of speech
        for _ in range(repeat):
            words._cache = None
            began = time.perf_counter()
            words.build_words_artifact(long, clip_id=identity, window_ms=(1_800_000, 1_980_000),
                                       fps=fps, audio=None, events=(),
                                       peaks=bytes(2 * bin_count((1_800_000, 1_980_000))))
            long_timings.append(time.perf_counter() - began)
        totals = [entry["total_s"] for entry in timings]
        words_run = {
            **_toolchain(), "size": list(size), "window_ms": list(window), "repeat": repeat,
            "words_in_window": count,
            "median_s": round(statistics.median(totals), 4), "max_s": round(max(totals), 4),
            "median_peaks_s": round(statistics.median(e["peaks_s"] for e in timings), 4),
            "median_words_s": round(statistics.median(e["words_s"] for e in timings), 4),
            "median_transcript_read_s": round(
                statistics.median(e["transcript_read_s"] for e in timings), 4),
            "words_only_1h_transcript_median_s": round(statistics.median(long_timings), 4),
            "words_only_1h_transcript_max_s": round(max(long_timings), 4),
            "pass": max(totals) <= 1.0,
        }
        _merge_evidence(evidence_dir / "T1.5-words_peaks.json",
                        "words + peaks for a 60 s clip (180 s analysis window)", 1.0, label,
                        words_run)

        camera_run: dict[str, Any] = {**_toolchain(), "size": list(size),
                                      "window_ms": list(window)}
        began = time.perf_counter()
        stub_plan = camera.build_camera_plan(source, window, fps, out_w=720, out_h=1280,
                                             detector=_stub_detector)
        camera_run["stub_detector_s"] = round(time.perf_counter() - began, 4)
        camera_run["samples"] = len(stub_plan["samples"])
        try:
            import cv2  # noqa: F401
        except ImportError:
            camera_run["real_detector_s"] = None
            camera_run["real_detector"] = "opencv unavailable"
        else:
            began = time.perf_counter()
            real_plan = camera.build_camera_plan(source, window, fps, out_w=720, out_h=1280)
            camera_run["real_detector_s"] = round(time.perf_counter() - began, 3)
            camera_run["real_detector_samples"] = len(real_plan["samples"])
            camera_run["gop_frames"] = round(4 * 30000 / 1001)
        measured = camera_run.get("real_detector_s")
        camera_run["pass_stub"] = camera_run["stub_detector_s"] <= 15.0
        camera_run["pass_real"] = None if measured is None else measured <= 15.0
        _merge_evidence(evidence_dir / "T1.5-camera.json", "camera plan for a 3 min window",
                        15.0, label, camera_run)
        return {"words_peaks": words_run, "camera": camera_run}
    finally:
        if temp is not None:
            temp.cleanup()


# --- command line --------------------------------------------------------------------------------


def _size(value: str) -> tuple[int, int]:
    width, _, height = value.partition("x")
    try:
        parsed = int(width), int(height)
    except ValueError:
        raise argparse.ArgumentTypeError("size must be WIDTHxHEIGHT") from None
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Editor V3 synthetic V3 job")
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("build", help="write the fixture jobs")
    make.add_argument("out", type=Path)
    make.add_argument("--size", type=_size, default=DEFAULT_SIZE)
    make.add_argument("--only", default=None, help="comma-separated job names")
    make.add_argument("--force", action="store_true", help="replace existing fixture jobs")
    make.add_argument("--prepare", action="store_true", help="also run prepare_legacy_job")
    make.add_argument("--stub-camera", action="store_true",
                      help="with --prepare: a deterministic face track instead of OpenCV")
    gate = commands.add_parser("gates", help="measure the T1.5 gates")
    gate.add_argument("evidence_dir", type=Path)
    gate.add_argument("--label", required=True)
    gate.add_argument("--work", type=Path, default=None)
    gate.add_argument("--size", type=_size, default=DEFAULT_SIZE)
    gate.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args(argv)
    if args.command == "build":
        only = None if args.only is None else [name for name in args.only.split(",") if name]
        index = build(args.out, size=args.size, only=only, force=args.force)
        report: dict[str, Any] = {"jobs": {name: entry["dir"]
                                           for name, entry in index["jobs"].items()}}
        if args.prepare:
            report["prepare"] = prepare_all(args.out, index, stub_camera=args.stub_camera)
        print(json.dumps(report, indent=2))
        return 0
    result = gates(args.evidence_dir, label=args.label, work=args.work, size=args.size,
                   repeat=args.repeat)
    print(json.dumps(result, indent=2, sort_keys=True))
    passed = result["words_peaks"]["pass"] and result["camera"]["pass_stub"]
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
