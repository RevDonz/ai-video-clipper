"""The UI language never reaches the render (rombak 07 §10.4, §11, §14).

The web app runs in an Indonesian session (``POTONGIN_LOCALES=id``) or an English one
(``POTONGIN_LOCALES=id,en`` and the e2e strict switch). The same edit document must give the same
plan digest, the same ASS and the same ``render_key`` in both, so a render cached in one session
is the render of the other. Each session runs in its own interpreter with its own environment;
the web half of this check is ``web/tests/content-language-isolation.test.mjs``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from test_edit_v2_plan import write_resources

ROOT = Path(__file__).resolve().parents[1]

CHILD = """
import hashlib, json, sys
from pathlib import Path
from support import edit_v2_fixtures as fixtures
from ai_clipper.edit_v2.plan import Resources, build_plan, render_key, toolchain_sha256

name, resources_root = sys.argv[1], Path(sys.argv[2])
resources = Resources(resources_root)
context = fixtures.load_context(name.rsplit("__", 1)[1])
doc = json.loads((fixtures.DOC_FIXTURES_DIR / "valid" / f"{name}.json").read_text(encoding="utf-8"))
plan = build_plan(doc, words=context.words, camera=None, assets=context.assets, resources=resources)
key = render_key(plan, size=plan.output, quality="standar", measure_sha=None,
                 toolchain_sha=toolchain_sha256(resources))
print(json.dumps({
    "plan_sha256": plan.plan_sha256,
    "ass_sha256": hashlib.sha256(plan.captions.ass.encode("utf-8")).hexdigest(),
    "render_key": key,
}))
"""

# What differs between the two sessions on the app's side. LANGUAGE and LC_MESSAGES stand for a
# UI language leaking into the process locale; the character set stays UTF-8 in both.
SESSIONS = {
    "id": {"POTONGIN_LOCALES": "id", "LANGUAGE": "id", "LC_MESSAGES": "C.UTF-8"},
    "en": {"POTONGIN_LOCALES": "id,en", "POTONGIN_I18N_STRICT": "1", "LANGUAGE": "en",
           "LC_MESSAGES": "C.UTF-8"},
}
DROP = ("POTONGIN_LOCALES", "POTONGIN_I18N_STRICT", "LANGUAGE", "LC_MESSAGES", "LC_ALL")


def run_session(session: str, name: str, resources_root: Path) -> dict:
    env = {key: value for key, value in os.environ.items() if key not in DROP}
    env.update(SESSIONS[session])
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT / "src"), str(ROOT / "tests")])
    env["PYTHONUTF8"] = "1"
    result = subprocess.run(
        [sys.executable, "-c", CHILD, name, str(resources_root)],
        capture_output=True, text=True, env=env, check=False, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("name", ["full_example__c30", "music__c30"])
def test_plan_ass_and_render_key_are_the_same_in_id_and_en_sessions(tmp_path, name):
    resources = write_resources(tmp_path / "resources")
    indonesian = run_session("id", name, resources.root)
    english = run_session("en", name, resources.root)
    assert english == indonesian
    for value in indonesian.values():
        assert isinstance(value, str) and len(value) == 64
