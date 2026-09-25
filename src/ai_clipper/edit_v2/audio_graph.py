"""The audio filter fragment: speech pieces, envelopes, music and mix (plan §5.3, §5.6).

Owner: T1.4. The seam with T1.3's ``compile_job`` (docs/editor/CONTRACTS.md, "T1.0
resolutions"):

* **In.** When the source has audio, ``compile_job`` provides one label per piece,
  ``[sa0]``, ``[sa1]``, … (``SOURCE_AUDIO_LABEL``), each the source's first audio stream as
  decoded from that piece's decoder run: native layout and rate, timestamps untouched
  (``-copyts``), no filter applied. The fragment's own inputs (envelope sidecars, the music
  asset) are ``[<first_input_index + k>:a]`` for the k-th ``InputSpec`` of ``inputs``.
* **Out.** Exactly one label, ``[apre]`` (``OUTPUT_LABEL``): the pre-master mix, 48 kHz
  stereo, identical in ``final``, ``reference``, ``audio_preview`` and ``audio_measure``.
  ``compile_job`` appends the master stage (the gain from ``loudness.output_gain``, then
  ``aresample=48000``) or, in ``audio_measure``, ``ebur128=peak=true``; ``master_filter``
  returns exactly that text.
* Internal labels start with ``au_``; sidecar names match ``audio-[a-z0-9-]+\\.[a-z0-9]+``.

The graph (every number is an integer computed from the document; no user string, path or
asset name ever appears in it):

* per piece ``i``: ``[sa<i>]aresample=48000,pan=stereo|FL=FL+FC|FR=FR+FC,asettb=1/48000,apad,
  atrim=start_pts=<a>:end_pts=<b>,asetpts=PTS-STARTPTS`` with ``a = smp(in_sf)`` and
  ``b = a + smp(out_f0 + frames) − smp(out_f0)`` (§5.3). The explicit ``pan`` maps a mono
  source (``FC``) to both channels at full gain and keeps stereo unchanged (the implicit upmix
  is −3 dB); ``apad`` makes a source whose audio ends early still yield the exact count;
* ``concat`` of the pieces, then ``amultiply`` with the speech envelope (micro-fades × source
  gain) when it is not 1.0 everywhere; without source audio, ``anullsrc`` trimmed to the exact
  sample count;
* music: ``-stream_loop -1`` when looping (the demuxer is forced to ``mov``), ``aresample``,
  ``pan``, ``atrim=start_sample=<src_in_smp>:end_sample=<src_in_smp + samples>``, then
  ``amultiply`` with the music envelope and ``amix=inputs=2:normalize=0:duration=first``;
* envelope sidecars are mono f32 at 48 kHz (``-f f32le -ar 48000 -ac 1``) panned to stereo
  with ``pan=stereo|c0=c0|c1=c0`` before ``amultiply`` (again no implicit −3 dB upmix);
* ``aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`` → ``[apre]``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from . import COMPILER_VERSION
from .compile_ffmpeg import InputSpec
from .envelope import (
    expand_f32,
    is_unity,
    music_envelope,
    music_item,
    speech_envelope,
)
from .plan import RenderPlan
from .timemap import SAMPLE_RATE, smp

SOURCE_AUDIO_LABEL = "sa{i}"
OUTPUT_LABEL = "apre"
LABEL_PREFIX = "au_"
AUDIO_MODES = ("final", "reference", "audio_preview", "audio_measure")

SPEECH_ENVELOPE = "audio-speech.f32"
MUSIC_ENVELOPE = "audio-music.f32"
ENVELOPE_OPTIONS = ("-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1")
MEASURE_FILTER = "ebur128=peak=true:framelog=verbose"
MIX_SCHEMA = "potongin-audio-mix/1"

_PAN_ANY = "pan=stereo|FL=FL+FC|FR=FR+FC"  # mono (FC) → both channels at 1.0; stereo kept
_PAN_MONO = "pan=stereo|c0=c0|c1=c0"  # envelope sidecars (mono f32) → stereo, exact copy
_RESAMPLE = f"aresample={SAMPLE_RATE}"
_FORMAT = f"aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo"


@dataclass(frozen=True)
class AudioFragment:
    graph: str  # filtergraph text: consumes [sa<i>] and its own inputs, produces [apre]
    inputs: tuple[InputSpec, ...]
    sidecars: Mapping[str, bytes]  # e.g. f32 envelopes
    mix_sha256: str  # identity of the pre-master mix (caches preview audio and measurements)


class _Graph:
    def __init__(self) -> None:
        self.chains: list[str] = []

    def close(self, text: str, label: str) -> str:
        self.chains.append(f"{text}[{label}]")
        return f"[{label}]"


def _build(plan: RenderPlan, first_input_index: int) -> tuple[str, tuple[InputSpec, ...],
                                                               dict[str, bytes]]:
    doc = plan.doc
    fps = plan.fps
    total = plan.total_samples
    graph = _Graph()
    inputs: list[InputSpec] = []
    sidecars: dict[str, bytes] = {}

    def own_input(spec: InputSpec) -> str:
        inputs.append(spec)
        return f"[{first_input_index + len(inputs) - 1}:a]"

    # Speech ---------------------------------------------------------------------------------
    if doc["base"]["source"]["has_audio"]:
        texts = []
        for piece in plan.pieces:
            start = smp(piece.in_sf, fps)
            end = start + smp(piece.out_f0 + piece.frames, fps) - smp(piece.out_f0, fps)
            texts.append(
                f"[{SOURCE_AUDIO_LABEL.format(i=piece.i)}]{_RESAMPLE},{_PAN_ANY},"
                f"asettb=1/{SAMPLE_RATE},apad,atrim=start_pts={start}:end_pts={end},"
                "asetpts=PTS-STARTPTS"
            )
        if len(texts) == 1:
            speech = texts[0]
        else:
            labels = [graph.close(text, f"{LABEL_PREFIX}p{i}") for i, text in enumerate(texts)]
            speech = "".join(labels) + f"concat=n={len(labels)}:v=0:a=1"
        main = doc["main"]
        joins = {join["after"]: join["audio_fade_ms"] for join in main.get("joins", ())}
        envelope = speech_envelope(plan.pieces, joins, main["cut_fade_ms"], fps,
                                   doc["audio"]["source"]["gain_cdb"])
        if not is_unity(envelope):
            sidecars[SPEECH_ENVELOPE] = expand_f32(envelope, total)
            source = graph.close(speech, f"{LABEL_PREFIX}sc")
            env_input = own_input(InputSpec("sidecar", SPEECH_ENVELOPE, ENVELOPE_OPTIONS))
            gain = graph.close(f"{env_input}{_PAN_MONO}", f"{LABEL_PREFIX}se")
            speech = f"{source}{gain}amultiply"
    else:
        speech = (f"anullsrc=channel_layout=stereo:sample_rate={SAMPLE_RATE},"
                  f"atrim=end_sample={total}")

    # Music ----------------------------------------------------------------------------------
    item = music_item(doc)
    if item is not None:
        payload = item["payload"]
        speech_label = graph.close(speech, f"{LABEL_PREFIX}s")
        options = ("-stream_loop", "-1", "-f", "mov") if payload["loop"] else ("-f", "mov")
        asset_input = own_input(InputSpec("asset", payload["asset"], options))
        first = payload["src_in_smp"]
        music = (f"{asset_input}{_RESAMPLE},{_PAN_ANY},"
                 f"atrim=start_sample={first}:end_sample={first + total},asetpts=PTS-STARTPTS")
        envelope = music_envelope(plan.speech_spans, item, total, fps)
        if not is_unity(envelope):
            sidecars[MUSIC_ENVELOPE] = expand_f32(envelope, total)
            raw = graph.close(music, f"{LABEL_PREFIX}mr")
            env_input = own_input(InputSpec("sidecar", MUSIC_ENVELOPE, ENVELOPE_OPTIONS))
            gain = graph.close(f"{env_input}{_PAN_MONO}", f"{LABEL_PREFIX}me")
            music = f"{raw}{gain}amultiply"
        music_label = graph.close(music, f"{LABEL_PREFIX}m")
        mix = f"{speech_label}{music_label}amix=inputs=2:normalize=0:duration=first"
    else:
        mix = speech
    graph.close(f"{mix},{_FORMAT}", OUTPUT_LABEL)
    return ";".join(graph.chains), tuple(inputs), sidecars


def _mix_sha256(plan: RenderPlan, graph: str, inputs: tuple[InputSpec, ...],
                sidecars: Mapping[str, bytes]) -> str:
    source = plan.doc["base"]["source"]
    identity: dict[str, Any] = {
        "schema": MIX_SCHEMA,
        "compiler": COMPILER_VERSION,
        "source": source["content_sha256"] if source["has_audio"] else None,
        "graph": graph,
        "inputs": [[spec.kind, spec.name, list(spec.options)] for spec in inputs],
        "sidecars": {name: hashlib.sha256(data).hexdigest()
                     for name, data in sorted(sidecars.items())},
        "samples": plan.total_samples,
    }
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def audio_fragment(plan: RenderPlan, *, mode: str, first_input_index: int) -> AudioFragment:
    """The audio fragment of ``plan`` for ``mode`` (one of ``AUDIO_MODES``).

    The fragment is the same in every mode (the mode only selects the master stage and the
    output, which ``compile_job`` adds). ``mix_sha256`` identifies the pre-master mix: it
    covers the source identity, the graph (with its own inputs numbered from 0), the input
    options, the envelope bytes and the sample count, but not ``first_input_index`` or the mode.
    """
    if mode not in AUDIO_MODES:
        raise ValueError(f"audio mode must be one of {AUDIO_MODES}")
    if type(first_input_index) is not int or first_input_index < 0:
        raise ValueError("first_input_index must be a non-negative integer")
    graph, inputs, sidecars = _build(plan, first_input_index)
    canonical_graph = graph if first_input_index == 0 else _build(plan, 0)[0]
    return AudioFragment(
        graph=graph,
        inputs=inputs,
        sidecars=sidecars,
        mix_sha256=_mix_sha256(plan, canonical_graph, inputs, sidecars),
    )


def _decibels(cdb: int) -> str:
    sign = "-" if cdb < 0 else ""
    return f"{sign}{abs(cdb) // 100}.{abs(cdb) % 100:02d}"


def master_filter(mode: str, gain_cdb: int) -> str:
    """The master stage ``compile_job`` appends after ``[apre]`` (CONTRACTS §5.8).

    ``audio_measure``: ``ebur128=peak=true:framelog=verbose`` (``framelog=verbose`` keeps the
    per-frame lines out of an ``info`` log, so only the summary is printed). Otherwise
    ``volume=<gain>dB`` (omitted when the gain is 0) and ``aresample=48000``; the gain comes
    from ``loudness.output_gain``.
    """
    if mode not in AUDIO_MODES:
        raise ValueError(f"audio mode must be one of {AUDIO_MODES}")
    if type(gain_cdb) is not int:
        raise TypeError("gain_cdb must be an integer")
    if mode == "audio_measure":
        return MEASURE_FILTER
    if gain_cdb == 0:
        return _RESAMPLE
    return f"volume={_decibels(gain_cdb)}dB,{_RESAMPLE}"


__all__ = [
    "AUDIO_MODES",
    "ENVELOPE_OPTIONS",
    "LABEL_PREFIX",
    "MEASURE_FILTER",
    "MUSIC_ENVELOPE",
    "OUTPUT_LABEL",
    "SOURCE_AUDIO_LABEL",
    "SPEECH_ENVELOPE",
    "AudioFragment",
    "audio_fragment",
    "master_filter",
]
