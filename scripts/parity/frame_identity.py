"""Server-side parity gates of the single compiler (plan §10.1 P-FRAME, P-PLATE; §10.2 G1/G2,
G-DET; §10.3 PF-RENDER). A port of the PF spike ``frame_identity.py`` against
``edit_v2.compile_ffmpeg``.

The spike compared one seeked range with the whole-file ``fps=F`` grid. Here every output frame
of a compiled render (plate cells and final) is decoded, its barcode frame index read back
(``support.edit_v2_media``) and compared with the grid frame the time map says it must show.

**Harness.** Until the W1 integrator connects T1.2a (captions) and T1.4 (audio), the compiler is
driven with the deterministic stand-ins below (``HARNESS_PATCHES``), which honour the Appendix A
contracts: a caption track whose ASS has one bottom event per piece, and an audio fragment that
turns ``[sa<i>]`` into ``[apre]`` with the exact sample count (plan §5.3). The unit tests use the
same stand-ins, so the string goldens do not move when the real modules land.

Run (stdlib only; the reference image has no pytest)::

    PYTHONPATH=src:tests python scripts/parity/frame_identity.py all --evidence docs/editor/evidence/W1

    docker run --rm --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/src:/w/tests \\
        ai-video-clipper:editor-ref /app/.venv/bin/python scripts/parity/frame_identity.py all \\
        --evidence docs/editor/evidence/W1
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
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

    Each ``[sa<i>]`` is resampled, panned to stereo and trimmed to the piece's exact samples
    (plan §5.3), then the pieces are concatenated into ``[apre]``. A source without audio gives
    ``anullsrc`` with the exact sample count. Music items are not mixed by the harness.
    """
    fps = plan.fps
    parts = []
    if plan.doc["base"]["source"]["has_audio"]:
        for piece in plan.pieces:
            first = piece.in_sf * SAMPLE_RATE * fps.den // fps.num
            count = tm.smp(piece.out_f0 + piece.frames, fps) - tm.smp(piece.out_f0, fps)
            parts.append(
                f"[sa{piece.i}]aresample={SAMPLE_RATE},pan=stereo|FL=FL+FC|FR=FR+FC,"
                f"asettb=1/{SAMPLE_RATE},atrim=start_pts={first}:end_pts={first + count},"
                f"asetpts=PTS-STARTPTS[au_p{piece.i}]"
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
