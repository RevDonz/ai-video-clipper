#!/usr/bin/env python3
"""Caption-pack thumbnails for the editor's text panel (plan §11.2 T2.7, §5.4 packs).

One small PNG per pack, rendered from the pack files by the production pipeline: the sample
words go through ``captions_ass.fit_cues`` + ``build_ass_v2`` with the pack's default overrides
(exactly what an export would burn for them), and FFmpeg's ``ass`` filter draws the ASS over a
flat plate with the locked-down fonts (``resources/fontconfig/fonts.conf``, R6). The frame is
taken between the two word onsets so Karaoke shows its sweep and Bold its active word. A band
around the caption is cropped and halved: 320×80 px, shown at 160×40 CSS px (sharp on 2× screens).

Run it in the toolchain image, which pins FFmpeg 5.1.9 and libass 0.17.1::

    docker run --rm --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/src \\
      ai-video-clipper:editor-w1z /app/.venv/bin/python scripts/editor/make_pack_thumbs.py

It writes ``web/components/editor/panels/pack-thumbs/<pack>.png`` (only the critical PNG chunks,
each under 30 KB, the one committed-media exception of the plan) and ``manifest.json``, which
pins the pack files the thumbnails were rendered from (``tests/test_editor_pack_thumbs.py``
fails when a pack changes without new thumbnails). ``--check`` re-renders into a temporary
directory and compares bytes (meaningful on the pinned toolchain only). Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from ai_clipper import captions_ass  # noqa: E402
from ai_clipper.edit_v2 import PACK_DEFAULT_OVERRIDES, PACK_IDS  # noqa: E402
from ai_clipper.edit_v2.timemap import Fps  # noqa: E402
from ai_clipper.subtitles import FrameCue, FrameWord  # noqa: E402

SCHEMA = "potongin.pack-thumbs/1"
PACKS = PACK_IDS
RESOURCES = ROOT / "resources"
DEFAULT_OUT = ROOT / "web" / "components" / "editor" / "panels" / "pack-thumbs"

PLAY_RES = (720, 1280)
FPS = Fps(30, 1)
TOTAL_FRAMES = 60
SAMPLE_WORDS = (("Halo", 0), ("semua", 30))  # (text, onset frame)
SHOW_FRAME = 10  # after the first onset, before the second
BACKGROUND = "#4B5563"
# The caption block's bottom sits at y_e5 = 83% (1062 px); the band holds one line of every pack
# (the Box pack's padding included), centred.
CROP = (80, 950, 560, 140)  # x, y, w, h at 720×1280
THUMB_SIZE = (320, 80)
MAX_BYTES = 30 * 1024
THREADS = 4
CRITICAL_CHUNKS = (b"IHDR", b"PLTE", b"IDAT", b"IEND")


def thumb_ass(pack_id: str) -> str:
    """The production ASS of the sample words in ``pack_id`` at its default overrides."""
    pack = captions_ass.load_pack(pack_id, 1)
    overrides = dict(PACK_DEFAULT_OVERRIDES[pack_id])
    onsets = [onset for _text, onset in SAMPLE_WORDS] + [TOTAL_FRAMES]
    words = tuple(
        FrameWord(f"w{index:06d}", onsets[index], onsets[index + 1], text, False)
        for index, (text, _onset) in enumerate(SAMPLE_WORDS)
    )
    cues = captions_ass.fit_cues((FrameCue(0, TOTAL_FRAMES, "seg_b1", words),), pack=pack,
                                 play_res=PLAY_RES, overrides=overrides)
    return captions_ass.build_ass_v2(cues, play_res=PLAY_RES, fps=FPS, total_frames=TOTAL_FRAMES,
                                     pack=pack, overrides=overrides, hook=None)


def ffmpeg_argv(ffmpeg: str, out_png: Path) -> list[str]:
    """FFmpeg command run in a directory holding ``captions.ass`` and ``fonts/``."""
    width, height = PLAY_RES
    x, y, w, h = CROP
    colour = "0x" + BACKGROUND.lstrip("#")
    graph = (
        f"settb=1/{FPS.num},setpts=N,"
        "format=gbrp,ass=filename=captions.ass:fontsdir=fonts:shaping=complex,"
        f"select=eq(n\\,{SHOW_FRAME}),crop={w}:{h}:{x}:{y},"
        f"scale={THUMB_SIZE[0]}:{THUMB_SIZE[1]}:flags=lanczos+accurate_rnd+full_chroma_int,format=rgb24"
    )
    return [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-threads", str(THREADS), "-filter_threads", "1",
        "-f", "lavfi", "-i", f"color=c={colour}:s={width}x{height}:r={FPS.num}:d=1",
        "-vf", graph, "-frames:v", "1", "-fps_mode", "passthrough",
        "-map_metadata", "-1", "-flags", "+bitexact", "-fflags", "+bitexact",
        "-f", "image2", "-c:v", "png", "-pred", "mixed", "-compression_level", "9", str(out_png),
    ]


def ffmpeg_env(resources: Path = RESOURCES) -> dict[str, str]:
    """A minimal child environment: PATH/LANG plus the fontconfig lockdown (no secrets)."""
    env = {key: os.environ[key] for key in ("PATH", "LANG", "TZ") if key in os.environ}
    env["FONTCONFIG_FILE"] = str(resources / "fontconfig" / "fonts.conf")
    return env


def strip_png(raw: bytes) -> bytes:
    """Keep only IHDR, PLTE, IDAT and IEND (no text, time or colour-profile chunks)."""
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    out = [raw[:8]]
    offset = 8
    while offset < len(raw):
        (length,) = struct.unpack(">I", raw[offset:offset + 4])
        name = raw[offset + 4:offset + 8]
        end = offset + 12 + length
        if name in CRITICAL_CHUNKS:
            out.append(raw[offset:end])
        offset = end
    return b"".join(out)


def _chunk_ok(raw: bytes) -> bool:
    offset = 8
    while offset < len(raw):
        (length,) = struct.unpack(">I", raw[offset:offset + 4])
        name = raw[offset + 4:offset + 8]
        body = raw[offset + 8:offset + 8 + length]
        (crc,) = struct.unpack(">I", raw[offset + 8 + length:offset + 12 + length])
        if zlib.crc32(name + body) & 0xFFFFFFFF != crc:
            return False
        offset += 12 + length
    return True


def render_thumb(pack_id: str, *, ffmpeg: str = "ffmpeg", resources: Path = RESOURCES) -> bytes:
    """The stripped PNG bytes of one pack's thumbnail."""
    with tempfile.TemporaryDirectory(prefix="pack-thumb-") as scratch:
        work = Path(scratch)
        (work / "captions.ass").write_text(thumb_ass(pack_id), encoding="utf-8")
        (work / "fonts").symlink_to(resources / "fonts", target_is_directory=True)
        out = work / "thumb.png"
        result = subprocess.run(ffmpeg_argv(ffmpeg, out), cwd=work, env=ffmpeg_env(resources),
                                capture_output=True, text=True, timeout=120, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed for {pack_id}: {result.stderr[-2000:]}")
        raw = strip_png(out.read_bytes())
    if not _chunk_ok(raw):
        raise RuntimeError(f"corrupt PNG for {pack_id}")
    return raw


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def toolchain(ffmpeg: str) -> dict[str, str]:
    version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True,
                             check=False).stdout.split()
    info = {"ffmpeg": version[2] if len(version) > 2 else "unknown"}
    dpkg = shutil.which("dpkg-query")
    if dpkg:
        result = subprocess.run([dpkg, "-W", "-f=${Version}", "libass9"], capture_output=True,
                                text=True, check=False)
        if result.returncode == 0:
            info["libass9"] = result.stdout.strip()
    return info


def build_manifest(rendered: dict[str, bytes], tool: dict[str, str]) -> dict:
    return {
        "schema": SCHEMA,
        "size": list(THUMB_SIZE),
        "sample": " ".join(text for text, _onset in SAMPLE_WORDS),
        "frame": SHOW_FRAME,
        "background": BACKGROUND,
        "crop": list(CROP),
        "toolchain": tool,
        "packs": {
            pack: {
                "file": f"{pack}.png",
                "pack_sha256": _sha256((RESOURCES / "caption-packs" / pack / "v1.json").read_bytes()),
                "png_sha256": _sha256(raw),
                "bytes": len(raw),
            }
            for pack, raw in rendered.items()
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    parser.add_argument("--check", action="store_true",
                        help="re-render and compare with the files in --out; write nothing")
    args = parser.parse_args(argv)

    rendered = {pack: render_thumb(pack, ffmpeg=args.ffmpeg) for pack in PACKS}
    too_big = {pack: len(raw) for pack, raw in rendered.items() if len(raw) >= MAX_BYTES}
    if too_big:
        print(f"thumbnails over {MAX_BYTES} bytes: {too_big}", file=sys.stderr)
        return 1
    if args.check:
        different = [pack for pack, raw in rendered.items()
                     if not (args.out / f"{pack}.png").is_file()
                     or (args.out / f"{pack}.png").read_bytes() != raw]
        print(json.dumps({"identical": not different, "different": different}))
        return 1 if different else 0
    args.out.mkdir(parents=True, exist_ok=True)
    for pack, raw in rendered.items():
        (args.out / f"{pack}.png").write_bytes(raw)
    manifest = build_manifest(rendered, toolchain(args.ffmpeg))
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                                            encoding="utf-8")
    print(json.dumps({pack: len(raw) for pack, raw in rendered.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
