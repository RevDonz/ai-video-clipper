// Daily removal of expired control metadata (rombak 01 §9; Q6, default, bisa diubah): one tx with
// at most 5000 rows per round, so a long backlog never holds the write lock for long. It never
// touches JOBS_ROOT. Tables of later phases add their rows here together with their migration.
import { tx } from "./index.mjs";

const BATCH = 5000;
const DAY = 86_400_000;

const STEPS = Object.freeze([
  {
    table: "sessions",
    key: "id",
    where: "expires_at < :now - 30 * :day OR revoked_at < :now - 30 * :day",
  },
  { table: "invites", key: "id", where: "expires_at < :now - 7 * :day" },
  { table: "password_resets", key: "id", where: "expires_at < :now - 7 * :day" },
  { table: "audit_events", key: "id", where: "at < :now - 180 * :day" },
  { table: "process_heartbeats", where: "beat_at < :now - :day", composite: true },
]);

function pruneStep(step, now) {
  const { table, key, where } = step;
  const statement = step.composite
    ? `DELETE FROM ${table} WHERE (role, host) IN (SELECT role, host FROM ${table} WHERE ${where} LIMIT ${BATCH})`
    : `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ${BATCH})`;
  let total = 0;
  for (;;) {
    const changes = tx((connection) => Number(connection.prepare(statement).run({ now, day: DAY }).changes));
    total += changes;
    if (changes < BATCH) return total;
  }
}

/** Runs every step; returns the rows removed per table. */
export function runPrune({ now = Date.now() } = {}) {
  return Object.fromEntries(STEPS.map((step) => [step.table, pruneStep(step, now)]));
}
