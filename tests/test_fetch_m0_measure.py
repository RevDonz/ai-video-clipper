"""The FETCH-M0 measurement script (``scripts/fetch/m0_measure.py``): its pure parts.

The measurements themselves run on GitHub Actions (``editor-gates.yml`` suite=command); these
tests cover the parsing, the pairing, the gates and the go/no-go rules on hand-made data, with no
network, no yt-dlp and no FFmpeg.
"""

from __future__ import annotations

import importlib.util
import io
import json
import tarfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch" / "m0_measure.py"


@pytest.fixture(scope="module")
def m0():
    spec = importlib.util.spec_from_file_location("m0_measure", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- yt-dlp output ---------------------------------------------------------------------------

LISTING = """Kicker
KickStarter
kick:clips
kick:live
kick:vod
twitch:clips
twitch:stream
twitch:vod
TwitchCollection
youtube
youtube:clip
youtube:tab
YoutubeYtBe
youtube.com.evil
"""


def test_extractor_names_keep_the_platform_and_its_colon_names_only(m0):
    names = m0.extractor_names(LISTING)
    assert names == {
        "youtube": ["youtube", "youtube:clip", "youtube:tab"],
        "twitch": ["twitch:clips", "twitch:stream", "twitch:vod"],
        "kick": ["kick:clips", "kick:live", "kick:vod"],
    }


DEBUG = """[debug] Command-line config: ['-v', '--js-runtimes', 'node']
[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp [d1f6a5a2b] (pip)
[debug] Optional libraries: certifi-2026.07.22, sqlite3-3.40.1
[debug] JS runtimes: node-20.20.2 (unsupported)
[debug] Proxy map: {}
"""


def test_debug_value_reads_one_header_line(m0):
    assert m0.debug_value(DEBUG, "JS runtimes") == "node-20.20.2 (unsupported)"
    assert m0.debug_value(DEBUG, "Optional libraries").startswith("certifi-")
    assert m0.debug_value(DEBUG, "Request Handlers") is None


@pytest.mark.parametrize(("value", "expected"), [
    ("node-20.20.2 (unsupported)", {"name": "node", "version": "20.20.2", "supported": False}),
    ("node-24.21.0", {"name": "node", "version": "24.21.0", "supported": True}),
    ("deno-2.5.0, node-24.21.0", {"name": "node", "version": "24.21.0", "supported": True}),
    ("none", None),
    ("node (unknown)", {"name": "node", "version": None, "supported": None}),
])
def test_js_runtime_names_the_version_and_whether_yt_dlp_supports_it(m0, value, expected):
    assert m0.js_runtime(value, "node") == expected


BOT = ("ERROR: [youtube] u8Y6S6ev-Vg: Sign in to confirm you’re not a bot. Use "
       "--cookies-from-browser or --cookies for the authentication.")


def test_download_outcome_uses_the_smoke_classes(m0):
    assert m0.download_outcome(0, "", True) == "ok"
    assert m0.download_outcome(0, "", False) == "no_file"
    assert m0.download_outcome(1, BOT, False) == "bot_check"
    assert m0.download_outcome(1, "ERROR: Unable to download: HTTP Error 403: Forbidden", False) \
        == "forbidden"
    assert m0.download_outcome(None, "", False) == "timeout"


def test_pot_token_contexts_count_each_generated_token(m0):
    stderr = (
        "[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.2 (external)\n"
        "[youtube] [pot:bgutil:http] Generating a gvs PO Token for web client via bgutil HTTP\n"
        "[youtube] [pot:bgutil:http] Generating a player PO Token for mweb client via bgutil\n"
    )
    assert m0.pot_token_contexts(stderr) == ["gvs", "player"]
    assert m0.pot_token_contexts(BOT) == []


def test_rate_counts_one_outcome(m0):
    assert m0.rate(["bot_check", "ok", "bot_check", "network"], "bot_check") == {
        "tries": 4, "count": 2, "share": 0.5}
    assert m0.rate([], "bot_check") == {"tries": 0, "count": 0, "share": None}


# --- sources ---------------------------------------------------------------------------------

def video(uuid, duration, licence=1, language="en"):
    return {"uuid": uuid, "duration": duration, "name": f"talk {uuid}",
            "licence": {"id": licence, "label": "x"}, "language": {"id": language}}


def test_only_open_licences_count(m0):
    assert m0.licensed(video("a", 600, 1))
    assert m0.licensed(video("a", 600, 2))
    assert m0.licensed(video("a", 600, 7))
    assert not m0.licensed(video("a", 600, 4))  # Attribution - Non Commercial
    assert not m0.licensed({"uuid": "a", "duration": 600, "licence": None})


def test_pick_by_duration_takes_the_closest_licensed_video_once(m0):
    videos = [video("a", 610), video("b", 1700), video("c", 1850, licence=3),
              video("d", 3596), video("e", 5937), video("f", 598)]
    picked = m0.pick_by_duration(videos, [600, 1800, 3600, 7200], tolerance=0.35)
    assert {target: item and item["uuid"] for target, item in picked.items()} == {
        600: "f", 1800: "b", 3600: "d", 7200: "e"}
    assert m0.pick_by_duration([video("a", 600)], [600, 610])[610] is None


def test_pick_talks_is_deterministic_and_bounded(m0):
    videos = [video(name, seconds) for name, seconds in
              [("z", 900), ("b", 700), ("y", 2000), ("c", 650), ("a", 1200), ("d", 400)]]
    videos.append(video("e", 800, language="fr"))
    talks = m0.pick_talks(videos, 3, 600, 1800, "en")
    assert [item["uuid"] for item in talks] == ["a", "b", "c"]
    assert m0.pick_talks(list(reversed(videos)), 3, 600, 1800, "en") == talks


# --- audio and selection deltas ----------------------------------------------------------------

def clip(rank, start, end):
    return {"rank": rank, "start": start, "end": end}


def test_clip_deltas_pair_the_same_moments(m0):
    reference = [clip(1, 10.0, 40.0), clip(2, 100.0, 130.0), clip(3, 300.0, 330.0)]
    other = [clip(1, 100.05, 130.18), clip(2, 10.0, 40.02), clip(3, 500.0, 540.0)]
    result = m0.clip_deltas(reference, other, limit_ms=200)
    assert result["clips"] == 3
    assert result["paired"] == 2
    assert result["same_rank"] == 0
    assert result["max_boundary_ms"] == 180
    assert result["within_limit"] == 2
    assert result["unpaired"] == 1


def test_clip_deltas_of_identical_selections(m0):
    clips = [clip(1, 10.0, 40.0), clip(2, 100.0, 130.0)]
    result = m0.clip_deltas(clips, clips, limit_ms=200)
    assert result == {"clips": 2, "paired": 2, "same_rank": 2, "unpaired": 0,
                      "max_boundary_ms": 0, "within_limit": 2, "limit_ms": 200}


def test_word_deltas_align_the_text_first(m0):
    ref = [(0.0, "Hello"), (0.5, "world,"), (1.0, "this"), (1.5, "is"), (2.0, "a"), (2.5, "test")]
    other = [(0.02, "hello"), (0.49, "world"), (1.1, "this"), (2.04, "a"), (2.5, "test."),
             (3.0, "extra")]
    result = m0.word_deltas(ref, other)
    assert result["reference_words"] == 6
    assert result["matched"] == 5
    assert result["max_ms"] == 100
    assert result["median_ms"] == 20
    assert m0.word_deltas([], other)["matched"] == 0


# --- A/V offset from the flash/beep test source -------------------------------------------------

SIGNALSTATS = """frame:0    pts:0       pts_time:0
lavfi.signalstats.YAVG=235.000000
frame:1    pts:1       pts_time:0.0333333
lavfi.signalstats.YAVG=16.000000
frame:2    pts:2       pts_time:0.0666667
lavfi.signalstats.YAVG=16.000000
frame:60   pts:60      pts_time:2
lavfi.signalstats.YAVG=235.000000
frame:61   pts:61      pts_time:2.03333
lavfi.signalstats.YAVG=230.000000
frame:62   pts:62      pts_time:2.06667
lavfi.signalstats.YAVG=16.000000
"""

SILENCE = """[silencedetect @ 0x55] silence_start: 0.02
[silencedetect @ 0x55] silence_end: 2.04 | silence_duration: 2.02
[silencedetect @ 0x55] silence_start: 2.06
[silencedetect @ 0x55] silence_end: 4.0 | silence_duration: 1.94
"""


def test_flash_times_are_rising_edges(m0):
    assert m0.flash_times(SIGNALSTATS) == [0.0, 2.0]


def test_beep_onsets_are_silence_ends(m0):
    assert m0.beep_onsets(SILENCE) == [2.04, 4.0]


def test_av_offset_is_the_median_beep_minus_flash(m0):
    assert m0.av_offset([0.0, 2.0, 4.0], [0.03, 2.04, 4.03]) == pytest.approx(0.03)
    assert m0.av_offset([0.0, 2.0], [5.0]) is None
    assert m0.av_offset([], [1.0]) is None


# --- gates ---------------------------------------------------------------------------------------

def test_bytes_per_hour(m0):
    assert m0.bytes_per_hour(652022301, 3596) == round(652022301 * 3600 / 3596)
    assert m0.bytes_per_hour(None, 3596) is None


def test_range_only_saving_compares_with_audio_first_and_parallel_video(m0):
    # audio-first: max(audio 20 + transcribe 300 + select 5, video 200) = 325
    # range-only: 20 + 300 + 5 + ranges 30 = 355, so it is slower here
    assert m0.range_only_saving(20, 300, 5, 200, 30) == pytest.approx(1 - 355 / 325)
    # captions instead of Whisper: max(25, 200) = 200 vs 25 + 30 = 55
    assert m0.range_only_saving(20, 0, 5, 200, 30) == pytest.approx(1 - 55 / 200)


def test_range_gate_needs_both_numbers(m0):
    assert m0.range_gate([0.5, 0.45, 0.42], [0.0] * 19 + [2.0])["pass"] is True
    assert m0.range_gate([0.5, 0.3, 0.2], [0.0] * 20)["pass"] is False
    assert m0.range_gate([0.5, 0.5, 0.5], [0.0] * 18 + [2.0, 3.0])["pass"] is False
    gate = m0.range_gate([], [])
    assert gate["pass"] is False and gate["median_saving"] is None


def timing_source(duration, video, audio, transcribe, select=0.1):
    return {"video": {"duration": duration},
            "seconds": {"video_download": video, "audio_download_simulated": audio,
                        "transcribe": transcribe, "select": select}}


def test_range_report_counts_only_long_sources(m0):
    sources = [timing_source(600, 4, 1, 140), timing_source(3596, 85, 8, 800),
               timing_source(5937, 140, 13, 1400), {"video": None}]
    report = m0.range_report(sources, cut_seconds=[12.6, 5.4, 6.0], offsets_frames=[0.6] * 40)
    assert [item["duration"] for item in report["sources"]] == [3596, 5937]
    first = report["sources"][0]
    # 5 clips at the median cut time (6.0 s), one after the other
    assert first["ranges_seconds"] == pytest.approx(30.0)
    assert first["whisper"] == pytest.approx(m0.range_only_saving(8, 800, 0.1, 85, 30.0))
    assert first["captions"] == pytest.approx(m0.range_only_saving(8, 0, 0.1, 85, 30.0))
    assert report["gate_whisper"]["pass"] is False
    assert report["gate_captions"]["av_within_one_frame"] == 1.0


def test_kick_decision(m0):
    assert m0.kick_decision(["ok"] * 5, ["ok"] * 5) == "metadata_ok_without_curl_cffi"
    assert m0.kick_decision(["ok"] * 4 + ["forbidden"], []) == "metadata_ok_without_curl_cffi"
    assert m0.kick_decision(["forbidden"] * 5, ["ok"] * 5) == "needs_curl_cffi"
    assert m0.kick_decision(["forbidden"] * 5, ["forbidden"] * 5) == "no_go"
    assert m0.kick_decision([], []) == "not_measured"


def test_bgutil_decision(m0):
    assert m0.bgutil_decision(None, None, 0) == "setup_failed"
    assert m0.bgutil_decision(0.0, 0.0, 10) == "not_needed"
    assert m0.bgutil_decision(1.0, 1.0, 0) == "no_token"
    assert m0.bgutil_decision(1.0, 0.95, 12) == "no_effect"
    assert m0.bgutil_decision(1.0, 0.5, 12) == "helps"


# --- proxy leak scan ------------------------------------------------------------------------------

def test_scan_proc_finds_the_marker_in_cmdline_and_environ_only(m0, tmp_path):
    marker = b"m0-marker-7f3a"
    for pid, cmdline, environ in [
        ("101", b"yt-dlp\0--config-locations\0/tmp/x/ytdlp.conf\0", b"HOME=/home/node\0"),
        ("102", b"yt-dlp\0--proxy\0http://u:" + marker + b"@127.0.0.1:9\0", b""),
        ("103", b"ffmpeg\0-i\0x\0", b"HTTPS_PROXY=http://u:" + marker + b"@h\0"),
    ]:
        (tmp_path / pid).mkdir()
        (tmp_path / pid / "cmdline").write_bytes(cmdline)
        (tmp_path / pid / "environ").write_bytes(environ)
    (tmp_path / "self").mkdir()
    (tmp_path / "self" / "cmdline").write_bytes(marker)
    (tmp_path / "104").mkdir()  # a process that ended between listdir and open
    hits, seen = m0.scan_proc(tmp_path, marker)
    assert seen == 4
    assert hits == [{"pid": 102, "file": "cmdline"}, {"pid": 103, "file": "environ"}]


def test_proxy_config_is_private_and_one_line(m0, tmp_path):
    path = m0.write_proxy_config(tmp_path / "fetch" / "ytdlp.conf", "http://u:p@127.0.0.1:9")
    assert path.read_text(encoding="utf-8") == "--proxy http://u:p@127.0.0.1:9\n"
    assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError):
        m0.write_proxy_config(tmp_path / "bad.conf", "http://a b@h:1")


# --- Kick discovery -------------------------------------------------------------------------------

def test_kick_urls_from_the_channel_api(m0):
    videos = [{"video": {"uuid": "5c697a87-afce-4256-b01f-3c8fe71ef5cb"}},
              {"uuid": "11111111-2222-3333-4444-555555555555"},
              {"video": {"uuid": "not-a-uuid"}}]
    clips = {"clips": [{"id": "clip_01GYXVB5Y8PWAPWCWMSBCFB05X"}, {"id": "evil/../x"}]}
    assert m0.kick_urls("some-channel", videos, clips, 5) == [
        "https://kick.com/some-channel/videos/5c697a87-afce-4256-b01f-3c8fe71ef5cb",
        "https://kick.com/some-channel/videos/11111111-2222-3333-4444-555555555555",
        "https://kick.com/some-channel/clips/clip_01GYXVB5Y8PWAPWCWMSBCFB05X",
    ]
    assert m0.kick_urls("some-channel", {"data": []}, None, 5) == []
    assert len(m0.kick_urls("some-channel", videos, clips, 2)) == 2


# --- results -------------------------------------------------------------------------------------

def test_merge_keeps_every_phase_and_every_run(m0):
    first = {"schema": m0.SCHEMA, "runs": [{"phases": ["env"]}], "phases": {"env": {"a": 1}}}
    second = {"schema": m0.SCHEMA, "runs": [{"phases": ["audio"]}],
              "phases": {"audio": {"sources": [1]}}}
    third = {"schema": m0.SCHEMA, "runs": [{"phases": ["audio"]}],
             "phases": {"audio": {"sources": [2]}}}
    merged = m0.merge_results([first, second, third])
    assert merged["phases"]["env"] == {"a": 1}
    assert merged["phases"]["audio"] == [{"sources": [1]}, {"sources": [2]}]
    assert len(merged["runs"]) == 3
    with pytest.raises(ValueError):
        m0.merge_results([{"schema": "other/1"}])


def test_child_env_drops_the_secrets(m0):
    env = {"PATH": "/bin", "POTONGIN_LLM_API_KEY": "x", "GROQ_API_KEY": "x",
           "APP_PASSWORD": "x", "POTONGIN_SETTINGS_SECRET": "x", "GITHUB_TOKEN": "x",
           "HOME": "/home/node"}
    assert m0.child_env(env) == {"PATH": "/bin", "HOME": "/home/node"}


def test_the_script_never_passes_cookies_and_records_its_pins(m0):
    assert "--cookies" not in SCRIPT.read_text(encoding="utf-8")
    pins = json.loads(json.dumps(m0.PINS))  # plain data, written into every result
    assert set(pins) >= {"node", "bgutil", "curl_cffi", "yt_dlp_ejs"}


def _tar(path, members):
    with tarfile.open(path, "w:gz") as tar:
        for name, kind, target in members:
            info = tarfile.TarInfo(name)
            if kind == "file":
                info.size = 2
                tar.addfile(info, io.BytesIO(b"ok"))
            else:
                info.type, info.linkname = tarfile.SYMTYPE, target
                tar.addfile(info)
    return path


def test_extract_refuses_members_that_leave_the_target(m0, tmp_path):
    good = _tar(tmp_path / "good.tgz", [("pkg/bin/tool", "file", ""),
                                         ("pkg/bin/link", "link", "tool")])
    m0.extract(good, tmp_path / "out")
    assert (tmp_path / "out" / "pkg" / "bin" / "link").read_bytes() == b"ok"
    for name, members in [("dots", [("../evil", "file", "")]),
                          ("abs", [("/tmp/evil", "file", "")]),
                          ("link", [("pkg/l", "link", "../../etc/passwd")])]:
        with pytest.raises(RuntimeError):
            m0.extract(_tar(tmp_path / f"{name}.tgz", members), tmp_path / name)
