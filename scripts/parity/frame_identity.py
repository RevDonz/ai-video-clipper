"""Server-side parity gates of the single compiler (plan §10.1 P-FRAME, P-PLATE; §10.2 G1/G2,
G-DET; §10.3 PF-RENDER). A port of the PF spike ``frame_identity.py`` against
``edit_v2.compile_ffmpeg``.

The spike compared one seeked range with the whole-file ``fps=F`` grid. Here every output frame
of a compiled render (plate cells and final) is decoded, its barcode frame index read back
(``support.edit_v2_media``) and compared with the grid frame the time map says it must show.

**Modules.** The gates run the real chain: ``captions.caption_track`` (T1.2a), the envelopes
and ``audio_graph.audio_fragment`` (T1.4) and the pinned resources (fonts, packs, fontconfig
lockdown, ``toolchain.json`` when the image wrote it), wired together by the W1 integrator.
``--harness`` restores the deterministic stand-ins below (``HARNESS_PATCHES``), which honour
the Appendix A contracts: a caption track whose ASS has one bottom event per piece, and an audio
fragment that turns ``[sa<i>]`` into ``[apre]`` with the exact sample count (plan §5.3). T1.3's
unit tests keep using the stand-ins, so its string goldens pin only the compiler's own part;
``tests/test_edit_v2_integration.py`` pins the joined graph.

Run (stdlib only; the reference image has no pytest); each gate writes
``T1.3-<gate>.json`` under ``--evidence``, merged per run (reference image or local FFmpeg)::

    PYTHONPATH=src:tests python scripts/parity/frame_identity.py all --evidence docs/editor/evidence/W1 \
        [--task T1.Z] [--harness]

    docker run --rm --cpus 4 --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/src:/w/tests \\
        ai-video-clipper:editor-ref /app/.venv/bin/python scripts/parity/frame_identity.py all \\
        --evidence docs/editor/evidence/W1

Gates: ``p-frame``, ``p-plate``, ``g1g2``, ``g-det``, ``pf-render`` (report only), or ``all``
(one workspace, so renders are shared). ``--cpus 4`` gives PF-RENDER the 4 CPUs of its budget.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any

from ai_clipper.edit_v2 import audio_graph, captions, envelope, loudness
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.audio_graph import AudioFragment
from ai_clipper.edit_v2.captions import CaptionResult
from ai_clipper.edit_v2.loudness import Loudness
from ai_clipper.edit_v2.timemap import Fps, Piece

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_RATE = 48_000

# --- harness stand-ins for the T1.2a and T1.4 seams ----------------------------------------------


def _ass_time(cs: int) -> str:
    cs = max(cs, 0)
    hours, rest = divmod(cs, 360_000)
    minutes, rest = divmod(rest, 6_000)
    seconds, centis = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def _ass_text(text: str) -> str:
    """Minimal escaping for the harness (the real escaper is ``captions_ass.ass_escape``)."""
    cleaned = "".join(" " if ch in "\r\n\t" else ch for ch in text)
    return cleaned.replace("\\", "\\⁠").replace("{", "(").replace("}", ")")


def harness_caption_track(doc: Mapping, words: Mapping, pieces: Sequence[Piece]) -> CaptionResult:
    """Stand-in for ``captions.caption_track`` (T1.2a): one bottom event per piece.

    The hook text and every word-edit text are written into the ASS (escaped), so the hostile
    text tests can prove that user text reaches FFmpeg only inside the ASS sidecar.
    """
    fps = Fps.from_json(doc["output"]["fps"])
    width, height = doc["output"]["w"], doc["output"]["h"]
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
         "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
         "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"),
        (f"Style: Default,DejaVu Sans,{height // 24},&H00FFFFFF,&H000000FF,&H00000000,"
         f"&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,{height * 17 // 100},1"),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    texts: list[str] = []
    if doc["captions"]["enabled"]:
        texts = [f"piece {piece.i}" for piece in pieces]
        edits = [edit["text"] for _id, edit in sorted(doc["captions"]["word_edits"].items())
                 if "text" in edit]
        if edits and texts:
            texts[0] += " " + " ".join(edits)
    hook = next((track["items"][0] for track in doc["tracks"] if track["kind"] == "hook"), None)
    hook_lines: tuple[str, ...] = ()
    if hook is not None:
        hook_lines = (hook["payload"]["text"],)
        lines.append(f"Dialogue: 1,{_ass_time(0)},{_ass_time(tm.safe_cs(hook['dur_f'], fps))},"
                     f"Default,,0,0,0,,{_ass_text(hook['payload']['text'])}")
    for piece, text in zip(pieces, texts):
        start = tm.safe_cs(piece.out_f0, fps)
        end = tm.safe_cs(piece.out_f0 + piece.frames, fps)
        lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,"
                     f"{_ass_text(text)}")
    ass = "\n".join(lines) + "\n"
    return CaptionResult(
        cues=(),
        ass=ass,
        ass_sha256=hashlib.sha256(ass.encode("utf-8")).hexdigest(),
        hook_lines=hook_lines,
        warnings=(),
    )


def harness_speech_envelope(pieces: Sequence[Piece], joins: Mapping[str, int], cut_fade_ms: int,
                            fps: Fps, gain_cdb: int) -> tuple[tuple[int, int], ...]:
    """Stand-in for ``envelope.speech_envelope`` (T1.4): a flat gain, no micro-fades."""
    gain_e6 = round(10 ** (gain_cdb / 2000) * 1_000_000)
    return ((0, gain_e6),)


def harness_music_envelope(speech_spans: Sequence[tuple[int, int]], item: Mapping,
                           total_samples: int, fps: Fps) -> tuple[tuple[int, int], ...]:
    """Stand-in for ``envelope.music_envelope`` (T1.4): the item gain, no fades, no ducking."""
    gain_e6 = round(10 ** (item["payload"]["gain_cdb"] / 2000) * 1_000_000)
    return ((0, gain_e6), (total_samples, gain_e6))


def harness_audio_fragment(plan: Any, *, mode: str, first_input_index: int) -> AudioFragment:
    """Stand-in for ``audio_graph.audio_fragment`` (T1.4) honouring the §5.8 seam.

    Each ``[sa<i>]`` is resampled, trimmed to the piece's exact samples and panned to stereo
    (plan §5.3), then the pieces are concatenated into ``[apre]``. A source without audio gives
    ``anullsrc`` with the exact sample count. Music items are not mixed by the harness.

    ``pan`` comes after ``atrim``: every piece label carries its whole decoder run, and a
    ``pan`` before the trim kept the audio queued in every finished piece (measured on FFmpeg
    6.1, 150 pieces over 133 s: 2.3 GiB resident with ``aresample,pan,…,atrim``, 67 MiB with
    ``aresample,…,atrim`` and the channel mapping after the trim).
    """
    fps = plan.fps
    parts = []
    if plan.doc["base"]["source"]["has_audio"]:
        for piece in plan.pieces:
            first = piece.in_sf * SAMPLE_RATE * fps.den // fps.num
            count = tm.smp(piece.out_f0 + piece.frames, fps) - tm.smp(piece.out_f0, fps)
            parts.append(
                f"[sa{piece.i}]aresample={SAMPLE_RATE},asettb=1/{SAMPLE_RATE},"
                f"atrim=start_pts={first}:end_pts={first + count},"
                f"pan=stereo|FL=FL+FC|FR=FR+FC,asetpts=PTS-STARTPTS[au_p{piece.i}]"
            )
        labels = "".join(f"[au_p{piece.i}]" for piece in plan.pieces)
        parts.append(f"{labels}concat=n={len(plan.pieces)}:v=0:a=1[apre]")
    else:
        parts.append(f"anullsrc=r={SAMPLE_RATE}:cl=stereo,atrim=end_sample="
                     f"{plan.total_samples}[apre]")
    graph = ";\n".join(parts)
    return AudioFragment(graph=graph, inputs=(), sidecars={},
                         mix_sha256=hashlib.sha256(graph.encode()).hexdigest())


def harness_needs_measurement(doc: Mapping) -> bool:
    """Stand-in for ``loudness.needs_measurement`` (T1.4, plan §5.6 step 5)."""
    music = any(track["kind"] == "audio" and track["items"] for track in doc["tracks"])
    return (doc["audio"]["master"]["mode"] == "normalize" or music
            or doc["audio"]["source"]["gain_cdb"] > 0)


def harness_output_gain(doc: Mapping, measured: Loudness | None) -> tuple[int, tuple]:
    """Stand-in for ``loudness.output_gain`` (T1.4): normalise and protect the true peak."""
    if measured is None:
        return 0, ()
    gain = 0
    if doc["audio"]["master"]["mode"] == "normalize":
        gain = doc["audio"]["master"]["target_clufs"] - measured.i_clufs
        gain = min(gain, doc["audio"]["master"]["tp_cdb"] - measured.tp_cdb)
    if measured.tp_cdb + gain > -100:
        gain = -100 - measured.tp_cdb
    return gain, ()


def harness_parse_ebur128(stderr: str) -> Loudness:
    """Stand-in for ``loudness.parse_ebur128`` (T1.4): the ``Summary:`` block of ebur128."""
    summary = stderr[stderr.rfind("Summary:"):]
    integrated = peak = None
    for line in summary.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[0] == "I:":
            integrated = float(fields[1])
        if len(fields) >= 3 and fields[0] == "Peak:":
            peak = float(fields[1])
    if integrated is None or peak is None:
        raise ValueError("no ebur128 summary")
    return Loudness(round(integrated * 100), round(peak * 100))


HARNESS_PATCHES: tuple[tuple[Any, str, Callable[..., Any]], ...] = (
    (captions, "caption_track", harness_caption_track),
    (envelope, "speech_envelope", harness_speech_envelope),
    (envelope, "music_envelope", harness_music_envelope),
    (audio_graph, "audio_fragment", harness_audio_fragment),
    (loudness, "needs_measurement", harness_needs_measurement),
    (loudness, "output_gain", harness_output_gain),
    (loudness, "parse_ebur128", harness_parse_ebur128),
)


def install_harness() -> None:
    """Patch the stand-ins in for a stdlib-only gate run (tests use ``monkeypatch`` instead)."""
    for module, name, function in HARNESS_PATCHES:
        setattr(module, name, function)


# --- documents -------------------------------------------------------------------------------------


def _template() -> dict[str, Any]:
    """The c30 fixture seed (plan §3.2 shape), used as the skeleton of harness documents."""
    path = ROOT / "tests" / "fixtures" / "edit_v2" / "docs" / "contexts" / "c30.seed.json"
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class SourceInfo:
    width: int
    height: int
    fps_native: tuple[int, int]
    vfr: bool
    duration_ms: int
    has_audio: bool


def make_doc(
    source: SourceInfo,
    *,
    fps: tuple[int, int],
    body: tuple[int, int],
    cold_open: tuple[int, int] | None = None,
    removals: Sequence[tuple[int, int]] = (),
    layout: str = "fit_blur",
    output: tuple[int, int] = (720, 1280),
    captions_enabled: bool = True,
    hook: tuple[str, int] | None = None,
    logo: tuple[str, Mapping[str, int]] | None = None,
    music: Mapping[str, Any] | None = None,
    assets: Mapping[str, Mapping[str, Any]] | None = None,
    master: str = "off",
    source_gain_cdb: int = 0,
) -> dict[str, Any]:
    """A ``clip-edit-v2`` document for a synthetic source (edges in source-grid frames)."""
    doc = _template()
    doc["revision"] = 1
    doc["parent_sha256"] = "0" * 64
    doc["base"]["source"].update(
        w=source.width, h=source.height, fps_native=list(source.fps_native), vfr=source.vfr,
        duration_ms=source.duration_ms, has_audio=source.has_audio,
    )
    doc["base"]["window_ms"] = [0, source.duration_ms]
    doc["output"].update(w=output[0], h=output[1], fps=list(fps))
    segments = []
    joins = []
    if cold_open is not None:
        segments.append({"id": "seg_co", "role": "cold_open", "in_sf": cold_open[0],
                         "out_sf": cold_open[1]})
        joins.append({"after": "seg_co", "style": "cut", "audio_fade_ms": 30})
    segments.append({"id": "seg_b1", "role": "body", "in_sf": body[0], "out_sf": body[1]})
    doc["main"] = {
        "segments": segments,
        "removals": [
            {"id": f"rm_{index + 1}", "seg": "seg_b1", "in_sf": start, "out_sf": end,
             "words": [], "reason": "user", "origin": "user"}
            for index, (start, end) in enumerate(removals)
        ],
        "joins": joins,
        "cut_fade_ms": 8,
    }
    doc["captions"]["enabled"] = captions_enabled
    doc["layout"]["default"]["mode"] = layout
    tracks: list[dict[str, Any]] = []
    if hook is not None:
        tracks.append({"id": "tr_hook", "kind": "hook", "items": [{
            "id": "it_hook", "type": "hook", "start": {"at": "out", "f": 0}, "dur_f": hook[1],
            "transform": {"x_e5": 50000, "y_e5": 13000},
            "payload": {"text": hook[0], "design": {"id": "legacy-bar", "v": 1}},
            "origin": "user"}]})
    if logo is not None:
        tracks.append({"id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay",
                       "items": [{"id": "it_logo", "type": "image",
                                  "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
                                  "transform": dict(logo[1]),
                                  "payload": {"asset": logo[0], "mode": "free"},
                                  "origin": "user"}]})
    if music is not None:
        tracks.append({"id": "tr_mus", "kind": "audio", "role": "music", "items": [{
            "id": "it_music", "type": "audio", "start": {"at": "clip_start"},
            "end": {"at": "clip_end"}, "payload": dict(music), "origin": "user"}]})
    doc["tracks"] = tracks
    doc["assets"] = {key: dict(value) for key, value in (assets or {}).items()}
    doc["audio"] = {"source": {"gain_cdb": source_gain_cdb},
                    "master": {"mode": master, "target_clufs": -1400, "tp_cdb": -100}}
    return doc


def make_words(duration_ms: int) -> dict[str, Any]:
    """A words artifact with one word per default tone burst (support.edit_v2_media)."""
    from support import edit_v2_media as media

    words = [
        {"id": f"w{index:06d}", "s": burst.start_ms, "e": burst.end_ms, "t": f"kata{index}",
         "p_pm": 900, "u": None, "z": False}
        for index, burst in enumerate(media.default_bursts(duration_ms))
    ]
    return {"schema": "potongin.words/1", "words": words, "units": [], "bounds": [], "gaps": [],
            "events": [], "silences": [], "scene_cuts_ms": [], "missing": []}


def make_camera(duration_ms: int, fps: tuple[int, int], source: tuple[int, int],
                output: tuple[int, int]) -> dict[str, Any]:
    """A camera plan (``potongin.camera-plan/1``) that sweeps the crop across the source, with a
    cut every 6 s and a no-face span, so crop x changes on almost every frame."""
    samples = []
    cuts = []
    for index, t_ms in enumerate(range(0, duration_ms, 750)):
        phase = index % 16
        center = 150 + (phase if phase < 8 else 16 - phase) * 90
        samples.append([t_ms, center])
        cuts.append(index > 0 and t_ms % 6000 == 0)
    return {
        "schema": "potongin.camera-plan/1",
        "source_content_sha256": "0" * 64,
        "window_ms": [0, duration_ms],
        "fps": list(fps),
        "source": {"w": source[0], "h": source[1]},
        "output": {"w": output[0], "h": output[1]},
        "sample_ms": 750,
        "samples": samples,
        "cuts": cuts,
        "no_face": [[3000, 5250]],
    }


# --- decoding ------------------------------------------------------------------------------------


def iter_gray_frames(path: Path, size: tuple[int, int]) -> Iterator[bytes]:
    """Stream the luma planes of every decoded frame (no frame-rate conversion)."""
    width, height = size
    frame = width * height
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "4",
            "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo",
            "-pix_fmt", "gray", "-"]
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        assert process.stdout is not None
        while True:
            data = process.stdout.read(frame)
            if not data:
                break
            if len(data) != frame:
                raise RuntimeError(f"{path.name}: truncated frame")
            yield data
    if process.returncode:
        raise RuntimeError(f"{path.name}: ffmpeg decode failed")


def png_to_gray(png: bytes, size: tuple[int, int]) -> bytes:
    """The luma plane of a PNG (truth frame)."""
    data = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "png_pipe", "-i",
         "pipe:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        input=png, capture_output=True, check=True).stdout
    if len(data) != size[0] * size[1]:
        raise RuntimeError("unexpected PNG size")
    return data


def gray_of_yuv420(frame: bytes, size: tuple[int, int]) -> bytes:
    """The luma plane of a raw yuv420p frame."""
    return frame[: size[0] * size[1]]


def decode_yuv420(path: Path, size: tuple[int, int]) -> list[bytes]:
    """Every decoded frame of ``path`` as raw yuv420p (used for plate cells: ≤ 60 frames)."""
    data = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "4", "-i",
         str(path), "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt",
         "yuv420p", "-"], capture_output=True, check=True).stdout
    frame = size[0] * size[1] * 3 // 2
    if len(data) % frame:
        raise RuntimeError(f"{path.name}: truncated frame")
    return [data[i:i + frame] for i in range(0, len(data), frame)]


# --- gate runs (stdlib only) ---------------------------------------------------------------------
#
# ``all`` measures, in one workspace, the server-side gates of T1.3 and writes one evidence file
# per gate (``T1.3-<gate>.json``, numbers only) under ``--evidence``:
#
# * P-FRAME: plate cells and final render of 4 barcode sources (29.97 CFR, 25, 30, VFR), each
#   with a cold open and 20 cuts, against the whole-file ``fps=F`` grid (≥ 2,000 frames each for
#   plate and final, 0 mismatches);
# * P-PLATE (server part): per layout, the decoded plate frames in output order vs the lossless
#   ``reference`` render with text and logo disabled: SSIM ≥ SSIM(final vs reference) − 0.002,
#   and crop x from the column ruler equal to the plan on every frame (plate, reference, final);
# * G1/G2: ``verify.verify_output`` on 6 synthetic final renders;
# * G-DET: plan hash, ASS, graph strings, sidecars (envelopes) identical across processes with
#   different hash seeds; preview ASS == export ASS; final and plate bytes identical across runs;
# * PF-RENDER (report only): final 720×1280 wall time / clip length.

TASK = "T1.3"
P_FRAME_MIN_FRAMES = 2_000
P_PLATE_SSIM_MARGIN = 0.002
PF_RENDER_BUDGET = {"p50": 0.4, "p95": 0.6}
REMOVAL_LENGTHS = (1, 3, 7, 12, 24, 2, 17, 5, 20, 9)
DET_SEEDS = ("11", "4242")


@dataclass(frozen=True)
class Case:
    """A synthetic clip: a barcode source and a document over it."""

    name: str
    fps: tuple[int, int]  # the document's output fps
    frames: int  # generated source frames
    layout: str
    source_fps: tuple[int, int] | None = None  # default: fps
    source_size: tuple[int, int] = (640, 360)
    output: tuple[int, int] = (720, 1280)
    vfr: bool = False
    drop_every: int = 0
    cuts: int = 20
    cold_open: bool = True
    hook: bool = False
    captions: bool = True
    logo: bool = False
    audio: bool = True


P_FRAME_CASES = (
    Case("cfr_29.97", (30000, 1001), 900, "fit_blur", hook=True),
    Case("cfr_25", (25, 1), 760, "fill_center"),
    Case("cfr_30", (30, 1), 900, "camera"),
    Case("vfr_30", (30, 1), 900, "fit_blur", vfr=True, drop_every=11),
)
EXTRA_RENDER_CASES = (
    Case("fhd_23.976_logo", (24000, 1001), 700, "fit_blur", output=(1080, 1920), cuts=5,
         hook=True, logo=True),
    Case("no_audio_29.97", (30000, 1001), 600, "fill_center", cuts=3, cold_open=False,
         audio=False),
)
P_PLATE_CASES = tuple(
    Case(f"plate_{layout}", (30000, 1001), 900, layout, cuts=10, captions=False)
    for layout in ("fit_blur", "fill_center", "camera")
)
PF_RENDER_CASES = tuple(
    Case(f"pf_60s_{layout}", (30000, 1001), 2_000, layout, source_size=(1280, 720), cuts=5,
         hook=True)
    for layout in ("fit_blur", "fill_center", "camera")
)


def _media():
    from support import edit_v2_media

    return edit_v2_media


def case_edges(case: Case) -> dict[str, Any]:
    """Body, cold open and removals in source-grid frames of the document fps.

    The body runs from frame 30 to 120 frames before the end; ``cuts`` removals are spread
    evenly over it with lengths cycling through ``REMOVAL_LENGTHS``; the cold open is two
    seconds taken 300 frames into the body (a new decoder run, since it comes first).
    """
    num, den = case.fps
    rate = -(-num // den)
    body = (30, case.frames - 120)
    removals = []
    if case.cuts:
        spacing = (body[1] - body[0]) // (case.cuts + 1)
        for k in range(case.cuts):
            length = REMOVAL_LENGTHS[k % len(REMOVAL_LENGTHS)]
            start = body[0] + spacing * (k + 1) - length // 2
            removals.append((start, start + length))
    cold_open = (body[0] + 300, body[0] + 300 + 2 * rate) if case.cold_open else None
    return {"body": body, "removals": removals, "cold_open": cold_open}


class Workspace:
    """Sources, documents and renders shared by the gates of one run (in a temp directory)."""

    def __init__(self, root: Path, *, harness: bool = False) -> None:
        self.root = root
        self.harness = harness
        self.clips: dict[str, dict[str, Any]] = {}
        self.sources: dict[Any, Path] = {}
        self.grids: dict[tuple[Path, tuple[int, int]], list[int | None]] = {}
        self.renders: dict[tuple[str, str], dict[str, Any]] = {}
        (root / "assets").mkdir(parents=True, exist_ok=True)

    @property
    def resources(self):
        from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
        from ai_clipper.edit_v2.plan import Resources

        if self.harness:
            return Resources(self.root / "resources")  # absent: FFmpeg uses the system fonts
        return Resources(RESOURCES_DIR)  # the pinned fonts, packs and fontconfig lockdown

    def logo_asset(self) -> tuple[str, dict[str, Any]]:
        media = _media()
        path = media.make_logo_png(self.root / "logo.png", 256, 128)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        stored = self.root / "assets" / f"{digest}.png"
        if not stored.exists():
            path.rename(stored)
        return f"sha256:{digest}", {"kind": "image", "mime": "image/png", "w": 256, "h": 128}

    def clip(self, case: Case) -> dict[str, Any]:
        if case.name in self.clips:
            return self.clips[case.name]
        media = _media()
        source_fps = case.source_fps or case.fps
        spec = media.VideoSpec(
            width=case.source_size[0], height=case.source_size[1], fps=source_fps,
            frames=case.frames, vfr=case.vfr, drop_every=case.drop_every,
            container="mkv" if case.vfr else "mp4",
            audio=media.AudioSpec() if case.audio else None)
        if spec not in self.sources:  # cases with the same source share one file
            suffix = "mkv" if case.vfr else "mp4"
            path = self.root / f"source-{len(self.sources):02d}.{suffix}"
            self.sources[spec] = media.make_barcode_video(path, spec)
        source = self.sources[spec]
        duration_ms = case.frames * 1000 * source_fps[1] // source_fps[0]
        info = SourceInfo(case.source_size[0], case.source_size[1], source_fps, case.vfr,
                          duration_ms, case.audio)
        edges = case_edges(case)
        assets: dict[str, dict[str, Any]] = {}
        logo = None
        if case.logo:
            asset, meta = self.logo_asset()
            assets[asset] = meta
            logo = (asset, {"x_e5": 80000, "y_e5": 50000, "w_e5": 20000, "opacity_pm": 800})
        doc = make_doc(info, fps=case.fps, body=edges["body"], cold_open=edges["cold_open"],
                       removals=edges["removals"], layout=case.layout, output=case.output,
                       captions_enabled=case.captions,
                       hook=("Hook sintetis", 45) if case.hook else None, logo=logo,
                       assets=assets)
        camera = (make_camera(duration_ms, case.fps, case.source_size, case.output)
                  if case.layout == "camera" else None)
        self.clips[case.name] = {"case": case, "source": source, "doc": doc,
                                 "words": make_words(duration_ms), "camera": camera,
                                 "assets": assets}
        return self.clips[case.name]

    def plan(self, case: Case):
        from ai_clipper.edit_v2.plan import build_plan

        clip = self.clip(case)
        return build_plan(clip["doc"], words=clip["words"], camera=clip["camera"],
                          assets=clip["assets"], resources=self.resources)

    def grid(self, case: Case) -> list[int | None]:
        key = (self.clip(case)["source"], case.fps)
        if key not in self.grids:
            self.grids[key] = _media().grid_indices(key[0], case.fps)
        return self.grids[key]

    def compile(self, case: Case, mode: str, **kwargs: Any):
        from ai_clipper.edit_v2.compile_ffmpeg import compile_job

        return compile_job(self.plan(case), mode=mode, source=self.clip(case)["source"],
                           assets_root=self.root / "assets", **kwargs)

    def render(self, case: Case, mode: str, *, again: bool = False) -> dict[str, Any]:
        """Render ``final`` (.mp4) or ``reference`` (.mkv) once (``again``: a second time)."""
        from ai_clipper.edit_v2 import execute

        key = (case.name, mode + ("#2" if again else ""))
        if key not in self.renders:
            extension = "mkv" if mode == "reference" else "mp4"
            path = self.root / f"{case.name}.{mode}{'.2' if again else ''}.{extension}"
            job = self.compile(case, mode)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                result = execute.run(job, output_fd=fd, timeout_s=1800)
            finally:
                os.close(fd)
            self.renders[key] = {"path": path, "elapsed_s": result.elapsed_s}
        return self.renders[key]

    def cells(self, case: Case, *, again: bool = False) -> dict[str, Any]:
        """All plate cells covering the clip's pieces, rendered into one directory."""
        from ai_clipper.edit_v2 import execute

        key = (case.name, "cells" + ("#2" if again else ""))
        if key not in self.renders:
            plan = self.plan(case)
            size = tm.cell_frames(plan.fps)
            wanted = sorted({sf // size for piece in plan.pieces
                             for sf in range(piece.in_sf, piece.out_sf)})
            directory = self.root / f"{case.name}.cells{'.2' if again else ''}"
            directory.mkdir(exist_ok=True)
            job = self.compile(case, "plate_cells", cells=wanted)
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                result = execute.run(job, output_fd=fd, timeout_s=1800)
            finally:
                os.close(fd)
            self.renders[key] = {"dir": directory, "cells": wanted, "cell_frames": size,
                                 "elapsed_s": result.elapsed_s}
        return self.renders[key]


def geometry(layout: str, source: tuple[int, int], output: tuple[int, int]) -> dict[str, float]:
    """Where the source rows land in the output (for ``decode_index``)."""
    from ai_clipper.edit_v2 import layouts

    (src_w, src_h), (out_w, out_h) = source, output
    if layout == "fit_blur":
        fg_h = min(out_h, (out_w * src_h + src_w // 2) // src_w)
        return {"scale": fg_h / src_h, "top": (out_h - fg_h) / 2}
    scaled_h = layouts.scaled_size(source, output)[1]
    return {"scale": scaled_h / src_h, "top": (out_h - scaled_h) / 2}


def index_decoder(case: Case) -> Callable[[bytes], int | None]:
    """Frame index of an output luma plane of ``case`` (``None`` when unreadable)."""
    media = _media()
    pattern = media.Pattern.for_size(*case.source_size)
    where = geometry(case.layout, case.source_size, case.output)
    width, height = case.output

    def decode(plane: bytes) -> int | None:
        return media.decode_index(plane, width, height, pattern, **where)

    return decode


def crop_decoder(case: Case) -> Callable[[bytes], int | None]:
    """Crop x (in the scaled source) of an output luma plane of a crop layout of ``case``."""
    from ai_clipper.edit_v2 import layouts

    media = _media()
    pattern = media.Pattern.for_size(*case.source_size)
    scale = layouts.scaled_size(case.source_size, case.output)[0] / case.source_size[0]
    width, height = case.output

    def decode(plane: bytes) -> int | None:
        return media.decode_crop_x(plane, width, height, pattern, scale=scale)

    return decode


def _toolchain() -> dict[str, Any]:
    import platform

    media = _media()
    first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                           check=False).stdout.splitlines()
    return {"ffmpeg": first[0] if first else None,
            "reference_toolchain_problem": media.reference_toolchain_problem(),
            "python": platform.python_version()}


def run_id() -> str:
    toolchain = _toolchain()
    words = (toolchain["ffmpeg"] or "ffmpeg unknown").split()
    version = words[2].split("-")[0] if len(words) > 2 else "unknown"
    if toolchain["reference_toolchain_problem"] is None:
        return f"reference-image-ffmpeg-{version}"
    return f"local-ffmpeg-{version}"


# --- P-FRAME ---------------------------------------------------------------------------------------


def p_frame(ws: Workspace, cases: Sequence[Case] = P_FRAME_CASES) -> dict[str, Any]:
    results = []
    for case in cases:
        plan = ws.plan(case)
        grid = ws.grid(case)
        index_of = index_decoder(case)
        expected = [grid[tm.out_to_src(n, plan.pieces)[1]] for n in range(plan.total_frames)]
        final = [index_of(p) for p in iter_gray_frames(ws.render(case, "final")["path"],
                                                        case.output)]
        cells = ws.cells(case)
        size = cells["cell_frames"]
        decoded: dict[int, list[int | None]] = {}
        cell_frames = cell_mismatches = short_cells = 0
        for k in cells["cells"]:
            path = cells["dir"] / f"c{k:07d}.mp4"
            decoded[k] = [index_of(p) for p in iter_gray_frames(path, case.output)]
            within = max(0, min(size, len(grid) - k * size))
            short_cells += len(decoded[k]) != within
            for i, value in enumerate(decoded[k][:within]):
                cell_frames += 1
                cell_mismatches += value is None or value != grid[k * size + i]
        plate_mismatches = 0
        for n in range(plan.total_frames):
            sf = tm.out_to_src(n, plan.pieces)[1]
            frames = decoded.get(sf // size, [])
            got = frames[sf % size] if sf % size < len(frames) else None
            plate_mismatches += got is None or got != expected[n]
        results.append({
            "case": case.name,
            "fps": list(case.fps),
            "vfr": case.vfr,
            "layout": case.layout,
            "pieces": len(plan.pieces),
            "removals": len(plan.doc["main"]["removals"]),
            "joins": len(plan.pieces) - 1,
            "grid_frames": len(grid),
            "grid_repeats": sum(a == b for a, b in pairwise(grid)),
            "grid_undecodable": sum(value is None for value in grid),
            "output_frames": plan.total_frames,
            "final_frames": len(final),
            "final_mismatches": sum(
                a is None or a != b for a, b in zip(final, expected)
            ) + abs(len(final) - plan.total_frames),
            "plate_output_frames": plan.total_frames,
            "plate_mismatches": plate_mismatches,
            "plate_cells": len(cells["cells"]),
            "plate_cell_frames_checked": cell_frames,
            "plate_cell_mismatches": cell_mismatches,
            "plate_cells_with_wrong_length": short_cells,
        })
    totals = {
        "final_frames": sum(r["final_frames"] for r in results),
        "final_mismatches": sum(r["final_mismatches"] for r in results),
        "plate_output_frames": sum(r["plate_output_frames"] for r in results),
        "plate_mismatches": sum(r["plate_mismatches"] for r in results),
        "plate_cell_frames_checked": sum(r["plate_cell_frames_checked"] for r in results),
        "plate_cell_mismatches": sum(r["plate_cell_mismatches"] for r in results),
        "plate_cells_with_wrong_length": sum(r["plate_cells_with_wrong_length"]
                                             for r in results),
        "grid_undecodable": sum(r["grid_undecodable"] for r in results),
    }
    passed = (totals["final_frames"] >= P_FRAME_MIN_FRAMES
              and totals["plate_output_frames"] >= P_FRAME_MIN_FRAMES
              and not totals["final_mismatches"] and not totals["plate_mismatches"]
              and not totals["plate_cell_mismatches"]
              and not totals["plate_cells_with_wrong_length"]
              and not totals["grid_undecodable"])
    return {"threshold": {"min_frames": P_FRAME_MIN_FRAMES, "mismatches": 0}, "cases": results,
            "totals": totals, "pass": passed}


# --- P-PLATE (server part) --------------------------------------------------------------------


def _ssim_stats(stderr: str) -> dict[str, float]:
    line = stderr[stderr.rfind("SSIM Y:"):].splitlines()[0]
    values = {}
    for token in line.split():
        key, _, value = token.partition(":")
        if key in ("Y", "U", "V", "All") and value:
            values[key] = float(value)
    return values


def ssim_files(first: Path, second: Path) -> dict[str, float]:
    graph = ("[0:v]settb=1/1,setpts=N[a];[1:v]settb=1/1,setpts=N[b];[a][b]ssim")
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-threads", "4",
         "-i", str(first), "-i", str(second), "-filter_complex", graph, "-f", "null", "-"],
        capture_output=True, text=True, check=True)
    return _ssim_stats(result.stderr)


def ssim_stream(frames: Iterator[bytes], size: tuple[int, int], fps: tuple[int, int],
                reference: Path, work: Path) -> dict[str, float]:
    """SSIM of raw yuv420p ``frames`` (piped) against ``reference``."""
    graph = ("[0:v]settb=1/1,setpts=N[a];[1:v]settb=1/1,setpts=N[b];[a][b]ssim")
    log = work / "ssim.log"
    with open(log, "w", encoding="utf-8") as stderr, subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-threads", "4",
         "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{size[0]}x{size[1]}", "-framerate",
         f"{fps[0]}/{fps[1]}", "-i", "pipe:0", "-i", str(reference), "-filter_complex", graph,
         "-f", "null", "-"], stdin=subprocess.PIPE, stderr=stderr) as process:
        assert process.stdin is not None
        for frame in frames:
            process.stdin.write(frame)
        process.stdin.close()
        process.wait()
    if process.returncode:
        raise RuntimeError("ssim failed")
    return _ssim_stats(log.read_text(encoding="utf-8"))


def plate_sequence(ws: Workspace, case: Case) -> Iterator[bytes]:
    """The plate frames (raw yuv420p) in output order, as the player shows them."""
    plan = ws.plan(case)
    cells = ws.cells(case)
    size = cells["cell_frames"]
    cache: dict[int, list[bytes]] = {}
    for n in range(plan.total_frames):
        sf = tm.out_to_src(n, plan.pieces)[1]
        k = sf // size
        if k not in cache:
            cache.clear()
            cache[k] = decode_yuv420(cells["dir"] / f"c{k:07d}.mp4", case.output)
        yield cache[k][sf % size]


def p_plate(ws: Workspace, cases: Sequence[Case] = P_PLATE_CASES) -> dict[str, Any]:
    from ai_clipper.edit_v2 import layouts

    results = []
    for case in cases:
        plan = ws.plan(case)
        reference = ws.render(case, "reference")["path"]
        final = ws.render(case, "final")["path"]
        ssim_final = ssim_files(final, reference)
        ssim_plate = ssim_stream(plate_sequence(ws, case), case.output, case.fps, reference,
                                 ws.root)
        entry: dict[str, Any] = {
            "case": case.name, "layout": case.layout, "output_frames": plan.total_frames,
            "removals": len(plan.doc["main"]["removals"]), "joins": len(plan.pieces) - 1,
            "plate_cells": len(ws.cells(case)["cells"]),
            "ssim_final_vs_reference": ssim_final, "ssim_plate_vs_reference": ssim_plate,
            "ssim_margin": round(ssim_plate["All"] - (ssim_final["All"] - P_PLATE_SSIM_MARGIN), 6),
        }
        ok = ssim_plate["All"] >= ssim_final["All"] - P_PLATE_SSIM_MARGIN
        if case.layout in ("camera", "fill_center"):
            scaled = layouts.scaled_size(case.source_size, case.output)
            if case.layout == "camera":
                table = layouts.crop_positions(plan.camera, plan.fps, source=case.source_size,
                                               output=case.output, first_sf=0,
                                               count=max(p.out_sf for p in plan.pieces))
            else:
                table = None
            center = (scaled[0] - case.output[0]) // 2
            crop_x = crop_decoder(case)
            cell_frames = tm.cell_frames(plan.fps)
            boundaries = {"cut_frames": 0, "cell_edge_frames": 0}
            counts = {"plate": 0, "reference": 0, "final": 0}
            sources = {"plate": (gray_of_yuv420(f, case.output)
                                 for f in plate_sequence(ws, case)),
                       "reference": iter_gray_frames(reference, case.output),
                       "final": iter_gray_frames(final, case.output)}
            for n, planes in enumerate(zip(sources["plate"], sources["reference"],
                                           sources["final"])):
                piece, sf = tm.out_to_src(n, plan.pieces)
                want = table[sf] if table is not None else center
                for name, plane in zip(("plate", "reference", "final"), planes):
                    counts[name] += crop_x(plane) != want
                boundaries["cut_frames"] += n in (piece.out_f0, piece.out_f0 + piece.frames - 1)
                boundaries["cell_edge_frames"] += sf % cell_frames in (0, cell_frames - 1)
            entry["crop_x_mismatches"] = counts
            entry["crop_x_frames_checked"] = plan.total_frames
            entry.update(boundaries)
            entry["distinct_crop_x"] = (len({table[tm.out_to_src(n, plan.pieces)[1]]
                                             for n in range(plan.total_frames)})
                                        if table is not None else 1)
            ok = ok and not any(counts.values())
        entry["pass"] = ok
        results.append(entry)
    return {"threshold": {"ssim_margin": P_PLATE_SSIM_MARGIN, "crop_x_px": 0},
            "cases": results, "pass": all(r["pass"] for r in results)}


# --- G1/G2 ---------------------------------------------------------------------------------------


def g1_g2(ws: Workspace, cases: Sequence[Case] = P_FRAME_CASES + EXTRA_RENDER_CASES
          ) -> dict[str, Any]:
    from ai_clipper.edit_v2 import errors, verify

    results = []
    for case in cases:
        plan = ws.plan(case)
        path = ws.render(case, "final")["path"]
        fd = os.open(path, os.O_RDONLY)
        try:
            report = verify.verify_output(fd, plan, size=plan.output, normalize=False)
        except errors.VerificationFailed as failure:
            report = failure.report
        finally:
            os.close(fd)
        gates = {gate.name: gate.to_json() for gate in report.gates}
        results.append({"case": case.name, "output": list(case.output), "fps": list(case.fps),
                        "layout": case.layout, "audio": case.audio, "logo": case.logo,
                        "ok": report.ok, "G1": gates["G1"], "G2": gates["G2"],
                        "G5_warnings": [issue.code for issue in report.warnings]})
    return {"renders": len(results), "cases": results,
            "pass": len(results) >= 6 and all(r["G1"]["ok"] and r["G2"]["ok"] for r in results)}


# --- G-DET ---------------------------------------------------------------------------------------


def job_digests(plan: Any, source: Path, assets_root: Path) -> dict[str, str]:
    """sha256 of argv, graph and sidecars of every mode compiled from ``plan``."""
    from ai_clipper.edit_v2.compile_ffmpeg import compile_job

    size = tm.cell_frames(plan.fps)
    first_cell = plan.pieces[0].in_sf // size
    modes: dict[str, dict[str, Any]] = {
        "final": {}, "reference": {}, "plate_cells": {"cells": (first_cell, first_cell + 1)},
        "frame": {"frame": plan.total_frames // 2}, "audio_preview": {}, "audio_measure": {},
    }
    if plan.logo is not None:
        modes["derive_image"] = {}
    digests = {}
    for mode, kwargs in modes.items():
        job = compile_job(plan, mode=mode, source=source, assets_root=assets_root, **kwargs)
        blob = json.dumps({"argv": list(job.argv), "graph": job.filter_script,
                           "sidecars": {name: hashlib.sha256(data).hexdigest()
                                        for name, data in sorted(job.sidecars.items())},
                           "inputs": [[s.kind, s.name, list(s.options)] for s in job.inputs]},
                          sort_keys=True).encode("utf-8")
        digests[mode] = hashlib.sha256(blob).hexdigest()
        if "captions.ass" in job.sidecars:
            digests[f"{mode}.ass"] = hashlib.sha256(job.sidecars["captions.ass"]).hexdigest()
    return digests


def plan_digests(spec: Mapping[str, Any]) -> dict[str, Any]:
    """Digests of every case of a G-DET spec (run in this process)."""
    from ai_clipper.edit_v2.plan import Resources, build_plan

    out = {}
    for name, item in spec["cases"].items():
        plan = build_plan(item["doc"], words=item["words"], camera=item["camera"],
                          assets=item["assets"], resources=Resources(Path(spec["resources"])))
        out[name] = {
            "plan_sha256": plan.plan_sha256,
            "ass_sha256": plan.ass_sha256,
            "speech_envelope_sha256": hashlib.sha256(
                json.dumps(plan.speech_envelope).encode()).hexdigest(),
            "jobs": job_digests(plan, Path(item["source"]), Path(spec["assets_root"])),
        }
    return out


def _file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def g_det(ws: Workspace, cases: Sequence[Case] = P_FRAME_CASES + EXTRA_RENDER_CASES,
          bitstream: Sequence[Case] = (P_FRAME_CASES[0], P_FRAME_CASES[3])) -> dict[str, Any]:
    spec = {"resources": str(ws.resources.root), "assets_root": str(ws.root / "assets"),
            "cases": {case.name: {key: ws.clip(case)[key] if key != "source"
                                  else str(ws.clip(case)["source"])
                                  for key in ("doc", "words", "camera", "assets", "source")}
                      for case in cases}}
    spec_path = ws.root / "gdet-spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    here = plan_digests(spec)
    runs = {"in_process": here}
    for seed in DET_SEEDS:
        env = dict(os.environ, PYTHONHASHSEED=seed)
        child = [sys.executable, str(Path(__file__).resolve()), "gdet-child", str(spec_path)]
        output = subprocess.run(child + (["--harness"] if ws.harness else []),
                                capture_output=True, text=True, env=env, check=True).stdout
        runs[f"hash_seed_{seed}"] = json.loads(output)
    differing = sorted({f"{run}:{name}" for run, digests in runs.items()
                        for name in digests if digests[name] != here[name]})
    ass_mismatch = sorted(
        name for name, item in here.items()
        if not (item["jobs"].get("frame.ass") == item["jobs"].get("final.ass")
                == item["jobs"].get("reference.ass") == item["ass_sha256"])
    )
    streams = []
    for case in bitstream:
        first = _file_sha(ws.render(case, "final")["path"])
        second = _file_sha(ws.render(case, "final", again=True)["path"])
        cells = ws.cells(case)
        cells_again = ws.cells(case, again=True)
        cell_diffs = sum(_file_sha(cells["dir"] / f"c{k:07d}.mp4")
                         != _file_sha(cells_again["dir"] / f"c{k:07d}.mp4")
                         for k in cells["cells"])
        streams.append({"case": case.name, "final_identical": first == second,
                        "plate_cells": len(cells["cells"]), "plate_cells_differing": cell_diffs})
    passed = (not differing and not ass_mismatch
              and all(s["final_identical"] and not s["plate_cells_differing"] for s in streams))
    return {"cases": len(cases), "processes": len(runs),
            "hash_seeds": [int(seed) for seed in DET_SEEDS], "digests_per_case": {
                name: len(item["jobs"]) + 3 for name, item in here.items()},
            "digest_differences": len(differing), "preview_export_ass_mismatches": len(
                ass_mismatch), "bitstream": streams, "pass": passed}


# --- PF-RENDER (report only) ---------------------------------------------------------------------


def _cpu_quota() -> float | None:
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        return None if quota == "max" else int(quota) / int(period)
    except (OSError, ValueError):
        return None


def _nearest_rank(values: Sequence[float], percentile: float) -> float:
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * percentile // 100))
    return ordered[int(rank) - 1]


def pf_render(ws: Workspace, cases: Sequence[Case] = PF_RENDER_CASES) -> dict[str, Any]:
    results = []
    load_before = os.getloadavg()
    for case in cases:
        plan = ws.plan(case)
        ws.clip(case)
        rendered = ws.render(case, "final")
        clip_s = plan.total_frames * plan.fps.den / plan.fps.num
        results.append({"case": case.name, "layout": case.layout,
                        "source": list(case.source_size), "output": list(case.output),
                        "clip_s": round(clip_s, 3), "render_s": round(rendered["elapsed_s"], 3),
                        "ratio": round(rendered["elapsed_s"] / clip_s, 4)})
    ratios = [r["ratio"] for r in results]
    summary = {"p50": _nearest_rank(ratios, 50), "p95": _nearest_rank(ratios, 95)}
    return {"report_only": True, "budget": PF_RENDER_BUDGET, "cases": results,
            "note": ("synthetic barcode source (flat bands, "
                     + ("harness captions" if ws.harness else "real captions, hook and audio")
                     + "): encoding costs less than real footage, so these ratios are a lower "
                     "bound; the real-clip measurement comes with W2"),
            "composite": _composite(),
            "summary": summary,
            "within_budget": {key: summary[key] <= PF_RENDER_BUDGET[key] for key in summary},
            "cpus": {"os_cpu_count": os.cpu_count(),
                     "affinity": len(os.sched_getaffinity(0)), "cgroup_quota": _cpu_quota()},
            "loadavg_before": [round(v, 2) for v in load_before],
            "loadavg_after": [round(v, 2) for v in os.getloadavg()],
            "ffmpeg_threads": 4}


# --- CLI -----------------------------------------------------------------------------------------

GATES: dict[str, tuple[str, Callable[[Workspace], dict[str, Any]]]] = {
    "p-frame": ("P-FRAME", p_frame),
    "p-plate": ("P-PLATE", p_plate),
    "g1g2": ("G1-G2", g1_g2),
    "g-det": ("G-DET", g_det),
    "pf-render": ("PF-RENDER", pf_render),
}


def _composite() -> str:
    from ai_clipper.edit_v2 import compile_ffmpeg

    return compile_ffmpeg.COMPOSITE_FORMAT


def write_evidence(directory: Path, gate: str, result: Mapping[str, Any], *,
                   task: str = TASK) -> Path:
    """Merge this run into ``<directory>/<task>-<gate>.json`` under ``runs[<run id>]``."""
    path = directory / f"{task}-{gate}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.update(gate=gate, task=task)
    data.setdefault("runs", {})[run_id()] = {**result, "toolchain": _toolchain()}
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def main(argv: Sequence[str] | None = None) -> int:
    import argparse
    import tempfile
    import time

    parser = argparse.ArgumentParser(description="T1.3 server-side parity gates")
    parser.add_argument("gate", choices=("all", *GATES, "gdet-child"))
    parser.add_argument("spec", nargs="?", type=Path, help="gdet-child: the spec file")
    parser.add_argument("--evidence", type=Path, help="directory for <task>-<gate>.json")
    parser.add_argument("--task", default=TASK, help="evidence file prefix (default T1.3)")
    parser.add_argument("--harness", action="store_true",
                        help="use the caption/audio stand-ins instead of the real modules")
    args = parser.parse_args(argv)
    if args.harness:
        install_harness()
    if args.gate == "gdet-child":
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
        print(json.dumps(plan_digests(spec), sort_keys=True))
        return 0
    names = list(GATES) if args.gate == "all" else [args.gate]
    failed = []
    with tempfile.TemporaryDirectory(prefix="edit-v2-gates-") as tmp:
        ws = Workspace(Path(tmp), harness=args.harness)
        for name in names:
            gate, function = GATES[name]
            started = time.monotonic()
            result = function(ws)
            result["gate_wall_s"] = round(time.monotonic() - started, 1)
            result["modules"] = "harness" if args.harness else "real"
            if args.evidence is not None:
                write_evidence(args.evidence, gate, result, task=args.task)
            status = result.get("pass", "report")
            print(f"{gate}: {status} ({result['gate_wall_s']} s)", flush=True)
            if result.get("pass") is False:
                failed.append(gate)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
