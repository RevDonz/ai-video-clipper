// Watches the worker's yt-dlp video download (scripts/run-job.mjs): reads the progress lines,
// reports a download whose progress stops moving, and keeps a bounded tail of stderr so a
// failure can be classified (lib/download-errors.mjs). Nothing here kills a process.

import { DownloadError, classifyDownloadError } from "./download-errors.mjs";

export const DEFAULT_DOWNLOAD_STALL_MS = 120_000;
export const STDERR_TAIL_CHARS = 32 * 1024;

// One line per progress update (with --newline): status, then downloaded/total bytes.
export const PROGRESS_TEMPLATE = "download:[download-progress] %(progress.status)s %(progress.downloaded_bytes)s/%(progress.total_bytes,progress.total_bytes_estimate)s";

const PROGRESS_LINE = /^\[download-progress\] (\S+) ([^\s/]+)/;
// Merging and other post-processing print once and then run ffmpeg quietly.
const POST_PROCESSING = /^(?:\[(?:Merger|ExtractAudio|Fixup\w*|Video(?:Convertor|Remuxer)|Embed\w*|Metadata|MoveFiles\w*|ModifyChapters|SplitChapters|SponsorBlock|ThumbnailsConvertor|SubtitlesConvertor|Exec|ffmpeg)\]|Deleting original file\b)/i;
// yt-dlp keeps talking while it retries a dead connection; that is not progress.
const RETRY_NOTICE = /\bGot error\b|\bRetrying\b|\bSleeping \d/i;

/** POTONGIN_DOWNLOAD_STALL_MS when it is a whole number of ms in 100..3600000, else the default. */
export function downloadStallMs(env = process.env) {
  const raw = env.POTONGIN_DOWNLOAD_STALL_MS;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return DEFAULT_DOWNLOAD_STALL_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 100 && value <= 3_600_000 ? value : DEFAULT_DOWNLOAD_STALL_MS;
}

function seconds(ms) {
  return `${String(ms / 1000).replace(".", ",")} detik`;
}

export function createDownloadMonitor({
  stallMs = DEFAULT_DOWNLOAD_STALL_MS,
  now = Date.now,
  log = (line) => process.stdout.write(`${line}\n`),
  logIntervalMs = 10_000,
} = {}) {
  let lastActivity = now();
  let postProcessing = false;
  let lastProgress = null;
  let lastLoggedProgress = -Infinity;
  let tail = "";
  const decoder = new TextDecoder();

  function stdoutLine(line) {
    const progress = PROGRESS_LINE.exec(line);
    if (progress) {
      const at = now();
      const key = `${progress[1]} ${progress[2]}`;
      if (key !== lastProgress) {
        lastProgress = key;
        lastActivity = at;
        postProcessing = false;
      }
      // The operator log gets one progress line per interval, plus every status change.
      if (progress[1] !== "downloading") {
        log(line);
        lastLoggedProgress = -Infinity;
      } else if (at - lastLoggedProgress >= logIntervalMs) {
        log(line);
        lastLoggedProgress = at;
      }
      return;
    }
    log(line);
    if (POST_PROCESSING.test(line)) {
      postProcessing = true;
      return;
    }
    if (RETRY_NOTICE.test(line)) return;
    if (line.startsWith("[download] Destination:")) postProcessing = false;
    if (!postProcessing) lastActivity = now();
  }

  function stderrChunk(chunk) {
    tail += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (tail.length > STDERR_TAIL_CHARS) tail = tail.slice(-STDERR_TAIL_CHARS);
  }

  /** A DownloadError when the download has not moved for the stall window, else null. */
  function stalled() {
    if (postProcessing || now() - lastActivity < stallMs) return null;
    return new DownloadError("download_stalled", `yt-dlp tidak bergerak selama ${seconds(stallMs)}`);
  }

  /** The error for a run that exited unsuccessfully, classified from the stderr tail. */
  function failure(code, signal) {
    tail += decoder.decode();
    const { code: errorCode, detail } = classifyDownloadError(tail);
    return new DownloadError(errorCode, detail || `yt-dlp gagal (${signal || `exit ${code}`})`);
  }

  return {
    checkMs: Math.max(10, Math.min(1_000, Math.floor(stallMs / 4))),
    stdoutLine,
    stderrChunk,
    stderrTail: () => tail,
    stalled,
    failure,
  };
}
