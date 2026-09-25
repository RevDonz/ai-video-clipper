"""Audio-only harness graph and the T1.4 audio gates (plan §5.3, §5.6, §10; §11.1 T1.4).

Until the W1 integrator connects T1.3's ``compile_job``, this module stands in for it with the
minimum the audio seam needs (docs/editor/CONTRACTS.md §5.8):

* one seeked ``-copyts`` input per piece (``-ss max(0, in_sf/F − 1.0)``, plan §5.2 R1) whose
  first audio stream is labelled ``[sa<i>]`` exactly as decoded;
* the fragment's own inputs after them (``first_input_index`` = number of source inputs);
* the master stage after ``[apre]`` (``audio_graph.master_filter`` with the gain of
  ``loudness.output_gain``) and the per-mode output: ``reference`` pcm_s16le in Matroska,
  ``audio_preview`` FLAC s16, ``final`` AAC-LC 192k, ``audio_measure`` to the null muxer.

Everything is synthetic and generated on the fly (``support.edit_v2_media``, FFmpeg lavfi);
FFmpeg runs with at most 4 threads. Gate evidence, measured in the reference image
``ai-video-clipper:editor-ref``::

    PYTHONPATH=src:tests python -m support.edit_v2_audio_harness gates docs/editor/evidence/W1
"""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ai_clipper.edit_v2 import audio_graph, envelope, loudness
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.audio_graph import AudioFragment
from ai_clipper.edit_v2.doc import Issue
from ai_clipper.edit_v2.loudness import Loudness
from ai_clipper.edit_v2.plan import RenderPlan
from ai_clipper.edit_v2.timemap import Fps
from support import edit_v2_media as media
from support.edit_v2_fixtures import make_render_plan

FFMPEG_THREADS = 4
RATE = 48_000
NTSC = (30000, 1001)
SOURCE_SHA = hashlib.sha256(b"t1.4-harness-source").hexdigest()
MUSIC_ASSET = "sha256:" + hashlib.sha256(b"t1.4-harness-music").hexdigest()
MUSIC_ASSET_META = {"kind": "audio", "mime": "audio/mp4", "duration_ms": 30_000, "lufs_c": -1800}
CLICK_THRESHOLD_DBFS = -40.0
DUCK_TOLERANCE_DB = 0.5
DUCK_RECOVERY_DB = 1.0
DUCK_WINDOW = 480  # 10 ms RMS windows

_OUTPUTS = {
    "reference": (("-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-f", "matroska"), ".mkv"),
    "audio_preview": (
        ("-c:a", "flac", "-sample_fmt", "s16", "-ar", "48000", "-ac", "2", "-f", "flac"),
        ".flac",
    ),
    "final": (("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-f", "mp4"), ".m4a"),
}


# --- documents -------------------------------------------------------------------------------


def music_track(**payload: Any) -> dict[str, Any]:
    """A music track like ``SetMusic`` makes (plan Appendix B), with ``payload`` overrides."""
    body: dict[str, Any] = {
        "asset": MUSIC_ASSET, "src_in_smp": 0, "loop": True, "gain_cdb": -1000,
        "fade_in_f": 15, "fade_out_f": 30,
        "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                 "hold_ms": 250, "detector": "words"},
    }
    duck = payload.pop("duck", {})
    body.update(payload)
    body["duck"] = {**body["duck"], **duck}
    item = {"id": "it_music", "type": "audio", "start": {"at": "clip_start"},
            "end": {"at": "clip_end"}, "payload": body, "origin": "user"}
    return {"id": "tr_mus", "kind": "audio", "role": "music", "items": [item]}


def audio_doc(
    *,
    segments: Sequence[tuple[str, str, int, int]],
    removals: Sequence[tuple[str, int, int]] = (),
    fps: tuple[int, int] = NTSC,
    cut_fade_ms: int = 8,
    join_fade_ms: int = 30,
    has_audio: bool = True,
    source_gain_cdb: int = 0,
    master_mode: str = "off",
    target_clufs: int = -1400,
    tp_cdb: int = -100,
    music: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """A clip-edit-v2 document with the fields the audio path reads (not a full seed)."""
    segs = [{"id": sid, "role": role, "in_sf": a, "out_sf": b} for sid, role, a, b in segments]
    cold_open = next((s["id"] for s in segs if s["role"] == "cold_open"), None)
    joins = ([] if cold_open is None else
             [{"after": cold_open, "style": "cut", "audio_fade_ms": join_fade_ms}])
    rms = [{"id": f"rm_{k}", "seg": seg, "in_sf": a, "out_sf": b, "words": [], "reason": "user",
            "origin": "user"} for k, (seg, a, b) in enumerate(removals, 1)]
    tracks = [] if music is None else [music_track(**dict(music))]
    return {
        "schema": "clip-edit-v2",
        "schema_minor": 0,
        "clip_id": "clip_" + "0" * 24,
        "revision": 1,
        "parent_sha256": "0" * 64,
        "base": {"source": {"content_sha256": SOURCE_SHA, "w": 1280, "h": 720,
                            "fps_native": list(fps), "vfr": False, "duration_ms": 30_000,
                            "has_audio": has_audio}},
        "output": {"w": 720, "h": 1280, "fps": list(fps), "sample_rate": RATE, "channels": 2},
        "main": {"segments": segs, "removals": rms, "joins": joins, "cut_fade_ms": cut_fade_ms},
        "tracks": tracks,
        "audio": {"source": {"gain_cdb": source_gain_cdb},
                  "master": {"mode": master_mode, "target_clufs": target_clufs,
                             "tp_cdb": tp_cdb}},
        "assets": {} if music is None else {MUSIC_ASSET: dict(MUSIC_ASSET_META)},
    }


def words_artifact(words_ms: Sequence[tuple[int, int]]) -> dict[str, Any]:
    return {"words": [{"id": f"w{k:06d}", "s": s, "e": e, "t": "x"}
                      for k, (s, e) in enumerate(words_ms)]}


def burst_words(duration_ms: int) -> list[tuple[int, int]]:
    """One word per tone burst of the default schedule (the speech of the synthetic source)."""
    return [(b.start_ms, b.end_ms) for b in media.default_bursts(duration_ms)]


def plan_for(doc: Mapping[str, Any], words_ms: Sequence[tuple[int, int]]) -> RenderPlan:
    return make_render_plan(doc, words_artifact(words_ms))


# --- media -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Media:
    source: Path | None
    assets: Mapping[str, Path]


def make_speech_source(path: Path, *, duration_ms: int = 20_000, level_cdb: int = -1200,
                       channels: int = 2, rate: int = RATE, clicks: bool = False) -> Path:
    """Tone bursts (two word-like bursts per second) at ``level_cdb`` peak, optionally with
    click markers; ``.m4a`` (AAC), ``.wav`` or ``.flac``."""
    if path.exists():
        return path
    bursts = tuple(media.ToneBurst(b.start_ms, b.end_ms, b.freq_hz, level_cdb)
                   for b in media.default_bursts(duration_ms))
    spec = media.AudioSpec(sample_rate=rate, channels=channels, bursts=bursts,
                           clicks_ms=None if clicks else ())
    return media.make_audio(path, spec, duration_ms=duration_ms)


def make_music(path: Path, *, duration_ms: int = 30_000, kind: str = "noise") -> Path:
    """A 48 kHz stereo AAC music asset: pink noise plus a 220 Hz tone (peak ≈ −1 dBFS), or a
    square wave (``kind="square"``, the codec stress probe)."""
    if path.exists():
        return path
    seconds = f"{duration_ms / 1000:.3f}"
    if kind == "square":
        graph = (f"aevalsrc='0.6*sgn(sin(2*PI*300*t))+0.3*sin(2*PI*2000*t)':s={RATE}:"
                 f"d={seconds},pan=stereo|c0=c0|c1=c0")
    else:
        graph = (f"anoisesrc=r={RATE}:c=pink:a=0.45:seed=7:d={seconds}[n];"
                 f"sine=f=220:r={RATE}:d={seconds},volume=7dB[s];"
                 "[n][s]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0")
    _ffmpeg(["-filter_complex", graph, "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE),
             "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
             "-threads", str(FFMPEG_THREADS), str(path)])
    return path


def _ffmpeg(args: Sequence[str], *, loglevel: str = "error", timeout_s: float = 300.0) -> str:
    ffmpeg = media.ffmpeg_path()
    if ffmpeg is None:
        raise media.MediaError("ffmpeg not found")
    argv = [ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-loglevel", loglevel, "-y", *args]
    try:
        result = subprocess.run(argv, capture_output=True, check=False, timeout=timeout_s)
    except subprocess.TimeoutExpired as error:
        raise media.MediaError(f"ffmpeg timed out after {timeout_s:.0f} s") from error
    stderr = result.stderr.decode("utf-8", "replace")
    if result.returncode != 0:
        raise media.MediaError("ffmpeg failed: " + " | ".join(stderr.strip().splitlines()[-5:]))
    return stderr


# --- running the fragment ------------------------------------------------------------------------


@dataclass(frozen=True)
class RunResult:
    mode: str
    output: Path | None
    stderr: str
    graph: str
    gain_cdb: int
    warnings: tuple[Issue, ...]
    fragment: AudioFragment


def _seek(in_sf: int, fps: Fps) -> str:
    """``max(0, in_sf/F − 1.0)`` seconds with microsecond precision (plan §5.2 R1)."""
    us = max(0, in_sf * fps.den * 1_000_000 // fps.num - 1_000_000)
    return f"{us // 1_000_000}.{us % 1_000_000:06d}"


def run(plan: RenderPlan, *, mode: str, sources: Media, work: Path, name: str | None = None,
        measured: Loudness | None = None) -> RunResult:
    """Run the audio fragment of ``plan`` in ``mode`` through FFmpeg (one process)."""
    work.mkdir(parents=True, exist_ok=True)
    stem = name or mode
    has_audio = bool(plan.doc["base"]["source"]["has_audio"])
    args: list[str] = []
    n_src = 0
    if has_audio:
        if sources.source is None:
            raise ValueError("the document has source audio but no source file was given")
        for piece in plan.pieces:
            args += ["-ss", _seek(piece.in_sf, plan.fps), "-copyts", "-vn", "-i",
                     str(sources.source)]
        n_src = len(plan.pieces)
    fragment = audio_graph.audio_fragment(plan, mode=mode, first_input_index=n_src)
    for spec in fragment.inputs:
        if spec.kind == "sidecar":
            path = work / f"{stem}-{spec.name}"
            path.write_bytes(fragment.sidecars[spec.name])
        elif spec.kind == "asset":
            path = Path(sources.assets[spec.name])
        else:
            raise ValueError(f"unexpected fragment input kind {spec.kind!r}")
        args += [*spec.options, "-i", str(path)]
    if mode == "audio_measure":
        gain, warnings = 0, ()
    else:
        gain, warnings = loudness.output_gain(plan.doc, measured)
    chains = [f"[{i}:a:0]anull[sa{i}]" for i in range(n_src)]
    chains += [fragment.graph, f"[apre]{audio_graph.master_filter(mode, gain)}[aout]"]
    graph = ";".join(chains)
    script = work / f"{stem}.graph.txt"
    script.write_text(graph, encoding="utf-8")
    args += ["-filter_complex_script", str(script), "-map", "[aout]",
             "-threads", str(FFMPEG_THREADS), "-filter_complex_threads", str(FFMPEG_THREADS),
             "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"]
    output: Path | None = None
    if mode == "audio_measure":
        args += ["-f", "null", "-"]
    else:
        options, suffix = _OUTPUTS[mode]
        output = work / f"{stem}{suffix}"
        args += [*options, str(output)]
    stderr = _ffmpeg(args, loglevel="info" if mode == "audio_measure" else "error")
    return RunResult(mode, output, stderr, graph, gain, tuple(warnings), fragment)


def measure(plan: RenderPlan, *, sources: Media, work: Path, name: str = "measure") -> Loudness:
    """The ``audio_measure`` pass: integrated loudness and true peak of the pre-master mix."""
    result = run(plan, mode="audio_measure", sources=sources, work=work, name=name)
    return loudness.parse_ebur128(result.stderr)


def render(plan: RenderPlan, *, mode: str, sources: Media, work: Path, name: str | None = None,
           measured: Loudness | None = None) -> RunResult:
    """Two-pass render: measure first when ``loudness.needs_measurement`` says so."""
    if measured is None and loudness.needs_measurement(plan.doc):
        measured = measure(plan, sources=sources, work=work, name=f"{name or mode}-measure")
    return run(plan, mode=mode, sources=sources, work=work, name=name, measured=measured)


def measure_file(path: Path) -> Loudness:
    """``ebur128=peak=true`` over a decoded file (the G3/G3b check on an export)."""
    stderr = _ffmpeg(["-i", str(path), "-map", "0:a:0", "-af",
                      "ebur128=peak=true:framelog=verbose", "-f", "null", "-"], loglevel="info")
    return loudness.parse_ebur128(stderr)


def pcm(path: Path) -> array.array:
    return media.read_pcm(path, sample_rate=RATE, channels=2)


def md5(samples: array.array) -> str:
    data = samples.tobytes() if sys.byteorder == "little" else _swapped(samples)
    return hashlib.md5(data).hexdigest()


def _swapped(samples: array.array) -> bytes:
    copy_ = array.array(samples.typecode, samples)
    copy_.byteswap()
    return copy_.tobytes()


def _db(value: float) -> float:
    return -math.inf if value <= 0 else 20 * math.log10(value)


def _round(value: float, digits: int = 3) -> float | None:
    return None if math.isinf(value) or math.isnan(value) else round(value, digits)


def _cdb(value: int) -> float:
    return value / 100


# --- scenarios -------------------------------------------------------------------------------------

# Cold open + body with three jump cuts; at 29.97 every join falls inside a tone burst of the
# synthetic source, so a hard cut would click.
CLICK_SEGMENTS = (("seg_co", "cold_open", 312, 385), ("seg_b1", "body", 43, 540))
CLICK_REMOVALS = (("seg_b1", 105, 136), ("seg_b1", 202, 227), ("seg_b1", 405, 468))
SOURCE_MS = 20_000

# Duck scenario (output time = source time): groups merged by hold, a release/attack overlap,
# isolated spans.
DUCK_WORDS_MS = ((1000, 1200), (1300, 1500), (1600, 1800), (3000, 3200), (3400, 3600),
                 (3900, 4300), (7000, 8000), (10000, 10050), (14000, 16500))


class Sources:
    """Synthetic media for the scenarios, generated once per work root."""

    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def speech(self, *, level_cdb: int = -1200, fmt: str = ".m4a", channels: int = 2,
               rate: int = RATE, clicks: bool = False) -> Path:
        name = f"speech-{-level_cdb}-{channels}ch-{rate}{'-clicks' if clicks else ''}{fmt}"
        return make_speech_source(self.root / name, duration_ms=SOURCE_MS, level_cdb=level_cdb,
                                  channels=channels, rate=rate, clicks=clicks)

    def music(self, kind: str = "noise") -> Path:
        return make_music(self.root / f"music-{kind}.m4a", kind=kind)

    def media(self, source: Path | None, music_kind: str | None = "noise") -> Media:
        assets = {} if music_kind is None else {MUSIC_ASSET: self.music(music_kind)}
        return Media(source, assets)


def click_doc(**kwargs: Any) -> dict[str, Any]:
    return audio_doc(segments=CLICK_SEGMENTS, removals=CLICK_REMOVALS, **kwargs)


def join_samples(plan: RenderPlan) -> list[int]:
    return [tm.smp(piece.out_f0, plan.fps) for piece in plan.pieces[1:]]


def join_steps(samples: array.array, joins: Sequence[int]) -> list[int]:
    """The largest sample step (s16, any channel) across each join: |x[J] − x[J−1]|."""
    return [max(abs(samples[2 * j + c] - samples[2 * (j - 1) + c]) for c in (0, 1))
            for j in joins]


def g_click(work: Path, sources: Sources | None = None) -> dict[str, Any]:
    """G-CLICK: the sample step at every join is below −40 dBFS (plan §5.3, §10.2)."""
    sources = sources or Sources(work / "media")
    source = sources.media(sources.speech(), music_kind=None)
    words = burst_words(SOURCE_MS)
    plan = plan_for(click_doc(), words)
    faded = pcm(render(plan, mode="reference", sources=source, work=work, name="faded").output)
    joins = join_samples(plan)
    steps = join_steps(faded, joins)
    hard_plan = plan_for(click_doc(cut_fade_ms=0, join_fade_ms=0), words)
    hard = pcm(render(hard_plan, mode="reference", sources=source, work=work, name="hard").output)
    hard_steps = join_steps(hard, joins)
    steps_db = [_db(step / 32768) for step in steps]
    failures = sum(db >= CLICK_THRESHOLD_DBFS for db in steps_db)
    return {
        "gate": "G-CLICK",
        "threshold_dbfs": CLICK_THRESHOLD_DBFS,
        "joins": len(joins),
        "join_samples": joins,
        "cut_fade_ms": 8,
        "cold_open_fade_ms": 30,
        "steps_dbfs": [_round(db, 2) for db in steps_db],
        "max_step_dbfs": _round(max(steps_db), 2),
        "control_hard_cuts_steps_dbfs": [_round(_db(s / 32768), 2) for s in hard_steps],
        "control_hard_cuts_detected": sum(_db(s / 32768) >= CLICK_THRESHOLD_DBFS
                                          for s in hard_steps),
        "samples": len(faded) // 2,
        "plan_samples": plan.total_samples,
        "failures": failures + int(len(faded) // 2 != plan.total_samples),
    }


def _rms(samples: array.array, start: int, length: int) -> float:
    chunk = samples[2 * start: 2 * (start + length)]
    return math.sqrt(sum(v * v for v in chunk) / len(chunk)) if chunk else 0.0


def duck_gate(work: Path, sources: Sources | None = None) -> dict[str, Any]:
    """Duck gate (plan §10.2): the music-only stem during speech is unducked − depth ± 0.5 dB
    after the attack, and back within 1 dB of unducked by release + 50 ms after end + hold."""
    sources = sources or Sources(work / "media")
    stem = sources.media(None)
    music = {"gain_cdb": 0, "fade_in_f": 0, "fade_out_f": 0}
    segments = (("seg_b1", "body", 0, 600),)
    ducked_plan = plan_for(audio_doc(segments=segments, has_audio=False, music=music),
                           DUCK_WORDS_MS)
    flat = {**music, "duck": {"on": False}}
    flat_plan = plan_for(audio_doc(segments=segments, has_audio=False, music=flat),
                         DUCK_WORDS_MS)
    # One measurement for both stems: the master stage (peak protection) then applies the same
    # gain to both, so their ratio is the duck envelope alone.
    measured = measure(flat_plan, sources=stem, work=work, name="unducked-m")
    ducked = pcm(run(ducked_plan, mode="reference", sources=stem, work=work, name="ducked",
                     measured=measured).output)
    unducked = pcm(run(flat_plan, mode="reference", sources=stem, work=work, name="unducked",
                       measured=measured).output)
    duck = ducked_plan.doc["tracks"][0]["items"][0]["payload"]["duck"]
    depth_db = duck["depth_cdb"] / 100
    attack, hold, release = (duck[k] * RATE // 1000 for k in ("attack_ms", "hold_ms",
                                                                "release_ms"))
    spans = envelope.merge_spans(ducked_plan.speech_spans, hold)
    rows = []
    failures = 0
    for index, (start, end) in enumerate(spans):
        deviations = []
        position = start
        while position + DUCK_WINDOW <= end + hold:
            ratio = _db(_rms(ducked, position, DUCK_WINDOW) / _rms(unducked, position,
                                                                     DUCK_WINDOW))
            deviations.append(ratio + depth_db)
            position += DUCK_WINDOW
        worst = max((abs(d) for d in deviations), default=0.0)
        row: dict[str, Any] = {"span": [start, end], "windows": len(deviations),
                               "max_deviation_db": _round(worst)}
        failures += worst > DUCK_TOLERANCE_DB or not deviations
        check = end + hold + release + 50 * RATE // 1000
        following = spans[index + 1][0] - attack if index + 1 < len(spans) else math.inf
        if check + DUCK_WINDOW <= min(following, ducked_plan.total_samples):
            recovery = _db(_rms(ducked, check, DUCK_WINDOW) / _rms(unducked, check, DUCK_WINDOW))
            row["recovery_db"] = _round(recovery)
            failures += abs(recovery) > DUCK_RECOVERY_DB
        else:
            row["recovery_db"] = None  # the next span's attack starts first (legitimately ducked)
        rows.append(row)
    return {
        "gate": "duck",
        "depth_db": depth_db,
        "tolerance_db": DUCK_TOLERANCE_DB,
        "recovery_tolerance_db": DUCK_RECOVERY_DB,
        "attack_ms": duck["attack_ms"],
        "hold_ms": duck["hold_ms"],
        "release_ms": duck["release_ms"],
        "window_samples": DUCK_WINDOW,
        "spans": rows,
        "recovery_checks": sum(row["recovery_db"] is not None for row in rows),
        "samples": len(ducked) // 2,
        "plan_samples": ducked_plan.total_samples,
        "failures": failures + int(len(ducked) // 2 != ducked_plan.total_samples),
    }


def _mixes(sources: Sources) -> list[tuple[str, dict[str, Any], Media]]:
    """The G3/G3b mixes: (name, document, media)."""
    speech = sources.speech()
    loud = sources.speech(level_cdb=-100)
    body = (("seg_b1", "body", 0, 600),)
    ducked = {"gain_cdb": -1000}
    hot = {"gain_cdb": 600, "fade_in_f": 0, "fade_out_f": 0, "duck": {"on": False}}
    return [
        ("speech", click_doc(master_mode="normalize"), sources.media(speech, None)),
        ("music_ducked", click_doc(master_mode="normalize", music=ducked),
         sources.media(speech)),
        ("hot", audio_doc(segments=body, master_mode="normalize", music=hot),
         sources.media(loud)),
        ("hot", audio_doc(segments=body, master_mode="off", music=hot), sources.media(loud)),
        ("speech_gain_12db", click_doc(source_gain_cdb=1200), sources.media(speech, None)),
        ("music_ducked", click_doc(music=ducked), sources.media(speech)),
    ]


def _loudness_row(name: str, doc: dict[str, Any], sources_: Media, work: Path) -> dict[str, Any]:
    plan = plan_for(doc, burst_words(SOURCE_MS))
    mode = doc["audio"]["master"]["mode"]
    tag = f"{name}-{mode}"
    pre = measure(plan, sources=sources_, work=work, name=f"{tag}-measure")
    result = run(plan, mode="final", sources=sources_, work=work, name=tag, measured=pre)
    export = measure_file(result.output)
    return {
        "name": name,
        "mode": mode,
        "pre_master_i_lufs": _cdb(pre.i_clufs),
        "pre_master_tp_dbtp": _cdb(pre.tp_cdb),
        "gain_db": _cdb(result.gain_cdb),
        "warnings": [w.code.split(":", 1)[0] for w in result.warnings],
        "warning_details": [w.code for w in result.warnings],
        "export_i_lufs": _cdb(export.i_clufs),
        "export_tp_dbtp": _cdb(export.tp_cdb),
        "target_lufs": _cdb(doc["audio"]["master"]["target_clufs"]),
        "achieved_lufs": _cdb(pre.i_clufs + result.gain_cdb),
    }


def g3_g3b(work: Path, sources: Sources | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """G3 (normalize: −14 ± 1 LUFS or the recorded clamped value ± 0.5 LU; TP ≤ −1.0 dBTP) and
    G3b (music or source gain > 0: TP ≤ −1.0 dBTP), both on the decoded AAC export."""
    sources = sources or Sources(work / "media")
    mixes = _mixes(sources)
    rows = [_loudness_row(name, doc, src, work) for name, doc, src in mixes]
    g3_rows = []
    for row in (r for r in rows if r["mode"] == "normalize"):
        if "loudness_clamped" in row["warnings"]:
            loud_ok = abs(row["export_i_lufs"] - row["achieved_lufs"]) <= 0.5
        else:
            loud_ok = abs(row["export_i_lufs"] - row["target_lufs"]) <= 1.0
        g3_rows.append({**row, "pass": bool(loud_ok and row["export_tp_dbtp"] <= -1.0)})
    g3b_rows = []
    for row, (_name, doc, _src) in zip(rows, mixes):
        if doc["tracks"] or doc["audio"]["source"]["gain_cdb"] > 0:
            g3b_rows.append({**row, "pass": row["export_tp_dbtp"] <= -1.0})
    # Informational stress probe (not part of the gate): a square-wave music bed shows how far
    # the AAC encoder can push the true peak above the protected pre-encode level.
    stress_doc = audio_doc(segments=(("seg_b1", "body", 0, 600),), master_mode="off",
                           music={"gain_cdb": 600, "fade_in_f": 0, "fade_out_f": 0,
                                  "duck": {"on": False}})
    stress = _loudness_row("square_stress", stress_doc,
                           sources.media(sources.speech(level_cdb=-100), "square"), work)
    g3 = {"gate": "G3", "target_tolerance_lu": 1.0, "clamped_tolerance_lu": 0.5,
          "tp_max_dbtp": -1.0, "encode": "aac 192k 48 kHz stereo", "mixes": g3_rows,
          "failures": sum(not r["pass"] for r in g3_rows)}
    g3b = {"gate": "G3b", "tp_max_dbtp": -1.0,
           "peak_ceiling_dbtp": _cdb(loudness.PEAK_CEILING_CDB),
           "encode_headroom_db": _cdb(loudness.ENCODE_HEADROOM_CDB),
           "encode": "aac 192k 48 kHz stereo", "mixes": g3b_rows,
           "failures": sum(not r["pass"] for r in g3b_rows),
           "stress_probe_informational": stress}
    return g3, g3b


def p_aud(work: Path, sources: Sources | None = None) -> dict[str, Any]:
    """P-AUD (server): two reference runs give the same PCM md5; the ``audio_preview`` FLAC
    decodes to the same PCM as ``reference``; sample count == plan samples."""
    sources = sources or Sources(work / "media")
    source = sources.media(sources.speech())
    doc = click_doc(master_mode="normalize", source_gain_cdb=-300,
                    music={"gain_cdb": -800, "src_in_smp": 12_345})
    plan = plan_for(doc, burst_words(SOURCE_MS))
    first = measure(plan, sources=source, work=work, name="m1")
    second = measure(plan, sources=source, work=work, name="m2")
    ref1 = run(plan, mode="reference", sources=source, work=work, name="ref1", measured=first)
    ref2 = run(plan, mode="reference", sources=source, work=work, name="ref2", measured=first)
    preview = run(plan, mode="audio_preview", sources=source, work=work, name="preview",
                  measured=first)
    pcm1, pcm2, pcm3 = pcm(ref1.output), pcm(ref2.output), pcm(preview.output)
    md5s = [md5(pcm1), md5(pcm2), md5(pcm3)]
    mix_shas = {audio_graph.audio_fragment(plan, mode=mode, first_input_index=k).mix_sha256
                for mode in audio_graph.AUDIO_MODES for k in (0, 7)}
    counts = [len(pcm1) // 2, len(pcm2) // 2, len(pcm3) // 2]
    checks = {
        "reference_runs_identical": md5s[0] == md5s[1],
        "preview_equals_reference": md5s[2] == md5s[0],
        "sample_counts_equal_plan": all(c == plan.total_samples for c in counts),
        "measurement_deterministic": first == second,
        "graphs_identical": ref1.graph == ref2.graph == preview.graph,
        "one_mix_sha_across_modes": len(mix_shas) == 1,
    }
    return {
        "gate": "P-AUD (server)",
        "pcm_md5": {"reference_1": md5s[0], "reference_2": md5s[1], "audio_preview": md5s[2]},
        "samples": counts,
        "plan_samples": plan.total_samples,
        "master_gain_db": _cdb(ref1.gain_cdb),
        "checks": checks,
        "failures": sum(not ok for ok in checks.values()),
    }


# --- CLI ----------------------------------------------------------------------------------------------


def _ffmpeg_version() -> str:
    ffmpeg = media.ffmpeg_path()
    if ffmpeg is None:
        return "missing"
    out = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=False)
    return out.stdout.splitlines()[0] if out.stdout else "unknown"


def gates(out_dir: Path) -> dict[str, dict[str, Any]]:
    header = {"ffmpeg": _ffmpeg_version(),
              "reference_toolchain_problem": media.reference_toolchain_problem(),
              "harness": "support.edit_v2_audio_harness (audio-only graph, until compile_job)"}
    with tempfile.TemporaryDirectory(prefix="t14-gates-") as tmp:
        work = Path(tmp)
        sources = Sources(work / "media")
        g3, g3b = g3_g3b(work / "loud", sources)
        reports = {
            "G-CLICK": g_click(work / "click", sources),
            "duck": duck_gate(work / "duck", sources),
            "G3": g3,
            "G3b": g3b,
            "P-AUD": p_aud(work / "paud", sources),
        }
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, report in reports.items():
        path = out_dir / f"T1.4-{name}.json"
        path.write_text(json.dumps({**header, **report}, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")
    return reports


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="T1.4 audio harness and gates")
    commands = parser.add_subparsers(dest="command", required=True)
    run_gates = commands.add_parser("gates", help="measure every T1.4 gate and write evidence")
    run_gates.add_argument("out_dir", type=Path)
    args = parser.parse_args(argv)
    reports = gates(args.out_dir)
    failures = {name: report["failures"] for name, report in reports.items()}
    print(json.dumps(failures, sort_keys=True))
    return 1 if any(failures.values()) else 0


if __name__ == "__main__":
    sys.exit(main())


__all__ = [
    "MUSIC_ASSET",
    "MUSIC_ASSET_META",
    "Media",
    "RunResult",
    "Sources",
    "audio_doc",
    "burst_words",
    "click_doc",
    "duck_gate",
    "g3_g3b",
    "g_click",
    "gates",
    "join_samples",
    "join_steps",
    "measure",
    "measure_file",
    "music_track",
    "p_aud",
    "pcm",
    "plan_for",
    "render",
    "run",
    "words_artifact",
]
