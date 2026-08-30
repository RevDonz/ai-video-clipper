import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function checkPrimaryWorkerHealth(env = process.env, now = Date.now()) {
  const healthPath = path.resolve(env.PRIMARY_WORKER_HEALTH_PATH || "/tmp/primary-worker-health.json");
  const maximumAgeMs = Number(env.PRIMARY_WORKER_HEALTH_MAX_AGE_MS || 15_000);
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1_000 || maximumAgeMs > 300_000) throw new Error("Invalid primary worker health configuration");
  const fd = await open(healthPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let health;
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > 16_384) throw new Error("Invalid primary worker health file");
    health = JSON.parse(await fd.readFile("utf8"));
  } finally {
    await fd.close();
  }
  if (health?.version !== 1 || !Number.isSafeInteger(health.pid) || health.pid < 1 || typeof health.workerId !== "string"
      || !Number.isSafeInteger(health.activeClaims) || health.activeClaims < 0) throw new Error("Invalid primary worker health state");
  const heartbeatAt = Date.parse(health.heartbeatAt);
  const pollAt = Date.parse(health.lastPollAt);
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt < 0 || now - heartbeatAt > maximumAgeMs) throw new Error("Primary worker heartbeat is stale");
  if (health.activeClaims === 0 && (!Number.isFinite(pollAt) || now - pollAt < 0 || now - pollAt > maximumAgeMs)) throw new Error("Primary worker polling is stale");
  try { process.kill(health.pid, 0); } catch (error) { if (error.code === "ESRCH") throw new Error("Primary worker process is not running"); throw error; }
  return health;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPrimaryWorkerHealth();
}
