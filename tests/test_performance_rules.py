"""FB-M0: the frozen rules.v1.json and the engine agree (rencana 2026-10-24-rombak, dok 03 §13.1)."""

from __future__ import annotations

import json
from pathlib import Path

from ai_clipper.selection_types import ARCHETYPES

RESOURCES = Path(__file__).resolve().parents[1] / "resources" / "performance"


def _load(name: str) -> dict:
    return json.loads((RESOURCES / name).read_text(encoding="utf-8"))


def test_rules_v1_archetypes_match_selection_types() -> None:
    rules = _load("rules.v1.json")
    assert len(rules["archetype"]) == len(set(rules["archetype"]))
    assert set(rules["archetype"]) == set(ARCHETYPES)


def test_snapshot_schema_allows_exactly_the_rules_v1_archetypes() -> None:
    rules = _load("rules.v1.json")
    schema = _load("performance-profile.v1.schema.json")
    archetype = schema["properties"]["boosts"]["properties"]["archetype"]
    assert archetype["propertyNames"]["enum"] == rules["archetype"]
