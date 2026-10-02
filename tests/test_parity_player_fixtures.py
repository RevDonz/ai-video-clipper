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


# P-JOIN-B (spec 2026-10-02 §5.4): the cold-open transition in the browser.

FLASH_30 = [(58, 333), (59, 667), (60, 1000), (61, 667), (62, 333)]


def test_the_dto_always_lists_the_joins():
    dto = pf.plan_dto(_plan(), case="c", variant="v", plate_key="k" * 64, ready=set(), mix=None,
                      fonts=[], logo_file=None, auto_render=None)
    assert isinstance(dto["joins"], list)
    assert all(join["style"] == "cut" and join["alphaPm"] == [] and join["rgb"] is None
               for join in dto["joins"])


def test_join_frames_cover_the_window_and_its_neighbours():
    assert pf.join_check_frames(FLASH_30, 150) == list(range(56, 65))
    assert pf.join_probe_frames(FLASH_30, 150) == list(range(57, 64))
    # clipped to the clip (§2.4 drops affected frames outside it; the window follows)
    assert pf.join_check_frames([(0, 1000), (1, 500)], 3) == [0, 1, 2]
    assert pf.join_probe_frames([(0, 1000), (1, 500)], 2) == [0, 1]
    with pytest.raises(ValueError):
        pf.join_check_frames([], 150)


def test_the_server_composite_blends_the_transition_before_the_text():
    plan = _plan(hook=False, cuts=2)
    resources = Resources(RESOURCES_DIR)
    cell = Path("/cells/c0000000.mp4")
    lut = ",lutrgb=r=floor((val*0+255500)/1000):enable='between(t,1.985317,2.018683)'"
    job = pf.composite_job(plan, cell=cell, j=3, n=60, resources=resources, lut=lut)
    assert f"setpts=60,{pf._TEXT_IN_GBRP}{lut},{pf._TEXT_FILTER}[vtext]" in job.filter_script
    plate = pf.composite_job(plan, cell=cell, j=3, n=60, resources=resources, text=False, lut=lut)
    assert f"setpts=60,{pf._TEXT_IN_GBRP}{lut}[vtext]" in plate.filter_script
    cut = pf.composite_job(plan, cell=cell, j=3, n=60, resources=resources)
    assert f"setpts=60,{pf._TEXT_IN_GBRP},{pf._TEXT_FILTER}[vtext]" in cut.filter_script


def test_mean_diff_is_signed_per_channel():
    reference = _image(8, 4, (100, 100, 100))
    data = bytearray(reference.data)
    for i in range(0, len(data), 3):
        data[i] += 2  # red +2 everywhere
    data[1] -= 32  # green −32 on one pixel of 32
    test_img = compare.image_from_rgb(8, 4, bytes(data))
    assert pf.mean_diff(reference, test_img) == pytest.approx([2.0, -1.0, 0.0])
    assert pf.mean_diff(reference, reference) == [0.0, 0.0, 0.0]


def test_the_join_composite_gate_adds_the_mean_to_p_txt():
    good = {"ssim": 0.9995, "psnr": 50.0, "max": 2, "px_over_16": 0, "mean_diff": [0.4, -0.9, 1.0]}
    assert pf.join_composite_pass(good)
    assert not pf.join_composite_pass({**good, "mean_diff": [0.0, -1.01, 0.0]})
    assert not pf.join_composite_pass({**good, "ssim": 0.9989})
    assert not pf.join_composite_pass({**good, "psnr": 44.9})
    assert not pf.join_composite_pass({**good, "max": 17})
    assert not pf.join_composite_pass({**good, "px_over_16": 1})
    assert pf.P_JOIN_B["mean_diff"] == 1.0
    assert {k: pf.P_JOIN_B[k] for k in compare.P_TXT_THRESHOLDS} == compare.P_TXT_THRESHOLDS


def _join_fixture(tmp_path, probe):
    fixtures = tmp_path / "fixtures"
    case_dir = fixtures / "player" / "join_x"
    (case_dir / "composite").mkdir(parents=True)
    reference = _image(64, 64, (200, 150, 100))
    composite = {}
    for frame in probe:
        path = case_dir / "composite" / f"{frame}.png"
        compare.write_png(path, reference)
        composite[str(frame)] = str(path.relative_to(fixtures))
    case = {"id": "join_x", "kind": "join", "variants": [],
            "join": {"probe_frames": probe, "composite": composite,
                     "text_region": {str(f): [0, 0, 64, 64] for f in probe}}}
    manifest = {"schema": pf.SCHEMA, "toolchain": {"ffmpeg": "ffmpeg version 5.1.9"},
                "cases": [case, {"id": "cfr", "kind": "pframe", "variants": []}]}
    (fixtures / "player" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return fixtures, reference


def test_join_scoring_scores_every_probe_frame_and_flags_missing_ones(tmp_path):
    fixtures, reference = _join_fixture(tmp_path, [57, 58, 59])
    shots = tmp_path / "browser" / "join" / "join_x"
    shots.mkdir(parents=True)
    compare.write_png(shots / "57.png", reference)
    # A quarter of the rows 2 levels brighter, the rest 1: within P-TXT, but a mean of 1.25.
    brighter = bytes(v + (2 if i < 16 * 64 * 3 else 1) for i, v in enumerate(reference.data))
    compare.write_png(shots / "58.png", compare.image_from_rgb(64, 64, brighter))
    result = pf.score_join(fixtures, tmp_path / "browser")
    assert result["frames"] == 2
    assert result["thresholds"] == pf.P_JOIN_B
    by_frame = {f.get("frame"): f for f in result["failures"]}
    assert by_frame[59]["missing"] is True
    assert compare.p_txt_pass(by_frame[58])
    assert by_frame[58]["mean_diff"] == [1.25, 1.25, 1.25]
    assert 57 not in by_frame
    assert result["worst"]["mean_diff"] == 1.25
    assert set(result["cases"]["join_x"]) == {"57", "58"}


def _p_join_b(*, mismatches=0, max_lsb=0, failures=(), scored=23, flagged=6):
    alpha = {"frames": 9, "mismatches": mismatches, "unpresented": 0,
             "control_one_frame_late_flagged": flagged, "control_edges": 6}
    audio = {"contextRate": 48000, "bufferRate": 48000, "length": 960960,
             "referenceLength": 960960, "maxDiffLsb": max_lsb}
    composite = None if scored is None else {"frames": scored, "failures": list(failures),
                                             "worst": {"mean_diff": 0.4}}
    return {"browser": "147.0.7727.15", "executable": "/home/x/chrome",
            "cases": [{"case": "join_29.97", "whoosh": True, "alpha": alpha, "audio": audio},
                      {"case": "join_25", "whoosh": False, "alpha": alpha, "audio": None},
                      {"case": "join_23.976", "whoosh": False, "alpha": alpha, "audio": None}],
            "composite": composite, "composite_expected": 23}


@pytest.mark.parametrize(("change", "ok"), [
    ({}, True),
    ({"mismatches": 1}, False),
    ({"flagged": 0}, False),
    ({"max_lsb": 2}, False),
    ({"failures": [{"case": "join_25", "frame": 50, "missing": True}]}, False),
    ({"scored": 22}, False),
    ({"scored": None}, False),
])
def test_the_p_join_b_evidence_is_written_under_the_label(tmp_path, change, ok):
    fixtures, _ = _join_fixture(tmp_path, [57])
    browser = tmp_path / "browser"
    browser.mkdir()
    (browser / "p_join_b.json").write_text(json.dumps(_p_join_b(**change)), encoding="utf-8")
    (browser / "p_frame.json").write_text(json.dumps({"totals": {"frames": 0, "mismatches": 0}}),
                                          encoding="utf-8")
    written = pf.write_evidence(fixtures, browser, tmp_path / "evidence", task="CI",
                                gates=["P-JOIN-B"])
    assert [path.name for path in written] == ["CI-P-JOIN-B.json"]
    text = written[0].read_text(encoding="utf-8")
    data = json.loads(text)
    assert data["gate"] == "P-JOIN-B"
    assert data["pass"] is ok
    assert data["browser"] == "147.0.7727.15"
    assert "/home/" not in text


def test_the_evidence_cli_takes_a_label_and_a_gate(tmp_path):
    fixtures, _ = _join_fixture(tmp_path, [57])
    browser = tmp_path / "browser"
    browser.mkdir()
    (browser / "p_join_b.json").write_text(json.dumps(_p_join_b()), encoding="utf-8")
    assert pf.main(["evidence", "--fixtures", str(fixtures), "--browser", str(browser),
                    "--out-dir", str(tmp_path / "ev"), "--label", "CI", "--gate", "P-JOIN-B"]) == 0
    assert json.loads((tmp_path / "ev" / "CI-P-JOIN-B.json").read_text(encoding="utf-8"))["pass"]


# §2.2 at the gate cases' rates: (style, J, alpha from J − before).
JOIN_TABLE = {
    "join_29.97": ("flash_white", 60, [333, 666, 1000, 666, 333]),
    "join_25": ("dip_black", 50, [200, 467, 733, 1000, 733, 467, 200]),
    "join_23.976": ("flash_white", 48, [166, 583, 1000, 583, 166]),
}


def test_the_join_cases_carry_their_transition_through_the_plan_and_the_dto():
    transitions = pytest.importorskip("ai_clipper.edit_v2.transitions")
    assert [jc.case.name for jc in pf.JOIN_CASES] == list(JOIN_TABLE)
    assert [jc.whoosh for jc in pf.JOIN_CASES] == [True, False, False]
    assert [(jc.case.layout, jc.case.hook, jc.case.logo) for jc in pf.JOIN_CASES] == [
        ("fit_blur", True, False), ("fill_center", False, False), ("fit_blur", False, True)]
    for jc in pf.JOIN_CASES:
        assets: dict = {}
        logo_asset = None
        if jc.case.logo:
            logo_asset = "sha256:" + "ab" * 32
            assets = {logo_asset: {"kind": "image", "mime": "image/png", "w": 256, "h": 128}}
        doc = pf.join_document(jc, logo_asset=logo_asset, assets=assets)
        plan = build_plan(doc, words=fi.make_words(doc["base"]["source"]["duration_ms"]),
                          camera=None, assets=assets, resources=Resources(RESOURCES_DIR))
        join = pf.transition_of(plan, jc)
        style, at_f, alphas = JOIN_TABLE[jc.case.name]
        assert (join.style, join.at_f) == (style, at_f)
        before = (len(alphas) - 1) // 2
        assert [list(pair) for pair in join.alpha] == [
            [at_f - before + i, a] for i, a in enumerate(alphas)]
        dto = pf.plan_dto(plan, case=jc.case.name, variant="default", plate_key="k" * 64,
                          ready=set(), mix=None, fonts=[], logo_file=None, auto_render=None)
        assert dto["joins"] == transitions.joins_dto(plan.joins)
        assert dto["joins"][0]["alphaPm"] == [list(pair) for pair in join.alpha]
        assert dto["joins"][0]["rgb"] == ([255] * 3 if style == "flash_white" else [0] * 3)
        assert (dto["joins"][0]["sfx"] is not None) == jc.whoosh
        assert (plan.logo is not None) == jc.case.logo
        assert pf.join_probe_frames(join.alpha, plan.total_frames)[0] == at_f - before - 1


def test_a_join_case_whose_plan_lost_its_transition_is_refused():
    class Join:
        def __init__(self, style, sfx, alpha):
            self.style, self.sfx, self.alpha, self.at_f = style, sfx, alpha, 60

    class Plan:
        def __init__(self, joins):
            self.joins = joins

    flash = pf.JOIN_CASES[0]
    assert pf.transition_of(Plan((Join("flash_white", object(), tuple(FLASH_30)),)), flash)
    for joins in ((), (Join("cut", None, ()),), (Join("flash_white", None, tuple(FLASH_30)),),
                  (Join("flash_white", object(), ()),)):
        with pytest.raises(RuntimeError):
            pf.transition_of(Plan(joins), flash)
