"""Pinned fonts, glyph coverage and advances (plan §5.2 R6, §5.4; T1.2a)."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from support import edit_v2_text

from ai_clipper.captions_ass import estimate_text_width
from ai_clipper.edit_v2 import glyphs

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "resources" / "fonts"
FONTCONFIG = ROOT / "resources" / "fontconfig" / "fonts.conf"

DEJAVU = FONTS / "DejaVuSans.ttf"
DEJAVU_BOLD = FONTS / "DejaVuSans-Bold.ttf"
MONTSERRAT = FONTS / "Montserrat-ExtraBold.ttf"

# Debian bookworm fonts-dejavu-core 2.37-6 (the package of the reference image).
DEJAVU_DEB_SHA256 = "8892669e51aab4dc56682c8e39d8ddb7d70fad83c369344e1e240bf3ca22bb76"
MONTSERRAT_COMMIT = "5dae7a4ef9c0bf9fe48dc54fd1076eefaa0a8c7e"  # tag v7.222


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest() -> dict:
    return json.loads((FONTS / "fonts.json").read_text(encoding="utf-8"))


# --- fonts.json ----------------------------------------------------------------------------


def test_fonts_json_lists_every_font_file_with_its_exact_sha256_and_size():
    manifest = _manifest()
    assert manifest["schema"] == "potongin.fonts/1"
    listed = {entry["file"] for entry in manifest["fonts"]}
    on_disk = {path.name for path in FONTS.glob("*.ttf")}
    assert listed == on_disk == {"DejaVuSans.ttf", "DejaVuSans-Bold.ttf",
                                 "Montserrat-ExtraBold.ttf"}
    for entry in manifest["fonts"]:
        path = FONTS / entry["file"]
        assert entry["sha256"] == _sha256(path), entry["file"]
        assert entry["bytes"] == path.stat().st_size, entry["file"]
        assert (FONTS / entry["license_file"]).is_file()
    for entry in manifest["licenses"]:
        assert entry["sha256"] == _sha256(FONTS / entry["file"]), entry["file"]
    assert {entry["file"] for entry in manifest["licenses"]} == {"OFL.txt",
                                                                 "LICENSE-DejaVu.txt"}
    assert manifest["fallback"] == "DejaVuSans.ttf"


def test_dejavu_is_the_debian_bookworm_package_and_montserrat_a_pinned_upstream_commit():
    entries = {entry["file"]: entry for entry in _manifest()["fonts"]}
    for name in ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf"):
        source = entries[name]["source"]
        assert source["kind"] == "debian-package"
        assert (source["distribution"], source["package"], source["version"]) == (
            "bookworm", "fonts-dejavu-core", "2.37-6")
        assert source["deb_sha256"] == DEJAVU_DEB_SHA256
        assert source["path"] == f"usr/share/fonts/truetype/dejavu/{name}"
        assert entries[name]["family"] == "DejaVu Sans"
        assert entries[name]["license"] == "Bitstream-Vera"
    montserrat = entries["Montserrat-ExtraBold.ttf"]
    assert montserrat["family"] == "Montserrat ExtraBold"
    assert montserrat["license"] == "OFL-1.1"
    assert montserrat["source"]["commit"] == MONTSERRAT_COMMIT
    assert montserrat["source"]["url"] == (
        f"https://raw.githubusercontent.com/JulietaUla/Montserrat/{MONTSERRAT_COMMIT}"
        "/fonts/ttf/Montserrat-ExtraBold.ttf"
    )
    assert montserrat["sha256"] == (
        "1b364c3400bf7b1cc2c47a25dd0d3edd8331da451412aa5539080f78f8f70b63")


def test_module_manifest_helpers_resolve_the_pinned_files():
    assert glyphs.FONTS_DIR == FONTS
    assert glyphs.RESOURCES_DIR == ROOT / "resources"
    assert glyphs.fonts_manifest() == _manifest()
    assert glyphs.font_path("DejaVuSans.ttf") == DEJAVU
    assert glyphs.FALLBACK_FONT == DEJAVU
    with pytest.raises(ValueError):
        glyphs.font_path("../fonts.json")
    with pytest.raises(ValueError):
        glyphs.font_path("Arial.ttf")


def test_licence_texts_are_the_upstream_texts():
    ofl = (FONTS / "OFL.txt").read_text(encoding="utf-8")
    assert "SIL Open Font License, Version 1.1" in ofl
    assert "The Montserrat Project Authors" in ofl
    dejavu = (FONTS / "LICENSE-DejaVu.txt").read_text(encoding="utf-8")
    assert "Bitstream Vera Fonts Copyright" in dejavu
    assert "DejaVu changes are in public domain" in dejavu


# --- cmap coverage ---------------------------------------------------------------------------


def test_ascii_and_indonesian_text_is_covered_by_every_pack_font():
    text = "Kenapa semua orang ketawa? Gue BUKAN jambret, bro! 0123456789 …–—“”‘’é"
    for font in (DEJAVU, DEJAVU_BOLD, MONTSERRAT):
        assert glyphs.missing_glyphs(text, font) == (), font.name


def test_missing_glyphs_are_reported_once_in_first_seen_order():
    assert glyphs.missing_glyphs("a🔥b😤🔥c😤", DEJAVU) == ("🔥", "😤")
    assert glyphs.missing_glyphs("", DEJAVU) == ()


def test_emoji_coverage_of_the_pinned_fonts():
    # The plan assumed DejaVu lacks 😂; the pinned DejaVu Sans 2.37 maps U+1F600-1F643
    # (monochrome), so 😂 renders in DejaVu (and through the DejaVu fallback). 🔥 is in no font.
    assert glyphs.missing_glyphs("😂", MONTSERRAT) == ("😂",)
    assert glyphs.missing_glyphs("😂", DEJAVU) == ()
    assert glyphs.missing_glyphs("😂", DEJAVU_BOLD) == ()
    for font in (DEJAVU, DEJAVU_BOLD, MONTSERRAT):
        assert glyphs.missing_glyphs("🔥", font) == ("🔥",)


def test_fallback_probe_characters_have_the_coverage_the_probe_relies_on():
    # ‱ is DejaVu-only (a Montserrat caption falls back to DejaVu for it); ₿ is Montserrat-only
    # (a DejaVu caption must NOT fall back to Montserrat for it).
    assert glyphs.missing_glyphs("‱", MONTSERRAT) == ("‱",)
    assert glyphs.missing_glyphs("‱", DEJAVU) == ()
    assert glyphs.missing_glyphs("₿", MONTSERRAT) == ()
    assert glyphs.missing_glyphs("₿", DEJAVU) == ("₿",)


# --- advances -------------------------------------------------------------------------------


def test_advance_uses_hmtx_scaled_like_libass():
    # libass sizes a font so that OS/2 winAscent + winDescent spans the font size; DejaVu Sans
    # Bold: 'm' advances 2134/2048 em and the win height is 2384/2048 em (the 1.164 of
    # captions_ass). So at size 2384 px, 'm' is exactly 2134 px wide.
    assert glyphs.advance_px("m", DEJAVU_BOLD, 2384) == pytest.approx(2134)
    assert glyphs.advance_px("mm", DEJAVU_BOLD, 50) == pytest.approx(
        2 * glyphs.advance_px("m", DEJAVU_BOLD, 50))
    assert glyphs.advance_px("", MONTSERRAT, 64) == 0
    assert glyphs.advance_px("WWW", MONTSERRAT, 128) == pytest.approx(
        2 * glyphs.advance_px("WWW", MONTSERRAT, 64))


def test_advance_agrees_with_the_legacy_dejavu_bold_estimate():
    text = "Kode rahasia copet di keramaian"
    legacy = estimate_text_width(text, 53) / 1.04  # the estimate adds a 4% safety margin
    assert glyphs.advance_px(text, DEJAVU_BOLD, 53) == pytest.approx(legacy, rel=0.01)


def test_missing_characters_advance_like_notdef():
    notdef = glyphs.advance_px("🔥", DEJAVU, 100)
    assert notdef > 0
    assert glyphs.advance_px("a🔥", DEJAVU, 100) == pytest.approx(
        glyphs.advance_px("a", DEJAVU, 100) + notdef)


def test_non_font_files_are_rejected(tmp_path: Path):
    bogus = tmp_path / "bogus.ttf"
    bogus.write_bytes(b"not a font at all" * 10)
    with pytest.raises(ValueError):
        glyphs.missing_glyphs("a", bogus)
    with pytest.raises(ValueError):
        glyphs.advance_px("a", bogus, 10)
    with pytest.raises(OSError):
        glyphs.missing_glyphs("a", tmp_path / "absent.ttf")


# --- fontconfig lockdown (R6) ------------------------------------------------------------------


def test_fontconfig_file_lists_only_the_pinned_directory_and_accepts_only_dejavu():
    text = FONTCONFIG.read_text(encoding="utf-8")
    assert '<dir prefix="relative">../fonts</dir>' in text
    assert text.count("<dir") == 1
    assert "<include" not in text
    assert "<string>DejaVu Sans</string>" in text


@pytest.mark.skipif(shutil.which("fc-list") is None, reason="fc-list not available")
def test_fontconfig_sees_only_dejavu_sans(tmp_path: Path):
    result = subprocess.run(
        ["fc-list", "--format", "%{file}\n"], capture_output=True, text=True, check=True,
        cwd=tmp_path, env={"FONTCONFIG_FILE": str(FONTCONFIG), "PATH": "/usr/bin:/bin"},
    )
    files = sorted(Path(line).name for line in result.stdout.split())
    assert files == ["DejaVuSans-Bold.ttf", "DejaVuSans.ttf"]


def test_missing_glyph_probe_uses_no_face_but_the_pinned_ones(edit_v2_libass):
    report = edit_v2_text.glyph_probe()
    assert report["unexpected_faces"] == []
    # ‱ and 😂 in the Montserrat packs are drawn by DejaVu Sans, the only fallback.
    assert "DejaVuSans" in report["fallback_faces"]
    assert set(report["fallback_faces"]) <= {"DejaVuSans", "DejaVuSans-Bold"}
    # ₿ exists only in Montserrat, yet a DejaVu caption never falls back to Montserrat.
    assert report["montserrat_used_for_other_families"] == 0
    assert report["not_found"] == ["U+1F525 DejaVu Sans", "U+20BF DejaVu Sans"]
    assert report["failures"] == 0
