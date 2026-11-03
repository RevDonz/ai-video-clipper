// The image's CMD (rombak 01 §10): lib/db/boot.mjs, the heartbeat and daily jobs, then server.js.
// A refused boot exits 1: the health check fails and deploy/production.sh rolls back to the old
// image, where the APP_* login still works.
//   --prepare-settings  only check the environment and copy the settings (deploy, before up -d)
//   --prepare-only      boot steps without the server (CI, which serves with next start)
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bootApp, prepareSettings } from "../lib/db/boot.mjs";
import { closeDb, startHeartbeat, stopHeartbeat } from "../lib/db/index.mjs";
import { runPrune } from "../lib/db/prune.mjs";
import { clearInstanceSettingsCache } from "../lib/instance-settings.mjs";

const DAY_MS = 86_400_000;
const FIRST_PRUNE_MS = 60_000;
const BACKUP_TIMEOUT_MS = 10 * 60_000;

function logPrune() {
  try {
    runPrune();
  } catch (error) {
    console.warn(`[boot] prune gagal: ${error?.code ?? "error"}`);
  }
}

// The child gets the paths it needs and nothing else: no login or sealing secret.
function dailyBackup(env, script) {
  const childEnv = { PATH: env.PATH ?? "/usr/bin:/bin" };
  for (const name of ["POTONGIN_DB_PATH", "POTONGIN_SETTINGS_DIR", "JOBS_ROOT"]) if (env[name]) childEnv[name] = env[name];
  execFile(process.execPath, [script, "--reason", "daily"], { env: childEnv, timeout: BACKUP_TIMEOUT_MS }, (error) => {
    if (error) console.warn(`[boot] cadangan harian gagal: exit ${error.code ?? "?"}`);
  });
}

/** Milliseconds until the next 03:00 UTC. */
export function msUntilDailyBackup(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next.getTime() <= now) next.setTime(next.getTime() + DAY_MS);
  return next.getTime() - now;
}

function scheduleBackgroundWork(env, here) {
  startHeartbeat({ env });
  const firstPrune = setTimeout(logPrune, FIRST_PRUNE_MS);
  firstPrune.unref();
  setInterval(logPrune, DAY_MS).unref();
  const script = path.join(here, "db-backup.mjs");
  const armBackup = () => {
    setTimeout(() => {
      dailyBackup(env, script);
      armBackup();
    }, msUntilDailyBackup()).unref();
  };
  armBackup();
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--prepare-settings")) {
    if (!env.POTONGIN_DB_PATH) return 0;
    const moved = await prepareSettings(env);
    console.log(`SETTINGS_MOVE=${moved.moved ? `copied:${moved.files}` : "none"}`);
    return 0;
  }
  const stopEarly = () => {
    stopHeartbeat();
    closeDb();
    process.exit(0);
  };
  process.once("SIGTERM", stopEarly);
  process.once("SIGINT", stopEarly);
  const { mode } = await bootApp({ env });
  clearInstanceSettingsCache();
  if (argv.includes("--prepare-only")) {
    closeDb();
    return 0;
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  if (mode === "identity") scheduleBackgroundWork(env, here);
  process.removeListener("SIGTERM", stopEarly);
  process.removeListener("SIGINT", stopEarly);
  await import("../server.js");
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const code = await main();
    if (code !== null) process.exitCode = code;
  } catch (error) {
    // Messages name a setting, never its value; a path is fine in this log.
    console.error(`[boot] gagal: ${error?.message ?? "error"}`);
    closeDb();
    process.exit(1);
  }
}
