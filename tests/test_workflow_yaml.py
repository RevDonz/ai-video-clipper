"""The small YAML reader the workflow tests use (``tests/support/workflow_yaml.py``).

The repository has no YAML library, and the workflow tests must not add one. The reader takes
the block style the GitHub workflows are written in and raises on anything else.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from support.workflow_yaml import YamlSubsetError, load

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"


def test_mappings_sequences_and_scalars():
    text = """\
# leading comment
name: Demo   # trailing comment
on:
  schedule:
    - cron: "0 2 * * 1" # weekly
  workflow_dispatch:
permissions: {}
jobs:
  one:
    timeout-minutes: 20
    if: needs.a.outputs.changed == 'true' && github.ref == 'refs/heads/main'
    options: [pr, toolchain, 'night ly']
    flag: false
    empty:
    steps:
      - name: First
        run: echo "a: b" # not a key
      -  name: Second
         with:
           path: ${{ runner.temp }}/x
      - plain item
"""
    assert load(text) == {
        "name": "Demo",
        "on": {"schedule": [{"cron": "0 2 * * 1"}], "workflow_dispatch": None},
        "permissions": {},
        "jobs": {"one": {
            "timeout-minutes": 20,
            "if": "needs.a.outputs.changed == 'true' && github.ref == 'refs/heads/main'",
            "options": ["pr", "toolchain", "night ly"],
            "flag": False,
            "empty": None,
            "steps": [{"name": "First", "run": 'echo "a: b"'},
                      {"name": "Second", "with": {"path": "${{ runner.temp }}/x"}},
                      "plain item"],
        }},
    }


def test_block_scalars_keep_their_lines():
    text = """\
run: |
  first line
    indented # kept, not a comment

  after a blank line
keep: |-
  no trailing newline
next: value
"""
    assert load(text) == {
        "run": "first line\n  indented # kept, not a comment\n\nafter a blank line\n",
        "keep": "no trailing newline",
        "next": "value",
    }


def test_a_sequence_may_sit_at_the_indent_of_its_key():
    assert load("steps:\n- a\n- b\nafter: 1\n") == {"steps": ["a", "b"], "after": 1}


def test_quoted_scalars():
    assert load("""a: "x \\"y\\" z"\nb: 'it''s'\nc: "#not comment"\n""") == {
        "a": 'x "y" z', "b": "it's", "c": "#not comment"}


@pytest.mark.parametrize("text", [
    "a: 1\na: 2\n",                 # duplicate key
    "a:\n\tb: 1\n",                 # tab indent
    "a: &anchor 1\n",               # anchors
    "a: *anchor\n",                 # aliases
    "a: {b: 1}\n",                  # flow mapping
    "a: plain\n  continued\n",      # multi-line plain scalar
    "a: 'open\n",                   # unterminated quote
    "a: 1\n b: 2\n",                # stray indent
])
def test_unsupported_or_broken_yaml_raises(text):
    with pytest.raises(YamlSubsetError):
        load(text)


def test_the_existing_workflows_read_whole():
    ci = load((WORKFLOWS / "ci-cd.yml").read_text(encoding="utf-8"))
    assert ci["on"]["workflow_dispatch"]["inputs"]["suite"]["options"] == \
        ["pr", "toolchain", "nightly"]
    assert ci["jobs"]["test"]["timeout-minutes"] == 45
    assert ci["jobs"]["test"]["steps"][0]["uses"] == "actions/checkout@v5"
    gates = load((WORKFLOWS / "editor-gates.yml").read_text(encoding="utf-8"))
    assert gates["on"]["workflow_dispatch"]["inputs"]["gates"]["type"] == "boolean"
    assert "uv run pytest" in gates["jobs"]["gates"]["steps"][4]["run"]
