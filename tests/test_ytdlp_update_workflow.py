"""The weekly yt-dlp bump (``.github/workflows/ytdlp-update.yml``), read as a structure.

yt-dlp only changes through ``uv.lock`` and a merged PR, so the image stays reproducible. The
workflow bumps it, smoke-tests the new version, and proposes it from ``deps/yt-dlp-<version>``.
The repository does not let Actions open PRs (the owner decides), and pushes made with
``GITHUB_TOKEN`` start no other workflow: the PR checks are dispatched, and a refused PR leaves a
compare link in the run summary.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from support.workflow_yaml import load

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
WORKFLOW = load((WORKFLOWS / "ytdlp-update.yml").read_text(encoding="utf-8"))
CI = load((WORKFLOWS / "ci-cd.yml").read_text(encoding="utf-8"))
JOBS = WORKFLOW["jobs"]
SMOKE = "scripts/ytdlp/ytdlp_smoke.py"


def _steps(job: str) -> list[dict]:
    return JOBS[job]["steps"]


def _runs(job: str) -> str:
    return "\n".join(step.get("run", "") for step in _steps(job))


def _step(job: str, name: str) -> dict:
    matches = [step for step in _steps(job) if step.get("name") == name]
    assert len(matches) == 1, f"{job} has no single step named {name!r}"
    return matches[0]


def _uses(job: str) -> list[str]:
    return [step["uses"] for step in _steps(job) if "uses" in step]


def test_it_runs_weekly_and_by_hand_only():
    assert set(WORKFLOW["on"]) == {"schedule", "workflow_dispatch"}
    (schedule,) = WORKFLOW["on"]["schedule"]
    minute, hour, day, month, weekday = schedule["cron"].split()
    assert minute.isdigit() and hour.isdigit() and (day, month) == ("*", "*")
    assert weekday.isdigit(), "once a week"


def test_permissions_are_granted_per_job_and_least_privilege():
    assert WORKFLOW["permissions"] == {}
    assert set(JOBS) == {"bump", "propose"}
    assert JOBS["bump"]["permissions"] == {"contents": "read"}
    assert JOBS["propose"]["permissions"] == {
        "contents": "write", "pull-requests": "write", "actions": "write"}


def test_the_job_that_runs_yt_dlp_holds_no_write_token():
    checkout = _steps("bump")[0]
    assert checkout["uses"] == "actions/checkout@v5"
    assert checkout["with"]["persist-credentials"] is False
    assert "GH_TOKEN" not in str(JOBS["bump"]) and "github.token" not in str(JOBS["bump"])


def test_the_bump_uses_the_ci_toolchain():
    uv = [step for step in _steps("bump") if step.get("uses", "").startswith("astral-sh/setup-uv")]
    assert [step["with"]["version"] for step in uv] == ["0.11.6"]
    ci_uv = [step["with"]["version"] for step in CI["jobs"]["test"]["steps"]
             if step.get("uses", "").startswith("astral-sh/setup-uv")]
    assert ci_uv == ["0.11.6"]
    python = [step["with"]["python-version"] for step in _steps("bump")
              if step.get("uses", "").startswith("actions/setup-python")]
    assert python == ["3.11"]
    node = [step["with"]["node-version"] for step in _steps("bump")
            if step.get("uses", "").startswith("actions/setup-node")]
    assert node == ["20"], "yt-dlp runs YouTube's player JavaScript with Node, as in the image"


def test_actions_are_the_versions_the_other_workflows_use():
    known = {step["uses"] for job in CI["jobs"].values() for step in job.get("steps", [])
             if "uses" in step}
    for uses in _uses("bump") + _uses("propose"):
        if uses.startswith("actions/download-artifact@"):
            assert uses == "actions/download-artifact@v4", "the pair of upload-artifact@v4"
        else:
            assert uses in known, uses


def test_yt_dlp_is_bumped_in_the_lock_and_never_installed_any_other_way():
    bump = _step("bump", "Bump yt-dlp in uv.lock")["run"]
    assert "uv lock --upgrade-package yt-dlp" in bump
    assert f"{SMOKE} compare-locks" in bump
    assert 'test -z "$(git status --porcelain' in bump, "nothing but uv.lock may change"
    install = _step("bump", "Install the locked yt-dlp")["run"]
    assert install.startswith("uv sync --frozen")
    everything = _runs("bump") + _runs("propose")
    for forbidden in ("pip install", "yt-dlp -U", "yt-dlp --update", "--upgrade yt-dlp",
                      "uv pip", "uv add"):
        assert forbidden not in everything, forbidden


def test_the_smoke_checks_the_bumped_version_and_tolerates_only_inconclusive():
    smoke = _step("bump", "Smoke download")
    assert smoke["id"] == "smoke"
    run = smoke["run"]
    assert f"{SMOKE} run" in run and "--yt-dlp .venv/bin/yt-dlp" in run
    assert '--expect-version "$VERSION"' in run
    assert smoke["env"]["VERSION"] == "${{ steps.bump.outputs.version }}"
    assert '--summary "$GITHUB_STEP_SUMMARY"' in run
    assert "|| test $? -eq 3" in run, "exit 3 (inconclusive) continues, exit 1 (broken) fails"
    assert (ROOT / SMOKE).is_file()


def test_the_bump_job_hands_the_tested_lock_over():
    outputs = JOBS["bump"]["outputs"]
    assert outputs == {
        "before": "${{ steps.bump.outputs.before }}",
        "version": "${{ steps.bump.outputs.version }}",
        "changed": "${{ steps.bump.outputs.changed }}",
        "smoke": "${{ steps.smoke.outputs.status }}",
    }
    keep = _step("bump", "Keep the bumped lock")
    assert keep["if"] == "steps.bump.outputs.changed == 'true'"
    assert keep["uses"] == "actions/upload-artifact@v4"
    fetch = [step for step in _steps("propose") if "download-artifact" in step.get("uses", "")]
    assert [step["with"]["name"] for step in fetch] == [keep["with"]["name"]]


def test_a_pr_is_proposed_only_for_a_new_version_on_main():
    propose = JOBS["propose"]
    assert propose["needs"] == "bump"
    assert propose["if"] == ("needs.bump.outputs.changed == 'true' && "
                             "github.ref == 'refs/heads/main'")


def test_the_branch_is_pushed_once_and_its_lock_rechecked_against_main():
    push = _step("propose", "Push the branch")["run"]
    assert 'branch="deps/yt-dlp-$VERSION"' in push
    assert "git ls-remote --exit-code --heads origin" in push, "an existing branch is not redone"
    recheck = f'{SMOKE} compare-locks "$RUNNER_TEMP/uv.lock.main" uv.lock'
    assert f'{recheck} --expect-version "$VERSION"' in push
    assert 'git push origin "$branch"' in push
    assert not re.search(r"git push[^\n]*(--force|-f\b|\+)", push), "never overwrites a branch"


def test_a_refused_pr_leaves_the_compare_link_in_the_summary():
    step = _step("propose", "Open the pull request")
    run = step["run"]
    assert "gh pr create --base main" in run
    assert re.search(r"if .*gh pr create", run), "a refusal is handled, not fatal"
    assert '$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/compare/main...$BRANCH?expand=1' in run
    assert run.count('>> "$GITHUB_STEP_SUMMARY"') >= 2
    assert "::warning" in run
    assert '[ "$SMOKE" = pass ] || draft=(--draft)' in run, "an unproven bump opens as a draft"
    assert '"${draft[@]}"' in run
    assert step["env"]["GH_TOKEN"] == "${{ github.token }}"


def test_the_pr_checks_are_dispatched_on_the_branch():
    run = _step("propose", "Run the PR checks on the branch")["run"]
    assert 'gh workflow run ci-cd.yml --ref "$BRANCH" -f suite=pr' in run
    assert "pr" in CI["on"]["workflow_dispatch"]["inputs"]["suite"]["options"]


@pytest.mark.parametrize("job", ["bump", "propose"])
def test_no_expression_is_spliced_into_a_shell_script(job):
    for step in _steps(job):
        assert "${{" not in step.get("run", ""), step.get("name")


def test_every_job_has_a_time_limit():
    for name, job in JOBS.items():
        assert 0 < job["timeout-minutes"] <= 30, name


def test_the_emergency_procedure_is_written_down():
    text = (ROOT / "docs" / "editor" / "OPERASIONAL.md").read_text(encoding="utf-8")
    start = text.index("YouTube rusak: naikkan yt-dlp")
    section = text[start:]
    for needle in ("uv lock --upgrade-package yt-dlp", "gh workflow run ytdlp-update.yml",
                   f"{SMOKE} run", "yt-dlp --version", "suite=command", "deps/yt-dlp-"):
        assert needle in section, needle
