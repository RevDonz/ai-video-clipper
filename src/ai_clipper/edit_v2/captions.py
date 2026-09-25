"""Caption and hook track of a document: frame cues + the one ASS file (plan §5.4).

Owner: T1.2a. The cue builder (``subtitles.build_frame_cues``) and the ASS emitter
(``captions_ass.build_ass_v2``) live in ``subtitles.py`` and ``captions_ass.py``;
``captions_ass.py`` stays the only ASS generator. Event times are frame-safe
(``timemap.safe_cs``).

Warnings (plan §3.7), each an ``Issue`` with a JSON pointer, the item or word id and the output
frame to jump to:

* ``glyph_unsupported:U+XXXX``: the pack font (or, for the hook, DejaVu Sans Bold) lacks a
  character of the displayed text. libass then draws it with DejaVu Sans, the only fallback, or
  not at all. One issue per word and character.
* ``hook_overflow``: the hook does not fit three lines at the smallest size; its tail is cut
  with "…".
* ``unsafe_zone``: the bottom of the caption block lies in the TikTok UI zone (the lowest
  280 px of 1280, scaled to the output height), or the top of the hook in its top zone (93 px).
  Seeds keep today's 17% bottom margin (K5), so every seed carries the caption warning. The
  right-hand zone and multi-line caption tops are not estimated here (G5 in ``verify.py``).
"""

from __future__ import annotations

import hashlib
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..captions_ass import HookSpec, build_ass_v2, fit_cues, layout_hook, load_pack
from ..subtitles import FrameCue, SourceWord, build_frame_cues
from .doc import Issue
from .glyphs import font_path, missing_glyphs
from .timemap import Fps, Piece, div_round_half_up, total_frames

HOOK_FONT_FILE = "DejaVuSans-Bold.ttf"  # legacy-bar@1 (DejaVu Sans, bold)
# TikTok UI zone at 720×1280 (plan §5.9 G5), scaled with the output height.
_ZONE_HEIGHT = 1280
_ZONE_TOP = 93
_ZONE_BOTTOM = 280
_E5 = 100_000


@dataclass(frozen=True)
class CaptionResult:
    cues: tuple[FrameCue, ...]
    ass: str  # the exact bytes (UTF-8) burned by FFmpeg and drawn by JASSUB
    ass_sha256: str
    hook_lines: tuple[str, ...]
    warnings: tuple[Issue, ...]  # hook_overflow, glyph_unsupported:U+XXXX, unsafe_zone, …


def _draws_nothing(character: str) -> bool:
    """Characters that never need a glyph: spaces, controls, format marks, selectors."""
    code = ord(character)
    return (character.isspace() or unicodedata.category(character) in ("Cc", "Cf", "Cs")
            or 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF)


def _glyph_issues(text: str, font_file: str, *, path: str, ref: str, frame: int) -> list[Issue]:
    return [
        Issue(f"glyph_unsupported:U+{ord(character):04X}", path, ref, frame)
        for character in missing_glyphs(text, font_path(font_file))
        if not _draws_nothing(character)
    ]


def _source_words(words: Mapping[str, Any], edits: Mapping[str, Any]) -> tuple[SourceWord, ...]:
    source = []
    for word in words["words"]:
        edit = edits.get(word["id"], {})
        if edit.get("hidden"):
            continue
        source.append(SourceWord(word["id"], word["s"], word["e"], edit.get("text", word["t"]),
                                 bool(edit.get("emphasis", False))))
    return tuple(source)


def _hook(doc: Mapping[str, Any], total: int) -> tuple[HookSpec, str, str] | None:
    """The document's hook as a ``HookSpec`` plus its JSON pointer and item id."""
    for track_index, track in enumerate(doc.get("tracks", ())):
        if track.get("kind") != "hook" or not track.get("items"):
            continue
        item = track["items"][0]
        start = item["start"].get("f", 0)
        if start >= total:
            return None
        spec = HookSpec(item["payload"]["text"], start, min(start + item["dur_f"], total),
                        item["transform"]["y_e5"])
        return spec, f"/tracks/{track_index}/items/0", item["id"]
    return None


def caption_track(doc: Mapping, words: Mapping, pieces: Sequence[Piece]) -> CaptionResult:
    """Cues (≤ 4 words, 600 ms output-time gaps, never across the cold-open join), hook lines and
    the ASS document of ``doc`` over ``pieces`` (plan §3.4 word visibility, §5.4)."""
    pieces = tuple(pieces)
    output = doc["output"]
    play_res = (output["w"], output["h"])
    fps = Fps.from_json(output["fps"])
    total = total_frames(pieces)
    captions = doc["captions"]
    pack = load_pack(captions["pack"]["id"], captions["pack"]["v"])
    overrides = captions["overrides"]
    height = play_res[1]
    issues: list[Issue] = []

    cues: tuple[FrameCue, ...] = ()
    if captions["enabled"]:
        edits = captions.get("word_edits", {})
        cues = fit_cues(
            build_frame_cues(_source_words(words, edits), pieces, fps,
                             max_words=pack.words_per_cue),
            pack=pack, play_res=play_res, overrides=overrides,
        )
        for cue in cues:
            for word in cue.words:
                text = word.text.upper() if overrides["case"] == "upper" else word.text
                path = (f"/captions/word_edits/{word.id}/text"
                        if "text" in edits.get(word.id, {}) else "/captions")
                issues += _glyph_issues(text, pack.font_file, path=path, ref=word.id,
                                        frame=word.f0)
        margin_v = div_round_half_up((_E5 - overrides["y_e5"]) * height, _E5)
        bottom_zone = div_round_half_up(_ZONE_BOTTOM * height, _ZONE_HEIGHT)
        if cues and height - margin_v > height - bottom_zone:
            issues.append(Issue("unsafe_zone", "/captions/overrides/y_e5", None, cues[0].f0))

    hook_lines: tuple[str, ...] = ()
    found = _hook(doc, total)
    if found is not None:
        hook, pointer, item_id = found
        layout = layout_hook(hook.text, play_res=play_res, y_e5=hook.y_e5)
        hook_lines = layout.lines
        if layout.lines:
            issues += _glyph_issues(" ".join(layout.lines), HOOK_FONT_FILE,
                                    path=f"{pointer}/payload/text", ref=item_id, frame=hook.f0)
            if layout.overflow:
                issues.append(Issue("hook_overflow", f"{pointer}/payload/text", item_id,
                                    hook.f0))
            if layout.top < div_round_half_up(_ZONE_TOP * height, _ZONE_HEIGHT):
                issues.append(Issue("unsafe_zone", f"{pointer}/transform/y_e5", item_id,
                                    hook.f0))
        hook_spec: HookSpec | None = hook
    else:
        hook_spec = None

    ass = build_ass_v2(cues, play_res=play_res, fps=fps, total_frames=total, pack=pack,
                       overrides=overrides, hook=hook_spec)
    unique: dict[tuple[str, str, str | None], Issue] = {}
    for issue in issues:
        unique.setdefault((issue.code, issue.path, issue.ref), issue)
    return CaptionResult(cues, ass, hashlib.sha256(ass.encode("utf-8")).hexdigest(), hook_lines,
                         tuple(unique.values()))


__all__ = ["HOOK_FONT_FILE", "CaptionResult", "caption_track"]
