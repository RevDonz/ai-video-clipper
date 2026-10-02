"""The cold-open transition across the three builds (spec 2026-10-02 §9, "Cross-task shapes").

The editor client (``web/lib/editor/commands.mjs``), the engine (``edit_v2``) and the player
(``web/lib/editor/player/join-layer.mjs``) were built in parallel against the shapes the spec
fixed. This test runs them against each other through ``scripts/edit_v2/transition_wiring.mjs``:

* every document the real ``SetColdOpen``/``SetJoinStyle``/``SetJoinSfx`` give is valid, plans
  with the style and the sound it names, has the Cold open panel's ``J``, and compiles with one
  ``lutrgb`` per affected frame and the whoosh sidecar exactly when it has the sound;
* the plan DTO ``joins`` the engine sends is the one the dev fakes port draws, and the player
  accepts it and fills exactly the plan's frames with the style's colour;
* every join the pipeline writes into a seed (``coldOpenJoin``) is a document the client accepts,
  and ``SetColdOpen`` gives that join back (R10).
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_plan import camera_for

from ai_clipper.edit_v2 import audio_graph, compile_ffmpeg, transitions
from ai_clipper.edit_v2.compile_ffmpeg import SourceStreams, compile_job
from ai_clipper.edit_v2.doc import canonical_bytes, parse_doc, validate_doc
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan
from ai_clipper.edit_v2.transitions import AUTO_COLD_OPEN_JOIN, CUT_JOIN, ColdOpenJoin

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "edit_v2" / "transition_wiring.mjs"
SOURCE = Path("/jobs/job-1/source.mp4")
ASSETS_ROOT = Path("/jobs/job-1/analysis/assets")

pytestmark = pytest.mark.skipif(shutil.which("node") is None,
                                reason="node is not installed (the web toolchain runs this)")


def node(*args: str) -> str:
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/tmp")}
    result = subprocess.run([shutil.which("node") or "node", str(SCRIPT), *args], cwd=ROOT,
                            env=env, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")[-2000:]
    return result.stdout.decode("utf-8")


@pytest.fixture(scope="module")
def client_docs() -> list[tuple[dict, bytes]]:
    lines = node("docs").encode("utf-8").splitlines()
    assert lines and len(lines) % 2 == 0
    return [(json.loads(lines[i]), lines[i + 1]) for i in range(0, len(lines), 2)]


@pytest.fixture(scope="module")
def contexts() -> dict[str, fixtures.Context]:
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def plan_of(doc: dict, context: fixtures.Context):
    camera = camera_for(doc) if doc["layout"]["default"]["mode"] == "camera" else None
    return build_plan(doc, words=context.words, camera=camera, assets=context.assets,
                      resources=Resources(RESOURCES_DIR))


@pytest.fixture
def probe_stub(monkeypatch):
    def probe(_path):
        source = probe.doc["base"]["source"]
        return SourceStreams(video_index=0, audio_index=1 if source["has_audio"] else None,
                             width=source["w"], height=source["h"], color_space="bt709",
                             color_range="tv", duration_s=source["duration_ms"] / 1000)

    monkeypatch.setattr(compile_ffmpeg, "probe_source", probe)
    return probe


def test_the_client_covers_every_style_and_the_whoosh_on_every_rate(client_docs):
    seen = {(header["ctx"], header["style"], header["sfx"]) for header, _raw in client_docs}
    assert seen >= {(ctx, style, sfx) for ctx in fixtures.CONTEXT_IDS
                    for style in transitions.JOIN_STYLES for sfx in (False, True)}
    # a cold open added where the seed has none takes the auto clips' join (owner decision 1)
    added = [header for header, _raw in client_docs if header["name"] == "added"]
    assert added and all((h["style"], h["sfx"]) == ("flash_white", True) for h in added)
    # re-adding the seed's own cold open keeps the seed's join (a cut in these seeds)
    readded = [header for header, _raw in client_docs if header["name"] == "readded"]
    assert readded and all((h["style"], h["sfx"]) == ("cut", False) for h in readded)


def test_client_documents_validate_plan_and_compile_with_their_transition(
        client_docs, contexts, probe_stub):
    for header, raw in client_docs:
        label = f"{header['ctx']}/{header['name']}"
        context = contexts[header["ctx"]]
        doc = parse_doc(raw)
        assert canonical_bytes(doc) == raw, label
        result = validate_doc(doc, words=context.words, assets=context.assets, seed=context.seed)
        assert not result.errors, (label, [issue.to_json() for issue in result.errors])

        plan = plan_of(doc, context)
        (join,) = plan.joins
        assert (join.style, join.sfx is not None) == (header["style"], header["sfx"]), label
        assert join.at_f == header["joinFrame"], label  # the panel's J is the engine's
        assert plan.total_frames == header["totalFrames"], label
        # the dev fakes' DTO port is the engine's DTO, field for field
        assert transitions.joins_dto(plan.joins) == header["fakeJoins"], label

        probe_stub.doc = doc
        job = compile_job(plan, mode="reference", source=SOURCE, assets_root=ASSETS_ROOT)
        assert job.filter_script.count("lutrgb=") == len(join.alpha), label
        whoosh = audio_graph.SFX_SIDECAR.format(id="whoosh", v=1)
        assert (whoosh in job.sidecars) == header["sfx"], label
        if header["sfx"]:
            assert f"adelay=delays={join.sfx.start_smp}S:all=1" in job.filter_script, label


def test_the_player_draws_exactly_the_engine_plan(client_docs, contexts, tmp_path):
    entries, plans = [], {}
    for header, raw in client_docs:
        name = f"{header['ctx']}/{header['name']}"
        plan = plan_of(parse_doc(raw), contexts[header["ctx"]])
        plans[name] = plan
        entries.append({"name": name, "totalFrames": plan.total_frames,
                        "joins": transitions.joins_dto(plan.joins)})
    # the shapes the player must refuse stay refused when they come from the engine's fields
    bad = copy.deepcopy(entries[-1])
    bad["name"] = "bad"
    bad["joins"][0]["alphaPm"] = list(reversed(bad["joins"][0]["alphaPm"]))
    file = tmp_path / "dto.json"
    file.write_text(json.dumps([*entries, bad]), encoding="utf-8")
    verdicts = {entry["name"]: entry for entry in json.loads(node("check", str(file)))}

    for name, plan in plans.items():
        verdict = verdicts[name]
        assert verdict["valid"] is True, name
        (join,) = plan.joins
        rgb = list(transitions.RGB[join.style]) if join.style != "cut" else None
        assert verdict["overlays"] == [[frame, rgb, alpha] for frame, alpha in join.alpha], name
    assert bad["joins"][0]["alphaPm"] and verdicts["bad"]["valid"] is False


@pytest.mark.parametrize("join", [AUTO_COLD_OPEN_JOIN, CUT_JOIN, ColdOpenJoin("dip_black", None),
                                  ColdOpenJoin("dip_black", "whoosh"),
                                  ColdOpenJoin("cut", "whoosh"),
                                  ColdOpenJoin("flash_white", None)])
def test_the_client_accepts_every_seed_join_the_pipeline_writes(join, contexts, tmp_path):
    entries = []
    for cid, context in contexts.items():
        if not context.seed["main"]["joins"]:
            continue
        seed = copy.deepcopy(context.seed)
        after = seed["main"]["joins"][0]["after"]
        seed["main"]["joins"] = [join.doc_join(after, 30)]
        assert not validate_doc(seed, words=context.words, assets=context.assets,
                                seed=None).errors, cid
        entries.append({"name": cid, "ctx": cid, "seed": seed})
    assert entries
    file = tmp_path / "seeds.json"
    file.write_text(json.dumps(entries), encoding="utf-8")
    for verdict in json.loads(node("seeds", str(file))):
        assert verdict["issues"] == [], verdict
        # SetColdOpen's template on a seed with a cold open is the seed's own join (R10)
        assert verdict["template"] == join.to_json(), verdict
