"""The audio filter fragment: pieces, envelopes, music and mix (plan §5.3, §5.6; T1.4).

String goldens pin the fragment for every shape; the FFmpeg tests run it through the audio-only
harness (``support.edit_v2_audio_harness``) on the local toolchain. The gate numbers of record
are measured in the reference image (``python -m support.edit_v2_audio_harness gates``).
"""

from __future__ import annotations

import array
import copy
import math
import re
import struct

import pytest
from support import edit_v2_audio_harness as harness
from support import edit_v2_media as media

from ai_clipper.edit_v2 import audio_graph as ag
from ai_clipper.edit_v2 import envelope as env
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.compile_ffmpeg import InputSpec

PAN = "pan=stereo|FL=FL+FC|FR=FR+FC"
FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
ENV_OPTIONS = ("-f", "f32le", "-ar", "48000", "-ac", "1")
SOURCE_MS = harness.SOURCE_MS


def _piece(i: int, a: int, b: int) -> str:
    return (f"[sa{i}]aresample=48000,{PAN},asettb=1/48000,apad,"
            f"atrim=start_pts={a}:end_pts={b},asetpts=PTS-STARTPTS")


def _plan(doc, words=None):
    return harness.plan_for(doc, harness.burst_words(SOURCE_MS) if words is None else words)


# --- string goldens --------------------------------------------------------------------------------


def test_single_piece_without_edits_is_one_chain():
    doc = harness.audio_doc(segments=(("seg_b1", "body", 43, 540),))
    fragment = ag.audio_fragment(_plan(doc), mode="final", first_input_index=1)
    # smp(43) = 68868; smp(497) = 795995 samples.
    assert fragment.graph == _piece(0, 68868, 864863) + f",{FORMAT}[apre]"
    assert fragment.inputs == ()
    assert fragment.sidecars == {}


def test_cold_open_and_jump_cuts_golden():
    plan = _plan(harness.click_doc())
    assert [(p.in_sf, p.out_sf, p.out_f0) for p in plan.pieces] == [
        (312, 385, 0), (43, 105, 73), (136, 202, 135), (227, 405, 201), (468, 540, 379),
    ]
    fragment = ag.audio_fragment(plan, mode="reference", first_input_index=5)
    assert fragment.graph == ";".join([
        _piece(0, 499699, 616615) + "[au_p0]",
        _piece(1, 68868, 168168) + "[au_p1]",
        _piece(2, 217817, 323522) + "[au_p2]",
        _piece(3, 363563, 648648) + "[au_p3]",
        _piece(4, 749548, 864863) + "[au_p4]",
        "[au_p0][au_p1][au_p2][au_p3][au_p4]concat=n=5:v=0:a=1[au_sc]",
        "[5:a]pan=stereo|c0=c0|c1=c0[au_se]",
        f"[au_sc][au_se]amultiply,{FORMAT}[apre]",
    ])
    assert fragment.inputs == (InputSpec("sidecar", "audio-speech.f32", ENV_OPTIONS),)
    expected = env.expand_f32(
        env.speech_envelope(plan.pieces, {"seg_co": 30}, 8, plan.fps, 0), plan.total_samples)
    assert fragment.sidecars == {"audio-speech.f32": expected}
    assert plan.total_samples == 722321


def test_music_without_source_audio_golden():
    doc = harness.audio_doc(segments=(("seg_b1", "body", 0, 600),), has_audio=False,
                            music={"gain_cdb": 0, "fade_in_f": 0, "fade_out_f": 0})
    plan = _plan(doc, harness.DUCK_WORDS_MS)
    fragment = ag.audio_fragment(plan, mode="audio_preview", first_input_index=0)
    assert fragment.graph == ";".join([
        "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=960960[au_s]",
        (f"[0:a]aresample=48000,{PAN},atrim=start_sample=0:end_sample=960960,"
         "asetpts=PTS-STARTPTS[au_mr]"),
        "[1:a]pan=stereo|c0=c0|c1=c0[au_me]",
        "[au_mr][au_me]amultiply[au_m]",
        f"[au_s][au_m]amix=inputs=2:normalize=0:duration=first,{FORMAT}[apre]",
    ])
    assert fragment.inputs == (
        InputSpec("asset", harness.MUSIC_ASSET, ("-stream_loop", "-1", "-f", "mov")),
        InputSpec("sidecar", "audio-music.f32", ENV_OPTIONS),
    )
    item = doc["tracks"][0]["items"][0]
    assert fragment.sidecars["audio-music.f32"] == env.expand_f32(
        env.music_envelope(plan.speech_spans, item, plan.total_samples, plan.fps),
        plan.total_samples)


def test_full_mix_input_order_and_numbering():
    doc = harness.click_doc(source_gain_cdb=-300,
                            music={"gain_cdb": -800, "src_in_smp": 12_345, "loop": False})
    plan = _plan(doc)
    fragment = ag.audio_fragment(plan, mode="final", first_input_index=5)
    assert fragment.inputs == (
        InputSpec("sidecar", "audio-speech.f32", ENV_OPTIONS),
        InputSpec("asset", harness.MUSIC_ASSET, ("-f", "mov")),
        InputSpec("sidecar", "audio-music.f32", ENV_OPTIONS),
    )
    tail = fragment.graph.split(";")[-6:]
    assert tail == [
        "[5:a]pan=stereo|c0=c0|c1=c0[au_se]",
        "[au_sc][au_se]amultiply[au_s]",
        (f"[6:a]aresample=48000,{PAN},atrim=start_sample=12345:end_sample={12_345 + 722_321},"
         "asetpts=PTS-STARTPTS[au_mr]"),
        "[7:a]pan=stereo|c0=c0|c1=c0[au_me]",
        "[au_mr][au_me]amultiply[au_m]",
        f"[au_s][au_m]amix=inputs=2:normalize=0:duration=first,{FORMAT}[apre]",
    ]


def test_constant_unity_music_needs_no_envelope_input():
    doc = harness.audio_doc(segments=(("seg_b1", "body", 43, 540),),
                            music={"gain_cdb": 0, "fade_in_f": 0, "fade_out_f": 0,
                                   "duck": {"on": False}})
    fragment = ag.audio_fragment(_plan(doc), mode="final", first_input_index=1)
    assert fragment.inputs == (
        InputSpec("asset", harness.MUSIC_ASSET, ("-stream_loop", "-1", "-f", "mov")),
    )
    assert fragment.graph.split(";") == [
        _piece(0, 68868, 864863) + "[au_s]",
        (f"[1:a]aresample=48000,{PAN},atrim=start_sample=0:end_sample=795995,"
         "asetpts=PTS-STARTPTS[au_m]"),
        f"[au_s][au_m]amix=inputs=2:normalize=0:duration=first,{FORMAT}[apre]",
    ]


def test_no_audio_and_no_music_is_exact_silence():
    doc = harness.audio_doc(segments=(("seg_b1", "body", 43, 540),), has_audio=False)
    fragment = ag.audio_fragment(_plan(doc), mode="final", first_input_index=0)
    assert fragment.graph == (
        "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=795995,"
        f"{FORMAT}[apre]"
    )


# --- seam rules (CONTRACTS §5.8) ---------------------------------------------------------------------


def _shapes():
    return [
        harness.audio_doc(segments=(("seg_b1", "body", 43, 540),)),
        harness.click_doc(),
        harness.click_doc(source_gain_cdb=600, music={"gain_cdb": -800}),
        harness.audio_doc(segments=(("seg_b1", "body", 0, 600),), has_audio=False,
                          music={"gain_cdb": 0}),
        harness.audio_doc(segments=(("seg_b1", "body", 0, 600),), has_audio=False),
    ]


@pytest.mark.parametrize("index", range(5))
def test_labels_inputs_and_sidecars_follow_the_seam_rules(index):
    doc = _shapes()[index]
    plan = _plan(doc)
    for first in (0, 3, 11):
        fragment = ag.audio_fragment(plan, mode="final", first_input_index=first)
        labels = re.findall(r"\[([^\]]+)\]", fragment.graph)
        outputs = re.findall(r"\[([^\]]+)\](?=;|$)", fragment.graph)
        assert outputs.count("apre") == 1 and fragment.graph.endswith("[apre]")
        own = {str(first + k) + ":a" for k in range(len(fragment.inputs))}
        sources = {f"sa{i}" for i in range(len(plan.pieces))}
        for label in labels:
            assert (label == "apre" or label.startswith(ag.LABEL_PREFIX) or label in own
                    or (label in sources and doc["base"]["source"]["has_audio"])), label
        for name in fragment.sidecars:
            assert re.fullmatch(r"audio-[a-z0-9-]+\.[a-z0-9]+", name)
        assert {s.name for s in fragment.inputs if s.kind == "sidecar"} == set(fragment.sidecars)
        for sidecar, data in fragment.sidecars.items():
            assert len(data) == 4 * plan.total_samples, sidecar


def test_the_graph_never_contains_asset_names_paths_or_user_text():
    doc = harness.click_doc(music={"gain_cdb": -800})
    fragment = ag.audio_fragment(_plan(doc), mode="final", first_input_index=0)
    assert harness.MUSIC_ASSET.split(":")[1] not in fragment.graph
    assert "/" not in fragment.graph.replace("asettb=1/48000", "")
    assert re.fullmatch(r"[A-Za-z0-9_\[\]:;,=|+\-/.]+", fragment.graph)


def test_every_mode_gives_the_same_fragment_and_mix_sha():
    plan = _plan(harness.click_doc(source_gain_cdb=-300, music={"gain_cdb": -800}))
    fragments = [ag.audio_fragment(plan, mode=mode, first_input_index=5)
                 for mode in ag.AUDIO_MODES]
    assert len({f.graph for f in fragments}) == 1
    assert len({f.mix_sha256 for f in fragments}) == 1
    assert all(f.sidecars == fragments[0].sidecars for f in fragments)
    assert re.fullmatch(r"[0-9a-f]{64}", fragments[0].mix_sha256)


def test_mix_sha_ignores_input_numbering_and_tracks_every_audible_change():
    base = harness.click_doc(music={"gain_cdb": -800})
    sha = ag.audio_fragment(_plan(base), mode="final", first_input_index=0).mix_sha256
    assert ag.audio_fragment(_plan(base), mode="final", first_input_index=9).mix_sha256 == sha
    changes = [
        harness.click_doc(music={"gain_cdb": -700}),
        harness.click_doc(music={"gain_cdb": -800, "loop": False}),
        harness.click_doc(music={"gain_cdb": -800, "duck": {"depth_cdb": 900}}),
        harness.click_doc(music={"gain_cdb": -800}, cut_fade_ms=9),
        harness.click_doc(music={"gain_cdb": -800}, source_gain_cdb=-100),
        harness.click_doc(music={"gain_cdb": -800}, has_audio=False),
    ]
    other_source = copy.deepcopy(base)
    other_source["base"]["source"]["content_sha256"] = "d" * 64
    changes.append(other_source)
    shas = {ag.audio_fragment(_plan(doc), mode="final", first_input_index=0).mix_sha256
            for doc in changes}
    assert sha not in shas and len(shas) == len(changes)
    # The master stage (gain after [apre]) is not part of the pre-master mix.
    normalized = copy.deepcopy(base)
    normalized["audio"]["master"]["mode"] = "normalize"
    assert ag.audio_fragment(_plan(normalized), mode="final", first_input_index=0).mix_sha256 == sha


def test_fragment_is_deterministic():
    doc = harness.click_doc(source_gain_cdb=-300, music={"gain_cdb": -800})
    a = ag.audio_fragment(_plan(doc), mode="final", first_input_index=5)
    b = ag.audio_fragment(_plan(copy.deepcopy(doc)), mode="final", first_input_index=5)
    assert a == b


def test_unknown_mode_and_bad_index_are_rejected():
    plan = _plan(harness.click_doc())
    with pytest.raises(ValueError):
        ag.audio_fragment(plan, mode="plate_cells", first_input_index=0)
    with pytest.raises(ValueError):
        ag.audio_fragment(plan, mode="final", first_input_index=-1)


def test_48_khz_in_every_chain():
    for doc in _shapes():
        fragment = ag.audio_fragment(_plan(doc), mode="final", first_input_index=0)
        for chain in fragment.graph.split(";"):
            if chain.startswith("[sa") or ("atrim=start_sample" in chain):
                assert "aresample=48000," in chain
            if "anullsrc" in chain:
                assert "sample_rate=48000" in chain
        assert fragment.graph.endswith(f"{FORMAT}[apre]")
        for spec in fragment.inputs:
            if spec.kind == "sidecar":
                assert spec.options == ENV_OPTIONS


def test_master_filter():
    assert ag.master_filter("final", 0) == "aresample=48000"
    assert ag.master_filter("reference", -380) == "volume=-3.80dB,aresample=48000"
    assert ag.master_filter("audio_preview", 605) == "volume=6.05dB,aresample=48000"
    assert ag.master_filter("final", -5) == "volume=-0.05dB,aresample=48000"
    assert ag.master_filter("audio_measure", 0) == "ebur128=peak=true:framelog=verbose"
    with pytest.raises(ValueError):
        ag.master_filter("plate_cells", 0)


# --- FFmpeg (local toolchain) ------------------------------------------------------------------------


@pytest.fixture(scope="module")
def sources(edit_v2_ffmpeg, tmp_path_factory):
    return harness.Sources(tmp_path_factory.mktemp("t14-media"))


def test_pieces_are_placed_sample_exactly(sources, tmp_path):
    wav = sources.speech(fmt=".wav", clicks=True)
    plan = _plan(harness.click_doc())
    out = harness.render(plan, mode="reference", sources=harness.Media(wav, {}), work=tmp_path)
    samples = harness.pcm(out.output)
    assert len(samples) // 2 == plan.total_samples
    expected = []
    for piece in plan.pieces:
        first_src = tm.smp(piece.in_sf, plan.fps)
        length = tm.smp(piece.out_f0 + piece.frames, plan.fps) - tm.smp(piece.out_f0, plan.fps)
        for ms in media.default_clicks(SOURCE_MS):
            click = ms * 48
            if first_src <= click < first_src + length:
                expected.append(tm.smp(piece.out_f0, plan.fps) + click - first_src)
    assert len(expected) >= 10
    assert media.find_clicks(samples, channels=2) == expected


def test_amultiply_applies_the_envelope_exactly(sources, tmp_path):
    wav = sources.speech(fmt=".wav", clicks=True)
    doc = harness.click_doc(source_gain_cdb=-450)
    plan = _plan(doc)
    out = harness.render(plan, mode="reference", sources=harness.Media(wav, {}), work=tmp_path)
    got = harness.pcm(out.output)
    source = harness.pcm(wav)
    envelope = struct.unpack(f"<{plan.total_samples}f", env.expand_f32(
        env.speech_envelope(plan.pieces, {"seg_co": 30}, 8, plan.fps, -450),
        plan.total_samples))

    worst = 0
    exact = 0
    for piece in plan.pieces:
        first_src = tm.smp(piece.in_sf, plan.fps)
        start = tm.smp(piece.out_f0, plan.fps)
        end = tm.smp(piece.out_f0 + piece.frames, plan.fps)
        # s16 → f32 is exact (x/32768); f32 × f32 is the correctly rounded product, which is
        # the double product (exact: ≤ 40 significant bits) rounded to f32 by array("f").
        products = array.array("f", (
            source[2 * (first_src + k) + c] * envelope[start + k] / 32768
            for k in range(end - start) for c in (0, 1)
        ))
        for index, value in enumerate(products):
            want = max(-32768, min(32767, round(value * 32768)))
            diff = abs(got[2 * start + index] - want)
            worst = max(worst, diff)
            exact += diff == 0
    assert worst <= 1
    assert exact >= 0.999 * 2 * plan.total_samples


def test_mono_44k_source_is_panned_to_both_channels_at_full_gain(sources, tmp_path):
    mono = sources.speech(channels=1, rate=44_100)
    stereo = sources.speech(channels=2, rate=44_100)
    plan = _plan(harness.click_doc())
    levels = {}
    for name, path in (("mono", mono), ("stereo", stereo)):
        for mode in ("reference", "audio_preview", "final"):
            result = harness.render(plan, mode=mode, sources=harness.Media(path, {}),
                                    work=tmp_path / name, name=mode)
            stream = media.probe(result.output)["audio"]
            assert (int(stream["sample_rate"]), int(stream["channels"])) == (48_000, 2), mode
            if mode != "final":
                samples = harness.pcm(result.output)
                assert len(samples) // 2 == plan.total_samples
                if mode == "reference":
                    levels[name] = samples
    left, right = levels["mono"][0::2], levels["mono"][1::2]
    assert left == right

    def rms_db(values: array.array) -> float:
        return 10 * math.log10(sum(v * v for v in values) / len(values) / 32768**2)

    assert abs(rms_db(left) - rms_db(levels["stereo"][0::2])) < 0.1  # not the −3 dB upmix


def test_short_music_without_loop_ends_and_the_mix_keeps_its_length(sources, tmp_path):
    speech = sources.speech()
    near_end = (harness.MUSIC_ASSET_META["duration_ms"] - 5_000) * 48
    music = {"gain_cdb": -600, "loop": False, "src_in_smp": near_end, "fade_in_f": 0,
             "fade_out_f": 0, "duck": {"on": False}}
    with_music = _plan(harness.click_doc(music=music))
    without = _plan(harness.click_doc())
    a = harness.pcm(harness.render(with_music, mode="reference", sources=sources.media(speech),
                                   work=tmp_path, name="music").output)
    b = harness.pcm(harness.render(without, mode="reference", sources=sources.media(speech),
                                   work=tmp_path, name="speech").output)
    assert len(a) == len(b) == 2 * with_music.total_samples
    tail = 2 * (5_500 * 48)  # after the music ran out (5 s plus the codec's last frame)
    assert a[:48_000] != b[:48_000]
    assert a[tail:] == b[tail:]


def test_source_without_audio_gives_exact_silence(sources, tmp_path):
    plan = _plan(harness.audio_doc(segments=(("seg_b1", "body", 43, 540),), has_audio=False))
    out = harness.render(plan, mode="reference", sources=harness.Media(None, {}), work=tmp_path)
    samples = harness.pcm(out.output)
    assert len(samples) == 2 * plan.total_samples
    assert not any(samples)


# --- gates (local run; evidence of record comes from the reference image) -------------------------


def test_g_click(sources, tmp_path):
    report = harness.g_click(tmp_path, sources)
    assert report["joins"] == 4
    assert report["max_step_dbfs"] < -40.0
    assert report["control_hard_cuts_detected"] >= 1  # the check can see a click
    assert report["failures"] == 0


def test_duck_gate(sources, tmp_path):
    report = harness.duck_gate(tmp_path, sources)
    assert len(report["spans"]) >= 5
    assert report["recovery_checks"] >= 3
    assert report["failures"] == 0, report


def test_p_aud_determinism(sources, tmp_path):
    report = harness.p_aud(tmp_path, sources)
    assert all(report["checks"].values()), report["checks"]
    assert report["failures"] == 0
