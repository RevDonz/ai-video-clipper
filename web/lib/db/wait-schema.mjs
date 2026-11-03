// A process other than the app waits for the app's migration at start (rombak 01 §2.4): a try every
// 2 s for at most 60 s, then exit 78, so the health check fails and the deploy rolls back. Without
// POTONGIN_DB_PATH there is no DB to wait for.
import { DbBusyError, DbUnavailableError, REQUIRED_SCHEMA_PRIMARY, REQUIRED_SCHEMA_SOCIAL, SchemaTooOldError, closeDb, openDb, requireSchema, startHeartbeat } from "./index.mjs";

export const SCHEMA_WAIT_EXIT = 78;
const REQUIRED = Object.freeze({ primary: REQUIRED_SCHEMA_PRIMARY, social: REQUIRED_SCHEMA_SOCIAL });
const RETRY_MS = 2_000;
const DEADLINE_MS = 60_000;

export class SchemaWaitError extends Error {
  constructor(role, cause) {
    super(`[db] ${role}: skema belum siap setelah 60 detik (${cause?.code ?? "error"})`);
    this.name = "SchemaWaitError";
  }
}

const isWorthRetrying = (error) => error instanceof SchemaTooOldError || error instanceof DbUnavailableError || error instanceof DbBusyError;

export async function waitForSchema(env, role, {
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), retryMs = RETRY_MS, deadlineMs = DEADLINE_MS,
} = {}) {
  if (!env.POTONGIN_DB_PATH) return false;
  const deadline = now() + deadlineMs;
  for (;;) {
    try {
      openDb({ path: env.POTONGIN_DB_PATH, role, env });
      requireSchema(REQUIRED[role]);
      startHeartbeat({ env });
      return true;
    } catch (error) {
      closeDb();
      if (!isWorthRetrying(error) || now() >= deadline) throw new SchemaWaitError(role, error);
      await sleep(retryMs);
    }
  }
}
