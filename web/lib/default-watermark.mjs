// Pengaturan "Teks watermark bawaan" (CONTRACTS §5.43): one line of text that the seeds of every
// new job's clips carry (edit_v2.seed), changeable or removable per clip in the editor's Logo panel.
//
//   GET    /api/settings/watermark   {watermark: {text, pos, size_pm, opacity_pm, updatedAtMs} | null, autoClips}
//   PUT    /api/settings/watermark   {text, pos, size_pm, opacity_pm} → the same answer
//   DELETE /api/settings/watermark   jobs created earlier keep their copy
//
// The body is a small JSON object, so web/proxy.js runs in front; the handlers check the session
// again and the origin of a change. <settings>/default-watermark.json (0600, the folder 0700);
// snapshotDefaultWatermark copies it into <job>/watermark.json when a job is created, and that
// copy is what its clips seed (edit_v2.seed.job_watermark).
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { requireAuth } from "./auth.mjs";
import {
  LIMITS,
  WATERMARK_OPACITY_RANGE,
  WATERMARK_POSITIONS,
  WATERMARK_SIZE_RANGE,
  normalizeText,
} from "./editor/doc-model.mjs";
import { readEditorFlags } from "./editor/flags.mjs";
import { HttpBodyError, guardRequest, noStore, readJsonBody } from "./llm-settings-http.mjs";
import { resolveSettingsPaths } from "./llm-settings.mjs";
import { sameOriginMutation } from "./request-security.mjs";

export const DEFAULT_WATERMARK_FILE = "default-watermark.json";
export const DEFAULT_WATERMARK_SCHEMA = "potongin.default-watermark/1";
export const JOB_WATERMARK_FILE = "watermark.json"; // edit_v2.seed.JOB_WATERMARK_FILE
export const JOB_WATERMARK_SCHEMA = "potongin.job-watermark/1"; // edit_v2.seed.JOB_WATERMARK_SCHEMA
const MAX_BODY_BYTES = 4096;
const MAX_FILE_BYTES = 4096;
const KEYS = Object.freeze(["text", "pos", "size_pm", "opacity_pm"]);
const SETTINGS_UNAVAILABLE = "Folder pengaturan di server belum bisa dipakai";

const TEXT_MESSAGES = Object.freeze({
  text_empty: "Tulis teks watermark dulu.",
  text_too_long: `Teks watermark maksimal ${LIMITS.watermarkText} karakter.`,
  text_invalid: "Teks watermark berisi karakter yang tidak bisa dipakai.",
  invalid_args: "Teks watermark harus berupa teks.",
});

class Unavailable extends Error {}

const inRange = (value, [low, high]) => Number.isSafeInteger(value) && value >= low && value <= high;

/**
 * The watermark of a request body: `{ value }` (the text trimmed in NFC) or `{ field, message }`
 * with `field` one of text, pos, size_pm, opacity_pm or body. The same rules as the document.
 */
export function parseDefaultWatermark(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== KEYS.length
    || !KEYS.every((key) => Object.hasOwn(input, key))) {
    return { field: "body", message: "Isi permintaan harus { text, pos, size_pm, opacity_pm }." };
  }
  const text = normalizeText(input.text, LIMITS.watermarkText);
  if (text.code) return { field: "text", message: TEXT_MESSAGES[text.code] ?? TEXT_MESSAGES.text_invalid };
  if (!WATERMARK_POSITIONS.includes(input.pos)) return { field: "pos", message: "Posisi watermark tidak dikenal." };
  if (!inRange(input.size_pm, WATERMARK_SIZE_RANGE)) return { field: "size_pm", message: "Ukuran harus 50% sampai 200%." };
  if (!inRange(input.opacity_pm, WATERMARK_OPACITY_RANGE)) return { field: "opacity_pm", message: "Opasitas harus 20% sampai 100%." };
  return { value: { text: text.value, pos: input.pos, size_pm: input.size_pm, opacity_pm: input.opacity_pm } };
}

// The real path of <settings> (created 0700 on request), or null when it does not exist yet.
async function settingsDirectory(env, { create = false } = {}) {
  let dir;
  try { dir = resolveSettingsPaths(env).dir; } catch { throw new Unavailable(); }
  if (create) {
    try { await mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 }); } catch { throw new Unavailable(); }
  }
  let root;
  try { root = await realpath(/* turbopackIgnore: true */ dir); } catch {
    if (create) throw new Unavailable();
    return null;
  }
  const info = await lstat(/* turbopackIgnore: true */ root).catch(() => null);
  if (!info?.isDirectory()) throw new Unavailable();
  if (create && (info.mode & 0o077) !== 0) await chmod(/* turbopackIgnore: true */ root, 0o700).catch(() => {});
  return root;
}

async function readSmall(target) {
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readFrom(directory) {
  const bytes = await readSmall(path.join(directory, DEFAULT_WATERMARK_FILE));
  let stored = null;
  try { stored = bytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { return null; }
  if (stored?.schema !== DEFAULT_WATERMARK_SCHEMA || !Number.isSafeInteger(stored.updatedAtMs)) return null;
  const parsed = parseDefaultWatermark(Object.fromEntries(KEYS.map((key) => [key, stored[key]])));
  if (!parsed.value || parsed.value.text !== stored.text) return null;
  return { ...parsed.value, updatedAtMs: stored.updatedAtMs };
}

/** The current default watermark `{ text, pos, size_pm, opacity_pm, updatedAtMs }`, or null; never throws. */
export async function readDefaultWatermark(env = process.env) {
  try {
    const directory = await settingsDirectory(env);
    return directory ? await readFrom(directory) : null;
  } catch {
    return null;
  }
}

// One change at a time in this process: a save, a removal and a job's copy never see half of another.
const LOCK = Symbol.for("potongin.defaultWatermarkLock");

function locked(task) {
  const previous = globalThis[LOCK] ?? Promise.resolve();
  const run = previous.then(task, task);
  globalThis[LOCK] = run.catch(() => {});
  return run;
}

async function writeNew(target, bytes) {
  const handle = await open(/* turbopackIgnore: true */ target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function save(directory, value, now) {
  const stored = { schema: DEFAULT_WATERMARK_SCHEMA, ...value, updatedAtMs: now() };
  const temporary = path.join(directory, `.${DEFAULT_WATERMARK_FILE}.${randomUUID()}.tmp`);
  await locked(async () => {
    try {
      await writeNew(temporary, Buffer.from(`${JSON.stringify(stored)}\n`));
      await rename(/* turbopackIgnore: true */ temporary, path.join(directory, DEFAULT_WATERMARK_FILE));
    } catch (error) {
      await unlink(/* turbopackIgnore: true */ temporary).catch(() => {});
      throw error;
    }
  });
  const { schema: _schema, ...watermark } = stored;
  return watermark;
}

/** Removes the default watermark; jobs created earlier keep their copy. */
export async function removeDefaultWatermark(env = process.env) {
  const directory = await settingsDirectory(env);
  if (!directory) return;
  await locked(() => unlink(/* turbopackIgnore: true */ path.join(directory, DEFAULT_WATERMARK_FILE)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  }));
}

/**
 * Writes the current watermark into `<jobRoot>/watermark.json` (0600) for a job being created;
 * true when it did. Never throws and never overwrites: without the copy the clips seed none.
 */
export async function snapshotDefaultWatermark(jobRoot, env = process.env) {
  try {
    const directory = await settingsDirectory(env);
    if (!directory) return false;
    return await locked(async () => {
      const watermark = await readFrom(directory);
      if (!watermark) return false;
      const { updatedAtMs: _updated, ...value } = watermark;
      await writeNew(path.join(jobRoot, JOB_WATERMARK_FILE), Buffer.from(`${JSON.stringify({ schema: JOB_WATERMARK_SCHEMA, ...value })}\n`));
      return true;
    });
  } catch {
    return false;
  }
}

function stateBody(watermark, env) {
  return { watermark, autoClips: readEditorFlags(env).renderEngine === "edit-v2" };
}

function unavailable() {
  return noStore({ error: SETTINGS_UNAVAILABLE, code: "settings_unavailable" }, 503);
}

export function createDefaultWatermarkRoute({ authorize = requireAuth, env = process.env, now = Date.now } = {}) {
  return {
    async GET(request) {
      const denied = guardRequest(request, { authorize });
      if (denied) return denied;
      return noStore(stateBody(await readDefaultWatermark(env), env));
    },

    async PUT(request) {
      const denied = guardRequest(request, { authorize, sameOrigin: sameOriginMutation, mutation: true });
      if (denied) return denied;
      let input;
      try {
        input = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
      } catch (error) {
        if (error instanceof HttpBodyError) return noStore({ error: error.message, code: "bad_request" }, error.status);
        return noStore({ error: "Isi permintaan tidak valid", code: "bad_request" }, 400);
      }
      const parsed = parseDefaultWatermark(input);
      if (!parsed.value) return noStore({ error: parsed.message, code: "invalid_watermark", field: parsed.field }, 400);
      try {
        const directory = await settingsDirectory(env, { create: true });
        return noStore(stateBody(await save(directory, parsed.value, now), env));
      } catch {
        return unavailable();
      }
    },

    async DELETE(request) {
      const denied = guardRequest(request, { authorize, sameOrigin: sameOriginMutation, mutation: true });
      if (denied) return denied;
      try { await removeDefaultWatermark(env); } catch { return unavailable(); }
      return noStore(stateBody(null, env));
    },
  };
}
