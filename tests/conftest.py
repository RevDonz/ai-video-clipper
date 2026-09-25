"""Shared pytest fixtures for the Editor V3 tests (plan §11.0: fixtures only, never autouse).

Test media is generated on the fly by ``support.edit_v2_media`` and cached per session; nothing
here runs unless a test asks for the fixture by name.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path

import pytest
from support import edit_v2_fixtures, edit_v2_media


@pytest.fixture(scope="session")
def edit_v2_ffmpeg() -> str:
    """Path of the local ffmpeg; skips the test when FFmpeg (with ffprobe) is unavailable."""
    path = edit_v2_media.ffmpeg_path()
    if path is None or edit_v2_media.ffprobe_path() is None:
        pytest.skip("ffmpeg/ffprobe not available")
    return path


@pytest.fixture(scope="session")
def edit_v2_libass(edit_v2_ffmpeg: str) -> str:
    """Like ``edit_v2_ffmpeg`` but also requires the ``ass`` filter (libass)."""
    if not edit_v2_media.ffmpeg_has_filter("ass"):
        pytest.skip("ffmpeg was built without libass")
    return edit_v2_ffmpeg


@pytest.fixture
def edit_v2_reference_toolchain() -> None:
    """Skips unless running on the pinned toolchain (image ai-video-clipper:editor-ref)."""
    problem = edit_v2_media.reference_toolchain_problem()
    if problem is not None:
        pytest.skip(f"needs the pinned reference toolchain: {problem}")


@pytest.fixture(scope="session")
def edit_v2_media_factory(
    tmp_path_factory: pytest.TempPathFactory, edit_v2_ffmpeg: str
) -> Callable[..., Path]:
    """``factory(spec, suffix=None) -> Path``: a barcode video for ``spec``, built once per session."""
    root = tmp_path_factory.mktemp("edit_v2_media")
    cache: dict[edit_v2_media.VideoSpec, Path] = {}

    def factory(spec: edit_v2_media.VideoSpec | None = None) -> Path:
        spec = edit_v2_media.VideoSpec() if spec is None else spec
        if spec not in cache:
            path = root / f"barcode-{len(cache):03d}.{spec.container}"
            cache[spec] = edit_v2_media.make_barcode_video(path, spec)
        return cache[spec]

    return factory


@pytest.fixture(scope="session")
def edit_v2_doc_contexts() -> Mapping[str, edit_v2_fixtures.Context]:
    """The committed document-fixture contexts (words artifact, seed, asset store) by id."""
    return {context_id: edit_v2_fixtures.load_context(context_id)
            for context_id in edit_v2_fixtures.CONTEXT_IDS}


@pytest.fixture(scope="session")
def edit_v2_doc_cases() -> tuple[edit_v2_fixtures.FixtureCase, ...]:
    """Every committed document fixture with its expected classification (see index.json)."""
    return edit_v2_fixtures.load_cases()
