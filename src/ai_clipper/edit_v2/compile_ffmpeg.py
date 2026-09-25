"""Turn a ``RenderPlan`` into FFmpeg work for one mode (plan §5.1, §5.2 R1–R9).

Every caller (pipeline, render-worker, preview lane, gates) goes through ``compile_job`` and
``execute.run``. The graph rules, each pinned by a string golden
(``tests/fixtures/edit_v2/goldens``):

* **R1 frame identity** (the PF grid rule): each decoder run is
  ``-ss (first_sf/F − 1) -copyts -i``; a run of one piece is
  ``fps=num/den,trim=start_pts=<in_sf>:end_pts=<out_sf>,setpts=PTS-STARTPTS`` verbatim. Plate
  cells use the same rule over ``[k·C, (k+1)·C)``, so a plate frame and a final frame for the
  same source frame are the same decoded frame.
* **R2 decoder runs**: consecutive pieces whose source gap is below 10 s (forward) share one
  seeked input. Their video is **one** chain, ``fps=num/den,select='<ranges>',setpts=N``: after
  ``fps`` the ``pts`` is the grid index, so ``select`` on the pieces' ``[in_sf, out_sf)`` keeps
  exactly the frames the per-piece ``trim`` keeps, in the same order (P-FRAME re-measured), and
  a document with up to 2,000 removals needs no ``split`` into one ``fps`` per piece (measured,
  150 pieces: 89 MiB and 0.6 s against 196 MiB and 1.2 s; 1,000 removals render in 10.5 s
  without audio). The source audio keeps one ``asplit`` label per piece (the §5.8 seam).
* **R3** the layout output is ``setsar=1``, every format change is an explicit ``scale`` with its
  matrices, and ``settb=den/num`` follows ``concat`` (the frame-safe ASS rule, §3.4).
* **R4** layouts from ``layouts.py``, applied **once, after the pieces are joined** (a plate
  run is one piece). The layout is per frame, so the pixels equal one chain per piece, but the
  graph keeps one set of scale/blur contexts however many cuts there are: measured with 22
  pieces (20 cuts + cold open, fit_blur, FFmpeg 6.1), a chain per piece peaked at 4.0 GiB of
  address space and 162 threads (each ``scale`` starts its own slice threads) and failed under
  the 3 GiB ``RLIMIT_AS`` of R8, while a document may hold up to 2,000 removals. The camera
  crop x is a table indexed by the output frame (values = the plan's x at the source frame
  shown), identical per source frame in plate cells and final renders.
* **R5** text composited in ``COMPOSITE_FORMAT``
  (``ass`` with ``shaping=complex``), then the logo, then BT.709/tv 4:2:0; **R7** the Standar
  encode; **R8** no user string in argv or the graph (text reaches FFmpeg only inside the ASS
  sidecar), inputs as ``/proc/self/fd/N`` tokens, ``-protocol_whitelist file,pipe``,
  ``-progress``; **R9** see ``plan.render_key``.

The argv is a template: ``@in:<k>`` (the k-th input), ``@out`` (the output fd) and
``@progress`` (the progress pipe) are resolved by ``execute.run``, which also writes the
sidecars and ``filter_graph.txt`` into a private directory that is FFmpeg's working directory.

``InputSpec`` is also the seam with T1.4: ``audio_graph.audio_fragment`` returns its own inputs
as ``InputSpec`` values; the fragment consumes ``[sa<i>]`` (the source audio of piece ``i`` as
decoded) and produces ``[apre]``, to which ``compile_job`` appends the master stage.
"""

from __future__ import annotations

import functools
import json
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import render as _render
from . import errors, layouts
from . import timemap as tm
from .plan import RenderPlan
from .timemap import Fps, Piece

if TYPE_CHECKING:
    from .loudness import Loudness

MODES = (
    "final",  # pipeline and render-worker: H.264/AAC MP4 at size, plus the .srt sidecar
    "reference",  # gates only: ffv1 in .mkv + pcm_s16le, same graph, no encode loss
    "plate_cells",  # preview lane: layout-only cells, crf 18, IDR at every cell start
    "frame",  # preview lane: one final-graph frame incl. 4:2:0 + intra encode → PNG
    "audio_preview",  # preview lane: the final audio graph → FLAC s16 48 kHz stereo
    "audio_measure",  # pre-master mix → ebur128=peak=true
    "derive_image",  # logo asset → exact pixel box, opacity baked → PNG
)
QUALITIES = ("standar",)  # Essentials; "tinggi" is Stage 2 (K14)

# Plan §5.2 R5 / E6: the text compositing format. Spike S-COLOR (T1.2b, docs/editor/SPIKES.md
# §1) chose planar RGB: FFmpeg 5.1.9's ``ass`` converts ASS colours with BT.601 coefficients in
# the YUV formats (up to 23 levels off in a BT.709 file), so only ``gbrp`` passes P-TXT and
# P-COLOR, at +11.7 % render cost. Applied by the W1 integrator before any render with
# RENDER_SEMANTICS 1 existed, so the semantics version stays 1.
COMPOSITE_FORMATS = ("yuv420p", "yuv444p", "gbrp")
COMPOSITE_FORMAT = "gbrp"

FFMPEG_THREADS = 4
DECODER_RUN_GAP_S = 10  # R2
PREROLL_S = 1  # R1
STANDAR = ("veryfast", 21)  # R7 (preset, crf)
PLATE = ("veryfast", 18)  # §5.1 plate_cells
AAC_BITRATE = "192k"  # K4
SAMPLE_RATE = 48_000

INPUT_TOKEN = "@in:{}"
OUTPUT_TOKEN = "@out"
PROGRESS_TOKEN = "@progress"
GRAPH_FILE = "filter_graph.txt"
CAPTIONS_FILE = "captions.ass"
FONTS_DIR = "fonts"
FRAME_H264 = "frame.h264"
FRAME_PNG = "frame.png"
DERIVED_PNG = "derived.png"
CELL_PATTERN = "c%07d.mp4"
SIDECAR_NAME = re.compile(r"audio-[a-z0-9-]+\.[a-z0-9]+")  # §5.8: fragment sidecars
_ASSET_ID = re.compile(r"sha256:([0-9a-f]{64})")
_ASSET_EXTENSION = {"image": ".png", "audio": ".m4a"}  # §4.1 analysis/assets/<sha>.{png,m4a}

_WHITELIST = ("-protocol_whitelist", "file,pipe")
_COLOR_TAGS = ("-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
               "-color_range", "tv")
_BITEXACT = ("-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
             "-flags:a", "+bitexact")
_YUV_TO_709 = "scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv"
# R5: into the composite format, after the text and logo back to BT.709/tv 4:2:0.
_TEXT_IN = {
    "yuv420p": f"{_YUV_TO_709},format=yuv420p",
    "yuv444p": f"{_YUV_TO_709},format=yuv444p",
    "gbrp": "scale=in_color_matrix=bt709:in_range=tv,format=gbrp",
}
_TO_OUTPUT = {
    "yuv420p": f"{_YUV_TO_709},format=yuv420p",
    "yuv444p": f"{_YUV_TO_709},format=yuv420p",
    "gbrp": "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
}
_LOGO_FORMAT = {
    "yuv420p": "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p",
    "yuv444p": "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p",
    "gbrp": "scale,format=gbrap",
}
_OVERLAY_FORMAT = {"yuv420p": "yuv420", "yuv444p": "yuv444", "gbrp": "gbrp"}
_TEXT_FILTER = f"ass=filename={CAPTIONS_FILE}:fontsdir={FONTS_DIR}:shaping=complex"
_PNG_DECODE = "scale=in_color_matrix=bt709:in_range=tv,format=rgb24"


@dataclass(frozen=True, slots=True)
class InputSpec:
    """One FFmpeg input, opened by ``execute.run`` and passed as ``/proc/self/fd/N``.

    ``kind`` is ``"source"`` (the job's source video; ``name`` = ``"source"``), ``"asset"``
    (``name`` = ``"sha256:<hex>"`` in the job asset store) or ``"sidecar"`` (``name`` = a key of
    the job's or fragment's ``sidecars``). ``options`` are input options placed before ``-i``
    (e.g. ``("-f", "f32le", "-ar", "48000", "-ac", "1")`` or ``("-stream_loop", "-1")``).
    """

    kind: str
    name: str
    options: tuple[str, ...] = ()


@dataclass(frozen=True)
class FfmpegJob:
    argv: tuple[str, ...]  # template: @in:<k>, @out and @progress are resolved by execute.run
    filter_script: str  # the -filter_complex_script text (written as filter_graph.txt)
    inputs: tuple[InputSpec, ...]
    sidecars: Mapping[str, bytes]  # constant names in a private 0700 temp directory
    expected: Mapping[str, Any]  # frames, samples, size, paths, output kind: verify/execute


# --- source probe ------------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceStreams:
    """The selected streams of a source and the video's geometry.

    Stream selection is ``render._probe_source``'s rule (the default-disposition video that is
    not an attached picture, else the first; the default audio, else the first), so both
    engines render the same streams. ``duration_s`` is informational (``None`` when neither the
    stream nor the container states one).
    """

    video_index: int
    audio_index: int | None
    width: int
    height: int
    color_space: str | None
    color_range: str | None
    duration_s: float | None


def _default_first(streams: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    return next((item for item in streams if item.get("disposition", {}).get("default", 0)),
                streams[0] if streams else None)


_PROBE_ENTRIES = ("stream=index,codec_type,duration,duration_ts,time_base,width,height,color_space,"
                  "color_range:stream_disposition=attached_pic,default:format=duration")


@functools.lru_cache(maxsize=32)
def _probe_cached(path: str, _identity: tuple[int, int, int, int]) -> SourceStreams:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", _PROBE_ENTRIES, "-of", "json", path],
        capture_output=True, text=True, timeout=_render.FFPROBE_TIMEOUT_SECONDS, check=True)
    info = json.loads(result.stdout)
    streams = info["streams"]
    video = _default_first([item for item in streams if item.get("codec_type") == "video"
                            and not item.get("disposition", {}).get("attached_pic", 0)])
    audio = _default_first([item for item in streams if item.get("codec_type") == "audio"])
    if video is None:
        raise ValueError("the source has no video stream")
    try:
        duration: float | None = _render._stream_duration(dict(video))
    except (KeyError, ValueError):  # e.g. Matroska: only the container states a duration
        container = info.get("format", {}).get("duration")
        duration = None if container in (None, "N/A") else float(container)
    return SourceStreams(int(video["index"]), None if audio is None else int(audio["index"]),
                         int(video["width"]), int(video["height"]), video.get("color_space"),
                         video.get("color_range"), duration)


def probe_source(source: Path) -> SourceStreams:
    """Probe ``source`` once per file identity (inode, size, mtime); failures are
    ``RenderFailed`` (``render_failed``)."""
    try:
        info = os.stat(source)
        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        return _probe_cached(str(source), identity)
    except (OSError, RuntimeError, subprocess.SubprocessError, KeyError, IndexError, TypeError,
            ValueError) as exc:
        raise errors.RenderFailed("render_failed") from exc


# --- R1 / R2 ------------------------------------------------------------------------------------


def decoder_runs(pieces: Sequence[Piece], fps: Fps) -> tuple[tuple[int, ...], ...]:
    """Positions of the pieces that share one seeked input (R2): each next piece joins the run
    when it starts at or after the previous piece's end and less than 10 s later."""
    runs: list[list[int]] = []
    for position, piece in enumerate(pieces):
        if runs:
            gap = piece.in_sf - pieces[runs[-1][-1]].out_sf
            if 0 <= gap and gap * fps.den < DECODER_RUN_GAP_S * fps.num:
                runs[-1].append(position)
                continue
        runs.append([position])
    return tuple(tuple(run) for run in runs)


def seek_arg(first_sf: int, fps: Fps) -> str:
    """``-ss`` of a decoder run: ``max(0, first_sf·den/num − 1)`` s, floored to microseconds
    (R1: one second of pre-roll before the first frame)."""
    micro = first_sf * fps.den * 1_000_000 // fps.num - PREROLL_S * 1_000_000
    micro = max(micro, 0)
    return f"{micro // 1_000_000}.{micro % 1_000_000:06d}"


def _x264(preset: str, crf: int, gop: int) -> tuple[str, ...]:
    return ("-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-g", str(gop), "-x264-params", f"threads={FFMPEG_THREADS}",
            *_COLOR_TAGS)


def _head(loglevel: str, *, copyts: bool) -> list[str]:
    # -y: the output is the caller's fd (it exists); FFmpeg would otherwise exit, with status 0.
    head = ["ffmpeg", "-nostdin", "-y", "-hide_banner", "-nostats", "-loglevel", loglevel,
            "-progress", PROGRESS_TOKEN]
    return head + (["-copyts"] if copyts else [])


def asset_path(assets_root: Path, name: str, kind: str) -> Path:
    """``analysis/assets/<sha256>.{png,m4a}`` for an asset id (plan §4.1)."""
    match = _ASSET_ID.fullmatch(name)
    if match is None or kind not in _ASSET_EXTENSION:
        raise ValueError("invalid asset reference")
    return Path(assets_root) / f"{match.group(1)}{_ASSET_EXTENSION[kind]}"


# --- the compiler --------------------------------------------------------------------------------


class _Compiler:
    def __init__(self, plan: RenderPlan, streams: SourceStreams, source: Path,
                 assets_root: Path, mode: str) -> None:
        self.plan = plan
        self.streams = streams
        self.mode = mode
        self.fps = plan.fps
        self.assets_root = assets_root
        self.inputs: list[InputSpec] = []
        self.graph: list[str] = []
        self.sidecars: dict[str, bytes] = {}
        self.video_runs = 0  # [vr<r>] labels made by decoded()
        self.expected: dict[str, Any] = {
            "mode": mode,
            "fps": plan.fps.to_json(),
            "size": list(plan.output),
            "paths": {"source": str(source)},
            "assets_root": str(assets_root),
        }
        if plan.resources is not None:
            self.expected["fonts_dir"] = str(plan.resources.fonts_dir)
            self.expected["fontconfig_file"] = str(plan.resources.fontconfig_file)
        self.matrix = layouts.color_matrix(streams.color_space, streams.height)
        self.in_range = "pc" if streams.color_range == "pc" else "tv"
        self.audio = bool(plan.doc["base"]["source"]["has_audio"])
        self.composite = COMPOSITE_FORMAT
        if self.composite not in COMPOSITE_FORMATS:
            raise ValueError(f"unknown composite format: {self.composite}")

    # inputs
    def add_input(self, spec: InputSpec) -> int:
        self.inputs.append(spec)
        return len(self.inputs) - 1

    def add_asset(self, spec: InputSpec) -> int:
        meta = self.plan.assets.get(spec.name)
        if meta is None:
            raise errors.DocSemanticInvalid("asset_missing", ref=spec.name)
        self.expected["paths"][spec.name] = str(asset_path(self.assets_root, spec.name,
                                                           meta["kind"]))
        return self.add_input(spec)

    def source_input(self, first_sf: int) -> int:
        return self.add_input(InputSpec("source", "source", (
            "-threads", str(FFMPEG_THREADS), "-ss", seek_arg(first_sf, self.fps))))

    def argv_inputs(self) -> list[str]:
        argv: list[str] = []
        for index, spec in enumerate(self.inputs):
            argv += [*_WHITELIST, *spec.options, "-i", INPUT_TOKEN.format(index)]
        return argv

    # video
    def trim(self, label_in: str, in_sf: int, out_sf: int, shift: int, label_out: str) -> str:
        """R1, the measured grid rule: source-grid frames ``[in_sf, out_sf)`` of one decoder run,
        restamped from 0 (``+shift`` in ``frame`` mode)."""
        fps = self.fps
        setpts = "setpts=PTS-STARTPTS" + (f"+{shift}" if shift else "")
        return (f"{label_in}fps={fps.num}/{fps.den},trim=start_pts={in_sf}:end_pts={out_sf},"
                f"{setpts}{label_out}")

    def run_chain(self, label_in: str, ranges: Sequence[tuple[int, int]], shift: int,
                  label_out: str) -> str:
        """The frames of one decoder run: R1's ``trim`` for a single range; for several, the
        same grid frames kept by one ``select`` on the grid index (``pts`` after ``fps``) and
        renumbered, instead of ``split`` into one ``trim`` per piece (see the module notes)."""
        if len(ranges) == 1:
            return self.trim(label_in, ranges[0][0], ranges[0][1], shift, label_out)
        if shift:
            raise ValueError("only a single range can be shifted")
        fps = self.fps
        return (f"{label_in}fps={fps.num}/{fps.den},select='{select_expression(ranges)}',"
                f"setpts=N{label_out}")

    def layout(self, label_in: str, ranges: Sequence[tuple[int, int]], label_out: str,
               suffix: str = "_0") -> str:
        """R4: one layout chain over frames that show the source-grid ``ranges`` in order.

        The layout is per frame (scale, crop, blur, overlay), so applying it once after the
        pieces are joined gives the same pixels as one chain per piece, with one set of
        filter contexts however many cuts there are. The camera crop x of output frame ``n``
        is the plan's value at the source frame it shows, so a plate cell and a final render
        crop any source frame at the same x. ``suffix`` keeps fit_blur's internal labels unique
        when a job holds several chains (plate runs).
        """
        crop = None
        if self.plan.layout == "camera":
            if self.plan.camera is None:
                raise errors.AnalysisMissing("analysis_missing", ref="camera")
            crop = []
            for in_sf, out_sf in ranges:
                crop.extend(layouts.crop_positions(
                    self.plan.camera, self.fps, source=(self.streams.width, self.streams.height),
                    output=self.plan.output, first_sf=in_sf, count=out_sf - in_sf))
        return layouts.layout_chain(
            self.plan.layout, label_in=label_in, label_out=label_out, suffix=suffix,
            output=self.plan.output, source=(self.streams.width, self.streams.height),
            matrix=self.matrix, in_range=self.in_range, crop=crop)

    def decoded(self, branches: Sequence[tuple[int, int, int]],
                runs: Sequence[Sequence[int]], *, video: bool, audio: bool) -> None:
        """One seeked input per decoder run: ``[vr<r>]`` the run's frames (R1), and ``[sa<i>]``
        the source audio of each branch ``i`` as decoded (the T1.4 seam, §5.8)."""
        for r, run in enumerate(runs):
            k = self.source_input(branches[run[0]][0])
            if video:
                ranges = [(branches[i][0], branches[i][1]) for i in run]
                shift = branches[run[0]][2]
                self.graph.append(self.run_chain(f"[{k}:{self.streams.video_index}]", ranges,
                                                 shift, f"[vr{r}]"))
            if audio:
                labels = "".join(f"[sa{i}]" for i in run)
                split = f"asplit={len(run)}" if len(run) > 1 else "anull"
                self.graph.append(f"[{k}:{self.streams.audio_index}]{split}{labels}")
        self.video_runs = len(runs) if video else 0

    def picture(self, branches: Sequence[tuple[int, int, int]]) -> None:
        """Runs → concat → layout → text → logo → BT.709 4:2:0 ``[vout]`` (R1–R5)."""
        fps = self.fps
        labels = "".join(f"[vr{r}]" for r in range(self.video_runs))
        if self.video_runs > 1:
            join = f"concat=n={self.video_runs}:v=1:a=0,settb={fps.den}/{fps.num}"
        else:
            join = f"settb={fps.den}/{fps.num}"
        self.graph.append(f"{labels}{join}[vcat]")
        ranges = [(in_sf, out_sf) for in_sf, out_sf, _shift in branches]
        self.graph.append(self.layout("[vcat]", ranges, "[vlay]"))
        assert self.plan.ass is not None
        self.sidecars[CAPTIONS_FILE] = self.plan.ass.encode("utf-8")
        self.graph.append(f"[vlay]{_TEXT_IN[self.composite]},{_TEXT_FILTER}[vtext]")
        last = "[vtext]"
        logo = self.plan.logo
        if logo is not None:
            from .derive import derive_filter

            k = self.add_asset(InputSpec("asset", logo.asset, ("-f", "png_pipe")))
            self.graph.append(f"[{k}:v]{derive_filter(logo.w, logo.h, logo.opacity_pm)},"
                              f"{_LOGO_FORMAT[self.composite]}[lg]")
            self.graph.append(f"[vtext][lg]overlay=x={logo.x}:y={logo.y}:"
                              f"format={_OVERLAY_FORMAT[self.composite]}[vlogo]")
            last = "[vlogo]"
        self.graph.append(f"{last}{_TO_OUTPUT[self.composite]}[vout]")

    # audio
    def sound(self, loudness: Loudness | None, sample_fmt: str | None) -> None:
        """The T1.4 fragment (``[sa<i>]`` → ``[apre]``) and the master stage (§5.8)."""
        from . import audio_graph
        from . import loudness as _loudness

        fragment = audio_graph.audio_fragment(self.plan, mode=self.mode,
                                              first_input_index=len(self.inputs))
        for name, data in fragment.sidecars.items():
            if not SIDECAR_NAME.fullmatch(name) or name in self.sidecars:
                raise ValueError(f"invalid audio sidecar name: {name!r}")
            self.sidecars[name] = bytes(data)
        for spec in fragment.inputs:
            if spec.kind == "asset":
                self.add_asset(spec)
            elif spec.kind == "sidecar" and spec.name in fragment.sidecars:
                self.add_input(spec)
            else:
                raise ValueError(f"invalid audio fragment input: {spec.kind}")
        self.graph.append(fragment.graph.strip().rstrip(";").strip())
        self.expected["mix_sha256"] = fragment.mix_sha256
        if sample_fmt is None:  # audio_measure: the pre-master mix is measured
            measure = audio_graph.master_filter("audio_measure", 0)
            self.graph.append(f"[apre]aformat=sample_fmts=dbl,{measure}[ameas]")
            return
        needs = _loudness.needs_measurement(self.plan.doc)
        if needs and loudness is None:
            raise ValueError("this document needs a loudness/peak measurement (audio_measure) "
                             "before it can be rendered")
        if not needs and loudness is not None:
            raise ValueError("this document must not be measured (revision-0 audio)")
        gain, issues = _loudness.output_gain(self.plan.doc, loudness)
        master = audio_graph.master_filter(self.mode, gain)  # [volume=<g>dB,]aresample=48000
        self.graph.append(f"[apre]{master},aformat=sample_fmts={sample_fmt}:sample_rates="
                          f"{SAMPLE_RATE}:channel_layouts=stereo[aout]")
        self.expected["gain_cdb"] = gain
        self.expected["warnings"] = [issue.to_json() for issue in issues]

    def job(self, argv: Sequence[str]) -> FfmpegJob:
        return FfmpegJob(argv=tuple(argv), filter_script=";\n".join(self.graph) + "\n",
                         inputs=tuple(self.inputs), sidecars=dict(self.sidecars),
                         expected=self.expected)


def select_expression(ranges: Sequence[tuple[int, int]]) -> str:
    """A ``select`` expression true exactly for grid indices (``pts``) in the half-open
    ``ranges`` (sorted, disjoint): a balanced ``if(lt(pts,K),A,B)`` tree of ``between`` leaves,
    so a run of 2,000 pieces costs 11 comparisons per frame. Integers only (exact in double)."""
    if not ranges:
        raise ValueError("a select expression needs at least one range")
    if any(b <= a for a, b in ranges) or any(
            later[0] < earlier[1] for earlier, later in pairwise(ranges)):
        raise ValueError("ranges must be non-empty, sorted and disjoint")

    def tree(lo: int, hi: int) -> str:
        if hi - lo == 1:
            start, end = ranges[lo]
            return f"between(pts,{start},{end - 1})"
        mid = (lo + hi) // 2
        return f"if(lt(pts,{ranges[mid][0]}),{tree(lo, mid)},{tree(mid, hi)})"

    return tree(0, len(ranges))


def _pieces_branches(plan: RenderPlan) -> list[tuple[int, int, int]]:
    return [(piece.in_sf, piece.out_sf, 0) for piece in plan.pieces]


def _final_like(compiler: _Compiler, loudness: Loudness | None, *, reference: bool) -> FfmpegJob:
    plan = compiler.plan
    branches = _pieces_branches(plan)
    compiler.decoded(branches, decoder_runs(plan.pieces, plan.fps), video=True,
                     audio=compiler.audio)
    compiler.picture(branches)
    compiler.sound(loudness, "s16" if reference else "fltp")
    compiler.expected.update(output="fd", frames=plan.total_frames, samples=plan.total_samples)
    argv = [*_head("error", copyts=True), *compiler.argv_inputs(),
            "-filter_complex_script", GRAPH_FILE,
            "-filter_complex_threads", str(FFMPEG_THREADS), "-map", "[vout]", "-map", "[aout]"]
    if reference:
        argv += ["-c:v", "ffv1", "-level", "3", "-g", "1", "-threads", str(FFMPEG_THREADS),
                 *_COLOR_TAGS, "-c:a", "pcm_s16le", "-fps_mode", "passthrough", *_BITEXACT,
                 "-f", "matroska", OUTPUT_TOKEN]
    else:
        compiler.expected["srt"] = plan.srt()
        argv += [*_x264(*STANDAR, tm.cell_frames(plan.fps)),
                 "-c:a", "aac", "-b:a", AAC_BITRATE, "-ar", str(SAMPLE_RATE), "-ac", "2",
                 "-fps_mode", "passthrough", *_BITEXACT, "-movflags", "+faststart",
                 "-f", "mp4", OUTPUT_TOKEN]
    return compiler.job(argv)


def _frame(compiler: _Compiler, frame: int | None) -> FfmpegJob:
    plan = compiler.plan
    if type(frame) is not int or not 0 <= frame < plan.total_frames:
        raise ValueError("frame must be an output frame of the clip")
    _piece, sf = tm.out_to_src(frame, plan.pieces)
    branches = [(sf, sf + 1, frame)]  # pts = frame, so ass sees now_ms(frame) (§3.4)
    compiler.decoded(branches, ((0,),), video=True, audio=False)
    compiler.picture(branches)
    post = ("ffmpeg", "-nostdin", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            *_WHITELIST, "-f", "h264", "-i", FRAME_H264, "-frames:v", "1", "-vf", _PNG_DECODE,
            "-fflags", "+bitexact", "-flags:v", "+bitexact", "-f", "image2", "-c:v", "png",
            FRAME_PNG)
    compiler.expected.update(output="png", result=FRAME_PNG, post=list(post), frames=1,
                             frame=frame, source_frame=sf)
    argv = [*_head("error", copyts=True), *compiler.argv_inputs(),
            "-filter_complex_script", GRAPH_FILE,
            "-filter_complex_threads", str(FFMPEG_THREADS), "-map", "[vout]", "-frames:v", "1",
            *_x264(*STANDAR, tm.cell_frames(plan.fps)), "-fps_mode", "passthrough", *_BITEXACT,
            "-f", "h264", FRAME_H264]
    return compiler.job(argv)


def _plate_cells(compiler: _Compiler, cells: Sequence[int]) -> FfmpegJob:
    plan = compiler.plan
    fps = plan.fps
    size = tm.cell_frames(fps)
    wanted = sorted(set(cells))
    if not wanted or any(type(k) is not int or k < 0 for k in wanted):
        raise ValueError("cells must be non-negative cell indices")
    duration_ms = plan.doc["base"]["source"]["duration_ms"]
    first_missing = tm.sf_ceil(duration_ms, fps)  # the first source-grid frame after the end
    full = tm.sf_floor(duration_ms, fps)
    if wanted[-1] * size >= first_missing:
        raise ValueError("cell beyond the end of the source")
    # The first source-grid frame of the document's window. The seed keeps the window inside the
    # frames that exist (a video starting at 0.041 s has no grid frame 0), so a cell that starts
    # below it decodes from it and repeats it for the frames below: frame i of cell k stays grid
    # frame k·C + i for every frame the document can show (none below the window).
    low = tm.sf_floor(plan.doc["base"]["window_ms"][0], fps)
    if (wanted[0] + 1) * size <= low:
        raise ValueError("cell before the document's window")
    runs: list[list[int]] = []
    for k in wanted:
        if runs and runs[-1][-1] == k - 1:
            runs[-1].append(k)
        else:
            runs.append([k])
    outputs: list[str] = []
    for r, run in enumerate(runs):
        in_sf, out_sf = run[0] * size, (run[-1] + 1) * size
        start = max(in_sf, low)
        k = compiler.source_input(start)
        compiler.graph.append(compiler.trim(f"[{k}:{compiler.streams.video_index}]",
                                            start, out_sf, 0, f"[pt{r}]"))
        pad = f"tpad=start={start - in_sf}:start_mode=clone," if start > in_sf else ""
        compiler.graph.append(compiler.layout(f"[pt{r}]{pad}settb={fps.den}/{fps.num},",
                                              [(in_sf, out_sf)], f"[pl{r}]", suffix=f"_{r}"))
        # The same conversions as the final picture without text and logo (R5): with the gbrp
        # composite the final's video passes through planar RGB, which clips the few YUV values
        # outside the RGB gamut (scaling overshoot). A plate that skipped the round trip measured
        # Y-SSIM 0.978 against the reference on the fill_center barcode (P-PLATE, W1 exit).
        compiler.graph.append(
            f"[pl{r}]{_TEXT_IN[compiler.composite]},{_TO_OUTPUT[compiler.composite]}[cell{r}]")
        split_at = ",".join(str(size * (i + 1)) for i in range(len(run)))
        outputs += ["-map", f"[cell{r}]", *_x264(*PLATE, size), "-bf", "0", "-forced-idr", "1",
                    "-force_key_frames", f"expr:eq(mod(n,{size}),0)", "-sc_threshold", "0",
                    "-fps_mode", "passthrough", *_BITEXACT, "-f", "segment",
                    "-segment_format", "mp4", "-segment_frames", split_at,
                    "-segment_start_number", str(run[0]), "-reset_timestamps", "1",
                    CELL_PATTERN]
    compiler.expected.update(
        output="cells", cell_frames=size,
        cells={str(k): size if (k + 1) * size <= full else None for k in wanted})
    argv = [*_head("error", copyts=True), *compiler.argv_inputs(),
            "-filter_complex_script", GRAPH_FILE,
            "-filter_complex_threads", str(FFMPEG_THREADS), *outputs]
    return compiler.job(argv)


def _audio_only(compiler: _Compiler, loudness: Loudness | None, *, measure: bool) -> FfmpegJob:
    plan = compiler.plan
    branches = _pieces_branches(plan)
    compiler.decoded(branches, decoder_runs(plan.pieces, plan.fps), video=False,
                     audio=compiler.audio)
    compiler.sound(loudness, None if measure else "s16")
    compiler.expected.update(samples=plan.total_samples)
    argv = [*_head("info" if measure else "error", copyts=True), *compiler.argv_inputs(),
            "-filter_complex_script", GRAPH_FILE,
            "-filter_complex_threads", str(FFMPEG_THREADS)]
    if measure:
        compiler.expected.update(output="null")
        argv += ["-map", "[ameas]", "-f", "null", "-"]
    else:
        compiler.expected.update(output="fd")
        argv += ["-map", "[aout]", "-c:a", "flac", "-sample_fmt", "s16", *_BITEXACT,
                 "-f", "flac", OUTPUT_TOKEN]
    return compiler.job(argv)


def _derive_logo(plan: RenderPlan, assets_root: Path) -> FfmpegJob:
    from .derive import derive_job

    logo = plan.logo
    if logo is None:
        raise ValueError("the document has no logo")
    meta = plan.assets.get(logo.asset)
    if meta is None:
        raise errors.DocSemanticInvalid("asset_missing", ref=logo.asset)
    path = asset_path(assets_root, logo.asset, meta["kind"])
    return derive_job(InputSpec("asset", logo.asset, ("-f", "png_pipe")), w=logo.w, h=logo.h,
                      opacity_pm=logo.opacity_pm,
                      expected={"paths": {logo.asset: str(path)},
                                "assets_root": str(assets_root)})


def compile_job(
    plan: RenderPlan,
    *,
    mode: str,
    source: Path,
    assets_root: Path,
    size: tuple[int, int] | None = None,
    quality: str = "standar",
    cells: Sequence[int] = (),
    frame: int | None = None,
    loudness: Loudness | None = None,
) -> FfmpegJob:
    """Compile ``plan`` for ``mode`` (one of ``MODES``). Essentials: ``size`` is always the
    document's output size and ``quality`` ``"standar"``; both stay parameters for Stage 2.

    ``loudness`` is the ``audio_measure`` result, required exactly when
    ``loudness.needs_measurement(doc)`` (§5.8). ``cells`` are the plate cells to build and
    ``frame`` the output frame of ``frame`` mode.
    """
    if mode not in MODES:
        raise ValueError(f"unknown mode: {mode}")
    if quality not in QUALITIES:
        raise ValueError(f"unknown quality: {quality}")
    if size is not None and (size[0], size[1]) != plan.output:
        raise ValueError("Essentials renders at the document's output size")
    if mode in ("final", "reference", "frame") and plan.captions is None:
        raise ValueError("the plan has no caption track (build it with plan.build_plan)")
    assets_root = Path(assets_root)
    if mode == "derive_image":
        return _derive_logo(plan, assets_root)
    streams = probe_source(Path(source))
    if plan.doc["base"]["source"]["has_audio"] and streams.audio_index is None:
        raise errors.RenderFailed("render_failed")  # the document's source had audio
    compiler = _Compiler(plan, streams, Path(source), assets_root, mode)
    if mode in ("final", "reference"):
        return _final_like(compiler, loudness, reference=mode == "reference")
    if mode == "frame":
        return _frame(compiler, frame)
    if mode == "plate_cells":
        return _plate_cells(compiler, cells)
    return _audio_only(compiler, loudness, measure=mode == "audio_measure")


__all__ = [
    "COMPOSITE_FORMAT",
    "COMPOSITE_FORMATS",
    "MODES",
    "QUALITIES",
    "FfmpegJob",
    "InputSpec",
    "SourceStreams",
    "compile_job",
    "decoder_runs",
    "probe_source",
    "seek_arg",
    "select_expression",
]
