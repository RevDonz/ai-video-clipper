#!/usr/bin/env python3
"""Hook-design thumbnails for the editor's Hook card and Teks panel (CONTRACTS §5.31).

One small PNG per hook design, rendered from the design files by the production pipeline: the
sample hook goes through ``captions_ass.build_ass_v2`` (exactly what an export would burn) and
FFmpeg's ``ass`` filter draws it over the flat plate of the caption-pack thumbnails with the
locked-down fonts (``resources/fontconfig/fonts.conf``, R6). The band holding the hook is
cropped and scaled: 320×80 px, shown at 160×40 CSS px like the pack tiles.

Run it in the toolchain image, which pins FFmpeg 5.1.9 and libass 0.17.1::

    docker run --rm --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/src \\
      ai-video-clipper:editor-w1z /app/.venv/bin/python scripts/editor/make_hook_thumbs.py

It writes ``web/components/editor/panels/hook-thumbs/<design>.png`` (only the critical PNG
chunks, each under 30 KB) and ``manifest.json``, which pins the design files the thumbnails were
rendered from (``tests/test_editor_hook_thumbs.py`` fails when a design changes without new
thumbnails). ``--check`` re-renders into memory and compares bytes (meaningful on the pinned
toolchain only). Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for path in (ROOT / "src", Path(__file__).resolve().parent):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import make_pack_thumbs as packs

from ai_clipper import captions_ass
from ai_clipper.edit_v2 import HOOK_DESIGN_IDS, PACK_DEFAULT_OVERRIDES
from ai_clipper.edit_v2.timemap import Fps

SCHEMA = "potongin.hook-thumbs/1"
DESIGNS = HOOK_DESIGN_IDS
RESOURCES = ROOT / "resources"
DEFAULT_OUT = ROOT / "web" / "components" / "editor" / "panels" / "hook-thumbs"

PLAY_RES = (720, 1280)
FPS = Fps(30, 1)
TOTAL_FRAMES = 60
SHOW_FRAME = 30  # after the 150 ms fade in, before the 250 ms fade out
# A kicker closed by a colon, a word in capitals for Kotak kata, short enough for two lines.
SAMPLE = "Ternyata: dia DITAHAN"
Y_E5 = 13000  # the seeds' hook position
BACKGROUND = packs.BACKGROUND
# The band from just above the hook's top (y_e5 13% = 166 px) holds two lines of every design.
CROP = (0, 160, 720, 180)  # x, y, w, h at 720×1280
THUMB_SIZE = (320, 80)
MAX_BYTES = packs.MAX_BYTES
THREADS = 4


def thumb_ass(design_id: str) -> str:
    """The production ASS of the sample hook in ``design_id`` over a clip without captions."""
    return captions_ass.build_ass_v2(
        (), play_res=PLAY_RES, fps=FPS, total_frames=TOTAL_FRAMES,
        pack=captions_ass.load_pack("classic", 1),
        overrides=dict(PACK_DEFAULT_OVERRIDES["classic"]),
        hook=captions_ass.HookSpec(SAMPLE, 0, TOTAL_FRAMES, Y_E5, (design_id, 1)))


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
        "-f", "lavfi", "-i", f"color=c={colour}:s={width}x{height}:r={FPS.num}:d=2",
        "-vf", graph, "-frames:v", "1", "-fps_mode", "passthrough",
        "-map_metadata", "-1", "-flags", "+bitexact", "-fflags", "+bitexact",
        "-f", "image2", "-c:v", "png", "-pred", "mixed", "-compression_level", "9", str(out_png),
    ]


def render_thumb(design_id: str, *, ffmpeg: str = "ffmpeg", resources: Path = RESOURCES) -> bytes:
    """The stripped PNG bytes of one design's thumbnail."""
    with tempfile.TemporaryDirectory(prefix="hook-thumb-") as scratch:
        work = Path(scratch)
        (work / "captions.ass").write_text(thumb_ass(design_id), encoding="utf-8")
        (work / "fonts").symlink_to(resources / "fonts", target_is_directory=True)
        out = work / "thumb.png"
        result = subprocess.run(ffmpeg_argv(ffmpeg, out), cwd=work,
                                env=packs.ffmpeg_env(resources), capture_output=True, text=True,
                                timeout=120, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed for {design_id}: {result.stderr[-2000:]}")
        raw = packs.strip_png(out.read_bytes())
    if not packs._chunk_ok(raw):
        raise RuntimeError(f"corrupt PNG for {design_id}")
    return raw


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def build_manifest(rendered: dict[str, bytes], tool: dict[str, str]) -> dict:
    return {
        "schema": SCHEMA,
        "size": list(THUMB_SIZE),
        "sample": SAMPLE,
        "frame": SHOW_FRAME,
        "background": BACKGROUND,
        "crop": list(CROP),
        "toolchain": tool,
        "designs": {
            design: {
                "file": f"{design}.png",
                "design_sha256": _sha256(
                    (RESOURCES / "hook-designs" / design / "v1.json").read_bytes()),
                "png_sha256": _sha256(raw),
                "bytes": len(raw),
            }
            for design, raw in rendered.items()
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    parser.add_argument("--check", action="store_true",
                        help="re-render and compare with the files in --out; write nothing")
    args = parser.parse_args(argv)

    rendered = {design: render_thumb(design, ffmpeg=args.ffmpeg) for design in DESIGNS}
    too_big = {design: len(raw) for design, raw in rendered.items() if len(raw) >= MAX_BYTES}
    if too_big:
        print(f"thumbnails over {MAX_BYTES} bytes: {too_big}", file=sys.stderr)
        return 1
    if args.check:
        different = [design for design, raw in rendered.items()
                     if not (args.out / f"{design}.png").is_file()
                     or (args.out / f"{design}.png").read_bytes() != raw]
        print(json.dumps({"identical": not different, "different": different}))
        return 1 if different else 0
    args.out.mkdir(parents=True, exist_ok=True)
    for design, raw in rendered.items():
        (args.out / f"{design}.png").write_bytes(raw)
    manifest = build_manifest(rendered, packs.toolchain(args.ffmpeg))
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                                            encoding="utf-8")
    print(json.dumps({design: len(raw) for design, raw in rendered.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
