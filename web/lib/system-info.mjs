// Pengaturan "Tentang sistem" (server side): the tools this server runs, read without the network.
//
// - yt-dlp: the package metadata of the app's Python, asked through the python-cli helper and
//   cached (a failure is cached briefly, so a missing Python is not re-spawned on every load).
// - FFmpeg and libass: `resources/toolchain.json`, written by the image build (E10). Local runs
//   usually have no such file.
// - Whisper: WHISPER_MODEL (run-job.mjs falls back to small). A path or repository id is only
//   reported as custom, so no folder or user name reaches the page.
// - The app commit: POTONGIN_APP_COMMIT, set by the image build from the deploy's IMAGE_TAG.
// Every reader returns null for what it cannot read and never throws.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resourcesDir } from "./clip-media.mjs";
import { runPythonCli } from "./python-cli.mjs";

export const SYSTEM_INFO_MODULE = "ai_clipper.system_info";
export const YT_DLP_TTL_MS = 10 * 60_000;
export const YT_DLP_FAILURE_TTL_MS = 60_000;
const YT_DLP_TIMEOUT_MS = 10_000;
const YT_DLP_MAX_STDOUT_BYTES = 1024;
const MAX_TOOLCHAIN_BYTES = 64 * 1024;
const TOOLCHAIN_SCHEMA = "potongin.toolchain/1";

const PACKAGE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+!_-]{0,39}$/;
const UPSTREAM_VERSION = /^[0-9][0-9A-Za-z.+~-]{0,31}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The upstream part of a Debian version: "7:5.1.9-0+deb12u1" is "5.1.9". */
export function upstreamVersion(version) {
  if (typeof version !== "string") return null;
  let upstream = version.replace(/^\d+:/, "");
  const revision = upstream.lastIndexOf("-");
  if (revision >= 0) upstream = upstream.slice(0, revision);
  return UPSTREAM_VERSION.test(upstream) ? upstream : null;
}

/** `{ffmpeg, libass}` from `<dir>/toolchain.json`, each null when unknown. */
export async function toolchainVersions(dir) {
  const none = { ffmpeg: null, libass: null };
  if (typeof dir !== "string" || dir === "") return none;
  let document;
  try {
    const raw = await readFile(path.join(dir, "toolchain.json"));
    if (raw.length > MAX_TOOLCHAIN_BYTES) return none;
    document = JSON.parse(raw.toString("utf8"));
  } catch {
    return none;
  }
  const packages = document?.schema === TOOLCHAIN_SCHEMA ? document.packages : null;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return none;
  return { ffmpeg: upstreamVersion(packages.ffmpeg), libass: upstreamVersion(packages.libass9) };
}

/** `{model, custom}`: the model name, or `custom` for a path or repository id. */
export function whisperModel(env = process.env) {
  const configured = typeof env?.WHISPER_MODEL === "string" ? env.WHISPER_MODEL.trim() : "";
  const value = configured || "small";
  return MODEL_NAME.test(value) ? { model: value, custom: false } : { model: null, custom: true };
}

/** The first seven hex digits of POTONGIN_APP_COMMIT, or null. */
export function appCommit(env = process.env) {
  const value = env?.POTONGIN_APP_COMMIT;
  return typeof value === "string" && COMMIT.test(value) ? value.slice(0, 7).toLowerCase() : null;
}

/** A cached reader of yt-dlp's version: resolves the version string or null, never rejects. */
export function createYtDlpReader({
  run = runPythonCli, now = Date.now, ttlMs = YT_DLP_TTL_MS, failureTtlMs = YT_DLP_FAILURE_TTL_MS,
} = {}) {
  let cached = null; // {value, expires}
  let pending = null;

  async function ask() {
    try {
      const answer = await run(SYSTEM_INFO_MODULE, "versions", {}, {
        timeoutMs: YT_DLP_TIMEOUT_MS, maxStdoutBytes: YT_DLP_MAX_STDOUT_BYTES,
      });
      const version = answer?.exitCode === 0 ? answer.json?.yt_dlp : null;
      return typeof version === "string" && PACKAGE_VERSION.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  return function ytDlpVersion() {
    if (cached && now() < cached.expires) return Promise.resolve(cached.value);
    if (!pending) {
      pending = ask().then((value) => {
        cached = { value, expires: now() + (value === null ? failureTtlMs : ttlMs) };
        pending = null;
        return value;
      });
    }
    return pending;
  };
}

const defaultYtDlp = createYtDlpReader();

/** Everything "Tentang sistem" shows; unknown values are null. */
export async function readSystemInfo({ env = process.env, resources = resourcesDir(env), ytDlp = defaultYtDlp } = {}) {
  const [ytDlpVersion, toolchain] = await Promise.all([
    Promise.resolve().then(ytDlp).catch(() => null),
    toolchainVersions(resources),
  ]);
  const whisper = whisperModel(env);
  return {
    ytDlp: typeof ytDlpVersion === "string" ? ytDlpVersion : null,
    ffmpeg: toolchain.ffmpeg,
    libass: toolchain.libass,
    whisperModel: whisper.model,
    whisperModelCustom: whisper.custom,
    commit: appCommit(env),
  };
}
