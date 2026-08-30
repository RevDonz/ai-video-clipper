import hashlib
import json
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest
from test_edit_manifest import make_manifest
from test_ranking import ranked_input

from ai_clipper.edit_manifest import (
    AudioEdit,
    Audit,
    CaptionCueEdit,
    CaptionStyleEdit,
    EditManifestInvalid,
    LogoOverlay,
    TitleOverlay,
    VisualEdit,
    canonical_manifest_bytes,
    create_edit_manifest,
    manifest_sha256,
    write_edit_manifest,
)
from ai_clipper.models import ClipProfile
from ai_clipper.ranking import (
    SELECTION_VERSION,
    CandidatesArtifact,
    WeightConfig,
    rank_candidates_with_breakdowns,
    write_candidates_artifact,
)
from ai_clipper.render_manifest import (
    ManifestRenderError,
    ManifestRenderTimeout,
    RenderConflict,
    RenderUnsupported,
    UnsupportedRenderMode,
    _ass_escape,
    _build_ass,
    _execute,
    _layout_filter,
    _logo_filter,
    render_from_manifest,
)


def _publish(tmp_path: Path, **changes):
    analysis, _artifact, manifest = make_manifest(tmp_path)
    if changes:
        manifest = replace(manifest, **changes)
    write_edit_manifest(analysis, manifest, expected_revision_sha256=None)
    path = analysis / "edits" / f"{manifest.identity.candidate_id}.edit.v1.json"
    return analysis, manifest, path


def test_ass_escaping_and_wrapping_never_exposes_control_sequences(tmp_path: Path):
    style = CaptionStyleEdit(max_chars_per_line=12, max_lines=2)
    analysis, manifest, _path = _publish(
        tmp_path,
        captions=(
            replace(
                make_manifest(tmp_path / "cue")[2].captions[0],
                text=r"{tag} \\ alpha beta gamma delta",
            ),
        ),
        caption_style=style,
        overlays=(TitleOverlay(text=r"Title {x} \\ safe", x=0.5, y=0.1, max_width=0.8),),
    )

    ass = _build_ass(manifest)

    assert _ass_escape(r"{tag} \\ value") == r"\{tag\} \\\\ value"
    dialogue = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert len(dialogue) == 2
    assert "{tag}" not in ass
    assert "\\N" in dialogue[0]
    assert analysis.is_dir()


def test_strict_binding_rejects_candidate_artifact_tamper_before_ffmpeg(tmp_path: Path):
    analysis, _manifest, manifest_path = _publish(tmp_path)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"not media")
    (analysis / "candidates.v2.json").write_bytes(
        (analysis / "candidates.v2.json").read_bytes() + b" "
    )

    with pytest.raises(EditManifestInvalid):
        render_from_manifest(
            source,
            manifest_path,
            tmp_path / "out.mp4",
            analysis / "candidates.v2.json",
        )


def test_face_track_is_explicitly_unsupported_without_persisted_track(tmp_path: Path):
    analysis, _manifest, manifest_path = _publish(
        tmp_path, visual=VisualEdit(render_mode="face-track")
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"not media")

    with pytest.raises(UnsupportedRenderMode, match="persisted crop track"):
        render_from_manifest(
            source,
            manifest_path,
            tmp_path / "out.mp4",
            analysis / "candidates.v2.json",
        )


def test_logo_asset_must_be_regular_nonsymlink_content_addressed_raster(tmp_path: Path):
    digest = "a" * 64
    logo = LogoOverlay(asset=f"assets/{digest}.png", x=0.8, y=0.2, opacity=0.8, scale=0.2)
    analysis, _manifest, manifest_path = _publish(tmp_path, overlays=(logo,))
    source = tmp_path / "source.mp4"
    source.write_bytes(b"not media")
    root = tmp_path / "assets-root"
    (root / "assets").mkdir(parents=True)
    target = root / logo.asset
    target.symlink_to(source)

    with pytest.raises(ManifestRenderError, match="logo asset"):
        render_from_manifest(
            source,
            manifest_path,
            tmp_path / "out.mp4",
            analysis / "candidates.v2.json",
            logo_assets_root=root,
        )

    target.unlink()
    target.write_bytes(b"not a png")
    with pytest.raises(ManifestRenderError, match="logo asset"):
        render_from_manifest(
            source,
            manifest_path,
            tmp_path / "out.mp4",
            analysis / "candidates.v2.json",
            logo_assets_root=root,
        )


def test_manifest_path_must_be_exact_current_canonical_manifest(tmp_path: Path):
    analysis, manifest, _manifest_path = _publish(tmp_path)
    copied = tmp_path / "copied.json"
    copied.write_bytes(canonical_manifest_bytes(manifest))
    source = tmp_path / "source.mp4"
    source.write_bytes(b"not media")

    with pytest.raises(ManifestRenderError, match="current manifest"):
        render_from_manifest(
            source,
            copied,
            tmp_path / "out.mp4",
            analysis / "candidates.v2.json",
        )


def test_existing_output_is_no_clobber_conflict_and_keeps_existing_bytes(
    tmp_path: Path, monkeypatch
):
    analysis, _manifest, manifest_path = _publish(tmp_path)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    output = tmp_path / "out.mp4"
    output.write_bytes(b"old")

    monkeypatch.setattr(
        "ai_clipper.render_manifest._probe_media",
        lambda *_args, **_kwargs: {"duration": 99.0, "has_video": True, "has_audio": True},
    )

    def fail(*_args, **_kwargs):
        raise ManifestRenderError("FFmpeg render failed")

    monkeypatch.setattr("ai_clipper.render_manifest._execute", fail)
    with pytest.raises(RenderConflict, match="already exists"):
        render_from_manifest(
            source,
            manifest_path,
            output,
            analysis / "candidates.v2.json",
        )

    assert output.read_bytes() == b"old"
    assert not list(tmp_path.glob(".out.mp4.*.tmp.mp4"))
    assert not list(tmp_path.glob("ai-clipper-render-*"))


def test_media_process_timeout_terminates_child():
    with pytest.raises(ManifestRenderTimeout, match="timed out"):
        _execute(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            cwd=None,
            timeout=0.05,
        )


def test_source_and_output_symlinks_are_rejected(tmp_path: Path):
    analysis, _manifest, manifest_path = _publish(tmp_path)
    real = tmp_path / "real.mp4"
    real.write_bytes(b"media")
    source = tmp_path / "source.mp4"
    source.symlink_to(real)

    with pytest.raises(ManifestRenderError, match="source"):
        render_from_manifest(
            source,
            manifest_path,
            tmp_path / "out.mp4",
            analysis / "candidates.v2.json",
        )

    source.unlink()
    source.write_bytes(b"media")
    output = tmp_path / "out.mp4"
    output.symlink_to(real)
    with pytest.raises(ManifestRenderError, match="output"):
        render_from_manifest(
            source,
            manifest_path,
            output,
            analysis / "candidates.v2.json",
        )


def _real_manifest(tmp_path: Path, render_mode: str, source: Path):
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    source_id = source.resolve().as_uri()
    config = WeightConfig()
    selection = rank_candidates_with_breakdowns(
        [ranked_input("real", 0.25, 3.25, "A real short render")],
        source=source_id,
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        source_id,
        ("synthetic render test",),
        config,
        selection.candidates,
        selection.breakdowns,
        selection.media_snapshots,
    )
    candidate_path = analysis / "candidates.v2.json"
    write_candidates_artifact(candidate_path, artifact)
    candidate = artifact.candidates[0]
    cue = CaptionCueEdit(
        cue_id="cue-real",
        index=0,
        start=0.5,
        end=2.75,
        text="Safe captions render across two deterministic lines",
        original_text_sha256=hashlib.sha256(candidate.text.encode()).hexdigest(),
    )
    visual = VisualEdit(
        render_mode=render_mode,
        focal_x=0.2 if render_mode == "center-crop" else None,
        focal_y=0.7 if render_mode == "center-crop" else None,
    )
    manifest = create_edit_manifest(
        candidate_path,
        candidate.candidate_id,
        captions=(cue,),
        caption_style=CaptionStyleEdit(max_chars_per_line=24, max_lines=2),
        visual=visual,
        overlays=(TitleOverlay(text="Verified title", x=0.5, y=0.1, max_width=0.8),),
        audio=AudioEdit(gain_db=-2.0, normalize=True),
        created_at="2026-08-30T01:02:03.456Z",
        editor_schema="renderer-test-v1",
    )
    write_edit_manifest(analysis, manifest, expected_revision_sha256=None)
    manifest_path = analysis / "edits" / f"{candidate.candidate_id}.edit.v1.json"
    return candidate_path, manifest_path


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg tools are unavailable",
)
@pytest.mark.parametrize("render_mode", ["fit-blur", "center-crop"])
def test_real_ffmpeg_render_is_verified_h264_aac_portrait(tmp_path: Path, render_mode: str):
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=24:duration=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    candidate_path, manifest_path = _real_manifest(tmp_path, render_mode, source)
    output = tmp_path / f"{render_mode}.mp4"

    result = render_from_manifest(source, manifest_path, output, candidate_path, timeout=45)

    assert result.output_file == output.name
    assert result.output_path == output.name
    assert not Path(result.output_path).is_absolute()
    assert result.revision == 1
    assert result.video_codec == "h264"
    assert result.audio_codec == "aac"
    assert result.width == 720 and result.height == 1280
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,sample_aspect_ratio:format=duration",
            "-of",
            "json",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(probe.stdout)
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    assert video == {
        "codec_name": "h264",
        "codec_type": "video",
        "width": 720,
        "height": 1280,
        "sample_aspect_ratio": "1:1",
    }
    assert audio["codec_name"] == "aac"
    assert 2.75 <= float(metadata["format"]["duration"]) <= 3.25
    assert not list(tmp_path.glob(f".{output.name}.*.tmp.mp4"))


def test_source_binding_accepts_exact_local_file_uri_and_rejects_other_file(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    candidate_path, manifest_path = _real_manifest(tmp_path, "fit-blur", source)
    other = tmp_path / "other.mp4"
    other.write_bytes(b"media")

    with pytest.raises(RenderUnsupported, match="source content binding unavailable"):
        render_from_manifest(other, manifest_path, tmp_path / "out.mp4", candidate_path)


def test_http_candidate_source_is_explicitly_unsupported(tmp_path: Path):
    analysis, _manifest, manifest_path = _publish(tmp_path)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")

    with pytest.raises(RenderUnsupported, match="source content binding unavailable"):
        render_from_manifest(
            source, manifest_path, tmp_path / "out.mp4", analysis / "candidates.v2.json"
        )


def test_keyword_emphasis_is_rejected_because_manifest_has_no_spans(tmp_path: Path):
    _analysis, manifest, _path = _publish(
        tmp_path, caption_style=CaptionStyleEdit(emphasis="keyword")
    )
    with pytest.raises(RenderUnsupported, match="keyword emphasis spans"):
        _build_ass(manifest)


@pytest.mark.parametrize("preset", ["clean", "bold-keyword", "karaoke", "podcast", "minimal"])
def test_every_caption_preset_has_explicit_ass_semantics(tmp_path: Path, preset: str):
    _analysis, manifest, _path = _publish(
        tmp_path / preset, caption_style=CaptionStyleEdit(preset=preset)
    )
    style_line = next(
        line for line in _build_ass(manifest).splitlines() if line.startswith("Style: Caption")
    )
    assert {
        "clean": ("DejaVu Sans", ",3,2,0,"),
        "bold-keyword": (
            "DejaVu Sans",
            ",-1,0,0,0,",
        ),
        "karaoke": ("DejaVu Sans", ",3,3,0,"),
        "podcast": ("DejaVu Sans", ",3,4,1,"),
        "minimal": ("DejaVu Sans", ",1,1,0,"),
    }[preset][0] in style_line
    assert {
        "clean": ",3,2,0,",
        "bold-keyword": ",-1,0,0,0,",
        "karaoke": ",3,3,0,",
        "podcast": ",3,4,1,",
        "minimal": ",1,1,0,",
    }[preset] in style_line


def test_title_is_clipped_to_safe_area_and_logo_uses_exact_contained_square_box(tmp_path: Path):
    title = TitleOverlay(text="Safe", x=0.5, y=0.1, max_width=0.5)
    logo = LogoOverlay(asset=f"assets/{'a' * 64}.png", x=0.8, y=0.2, opacity=0.8, scale=0.2)
    _analysis, manifest, _path = _publish(tmp_path, overlays=(title, logo))
    ass = _build_ass(manifest)
    assert r"\clip(36,64,684,1216)" in ass

    logo_width = round(720 * logo.scale)
    filters = _layout_filter(manifest) + _logo_filter(logo)
    assert "[1:v]format=rgba,scale=" in filters
    assert "force_original_aspect_ratio=decrease" in filters
    assert f"pad={logo_width}:{logo_width}" in filters


def _fake_render_tools(monkeypatch):
    source_metadata = {
        "duration": 4.0,
        "has_video": True,
        "has_audio": True,
        "video_codec": "h264",
        "audio_codec": "aac",
        "width": 720,
        "height": 1280,
        "sar": "1:1",
    }

    def probe(path, **_kwargs):
        return (
            source_metadata
            if Path(path).name == "source.mp4"
            else {**source_metadata, "duration": 3.0}
        )

    monkeypatch.setattr("ai_clipper.render_manifest._probe_media", probe)

    def execute(argv, **_kwargs):
        if argv[0] == "ffmpeg":
            time.sleep(0.05)
            Path(argv[-1]).write_bytes(b"rendered")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr("ai_clipper.render_manifest._execute", execute)


def test_archived_revision_filename_pins_exact_revision_and_digest(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    candidate_path, current_path = _real_manifest(tmp_path, "fit-blur", source)
    first = __import__(
        "ai_clipper.edit_manifest", fromlist=["read_edit_manifest"]
    ).read_edit_manifest(candidate_path.parent, current_path.name.split(".edit.v1.json")[0])
    first_digest = manifest_sha256(first)
    second = replace(
        first,
        revision=2,
        parent_revision_sha256=first_digest,
        audit=Audit(first.audit.created_at, "2026-08-30T01:03:03.456Z", first.audit.editor_schema),
    )
    write_edit_manifest(candidate_path.parent, second, expected_revision_sha256=first_digest)
    archive = (
        candidate_path.parent
        / "edits"
        / "archive"
        / (f"{first.identity.candidate_id}.edit.v1.r1.{first_digest}.json")
    )
    _fake_render_tools(monkeypatch)

    result = render_from_manifest(source, archive, tmp_path / "r1.mp4", candidate_path)
    assert result.revision == 1 and result.manifest_sha256 == first_digest


def test_manifest_candidate_and_archive_paths_reject_symlinks_or_wrong_digest(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    candidate_path, manifest_path = _real_manifest(tmp_path, "fit-blur", source)
    candidate_link = tmp_path / "candidate-link.json"
    candidate_link.symlink_to(candidate_path)
    with pytest.raises(ManifestRenderError, match="candidate artifact path"):
        render_from_manifest(source, manifest_path, tmp_path / "candidate.mp4", candidate_link)

    manifest_link = manifest_path.with_name("linked.edit.v1.json")
    manifest_link.symlink_to(manifest_path)
    with pytest.raises(ManifestRenderError, match="manifest must be a regular non-symlink file"):
        render_from_manifest(source, manifest_link, tmp_path / "manifest.mp4", candidate_path)

    raw = manifest_path.read_bytes()
    manifest = __import__(
        "ai_clipper.edit_manifest", fromlist=["manifest_from_bytes"]
    ).manifest_from_bytes(raw)
    archive_dir = candidate_path.parent / "edits" / "archive"
    archive_dir.mkdir()
    wrong = archive_dir / (
        f"{manifest.identity.candidate_id}.edit.v1.r{manifest.revision}.{'0' * 64}.json"
    )
    wrong.write_bytes(raw)
    with pytest.raises(ManifestRenderError, match="canonical manifest revision"):
        render_from_manifest(source, wrong, tmp_path / "archive.mp4", candidate_path)


def test_render_is_no_clobber_and_concurrent_calls_have_one_winner(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    candidate_path, manifest_path = _real_manifest(tmp_path, "fit-blur", source)
    output = tmp_path / "out.mp4"
    _fake_render_tools(monkeypatch)
    outcomes = []

    def run():
        try:
            render_from_manifest(source, manifest_path, output, candidate_path)
            outcomes.append("ok")
        except RenderConflict:
            outcomes.append("conflict")

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(outcomes) == ["conflict", "ok"]
    assert output.read_bytes() == b"rendered"
    assert not list(tmp_path.glob(".out.mp4.*.tmp.mp4"))
