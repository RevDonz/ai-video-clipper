"""``scripts/ops/auto_layout_downgrade.py``: Otomatis back to Latar blur before a rollback below
the reframe floor (rombak 04 §A8.4)."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import make_clip, next_doc, put, tree

from ai_clipper.edit_v2 import seed as seed_module
from ai_clipper.edit_v2 import store
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import validate_doc

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "auto_layout_downgrade.py"
AUTO_JOB = "2f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"
PLAIN_JOB = "3f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"


def _load():
    name = "auto_layout_downgrade"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


downgrade = _load()


def auto_seed(context: fixtures.Context, job_id: str) -> dict:
    """The context's seed with the automatic layout: two ranges and a shot plan sha."""
    seed = copy.deepcopy(context.seed)
    fps = tm.Fps.from_json(seed["output"]["fps"])
    first = tm.sf_floor(seed["base"]["window_ms"][0], fps)
    end = tm.sf_ceil(seed["base"]["window_ms"][1], fps)
    middle = (first + end) // 2
    seed["base"]["job_id"] = job_id
    seed["layout"] = {"default": {"mode": "auto", "no_face": "fit_blur"},
                      "ranges": [{"in_sf": first, "out_sf": middle, "mode": "camera",
                                  "origin": "auto"},
                                 {"in_sf": middle, "out_sf": end, "mode": "fit_blur",
                                  "origin": "auto"}]}
    seed["base"]["camera"] = {"sha256": "d" * 64}
    seed["base"]["shots"] = {"sha256": "e" * 64}
    seed["base"]["seed_sha256"] = seed_module.seed_sha256(seed)
    return seed


def write_job(root: Path, job_id: str, render_mode: str) -> Path:
    job_dir = root / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    job = {"id": job_id, "status": "completed",
           "options": {"renderMode": render_mode, "selectionMode": "v3"}, "clips": []}
    (job_dir / "job.json").write_text(json.dumps(job, indent=2) + "\n", encoding="utf-8")
    return job_dir


@pytest.fixture
def jobs(tmp_path, edit_v2_doc_contexts):
    context = edit_v2_doc_contexts["c30"]
    root = tmp_path / "jobs"
    root.mkdir()
    seed = auto_seed(context, AUTO_JOB)
    clip = make_clip(root, context, job_id=AUTO_JOB, seed=seed)
    seed_raw = (clip / "seed.json").read_bytes()
    edited = next_doc(seed, fixtures.etag(seed), main__cut_fade_ms=20)
    _doc, edited_etag, _warnings = put(clip, edited, fixtures.etag(seed))
    write_job(root, AUTO_JOB, "auto")
    plain_clip = make_clip(root, context, job_id=PLAIN_JOB)
    write_job(root, PLAIN_JOB, "fit-blur")
    return {"root": root, "context": context, "clip": clip, "seed": seed, "seed_raw": seed_raw,
            "edited_etag": edited_etag, "plain_clip": plain_clip}


def lines(capsys) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_a_dry_run_lists_the_changes_and_writes_nothing(jobs, capsys):
    before = tree(jobs["root"])
    assert downgrade.main(["--jobs-root", str(jobs["root"])]) == 0
    out = lines(capsys)
    changes = [(line.get("job"), line.get("change"), line.get("applied")) for line in out
               if "change" in line]
    assert changes == [(AUTO_JOB, "seed", False), (AUTO_JOB, "revision", False),
                       (AUTO_JOB, "job_render_mode", False)]
    assert out[-1] == {"summary": {"jobs": 2, "changes": 3, "errors": 0, "applied": False}}
    assert tree(jobs["root"]) == before


def test_apply_takes_the_clip_and_the_job_to_latar_blur(jobs, capsys):
    plain_before = tree(jobs["plain_clip"])
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--apply"]) == 0
    out = lines(capsys)
    assert out[-1]["summary"] == {"jobs": 2, "changes": 3, "errors": 0, "applied": True}
    clip = jobs["clip"]
    # revision 0: the original bytes kept beside it, the Latar blur form in its place
    assert (clip / downgrade.SEED_BACKUP).read_bytes() == jobs["seed_raw"]
    new_seed, _etag = store.seed(clip)
    assert new_seed["layout"] == {"default": {"mode": "fit_blur", "no_face": "center"}}
    assert "shots" not in new_seed["base"]
    assert new_seed["base"]["seed_sha256"] == seed_module.seed_sha256(new_seed)
    assert new_seed["base"]["camera"] == jobs["seed"]["base"]["camera"]
    for key in ("main", "captions", "tracks", "output", "clip_id"):
        assert new_seed[key] == jobs["seed"][key], key
    context = jobs["context"]
    assert validate_doc(new_seed, words=context.words, assets=context.assets,
                        seed=None).errors == ()
    # the edited revision: one more, the same edit in Latar blur
    current, _etag, is_seed = store.get(clip)
    assert not is_seed and current["revision"] == 2
    assert current["parent_sha256"] == jobs["edited_etag"]
    assert current["layout"] == new_seed["layout"]
    assert current["base"] == new_seed["base"]
    assert current["main"]["cut_fade_ms"] == 20
    assert current["audit"]["last_command"] == "Downgrade"
    assert store.revision(clip, jobs["edited_etag"])["layout"]["default"]["mode"] == "auto"
    job = json.loads((jobs["root"] / AUTO_JOB / "job.json").read_text(encoding="utf-8"))
    assert job["options"]["renderMode"] == "fit-blur"
    assert not (jobs["root"] / downgrade.QUEUE_LOCK).exists()
    # the other job is untouched
    assert tree(jobs["plain_clip"]) == plain_before
    plain_job = json.loads((jobs["root"] / PLAIN_JOB / "job.json").read_text(encoding="utf-8"))
    assert plain_job["options"]["renderMode"] == "fit-blur"


def test_apply_is_idempotent(jobs, capsys):
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--apply"]) == 0
    capsys.readouterr()
    after = tree(jobs["root"])
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--apply"]) == 0
    assert lines(capsys) == [{"summary": {"jobs": 2, "changes": 0, "errors": 0,
                                          "applied": True}}]
    assert tree(jobs["root"]) == after


def test_only_the_named_jobs_are_read(jobs, capsys):
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--job", PLAIN_JOB]) == 0
    assert lines(capsys) == [{"summary": {"jobs": 1, "changes": 0, "errors": 0,
                                          "applied": False}}]
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--job", "../etc"]) == 1
    assert lines(capsys) == [{"error": "job_invalid"}]


def test_an_unedited_automatic_clip_changes_only_its_seed(tmp_path, edit_v2_doc_contexts,
                                                          capsys):
    context = edit_v2_doc_contexts["c30"]
    root = tmp_path / "jobs"
    root.mkdir()
    clip = make_clip(root, context, job_id=AUTO_JOB, seed=auto_seed(context, AUTO_JOB))
    write_job(root, AUTO_JOB, "auto")
    assert downgrade.main(["--jobs-root", str(root), "--apply"]) == 0
    assert [line.get("change") for line in lines(capsys) if "change" in line] == [
        "seed", "job_render_mode"]
    _doc, _etag, is_seed = store.get(clip)
    assert is_seed and not (clip / "edit" / "doc.json").exists()


def test_symlinks_and_paths_outside_the_root_are_refused(jobs, tmp_path, capsys):
    outside = tmp_path / "outside"
    write_job(outside, "4f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "auto")
    link = jobs["root"] / "4f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"
    os.symlink(outside / "4f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", link)
    clips = jobs["root"] / PLAIN_JOB / "analysis" / "clips"
    os.symlink(jobs["clip"], clips / ("clip_" + "f" * 24))
    before = tree(outside)
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--apply"]) == 1
    out = lines(capsys)
    errors = [line for line in out if "error" in line]
    assert {(line["job"], line["error"]) for line in errors} == {
        ("4f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "Refused"), (PLAIN_JOB, "Refused")}
    assert tree(outside) == before
    root_link = tmp_path / "root-link"
    os.symlink(jobs["root"], root_link)
    assert downgrade.main(["--jobs-root", str(root_link)]) == 1
    assert lines(capsys) == [{"error": "jobs_root_invalid"}]


def test_a_held_queue_lock_stops_the_job_rewrite(jobs, capsys, monkeypatch):
    (jobs["root"] / downgrade.QUEUE_LOCK).mkdir(mode=0o700)
    monkeypatch.setattr(downgrade, "QUEUE_LOCK_TIMEOUT_S", 0.1)
    assert downgrade.main(["--jobs-root", str(jobs["root"]), "--apply"]) == 1
    out = lines(capsys)
    assert {"error": "TimeoutError", "change": "job_render_mode"} in out
    job = json.loads((jobs["root"] / AUTO_JOB / "job.json").read_text(encoding="utf-8"))
    assert job["options"]["renderMode"] == "auto"
    assert (jobs["root"] / downgrade.QUEUE_LOCK).is_dir()  # somebody else's lock stays
