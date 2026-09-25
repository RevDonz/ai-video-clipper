"""Synthetic test media for Editor V3 (plan §11.1 T1.0). Generated on the fly, never stored.

**Barcode video.** Every frame carries, in full-width horizontal bands from the top:

* the frame index (24 bits) as ``INDEX_BANDS`` bands: a white and a black sync band, the 24
  bits most significant first (white = 1), and an even-parity band;
* a **column ruler**: ``ruler_bits`` bands where column ``c`` shows the Gray code of ``c``
  (most significant bit first), so the source column, and therefore the crop x, can be read
  back from any rendered frame;
* a grey background below, which can flash white every ``scene_cut_every`` frames to make the
  source scene-cut heavy.

The bands span the full width, so any horizontal crop keeps them; the decoders take the
vertical geometry (``scale``, ``top``) of the layout that was applied. Luma is 235 (white) /
16 (black). The frame index is the index of the generated frame, before VFR frame drops.

**Audio.** Tone bursts (sine, 5 ms raised-cosine ramps, exact silence between) and
single-sample click markers at known samples, 48 kHz by default.

Videos are built with FFmpeg lavfi (background, bands via ``drawbox`` with per-frame
``enable``) plus raw frames (the ruler, looped) and raw PCM. Encoding uses at most
``FFMPEG_THREADS`` threads.

Self-check (evidence in the reference image)::

    PYTHONPATH=src:tests python -m support.edit_v2_media self-check OUT.json
"""

from __future__ import annotations

import argparse
import array
import functools
import json
import math
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any

FFMPEG_THREADS = 4
INDEX_BITS = 24
INDEX_BANDS = INDEX_BITS + 3  # white sync, black sync, bits (MSB first), even parity
WHITE = 235
BLACK = 16
GREY = 128
SYNC_MIN_CONTRAST = 80

# The pinned production toolchain (plan §10, E10): image ai-video-clipper:editor-ref.
REFERENCE_FFMPEG = "5.1.9"
REFERENCE_PACKAGES = (
    ("libass9", "0.17.1"),
    ("libfreetype6", "2.12.1"),
    ("libharfbuzz0b", "6.0.0"),
    ("libfribidi0", "1.0.8"),
    ("fontconfig", "2.14.1"),
)


class MediaError(RuntimeError):
    """FFmpeg is missing or a generation/decoding step failed."""


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def _require(tool: str | None, name: str) -> str:
    if tool is None:
        raise MediaError(f"{name} not found")
    return tool


@functools.cache
def ffmpeg_has_filter(name: str) -> bool:
    ffmpeg = ffmpeg_path()
    if ffmpeg is None:
        return False
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, check=False
    )
    return any(line.split()[1:2] == [name] for line in result.stdout.splitlines())


def _upstream_version(version: str) -> str:
    version = version.split(":", 1)[-1]  # epoch
    return version.split("-", 1)[0].split("+", 1)[0]  # revision, +dfsg


def reference_toolchain_problem() -> str | None:
    """``None`` on the pinned toolchain (FFmpeg 5.1.9, libass 0.17.1, …), else the reason."""
    ffmpeg = ffmpeg_path()
    if ffmpeg is None:
        return "ffmpeg not found"
    first = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=False)
    words = first.stdout.split()
    version = words[2] if len(words) > 2 else "unknown"
    if not version.startswith(REFERENCE_FFMPEG):
        return f"ffmpeg {version} (reference {REFERENCE_FFMPEG})"
    dpkg = shutil.which("dpkg-query")
    if dpkg is None:
        return "dpkg-query not found; cannot check libass/freetype/harfbuzz/fribidi/fontconfig"
    for package, wanted in REFERENCE_PACKAGES:
        result = subprocess.run(
            [dpkg, "-W", "-f=${Version}\n", package], capture_output=True, text=True, check=False
        )
        versions = result.stdout.split()  # one line per installed architecture
        found = _upstream_version(versions[0]) if result.returncode == 0 and versions else "missing"
        if found != wanted:
            return f"{package} {found} (reference {wanted})"
    return None


# --- pattern -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Pattern:
    """Band geometry of a ``width``×``height`` barcode source (all values in source pixels)."""

    width: int
    height: int
    band_h: int
    ruler_bits: int

    @property
    def index_top(self) -> int:
        return 0

    @property
    def ruler_top(self) -> int:
        return INDEX_BANDS * self.band_h

    @property
    def bg_top(self) -> int:
        return self.ruler_top + self.ruler_bits * self.band_h

    @classmethod
    def for_size(cls, width: int, height: int) -> Pattern:
        if width % 2 or height % 2 or width < 16 or height < 16:
            raise ValueError("barcode sources need even dimensions of at least 16 px")
        band_h = max(4, (height // 64) & ~1)
        pattern = cls(width, height, band_h, max(1, (width - 1).bit_length()))
        if pattern.bg_top >= height:
            raise ValueError("frame too small for the barcode and ruler bands")
        return pattern


def gray_code(value: int) -> int:
    return value ^ (value >> 1)


def gray_decode(code: int) -> int:
    value = code
    shift = code >> 1
    while shift:
        value ^= shift
        shift >>= 1
    return value


def _index_bits(index: int) -> list[bool]:
    if not 0 <= index < 1 << INDEX_BITS:
        raise ValueError("frame index must fit in 24 bits")
    bits = [bool(index >> bit & 1) for bit in range(INDEX_BITS - 1, -1, -1)]
    return [True, False, *bits, sum(bits) % 2 == 1]


def _ruler_rows(pattern: Pattern) -> list[bytes]:
    rows = []
    for band in range(pattern.ruler_bits):
        bit = pattern.ruler_bits - 1 - band
        row = bytes(
            WHITE if gray_code(column) >> bit & 1 else BLACK for column in range(pattern.width)
        )
        rows.extend([row] * pattern.band_h)
    return rows


def render_luma(pattern: Pattern, index: int) -> bytes:
    """The luma plane of frame ``index`` as FFmpeg draws it (without compression)."""
    rows = []
    for on in _index_bits(index):
        rows.extend([bytes([WHITE if on else BLACK]) * pattern.width] * pattern.band_h)
    rows.extend(_ruler_rows(pattern))
    rows.extend([bytes([GREY]) * pattern.width] * (pattern.height - pattern.bg_top))
    return b"".join(rows)


def _ruler_yuv420(pattern: Pattern) -> bytes:
    luma = b"".join(_ruler_rows(pattern))
    chroma = bytes([128]) * ((pattern.width // 2) * (pattern.ruler_bits * pattern.band_h // 2))
    return luma + chroma + chroma


# --- decoders ----------------------------------------------------------------------------------


def _row(pattern: Pattern, band: int, scale: float, top: float, height: int) -> int:
    y = top + (band + 0.5) * pattern.band_h * scale
    return min(max(math.floor(y), 0), height - 1)


def _median(values: list[int]) -> int:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _sync_levels(plane: bytes, width: int, height: int, pattern: Pattern, scale: float,
                 top: float) -> tuple[int, int] | None:
    columns = [int(width * (k + 0.5) / 9) for k in range(9)]
    levels = []
    for band in (0, 1):
        row = _row(pattern, band, scale, top, height) * width
        levels.append(_median([plane[row + x] for x in columns]))
    white, black = levels
    if white - black < SYNC_MIN_CONTRAST:
        return None
    return white, black


def decode_index(plane: bytes, width: int, height: int, pattern: Pattern, *,
                 scale: float = 1.0, top: float = 0.0) -> int | None:
    """Frame index of a gray ``plane`` whose source rows were scaled by ``scale`` and shifted
    to ``top`` (fit_blur foreground: ``scale = W/w_src``, ``top = (H − h_src·scale)/2``; crop
    layouts: ``scale = H/h_src``, ``top = 0``). ``None`` when the sync bands or parity fail."""
    levels = _sync_levels(plane, width, height, pattern, scale, top)
    if levels is None:
        return None
    threshold = sum(levels) / 2
    columns = [int(width * (k + 0.5) / 9) for k in range(9)]
    bits = []
    for band in range(2, INDEX_BANDS):
        row = _row(pattern, band, scale, top, height) * width
        bits.append(_median([plane[row + x] for x in columns]) > threshold)
    value = 0
    for bit in bits[:INDEX_BITS]:
        value = value << 1 | bit
    if bits[INDEX_BITS] != (sum(bits[:INDEX_BITS]) % 2 == 1):
        return None
    return value


def decode_ruler(plane: bytes, width: int, height: int, pattern: Pattern, *,
                 scale: float = 1.0, top: float = 0.0) -> list[int]:
    """The source column shown in each output column (Gray-decoded ruler)."""
    levels = _sync_levels(plane, width, height, pattern, scale, top)
    threshold = sum(levels) / 2 if levels else 128
    rows = [
        _row(pattern, INDEX_BANDS + band, scale, top, height) * width
        for band in range(pattern.ruler_bits)
    ]
    columns = []
    for x in range(width):
        code = 0
        for row in rows:
            code = code << 1 | (plane[row + x] > threshold)
        columns.append(gray_decode(code))
    return columns


def decode_crop_x(plane: bytes, width: int, height: int, pattern: Pattern, *,
                  scale: float, top: float = 0.0) -> int | None:
    """The crop x (in the scaled source) of a crop layout: scale by ``scale`` (the horizontal
    factor, e.g. ``scaled_width / source_width``), then ``crop=width:…:x``. Each output column
    votes for the x values consistent with its decoded source column; the most voted x wins."""
    columns = decode_ruler(plane, width, height, pattern, scale=scale, top=top)
    limit = math.ceil(pattern.width * scale) - width
    if limit < 0:
        return None
    votes = [0] * (limit + 2)
    for j, column in enumerate(columns):
        low = max(math.ceil(column * scale - j - 0.5), 0)
        high = min(math.ceil((column + 1) * scale - j - 0.5) - 1, limit)
        if low <= high:
            votes[low] += 1
            votes[high + 1] -= 1
    best, best_votes, running = None, 0, 0
    for x in range(limit + 1):
        running += votes[x]
        if running > best_votes:
            best, best_votes = x, running
    return best if best_votes * 2 >= width else None


# --- audio -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ToneBurst:
    """A sine burst on ``[start_ms, end_ms)``; the period is ``round(rate / freq_hz)`` samples."""

    start_ms: int
    end_ms: int
    freq_hz: int = 1000
    level_cdb: int = -1200  # peak level in centi-dBFS


@dataclass(frozen=True)
class AudioSpec:
    """``bursts``/``clicks_ms`` of ``None`` mean the default schedule for the duration."""

    sample_rate: int = 48_000
    channels: int = 2
    bursts: tuple[ToneBurst, ...] | None = None
    clicks_ms: tuple[int, ...] | None = None
    click_level_cdb: int = -300


def default_bursts(duration_ms: int) -> tuple[ToneBurst, ...]:
    """Two word-like 240 ms bursts per second (at +400 and +700 ms), frequencies cycling."""
    bursts = []
    for second in range(0, duration_ms, 1000):
        freq = (600, 750, 800, 1000, 1200)[(second // 1000) % 5]
        for offset in (400, 700):
            start = second + offset
            if start < duration_ms:
                bursts.append(ToneBurst(start, min(start + 240, duration_ms), freq))
    return tuple(bursts)


def default_clicks(duration_ms: int) -> tuple[int, ...]:
    """One click per second at +250 ms, inside the silence before the bursts."""
    return tuple(range(250, duration_ms, 1000))


def audio_samples(frames: int, fps: tuple[int, int], sample_rate: int) -> int:
    """Samples covering ``frames`` video frames: ``⌈frames·rate·den / num⌉``."""
    return -(-frames * sample_rate * fps[1] // fps[0])


def _amplitude(level_cdb: int) -> float:
    return 32767 * 10 ** (level_cdb / 2000)


def render_pcm(spec: AudioSpec, samples: int) -> bytes:
    """Interleaved s16le PCM of ``spec`` with exactly ``samples`` samples per channel."""
    rate = spec.sample_rate
    duration_ms = samples * 1000 // rate + 1
    bursts = default_bursts(duration_ms) if spec.bursts is None else spec.bursts
    clicks = default_clicks(duration_ms) if spec.clicks_ms is None else spec.clicks_ms
    mono = array.array("h", bytes(2 * samples))
    for burst in bursts:
        start = min(burst.start_ms * rate // 1000, samples)
        end = min(burst.end_ms * rate // 1000, samples)
        if end <= start:
            continue
        period = max(2, round(rate / burst.freq_hz))
        amplitude = _amplitude(burst.level_cdb)
        cycle = [round(amplitude * math.sin(2 * math.pi * k / period)) for k in range(period)]
        length = end - start
        tone = (cycle * (length // period + 1))[:length]
        ramp = min(rate * 5 // 1000, length // 2)
        for k in range(ramp):
            gain = 0.5 - 0.5 * math.cos(math.pi * k / ramp)
            tone[k] = round(tone[k] * gain)
            tone[length - 1 - k] = round(tone[length - 1 - k] * gain)
        mono[start:end] = array.array("h", tone)
    click = round(_amplitude(spec.click_level_cdb))
    for ms in clicks:
        index = ms * rate // 1000
        if 0 <= index < samples:
            mono[index] = click
    if spec.channels == 1:
        return mono.tobytes()
    interleaved = array.array("h", bytes(2 * samples * spec.channels))
    for channel in range(spec.channels):
        interleaved[channel :: spec.channels] = mono
    return interleaved.tobytes()


def find_clicks(samples: Sequence[int], *, channels: int, threshold: float = 0.5) -> list[int]:
    """Sample indices (per channel) of click markers: peaks of channel 0 above ``threshold``
    full scale; hits within 8 samples are merged (lossy codecs smear a click)."""
    limit = threshold * 32767
    found: list[tuple[int, int]] = []
    for index, value in enumerate(samples[0::channels]):
        if abs(value) >= limit:
            if found and index - found[-1][0] <= 8:
                if abs(value) > found[-1][1]:
                    found[-1] = (index, abs(value))
                continue
            found.append((index, abs(value)))
    return [index for index, _level in found]


# --- generation --------------------------------------------------------------------------------


@dataclass(frozen=True)
class VideoSpec:
    width: int = 640
    height: int = 360
    fps: tuple[int, int] = (30000, 1001)
    frames: int = 300
    vfr: bool = False  # ms timebase with 0–2 ms jitter (needs container "mkv")
    drop_every: int = 0  # drop every n-th generated frame (index n % drop_every == last)
    scene_cut_every: int = 0  # background flashes white/grey every n frames
    gop: int = 250
    crf: int = 18
    container: str = "mp4"  # "mp4" (AAC) or "mkv" (PCM, exact samples)
    audio: AudioSpec | None = AudioSpec()
    # The video stream starts this late (the audio still at 0), like a download whose video
    # has a B-frame delay (ffprobe start_time 0.041 s): mp4 only, set by a stream-copy remux.
    video_delay_ms: int = 0


def _drawboxes(spec: VideoSpec, pattern: Pattern) -> list[str]:
    band = pattern.band_h
    width = pattern.width
    filters = [
        f"drawbox=x=0:y=0:w={width}:h={INDEX_BANDS * band}:color=black:t=fill",
        f"drawbox=x=0:y=0:w={width}:h={band}:color=white:t=fill",
    ]
    terms = []
    for position in range(INDEX_BITS):
        bit = INDEX_BITS - 1 - position
        term = f"mod(floor(n/{1 << bit}),2)"
        terms.append(term)
        y = (2 + position) * band
        filters.append(
            f"drawbox=x=0:y={y}:w={width}:h={band}:color=white:t=fill:enable='{term}'"
        )
    parity_y = (INDEX_BANDS - 1) * band
    filters.append(
        f"drawbox=x=0:y={parity_y}:w={width}:h={band}:color=white:t=fill:"
        f"enable='mod({'+'.join(terms)},2)'"
    )
    if spec.scene_cut_every:
        filters.append(
            f"drawbox=x=0:y={pattern.bg_top}:w={width}:h={pattern.height - pattern.bg_top}:"
            f"color=white:t=fill:enable='mod(floor(n/{spec.scene_cut_every}),2)'"
        )
    return filters


def make_barcode_video(path: Path, spec: VideoSpec = VideoSpec()) -> Path:  # noqa: B008
    """Write a barcode video for ``spec`` to ``path`` (overwritten) and return ``path``."""
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    if spec.vfr and spec.container != "mkv":
        raise ValueError("VFR sources are written as mkv (ms timestamps)")
    if spec.frames <= 0 or spec.frames >= 1 << INDEX_BITS:
        raise ValueError("frames must be between 1 and 2^24 - 1")
    if spec.video_delay_ms and (spec.container != "mp4" or spec.video_delay_ms < 0):
        raise ValueError("a video delay needs an mp4 container and a positive delay")
    pattern = Pattern.for_size(spec.width, spec.height)
    num, den = spec.fps
    path = Path(path)
    with tempfile.TemporaryDirectory(prefix="edit-v2-media-") as tmp:
        work = Path(tmp)
        (work / "ruler.yuv").write_bytes(_ruler_yuv420(pattern))
        chain = [
            f"[0:v]format=yuv420p,trim=end_frame={spec.frames}[bg]",
            f"[bg][1:v]overlay=x=0:y={pattern.ruler_top}:shortest=1,"
            + ",".join(_drawboxes(spec, pattern))
            + (
                f",select='not(eq(mod(n,{spec.drop_every}),{spec.drop_every - 1}))'"
                if spec.drop_every
                else ""
            )
            + (",settb=1/1000,setpts='PTS+mod(N,3)'" if spec.vfr else "")
            + "[v]",
        ]
        (work / "graph.txt").write_text(";".join(chain), encoding="utf-8")
        argv = [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=0x808080:s={spec.width}x{spec.height}:r={num}/{den}",
            "-stream_loop", "-1", "-f", "rawvideo", "-pix_fmt", "yuv420p",
            "-s", f"{spec.width}x{pattern.ruler_bits * pattern.band_h}",
            "-framerate", f"{num}/{den}", "-i", str(work / "ruler.yuv"),
        ]
        if spec.audio is not None:
            samples = audio_samples(spec.frames, spec.fps, spec.audio.sample_rate)
            (work / "audio.pcm").write_bytes(render_pcm(spec.audio, samples))
            argv += ["-f", "s16le", "-ar", str(spec.audio.sample_rate),
                     "-ac", str(spec.audio.channels), "-i", str(work / "audio.pcm")]
        argv += ["-filter_complex_script", str(work / "graph.txt"), "-map", "[v]"]
        if spec.audio is not None:
            argv += ["-map", "2:a"]
            if spec.container == "mkv":
                argv += ["-c:a", "pcm_s16le"]
            else:
                argv += ["-c:a", "aac", "-b:a", "192k"]
        argv += [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", str(spec.crf), "-g", str(spec.gop),
            "-pix_fmt", "yuv420p", "-threads", str(FFMPEG_THREADS),
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-color_range", "tv", "-fps_mode", "passthrough" if spec.vfr else "cfr",
            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
            "-flags:a", "+bitexact",
            str(work / "undelayed.mp4") if spec.video_delay_ms else str(path),
        ]
        _run(argv)
        if spec.video_delay_ms:
            undelayed = str(work / "undelayed.mp4")
            remux = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                     "-itsoffset", f"{spec.video_delay_ms / 1000:.3f}", "-i", undelayed]
            maps = ["-map", "0:v"]
            if spec.audio is not None:
                remux += ["-i", undelayed]
                maps += ["-map", "1:a"]
            _run(remux + maps + ["-c", "copy", "-map_metadata", "-1", "-fflags", "+bitexact",
                                 str(path)])
    return path


def make_audio(path: Path, spec: AudioSpec, *, duration_ms: int) -> Path:
    """Write an audio file (``.wav`` s16, ``.flac``, or ``.m4a`` AAC 192k) of ``spec``."""
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    path = Path(path)
    codec = {".wav": ["-c:a", "pcm_s16le"], ".flac": ["-c:a", "flac"],
             ".m4a": ["-c:a", "aac", "-b:a", "192k"]}.get(path.suffix)
    if codec is None:
        raise ValueError("audio files must be .wav, .flac or .m4a")
    samples = duration_ms * spec.sample_rate // 1000
    with tempfile.TemporaryDirectory(prefix="edit-v2-audio-") as tmp:
        raw = Path(tmp) / "audio.pcm"
        raw.write_bytes(render_pcm(spec, samples))
        _run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
              "-f", "s16le", "-ar", str(spec.sample_rate), "-ac", str(spec.channels),
              "-i", str(raw), *codec, "-map_metadata", "-1", "-fflags", "+bitexact",
              "-flags:a", "+bitexact", str(path)])
    return path


def make_logo_png(path: Path, width: int, height: int) -> Path:
    """An RGBA PNG logo: a translucent blue box with an opaque yellow inner box."""
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    graph = (
        f"color=c=0x2266CC@0.6:s={width}x{height},format=rgba,"
        f"drawbox=x={width // 8}:y={height // 8}:w={width * 3 // 4}:h={height * 3 // 4}:"
        "color=0xFFCC00@1.0:t=fill"
    )
    _run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
          "-i", graph, "-frames:v", "1", "-pix_fmt", "rgba", "-fflags", "+bitexact",
          "-flags:v", "+bitexact", str(path)])
    return Path(path)


def _run(argv: list[str], *, timeout_s: float = 600.0) -> bytes:
    try:
        result = subprocess.run(argv, capture_output=True, check=False, timeout=timeout_s)
    except subprocess.TimeoutExpired as error:
        raise MediaError(f"{Path(argv[0]).name} timed out after {timeout_s:.0f} s") from error
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-5:]
        raise MediaError("ffmpeg failed: " + " | ".join(tail))
    return result.stdout


# --- reading back ------------------------------------------------------------------------------


def probe(path: Path) -> dict[str, Any]:
    """``{"video": first video stream, "audio": first audio stream}`` from ffprobe (or None)."""
    ffprobe = _require(ffprobe_path(), "ffprobe")
    output = _run([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(path)])
    streams = json.loads(output)["streams"]
    first = {}
    for kind in ("video", "audio"):
        first[kind] = next((s for s in streams if s.get("codec_type") == kind), None)
    return first


def read_gray_frames(path: Path, *, vf: str | None = None,
                     size: tuple[int, int] | None = None) -> tuple[int, int, list[bytes]]:
    """Decode every video frame (no frame-rate conversion) as 8-bit gray planes.

    ``size`` is the frame size after ``vf``; without ``vf`` it is probed.
    """
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    if size is None:
        if vf is not None:
            raise ValueError("pass size when vf changes the frame size")
        stream = probe(path)["video"]
        size = (int(stream["width"]), int(stream["height"]))
    width, height = size
    argv = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads",
            str(FFMPEG_THREADS), "-i", str(path), "-map", "0:v:0"]
    if vf:
        argv += ["-vf", vf]
    argv += ["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    data = _run(argv)
    frame = width * height
    if len(data) % frame:
        raise MediaError("decoded size is not a whole number of frames")
    return width, height, [data[i : i + frame] for i in range(0, len(data), frame)]


def read_pcm(path: Path, *, sample_rate: int = 48_000, channels: int = 2) -> array.array:
    """Decode the first audio stream as interleaved s16 samples."""
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    data = _run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path),
                 "-map", "0:a:0", "-f", "s16le", "-ar", str(sample_rate), "-ac", str(channels),
                 "-"])
    samples = array.array("h")
    samples.frombytes(data)
    return samples


def frame_times_ms(path: Path) -> list[float]:
    """Presentation times of the decoded video frames, in ms."""
    ffprobe = _require(ffprobe_path(), "ffprobe")
    output = _run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                   "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(path)])
    return [float(line.strip().rstrip(",")) * 1000 for line in output.decode().splitlines()
            if line.strip()]


def grid_range(path: Path, fps: tuple[int, int]) -> tuple[int, int]:
    """``(first, end)``: the source-grid indices ``[first, end)`` that the whole-file ``fps``
    grid holds, from the decoded frame timestamps with ``-copyts`` (independent of
    ``edit_v2.source_info``). A source whose video starts after t = 0 has ``first > 0``."""
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    output = _run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads",
                   str(FFMPEG_THREADS), "-copyts", "-i", str(path), "-map", "0:v:0", "-vf",
                   f"fps={fps[0]}/{fps[1]},scale=16:16", "-f", "framemd5", "-"])
    pts = [int(line.split(",")[2]) for line in output.decode().splitlines()
           if line.strip() and not line.startswith("#")]
    if not pts:
        raise MediaError("no video frames")
    if pts != list(range(pts[0], pts[0] + len(pts))):
        raise MediaError("the fps grid is not contiguous")
    return pts[0], pts[-1] + 1


def grid_indices(path: Path, fps: tuple[int, int]) -> list[int | None]:
    """Frame indices of the whole-file ``fps=num/den`` grid (the P-FRAME reference)."""
    stream = probe(path)["video"]
    width, height = int(stream["width"]), int(stream["height"])
    pattern = Pattern.for_size(width, height)
    _w, _h, frames = read_gray_frames(path, vf=f"fps={fps[0]}/{fps[1]}", size=(width, height))
    return [decode_index(frame, width, height, pattern) for frame in frames]


# --- self-check (evidence) -----------------------------------------------------------------------


def self_check() -> dict[str, Any]:
    """Generate, decode and measure: CFR, VFR, fit-blur scaling and crop-x recovery."""
    report: dict[str, Any] = {"reference_toolchain_problem": reference_toolchain_problem()}
    ffmpeg = _require(ffmpeg_path(), "ffmpeg")
    report["ffmpeg"] = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True,
                                      check=False).stdout.splitlines()[0]
    with tempfile.TemporaryDirectory(prefix="edit-v2-selfcheck-") as tmp:
        work = Path(tmp)
        cfr = VideoSpec(width=640, height=360, fps=(30000, 1001), frames=300, container="mkv",
                        scene_cut_every=45)
        path = make_barcode_video(work / "cfr.mkv", cfr)
        width, height, frames = read_gray_frames(path)
        pattern = Pattern.for_size(width, height)
        decoded = [decode_index(frame, width, height, pattern) for frame in frames]
        report["cfr_2997"] = {
            "frames": len(frames),
            "index_mismatches": sum(a != b for a, b in zip(decoded, range(cfr.frames))),
            "grid_mismatches": sum(
                a != b for a, b in zip(grid_indices(path, cfr.fps), range(cfr.frames))
            ),
            "ruler_mismatches": sum(
                decode_ruler(frame, width, height, pattern) != list(range(width))
                for frame in frames[:30]
            ),
        }
        samples = read_pcm(path)
        expected_clicks = [ms * 48 for ms in default_clicks(10_000)
                           if ms * 48 < audio_samples(cfr.frames, cfr.fps, 48_000)]
        report["cfr_2997"]["click_mismatches"] = int(
            find_clicks(samples, channels=2) != expected_clicks
        )
        vfr = VideoSpec(width=640, height=360, fps=(30, 1), frames=120, vfr=True, drop_every=9,
                        container="mkv", audio=None)
        path = make_barcode_video(work / "vfr.mkv", vfr)
        _w, _h, frames = read_gray_frames(path)
        decoded = [decode_index(frame, width, height, pattern) for frame in frames]
        report["vfr"] = {
            "frames": len(frames),
            "index_mismatches": int(decoded != [n for n in range(120) if n % 9 != 8]),
            "distinct_steps_ms": len({round(b - a) for a, b in pairwise(frame_times_ms(path))}),
        }
        crop_errors = 0
        checked = 0
        scaled_w = 2276  # 640x360 -> 2276x1280 (fill_center / camera at 720x1280)
        for crop_x in (0, 1, 333, 778, 1555, 1556):
            _w, _h, frames = read_gray_frames(
                work / "cfr.mkv", vf=f"scale={scaled_w}:1280,crop=720:1280:{crop_x}:0",
                size=(720, 1280))
            for frame in frames[:20]:
                got = decode_crop_x(frame, 720, 1280, pattern, scale=scaled_w / 640)
                crop_errors += got != crop_x
                checked += 1
        report["crop_x"] = {"frames_checked": checked, "errors": crop_errors}
        _w, _h, frames = read_gray_frames(
            work / "cfr.mkv", vf="scale=720:-2,pad=720:1280:0:(oh-ih)/2", size=(720, 1280))
        top = (1280 - 360 * 720 / 640) / 2
        decoded = [decode_index(f, 720, 1280, pattern, scale=720 / 640, top=top) for f in frames]
        report["fit_blur_scaled"] = {
            "frames": len(frames),
            "index_mismatches": sum(a != b for a, b in zip(decoded, range(cfr.frames))),
        }
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Editor V3 synthetic media")
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("self-check")
    check.add_argument("output", type=Path)
    args = parser.parse_args(argv)
    report = self_check()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    failures = sum(
        value for section in report.values() if isinstance(section, dict)
        for key, value in section.items() if key.endswith(("mismatches", "errors"))
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
