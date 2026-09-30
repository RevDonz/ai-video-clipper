#!/usr/bin/env python3
"""Gates of the logo and watermark (plan §11.3 T3.2): P-LOGO at the output size and through a
truth frame (§10.1), and the G5 warning when the logo enters the TikTok UI zone (§5.9).

Subcommands:

``vectors [--write | --check]``
    The logo box (``timemap.logo_box``) and the zone rule (``plan.unsafe_zone_issues``) on a set
    of transforms around the zone's edges, written as one compact JSON value per line to
    ``web/components/editor/gizmos/__dev__/logo-zone-vectors.json``. The gizmo's geometry
    (``logo-geometry.mjs``) must give the same box and verdict for every line
    (``web/tests/editor-logo.test.mjs``).

``g5 [--out FILE]``
    G5 through the compiler: documents of the fixture contexts (720×1280 and 1080×1920) with a
    logo swept across the zone's edges; ``build_plan`` must report ``unsafe_zone`` for the logo
    item exactly when the box touches the zone, and the export's check (``verify`` calls
    ``unsafe_zone_issues`` at the render size) must agree.

``assets --job-dir DIR``
    Writes synthetic logos into a job's asset store (``analysis/assets/<hex>.png`` + ``.json``,
    CONTRACTS §5.9), in the form uploads are stored: RGBA PNG, at most 1024 px on the long edge,
    IHDR/IDAT/IEND only. Prints ``{name: {"asset": "sha256:…", "meta": {…}}}``.

``score --captures DIR --job-dir DIR --out FILE``
    P-LOGO for the captures of ``web/e2e/editor-logo.spec.mjs`` (real stack): per case and frame
    the browser canvas (``browser.png``), the truth frames with and without the logo
    (``truth.png``, ``truth-nologo.png``) and the document (``doc.json``). The server composite
    of the same plate-cell frame is made with the compiler's strings
    (``player_fixtures.composite_job``: gbrp, ``ass``, the derived logo, RGB before the 4:2:0
    step), with and without the logo, as W2 measured P-LOGO. Box: where the browser drew the logo
    must be exactly the plan's box; inside it mean ≤ 2 and max ≤ 8 levels. Truth frame: the box
    where the truth frames with and without the logo differ must be exactly the plan's box; the
    browser-vs-truth levels inside it are reported (the 4:2:0 step and the intra encode are in
    them, bounded by P-ENC).

Everything media-related runs in the toolchain image::

    docker run --rm --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/src:/w/tests \\
      ai-video-clipper:editor-w3base /app/.venv/bin/python scripts/parity/logo_gates.py g5

Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parents[2]
VECTORS = REPO / "web" / "components" / "editor" / "gizmos" / "__dev__" / "logo-zone-vectors.json"
CONTEXTS = REPO / "tests" / "fixtures" / "edit_v2" / "docs" / "contexts"
VECTOR_SCHEMA = "potongin.logo-zone-vectors/1"
P_LOGO = {"mean_abs": 2.0, "max": 8, "box_px": 0}
LOGO_CHANGE_LEVEL = 16  # the level player_fixtures.score_logo uses to find where a logo was drawn
OUTPUTS = ((720, 1280), (1080, 1920))
ASSETS = ((512, 512), (1000, 250), (200, 800), (1024, 7), (24, 1024), (640, 360))
WIDTHS_E5 = (4000, 16000, 27500, 40000)
UI_ZONE_720 = (93, 280, 93)  # plan §5.9 G5 (top, bottom, right at 720×1280)


def _round_half_up(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def independent_zone(output: tuple[int, int]) -> tuple[int, int, int]:
    """The zone of plan §5.9 written from the plan's text, not from plan.py."""
    width, height = output
    top, bottom, right = UI_ZONE_720
    return (_round_half_up(top * height, 1280), _round_half_up(bottom * height, 1280),
            _round_half_up(right * width, 720))


def independent_unsafe(box: Sequence[int], output: tuple[int, int]) -> bool:
    """G5 for the logo from the plan's text: the box touches the top, bottom or right band."""
    x, y, w, h = box
    top, bottom, right = independent_zone(output)
    return y < top or y + h > output[1] - bottom or x + w > output[0] - right


def centre_e5(start: int, size: int, total: int) -> int:
    """The centre e5 whose ``logo_box`` starts at ``start`` (the gizmo's positionFor)."""
    return _round_half_up((2 * start + size) * 100_000, 2 * total)


# --- vectors ------------------------------------------------------------------------------------


def _zone_doc(transform: Mapping[str, int]) -> dict[str, Any]:
    return {"captions": {"enabled": False, "overrides": {"y_e5": 50_000}},
            "tracks": [{"kind": "visual", "items": [{"id": "it_logo",
                                                       "transform": {**transform, "opacity_pm": 850},
                                                       "payload": {"asset": "sha256:" + "a" * 64}}]}]}


VECTOR_FIELDS = ("out_w", "out_h", "asset_w", "asset_h", "x_e5", "y_e5", "w_e5", "x", "y", "w", "h",
                 "unsafe")


def vector_lines() -> list[str]:
    from ai_clipper.edit_v2 import timemap as tm
    from ai_clipper.edit_v2.plan import ui_zone, unsafe_zone_issues

    rng = random.Random(20260930)
    records: list[list[int]] = []

    def record(output: tuple[int, int], asset: tuple[int, int], meta: Mapping[str, Any],
               transform: Mapping[str, int]) -> None:
        box = tm.logo_box(x_e5=transform["x_e5"], y_e5=transform["y_e5"], w_e5=transform["w_e5"],
                          asset_w=asset[0], asset_h=asset[1], out_w=output[0], out_h=output[1])
        issues = unsafe_zone_issues(_zone_doc(transform), meta, output, parts=("logo",))
        records.append([*output, *asset, transform["x_e5"], transform["y_e5"], transform["w_e5"],
                        *box, int(bool(issues))])

    for output in OUTPUTS:
        width, height = output
        top, bottom, right = ui_zone(output)
        for asset in ASSETS:
            meta = {"sha256:" + "a" * 64: {"kind": "image", "mime": "image/png", "w": asset[0],
                                            "h": asset[1]}}
            for w_e5 in WIDTHS_E5:
                _x, _y, bw, bh = tm.logo_box(x_e5=50_000, y_e5=50_000, w_e5=w_e5, asset_w=asset[0],
                                             asset_h=asset[1], out_w=width, out_h=height)
                if bh > height:
                    continue
                # One pixel either side of every edge of the zone, plus the frame's own edges.
                starts_x = [width - right - bw + d for d in range(-2, 3)] + [0, width - bw]
                starts_y = ([top + d for d in range(-2, 3)]
                            + [height - bottom - bh + d for d in range(-2, 3)] + [0, height - bh])
                points = [(x, y) for x in starts_x for y in starts_y[::4]]
                points += [(x, y) for x in starts_x[::3] for y in starts_y]
                points += [(rng.randrange(0, max(1, width - bw + 1)),
                            rng.randrange(0, max(1, height - bh + 1))) for _ in range(4)]
                for x0, y0 in points:
                    record(output, asset, meta, {"x_e5": centre_e5(x0, bw, width),
                                                 "y_e5": centre_e5(y0, bh, height), "w_e5": w_e5})
                # Arbitrary e5 values (not produced by the gizmo), for the box formula itself.
                for _ in range(4):
                    record(output, asset, meta, {"x_e5": rng.randrange(0, 100_001),
                                                 "y_e5": rng.randrange(0, 100_001), "w_e5": w_e5})
    header = {"schema": VECTOR_SCHEMA, "count": len(records), "fields": list(VECTOR_FIELDS),
              "zones": {f"{w}x{h}": list(ui_zone((w, h))) for w, h in OUTPUTS},
              "source": "scripts/parity/logo_gates.py vectors (timemap.logo_box, plan.unsafe_zone_issues)"}
    return [json.dumps(value, sort_keys=True, separators=(",", ":")) for value in [header, *records]]


def cmd_vectors(args: argparse.Namespace) -> int:
    text = "\n".join(vector_lines()) + "\n"
    if args.check:
        current = VECTORS.read_text(encoding="utf-8") if VECTORS.is_file() else ""
        if current != text:
            print(f"{VECTORS.relative_to(REPO)} is out of date; run with --write", file=sys.stderr)
            return 1
        print("vectors up to date")
        return 0
    VECTORS.parent.mkdir(parents=True, exist_ok=True)
    VECTORS.write_text(text, encoding="utf-8")
    print(f"wrote {len(text.splitlines()) - 1} vectors to {VECTORS.relative_to(REPO)}")
    return 0


# --- G5 through the compiler ---------------------------------------------------------------------


def _context(name: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    seed = json.loads((CONTEXTS / f"{name}.seed.json").read_text(encoding="utf-8"))
    words = json.loads((CONTEXTS / f"{name}.words.json").read_text(encoding="utf-8"))
    assets = json.loads((CONTEXTS / "assets.json").read_text(encoding="utf-8"))
    return seed, words, assets


def logo_doc(seed: Mapping[str, Any], asset: str, meta: Mapping[str, Any],
             transform: Mapping[str, int]) -> dict[str, Any]:
    """The seed with the logo item SetLogo writes (plan §3.2, Appendix B)."""
    doc = json.loads(json.dumps(seed))
    doc["tracks"] = [track for track in doc["tracks"] if track["kind"] != "visual"]
    doc["tracks"].append({"id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay",
                          "items": [{"id": "it_logo", "type": "image", "start": {"at": "clip_start"},
                                     "end": {"at": "clip_end"}, "transform": dict(transform),
                                     "payload": {"asset": asset, "mode": "free"}, "origin": "user"}]})
    doc["tracks"].sort(key=lambda track: {"hook": 0, "visual": 1, "audio": 2}[track["kind"]])
    doc["assets"] = {asset: dict(meta)}
    return doc


def g5_sweep(*, per_edge: int = 3) -> dict[str, Any]:
    from ai_clipper.edit_v2 import timemap as tm
    from ai_clipper.edit_v2.doc import validate_doc
    from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
    from ai_clipper.edit_v2.plan import Resources, build_plan, unsafe_zone_issues

    resources = Resources(RESOURCES_DIR)
    cases: list[dict[str, Any]] = []
    mismatches: list[dict[str, Any]] = []
    started = time.monotonic()
    for context in ("c30", "c24"):
        seed, words, store = _context(context)
        output = (seed["output"]["w"], seed["output"]["h"])
        width, height = output
        top, bottom, right = independent_zone(output)
        images = [(asset, meta) for asset, meta in store.items() if meta["kind"] == "image"]
        tall = ("sha256:" + "7" * 64, {"kind": "image", "mime": "image/png", "w": 300, "h": 600})
        images.append(tall)
        for asset, meta in images:
            assets = {asset: meta}
            for w_e5 in (4000, 16000, 40000):
                _x, _y, bw, bh = tm.logo_box(x_e5=50_000, y_e5=50_000, w_e5=w_e5, asset_w=meta["w"],
                                             asset_h=meta["h"], out_w=width, out_h=height)
                edges = {
                    "top": [(width // 3, top + d) for d in range(-per_edge, per_edge + 1)],
                    "bottom": [(width // 3, height - bottom - bh + d) for d in range(-per_edge, per_edge + 1)],
                    "right": [(width - right - bw + d, height // 2) for d in range(-per_edge, per_edge + 1)],
                    "corners": [(width - 29 * width // 720 - bw, 32 * height // 1280), (0, 0),
                                (width - bw, height - bh), (0, height - bh)],
                }
                for edge, points in edges.items():
                    for x0, y0 in points:
                        if not (0 <= x0 <= width - bw and 0 <= y0 <= height - bh):
                            continue
                        transform = {"x_e5": centre_e5(x0, bw, width), "y_e5": centre_e5(y0, bh, height),
                                     "w_e5": w_e5, "opacity_pm": 850}
                        doc = logo_doc(seed, asset, meta, transform)
                        validation = validate_doc(doc, words=words, assets=assets, seed=seed)
                        if validation.errors:
                            raise RuntimeError(f"{context} {edge}: {validation.errors[0]}")
                        plan = build_plan(doc, words=words, camera=None, assets=assets, resources=resources)
                        box = (plan.logo.x, plan.logo.y, plan.logo.w, plan.logo.h)
                        warned = any(issue.code == "unsafe_zone" and issue.ref == "it_logo"
                                     for issue in plan.warnings)
                        export = any(issue.code == "unsafe_zone" and issue.ref == "it_logo"
                                     for issue in unsafe_zone_issues(plan.doc, plan.assets, output))
                        expected = independent_unsafe(box, output)
                        record = {"context": context, "asset": [meta["w"], meta["h"]], "w_e5": w_e5,
                                  "edge": edge, "box": list(box), "expected": expected, "plan": warned,
                                  "export": export}
                        cases.append(record)
                        if warned != expected or export != expected:
                            mismatches.append(record)
    unsafe = sum(1 for case in cases if case["expected"])
    return {"gate": "G5", "task": "T3.2", "cases": len(cases), "unsafe_cases": unsafe,
            "safe_cases": len(cases) - unsafe, "mismatches": len(mismatches),
            "mismatch_detail": mismatches[:10], "pass": not mismatches and unsafe > 0 and unsafe < len(cases),
            "zone_720x1280": list(independent_zone((720, 1280))),
            "zone_1080x1920": list(independent_zone((1080, 1920))),
            "elapsed_s": round(time.monotonic() - started, 2), "toolchain": _toolchain()}


def cmd_g5(args: argparse.Namespace) -> int:
    result = g5_sweep()
    _dump(args.out, result)
    print(json.dumps({key: result[key] for key in ("cases", "unsafe_cases", "mismatches", "pass")}))
    return 0 if result["pass"] else 1


# --- synthetic logos ------------------------------------------------------------------------------


def _png_rgba(width: int, height: int, pixels: bytes) -> bytes:
    """An RGBA PNG with IHDR, IDAT and IEND only (the chunks png_strip keeps for uploads)."""
    rows = b"".join(b"\x00" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def synthetic_logo(width: int, height: int, *, hue: int) -> bytes:
    """A badge whose outer band is large black and white blocks at full alpha (so the box edge
    differs from any background by more than 16 levels after scaling and opacity), with a colour
    gradient, a translucent band and a fully transparent hole inside (the blend is measured)."""
    band = max(4, min(width, height) // 8)
    block = max(band, min(width, height) // 5)
    palette = ((0xE4, 0x4E, 0x3F), (0x3F, 0x5E, 0xFB), (0xDF, 0xFF, 0x58))
    base = palette[hue % len(palette)]
    out = bytearray(width * height * 4)
    for y in range(height):
        for x in range(width):
            i = (y * width + x) * 4
            edge = min(x, y, width - 1 - x, height - 1 - y)
            if edge < band:
                light = ((x // block) + (y // block)) % 2 == 0
                out[i:i + 4] = bytes((255, 255, 255, 255) if light else (0, 0, 0, 255))
                continue
            u = x / max(1, width - 1)
            v = y / max(1, height - 1)
            r = int(base[0] * (1 - u) + 255 * u * 0.4)
            g = int(base[1] * (1 - v) + 40 * v)
            b = int(base[2] * (0.6 + 0.4 * u))
            cx, cy = (x - width / 2) / (width / 2), (y - height / 2) / (height / 2)
            if cx * cx + cy * cy < 0.08:
                alpha = 0  # the hole
            elif abs(cy) < 0.18:
                alpha = int(90 + 120 * u)  # a translucent band
            else:
                alpha = 255
            out[i:i + 4] = bytes((min(r, 255), min(g, 255), min(b, 255), alpha))
    return _png_rgba(width, height, bytes(out))


LOGOS = {"square": (512, 512, 0), "wide": (1000, 250, 1), "tall": (300, 600, 2)}


def cmd_assets(args: argparse.Namespace) -> int:
    store = Path(args.job_dir) / "analysis" / "assets"
    store.mkdir(parents=True, exist_ok=True)
    out: dict[str, Any] = {}
    for name, (width, height, hue) in LOGOS.items():
        data = synthetic_logo(width, height, hue=hue)
        digest = hashlib.sha256(data).hexdigest()
        meta = {"kind": "image", "mime": "image/png", "w": width, "h": height}
        (store / f"{digest}.png").write_bytes(data)
        (store / f"{digest}.json").write_text(json.dumps(meta, sort_keys=True), encoding="utf-8")
        out[name] = {"asset": f"sha256:{digest}", "meta": meta}
    print(json.dumps(out, sort_keys=True))
    return 0


# --- P-LOGO scoring ---------------------------------------------------------------------------------


def _toolchain() -> dict[str, Any]:
    try:
        first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                               check=False).stdout.splitlines()
    except OSError:
        first = []
    return {"ffmpeg": first[0] if first else None, "python": sys.version.split()[0]}


def detect_box(test: Any, reference: Any, around: Mapping[str, int]) -> list[int] | None:
    """Where two same-size RGB images differ by more than LOGO_CHANGE_LEVEL, searched in the
    plan's box padded by 16 px: ``[x0, y0, x1, y1]`` (half-open) or None."""
    x0, y0 = max(0, around["x"] - 16), max(0, around["y"] - 16)
    x1 = min(test.width, around["x"] + around["w"] + 16)
    y1 = min(test.height, around["y"] + around["h"] + 16)
    found = None
    c = test.channels
    for y in range(y0, y1):
        row_a, row_b = test.row(y), reference.row(y)
        for x in range(x0, x1):
            i = x * c
            if max(abs(row_a[i + k] - row_b[i + k]) for k in range(3)) > LOGO_CHANGE_LEVEL:
                found = [x, y, x + 1, y + 1] if found is None else [
                    min(found[0], x), min(found[1], y), max(found[2], x + 1), max(found[3], y + 1)]
    return found


def box_levels(test: Any, reference: Any, box: Mapping[str, int]) -> dict[str, float]:
    total = worst = count = 0
    c = test.channels
    for y in range(box["y"], box["y"] + box["h"]):
        row_a, row_b = test.row(y), reference.row(y)
        for x in range(box["x"], box["x"] + box["w"]):
            i = x * c
            for k in range(3):
                delta = abs(row_a[i + k] - row_b[i + k])
                total += delta
                worst = max(worst, delta)
                count += 1
    return {"mean_abs": total / count if count else 0.0, "max": worst}


def _rgb(path: Path) -> Any:
    import compare

    return compare.read_png(path).rgb()


def score_case(case_dir: Path, job_dir: Path, clip_id: str, work: Path) -> list[dict[str, Any]]:
    import player_fixtures as pf

    from ai_clipper.edit_v2 import plates, preview_cli
    from ai_clipper.edit_v2 import timemap as tm

    clip = job_dir / "analysis" / "clips" / clip_id
    doc_raw = (case_dir / "doc.json").read_bytes()
    validated = preview_cli._validated(clip, doc_raw)
    plan, camera_sha = preview_cli._build(clip, validated)
    if plan.logo is None:
        raise RuntimeError(f"{case_dir.name}: the document has no logo")
    resources = preview_cli._resources()
    key = plates.plate_key(plan.doc, camera_sha256=camera_sha, toolchain_sha256=preview_cli._toolchain())
    size = tm.cell_frames(plan.fps)
    asset_path = job_dir / "analysis" / "assets" / f"{plan.logo.asset.split(':', 1)[1]}.png"
    box = {"x": plan.logo.x, "y": plan.logo.y, "w": plan.logo.w, "h": plan.logo.h}
    results = []
    for frame_dir in sorted(path for path in case_dir.iterdir() if path.is_dir()):
        n = int(frame_dir.name)
        sf = tm.out_to_src(n, plan.pieces)[1]
        k, j = divmod(sf, size)
        cell = clip / "preview" / "plates" / plates.cell_name(key, k)
        if not cell.is_file():
            raise RuntimeError(f"{case_dir.name}/{n}: plate cell {cell.name} is missing")
        out = work / case_dir.name / str(n)
        out.mkdir(parents=True, exist_ok=True)
        with_logo, without = out / "composite.png", out / "nologo.png"
        pf._execute(pf.composite_job(plan, cell=cell, j=j, n=n, resources=resources,
                                     logo=(plan.logo.asset, asset_path)), with_logo)
        pf._execute(pf.composite_job(plan, cell=cell, j=j, n=n, resources=resources), without)
        browser = _rgb(frame_dir / "browser.png")
        reference, nologo = _rgb(with_logo), _rgb(without)
        drawn = detect_box(browser, nologo, box)
        levels = box_levels(browser, reference, box)
        plan_box = [box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"]]
        record: dict[str, Any] = {"case": case_dir.name, "frame": n, "plan_box": plan_box,
                                  "browser_box": drawn, "box_exact": drawn == plan_box, **levels}
        record["pass"] = (record["box_exact"] and levels["mean_abs"] <= P_LOGO["mean_abs"]
                          and levels["max"] <= P_LOGO["max"])
        truth_path, truth_bare = frame_dir / "truth.png", frame_dir / "truth-nologo.png"
        if truth_path.is_file() and truth_bare.is_file():
            truth, bare = _rgb(truth_path), _rgb(truth_bare)
            truth_box = detect_box(truth, bare, box)
            truth_levels = box_levels(browser, truth, box)
            record["truth"] = {"box": truth_box, "box_exact": truth_box == plan_box,
                               "browser_vs_truth": truth_levels,
                               "server_vs_truth": box_levels(reference, truth, box)}
        results.append(record)
    return results


def cmd_score(args: argparse.Namespace) -> int:
    captures = Path(args.captures)
    manifest = json.loads((captures / "manifest.json").read_text(encoding="utf-8"))
    frames: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="logo-gates-") as scratch:
        for case in manifest["cases"]:
            frames.extend(score_case(captures / case["id"], Path(args.job_dir), manifest["clipId"],
                                     Path(scratch)))
    failures = [frame for frame in frames if not frame["pass"]]
    truth = [frame["truth"] for frame in frames if "truth" in frame]
    truth_failures = [frame for frame in frames if "truth" in frame and not frame["truth"]["box_exact"]]
    worst = {"mean_abs": max((f["mean_abs"] for f in frames), default=0.0),
             "max": max((f["max"] for f in frames), default=0)}
    truth_worst = {"mean_abs": max((t["browser_vs_truth"]["mean_abs"] for t in truth), default=0.0),
                   "max": max((t["browser_vs_truth"]["max"] for t in truth), default=0),
                   "server_mean_abs": max((t["server_vs_truth"]["mean_abs"] for t in truth), default=0.0),
                   "server_max": max((t["server_vs_truth"]["max"] for t in truth), default=0)}
    result = {
        "gate": "P-LOGO", "task": "T3.2", "thresholds": P_LOGO,
        "method": ("browser canvas (real player, real lane, pinned Chrome) vs the server composite of "
                   "the same plate-cell frame with the compiler's strings before the 4:2:0 step; "
                   "box from the browser against the server's logo-less composite (> 16 levels)"),
        "job": manifest.get("job"), "clip": manifest["clipId"], "browser": manifest.get("browser"),
        "output": manifest.get("output"), "cases": len(manifest["cases"]), "frames": len(frames),
        "worst": worst, "failures": failures, "pass": bool(frames) and not failures,
        "truth_frame": {
            "method": ("POST preview/frame (the final graph with the 4:2:0 step and the intra encode) "
                       "with and without the logo; box where they differ by > 16 levels"),
            "frames": len(truth), "box_exact": len(truth) - len(truth_failures),
            "box_failures": [{"case": f["case"], "frame": f["frame"], **f["truth"]} for f in truth_failures],
            "worst": truth_worst, "box_pass": bool(truth) and not truth_failures,
            "levels_within_p_logo": truth_worst["max"] <= P_LOGO["max"]
            and truth_worst["mean_abs"] <= P_LOGO["mean_abs"],
        },
        "frames_detail": frames, "toolchain": _toolchain(),
    }
    _dump(args.out, result)
    print(json.dumps({"frames": len(frames), "worst": worst, "pass": result["pass"],
                      "truth": result["truth_frame"]["box_pass"], "truth_worst": truth_worst}))
    return 0 if result["pass"] and result["truth_frame"]["box_pass"] else 1


# --- main ------------------------------------------------------------------------------------------


def _dump(target: str | None, value: Any) -> None:
    text = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if target:
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        Path(target).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    vectors = sub.add_parser("vectors")
    mode = vectors.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    vectors.set_defaults(func=cmd_vectors)
    g5 = sub.add_parser("g5")
    g5.add_argument("--out")
    g5.set_defaults(func=cmd_g5)
    assets = sub.add_parser("assets")
    assets.add_argument("--job-dir", required=True)
    assets.set_defaults(func=cmd_assets)
    score = sub.add_parser("score")
    score.add_argument("--captures", required=True)
    score.add_argument("--job-dir", required=True)
    score.add_argument("--out")
    score.set_defaults(func=cmd_score)
    args = parser.parse_args(argv)
    os.umask(0o022)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
