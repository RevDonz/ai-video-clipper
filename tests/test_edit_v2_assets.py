"""``edit_v2.assets``: upload ingest and the job asset store (plan §9.2, §4.1, §4.2; T3.1).

Every row of §9.2 is covered here: transport caps (re-checked in Python), the quarantine, the
sniff, the forced demuxer, ``-enable_drefs 0``, EXIF orientation, normalisation, chunk
stripping, identity and the store; plus idempotency receipts, per-job quotas, the hardened
FFmpeg invocation (prlimit, fd input, protocol whitelist, threads, timeouts) and the ingest
child's environment (E11: no secret). Test media is generated (lavfi, ``wave``); nothing is
committed.
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import os
import shutil
import stat
import struct
import subprocess
import sys
import time
import unicodedata
import uuid
import wave
import zlib
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import assets, png_strip, store
from ai_clipper.edit_v2.compile_ffmpeg import asset_path

ROOT = Path(__file__).resolve().parents[1]
JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"
SECRETS = {
    "APP_PASSWORD": "app-password-value",
    "APP_SESSION_SECRET": "session-secret-value-that-is-long-enough-000",
    "POTONGIN_SETTINGS_SECRET": "settings-secret-value",
    "OPENROUTER_API_KEY": "sk-or-secret-value",
    "POTONGIN_LLM_CUSTOM_API_KEY": "custom-secret-value",
    "GEMINI_API_KEY": "gemini-secret-value",
}
FFMPEG_ENV = {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR"}


# Helpers.


class Job:
    def __init__(self, root: Path, job_id: str = JOB_ID) -> None:
        self.root = root
        self.id = job_id
        self.dir = root / job_id
        (self.dir / "analysis").mkdir(parents=True, exist_ok=True)

    @property
    def store(self) -> Path:
        return self.dir / "analysis" / "assets"

    @property
    def incoming(self) -> Path:
        return self.store / ".incoming"

    def quarantine(self, data: bytes) -> str:
        self.store.mkdir(exist_ok=True, mode=0o700)
        self.incoming.mkdir(exist_ok=True, mode=0o700)
        incoming_id = str(uuid.uuid4())
        path = self.incoming / incoming_id
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        return incoming_id

    def ingest(self, data: bytes, kind: str, mime: str, *, name: str | None = None,
               key: str | None = None) -> tuple[int, dict]:
        incoming_id = self.quarantine(data)
        envelope = {"op": "ingest", "jobId": self.id, "incomingId": incoming_id, "kind": kind,
                    "mime": mime, "name": name, "idempotencyKey": key or str(uuid.uuid4())}
        code, payload = assets.handle(json.dumps(envelope).encode(), jobs_root=self.root)
        assert not (self.incoming / incoming_id).exists(), "the quarantined original survived"
        assert str(self.root) not in json.dumps(payload)
        return code, payload

    def files(self) -> list[str]:
        if not self.store.is_dir():
            return []
        return sorted(p.name for p in self.store.iterdir() if not p.name.startswith("."))


@pytest.fixture
def job(tmp_path: Path) -> Job:
    return Job(tmp_path / "jobs")


def ok(result: tuple[int, dict]) -> dict:
    code, payload = result
    assert code == 0, payload
    return payload


def rejected(result: tuple[int, dict], code: str, ref: str | None = None) -> dict:
    exit_code, payload = result
    assert exit_code == 3, payload
    assert payload["error"]["code"] == code, payload
    assert payload["error"]["messageId"] == f"edit.{code}"
    if ref is not None:
        assert payload["error"]["ref"] == ref, payload
    return payload


def ffmpeg(edit_v2_ffmpeg: str, *args: str) -> None:
    subprocess.run([edit_v2_ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    *args], check=True, timeout=120)


def encoders(edit_v2_ffmpeg: str) -> str:
    return subprocess.run([edit_v2_ffmpeg, "-hide_banner", "-encoders"], capture_output=True,
                          text=True, check=True).stdout


def wav_bytes(path: Path, *, seconds: float = 3.0, rate: int = 44100, channels: int = 1,
              amplitude: float = 0.1, frequency: float = 1000.0) -> bytes:
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        data = bytearray()
        for n in range(frames):
            value = int(amplitude * 32767 * math.sin(2 * math.pi * frequency * n / rate))
            data += struct.pack("<h", value) * channels
        handle.writeframes(bytes(data))
    return path.read_bytes()


def png_bytes(edit_v2_ffmpeg: str, path: Path, width: int, height: int, *,
              pix_fmt: str = "rgba", comment: str | None = None) -> bytes:
    extra = ["-metadata", f"comment={comment}"] if comment else []
    ffmpeg(edit_v2_ffmpeg, "-f", "lavfi", "-i", f"testsrc2=s={width}x{height}", "-frames:v", "1",
           "-pix_fmt", pix_fmt, *extra, str(path))
    return path.read_bytes()


def decode_rgba(edit_v2_ffmpeg: str, data: bytes) -> bytes:
    return subprocess.run([edit_v2_ffmpeg, "-nostdin", "-loglevel", "error", "-f", "png_pipe",
                           "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
                          input=data, capture_output=True, check=True, timeout=60).stdout


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json",
                          str(path)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def chunk_kinds(data: bytes) -> list[bytes]:
    out, position = [], 8
    while position < len(data):
        (length,) = struct.unpack(">I", data[position:position + 4])
        out.append(data[position + 4:position + 8])
        position += 12 + length
    return out


def png_header(width: int, height: int) -> bytes:
    body = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr = struct.pack(">I", 13) + b"IHDR" + body + struct.pack(">I", zlib.crc32(b"IHDR" + body))
    raw = zlib.compress(b"\x00" * 64)
    idat = struct.pack(">I", len(raw)) + b"IDAT" + raw + struct.pack(">I", zlib.crc32(b"IDAT" + raw))
    iend = struct.pack(">I", 0) + b"IEND" + struct.pack(">I", zlib.crc32(b"IEND"))
    return b"\x89PNG\r\n\x1a\n" + ihdr + idat + iend


def exif_app1(orientation: int, order: str = "II", *, tag_type: int = 3) -> bytes:
    bo = "<" if order == "II" else ">"
    header = (b"II*\x00" if order == "II" else b"MM\x00*") + struct.pack(bo + "I", 8)
    entry = struct.pack(bo + "HHI", 0x0112, tag_type, 1) + struct.pack(bo + "HH", orientation, 0)
    ifd = struct.pack(bo + "H", 1) + entry + struct.pack(bo + "I", 0)
    payload = b"Exif\x00\x00" + header + ifd
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def with_app1(jpeg: bytes, app1: bytes) -> bytes:
    assert jpeg[:2] == b"\xff\xd8"
    return jpeg[:2] + app1 + jpeg[2:]


# Pure rules.


def test_the_transport_rules_of_the_plan():
    assert assets.ALLOWED_TYPES == {
        "logo": ("image/png", "image/jpeg", "image/webp"),
        "music": ("audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"),
    }
    assert assets.MAX_UPLOAD_BYTES == {"logo": 10 << 20, "music": 50 << 20}
    assert assets.MAX_ASSETS_PER_JOB == 50 and assets.MAX_STORE_BYTES == 1 << 30
    assert assets.MAX_NAME_CHARS == 80
    assert assets.DEMUXERS == {"png": "png_pipe", "jpeg": "jpeg_pipe", "webp": "webp_pipe",
                               "mp3": "mp3", "mp4": "mov", "wav": "wav", "ogg": "ogg",
                               "flac": "flac"}
    assert assets.TIME_CAPS_S == {"image": 20.0, "audio": 60.0}
    assert assets.RLIMIT_AS_BYTES == 2 << 30 and assets.FFMPEG_THREADS == 2
    assert (assets.MAX_IMAGE_SIDE, assets.MAX_IMAGE_PIXELS, assets.NORMALISED_MAX_SIDE) == (
        4096, 16_777_216, 1024)
    assert assets.MAX_AUDIO_MS == 15 * 60_000
    assert assets.OPS == ("ingest", "meta")
    for code in assets.ASSET_CODES:
        assert assets.message(code) == assets.message(code).strip() != ""


@pytest.mark.parametrize("head,fmt", [
    (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + bytes(20), "png"),
    (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00", "jpeg"),
    (b"\xff\xd8\xff\xe1\x00\x10Exif\x00\x00", "jpeg"),
    (b"RIFF\x10\x00\x00\x00WEBPVP8 " + bytes(8), "webp"),
    (b"RIFF\x10\x00\x00\x00WEBPVP8L" + bytes(8), "webp"),
    (b"RIFF\x10\x00\x00\x00WEBPVP8X" + bytes(8), "webp"),
    (b"ID3\x04\x00\x00\x00\x00\x00\x00", "mp3"),
    (b"\xff\xfb\x90\x64" + bytes(8), "mp3"),
    (b"\xff\xf3\x48\xc4" + bytes(8), "mp3"),
    (b"\xff\xe3\x18\xc4" + bytes(8), "mp3"),
    (b"\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00", "mp4"),
    (b"\x00\x00\x00\x1cftypisom\x00\x00\x02\x00", "mp4"),
    (b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "mp4"),
    (b"RIFF\x24\x00\x00\x00WAVEfmt ", "wav"),
    (b"OggS\x00\x02" + bytes(20), "ogg"),
    (b"fLaC\x00\x00\x00\x22", "flac"),
])
def test_sniff_recognises_every_allowed_format(head, fmt):
    assert assets.sniff(head) == fmt


@pytest.mark.parametrize("head", [
    b"",
    b"GIF89a\x01\x00\x01\x00",
    b"<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'>",
    b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'>",
    b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic",
    b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1heic",
    b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1",
    b"%PDF-1.7\n",
    b"PK\x03\x04\x14\x00\x00\x00",
    b"OTTO\x00\x0a\x00\x80",
    b"\x00\x01\x00\x00\x00\x0f\x00\x80",
    b"wOFF\x00\x01\x00\x00",
    b"#EXTM3U\n#EXT-X-VERSION:3\n",
    b"ffconcat version 1.0\nfile '/etc/passwd'\n",
    b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01",
    b"<!DOCTYPE html><html><script>alert(1)</script>",
    b"\xff\xf1\x50\x80\x02\x1f\xfc",  # ADTS AAC (layer 0): not MP3
    b"\xff\xfd\x90\x64",  # MPEG layer II
    b"\xff\xfb\xf0\x64",  # bitrate index 15 (bad)
    b"\xff\xfb\x9c\x64",  # sample-rate index 3 (reserved)
    b"\xff\xeb\x90\x64",  # reserved MPEG version
    b"RIFF\x24\x00\x00\x00AVI LIST",
    b"\xff\xd8\xfe",
])
def test_sniff_refuses_everything_else(head):
    assert assets.sniff(head) is None


def test_the_declared_type_must_match_the_kind_and_the_content():
    png_head = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    jpeg_head = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00"
    assert assets.check_declared("logo", "image/png", png_head) == "png"
    for kind, mime, head in [("logo", "image/png", jpeg_head),
                             ("logo", "image/jpeg", png_head),
                             ("logo", "audio/mpeg", b"ID3\x04"),
                             ("music", "image/png", png_head),
                             ("music", "audio/mp4", b"ID3\x04"),
                             ("logo", "image/gif", b"GIF89a"),
                             ("logo", "image/svg+xml", b"<svg"),
                             ("music", "audio/x-mpegurl", b"#EXTM3U")]:
        with pytest.raises(assets.AssetRejected) as caught:
            assets.check_declared(kind, mime, head)
        assert caught.value.code == "asset_type_unsupported"


# The same vectors are in web/tests/asset-upload.test.mjs (normaliseAssetName): one rule.
NAME_VECTORS = [
    (None, None),
    ("", None),
    ("logo.png", "logo.png"),
    ("../../../etc/passwd", "passwd"),
    ("C:\\Users\\ria\\lagu.mp3", "lagu.mp3"),
    ("/", None),
    ("..", None),
    (".", None),
    ("  spasi.png  ", "spasi.png"),
    ("e\u0301.png", "\u00e9.png"),
    ("lagu 🎵.mp3", "lagu 🎵.mp3"),
    ("x" * 80, "x" * 80),
]
NAME_INVALID = ["a\x00b.png", "a\nb.png", "tab\t.png", "\x7f.png", "x" * 81, "\ud800.png", 7]


@pytest.mark.parametrize("raw,expected", NAME_VECTORS)
def test_display_names_are_normalised(raw, expected):
    assert assets.normalise_name(raw) == expected
    if expected is not None:
        assert unicodedata.is_normalized("NFC", expected)


@pytest.mark.parametrize("raw", NAME_INVALID)
def test_invalid_display_names_are_refused(raw):
    with pytest.raises(ValueError):
        assets.normalise_name(raw)


def _jpeg_skeleton() -> bytes:
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, 30, 40, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + sof + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + b"\x00" * 16 + b"\xff\xd9"


@pytest.mark.parametrize("orientation", range(1, 9))
@pytest.mark.parametrize("order", ["II", "MM"])
def test_the_exif_orientation_is_read_from_app1(orientation, order):
    data = with_app1(_jpeg_skeleton(), exif_app1(orientation, order))
    assert assets.jpeg_orientation(data) == orientation
    jfif = b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    assert assets.jpeg_orientation(with_app1(_jpeg_skeleton(), jfif + exif_app1(orientation,
                                                                                  order))) == orientation


@pytest.mark.parametrize("data", [
    _jpeg_skeleton(),
    with_app1(_jpeg_skeleton(), exif_app1(0)),
    with_app1(_jpeg_skeleton(), exif_app1(9)),
    with_app1(_jpeg_skeleton(), exif_app1(6, tag_type=4)),
    with_app1(_jpeg_skeleton(), exif_app1(6)[:20]),
    with_app1(_jpeg_skeleton(), b"\xff\xe1\x00\x0cExif\x00\x00XX*\x00"),
    with_app1(_jpeg_skeleton(), b"\xff\xe1\x00\x12Exif\x00\x00II*\x00\xff\xff\xff\x7f"),
    with_app1(_jpeg_skeleton(), b"\xff\xe1\x00\x14Exif\x00\x00II*\x00\x08\x00\x00\x00\xff\xff"),
    b"\xff\xd8\xff\xda\x00\x02" + exif_app1(6),  # after the scan: not metadata
    b"\xff\xd8",
    b"",
    b"\x89PNG\r\n\x1a\n",
])
def test_a_missing_or_malformed_orientation_reads_as_1(data):
    assert assets.jpeg_orientation(data) == 1


def test_orientation_maps_to_ffmpeg_filters():
    assert [assets.orientation_filters(o) for o in range(1, 9)] == [
        (), ("hflip",), ("hflip", "vflip"), ("vflip",), ("transpose=0",), ("transpose=1",),
        ("transpose=3",), ("transpose=2",)]
    assert [assets.oriented_size(64, 32, o) for o in range(1, 9)] == [(64, 32)] * 4 + [(32, 64)] * 4


@pytest.mark.parametrize("size,expected", [
    ((1024, 1024), (1024, 1024)), ((500, 300), (500, 300)), ((4096, 2048), (1024, 512)),
    ((3000, 2000), (1024, 683)), ((2000, 3000), (683, 1024)), ((10, 4096), (3, 1024)),
    ((1, 4096), (1, 1024)), ((1025, 1), (1024, 1)),
])
def test_the_normalised_size_keeps_the_long_edge_at_most_1024(size, expected):
    assert assets.normalised_size(*size) == expected


SUMMARY = ("[Parsed_ebur128_1 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         {i} LUFS\n"
           "    Threshold: -32.4 LUFS\n\n  Loudness range:\n    LRA:         3.1 LU\n")


def test_the_integrated_loudness_is_read_from_the_last_summary():
    # FFmpeg 5.1 configures the graph twice and prints an empty summary first.
    assert assets.integrated_loudness(SUMMARY.format(i="-70.0") + SUMMARY.format(i="-22.4")) \
        == -2240
    assert assets.integrated_loudness(SUMMARY.format(i="-14.05")) == -1405
    assert assets.integrated_loudness(SUMMARY.format(i="-inf")) == -7000
    assert assets.integrated_loudness(SUMMARY.format(i="-99.0")) == -7000
    assert assets.integrated_loudness(SUMMARY.format(i="3.0")) == 300
    assert assets.integrated_loudness("no summary here") is None
    assert assets.integrated_loudness("Summary:\n  nothing") is None


def test_header_sizes_are_read_without_decoding():
    assert assets.header_size("png", png_header(5000, 12)) == (5000, 12)
    assert assets.header_size("jpeg", _jpeg_skeleton()) == (40, 30)
    vp8x = b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00" + b"\x10\x00\x00\x00" + \
        (4999).to_bytes(3, "little") + (99).to_bytes(3, "little")
    assert assets.header_size("webp", vp8x) == (5000, 100)
    assert assets.header_size("png", b"\x89PNG") is None
    assert assets.header_size("jpeg", b"\xff\xd8\xff\xe0\x00") is None


# Images.


def test_a_png_logo_is_normalised_into_the_store(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "in.png", 300, 200, comment="secret-comment")
    payload = ok(job.ingest(data, "logo", "image/png", name="../logo.png"))
    asset = payload["asset"]
    assert payload["created"] is True
    sha = asset["sha256"]
    assert asset == {"sha256": sha, "kind": "logo", "mime": "image/png", "w": 300, "h": 200,
                     "durationMs": None, "lufsC": None, "name": "logo.png"}
    stored = (job.store / f"{sha}.png").read_bytes()
    assert hashlib.sha256(stored).hexdigest() == sha
    assert set(chunk_kinds(stored)) <= set(png_strip.KEEP_CHUNKS)
    info = png_strip.png_info(stored)
    assert (info.width, info.height, info.bit_depth, info.color_type) == (300, 200, 8, 6)
    assert b"secret-comment" not in stored
    assert decode_rgba(edit_v2_ffmpeg, stored) == decode_rgba(edit_v2_ffmpeg, data)
    meta = json.loads((job.store / f"{sha}.json").read_text())
    assert {k: meta[k] for k in ("kind", "mime", "w", "h")} == {
        "kind": "image", "mime": "image/png", "w": 300, "h": 200}
    clip_dir = job.dir / "analysis" / "clips" / "clip_0123456789abcdef01234567"
    clip_dir.mkdir(parents=True)
    assert store.load_assets(clip_dir, [f"sha256:{sha}"]) == {
        f"sha256:{sha}": {"kind": "image", "mime": "image/png", "w": 300, "h": 200}}
    assert asset_path(job.store, f"sha256:{sha}", "image") == job.store / f"{sha}.png"
    assert job.files() == [f"{sha}.json", f"{sha}.png"]
    for name in job.files():
        assert stat.S_IMODE((job.store / name).stat().st_mode) == 0o600
    for directory in (job.store, job.incoming):
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700


def test_a_large_image_is_scaled_to_1024_on_the_long_edge(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "big.png", 2048, 1536, pix_fmt="rgb24")
    asset = ok(job.ingest(data, "logo", "image/png"))["asset"]
    assert (asset["w"], asset["h"]) == (1024, 768)
    info = png_strip.png_info((job.store / f"{asset['sha256']}.png").read_bytes())
    assert (info.width, info.height, info.color_type, info.bit_depth) == (1024, 768, 6, 8)


@pytest.mark.parametrize("pix_fmt", ["pal8", "rgba64be", "gray", "ya8"])
def test_palette_16_bit_and_grey_pngs_become_8_bit_rgba(job, tmp_path, edit_v2_ffmpeg, pix_fmt):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / f"{pix_fmt}.png", 64, 48, pix_fmt=pix_fmt)
    asset = ok(job.ingest(data, "logo", "image/png"))["asset"]
    info = png_strip.png_info((job.store / f"{asset['sha256']}.png").read_bytes())
    assert (info.width, info.height, info.color_type, info.bit_depth) == (64, 48, 6, 8)


QUADRANTS = {(0, 0): (255, 0, 0), (1, 0): (0, 255, 0), (0, 1): (0, 0, 255), (1, 1): (255, 255, 255)}
DISPLAY = {  # EXIF orientation: displayed pixel (x, y) -> stored pixel, stored size w×h
    1: lambda x, y, w, h: (x, y),
    2: lambda x, y, w, h: (w - 1 - x, y),
    3: lambda x, y, w, h: (w - 1 - x, h - 1 - y),
    4: lambda x, y, w, h: (x, h - 1 - y),
    5: lambda x, y, w, h: (y, x),
    6: lambda x, y, w, h: (y, h - 1 - x),
    7: lambda x, y, w, h: (w - 1 - y, h - 1 - x),
    8: lambda x, y, w, h: (w - 1 - y, x),
}


@pytest.fixture(scope="module")
def quadrant_jpeg(tmp_path_factory, edit_v2_ffmpeg) -> bytes:
    path = tmp_path_factory.mktemp("jpeg") / "quadrants.jpg"
    graph = ("color=c=0xFF0000:s=32x16[tl];color=c=0x00FF00:s=32x16[tr];"
             "color=c=0x0000FF:s=32x16[bl];color=c=0xFFFFFF:s=32x16[br];"
             "[tl][tr]hstack[top];[bl][br]hstack[bottom];[top][bottom]vstack,format=yuvj444p")
    ffmpeg(edit_v2_ffmpeg, "-f", "lavfi", "-i", graph, "-frames:v", "1", "-q:v", "1", str(path))
    return path.read_bytes()


@pytest.mark.parametrize("orientation", range(1, 9))
def test_jpeg_exif_orientation_is_applied(job, quadrant_jpeg, edit_v2_ffmpeg, orientation):
    data = with_app1(quadrant_jpeg, exif_app1(orientation, "MM" if orientation % 2 else "II"))
    asset = ok(job.ingest(data, "logo", "image/jpeg"))["asset"]
    width, height = (64, 32) if orientation <= 4 else (32, 64)
    assert (asset["w"], asset["h"]) == (width, height)
    pixels = decode_rgba(edit_v2_ffmpeg, (job.store / f"{asset['sha256']}.png").read_bytes())
    for qy in (0, 1):
        for qx in (0, 1):
            x, y = width // 4 + qx * width // 2, height // 4 + qy * height // 2
            sx, sy = DISPLAY[orientation](x, y, 64, 32)
            expected = QUADRANTS[(int(sx >= 32), int(sy >= 16))]
            offset = 4 * (y * width + x)
            got = pixels[offset:offset + 3]
            assert all(abs(a - b) <= 24 for a, b in zip(got, expected)), (
                orientation, (qx, qy), tuple(got), expected)
            assert pixels[offset + 3] == 255


def test_a_malformed_exif_block_is_ignored(job, quadrant_jpeg):
    data = with_app1(quadrant_jpeg, b"\xff\xe1\x00\x12Exif\x00\x00II*\x00\xff\xff\xff\x7f")
    asset = ok(job.ingest(data, "logo", "image/jpeg"))["asset"]
    assert (asset["w"], asset["h"]) == (64, 32)


def test_a_webp_logo_is_normalised(job, tmp_path, edit_v2_ffmpeg):
    if "libwebp" not in encoders(edit_v2_ffmpeg):
        pytest.skip("ffmpeg has no WebP encoder")
    path = tmp_path / "logo.webp"
    ffmpeg(edit_v2_ffmpeg, "-f", "lavfi", "-i", "testsrc2=s=120x90,format=yuva420p",
           "-frames:v", "1", "-c:v", "libwebp", str(path))
    asset = ok(job.ingest(path.read_bytes(), "logo", "image/webp"))["asset"]
    assert (asset["w"], asset["h"], asset["mime"]) == (120, 90, "image/png")


def test_image_dimension_caps_are_checked_before_anything_is_spawned(job, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("nothing may be spawned for an oversized header")

    monkeypatch.setattr(assets.subprocess, "Popen", forbidden)
    for width, height in [(4097, 1), (1, 4097), (100_000, 100_000), (4096, 4097)]:
        rejected(job.ingest(png_header(width, height), "logo", "image/png"), "asset_rejected",
                 "dimensions")
    # A zero side is a malformed file, not a large one (the panel says "too large" only for
    # "dimensions").
    rejected(job.ingest(png_header(0, 10), "logo", "image/png"), "asset_rejected", "probe")


def test_a_truncated_image_is_unreadable_not_too_large(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "cut.png", 200, 150)
    code, payload = job.ingest(data[: len(data) // 2], "logo", "image/png")
    assert code in (0, 3), payload
    if code == 3:
        assert payload["error"]["ref"] != "dimensions", payload


def test_an_image_over_the_side_cap_is_rejected_after_probe(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "wide.png", 4100, 2, pix_fmt="rgb24")
    rejected(job.ingest(data, "logo", "image/png"), "asset_rejected", "dimensions")


# Music.


def _music(job: Job, data: bytes, mime: str = "audio/wav", **kwargs) -> dict:
    return ok(job.ingest(data, "music", mime, **kwargs))["asset"]


def _decoded_samples(path: Path) -> int:
    pcm = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "mov", "-i", str(path),
                          "-f", "s16le", "-ac", "2", "-ar", "48000", "pipe:1"],
                         capture_output=True, check=True).stdout
    return len(pcm) // 4


def test_a_wav_track_is_normalised_to_aac_lc_48k_stereo(job, tmp_path, edit_v2_ffmpeg):
    data = wav_bytes(tmp_path / "tone.wav", seconds=3.0, channels=1, amplitude=0.1)
    asset = _music(job, data, name="Lagu Saya.wav")
    sha = asset["sha256"]
    assert asset["kind"] == "music" and asset["mime"] == "audio/mp4"
    assert asset["w"] is None and asset["h"] is None and asset["name"] == "Lagu Saya.wav"
    stored = job.store / f"{sha}.m4a"
    assert hashlib.sha256(stored.read_bytes()).hexdigest() == sha
    info = probe(stored)
    streams = info["streams"]
    assert len(streams) == 1
    audio = streams[0]
    assert (audio["codec_name"], audio["profile"], audio["sample_rate"], audio["channels"]) == (
        "aac", "LC", "48000", 2)
    samples = _decoded_samples(stored)
    assert asset["durationMs"] == samples // 48
    assert 2990 <= asset["durationMs"] <= 3060
    assert isinstance(asset["lufsC"], int) and -2600 < asset["lufsC"] < -1400
    meta = json.loads((job.store / f"{sha}.json").read_text())
    assert (meta["kind"], meta["mime"], meta["duration_ms"], meta["lufs_c"]) == (
        "audio", "audio/mp4", asset["durationMs"], asset["lufsC"])
    peaks = (job.store / f"{sha}.peaks.bin").read_bytes()
    assert len(peaks) == 2 * -(-asset["durationMs"] * assets.PEAKS_PER_SEC // 1000)
    levels = [max(peaks[i + 1] if peaks[i + 1] < 128 else peaks[i + 1] - 256, 0)
              for i in range(0, len(peaks), 2)]
    assert max(levels) >= 10  # a 0.1-amplitude tone reaches ±13/128 in the 8-bit bins
    clip_dir = job.dir / "analysis" / "clips" / "clip_0123456789abcdef01234567"
    clip_dir.mkdir(parents=True)
    assert store.load_assets(clip_dir, [f"sha256:{sha}"]) == {f"sha256:{sha}": {
        "kind": "audio", "mime": "audio/mp4", "duration_ms": asset["durationMs"],
        "lufs_c": asset["lufsC"]}}
    assert asset_path(job.store, f"sha256:{sha}", "audio") == stored
    assert job.files() == [f"{sha}.json", f"{sha}.m4a", f"{sha}.peaks.bin"]


def test_mono_is_panned_to_both_channels_at_full_gain(job, tmp_path, edit_v2_ffmpeg):
    data = wav_bytes(tmp_path / "mono.wav", seconds=2.0, channels=1, amplitude=0.25)
    sha = _music(job, data)["sha256"]
    pcm = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i",
                          str(job.store / f"{sha}.m4a"), "-f", "s16le", "pipe:1"],
                         capture_output=True, check=True).stdout
    left = [struct.unpack_from("<h", pcm, i)[0] for i in range(48000 * 4, 48000 * 4 + 4000, 4)]
    right = [struct.unpack_from("<h", pcm, i + 2)[0] for i in range(48000 * 4, 48000 * 4 + 4000, 4)]
    assert max(left) > 0.22 * 32767 and max(right) > 0.22 * 32767  # no −3 dB implicit upmix


@pytest.mark.parametrize("fmt,mime,codec", [
    ("mp3", "audio/mpeg", ["-c:a", "libmp3lame", "-b:a", "128k"]),
    ("flac", "audio/flac", ["-c:a", "flac"]),
    ("ogg", "audio/ogg", ["-c:a", "libvorbis"]),
    ("opus.ogg", "audio/ogg", ["-c:a", "libopus"]),
    ("m4a", "audio/mp4", ["-c:a", "aac", "-b:a", "128k"]),
])
def test_every_music_format_is_normalised(job, tmp_path, edit_v2_ffmpeg, fmt, mime, codec):
    encoder = {"libmp3lame": "libmp3lame", "libvorbis": "libvorbis", "libopus": "libopus"}.get(
        codec[1])
    if encoder and encoder not in encoders(edit_v2_ffmpeg):
        pytest.skip(f"ffmpeg has no {encoder}")
    source = tmp_path / "tone.wav"
    wav_bytes(source, seconds=2.0, channels=2, rate=44100)
    target = tmp_path / f"tone.{fmt}"
    ffmpeg(edit_v2_ffmpeg, "-i", str(source), *codec, str(target))
    asset = _music(job, target.read_bytes(), mime)
    assert 1900 <= asset["durationMs"] <= 2200
    assert probe(job.store / f"{asset['sha256']}.m4a")["streams"][0]["codec_name"] == "aac"


def test_cover_art_is_dropped(job, tmp_path, edit_v2_ffmpeg):
    if "libmp3lame" not in encoders(edit_v2_ffmpeg):
        pytest.skip("ffmpeg has no libmp3lame")
    wav_bytes(tmp_path / "tone.wav", seconds=2.0)
    cover = tmp_path / "cover.png"
    png_bytes(edit_v2_ffmpeg, cover, 64, 64, pix_fmt="rgb24")
    target = tmp_path / "with-cover.mp3"
    ffmpeg(edit_v2_ffmpeg, "-i", str(tmp_path / "tone.wav"), "-i", str(cover), "-map", "0:a",
           "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "png", "-disposition:v", "attached_pic",
           "-id3v2_version", "3", str(target))
    streams = probe(target)["streams"]
    assert any(s["codec_type"] == "video" for s in streams)
    asset = _music(job, target.read_bytes(), "audio/mpeg")
    stored = probe(job.store / f"{asset['sha256']}.m4a")["streams"]
    assert [s["codec_type"] for s in stored] == ["audio"]


def test_a_video_stream_is_rejected(job, tmp_path, edit_v2_ffmpeg):
    target = tmp_path / "video.mp4"
    ffmpeg(edit_v2_ffmpeg, "-f", "lavfi", "-i", "testsrc2=s=64x64:d=2", "-f", "lavfi", "-i",
           "sine=d=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(target))
    rejected(job.ingest(target.read_bytes(), "music", "audio/mp4"), "asset_rejected", "streams")


def test_two_audio_streams_are_rejected(job, tmp_path, edit_v2_ffmpeg):
    target = tmp_path / "two.m4a"
    ffmpeg(edit_v2_ffmpeg, "-f", "lavfi", "-i", "sine=d=2", "-f", "lavfi", "-i",
           "sine=d=2:f=880", "-map", "0:a", "-map", "1:a", "-c:a", "aac", str(target))
    rejected(job.ingest(target.read_bytes(), "music", "audio/mp4"), "asset_rejected", "streams")


def test_more_than_two_channels_are_rejected(job, tmp_path):
    data = wav_bytes(tmp_path / "six.wav", seconds=1.0, channels=6, rate=8000)
    rejected(job.ingest(data, "music", "audio/wav"), "asset_rejected", "channels")


def test_a_track_longer_than_the_cap_is_rejected(job, tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "MAX_AUDIO_MS", 2000)
    data = wav_bytes(tmp_path / "long.wav", seconds=3.0, rate=8000)
    rejected(job.ingest(data, "music", "audio/wav"), "asset_rejected", "duration")


def test_a_track_whose_header_lies_about_its_length_is_stopped_at_the_cap(
        job, tmp_path, monkeypatch):
    # The decode is capped whatever the probe says: a WAV whose header claims 1 s but carries
    # 3 s of samples (data size field patched) is cut and refused, never ingested at full length.
    monkeypatch.setattr(assets, "MAX_AUDIO_MS", 2000)
    data = bytearray(wav_bytes(tmp_path / "lying.wav", seconds=3.0, rate=8000))
    at = data.index(b"data")
    struct.pack_into("<I", data, at + 4, 8000 * 2)  # one second of mono s16
    code, payload = job.ingest(bytes(data), "music", "audio/wav")
    assert code in (0, 3), payload
    if code == 0:
        assert payload["asset"]["durationMs"] <= 2000


def test_a_near_empty_track_is_rejected(job, tmp_path):
    data = wav_bytes(tmp_path / "tiny.wav", seconds=0.02, rate=8000)
    rejected(job.ingest(data, "music", "audio/wav"), "asset_rejected")


# Identity, idempotency, quota.


def test_identical_content_is_stored_once(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 40, 40)
    first = ok(job.ingest(data, "logo", "image/png", name="satu.png"))
    second = ok(job.ingest(data, "logo", "image/png", name="dua.png"))
    assert first["asset"]["sha256"] == second["asset"]["sha256"]
    assert (first["created"], second["created"]) == (True, False)
    assert second["asset"]["name"] == "satu.png"  # the first display name is kept
    assert len(job.files()) == 2


def test_the_normalised_bytes_are_deterministic(job, tmp_path, edit_v2_ffmpeg):
    data = wav_bytes(tmp_path / "det.wav", seconds=1.5, channels=2)
    first = _music(job, data)
    (job.store / f"{first['sha256']}.json").unlink()
    (job.store / f"{first['sha256']}.m4a").unlink()
    (job.store / f"{first['sha256']}.peaks.bin").unlink()
    assert _music(job, data)["sha256"] == first["sha256"]


def test_an_idempotency_key_replays_and_conflicts(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    key = str(uuid.uuid4())
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 32, 32)
    other = png_bytes(edit_v2_ffmpeg, tmp_path / "b.png", 34, 34)  # testsrc2 rounds odd sizes down
    first = ok(job.ingest(data, "logo", "image/png", key=key))

    def forbidden(*_args, **_kwargs):
        raise AssertionError("a replay never runs FFmpeg again")

    with monkeypatch.context() as patch:
        patch.setattr(assets.subprocess, "Popen", forbidden)
        replay = ok(job.ingest(data, "logo", "image/png", key=key))
    assert replay["asset"] == first["asset"] and replay["created"] is False
    code, payload = job.ingest(other, "logo", "image/png", key=key)
    assert code == 9 and payload["error"]["code"] == "idempotency_conflict"
    receipts = list((job.store / ".receipts").iterdir())
    assert len(receipts) == 1
    receipt = json.loads(receipts[0].read_text())
    assert set(receipt) == {"key", "raw_sha256", "sha256", "at_ms"}
    assert receipt["raw_sha256"] == hashlib.sha256(data).hexdigest()


def test_receipts_are_pruned(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    monkeypatch.setattr(assets, "RECEIPTS_KEEP", 3)
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 32, 32)
    for _ in range(6):
        ok(job.ingest(data, "logo", "image/png"))
    assert len(list((job.store / ".receipts").iterdir())) == 3


def test_the_per_job_asset_count_is_capped(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    monkeypatch.setattr(assets, "MAX_ASSETS_PER_JOB", 2)
    images = [png_bytes(edit_v2_ffmpeg, tmp_path / f"{n}.png", 20 + 2 * n, 20) for n in range(3)]
    ok(job.ingest(images[0], "logo", "image/png"))
    ok(job.ingest(images[1], "logo", "image/png"))
    rejected(job.ingest(images[2], "logo", "image/png"), "asset_quota_exceeded")
    assert ok(job.ingest(images[0], "logo", "image/png"))["created"] is False  # dedupe: allowed
    assert len(job.files()) == 4


def test_the_per_job_bytes_are_capped(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    first = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 64, 64)
    ok(job.ingest(first, "logo", "image/png"))
    used = sum((job.store / name).stat().st_size for name in job.files())
    monkeypatch.setattr(assets, "MAX_STORE_BYTES", used + 10)
    second = png_bytes(edit_v2_ffmpeg, tmp_path / "b.png", 66, 64)
    rejected(job.ingest(second, "logo", "image/png"), "asset_quota_exceeded")


def test_the_upload_size_cap_is_rechecked(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 32, 32)
    monkeypatch.setitem(assets.MAX_UPLOAD_BYTES, "logo", len(data) - 1)
    rejected(job.ingest(data, "logo", "image/png"), "asset_too_large")
    rejected(job.ingest(b"", "music", "audio/wav"), "asset_rejected", "empty")


def test_a_type_mismatch_is_rejected_by_the_ingest_too(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 32, 32)
    rejected(job.ingest(data, "logo", "image/jpeg"), "asset_type_unsupported")
    rejected(job.ingest(b"GIF89a" + bytes(64), "logo", "image/png"), "asset_type_unsupported")
    rejected(job.ingest(data, "music", "audio/mpeg"), "asset_type_unsupported")


# Filesystem safety.


def _envelope(job: Job, incoming_id: str, **extra) -> bytes:
    value = {"op": "ingest", "jobId": job.id, "incomingId": incoming_id, "kind": "logo",
             "mime": "image/png", "name": None, "idempotencyKey": str(uuid.uuid4()), **extra}
    return json.dumps(value).encode()


def test_a_symlinked_quarantine_file_is_refused(job, tmp_path, edit_v2_ffmpeg):
    target = tmp_path / "secret.png"
    data = png_bytes(edit_v2_ffmpeg, target, 16, 16)
    job.incoming.mkdir(parents=True, mode=0o700)
    incoming_id = str(uuid.uuid4())
    (job.incoming / incoming_id).symlink_to(target)
    code, payload = assets.handle(_envelope(job, incoming_id), jobs_root=job.root)
    assert code == 4 and payload["error"]["code"] == "not_found"
    assert target.read_bytes() == data and job.files() == []


@pytest.mark.parametrize("link", ["incoming", "store", "analysis"])
def test_symlinked_directories_are_refused(job, tmp_path, link):
    # The link points at a tree where the quarantined file really exists: only the symlink
    # check can refuse it.
    elsewhere = tmp_path / "elsewhere"
    below = {"incoming": [], "store": [".incoming"], "analysis": ["assets", ".incoming"]}[link]
    target_dir = elsewhere.joinpath(*below)
    target_dir.mkdir(parents=True)
    incoming_id = str(uuid.uuid4())
    (target_dir / incoming_id).write_bytes(png_header(8, 8))
    if link == "incoming":
        job.store.mkdir(parents=True)
        job.incoming.symlink_to(elsewhere)
    elif link == "store":
        job.store.symlink_to(elsewhere)
    else:
        shutil.rmtree(job.dir / "analysis")
        (job.dir / "analysis").symlink_to(elsewhere)
    code, payload = assets.handle(_envelope(job, incoming_id), jobs_root=job.root)
    assert code == 4 and payload["error"]["code"] == "not_found"
    assert (target_dir / incoming_id).read_bytes() == png_header(8, 8)


def test_a_missing_job_or_quarantine_file_is_not_found(job):
    code, _payload = assets.handle(_envelope(job, str(uuid.uuid4())), jobs_root=job.root)
    assert code == 4
    other = Job(job.root.parent / "other", "11111111-2222-4333-8444-555555555555")
    shutil.rmtree(other.dir)
    code, _ = assets.handle(_envelope(other, str(uuid.uuid4())), jobs_root=other.root)
    assert code == 4


def test_stale_quarantine_files_are_pruned(job, tmp_path, edit_v2_ffmpeg):
    old = job.quarantine(b"left over by a crashed upload")
    fresh = job.quarantine(b"an upload in progress")
    past = time.time() - 2 * 3600
    os.utime(job.incoming / old, (past, past))
    ok(job.ingest(png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 16, 16), "logo", "image/png"))
    assert not (job.incoming / old).exists() and (job.incoming / fresh).exists()


# The FFmpeg invocation and the child environment.


class Recorder:
    def __init__(self, real):
        self.real = real
        self.calls: list[dict] = []

    def __call__(self, argv, **kwargs):
        self.calls.append({"argv": list(argv), **kwargs})
        return self.real(argv, **kwargs)


def test_every_child_is_hardened(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    image = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 16, 16)
    wav = wav_bytes(tmp_path / "a.wav", seconds=1.0)
    m4a = tmp_path / "a.m4a"
    ffmpeg(edit_v2_ffmpeg, "-f", "lavfi", "-i", "sine=d=1", "-c:a", "aac", str(m4a))
    recorder = Recorder(subprocess.Popen)
    monkeypatch.setattr(assets.subprocess, "Popen", recorder)  # only the ingests run below
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    ok(job.ingest(image, "logo", "image/png"))
    ok(job.ingest(wav, "music", "audio/wav"))
    ok(job.ingest(m4a.read_bytes(), "music", "audio/mp4"))
    monkeypatch.undo()
    assert len(recorder.calls) >= 6
    for call in recorder.calls:
        argv = call["argv"]
        assert Path(argv[0]).name == "prlimit"
        assert f"--as={2 << 30}:{2 << 30}" in argv
        assert any(a.startswith("--cpu=") for a in argv)
        tool = argv[argv.index("--") + 1]
        assert Path(tool).name in ("ffmpeg", "ffprobe")
        assert set(call["env"]) <= FFMPEG_ENV
        assert not any(value in json.dumps(call["env"]) for value in SECRETS.values())
        assert call.get("shell") in (None, False)
        assert call.get("start_new_session") is True
        joined = " ".join(argv)
        assert str(job.root) not in joined, "the job path never reaches FFmpeg"
        assert "-protocol_whitelist" in argv and argv[argv.index("-protocol_whitelist") + 1] == \
            "file,pipe"
        inputs = [argv[i + 1] for i, a in enumerate(argv) if a == "-i"]
        assert inputs, argv
        for path in inputs:
            if path.startswith("/proc/self/fd/"):
                assert int(path.rsplit("/", 1)[1]) in call["pass_fds"]
        forced = argv[argv.index("-f") + 1]
        assert forced in set(assets.DEMUXERS.values())
        if forced == "mov":
            assert argv[argv.index("-enable_drefs") + 1] == "0"
        if Path(tool).name == "ffmpeg":
            assert argv[argv.index("-threads") + 1] == "2"


def _wrapper(directory: Path, tool: str, log: Path, *, sleep_s: float = 0.0) -> None:
    real = shutil.which(tool)
    assert real is not None
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / tool
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        f"with open({str(log)!r}, 'a') as h:\n"
        "    env = dict(p.split('=', 1) for p in open('/proc/self/environ').read().split('\\0') if p)\n"
        f"    h.write(json.dumps({{'tool': {tool!r}, 'pid': os.getpid(), 'env': env}}) + '\\n')\n"
        f"time.sleep({sleep_s})\n"
        f"os.execv({real!r}, [{real!r}] + sys.argv[1:])\n")
    script.chmod(0o755)


def test_the_ingest_children_carry_no_secret(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    log = tmp_path / "environ.jsonl"
    wrappers = tmp_path / "bin"
    for tool in ("ffmpeg", "ffprobe"):
        _wrapper(wrappers, tool, log)
    monkeypatch.setenv("PATH", f"{wrappers}{os.pathsep}{os.environ['PATH']}")
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    ok(job.ingest(png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 16, 16), "logo", "image/png"))
    ok(job.ingest(wav_bytes(tmp_path / "a.wav", seconds=1.0), "music", "audio/wav"))
    records = [json.loads(line) for line in log.read_text().splitlines()]
    assert {r["tool"] for r in records} == {"ffmpeg", "ffprobe"}
    assert len(records) >= 4
    for record in records:
        assert set(record["env"]) <= FFMPEG_ENV, record["env"].keys()
        text = json.dumps(record["env"])
        assert not any(value in text for value in SECRETS.values())


def test_a_hung_child_is_killed_at_the_time_cap(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    log = tmp_path / "environ.jsonl"
    wrappers = tmp_path / "bin"
    _wrapper(wrappers, "ffprobe", log, sleep_s=30.0)
    monkeypatch.setenv("PATH", f"{wrappers}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setitem(assets.TIME_CAPS_S, "image", 1.0)
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 16, 16)
    started = time.monotonic()
    rejected(job.ingest(data, "logo", "image/png"), "asset_rejected", "timeout")
    assert time.monotonic() - started < 5.0
    pid = json.loads(log.read_text().splitlines()[0])["pid"]
    time.sleep(0.2)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_the_ingest_refuses_to_run_as_root(job, tmp_path, edit_v2_ffmpeg, monkeypatch):
    monkeypatch.setattr(assets.os, "geteuid", lambda: 0)
    code, payload = job.ingest(png_header(8, 8), "logo", "image/png")
    assert code == 1 and payload["error"]["code"] == "internal_error"


# CLI.


@pytest.mark.parametrize("change", [
    {"op": "delete"},
    {"extra": 1},
    {"jobId": "../../etc"},
    {"incomingId": "not-a-uuid"},
    {"idempotencyKey": "x"},
    {"kind": "video"},
    {"mime": "image/gif"},
    {"mime": 3},
    {"name": "a\x00b"},
    {"name": "x" * 81},
    {"name": 5},
])
def test_a_malformed_envelope_is_a_usage_error(job, change):
    value = {"op": "ingest", "jobId": job.id, "incomingId": str(uuid.uuid4()), "kind": "logo",
             "mime": "image/png", "name": None, "idempotencyKey": str(uuid.uuid4()), **change}
    code, payload = assets.handle(json.dumps(value).encode(), jobs_root=job.root)
    assert code == 2 and payload["error"]["code"] == "internal_error"


def test_the_envelope_rejects_duplicate_keys_and_garbage(job):
    raw = (b'{"op":"meta","jobId":"%s","sha256":"%s","sha256":"%s"}'
           % (job.id.encode(), b"a" * 64, b"b" * 64))
    assert assets.handle(raw, jobs_root=job.root)[0] == 2
    assert assets.handle(b"\xff\xfe", jobs_root=job.root)[0] == 2
    assert assets.handle(b"[]", jobs_root=job.root)[0] == 2
    assert assets.handle(b'{"op":"meta","jobId":"%s","sha256":"%s"}' % (
        job.id.encode(), b"a" * 64), jobs_root=None)[0] == 1


def test_meta_returns_the_stored_asset(job, tmp_path, edit_v2_ffmpeg):
    data = png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 50, 40)
    asset = ok(job.ingest(data, "logo", "image/png", name="Logo Toko.png"))["asset"]
    raw = json.dumps({"op": "meta", "jobId": job.id, "sha256": asset["sha256"]}).encode()
    code, payload = assets.handle(raw, jobs_root=job.root)
    assert code == 0 and payload == {"asset": asset}
    missing = json.dumps({"op": "meta", "jobId": job.id, "sha256": "c" * 64}).encode()
    assert assets.handle(missing, jobs_root=job.root)[0] == 4
    bad = json.dumps({"op": "meta", "jobId": job.id, "sha256": "sha256:" + "c" * 64}).encode()
    assert assets.handle(bad, jobs_root=job.root)[0] == 2


def test_the_module_runs_as_a_cli(job, tmp_path, edit_v2_ffmpeg):
    incoming_id = job.quarantine(png_bytes(edit_v2_ffmpeg, tmp_path / "a.png", 24, 24))
    envelope = _envelope(job, incoming_id)
    env = {"PATH": os.environ["PATH"], "JOBS_ROOT": str(job.root),
           "PYTHONPATH": str(ROOT / "src"), **SECRETS}
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.assets"], input=envelope,
                            capture_output=True, env=env, check=False, timeout=60)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["asset"]["w"] == 24 and payload["created"] is True
    usage = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.assets", "extra"],
                           input=b"", capture_output=True, env=env, check=False, timeout=60)
    assert usage.returncode == 2


def test_the_module_uses_the_standard_library_only():
    tree = ast.parse(Path(assets.__file__).read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            imported.add((node.module or "").split(".")[0])
    allowed = set(sys.stdlib_module_names) | {"__future__"}
    assert imported <= allowed, imported - allowed
