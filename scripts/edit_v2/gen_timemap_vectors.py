#!/usr/bin/env python3
"""Generate ``tests/fixtures/edit_v2/timemap-vectors.json`` (plan §11.1 T1.0).

The vectors are shared by the Python time map (``ai_clipper.edit_v2.timemap``) and its browser
mirror (``web/lib/editor/timemap.mjs``, T2.5). Expected values come from independent reference
arithmetic in this file (``fractions.Fraction`` and frame-by-frame expansion), never from the
module under test. ``now_ms`` is by definition FFmpeg's IEEE-double expression; the tests check
it against a compiled C copy of ``vf_subtitles`` and against FFmpeg itself.

The output is deterministic: a fixed RNG seed and a fixed layout (one compact JSON value per
line), so a second run is byte-identical.

Usage::

    python scripts/edit_v2/gen_timemap_vectors.py --write     # regenerate the fixture
    python scripts/edit_v2/gen_timemap_vectors.py --check     # exit 1 when it is stale
    python scripts/edit_v2/gen_timemap_vectors.py --evidence OUT.json --label local
        # measure safe_cs over 3 h at eight rates and probe FFmpeg's ass filter on the hazard
        # frames; the run is stored under ``label`` in OUT.json (other labels are kept)
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "tests" / "fixtures" / "edit_v2" / "timemap-vectors.json"
SCHEMA = "potongin.timemap-vectors/1"
RNG_SEED = 20260924
RATES = ((24, 1), (25, 1), (30, 1), (50, 1), (60, 1), (24000, 1001), (30000, 1001), (60000, 1001))
DOC_RATES = ((24, 1), (25, 1), (30, 1), (24000, 1001), (30000, 1001))
THREE_HOURS_MS = 3 * 3600 * 1000
MIN_PIECE_FRAMES = 2


# --- reference arithmetic (independent of the module under test) ------------------------------


def frame_ms(k: int, fps: tuple[int, int]) -> Fraction:
    return Fraction(k * 1000 * fps[1], fps[0])


def ref_pieces(doc: dict) -> list[dict]:
    """Frame-by-frame expansion: mark removed frames, keep runs of >= 2 frames, lay out."""
    result = []
    out_f0 = 0
    removals = doc["main"]["removals"]
    for segment in doc["main"]["segments"]:
        removed = set()
        for removal in removals:
            if removal["seg"] == segment["id"]:
                removed.update(range(removal["in_sf"], removal["out_sf"]))
        run: list[int] = []
        for sf in range(segment["in_sf"], segment["out_sf"] + 1):
            if sf < segment["out_sf"] and sf not in removed:
                run.append(sf)
                continue
            if len(run) >= MIN_PIECE_FRAMES:
                frames = len(run)
                result.append(
                    {
                        "i": len(result),
                        "seg": segment["id"],
                        "role": segment["role"],
                        "inSf": run[0],
                        "outSf": run[-1] + 1,
                        "outF0": out_f0,
                        "frames": frames,
                    }
                )
                out_f0 += frames
            run = []
    return result


def ref_word_frames(s_ms: int, e_ms: int, pieces: list[dict], fps: tuple[int, int]):
    mid = Fraction(s_ms + e_ms, 2)
    rate = Fraction(fps[0], 1000 * fps[1])
    for piece in pieces:
        lo = frame_ms(piece["inSf"], fps)
        if lo <= mid < frame_ms(piece["outSf"], fps):
            last = piece["outF0"] + piece["frames"]
            on = piece["outF0"] + math.floor((s_ms - lo) * rate + Fraction(1, 2))
            off = piece["outF0"] + math.floor((e_ms - lo) * rate + Fraction(1, 2))
            on = min(max(on, piece["outF0"]), last)
            off = max(min(max(off, piece["outF0"]), last), on)
            return [on, off]
    return None


def ref_smp(n: int, fps: tuple[int, int], rate: int) -> int:
    return math.floor(Fraction(n * rate * fps[1], fps[0]))


def ref_speech_spans(words, pieces: list[dict], fps: tuple[int, int]) -> list[list[int]]:
    spans = []
    segments: list[str] = []
    for piece in pieces:
        if piece["seg"] not in segments:
            segments.append(piece["seg"])
    for seg in segments:
        scope = [piece for piece in pieces if piece["seg"] == seg]
        for s_ms, e_ms in words:
            frames = ref_word_frames(s_ms, e_ms, scope, fps)
            if frames is not None and frames[1] > frames[0]:
                spans.append([ref_smp(frames[0], fps, 48000), ref_smp(frames[1], fps, 48000)])
    return sorted(spans)


def ref_now_ms(n: int, fps: tuple[int, int]) -> int:
    # FFmpeg libavfilter/vf_subtitles.c: double time_ms = pts * av_q2d(tb) * 1000; truncated to
    # long long by ass_render_frame. tb = den/num after settb.
    return int(float(n) * (fps[1] / fps[0]) * 1000)


def exact_floor_ms(n: int, fps: tuple[int, int]) -> int:
    return n * 1000 * fps[1] // fps[0]


def ref_round_half_up(value: Fraction) -> int:
    return math.floor(value + Fraction(1, 2))


def ref_logo_box(x_e5, y_e5, w_e5, asset_w, asset_h, out_w, out_h) -> list[int]:
    w_px = ref_round_half_up(Fraction(w_e5 * out_w, 100_000))
    h_px = ref_round_half_up(Fraction(w_px * asset_h, asset_w))
    x0 = ref_round_half_up(Fraction(x_e5 * out_w, 100_000) - Fraction(w_px, 2))
    y0 = ref_round_half_up(Fraction(y_e5 * out_h, 100_000) - Fraction(h_px, 2))
    return [x0, y0, w_px, h_px]


def frames_in(ms: int, fps: tuple[int, int]) -> int:
    return ms * fps[0] // (1000 * fps[1]) + 1


def hazards(fps: tuple[int, int], frames: int) -> list[int]:
    return [n for n in range(frames) if ref_now_ms(n, fps) != exact_floor_ms(n, fps)]


# --- cases -------------------------------------------------------------------------------------


def _doc(segments, removals) -> dict:
    return {
        "main": {
            "segments": [
                {"id": seg_id, "role": role, "in_sf": in_sf, "out_sf": out_sf}
                for seg_id, role, in_sf, out_sf in segments
            ],
            "removals": [
                {"id": f"rm_{index + 1}", "seg": seg, "in_sf": in_sf, "out_sf": out_sf}
                for index, (seg, in_sf, out_sf) in enumerate(removals)
            ],
        }
    }


def _handmade() -> list[tuple[str, tuple[int, int], dict]]:
    ntsc = (30000, 1001)
    return [
        (
            "plan_example",
            ntsc,
            _doc(
                [("seg_co", "cold_open", 38210, 38345), ("seg_b1", "body", 37215, 39284)],
                [("seg_b1", 37483, 37556), ("seg_b1", 37813, 37848)],
            ),
        ),
        ("seed_no_cold_open", (25, 1), _doc([("seg_b1", "body", 15000, 20000)], [])),
        (
            "slivers_dropped",
            (30, 1),
            _doc([("seg_b1", "body", 100, 200)], [("seg_b1", 101, 150), ("seg_b1", 151, 160),
                                                  ("seg_b1", 162, 199)]),
        ),
        (
            "touching_and_overlapping",
            (24, 1),
            _doc([("seg_b1", "body", 100, 400)], [("seg_b1", 90, 110), ("seg_b1", 110, 120),
                                                  ("seg_b1", 115, 130), ("seg_b1", 390, 450)]),
        ),
        (
            "cold_open_inside_body",
            (24000, 1001),
            _doc([("seg_co", "cold_open", 2200, 2300), ("seg_b1", "body", 2000, 2800)],
                 [("seg_b1", 2250, 2260)]),
        ),
        (
            "cold_open_before_body",
            ntsc,
            _doc([("seg_co", "cold_open", 900, 1050), ("seg_b1", "body", 3000, 4800)],
                 [("seg_co", 1000, 1010), ("seg_b1", 3000, 3050), ("seg_b1", 4700, 4800)]),
        ),
        (
            "three_hours_in",
            ntsc,
            _doc([("seg_b1", "body", 323000, 324500)], [("seg_b1", 323500, 323620)]),
        ),
        (
            "fully_removed_cold_open",
            (25, 1),
            _doc([("seg_co", "cold_open", 500, 560), ("seg_b1", "body", 100, 400)],
                 [("seg_co", 500, 560), ("seg_zz", 100, 400), ("seg_b1", 500, 520)]),
        ),
    ]


def _random_doc(rng: random.Random) -> dict:
    segments = []
    body_in = rng.randint(0, 200_000)
    body_out = body_in + rng.randint(2, 6000)
    if rng.random() < 0.5:
        co_in = rng.choice((rng.randint(0, 210_000), rng.randint(body_in, body_out)))
        segments.append(("seg_co", "cold_open", co_in, co_in + rng.randint(15, 240)))
    segments.append(("seg_b1", "body", body_in, body_out))
    removals = []
    for seg_id, _role, in_sf, out_sf in segments:
        cursor = in_sf
        while cursor < out_sf and rng.random() < 0.85:
            start = cursor + rng.randint(0, 120)
            end = start + rng.randint(1, 90)
            if end > out_sf:
                break
            removals.append((seg_id, start, end))
            cursor = end + rng.randint(0, 3)
    return _doc(segments, removals)


def _out_samples(rng: random.Random, pieces: list[dict]) -> list[list[int]]:
    total = sum(piece["frames"] for piece in pieces)
    if total == 0:
        return []
    picks = {0, total - 1}
    for piece in pieces:
        picks.add(piece["outF0"])
        picks.add(piece["outF0"] + piece["frames"] - 1)
    picks.update(rng.randrange(total) for _ in range(3))
    rows = []
    for n in sorted(picks)[:10]:
        piece = next(p for p in pieces if p["outF0"] <= n < p["outF0"] + p["frames"])
        rows.append([n, piece["i"], piece["inSf"] + n - piece["outF0"]])
    return rows


def _words(rng: random.Random, doc: dict, pieces: list[dict], fps) -> list[list[int]]:
    words = []
    anchors = [segment["in_sf"] for segment in doc["main"]["segments"]]
    anchors += [segment["out_sf"] for segment in doc["main"]["segments"]]
    anchors += [piece["inSf"] for piece in pieces] + [piece["outSf"] for piece in pieces]
    for _ in range(12):
        edge = frame_ms(rng.choice(anchors), fps)
        s_ms = max(0, math.floor(edge) + rng.randint(-400, 400))
        e_ms = s_ms + rng.choice((0, 0, rng.randint(1, 80), rng.randint(80, 900)))
        words.append([s_ms, e_ms])
    return words


def build() -> dict:
    rng = random.Random(RNG_SEED)
    named = _handmade()
    for index in range(32):
        named.append((f"random_{index:02d}", rng.choice(DOC_RATES), _random_doc(rng)))
    cases = []
    checks = 0
    for name, fps, doc in named:
        pieces = ref_pieces(doc)
        words = _words(rng, doc, pieces, fps)
        seg_ids = [segment["id"] for segment in doc["main"]["segments"]]
        word_rows = []
        for s_ms, e_ms in words:
            scope_id = rng.choice([None, *seg_ids])
            scope = pieces if scope_id is None else [p for p in pieces if p["seg"] == scope_id]
            word_rows.append(
                {"scope": scope_id, "s_ms": s_ms, "e_ms": e_ms,
                 "expect": ref_word_frames(s_ms, e_ms, scope, fps)}
            )
        out_rows = _out_samples(rng, pieces)
        cases.append(
            {
                "name": name,
                "fps": list(fps),
                "doc": doc,
                "pieces": pieces,
                "total_frames": sum(piece["frames"] for piece in pieces),
                "out_to_src": out_rows,
                "word_frames": word_rows,
                "speech_words": words,
                "speech_spans": ref_speech_spans(words, pieces, fps),
            }
        )
        checks += 3 + len(out_rows) + len(word_rows)

    ten_hours = 10 * 3600 * 1000
    smp_rows = []
    for fps in RATES:
        for n in (0, 1, 2, 29, 30, 1000, 30000, 107892, frames_in(ten_hours, fps)):
            for rate in (48000, 44100):
                smp_rows.append({"in": [fps[0], fps[1], n, rate], "expect": ref_smp(n, fps, rate)})
    floor_rows, ceil_rows = [], []
    for fps in RATES:
        values = {0, 1, 33, 34, 1000, 1001, 1241930, 1309400, 3901120, ten_hours}
        for k in (1, 7, 30, 1001, 30000):
            edge = frame_ms(k, fps)
            values.update((math.floor(edge) - 1, math.floor(edge), math.ceil(edge),
                           math.ceil(edge) + 1))
        for ms in sorted(values):
            floor_rows.append({"in": [fps[0], fps[1], ms],
                               "expect": math.floor(Fraction(ms * fps[0], 1000 * fps[1]))})
            ceil_rows.append({"in": [fps[0], fps[1], ms],
                              "expect": math.ceil(Fraction(ms * fps[0], 1000 * fps[1]))})
    now_rows, safe_rows = [], []
    for fps in RATES:
        frames = frames_in(THREE_HOURS_MS, fps)
        hazard_list = hazards(fps, frames)
        picks = set(range(12)) | {frames - 1, frames // 2}
        picks.update(hazard_list[:25])
        picks.update(hazard_list[-5:])
        picks.update(n + 1 for n in hazard_list[:5])
        picks.update(rng.randrange(frames) for _ in range(6))
        for n in sorted(picks):
            now = ref_now_ms(n, fps)
            now_rows.append({"in": [fps[0], fps[1], n], "expect": now,
                             "hazard": now != exact_floor_ms(n, fps)})
            safe_rows.append({"in": [fps[0], fps[1], n], "expect": (now - 2) // 10})
    cell_rows = [{"in": list(fps), "expect": 2 * math.ceil(Fraction(fps[0], fps[1]))}
                 for fps in RATES]
    round_rows = []
    for numerator, denominator in ((5, 2), (-5, 2), (-7, 2), (7, 3), (0, 9), (1, 2), (-1, 2),
                                   (3, 2), (-3, 2), (999, 1000), (-999, 1000), (1500, 1000),
                                   (-1500, 1000), (2**40 + 1, 2), (123456789, 1001),
                                   (-123456789, 1001)):
        round_rows.append({"in": [numerator, denominator],
                           "expect": ref_round_half_up(Fraction(numerator, denominator))})
    logo_rows = []
    logo_inputs = [
        (88000, 7000, 16000, 512, 512, 720, 1280),
        (92000, 50000, 16000, 512, 512, 720, 1280),
        (50000, 50000, 40000, 800, 200, 1080, 1920),
        (4000, 4000, 4000, 300, 700, 720, 1280),
        (100000, 100000, 40000, 1024, 1024, 720, 1280),
        (0, 0, 16000, 512, 512, 720, 1280),
        (33333, 66667, 12345, 999, 333, 1080, 1920),
    ]
    for _ in range(9):
        logo_inputs.append((rng.randint(0, 100000), rng.randint(0, 100000),
                            rng.randint(4000, 40000), rng.randint(16, 1024),
                            rng.randint(16, 1024), *rng.choice(((720, 1280), (1080, 1920)))))
    for x_e5, y_e5, w_e5, asset_w, asset_h, out_w, out_h in logo_inputs:
        logo_rows.append(
            {"in": {"x_e5": x_e5, "y_e5": y_e5, "w_e5": w_e5, "asset_w": asset_w,
                    "asset_h": asset_h, "out_w": out_w, "out_h": out_h},
             "expect": ref_logo_box(x_e5, y_e5, w_e5, asset_w, asset_h, out_w, out_h)}
        )
    scalar = {
        "smp": smp_rows,
        "sf_floor": floor_rows,
        "sf_ceil": ceil_rows,
        "now_ms": now_rows,
        "safe_cs": safe_rows,
        "cell_frames": cell_rows,
        "div_round_half_up": round_rows,
        "logo_box": logo_rows,
    }
    checks += sum(len(rows) for rows in scalar.values())
    counts = {"cases": len(cases), **{name: len(rows) for name, rows in scalar.items()},
              "total": checks}
    return {
        "schema": SCHEMA,
        "generator": "scripts/edit_v2/gen_timemap_vectors.py",
        "rng_seed": RNG_SEED,
        "notes": (
            "Piece fields use the plan DTO names (inSf, outSf, outF0). smp rows are "
            "[num, den, n, rate]; sf_floor/sf_ceil [num, den, ms]; now_ms/safe_cs [num, den, n] "
            "(hazard: the IEEE-double time is one below the exact time); word_frames scope null "
            "means all pieces, otherwise only that segment's pieces."
        ),
        "counts": counts,
        "cases": cases,
        **scalar,
    }


def _compact(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render() -> bytes:
    data = build()
    lines = ["{"]
    keys = list(data)
    for position, key in enumerate(keys):
        value = data[key]
        tail = "," if position < len(keys) - 1 else ""
        if isinstance(value, list):
            lines.append(f"  {json.dumps(key)}: [")
            lines.extend(
                f"    {_compact(item)}{',' if index < len(value) - 1 else ''}"
                for index, item in enumerate(value)
            )
            lines.append(f"  ]{tail}")
        else:
            lines.append(f"  {json.dumps(key)}: {_compact(value)}{tail}")
    lines.append("}")
    return ("\n".join(lines) + "\n").encode("utf-8")


# --- evidence ----------------------------------------------------------------------------------


def _safe_cs_stats() -> dict:
    stats = {}
    for fps in RATES:
        frames = frames_in(THREE_HOURS_MS, fps)
        failures = 0
        margin_prev = margin_now = 10
        previous = ref_now_ms(0, fps)
        for n in range(1, frames):
            current = ref_now_ms(n, fps)
            boundary = (current - 2) // 10 * 10
            if not previous < boundary <= current:
                failures += 1
            margin_prev = min(margin_prev, boundary - previous)
            margin_now = min(margin_now, current - boundary)
            previous = current
        stats[f"{fps[0]}/{fps[1]}"] = {
            "frames": frames,
            "hazards": len(hazards(fps, frames)),
            "failures": failures,
            "min_margin_after_previous_frame_ms": margin_prev,
            "min_margin_before_frame_ms": margin_now,
        }
    return stats


def _ass_time(cs: int) -> str:
    cs = max(cs, 0)
    hours, rest = divmod(cs, 360000)
    minutes, rest = divmod(rest, 6000)
    seconds, cents = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{cents:02d}"


def _probe_ass(ffmpeg: str, workdir: Path, fps, first: int, left_cs: int, right_cs: int):
    header = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 16\nPlayResY: 16\nWrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Default,DejaVu Sans,10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = "".join(
        f"Dialogue: 0,{_ass_time(cs)},9:00:00.00,Default,,0,0,0,,"
        f"{{\\pos({x},0)\\p1}}m 0 0 l 8 0 8 16 0 16{{\\p0}}\n"
        for cs, x in ((left_cs, 0), (right_cs, 8))
    )
    (workdir / "probe.ass").write_text(header + events, encoding="utf-8")
    graph = (
        f"color=c=black:s=16x16:r={fps[0]}/{fps[1]},trim=end_frame=3,"
        f"settb={fps[1]}/{fps[0]},setpts=PTS+{first},ass=filename=probe.ass"
    )
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-f",
         "lavfi", "-i", graph, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        cwd=workdir, capture_output=True, check=True,
    )
    frames = [result.stdout[i : i + 256] for i in range(0, len(result.stdout), 256)]
    return [(frame[8 * 16 + 3] > 128, frame[8 * 16 + 12] > 128) for frame in frames]


def _ffmpeg_probe_stats(ffmpeg: str) -> dict:
    stats = {}
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for fps in RATES:
            frames = frames_in(THREE_HOURS_MS, fps)
            hazard_list = hazards(fps, frames)
            hazard_set = set(hazard_list)
            aligned = [n for n in hazard_list if (n * 1000 * fps[1]) % (fps[0] * 10) == 0]
            controls = []
            for n in range(1, frames):
                if (n * 1000 * fps[1]) % (fps[0] * 10) == 0 and n not in hazard_set:
                    controls.append(n)
                    if len(controls) == 3:
                        break
            chosen = aligned[:4] + aligned[-2:] + controls
            mismatches = 0
            for n in chosen:
                exact_cs = exact_floor_ms(n, fps) // 10
                safe = (ref_now_ms(n, fps) - 2) // 10
                seen = _probe_ass(ffmpeg, workdir, fps, n - 1, exact_cs, safe)
                hazard = ref_now_ms(n, fps) < exact_cs * 10
                expected = [(False, False), (not hazard, True), (True, True)]
                mismatches += seen != expected
            stats[f"{fps[0]}/{fps[1]}"] = {
                "hazard_frames_probed": sum(1 for n in chosen if n in hazard_set),
                "control_frames_probed": sum(1 for n in chosen if n not in hazard_set),
                "mismatches": mismatches,
            }
    return stats


def _toolchain(ffmpeg: str | None) -> dict:
    info: dict = {"python": sys.version.split()[0]}
    if ffmpeg:
        first = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=False)
        info["ffmpeg"] = first.stdout.splitlines()[0] if first.stdout else None
    dpkg = shutil.which("dpkg-query")
    if dpkg:
        for package in ("libass9", "libfreetype6", "libharfbuzz0b", "libfribidi0", "fontconfig"):
            result = subprocess.run([dpkg, "-W", "-f=${Version}\n", package],
                                    capture_output=True, text=True, check=False)
            versions = result.stdout.split()
            info[package] = versions[0] if versions else None
    return info


def evidence(path: Path, label: str, ffmpeg: str | None) -> dict:
    run: dict = {"toolchain": _toolchain(ffmpeg), "safe_cs_3h": _safe_cs_stats()}
    if ffmpeg:
        filters = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True,
                                 text=True, check=False).stdout
        if " ass " in filters:
            run["ffmpeg_ass_probe"] = _ffmpeg_probe_stats(ffmpeg)
    data = {"task": "T1.0", "gate": "now_ms/safe_cs", "runs": {}}
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    data["runs"][label] = run
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--evidence", type=Path)
    parser.add_argument("--label", default="local")
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg"))
    args = parser.parse_args(argv)
    if args.evidence:
        run = evidence(args.evidence, args.label, args.ffmpeg)
        failures = sum(item["failures"] for item in run["safe_cs_3h"].values())
        failures += sum(item["mismatches"] for item in run.get("ffmpeg_ass_probe", {}).values())
        return 1 if failures else 0
    data = render()
    if args.write:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(data)
        return 0
    return 0 if OUTPUT.exists() and OUTPUT.read_bytes() == data else 1


if __name__ == "__main__":
    raise SystemExit(main())
