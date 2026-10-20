// yt-dlp failures become fixed codes with one Indonesian line each (lib/download-errors.mjs).
// Every stderr sample below is synthetic, shaped like the lines yt-dlp prints.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_ERROR_CODES,
  DOWNLOAD_ERROR_PATTERNS,
  DownloadError,
  classifyDownloadError,
  downloadErrorMessage,
  isDownloadErrorCode,
  sanitizeDownloadLine,
} from "../lib/download-errors.mjs";

const LOGIN_HINT = "Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips on effectively exporting YouTube cookies";
const BUG_HINT = "please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U";

const SAMPLES = {
  download_private: [
    `ERROR: [youtube] AbCdEfGhIjK: Private video. Sign in if you've been granted access to this video. ${LOGIN_HINT}`,
    "ERROR: [youtube] AbCdEfGhIjK: This video is private",
  ],
  download_unavailable: [
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable",
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable. This video has been removed by the uploader",
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.",
    "ERROR: [youtube] AbCdEfGhIjK: This video has been removed for violating YouTube's Terms of Service",
    "ERROR: [youtube:truncated_id] AbCdE: Incomplete YouTube ID AbCdE. URL https://www.youtube.com/watch?v=AbCdE looks truncated.",
  ],
  download_age_restricted: [
    `ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm your age. This video may be inappropriate for some users. ${LOGIN_HINT}`,
    "ERROR: [youtube] AbCdEfGhIjK: This video is age-restricted and only available on YouTube.",
  ],
  download_members_only: [
    "ERROR: [youtube] AbCdEfGhIjK: Join this channel to get access to members-only content like this video, and other exclusive perks.",
    "ERROR: [youtube] AbCdEfGhIjK: This video is available to this channel's members on level: Pendukung (or any higher level). Join this channel to get access to members-only content and other exclusive perks.",
    "ERROR: [youtube] AbCdEfGhIjK: This video requires payment to watch.",
  ],
  download_geo_blocked: [
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable. The uploader has not made this video available in your country",
    "ERROR: [youtube] AbCdEfGhIjK: This video is not available from your location due to geo restriction",
  ],
  download_bot_check: [
    `ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. ${LOGIN_HINT}`,
    "ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you're not a bot. This helps protect our community.",
    "ERROR: [youtube] AbCdEfGhIjK: This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
    "ERROR: unable to download video data: HTTP Error 429: Too Many Requests",
  ],
  download_ytdlp_outdated: [
    "ERROR: [youtube] AbCdEfGhIjK: Requested format is not available. Use --list-formats for a list of available formats",
    "ERROR: [youtube] AbCdEfGhIjK: No video formats found!",
    `ERROR: [youtube] AbCdEfGhIjK: Unable to extract yt initial data; ${BUG_HINT}`,
    "ERROR: [youtube] AbCdEfGhIjK: Signature extraction failed: Some formats may be missing",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  ],
};

test("each ERROR line maps to its fixed code", () => {
  for (const [code, lines] of Object.entries(SAMPLES)) {
    for (const line of lines) {
      assert.equal(classifyDownloadError(`[youtube] Extracting URL\n${line}\n`).code, code, line);
    }
  }
});

test("the help page reads the same patterns, in the order the classifier tries them", () => {
  assert.deepEqual(DOWNLOAD_ERROR_PATTERNS.map(([code]) => code), [
    "download_private",
    "download_age_restricted",
    "download_members_only",
    "download_geo_blocked",
    "download_bot_check",
    "download_unavailable",
    "download_ytdlp_outdated",
  ]);
  assert.ok(Object.isFrozen(DOWNLOAD_ERROR_PATTERNS) && DOWNLOAD_ERROR_PATTERNS.every(Object.isFrozen));
  for (const [code, lines] of Object.entries(SAMPLES)) {
    const [, pattern] = DOWNLOAD_ERROR_PATTERNS.find(([name]) => name === code);
    for (const line of lines) assert.match(line, pattern, line);
  }
});

test("the codes are stable anchors: snake_case, unique, every one with a message", () => {
  assert.deepEqual(DOWNLOAD_ERROR_CODES, [
    "download_private",
    "download_unavailable",
    "download_age_restricted",
    "download_members_only",
    "download_geo_blocked",
    "download_bot_check",
    "download_ytdlp_outdated",
    "download_stalled",
    "download_failed",
  ]);
  for (const code of DOWNLOAD_ERROR_CODES) {
    assert.match(code, /^[a-z]+(?:_[a-z]+)+$/);
    assert.equal(isDownloadErrorCode(code), true, code);
    assert.ok(downloadErrorMessage(code), code);
  }
  for (const value of ["", "storage_quota_exhausted", "toString", "__proto__", null, 42]) {
    assert.equal(isDownloadErrorCode(value), false, String(value));
    assert.equal(downloadErrorMessage(value), null, String(value));
  }
});

test("every message is short Indonesian with exactly one suggestion", () => {
  for (const code of DOWNLOAD_ERROR_CODES) {
    const { text, hint } = downloadErrorMessage(code);
    for (const value of [text, hint]) {
      assert.equal(typeof value, "string", code);
      assert.ok(value.length > 0 && value.length <= 80, `${code}: ${value}`);
      assert.match(value, /\.$/, `${code} ends as a sentence`);
      assert.doesNotMatch(value, /—|–|\bV[1-3]\b|versi|viral|Hot/, code);
    }
    // One suggestion: a single sentence, no second option chained with "atau".
    assert.equal(hint.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, `${code}: ${hint}`);
    assert.doesNotMatch(hint, /\batau\b/i, `${code}: ${hint}`);
  }
  assert.equal(downloadErrorMessage("download_stalled").text, "Unduhan macet.");
});

test("a bot check points to the YouTube cookies in Pengaturan", () => {
  assert.equal(downloadErrorMessage("download_bot_check").hint, "Unggah cookies YouTube di Pengaturan.");
});

test("WARNING lines never decide the code, even when they come first", () => {
  const stderr = [
    "WARNING: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. Retrying",
    "WARNING: [youtube] Private video playlist entry skipped",
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable. This video has been removed by the uploader",
  ].join("\n");
  assert.deepEqual(classifyDownloadError(stderr), {
    code: "download_unavailable",
    detail: "[youtube] AbCdEfGhIjK: Video unavailable. This video has been removed by the uploader",
  });
  assert.deepEqual(classifyDownloadError("WARNING: [youtube] Sign in to confirm your age\n"), { code: "download_failed", detail: null });
});

test("an unknown ERROR line falls back to the generic code and keeps the line", () => {
  assert.deepEqual(classifyDownloadError("ERROR: [youtube] AbCdEfGhIjK: This live event will begin in 3 hours.\n"), {
    code: "download_failed",
    detail: "[youtube] AbCdEfGhIjK: This live event will begin in 3 hours.",
  });
  for (const empty of ["", null, undefined, "random noise\n", 42]) {
    assert.deepEqual(classifyDownloadError(empty), { code: "download_failed", detail: null }, String(empty));
  }
});

test("colour codes and carriage returns do not hide an ERROR line", () => {
  assert.equal(classifyDownloadError("\u001b[0;31mERROR:\u001b[0m [youtube] AbCdEfGhIjK: Private video\n").code, "download_private");
  assert.deepEqual(classifyDownloadError("ERROR: \r[download] Got error: HTTP Error 403: Forbidden\r\n"), {
    code: "download_ytdlp_outdated",
    detail: "[download] Got error: HTTP Error 403: Forbidden",
  });
});

test("the first recognised ERROR line wins over later generic ones", () => {
  const stderr = [
    "ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm your age. This video may be inappropriate for some users.",
    "ERROR: something unrelated afterwards",
  ].join("\n");
  assert.equal(classifyDownloadError(stderr).code, "download_age_restricted");
});

test("the stored line keeps no cookies, tokens, URL queries or server paths", () => {
  const secrets = [
    "ERROR: unable to download video data: <urlopen error> https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SECRETSIG123&pot=SECRETPOT456 (caused by x)",
    "ERROR: [youtube] AbCdEfGhIjK: Cookie: SID=SECRETCOOKIE789; HSID=SECRETCOOKIE000",
    "ERROR: [youtube] AbCdEfGhIjK: token=SECRETTOKEN111 po_token: SECRETTOKEN222 authorization=Bearer SECRETBEARER333",
    "ERROR: [youtube] AbCdEfGhIjK: blob 0123456789abcdefABCDEF0123456789abcdef_-SECRETBLOB",
    "ERROR: unable to open for writing: [Errno 28] No space left on device: '/data/jobs/7d2f0c1e-0000-4000-8000-000000000000/input/source.f136.mp4.part'",
  ];
  for (const line of secrets) {
    const { detail } = classifyDownloadError(line);
    assert.ok(detail, line);
    assert.doesNotMatch(detail, /SECRET|expire=|\/data\/jobs|7d2f0c1e/, detail);
    assert.ok(detail.length <= 240, detail);
  }
  assert.equal(
    sanitizeDownloadLine("ERROR: unable to open for writing: No space left on device: '/data/jobs/x/input/source.mp4.part'"),
    "unable to open for writing: No space left on device: '…/source.mp4.part'",
  );
  assert.equal(
    sanitizeDownloadLine("ERROR: see https://www.youtube.com/watch?v=AbCdEfGhIjK&si=share123 now"),
    "see https://www.youtube.com/… now",
  );
});

test("yt-dlp's boilerplate advice is cut so the reason stays readable", () => {
  assert.equal(
    sanitizeDownloadLine(`ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. ${LOGIN_HINT}`),
    "[youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot.",
  );
  assert.equal(
    sanitizeDownloadLine(`ERROR: [youtube] AbCdEfGhIjK: Unable to extract yt initial data; ${BUG_HINT}`),
    "[youtube] AbCdEfGhIjK: Unable to extract yt initial data",
  );
  const long = sanitizeDownloadLine(`ERROR: ${"x ".repeat(400)}`);
  assert.ok(long.length <= 240 && long.endsWith("…"));
});

test("DownloadError carries the code and the technical message", () => {
  const error = new DownloadError("download_private", "[youtube] AbCdEfGhIjK: Private video");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "DownloadError");
  assert.equal(error.code, "download_private");
  assert.equal(error.message, "[youtube] AbCdEfGhIjK: Private video");
  assert.equal(new DownloadError("nonsense", "x").code, "download_failed");
  assert.equal(new DownloadError("download_failed").message, "Unduhan YouTube gagal");
});
