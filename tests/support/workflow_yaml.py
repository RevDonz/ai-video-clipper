"""A small YAML reader for the GitHub workflow files, for tests (the repo has no YAML library).

It reads the block style the workflows use: mappings, sequences, ``|`` and ``|-`` block scalars,
plain and quoted scalars, ``[a, b]`` flow sequences and ``{}``. Anything else raises
``YamlSubsetError``, so a workflow that needs more YAML fails a test instead of being half-read.
``on`` stays the string ``"on"`` (YAML 1.2, as GitHub reads it).
"""

from __future__ import annotations

import re
from typing import Any

_INT = re.compile(r"-?\d+")
_KEY = re.compile(r"([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: |$)")
_COMMENT = re.compile(r"\s#")


class YamlSubsetError(ValueError):
    pass


def load(text: str) -> Any:
    reader = _Reader(text.split("\n"))
    value = reader.node(0)
    leftover = reader.next_content()
    if leftover is not None:
        raise reader.error(leftover, "unexpected content after the document")
    return value


def _quote_end(text: str) -> int:
    """Index of the quote that closes the quoted scalar ``text`` starts with."""
    quote, index = text[0], 1
    while index < len(text):
        char = text[index]
        if quote == '"' and char == "\\":
            index += 2
            continue
        if char == quote:
            if quote == "'" and text[index + 1:index + 2] == "'":
                index += 2
                continue
            return index
        index += 1
    raise YamlSubsetError(f"unterminated quote: {text!r}")


def _without_comment(text: str) -> str:
    text = text.strip()
    if text.startswith(("'", '"')):
        end = _quote_end(text)
        tail = text[end + 1:].strip()
        if tail and not tail.startswith("#"):
            raise YamlSubsetError(f"text after a quoted scalar: {text!r}")
        return text[:end + 1]
    if text.startswith("#"):
        return ""
    match = _COMMENT.search(text)
    return text[:match.start()].rstrip() if match else text


def _double_quoted(body: str) -> str:
    escapes = {"\\": "\\", '"': '"', "n": "\n", "t": "\t", "/": "/"}
    out, index = [], 0
    while index < len(body):
        char = body[index]
        if char == "\\":
            if body[index + 1:index + 2] not in escapes:
                raise YamlSubsetError(f"unsupported escape in {body!r}")
            out.append(escapes[body[index + 1]])
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def scalar(text: str) -> Any:
    """The value of a scalar whose comment is already removed."""
    if text.startswith('"'):
        return _double_quoted(text[1:-1])
    if text.startswith("'"):
        return text[1:-1].replace("''", "'")
    if text == "{}":
        return {}
    if text.startswith("["):
        if not text.endswith("]") or any(char in text[1:-1] for char in "[]{}"):
            raise YamlSubsetError(f"unsupported flow sequence: {text!r}")
        inner = text[1:-1].strip()
        return [scalar(_without_comment(part)) for part in inner.split(",")] if inner else []
    if text[:1] in tuple("{&*!%@`|>"):
        raise YamlSubsetError(f"unsupported YAML: {text!r}")
    if text in ("true", "false"):
        return text == "true"
    if text in ("null", "~", ""):
        return None
    if _INT.fullmatch(text):
        return int(text)
    return text


def _is_item(text: str) -> bool:
    return text == "-" or text.startswith("- ")


class _Reader:
    def __init__(self, lines: list[str]) -> None:
        self.lines = lines
        self.index = 0
        for number, line in enumerate(lines):
            if "\t" in line[:len(line) - len(line.lstrip())]:
                raise YamlSubsetError(f"line {number + 1}: tab in indentation")

    def error(self, index: int, message: str) -> YamlSubsetError:
        return YamlSubsetError(f"line {index + 1}: {message}")

    def next_content(self) -> int | None:
        index = self.index
        while index < len(self.lines):
            stripped = self.lines[index].strip()
            if stripped and not stripped.startswith("#"):
                return index
            index += 1
        return None

    def indent(self, index: int) -> int:
        line = self.lines[index]
        return len(line) - len(line.lstrip(" "))

    def text(self, index: int) -> str:
        return self.lines[index].strip()

    def node(self, indent: int) -> Any:
        index = self.next_content()
        if index is None:
            return None
        if self.indent(index) != indent:
            raise self.error(index, f"expected indent {indent}")
        return self.sequence(indent) if _is_item(self.text(index)) else self.mapping(indent)

    def mapping(self, indent: int) -> dict[str, Any]:
        result: dict[str, Any] = {}
        while (index := self.next_content()) is not None and self.indent(index) == indent:
            text = self.text(index)
            if _is_item(text):
                break
            match = _KEY.match(text)
            if not match:
                raise self.error(index, f"expected `key: value`, got {text!r}")
            key = match.group(1)
            if key in result:
                raise self.error(index, f"duplicate key {key!r}")
            self.index = index + 1
            result[key] = self.value(_without_comment(text[match.end():]), indent, index)
        return result

    def sequence(self, indent: int) -> list[Any]:
        result: list[Any] = []
        while (index := self.next_content()) is not None and self.indent(index) == indent:
            text = self.text(index)
            if not _is_item(text):
                break
            item = text[1:].lstrip(" ")
            if _KEY.match(item):
                # A mapping that starts on the dash line: its keys sit at the item's column.
                column = indent + len(text) - len(item)
                self.lines[index] = " " * column + item
                self.index = index
                result.append(self.mapping(column))
                continue
            self.index = index + 1
            result.append(self.value(_without_comment(item), indent, index))
        return result

    def value(self, rest: str, indent: int, index: int) -> Any:
        if rest in ("|", "|-"):
            return self.block_scalar(indent, keep_newline=rest == "|")
        following = self.next_content()
        deeper = following is not None and self.indent(following) > indent
        if rest:
            if deeper:
                raise self.error(following, f"continuation of line {index + 1} is not supported")
            return scalar(rest)
        if deeper:
            return self.node(self.indent(following))
        if following is not None and self.indent(following) == indent and \
                _is_item(self.text(following)) and not _is_item(self.text(index)):
            return self.sequence(indent)
        return None

    def block_scalar(self, indent: int, *, keep_newline: bool) -> str:
        end = self.index
        while end < len(self.lines):
            if self.lines[end].strip() and self.indent(end) <= indent:
                break
            end += 1
        body = self.lines[self.index:end]
        self.index = end
        while body and not body[-1].strip():
            body.pop()
        if not body:
            return ""
        block = next(len(line) - len(line.lstrip(" ")) for line in body if line.strip())
        for line in body:
            if line.strip() and len(line) - len(line.lstrip(" ")) < block:
                raise YamlSubsetError(f"block scalar line less indented than its first: {line!r}")
        text = "\n".join(line[block:] if line.strip() else "" for line in body)
        return text + "\n" if keep_newline else text
