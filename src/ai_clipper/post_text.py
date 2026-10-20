"""Tulis ulang on the project page (plan 2026-10-20 P2): a new title and description for one clip.

``python -m ai_clipper.post_text`` is spawned by ``web/lib/clip-text-api.mjs`` through
``web/lib/python-cli.mjs`` with the LLM variables of the saved Pengaturan settings. stdin is one
envelope ``{"op": "rewrite", "jobId": <uuid>, "index": <1..9999>}``; stdout is one object:

* ``{"state": "done", "suggestion": {"title", "description"}, "error": null}``: the description
  ends with its hashtag line, the convention of every clip description;
* ``{"state": "failed", "suggestion": null, "error": {"code", "llmCode"}}``: ``code`` is one of
  :data:`ERRORS`, ``llmCode`` the LLM error code behind it (the /bantuan entries), or null.

Exit 0 for both, 2 for a malformed envelope, 4 when the job is not a finished job with that clip.

Only the clip's own transcript (``job.json`` ``clips[].text``) and its current title and
description go to the model. The answer is held to the editor's rules (``editor_ai``): every
number, name and quote grounded in that transcript, no URL, @account, emoji or hashtag in the
title, a title that is not a copy of the transcript. One request within a 20 s deadline over the
editor's chain, without the response cache: asking again gives another variant. Nothing is
written; the page shows the answer as a suggestion and saves only what the owner keeps.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from .edit_v2.errors import EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, EditV2Error, NotFound, message_id

# Shared with the editor's hook suggestions: the same grounding, format checks, deadline and
# failure codes, so both AI texts follow one rulebook.
from .editor_ai import (
    _CONTROL,
    _EMOJI,
    _HANDLE,
    _HASHTAG,
    _URL,
    _UUID,
    _Deadline,
    _Failed,
    _job_dir,
    _llm_failure,
    _prompt_safe,
    _read_json,
    _strict,
    _within,
    editor_chain,
    grounding_problem,
)

OPS = ("rewrite",)
PROMPT_RESOURCE = ("prompts", "post_text_v1.md")
PROMPT_VERSION = "post-text-v1"
DEADLINE_S = 20.0  # the whole request; Node kills the process group at 25 s
MAX_OUTPUT_TOKENS = 600
TEMPERATURE = 0.8
TITLE_MAX_CHARS = 100  # a job clip's title (web/lib/jobs.mjs CLIP_TEXT_LIMITS.title)
DESCRIPTION_MAX_CHARS = 600  # a manifest clip's description (CLIP_TEXT_LIMITS.description)
TRANSCRIPT_MAX_CHARS = 8000  # a job clip's text (CLIP_TEXT_LIMITS.text)
CURRENT_DESCRIPTION_CHARS = 1200
MAX_JOB_BYTES = 2 << 20  # the queue's own bound on job.json
MAX_ENVELOPE_BYTES = 4096
MAX_INDEX = 9999
ERRORS = ("timeout", "llm_unavailable", "llm_disabled", "invalid_output", "no_transcript")

_WRAPPERS = "\"'`*_“”‘’«»"
_TRAILING_TAGS = re.compile(r"(?:\s*(?<![\w&#])#[^\W_]\w*)+\s*$", re.UNICODE)
_LLM_CODE = re.compile(r"[a-z][a-z0-9_]{0,39}")


class _Usage(Exception):
    """A malformed envelope (exit 2): the route's bug, never the user's."""


class _Invalid(Exception):
    """The model's answer breaks a rule; the reason stays in this process."""


@dataclass(frozen=True)
class ClipText:
    """What the model sees of one clip: its transcript and its current post text."""

    text: str
    title: str
    description: str


def load_prompt() -> str:
    """The system prompt shipped with the package (``prompts/post_text_v1.md``)."""
    return resources.files("ai_clipper").joinpath(*PROMPT_RESOURCE).read_text(encoding="utf-8")


def _line(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = " ".join(_CONTROL.sub(" ", unicodedata.normalize("NFC", value)).split())
    return text[:limit]


def _without_hashtags(text: str) -> str:
    return " ".join(_HASHTAG.sub(" ", text).split())


def clip_text(job: Path, index: int) -> ClipText:
    """The clip ``index`` of the finished job in ``job``; ``NotFound`` for anything else. The
    owner's own edit (``textEdit``, web/lib/jobs.mjs) is the current text when it has a title."""
    record = _read_json(job / "job.json", MAX_JOB_BYTES)
    if not isinstance(record, dict) or record.get("status") != "completed":
        raise NotFound()
    clips = record.get("clips")
    found = next((item for item in clips if isinstance(item, dict) and item.get("index") == index
                  and type(item.get("index")) is int), None) if isinstance(clips, list) else None
    if found is None:
        raise NotFound()
    edit = found.get("textEdit") if isinstance(found.get("textEdit"), dict) else {}
    edited = _line(edit.get("title"), TITLE_MAX_CHARS)
    title = edited or _line(found.get("title"), TITLE_MAX_CHARS)
    description = edit.get("description") if edited else found.get("description")
    return ClipText(text=_line(found.get("text"), TRANSCRIPT_MAX_CHARS), title=title,
                    description=_without_hashtags(_line(description, CURRENT_DESCRIPTION_CHARS)))


def build_user(ctx: ClipText) -> str:
    return "\n".join([
        f"Judul sekarang: {_prompt_safe(ctx.title) or '-'}",
        f"Deskripsi sekarang: {_prompt_safe(ctx.description) or '-'}",
        "Transkrip klip:",
        _prompt_safe(ctx.text),
    ])


# --- the answer ------------------------------------------------------------------------------------------


def _folded(text: str) -> str:
    return " ".join(text.casefold().split())


def _title(value: object, ctx: ClipText) -> str:
    from .llm_selection import packaging_problem

    title = _line(value, 4 * TITLE_MAX_CHARS).strip(_WRAPPERS + " ").strip()
    if not title or len(title) > TITLE_MAX_CHARS:
        raise _Invalid()
    if _URL.search(title) or _HANDLE.search(title) or _HASHTAG.search(title) or _EMOJI.search(title):
        raise _Invalid()
    if packaging_problem(title, ctx.text, title=True) or grounding_problem(title, ctx.text):
        raise _Invalid()
    if _folded(title) == _folded(ctx.title):
        raise _Invalid()
    return title


def _description(value: object, ctx: ClipText) -> tuple[str, list[str]]:
    """The description without hashtags, and the hashtags that closed it."""
    text = _line(value, 4 * DESCRIPTION_MAX_CHARS)
    trailing = _TRAILING_TAGS.search(text)
    tags = trailing.group().split() if trailing else []
    if trailing:
        text = text[: trailing.start()]
    text = " ".join(_HASHTAG.sub(lambda match: match.group()[1:], text).split())
    text = text.strip(_WRAPPERS + " ").strip()
    if not text or len(text) > DESCRIPTION_MAX_CHARS:
        raise _Invalid()
    if _URL.search(text) or _HANDLE.search(text) or _EMOJI.search(text):
        raise _Invalid()
    if grounding_problem(text, ctx.text):
        raise _Invalid()
    return text, tags


def validate(data: object, ctx: ClipText) -> dict[str, str]:
    """``{"title", "description"}`` from the model's JSON; ``_Invalid`` when a rule is broken.
    Hashtags follow the engine's packaging rule (lower case, 2-38 letters or digits, at most 6)
    and close the description on a line of their own."""
    from .llm_selection import _clean_hashtags

    if not isinstance(data, dict):
        raise _Invalid()
    title = _title(data.get("title"), ctx)
    body, closing = _description(data.get("description"), ctx)
    raw = data.get("hashtags")
    listed = list(raw) if isinstance(raw, list) else ([raw] if isinstance(raw, str) else [])
    tags = _clean_hashtags([*listed, *closing])
    return {"title": title, "description": f"{body}\n\n{' '.join(tags)}" if tags else body}


# --- the request ------------------------------------------------------------------------------------------


def rewrite_client(env: Mapping[str, str]) -> Any:
    """The editor's chain (free providers from Pengaturan, bounded requests) without the response
    cache, so "Tulis ulang" twice asks twice. None when the LLM is off or unset."""
    return editor_chain(env)


def _failed(code: str, llm_code: object = None) -> dict:
    llm = llm_code if isinstance(llm_code, str) and _LLM_CODE.fullmatch(llm_code) else None
    return {"state": "failed", "suggestion": None, "error": {"code": code, "llmCode": llm}}


def rewrite(job: Path, *, index: int, env: Mapping[str, str] | None = None,
            client_factory: Callable[[Mapping[str, str]], Any] | None = None,
            deadline_s: float = DEADLINE_S,
            clock: Callable[[], float] = time.monotonic) -> dict:
    """One "Tulis ulang" for clip ``index`` of the finished job in ``job``."""
    from .llm import LLMError, llm_disabled

    env = os.environ if env is None else env
    started = clock()
    ctx = clip_text(job, index)
    if not ctx.text:
        return _failed("no_transcript")
    try:
        if llm_disabled(env):
            raise _Failed("llm_disabled")
        try:
            client = (client_factory or rewrite_client)(env)
        except LLMError as error:
            raise _llm_failure(error) from None
        if client is None:
            raise _Failed("llm_unavailable")
        try:
            response = _within(lambda: client.complete_json(
                system=load_prompt(), user=build_user(ctx), max_output_tokens=MAX_OUTPUT_TOKENS,
                temperature=TEMPERATURE), deadline_s - (clock() - started))
        except LLMError as error:
            raise _llm_failure(error) from None
        try:
            suggestion = validate(response.data, ctx)
        except _Invalid:
            raise _Failed("invalid_output") from None
    except _Deadline:
        return _failed("timeout")
    except _Failed as failure:
        return _failed(failure.code, failure.llm_code)
    return {"state": "done", "suggestion": suggestion, "error": None}


# --- entry points -------------------------------------------------------------------------------------------


def _envelope(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = _strict(bytes(raw).decode("utf-8"))
    except (ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict or set(value) != {"op", "jobId", "index"} or value["op"] not in OPS:
        raise _Usage()
    job_id, index = value["jobId"], value["index"]
    if not isinstance(job_id, str) or _UUID.fullmatch(job_id) is None:
        raise _Usage()
    if type(index) is not int or not 1 <= index <= MAX_INDEX:
        raise _Usage()
    return value


def _error(code: str) -> dict:
    return {"error": {"code": code, "path": None, "ref": None, "messageId": message_id(code)}}


def handle(raw: bytes, *, jobs_root: str | os.PathLike | None,
           env: Mapping[str, str] | None = None,
           client_factory: Callable[[Mapping[str, str]], Any] | None = None,
           deadline_s: float = DEADLINE_S) -> tuple[int, dict]:
    """Run one envelope; (exit code, stdout object). Never echoes paths, text or messages."""
    try:
        envelope = _envelope(raw)
        job = _job_dir(jobs_root, envelope["jobId"])
        return EXIT_OK, rewrite(job, index=envelope["index"], env=env,
                                client_factory=client_factory, deadline_s=deadline_s)
    except _Usage:
        return EXIT_USAGE, _error("internal_error")
    except NotFound:
        return NotFound.exit_code, _error("not_found")
    except EditV2Error:
        return EXIT_INTERNAL, _error("internal_error")
    except Exception:  # noqa: BLE001 - the process boundary exposes fixed codes only
        return EXIT_INTERNAL, _error("internal_error")


def main(argv: Sequence[str] | None = None) -> int:
    """Run one op from the stdin envelope; exits the process once the answer is written, so an
    LLM request abandoned at the deadline cannot keep it alive."""
    arguments = sys.argv[1:] if argv is None else list(argv)
    if arguments:
        code, payload = EXIT_USAGE, _error("internal_error")
    else:
        raw = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
        code, payload = handle(raw, jobs_root=os.environ.get("JOBS_ROOT"), env=os.environ)
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                            .encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return code


__all__ = [
    "DEADLINE_S",
    "ERRORS",
    "OPS",
    "ClipText",
    "build_user",
    "clip_text",
    "handle",
    "load_prompt",
    "main",
    "rewrite",
    "rewrite_client",
    "validate",
]


if __name__ == "__main__":
    os._exit(main())
