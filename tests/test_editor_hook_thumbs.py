"""Tests for the hook-design thumbnails of the Hook card and the Teks panel (CONTRACTS §5.31).

``scripts/editor/make_hook_thumbs.py`` renders one small PNG per hook design with the production
ASS generator (``build_ass_v2``) and FFmpeg's ``ass`` filter, inside the toolchain image, as
``make_pack_thumbs.py`` does for the caption packs. The PNGs are committed under
``web/components/editor/panels/hook-thumbs/`` with a manifest that pins the design files they were
rendered from, so a design change without new thumbnails fails here.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "editor" / "make_hook_thumbs.py"
THUMBS = ROOT / "web" / "components" / "editor" / "panels" / "hook-thumbs"
DESIGNS = ROOT / "resources" / "hook-designs"


def _load_script():
    spec = importlib.util.spec_from_file_location("make_hook_thumbs", SCRIPT)
    assert spec is not None and spec.loader is not None, SCRIPT
    module = importlib.util.module_from_spec(spec)
    sys.modules["make_hook_thumbs"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def thumbs():
    return _load_script()


def _png_size(raw: bytes) -> tuple[int, int]:
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    assert raw[12:16] == b"IHDR"
    return struct.unpack(">II", raw[16:24])


def _chunks(raw: bytes) -> list[str]:
    names, offset = [], 8
    while offset < len(raw):
        (length,) = struct.unpack(">I", raw[offset:offset + 4])
        names.append(raw[offset + 4:offset + 8].decode("ascii"))
        offset += 12 + length
    return names


def test_the_script_covers_every_design_with_the_production_generator(thumbs):
    from ai_clipper.captions_ass import layout_hook
    from ai_clipper.edit_v2 import HOOK_DESIGN_IDS

    assert thumbs.DESIGNS == HOOK_DESIGN_IDS
    for design in HOOK_DESIGN_IDS:
        ass = thumbs.thumb_ass(design)
        assert ass.startswith("[Script Info]")
        assert "PlayResX: 720" in ass and "PlayResY: 1280" in ass
        dialogue = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
        assert dialogue and all(",Hook,," in line for line in dialogue), design
        plain = re.sub(r"\{[^}]*\}", " ", " ".join(line.split(",", 9)[9] for line in dialogue))
        assert "DITAHAN" in plain.split(), (design, plain)
        # The band holds every line of the sample in every design.
        layout = layout_hook(thumbs.SAMPLE, play_res=thumbs.PLAY_RES, y_e5=thumbs.Y_E5,
                             design=(design, 1))
        assert 1 <= len(layout.lines) <= 2 and not layout.overflow, design
        assert thumbs.CROP[1] <= layout.top
    assert thumbs.thumb_ass("kotak") == thumbs.thumb_ass("kotak")


def test_the_frame_is_shown_after_the_fade_in_and_before_the_fade_out(thumbs):
    frame_ms = 1000 * thumbs.SHOW_FRAME * thumbs.FPS.den // thumbs.FPS.num
    end_ms = 1000 * thumbs.TOTAL_FRAMES * thumbs.FPS.den // thumbs.FPS.num
    assert 150 < frame_ms < end_ms - 250


def test_the_ffmpeg_command_is_capped_and_uses_the_locked_fonts(thumbs, tmp_path):
    argv = thumbs.ffmpeg_argv("ffmpeg", tmp_path / "out.png")
    joined = " ".join(argv)
    assert argv[argv.index("-threads") + 1] == "4"
    assert "ass=filename=captions.ass:fontsdir=fonts:shaping=complex" in joined
    assert f"select=eq(n\\,{thumbs.SHOW_FRAME})" in joined
    x, y, w, h = thumbs.CROP
    assert f"crop={w}:{h}:{x}:{y}" in joined and w == 4 * h  # the pack tiles' 4:1
    assert "-frames:v" in argv and argv[argv.index("-frames:v") + 1] == "1"


def test_the_committed_manifest_matches_the_design_files(thumbs):
    manifest = json.loads((THUMBS / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema"] == "potongin.hook-thumbs/1"
    assert manifest["size"] == list(thumbs.THUMB_SIZE)
    assert manifest["sample"] == thumbs.SAMPLE
    assert set(manifest["designs"]) == set(thumbs.DESIGNS)
    for design, entry in manifest["designs"].items():
        design_bytes = (DESIGNS / design / "v1.json").read_bytes()
        assert entry["design_sha256"] == hashlib.sha256(design_bytes).hexdigest(), (
            f"{design}: design file changed; re-run scripts/editor/make_hook_thumbs.py in the image")
        raw = (THUMBS / entry["file"]).read_bytes()
        assert entry["png_sha256"] == hashlib.sha256(raw).hexdigest(), design
        assert entry["bytes"] == len(raw) < thumbs.MAX_BYTES == 30 * 1024, design
        assert _png_size(raw) == thumbs.THUMB_SIZE, design
        assert set(_chunks(raw)) <= {"IHDR", "PLTE", "IDAT", "IEND"}, (design, _chunks(raw))
    assert manifest["toolchain"]["ffmpeg"].startswith("5.1.9")


def test_the_thumbnails_differ_per_design():
    manifest = json.loads((THUMBS / "manifest.json").read_text(encoding="utf-8"))
    digests = [entry["png_sha256"] for entry in manifest["designs"].values()]
    assert len(set(digests)) == len(digests)


@pytest.mark.usefixtures("edit_v2_reference_toolchain")
def test_the_committed_thumbnails_reproduce_on_the_pinned_toolchain(thumbs, tmp_path):
    assert thumbs.main(["--out", str(tmp_path)]) == 0
    for design in thumbs.DESIGNS:
        assert (tmp_path / f"{design}.png").read_bytes() == (THUMBS / f"{design}.png").read_bytes()
