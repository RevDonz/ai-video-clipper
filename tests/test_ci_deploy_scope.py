"""A push to ``main`` that changes only documentation skips the image build and the deploy.

``scripts/ci/deploy_scope.py`` classifies the push (``git diff`` against the push's ``before``)
and the ``changes`` job of ``.github/workflows/ci-cd.yml`` hands the answer to the image steps,
the parity job and ``Deploy production``. Every doubt deploys: a pull request, a schedule, a
first push, a force push, an unknown ``before`` or a failing ``git diff`` all answer "not
docs-only". The workflow keeps no ``paths-ignore``, so ``Test and build`` reports on every PR.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from support.workflow_yaml import load

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))

import deploy_scope

CI = load((ROOT / ".github" / "workflows" / "ci-cd.yml").read_text(encoding="utf-8"))
JOBS = CI["jobs"]
ZEROS = "0" * 40
SKIP_IF_DOCS = "needs.changes.outputs.docs_only != 'true'"


@pytest.mark.parametrize("paths", [
    ["docs/HANDOFF.md"],
    ["docs/evaluation/gold/abc.gold.json", "docs/editor/evidence/toolchain/P-TXT.json"],
    ["README.md", "AGENTS.md", "DESIGN.md", "CLAUDE.md", "deploy/VM_NGINX_CLOUDFLARE.md"],
    [".claude/skills/antislop/SKILL.md", "spikes/README.md"],
    ["docs/design/landing.png"],
])
def test_documentation_only(paths):
    assert deploy_scope.docs_only(paths) is True


@pytest.mark.parametrize("paths", [
    [],
    ["docs/HANDOFF.md", "web/app/page.jsx"],
    ["src/ai_clipper/prompts/post_text_v1.md"],   # a runtime prompt the image ships
    ["resources/notes.md"],
    ["web/e2e/README.md"],                        # under web/, which the image build copies
    [".github/workflows/ci-cd.yml"],
    ["Dockerfile"],
    ["docs"],                                     # a file named docs, not the folder
    ["notes.mdx"],
])
def test_anything_else_deploys(paths):
    assert deploy_scope.docs_only(paths) is False


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "config", "user.email", "ci@example.invalid")
    _git(tmp_path, "config", "user.name", "ci")
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "page.jsx").write_text("a\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "base")
    return tmp_path


def _commit(repo: Path, path: str, text: str) -> str:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", path)
    return _git(repo, "rev-parse", "HEAD")


def test_a_docs_push_is_docs_only_and_a_code_push_is_not(repo):
    base = _git(repo, "rev-parse", "HEAD")
    docs = _commit(repo, "docs/HANDOFF.md", "x\n")
    assert deploy_scope.decide("push", base, docs, "false", repo=repo) == (True, "docs only")
    code = _commit(repo, "web/page.jsx", "b\n")
    docs_only, _ = deploy_scope.decide("push", docs, code, "false", repo=repo)
    assert docs_only is False
    # Several commits in one push: the whole range counts.
    docs_only, _ = deploy_scope.decide("push", base, code, "false", repo=repo)
    assert docs_only is False


@pytest.mark.parametrize(("event", "before", "forced"), [
    ("pull_request", "BASE", "false"),
    ("schedule", "BASE", "false"),
    ("workflow_dispatch", "BASE", "false"),
    ("push", ZEROS, "false"),            # first push of the branch
    ("push", "", "false"),
    ("push", "BASE", "true"),            # force push
    ("push", "f" * 40, "false"),         # before is not in the clone
    ("push", "--output=/tmp/x", "false"),
])
def test_every_doubt_deploys(repo, event, before, forced):
    base = _git(repo, "rev-parse", "HEAD")
    docs = _commit(repo, "docs/HANDOFF.md", "x\n")
    docs_only, reason = deploy_scope.decide(event, base if before == "BASE" else before, docs,
                                            forced, repo=repo)
    assert docs_only is False
    assert reason


def test_the_cli_writes_a_github_output_line(repo):
    base = _git(repo, "rev-parse", "HEAD")
    docs = _commit(repo, "docs/HANDOFF.md", "x\n")
    script = ROOT / "scripts" / "ci" / "deploy_scope.py"
    out = subprocess.run([sys.executable, str(script), "--event", "push", "--before", base,
                          "--after", docs, "--forced", "false"],
                         cwd=repo, check=True, capture_output=True, text=True)
    assert out.stdout == "docs_only=true\n"
    out = subprocess.run([sys.executable, str(script), "--event", "push", "--before", ZEROS,
                          "--after", docs, "--forced", "false"],
                         cwd=repo, check=True, capture_output=True, text=True)
    assert out.stdout == "docs_only=false\n"


def test_the_workflow_keeps_reporting_on_every_pr():
    for event in ("pull_request", "push"):
        trigger = CI["on"][event]
        assert set(trigger) == {"branches"}, f"{event} must not filter paths"
    assert JOBS["test"]["name"] == "Test and build"
    assert "github.event_name == 'pull_request'" in JOBS["test"]["if"]
    # A failed classifier must not skip the required check: the test job runs anyway.
    assert JOBS["test"]["needs"] == "changes"
    assert "!cancelled()" in JOBS["test"]["if"]
    assert "docs_only" not in JOBS["test"]["if"]


def test_the_changes_job_classifies_with_the_push_payload():
    job = JOBS["changes"]
    assert "if" not in job
    assert job["outputs"]["docs_only"] == "${{ steps.scope.outputs.docs_only }}"
    checkout = job["steps"][0]
    assert checkout["uses"] == "actions/checkout@v5"
    assert checkout["with"]["fetch-depth"] == 0
    scope = next(step for step in job["steps"] if step.get("id") == "scope")
    assert scope["env"] == {"EVENT": "${{ github.event_name }}",
                            "BEFORE": "${{ github.event.before }}",
                            "FORCED": "${{ github.event.forced }}"}
    assert "scripts/ci/deploy_scope.py" in scope["run"]
    assert '>> "$GITHUB_OUTPUT"' in scope["run"]


def test_docs_only_skips_the_image_steps_and_nothing_else_in_test():
    image_steps = {"Validate production image", "Check the pinned rendering toolchain of the image"}
    for step in JOBS["test"]["steps"]:
        if step.get("name") in image_steps:
            assert step["if"] == SKIP_IF_DOCS
        else:
            assert "docs_only" not in step.get("if", "")
    assert image_steps <= {step.get("name") for step in JOBS["test"]["steps"]}


def test_docs_only_skips_parity_and_the_deploy():
    parity = JOBS["parity"]
    assert parity["needs"] == "changes"
    assert parity["if"] == "${{ !cancelled() && " + SKIP_IF_DOCS + " }}"
    deploy = JOBS["deploy"]
    assert deploy["name"] == "Deploy production"
    assert deploy["needs"] == ["test", "changes"]
    condition = deploy["if"]
    assert "github.event_name == 'push'" in condition
    assert "github.ref == 'refs/heads/main'" in condition
    assert "needs.test.result == 'success'" in condition
    assert SKIP_IF_DOCS in condition
    # A failed classifier still deploys a green test run.
    assert "!cancelled()" in condition
