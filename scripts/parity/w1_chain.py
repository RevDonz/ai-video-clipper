"""W1 exit: the full chain on the synthetic V3 job (plan §11.1 T1.Z "Steps").

seed → plan → ``reference`` + ``final`` for the 3 clips × 3 layouts (face-track with a stubbed
camera plan) → verify, all through the production modules:

1. ``scripts/editor_fixture/make_job.py`` writes the synthetic ``main`` job (180 s barcode +
   column-ruler source at 29.97 with the tone-burst speech of the Indonesian transcript).
2. ``python -m ai_clipper.edit_v2.api prepare_job`` (the CLI the Node routes call) persists
   ``source.json``, words, peaks and ``seed.json`` through ``seed.prepare_legacy_job``; every
   seed must pass ``doc.validate_doc`` (T1.5's integration gate).
3. Per clip and layout (``fit_blur`` is the seed; ``fill_center`` and ``camera`` are revision 1
   documents that change only ``layout.default.mode``): ``plan.build_plan`` with the real caption
   track and envelopes, the render key with ``resources/toolchain.json`` when the image wrote
   it, ``compile_job`` + ``execute.run`` for ``final`` and ``reference``.
4. Checks: ``verify.verify_output`` (G1, G2, G5 warnings) on every final; frame and sample
   counts of every reference; the barcode frame index of every decodable reference frame against
   the whole-file grid (P-FRAME inside the chain; frames under the hook of the crop layouts are
   not checked and are counted separately); ``audio_preview`` PCM == ``reference`` PCM
   (P-AUD); preview ASS == export ASS and a second ``build_plan`` gives the same plan sha
   (G-DET); R10: the seed's content equals the seed, a layout change does not.

Stdlib only; run it in the production image (``--cpus 4``)::

    docker run --rm --cpus 4 --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/tests \\
        -e HOME=/tmp ai-video-clipper:editor-w1 /app/.venv/bin/python scripts/parity/w1_chain.py \\
        --evidence docs/editor/evidence/W1

``PYTHONPATH`` names only ``tests``: ``ai_clipper`` then comes from the image (``/app/src``) and
the resources from ``/app/resources``, including the build's ``toolchain.json``.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

from support import edit_v2_media as media

from ai_clipper.edit_v2 import camera as camera_module
from ai_clipper.edit_v2 import (
    compile_ffmpeg,
    doc,
    errors,
    execute,
    loudness,
    store,
    verify,
)
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import (
    Resources,
    build_plan,
    render_key,
    toolchain_sha256,
)

LAYOUTS = ("fit_blur", "fill_center", "camera")
TASK = "T1.Z"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


make_job = _load("editor_fixture_make_job", ROOT / "scripts" / "editor_fixture" / "make_job.py")
frame_identity = _load("edit_v2_frame_identity", ROOT / "scripts" / "parity" / "frame_identity.py")


def api_cli(jobs_root: Path, envelope: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """``python -m ai_clipper.edit_v2.api`` exactly as the routes run it."""
    env = {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8",
           "HOME": os.environ.get("HOME", "/tmp"), "JOBS_ROOT": str(jobs_root)}
    if "PYTHONPATH" in os.environ:
        env["PYTHONPATH"] = os.environ["PYTHONPATH"]
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.api"],
                            input=json.dumps(envelope).encode(), capture_output=True, env=env,
                            timeout=1800, check=False)
    return result.returncode, json.loads(result.stdout or b"{}")


def _count(path: Path) -> dict[str, int]:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
         "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    samples = len(media.read_pcm(path)) // 2
    return {"frames": int(probe.split(",")[0]), "samples": samples}


def _pcm_md5(path: Path) -> str:
    return hashlib.md5(media.read_pcm(path).tobytes()).hexdigest()


def _run(job, out: Path | None) -> float:
    if out is None:
        return execute.run(job, output_fd=None, timeout_s=1800).elapsed_s
    fd = os.open(out, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        return execute.run(job, output_fd=fd, timeout_s=1800).elapsed_s
    finally:
        os.close(fd)


def _hook_frames(plan) -> range:
    """Output frames where the hook is drawn (it covers the index bands of the crop layouts)."""
    for track in plan.doc["tracks"]:
        if track["kind"] == "hook" and track["items"]:
            item = track["items"][0]
            start = item["start"].get("f", 0)
            return range(start, min(start + item["dur_f"], plan.total_frames))
    return range(0)


def _frame_check(path: Path, plan, grid: list[int | None], layout: str,
                 source_size: tuple[int, int]) -> dict[str, int]:
    """Barcode frame index of every reference frame against the grid. Frames under the hook
    are excluded from the gate where the hook covers the bands (the crop layouts)."""
    case = frame_identity.Case("chain", plan.fps.to_json(), 0, layout, source_size=source_size,
                               output=plan.output)
    decode = frame_identity.index_decoder(case)
    masked = _hook_frames(plan) if layout != "fit_blur" else range(0)
    checked = undecodable = mismatches = under_hook = 0
    for n, plane in enumerate(frame_identity.iter_gray_frames(path, plan.output)):
        if n in masked:
            under_hook += 1
            continue
        value = decode(plane)
        if value is None:
            undecodable += 1
            continue
        checked += 1
        mismatches += value != grid[tm.out_to_src(n, plan.pieces)[1]]
    return {"frames_checked": checked, "undecodable": undecodable, "mismatches": mismatches,
            "masked_under_hook": under_hook}


def chain(work: Path, size: tuple[int, int]) -> dict[str, Any]:
    index = make_job.build(work, size=size, only=["main"])
    entry = index["jobs"]["main"]
    jobs_root = work / "jobs"
    job_dir = work / entry["dir"]
    source = work / entry["source"]
    resources = Resources(RESOURCES_DIR)
    try:
        toolchain = toolchain_sha256(resources)
    except FileNotFoundError:
        toolchain = None
    code, prepared = api_cli(jobs_root, {"op": "prepare_job", "jobId": entry["id"]})
    report: dict[str, Any] = {
        "prepare_exit": code, "prepare": prepared, "toolchain_sha256": toolchain,
        "composite": compile_ffmpeg.COMPOSITE_FORMAT, "clips": [],
    }
    code, listing = api_cli(jobs_root, {"op": "clips", "jobId": entry["id"]})
    report["clips_exit"] = code
    report["openable"] = [clip["openable"] for clip in listing.get("clips", [])]
    grid = media.grid_indices(source, tuple(entry["fps"]))
    source_size = size
    for clip in prepared.get("clips", []):
        clip_dir = job_dir / "analysis" / "clips" / clip["clipId"]
        seed_doc, seed_etag = store.seed(clip_dir)
        words = store.load_words(clip_dir, seed_doc["base"]["words"]["sha256"])
        seed_validation = doc.validate_doc(seed_doc, words=words, assets={}, seed=seed_doc)
        fps = tm.Fps.from_json(seed_doc["output"]["fps"])
        output = (seed_doc["output"]["w"], seed_doc["output"]["h"])
        camera = camera_module.build_camera_plan(
            source, tuple(seed_doc["base"]["window_ms"]), fps, out_w=output[0], out_h=output[1],
            detector=make_job._stub_detector)
        row: dict[str, Any] = {
            "clip_id": clip["clipId"], "index": clip["index"],
            "seed_valid": seed_validation.ok,
            "seed_errors": [issue.code for issue in seed_validation.errors],
            "seed_warnings": sorted({issue.code for issue in seed_validation.warnings}),
            "cold_open": any(s["role"] == "cold_open" for s in seed_doc["main"]["segments"]),
            "hook": any(t["kind"] == "hook" for t in seed_doc["tracks"]),
            "pack": seed_doc["captions"]["pack"]["id"],
            "camera_no_face_spans": len(camera["no_face"]),
            "layouts": {},
        }
        for layout in LAYOUTS:
            document = copy.deepcopy(seed_doc)
            if layout != seed_doc["layout"]["default"]["mode"]:
                document["revision"] = 1
                document["parent_sha256"] = seed_etag
                document["layout"]["default"]["mode"] = layout
                document["audit"]["last_command"] = "SetLayout"
            validation = doc.validate_doc(document, words=words, assets={}, seed=seed_doc)
            used_camera = camera if layout == "camera" else None
            plan = build_plan(document, words=words, camera=used_camera, assets={},
                              resources=resources)
            again = build_plan(copy.deepcopy(document), words=words, camera=used_camera,
                               assets={}, resources=resources)
            measured = None
            if loudness.needs_measurement(document):  # never for these seeds (revision-0 audio)
                raise AssertionError("the synthetic seeds have no music and no source gain")
            key = None if toolchain is None else render_key(
                plan, size=output, quality="standar", measure_sha=None, toolchain_sha=toolchain)
            final_job = compile_ffmpeg.compile_job(plan, mode="final", source=source,
                                                   assets_root=job_dir / "analysis" / "assets",
                                                   loudness=measured)
            frame_job = compile_ffmpeg.compile_job(plan, mode="frame", source=source,
                                                   assets_root=job_dir / "analysis" / "assets",
                                                   frame=plan.total_frames // 2)
            final_path = work / f"{clip['index']}-{layout}.mp4"
            final_s = _run(final_job, final_path)
            fd = os.open(final_path, os.O_RDONLY)
            try:
                report_v = verify.verify_output(fd, plan, size=output, normalize=False)
            except errors.VerificationFailed as failure:
                report_v = failure.report
            finally:
                os.close(fd)
            gates = {gate.name: gate.to_json() for gate in report_v.gates}
            reference_job = compile_ffmpeg.compile_job(plan, mode="reference", source=source,
                                                       assets_root=job_dir / "analysis" / "assets",
                                                       loudness=measured)
            reference_path = work / f"{clip['index']}-{layout}.mkv"
            reference_s = _run(reference_job, reference_path)
            counts = _count(reference_path)
            frames = _frame_check(reference_path, plan, grid, layout, source_size)
            result: dict[str, Any] = {
                "revision": document["revision"],
                "valid": validation.ok,
                "errors": [issue.code for issue in validation.errors],
                "plan_sha256": plan.plan_sha256,
                "plan_deterministic": plan.plan_sha256 == again.plan_sha256,
                "render_key": key,
                "content_equals_seed": doc.content_equals_seed(document, seed_doc),
                "pieces": len(plan.pieces),
                "total_frames": plan.total_frames,
                "total_samples": plan.total_samples,
                "final_s": round(final_s, 2),
                "reference_s": round(reference_s, 2),
                "clip_s": round(plan.total_frames * fps.den / fps.num, 3),
                "G1": gates["G1"]["ok"], "G2": gates["G2"]["ok"],
                "verify_ok": report_v.ok,
                "G5_warnings": sorted({issue.code for issue in report_v.warnings}),
                "plan_warnings": sorted({issue.code.split(":", 1)[0] for issue in plan.warnings}),
                "reference_frames": counts["frames"], "reference_samples": counts["samples"],
                "reference_counts_exact": (counts["frames"] == plan.total_frames
                                           and counts["samples"] == plan.total_samples),
                "p_frame": frames,
                "preview_ass_equals_export": (frame_job.sidecars["captions.ass"]
                                              == final_job.sidecars["captions.ass"]
                                              == reference_job.sidecars["captions.ass"]),
            }
            if layout == "fit_blur":
                preview_job = compile_ffmpeg.compile_job(
                    plan, mode="audio_preview", source=source,
                    assets_root=job_dir / "analysis" / "assets", loudness=measured)
                preview_path = work / f"{clip['index']}-preview.flac"
                _run(preview_job, preview_path)
                result["p_aud_preview_equals_reference"] = (_pcm_md5(preview_path)
                                                            == _pcm_md5(reference_path))
                preview_path.unlink()
            reference_path.unlink()
            final_path.unlink()
            row["layouts"][layout] = result
        report["clips"].append(row)
    return report


def summarise(report: dict[str, Any]) -> dict[str, Any]:
    renders = [(clip["index"], layout, result) for clip in report["clips"]
               for layout, result in clip["layouts"].items()]
    fit_blur = [result for _i, layout, result in renders if layout == "fit_blur"]
    checks = {
        "prepare_ok": report["prepare_exit"] == 0 and len(report["prepare"].get("clips", [])) == 3,
        "all_openable": report["openable"] == [True, True, True],
        "seeds_valid": all(clip["seed_valid"] for clip in report["clips"]),
        "documents_valid": all(result["valid"] for _i, _l, result in renders),
        "renders": len(renders) == 9,
        "g1_g2": all(result["G1"] and result["G2"] for _i, _l, result in renders),
        "reference_counts_exact": all(result["reference_counts_exact"] for _i, _l, result in renders),
        "p_frame_zero_mismatches": all(result["p_frame"]["mismatches"] == 0
                                       for _i, _l, result in renders),
        "p_frame_fully_decoded": all(result["p_frame"]["undecodable"] == 0
                                     for _i, _l, result in renders),
        "p_aud": all(result["p_aud_preview_equals_reference"] for result in fit_blur),
        "g_det": all(result["plan_deterministic"] and result["preview_ass_equals_export"]
                     for _i, _l, result in renders),
        "r10_seed_is_seed": all(result["content_equals_seed"] == (result["revision"] == 0)
                                for _i, _l, result in renders),
        "render_key_with_toolchain": report["toolchain_sha256"] is not None
        and all(result["render_key"] for _i, _l, result in renders),
    }
    return {
        "checks": checks,
        "pass": all(checks.values()),
        "frames_checked": sum(result["p_frame"]["frames_checked"] for _i, _l, result in renders),
        "frames_masked_under_hook": sum(result["p_frame"]["masked_under_hook"]
                                        for _i, _l, result in renders),
        "render_ratio_final": sorted(round(result["final_s"] / result["clip_s"], 4)
                                     for _i, _l, result in renders),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="W1 exit: the full chain on the synthetic job")
    parser.add_argument("--evidence", type=Path, default=None)
    parser.add_argument("--task", default=TASK)
    parser.add_argument("--size", default="1280x720")
    args = parser.parse_args(argv)
    size = tuple(int(part) for part in args.size.split("x"))
    started = time.monotonic()
    load_before = os.getloadavg()
    with tempfile.TemporaryDirectory(prefix="w1-chain-") as tmp:
        report = chain(Path(tmp), size)
    report["prepare"] = {"clips": [{key: clip.get(key) for key in ("index", "openable", "reason")}
                                   for clip in report["prepare"].get("clips", [])]}
    summary = summarise(report)
    evidence = {
        "gate": "W1 chain", "task": args.task, **summary, "detail": report,
        "toolchain": {"ffmpeg": subprocess.run(["ffmpeg", "-version"], capture_output=True, check=False,
                                               text=True).stdout.splitlines()[0],
                      "reference_toolchain_problem": media.reference_toolchain_problem(),
                      "python": platform.python_version()},
        "source_size": list(size), "wall_s": round(time.monotonic() - started, 1),
        "loadavg_before": [round(v, 2) for v in load_before],
        "loadavg_after": [round(v, 2) for v in os.getloadavg()],
    }
    text = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
    if args.evidence is not None:
        args.evidence.mkdir(parents=True, exist_ok=True)
        (args.evidence / f"{args.task}-chain.json").write_text(text, encoding="utf-8")
    print(json.dumps({"pass": summary["pass"], "checks": summary["checks"]}, indent=1))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
