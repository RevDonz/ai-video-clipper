// The video download's watchdog and stderr tail (lib/download-monitor.mjs), on a fake clock.
import assert from "node:assert/strict";
import test from "node:test";

import { DownloadError } from "../lib/download-errors.mjs";
import {
  DEFAULT_DOWNLOAD_STALL_MS,
  PROGRESS_TEMPLATE,
  STDERR_TAIL_CHARS,
  createDownloadMonitor,
  downloadStallMs,
} from "../lib/download-monitor.mjs";

function fixture(stallMs = 1_000) {
  const clock = { now: 0 };
  const logged = [];
  const monitor = createDownloadMonitor({ stallMs, now: () => clock.now, log: (line) => logged.push(line), logIntervalMs: 10_000 });
  return { clock, logged, monitor };
}

const progress = (status, bytes, total = "5000") => `[download-progress] ${status} ${bytes}/${total}`;

test("the progress template prints the lines the monitor reads", () => {
  assert.match(PROGRESS_TEMPLATE, /^download:\[download-progress\] %\(progress\.status\)s %\(progress\.downloaded_bytes\)s\//);
});

test("no output at all for the stall window is a stalled download", () => {
  const { clock, monitor } = fixture();
  clock.now = 999;
  assert.equal(monitor.stalled(), null);
  clock.now = 1_000;
  const error = monitor.stalled();
  assert.ok(error instanceof DownloadError);
  assert.equal(error.code, "download_stalled");
  assert.match(error.message, /tidak bergerak selama 1 detik/);
});

test("moving bytes keep the download alive; a repeated progress line does not", () => {
  const { clock, monitor } = fixture();
  clock.now = 900;
  monitor.stdoutLine(progress("downloading", 1024));
  clock.now = 1_800;
  monitor.stdoutLine(progress("downloading", 2048));
  clock.now = 2_700;
  assert.equal(monitor.stalled(), null);
  monitor.stdoutLine(progress("downloading", 2048));
  clock.now = 2_800;
  assert.equal(monitor.stalled()?.code, "download_stalled", "the same byte count is no progress");
});

test("a new file restarting at zero bytes counts as progress", () => {
  const { clock, monitor } = fixture();
  monitor.stdoutLine(progress("finished", 5000));
  clock.now = 900;
  monitor.stdoutLine("[download] Destination: /data/jobs/x/input/source.f140.m4a");
  clock.now = 1_800;
  monitor.stdoutLine(progress("downloading", 0, "800"));
  clock.now = 2_700;
  assert.equal(monitor.stalled(), null);
});

test("extraction lines count as activity, retry and sleep notices do not", () => {
  const { clock, monitor } = fixture();
  clock.now = 900;
  monitor.stdoutLine("[youtube] AbCdEfGhIjK: Downloading webpage");
  clock.now = 1_800;
  assert.equal(monitor.stalled(), null);
  monitor.stdoutLine("[download] Got error: Read timed out. Retrying (1/10)...");
  monitor.stdoutLine("[download] Sleeping 3.00 seconds ...");
  clock.now = 1_900;
  assert.equal(monitor.stalled()?.code, "download_stalled");
});

test("merging and other post-processing never count as stalled", () => {
  const { clock, monitor } = fixture();
  monitor.stdoutLine(progress("finished", 5000));
  for (const line of [
    '[Merger] Merging formats into "/data/jobs/x/input/source.mp4"',
    "[ExtractAudio] Destination: source.m4a",
    "[FixupM4a] Correcting container of source.m4a",
    "[VideoConvertor] Converting video",
    "[ffmpeg] Merging formats",
  ]) {
    const fresh = fixture();
    fresh.monitor.stdoutLine(line);
    fresh.clock.now = 3_600_000;
    assert.equal(fresh.monitor.stalled(), null, line);
  }
  monitor.stdoutLine('[Merger] Merging formats into "/data/jobs/x/input/source.mp4"');
  clock.now = 60_000;
  assert.equal(monitor.stalled(), null);
  monitor.stdoutLine("Deleting original file /data/jobs/x/input/source.f136.mp4 (pass -k to keep)");
  clock.now = 120_000;
  assert.equal(monitor.stalled(), null, "still post-processing");
  // A later download phase arms the watchdog again.
  monitor.stdoutLine(progress("downloading", 10));
  clock.now = 121_000;
  assert.equal(monitor.stalled()?.code, "download_stalled");
});

test("the operator log keeps every line except a flood of progress lines", () => {
  const { clock, logged, monitor } = fixture(60_000);
  monitor.stdoutLine("[youtube] AbCdEfGhIjK: Downloading webpage");
  monitor.stdoutLine(progress("downloading", 1));
  clock.now = 1_000;
  monitor.stdoutLine(progress("downloading", 2));
  clock.now = 11_000;
  monitor.stdoutLine(progress("downloading", 3));
  clock.now = 11_500;
  monitor.stdoutLine(progress("finished", 5000));
  monitor.stdoutLine('[Merger] Merging formats into "source.mp4"');
  assert.deepEqual(logged, [
    "[youtube] AbCdEfGhIjK: Downloading webpage",
    progress("downloading", 1),
    progress("downloading", 3),
    progress("finished", 5000),
    '[Merger] Merging formats into "source.mp4"',
  ]);
});

test("a failed run is classified from the stderr tail", () => {
  const { monitor } = fixture();
  monitor.stderrChunk(Buffer.from("WARNING: [youtube] something minor\nERROR: [youtube] AbCdEfGhIjK: Private vi"));
  monitor.stderrChunk(Buffer.from("deo. Sign in if you've been granted access to this video\n"));
  const error = monitor.failure(1, null);
  assert.ok(error instanceof DownloadError);
  assert.equal(error.code, "download_private");
  assert.equal(error.message, "[youtube] AbCdEfGhIjK: Private video. Sign in if you've been granted access to this video");
});

test("a character split across two chunks still decodes", () => {
  const { monitor } = fixture();
  const bytes = Buffer.from("ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot\n");
  const cut = bytes.indexOf(Buffer.from("’")) + 1;
  monitor.stderrChunk(bytes.subarray(0, cut));
  monitor.stderrChunk(bytes.subarray(cut));
  const error = monitor.failure(1, null);
  assert.equal(error.code, "download_bot_check");
  assert.match(error.message, /you’re not a bot/);
});

test("the stderr tail is bounded: only the newest lines are kept", () => {
  const { monitor } = fixture();
  monitor.stderrChunk(Buffer.from("ERROR: [youtube] AbCdEfGhIjK: Private video\n"));
  monitor.stderrChunk(Buffer.from(`${"WARNING: filler line\n".repeat(Math.ceil((STDERR_TAIL_CHARS * 2) / 21))}`));
  assert.ok(monitor.stderrTail().length <= STDERR_TAIL_CHARS);
  const error = monitor.failure(1, null);
  assert.equal(error.code, "download_failed", "the old ERROR line fell out of the tail");
  assert.equal(error.message, "yt-dlp gagal (exit 1)");
});

test("without an ERROR line the exit status is the technical message", () => {
  const { monitor } = fixture();
  assert.equal(monitor.failure(2, null).message, "yt-dlp gagal (exit 2)");
  assert.equal(monitor.failure(null, "SIGKILL").message, "yt-dlp gagal (SIGKILL)");
  assert.equal(monitor.failure(null, "SIGKILL").code, "download_failed");
});

test("the stall window is a constant an env var can override, within bounds", () => {
  assert.equal(DEFAULT_DOWNLOAD_STALL_MS, 120_000);
  assert.equal(downloadStallMs({}), 120_000);
  assert.equal(downloadStallMs({ POTONGIN_DOWNLOAD_STALL_MS: "" }), 120_000);
  assert.equal(downloadStallMs({ POTONGIN_DOWNLOAD_STALL_MS: "300" }), 300);
  assert.equal(downloadStallMs({ POTONGIN_DOWNLOAD_STALL_MS: "600000" }), 600_000);
  for (const value of ["0", "-5", "99", "abc", "1e3", "3600001", "12.5", " 300"]) {
    assert.equal(downloadStallMs({ POTONGIN_DOWNLOAD_STALL_MS: value }), 120_000, value);
  }
  const { monitor } = fixture(200);
  assert.ok(monitor.checkMs > 0 && monitor.checkMs <= 50, "checks often enough for a short window");
  assert.equal(fixture(120_000).monitor.checkMs, 1_000);
});
