"""``llm.ERROR_CODES`` lists every code an ``LLMError`` can carry.

The help page (``/bantuan``) has one entry per code; ``web/tests/help-catalog.test.mjs`` reads
this list and fails for a code without an entry. This test keeps the list honest: a new
``LLMError("new_code", ...)`` anywhere in the package fails here until the code is listed.
"""

from __future__ import annotations

import ast
from pathlib import Path

from ai_clipper import llm

PACKAGE = Path(llm.__file__).parent
FACTORIES = {"LLMError", "LLMUnavailable"}
# ScriptedLLMClient (a test double) runs out of script with this code; no user ever sees it.
TEST_ONLY = {"script_exhausted"}


def _literal_codes(node: ast.expr) -> set[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.IfExp):
        return _literal_codes(node.body) | _literal_codes(node.orelse)
    return set()


def _first_argument(call: ast.Call) -> ast.expr | None:
    if call.args:
        return call.args[0]
    return next((item.value for item in call.keywords if item.arg == "code"), None)


def _raised_codes() -> tuple[set[str], set[str]]:
    """(literal codes, f-string prefixes) passed to LLMError, LLMUnavailable or self._error."""
    literals: set[str] = set()
    prefixes: set[str] = set()
    for path in sorted(PACKAGE.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            factory = (isinstance(func, ast.Name) and func.id in FACTORIES) or (
                isinstance(func, ast.Attribute)
                and func.attr == "_error"
                and isinstance(func.value, ast.Name)
                and func.value.id == "self"
            )
            argument = _first_argument(node) if factory else None
            if argument is None:
                continue
            literals |= _literal_codes(argument)
            if isinstance(argument, ast.JoinedStr):
                prefixes.add(
                    "".join(
                        part.value
                        for part in argument.values
                        if isinstance(part, ast.Constant) and isinstance(part.value, str)
                    )
                )
    return literals, prefixes


def test_error_codes_are_exactly_the_codes_the_package_raises():
    literals, _ = _raised_codes()
    assert set(llm.ERROR_CODES) == literals - TEST_ONLY
    assert len(llm.ERROR_CODES) == len(set(llm.ERROR_CODES))


def test_the_only_computed_code_is_http_status():
    # f"http_{status}": the help page maps every http_<status> to one entry.
    _, prefixes = _raised_codes()
    assert prefixes == {"http_"}


def test_every_listed_code_is_a_valid_error_code_and_every_cli_hint_names_one():
    for code in llm.ERROR_CODES:
        llm.LLMError(code, "pesan")  # raises for a code LLMError would refuse
    assert set(llm._HINTS) <= set(llm.ERROR_CODES)
