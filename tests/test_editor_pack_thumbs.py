"""Tests for the caption-pack thumbnails of the text panel (plan §11.2 T2.7, §5.4 packs).

``scripts/editor/make_pack_thumbs.py`` renders one small PNG per pack with the production ASS
generator (``captions_ass.fit_cues`` + ``build_ass_v2``) and FFmpeg's ``ass`` filter, inside the
toolchain image. The PNGs are committed under ``web/components/editor/panels/pack-thumbs/`` (the
one committed-media exception of the plan) with a manifest that pins the pack files they were
rendered from, so a pack change without new thumbnails fails here.
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
SCRIPT = ROOT / "scripts" / "editor" / "make_pack_thumbs.py"
THUMBS = ROOT / "web" / "components" / "editor" / "panels" / "pack-thumbs"
PACKS = ROOT / "resources" / "caption-packs"


def _load_script():
    spec = importlib.util.spec_from_file_location("make_pack_thumbs", SCRIPT)
    assert spec is not None and spec.loader is not None, SCRIPT
    module = importlib.util.module_from_spec(spec)
    sys.modules["make_pack_thumbs"] = module
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


def test_the_script_covers_every_pack_with_the_production_generator(thumbs):
    from ai_clipper.edit_v2 import PACK_IDS

    assert thumbs.PACKS == PACK_IDS
    for pack in PACK_IDS:
        ass = thumbs.thumb_ass(pack)
        assert ass.startswith("[Script Info]")
        assert "PlayResX: 720" in ass and "PlayResY: 1280" in ass
        dialogue = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
        assert dialogue, pack
        plain = re.sub(r"\{[^}]*\}", "", " ".join(dialogue))
        word = "HALO" if pack == "bold" else "Halo"
        assert word in plain, (pack, plain)
    # Same inputs, same bytes.
    assert thumbs.thumb_ass("karaoke") == thumbs.thumb_ass("karaoke")


def test_the_sample_frame_shows_the_reveal_between_the_two_word_onsets(thumbs):
    first, second = thumbs.SAMPLE_WORDS
    assert first[1] <= thumbs.SHOW_FRAME < second[1] < thumbs.TOTAL_FRAMES


def test_the_ffmpeg_command_is_capped_and_uses_the_locked_fonts(thumbs, tmp_path):
    argv = thumbs.ffmpeg_argv("ffmpeg", tmp_path / "out.png")
    joined = " ".join(argv)
    assert argv[argv.index("-threads") + 1] == "4"
    assert "ass=filename=captions.ass:fontsdir=fonts:shaping=complex" in joined
    assert f"select=eq(n\\,{thumbs.SHOW_FRAME})" in joined
    x, y, w, h = thumbs.CROP
    assert f"crop={w}:{h}:{x}:{y}" in joined
    assert "-frames:v" in argv and argv[argv.index("-frames:v") + 1] == "1"
    env = thumbs.ffmpeg_env(ROOT / "resources")
    assert env["FONTCONFIG_FILE"].endswith("resources/fontconfig/fonts.conf")
    assert not [key for key in env if key.startswith(("APP_", "POTONGIN_")) or key.endswith("_KEY")]


def test_the_committed_manifest_matches_the_pack_files(thumbs):
    manifest = json.loads((THUMBS / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema"] == "potongin.pack-thumbs/1"
    assert manifest["size"] == list(thumbs.THUMB_SIZE)
    assert set(manifest["packs"]) == set(thumbs.PACKS)
    for pack, entry in manifest["packs"].items():
        pack_bytes = (PACKS / pack / "v1.json").read_bytes()
        assert entry["pack_sha256"] == hashlib.sha256(pack_bytes).hexdigest(), (
            f"{pack}: pack file changed; re-run scripts/editor/make_pack_thumbs.py in the image")
        raw = (THUMBS / entry["file"]).read_bytes()
        assert entry["png_sha256"] == hashlib.sha256(raw).hexdigest(), pack
        assert entry["bytes"] == len(raw) < thumbs.MAX_BYTES == 30 * 1024, pack
        assert _png_size(raw) == thumbs.THUMB_SIZE, pack
        # Only the critical chunks: no text, time or colour-profile metadata in committed media.
        assert set(_chunks(raw)) <= {"IHDR", "PLTE", "IDAT", "IEND"}, (pack, _chunks(raw))
    assert manifest["toolchain"]["ffmpeg"].startswith("5.1.9")


def test_the_thumbnails_differ_per_pack():
    manifest = json.loads((THUMBS / "manifest.json").read_text(encoding="utf-8"))
    digests = [entry["png_sha256"] for entry in manifest["packs"].values()]
    assert len(set(digests)) == len(digests)


def test_strip_keeps_only_the_critical_chunks(thumbs):
    def chunk(name: bytes, data: bytes) -> bytes:
        import zlib
        return (struct.pack(">I", len(data)) + name + data
                + struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"tEXt", b"Software\x00x")
           + chunk(b"IDAT", b"\x78\x9c\x63\x60\x60\x60\x00\x00\x00\x04\x00\x01")
           + chunk(b"IEND", b""))
    stripped = thumbs.strip_png(raw)
    assert _chunks(stripped) == ["IHDR", "IDAT", "IEND"]
    assert thumbs.strip_png(stripped) == stripped


@pytest.mark.usefixtures("edit_v2_reference_toolchain")
def test_the_committed_thumbnails_reproduce_on_the_pinned_toolchain(thumbs, tmp_path):
    assert thumbs.main(["--out", str(tmp_path)]) == 0
    for pack in thumbs.PACKS:
        assert (tmp_path / f"{pack}.png").read_bytes() == (THUMBS / f"{pack}.png").read_bytes()
