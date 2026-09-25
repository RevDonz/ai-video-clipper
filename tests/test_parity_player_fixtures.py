"""Tests for the browser-player fixture generator (plan §11.2 T2.4,
``scripts/parity/player_fixtures.py``).

The generator turns compiler plans into the plan DTO the player loads (plan §4.3), the
expected source frame and crop x of every output frame (P-FRAME in the browser), the probe
frames of the composite comparison (P-TXT, P-LOGO), and scores the browser composites. The
media steps run FFmpeg in the toolchain image; everything tested here is pure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import compare
import frame_identity as fi
import player_fixtures as pf

from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan


def _plan(*, hook: bool = True, cuts: int = 20, layout: str = "fit_blur", pack: str | None = None,
          logo: bool = False):
    case = fi.Case("unit", (30000, 1001), 900, layout, hook=hook, cuts=cuts)
    info = fi.SourceInfo(640, 360, (30000, 1001), False, 30030, True)
    edges = fi.case_edges(case)
    assets = {}
    logo_spec = None
    if logo:
        asset = "sha256:" + "ab" * 32
        assets = {asset: {"kind": "image", "mime": "image/png", "w": 256, "h": 128}}
        logo_spec = (asset, pf.LOGO_TRANSFORM)
    doc = fi.make_doc(info, fps=case.fps, body=edges["body"], cold_open=edges["cold_open"],
                      removals=edges["removals"], layout=layout,
                      hook=("Hook sintetis", 45) if hook else None, logo=logo_spec, assets=assets)
    if pack is not None:
        pf.set_pack(doc, pack)
    words = fi.make_words(30030)
    camera = fi.make_camera(30030, case.fps, (640, 360), (720, 1280)) if layout == "camera" else None
    return build_plan(doc, words=words, camera=camera, assets=assets,
                      resources=Resources(RESOURCES_DIR))


def test_the_dto_has_the_plan_shape_and_fixture_urls():
    plan = _plan(logo=True)
    cells = pf.cells_needed(plan)
    dto = pf.plan_dto(plan, case="cfr_29.97", variant="karaoke", plate_key="k" * 64,
                      ready=set(cells), mix={"sha256": "m" * 64, "samples": plan.total_samples},
                      fonts=pf.font_entries(Resources(RESOURCES_DIR)), logo_file="logo.png",
                      auto_render=None)
    assert set(dto) >= {"planSha256", "docSha256", "compiler", "renderSemantics", "fps",
                        "totalFrames", "output", "pieces", "cues", "hook", "text", "plate",
                        "logo", "audio", "rev0", "warnings", "errors"}
    assert dto["planSha256"] == plan.plan_sha256
    assert dto["fps"] == [30000, 1001]
    assert dto["totalFrames"] == plan.total_frames
    assert dto["pieces"] == [piece.to_dto() for piece in plan.pieces]
    assert dto["text"]["assSha256"] == plan.ass_sha256
    assert dto["text"]["ass"] == plan.ass
    assert dto["text"]["url"] == f"{pf.BASE}/cfr_29.97/karaoke/captions.ass"
    assert {font["family"] for font in dto["text"]["fonts"]} == {
        "DejaVu Sans", "DejaVu Sans Bold", "Montserrat ExtraBold"}
    assert all(font["url"].startswith(f"{pf.BASE}/fonts/") for font in dto["text"]["fonts"])
    assert dto["plate"]["cellFrames"] == 60
    assert dto["plate"]["plateKey"] == "k" * 64
    assert [cell["k"] for cell in dto["plate"]["cells"]] == cells
    assert all(cell["state"] == "ready" and cell["url"] == f"{pf.BASE}/cfr_29.97/cells/c{cell['k']:07d}.mp4"
               for cell in dto["plate"]["cells"])
    assert dto["logo"]["box"] == {"x": plan.logo.x, "y": plan.logo.y, "w": plan.logo.w,
                                  "h": plan.logo.h}
    assert dto["logo"]["url"] == f"{pf.BASE}/cfr_29.97/logo.png"
    assert dto["audio"] == {"mixSha256": "m" * 64, "state": "ready",
                            "url": f"{pf.BASE}/cfr_29.97/mix.flac", "samples": plan.total_samples,
                            "musicGainPoints": [], "speechSpans": [list(s) for s in plan.speech_spans]}
    assert dto["rev0"] == {"planSha256": None, "autoRenderUrl": None, "exact": False}
    json.dumps(dto)  # serialisable


def test_cells_not_ready_are_queued_without_url_and_the_auto_render_is_exact():
    plan = _plan()
    cells = pf.cells_needed(plan)
    dto = pf.plan_dto(plan, case="c", variant="v", plate_key="k" * 64, ready=set(),
                      mix={"sha256": "m" * 64, "samples": plan.total_samples}, fonts=[],
                      logo_file=None, auto_render="auto.mp4")
    assert [cell["state"] for cell in dto["plate"]["cells"]] == ["queued"] * len(cells)
    assert all("url" not in cell for cell in dto["plate"]["cells"])
    assert dto["rev0"] == {"planSha256": plan.plan_sha256, "autoRenderUrl": f"{pf.BASE}/c/auto.mp4",
                           "exact": True}
    assert dto["logo"] is None


def test_cells_needed_cover_every_output_frame():
    plan = _plan()
    size = tm.cell_frames(plan.fps)
    cells = pf.cells_needed(plan)
    for n in range(plan.total_frames):
        assert tm.out_to_src(n, plan.pieces)[1] // size in cells
    assert cells == sorted(set(cells))


def test_expected_index_follows_the_grid_through_the_time_map():
    plan = _plan()
    grid = [1000 + i for i in range(900)]  # the barcode index of grid frame i
    expected = pf.expected_index(plan, grid, first=0)
    assert len(expected) == plan.total_frames
    for n in (0, 1, plan.total_frames // 2, plan.total_frames - 1):
        assert expected[n] == 1000 + tm.out_to_src(n, plan.pieces)[1]
    shifted = pf.expected_index(plan, grid, first=5)
    sf = tm.out_to_src(0, plan.pieces)[1]
    assert shifted[0] == (grid[sf - 5] if 5 <= sf < 905 else None)


def test_expected_crop_x_is_the_centre_or_the_camera_table():
    assert pf.expected_crop_x(_plan(), (640, 360)) is None
    centre = pf.expected_crop_x(_plan(layout="fill_center"), (640, 360))
    assert set(centre) == {(2276 - 720) // 2}
    plan = _plan(layout="camera")
    table = pf.expected_crop_x(plan, (640, 360))
    assert len(table) == plan.total_frames
    assert len(set(table)) > 10


def test_probe_frames_include_hook_fades_cue_edges_and_cuts():
    plan = _plan(pack="bold")
    frames = pf.probe_frames(plan, count=8)
    assert frames == sorted(set(frames))
    assert 1 <= len(frames) <= 8
    assert all(0 <= n < plan.total_frames for n in frames)
    assert 1 in frames  # the hook fading in
    cue_edges = {cue.f0 for cue in plan.captions.cues}
    assert cue_edges & set(frames)
    cuts = {piece.out_f0 for piece in plan.pieces[1:]}
    assert cuts & set(frames)


def test_with_gop_changes_only_the_plate_gop(tmp_path):
    from ai_clipper.edit_v2.compile_ffmpeg import FfmpegJob

    job = FfmpegJob(argv=("ffmpeg", "-g", "60", "-force_key_frames", "expr:eq(mod(n,60),0)",
                          "-segment_frames", "60"),
                    filter_script="", inputs=(), sidecars={}, expected={})
    short = pf.with_gop(job, 60, 15)
    assert short.argv == ("ffmpeg", "-g", "15", "-force_key_frames", "expr:eq(mod(n,60),0)",
                          "-segment_frames", "60")
    with pytest.raises(ValueError):
        pf.with_gop(job, 60, 0)


def test_set_pack_uses_the_pack_defaults():
    plan = _plan(pack="box")
    assert plan.doc["captions"]["pack"] == {"id": "box", "v": 1}
    assert plan.doc["captions"]["overrides"]["case"] == "asis"
    assert "BorderStyle" in plan.ass or "Box" in plan.ass
    bold = _plan(pack="bold")
    assert bold.doc["captions"]["overrides"]["case"] == "upper"


def _image(width, height, rgb):
    return compare.image_from_rgb(width, height, bytes(rgb) * (width * height))


def test_logo_scoring_checks_the_box_and_the_blend():
    size = (64, 48)
    box = {"x": 10, "y": 8, "w": 20, "h": 12}
    base = _image(*size, (100, 100, 100))
    reference = bytearray(base.data)
    test_img = bytearray(base.data)
    for y in range(8, 20):
        for x in range(10, 30):
            i = (y * 64 + x) * 3
            reference[i:i + 3] = bytes((200, 60, 30))
            test_img[i:i + 3] = bytes((201, 60, 29))
    reference_img = compare.image_from_rgb(*size, bytes(reference))
    good = compare.image_from_rgb(*size, bytes(test_img))
    score = pf.score_logo(good, reference_img, base, box)
    assert score["box"] == [10, 8, 30, 20]
    assert score["box_exact"] is True
    assert score["mean_abs"] == pytest.approx(2 / 3)
    assert score["max"] == 1
    assert pf.logo_pass(score)
    shifted = bytearray(base.data)
    for y in range(8, 20):
        for x in range(11, 31):
            i = (y * 64 + x) * 3
            shifted[i:i + 3] = bytes((200, 60, 30))
    moved = pf.score_logo(compare.image_from_rgb(*size, bytes(shifted)), reference_img, base, box)
    assert moved["box_exact"] is False
    assert not pf.logo_pass(moved)


def test_logo_thresholds_are_the_plan_numbers():
    assert pf.P_LOGO == {"mean_abs": 2.0, "max": 8, "box_px": 0}
    assert not pf.logo_pass({"box_exact": True, "mean_abs": 2.01, "max": 3})
    assert not pf.logo_pass({"box_exact": True, "mean_abs": 1.0, "max": 9})


def test_evidence_files_hold_numbers_only(tmp_path):
    results = {
        "p_frame.json": {"browser": "147.0.7727.15", "executable": "/home/x/chrome",
                         "cases": [{"case": "cfr_29.97", "frames": 2400, "mismatches": 0,
                                    "details": [], "crop_x_mismatches": 0, "unpresented": 0,
                                    "crop_x_checked": 0}],
                         "totals": {"frames": 2400, "mismatches": 0}},
    }
    browser = tmp_path / "browser"
    browser.mkdir()
    for name, value in results.items():
        (browser / name).write_text(json.dumps(value), encoding="utf-8")
    manifest = {"schema": pf.SCHEMA, "toolchain": {"ffmpeg": "ffmpeg version 5.1.9"}, "cases": []}
    fixtures = tmp_path / "fixtures" / "player"
    fixtures.mkdir(parents=True)
    (fixtures / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    written = pf.write_evidence(tmp_path / "fixtures", browser, tmp_path / "evidence", task="T2.4")
    assert [path.name for path in written] == ["T2.4-P-FRAME.json"]
    data = json.loads(written[0].read_text(encoding="utf-8"))
    assert data["gate"] == "P-FRAME"
    assert data["browser"] == "147.0.7727.15"
    assert "/home/" not in written[0].read_text(encoding="utf-8")
    assert data["pass"] is True
