import hashlib
import json
import math
import multiprocessing
import os
from dataclasses import replace
from pathlib import Path

import pytest
from test_candidate_api import encoded, task5_artifact

from ai_clipper.edit_manifest import (
    EDIT_MANIFEST_VERSION,
    MAX_EDIT_MANIFEST_BYTES,
    AudioEdit,
    CaptionCueEdit,
    CaptionStyleEdit,
    EditManifestConflict,
    EditManifestInvalid,
    LogoOverlay,
    ManifestIdentity,
    SafeArea,
    TitleOverlay,
    VisualEdit,
    canonical_manifest_bytes,
    create_edit_manifest,
    manifest_from_bytes,
    manifest_sha256,
    read_edit_manifest,
    write_edit_manifest,
)


def setup_analysis(tmp_path: Path) -> tuple[Path, object, str]:
    analysis = tmp_path / "analysis"
    analysis.mkdir(parents=True)
    artifact = task5_artifact()
    (analysis / "candidates.v2.json").write_bytes(encoded(artifact))
    return analysis, artifact, artifact.candidates[0].candidate_id


def cue(candidate, **overrides) -> CaptionCueEdit:
    values = {
        "cue_id": "cue-0001",
        "index": 0,
        "start": candidate.start,
        "end": min(candidate.end, candidate.start + 2.5),
        "text": "Mengapa biaya cloud tinggi?",
        "original_text_sha256": hashlib.sha256(b"Why are cloud bills high?").hexdigest(),
    }
    values.update(overrides)
    return CaptionCueEdit(**values)


def make_manifest(tmp_path: Path, **overrides):
    analysis, artifact, candidate_id = setup_analysis(tmp_path)
    candidate = artifact.candidates[0]
    values = {
        "captions": (cue(candidate),),
        "created_at": "2026-08-30T01:02:03.456Z",
        "editor_schema": "editor-web-v1",
    }
    values.update(overrides)
    manifest = create_edit_manifest(analysis / "candidates.v2.json", candidate_id, **values)
    return analysis, artifact, manifest


def test_contract_round_trip_is_canonical_immutable_and_identity_bound(tmp_path):
    analysis, artifact, manifest = make_manifest(tmp_path)
    candidate = artifact.candidates[0]

    assert EDIT_MANIFEST_VERSION == "clip-edit-v1.0"
    assert manifest.edit_manifest_version == EDIT_MANIFEST_VERSION
    assert manifest.identity.selection_version == "selection-v2.0"
    assert manifest.identity.candidate_id == candidate.candidate_id
    assert (
        manifest.identity.candidate_artifact_sha256
        == hashlib.sha256((analysis / "candidates.v2.json").read_bytes()).hexdigest()
    )
    assert (
        manifest.identity.source_sha256
        == hashlib.sha256(b"https://example.test/a/video.mp4?a=1&b=2").hexdigest()
    )
    assert (manifest.timeline.start, manifest.timeline.end) == (candidate.start, candidate.end)
    assert manifest.identity.profile == candidate.profile.value
    assert manifest.visual == VisualEdit()
    assert manifest.audio == AudioEdit()
    assert manifest.revision == 1 and manifest.parent_revision_sha256 is None

    raw = canonical_manifest_bytes(manifest)
    assert len(raw) <= MAX_EDIT_MANIFEST_BYTES
    assert raw == canonical_manifest_bytes(manifest_from_bytes(raw))
    assert manifest_sha256(manifest) == hashlib.sha256(raw).hexdigest()
    assert b"EXAMPLE.test" not in raw and b'source"' not in raw
    with pytest.raises(AttributeError):
        manifest.revision = 2


def test_json_shape_is_exact_and_canonical_hash_is_key_order_independent(tmp_path):
    _analysis, _artifact, manifest = make_manifest(tmp_path)
    payload = json.loads(canonical_manifest_bytes(manifest))
    assert set(payload) == {
        "edit_manifest_version",
        "identity",
        "revision",
        "parent_revision_sha256",
        "timeline",
        "visual",
        "caption_style",
        "captions",
        "overlays",
        "audio",
        "audit",
    }
    reordered = json.dumps(payload, ensure_ascii=False, sort_keys=False).encode()
    assert manifest_sha256(manifest_from_bytes(reordered)) == manifest_sha256(manifest)

    payload["unknown"] = True
    with pytest.raises(EditManifestInvalid):
        manifest_from_bytes(json.dumps(payload).encode())


def test_strict_json_rejects_duplicates_nonfinite_invalid_utf8_and_oversize(tmp_path):
    _analysis, _artifact, manifest = make_manifest(tmp_path)
    raw = canonical_manifest_bytes(manifest)
    duplicate = raw.replace(b'"revision":1', b'"revision":1,"revision":1', 1)
    nonfinite = raw.replace(b'"gain_db":0.0', b'"gain_db":NaN', 1)
    for value in (duplicate, nonfinite, b"\xff", b" " * (MAX_EDIT_MANIFEST_BYTES + 1)):
        with pytest.raises(EditManifestInvalid):
            manifest_from_bytes(value)


def test_caption_cues_are_bounded_nfc_sorted_nonoverlapping_and_touching_is_allowed(tmp_path):
    analysis, artifact, _candidate_id = setup_analysis(tmp_path)
    candidate = artifact.candidates[0]
    first = cue(candidate, end=1.0, text="Café")
    second = cue(candidate, cue_id="cue-0002", index=1, start=1.0, end=2.0)
    manifest = create_edit_manifest(
        analysis / "candidates.v2.json",
        candidate.candidate_id,
        captions=(first, second),
        created_at="2026-08-30T01:02:03.456Z",
        editor_schema="editor-web-v1",
    )
    assert len(manifest.captions) == 2

    invalid = [
        lambda: (replace(first, text="Cafe\u0301"),),
        lambda: (replace(first, text="bad\nline"),),
        lambda: (replace(first, text="x" * 501),),
        lambda: (replace(first, start=-0.1),),
        lambda: (second, first),
        lambda: (first, replace(second, start=0.9)),
        lambda: (first, replace(second, index=0)),
        lambda: (first, replace(second, cue_id=first.cue_id)),
    ]
    for build_captions in invalid:
        with pytest.raises((EditManifestInvalid, ValueError, TypeError)):
            create_edit_manifest(
                analysis / "candidates.v2.json",
                candidate.candidate_id,
                captions=build_captions(),
                created_at="2026-08-30T01:02:03.456Z",
                editor_schema="editor-web-v1",
            )


def test_visual_caption_overlay_and_audio_controls_are_strict(tmp_path):
    analysis, artifact, _candidate_id = setup_analysis(tmp_path)
    candidate = artifact.candidates[0]
    visual = VisualEdit(
        render_mode="center-crop",
        safe_area=SafeArea(top=0.1, right=0.05, bottom=0.1, left=0.05),
        focal_x=0.25,
        focal_y=0.75,
    )
    style = CaptionStyleEdit(
        preset="bold-keyword",
        position="bottom",
        font_family="Inter",
        font_size=48,
        color="#FFFFFF",
        keyword_color="#DFFF58",
        background_color="#000000",
        background_opacity=0.7,
        max_chars_per_line=32,
        max_lines=2,
        emphasis="keyword",
    )
    overlays = (
        TitleOverlay(text="Cloud costs", x=0.5, y=0.1, max_width=0.8),
        LogoOverlay(
            asset="assets/" + "a" * 64 + ".png",
            x=0.8,
            y=0.2,
            opacity=0.8,
            scale=0.2,
        ),
    )
    manifest = create_edit_manifest(
        analysis / "candidates.v2.json",
        candidate.candidate_id,
        captions=(cue(candidate),),
        visual=visual,
        caption_style=style,
        overlays=overlays,
        audio=AudioEdit(gain_db=-3.0, normalize=True),
        created_at="2026-08-30T01:02:03.456Z",
        editor_schema="editor-web-v1",
    )
    assert manifest.visual.canvas_width == 720
    assert manifest.visual.canvas_height == 1280

    # Logo x/y are its center. Scale is square pixel width as a fraction of
    # canvas width, so its normalized vertical size includes 720 / 1280.
    safe = SafeArea(top=0.1, right=0.1, bottom=0.1, left=0.1)
    scale = 0.2
    vertical_half = scale * 720 / 1280 / 2
    boundary_logos = (
        LogoOverlay(
            asset="assets/" + "b" * 64 + ".png",
            x=0.2,
            y=0.1 + vertical_half,
            opacity=1.0,
            scale=scale,
        ),
        LogoOverlay(
            asset="assets/" + "b" * 64 + ".png",
            x=0.8,
            y=0.9 - vertical_half,
            opacity=1.0,
            scale=scale,
        ),
    )
    for logo in boundary_logos:
        create_edit_manifest(
            analysis / "candidates.v2.json",
            candidate.candidate_id,
            captions=(cue(candidate),),
            visual=VisualEdit(safe_area=safe),
            overlays=(logo,),
            created_at="2026-08-30T01:02:03.456Z",
            editor_schema="editor-web-v1",
        )
    for logo in (
        replace(boundary_logos[0], x=0.2 - 1e-6),
        replace(boundary_logos[0], y=0.1 + vertical_half - 1e-6),
        replace(boundary_logos[1], x=0.8 + 1e-6),
        replace(boundary_logos[1], y=0.9 - vertical_half + 1e-6),
    ):
        with pytest.raises(ValueError, match="logo footprint"):
            create_edit_manifest(
                analysis / "candidates.v2.json",
                candidate.candidate_id,
                captions=(cue(candidate),),
                visual=VisualEdit(safe_area=safe),
                overlays=(logo,),
                created_at="2026-08-30T01:02:03.456Z",
                editor_schema="editor-web-v1",
            )

    invalid_factories = [
        lambda: VisualEdit(canvas_width=1080),
        lambda: VisualEdit(render_mode="stretch"),
        lambda: VisualEdit(render_mode="fit-blur", focal_x=0.5, focal_y=0.5),
        lambda: VisualEdit(render_mode="center-crop", focal_x=0.5, focal_y=None),
        lambda: SafeArea(top=0.6, bottom=0.5),
        lambda: CaptionStyleEdit(preset="unbundled"),
        lambda: CaptionStyleEdit(font_size=True),
        lambda: CaptionStyleEdit(font_size=17),
        lambda: CaptionStyleEdit(color="#fff"),
        lambda: CaptionStyleEdit(keyword_color="yellow"),
        lambda: CaptionStyleEdit(font_family="/tmp/font.ttf"),
        lambda: CaptionStyleEdit(background_opacity=math.inf),
        lambda: TitleOverlay(text="x" * 101),
        lambda: LogoOverlay(asset="../logo.png"),
        lambda: LogoOverlay(asset="https://example.test/logo.png"),
        lambda: AudioEdit(gain_db=True),
        lambda: AudioEdit(gain_db=12.1),
    ]
    for factory in invalid_factories:
        with pytest.raises((EditManifestInvalid, ValueError, TypeError)):
            factory()


@pytest.mark.parametrize("field,value", [("canvas_width", 720.0), ("canvas_height", 1280.0)])
def test_visual_canvas_dimensions_require_integers_in_constructor_and_json(tmp_path, field, value):
    with pytest.raises(TypeError, match=f"{field} must be an integer"):
        VisualEdit(**{field: value})

    _analysis, _artifact, manifest = make_manifest(tmp_path)
    payload = json.loads(canonical_manifest_bytes(manifest))
    payload["visual"][field] = value
    with pytest.raises(EditManifestInvalid):
        manifest_from_bytes(json.dumps(payload).encode())


def test_bool_number_control_and_unicode_rules_apply_after_decode(tmp_path):
    _analysis, _artifact, manifest = make_manifest(tmp_path)
    payload = json.loads(canonical_manifest_bytes(manifest))
    payload["revision"] = True
    with pytest.raises(EditManifestInvalid):
        manifest_from_bytes(json.dumps(payload).encode())

    payload = json.loads(canonical_manifest_bytes(manifest))
    payload["audit"]["editor_schema"] = "editor-e\u0301"
    with pytest.raises(EditManifestInvalid):
        manifest_from_bytes(json.dumps(payload).encode())


def test_unicode_surrogates_are_rejected_by_all_free_text_contracts(tmp_path):
    _analysis, _artifact, manifest = make_manifest(tmp_path)
    surrogate = "bad\ud800text"
    with pytest.raises(ValueError):
        replace(manifest.captions[0], text=surrogate)
    with pytest.raises(ValueError):
        TitleOverlay(text=surrogate, x=0.5, y=0.5, max_width=0.2)
    with pytest.raises(ValueError):
        ManifestIdentity(
            selection_version=surrogate,
            candidate_id=manifest.identity.candidate_id,
            candidate_artifact_sha256=manifest.identity.candidate_artifact_sha256,
            source_sha256=manifest.identity.source_sha256,
            candidate_start=manifest.identity.candidate_start,
            candidate_end=manifest.identity.candidate_end,
            profile=manifest.identity.profile,
        )
    raw = canonical_manifest_bytes(manifest).replace(
        b"Mengapa biaya cloud tinggi?", b"bad\\ud800text"
    )
    with pytest.raises(EditManifestInvalid):
        manifest_from_bytes(raw)


def test_signed_zero_is_canonicalized_and_noncanonical_storage_is_rejected(tmp_path):
    analysis, _artifact, manifest = make_manifest(tmp_path, audio=AudioEdit(gain_db=-0.0))
    positive = replace(manifest, audio=AudioEdit(gain_db=0.0))
    assert math.copysign(1.0, manifest.audio.gain_db) == 1.0
    assert canonical_manifest_bytes(manifest) == canonical_manifest_bytes(positive)
    assert manifest_sha256(manifest) == manifest_sha256(positive)

    write_edit_manifest(analysis, manifest, expected_revision_sha256=None)
    target = analysis / "edits" / f"{manifest.identity.candidate_id}.edit.v1.json"
    target.write_bytes(target.read_bytes().replace(b'"gain_db":0.0', b'"gain_db":-0.0'))
    with pytest.raises(EditManifestInvalid, match="not canonical"):
        read_edit_manifest(analysis, manifest.identity.candidate_id)


def test_candidate_tamper_wrong_identity_and_immutable_window_are_rejected(tmp_path):
    analysis, _artifact, manifest = make_manifest(tmp_path)
    candidate_path = analysis / "candidates.v2.json"
    candidate_path.write_bytes(candidate_path.read_bytes() + b" ")
    with pytest.raises(EditManifestInvalid):
        write_edit_manifest(analysis, manifest, expected_revision_sha256=None)

    analysis, _artifact, manifest = make_manifest(tmp_path / "fresh")
    with pytest.raises((EditManifestInvalid, ValueError)):
        write_edit_manifest(
            analysis,
            replace(manifest, timeline=replace(manifest.timeline, end=29.0)),
            expected_revision_sha256=None,
        )
    with pytest.raises(EditManifestInvalid):
        create_edit_manifest(
            analysis / "candidates.v2.json",
            "cand_" + "f" * 64,
            captions=(),
            created_at="2026-08-30T01:02:03.456Z",
            editor_schema="editor-web-v1",
        )


def next_revision(manifest, parent: str, text: str, updated_at: str):
    edited_cue = replace(manifest.captions[0], text=text)
    return replace(
        manifest,
        revision=manifest.revision + 1,
        parent_revision_sha256=parent,
        captions=(edited_cue, *manifest.captions[1:]),
        audit=replace(manifest.audit, updated_at=updated_at),
    )


def test_storage_creates_canonical_path_and_archives_every_previous_revision(tmp_path):
    analysis, _artifact, first = make_manifest(tmp_path)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    current = analysis / "edits" / f"{first.identity.candidate_id}.edit.v1.json"
    assert current.read_bytes() == canonical_manifest_bytes(first)
    assert read_edit_manifest(analysis, first.identity.candidate_id) == first

    second = next_revision(first, first_sha, "Biaya cloud tinggi.", "2026-08-30T01:03:03.456Z")
    second_sha = write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)
    assert read_edit_manifest(analysis, first.identity.candidate_id) == second
    archive = list((analysis / "edits" / "archive").glob("*.json"))
    assert len(archive) == 1
    assert archive[0].read_bytes() == canonical_manifest_bytes(first)
    assert first_sha in archive[0].name
    assert archive[0].name == f"{first.identity.candidate_id}.edit.v1.r1.{first_sha}.json"

    third = next_revision(second, second_sha, "Cloud mahal.", "2026-08-30T01:04:03.456Z")
    write_edit_manifest(analysis, third, expected_revision_sha256=second_sha)
    assert len(list((analysis / "edits" / "archive").glob("*.json"))) == 2
    assert list((analysis / "edits").glob(".*.tmp")) == []


def test_revision_conflicts_and_invalid_chains_never_replace_current(tmp_path):
    analysis, _artifact, first = make_manifest(tmp_path)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    original = canonical_manifest_bytes(first)
    valid = next_revision(first, first_sha, "Edit", "2026-08-30T01:03:03.456Z")

    invalid = [
        (valid, "f" * 64),
        (replace(valid, revision=3), first_sha),
        (replace(valid, parent_revision_sha256="e" * 64), first_sha),
        (
            replace(valid, audit=replace(valid.audit, created_at="2026-08-30T01:01:03.456Z")),
            first_sha,
        ),
    ]
    for candidate, expected in invalid:
        with pytest.raises((EditManifestConflict, EditManifestInvalid)):
            write_edit_manifest(analysis, candidate, expected_revision_sha256=expected)
        assert (
            analysis / "edits" / f"{first.identity.candidate_id}.edit.v1.json"
        ).read_bytes() == original


@pytest.mark.parametrize("change", ["hash", "timing", "add", "delete", "reorder"])
def test_revision_caption_source_bindings_are_immutable(tmp_path, change):
    analysis, artifact, first = make_manifest(tmp_path)
    candidate = artifact.candidates[0]
    second_cue = cue(
        candidate,
        cue_id="cue-0002",
        index=1,
        start=first.captions[0].end,
        end=min(candidate.end, first.captions[0].end + 1),
    )
    first = replace(first, captions=(first.captions[0], second_cue))
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    valid = next_revision(first, first_sha, "Edited", "2026-08-30T01:03:03.456Z")

    if change == "hash":
        captions = (
            replace(valid.captions[0], original_text_sha256="f" * 64),
            valid.captions[1],
        )
    elif change == "timing":
        captions = (
            replace(valid.captions[0], end=valid.captions[0].end - 0.01),
            valid.captions[1],
        )
    elif change == "add":
        captions = (
            *valid.captions,
            cue(
                candidate,
                cue_id="cue-0003",
                index=2,
                start=second_cue.end,
                end=min(candidate.end, second_cue.end + 0.5),
            ),
        )
    elif change == "delete":
        captions = (valid.captions[0],)
    else:
        captions = (
            replace(
                valid.captions[0],
                cue_id=valid.captions[1].cue_id,
                original_text_sha256=valid.captions[1].original_text_sha256,
            ),
            replace(
                valid.captions[1],
                cue_id=valid.captions[0].cue_id,
                original_text_sha256=valid.captions[0].original_text_sha256,
            ),
        )
    with pytest.raises(EditManifestInvalid, match="caption source bindings"):
        write_edit_manifest(
            analysis,
            replace(valid, captions=captions),
            expected_revision_sha256=first_sha,
        )


def _try_revision(args):
    analysis, raw, expected = args
    manifest = manifest_from_bytes(raw)
    try:
        return (
            "ok",
            write_edit_manifest(Path(analysis), manifest, expected_revision_sha256=expected),
        )
    except EditManifestConflict:
        return ("conflict", None)


def test_concurrent_updates_serialize_with_one_winner_and_no_lost_archive(tmp_path):
    analysis, _artifact, first = make_manifest(tmp_path)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    a = next_revision(first, first_sha, "Edit A", "2026-08-30T01:03:03.456Z")
    b = next_revision(first, first_sha, "Edit B", "2026-08-30T01:03:04.456Z")
    ctx = multiprocessing.get_context("fork")
    with ctx.Pool(2) as pool:
        results = pool.map(
            _try_revision,
            [
                (str(analysis), canonical_manifest_bytes(a), first_sha),
                (str(analysis), canonical_manifest_bytes(b), first_sha),
            ],
        )
    assert sorted(item[0] for item in results) == ["conflict", "ok"]
    assert read_edit_manifest(analysis, first.identity.candidate_id).captions[0].text in {
        "Edit A",
        "Edit B",
    }
    assert len(list((analysis / "edits" / "archive").glob("*.json"))) == 1


def test_symlink_fifo_and_path_traversal_targets_are_rejected_without_hanging(tmp_path):
    analysis, _artifact, manifest = make_manifest(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (analysis / "edits").symlink_to(outside, target_is_directory=True)
    with pytest.raises(EditManifestInvalid):
        write_edit_manifest(analysis, manifest, expected_revision_sha256=None)

    analysis, _artifact, manifest = make_manifest(tmp_path / "target")
    edits = analysis / "edits"
    edits.mkdir()
    target = edits / f"{manifest.identity.candidate_id}.edit.v1.json"
    outside_file = tmp_path / "outside.json"
    outside_file.write_text("{}")
    target.symlink_to(outside_file)
    with pytest.raises(EditManifestInvalid):
        write_edit_manifest(analysis, manifest, expected_revision_sha256=None)
    assert outside_file.read_text() == "{}"

    target.unlink()
    os.mkfifo(target)
    with pytest.raises(EditManifestInvalid):
        read_edit_manifest(analysis, manifest.identity.candidate_id)

    with pytest.raises(EditManifestInvalid):
        read_edit_manifest(analysis, "../candidate")


def test_replace_failure_preserves_current_cleans_temp_and_keeps_append_only_archive(
    tmp_path, monkeypatch
):
    analysis, _artifact, first = make_manifest(tmp_path)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    second = next_revision(first, first_sha, "Edit", "2026-08-30T01:03:03.456Z")
    module = __import__("ai_clipper.edit_manifest", fromlist=["os"])

    def fail_replace(_source, _target):
        raise OSError("injected replace failure")

    monkeypatch.setattr(module.os, "replace", fail_replace)
    with pytest.raises(OSError):
        write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)

    current = analysis / "edits" / f"{first.identity.candidate_id}.edit.v1.json"
    assert current.read_bytes() == canonical_manifest_bytes(first)
    assert list((analysis / "edits").glob(".*.tmp")) == []
    archives = list((analysis / "edits" / "archive").glob("*.json"))
    assert len(archives) == 1 and archives[0].read_bytes() == canonical_manifest_bytes(first)

    monkeypatch.undo()
    assert write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)
    assert read_edit_manifest(analysis, first.identity.candidate_id) == second
    assert len(list((analysis / "edits" / "archive").glob("*.json"))) == 1


def test_existing_archive_must_be_regular_and_byte_identical(tmp_path):
    analysis, _artifact, first = make_manifest(tmp_path)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    second = next_revision(first, first_sha, "Edit", "2026-08-30T01:03:03.456Z")
    archive_dir = analysis / "edits" / "archive"
    archive_dir.mkdir()
    archive = archive_dir / f"{first.identity.candidate_id}.edit.v1.r1.{first_sha}.json"
    archive.write_bytes(b"not the archived revision")

    with pytest.raises(EditManifestInvalid):
        write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)
    assert read_edit_manifest(analysis, first.identity.candidate_id) == first


def test_new_storage_directories_fsync_their_parent_after_mkdir(tmp_path, monkeypatch):
    analysis, _artifact, first = make_manifest(tmp_path)
    module = __import__("ai_clipper.edit_manifest", fromlist=["os"])
    events = []
    real_mkdir = Path.mkdir
    real_fsync_directory = module._fsync_directory

    def recording_mkdir(path, *args, **kwargs):
        result = real_mkdir(path, *args, **kwargs)
        if path.name in {"edits", "archive"}:
            events.append(("mkdir", path.name))
        return result

    def recording_fsync(path):
        if path.name in {"analysis", "edits"}:
            events.append(("fsync", path.name))
        return real_fsync_directory(path)

    monkeypatch.setattr(Path, "mkdir", recording_mkdir)
    monkeypatch.setattr(module, "_fsync_directory", recording_fsync)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    second = next_revision(first, first_sha, "Edit", "2026-08-30T01:03:03.456Z")
    write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)

    edits_mkdir = events.index(("mkdir", "edits"))
    archive_mkdir = events.index(("mkdir", "archive"))
    assert events[edits_mkdir + 1] == ("fsync", "analysis")
    assert events[archive_mkdir + 1] == ("fsync", "edits")


def test_existing_storage_directory_retry_fsyncs_parent_after_prior_failure(tmp_path, monkeypatch):
    module = __import__("ai_clipper.edit_manifest", fromlist=["os"])
    directory = tmp_path / "edits"
    calls = []

    def fail_once(path):
        calls.append(path)
        if len(calls) == 1:
            raise OSError("injected directory fsync failure")

    monkeypatch.setattr(module, "_fsync_directory", fail_once)
    with pytest.raises(OSError, match="injected directory fsync failure"):
        module._ensure_directory(directory)
    assert directory.is_dir()

    module._ensure_directory(directory)
    assert calls == [tmp_path, tmp_path]


def test_archive_retry_fsyncs_existing_identical_archive_before_advancing(tmp_path, monkeypatch):
    analysis, _artifact, first = make_manifest(tmp_path)
    first_sha = write_edit_manifest(analysis, first, expected_revision_sha256=None)
    second = next_revision(first, first_sha, "Edit", "2026-08-30T01:03:03.456Z")
    archive_dir = analysis / "edits" / "archive"
    module = __import__("ai_clipper.edit_manifest", fromlist=["os"])
    real_fsync_directory = module._fsync_directory
    archive_fsyncs = []

    def fail_first_archive_fsync(path):
        if path == archive_dir:
            archive_fsyncs.append(path)
            if len(archive_fsyncs) == 1:
                raise OSError("injected archive fsync failure")
        return real_fsync_directory(path)

    monkeypatch.setattr(module, "_fsync_directory", fail_first_archive_fsync)
    with pytest.raises(OSError, match="injected archive fsync failure"):
        write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)
    assert read_edit_manifest(analysis, first.identity.candidate_id) == first
    assert len(list(archive_dir.glob("*.json"))) == 1

    write_edit_manifest(analysis, second, expected_revision_sha256=first_sha)
    assert read_edit_manifest(analysis, first.identity.candidate_id) == second
    assert archive_fsyncs == [archive_dir, archive_dir]


def test_stored_tamper_duplicate_and_oversize_are_rejected(tmp_path):
    analysis, _artifact, manifest = make_manifest(tmp_path)
    write_edit_manifest(analysis, manifest, expected_revision_sha256=None)
    target = analysis / "edits" / f"{manifest.identity.candidate_id}.edit.v1.json"
    raw = target.read_bytes()
    target.write_bytes(raw.replace(b'"revision":1', b'"revision":1,"revision":1'))
    with pytest.raises(EditManifestInvalid):
        read_edit_manifest(analysis, manifest.identity.candidate_id)

    reordered = json.dumps(json.loads(raw), sort_keys=False).encode()
    assert reordered != raw
    target.write_bytes(reordered)
    with pytest.raises(EditManifestInvalid):
        read_edit_manifest(analysis, manifest.identity.candidate_id)

    target.write_bytes(b" " * (MAX_EDIT_MANIFEST_BYTES + 1))
    with pytest.raises(EditManifestInvalid):
        read_edit_manifest(analysis, manifest.identity.candidate_id)
