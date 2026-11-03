// Instance-wide settings (rombak 02 §3.3): a typed key per row of instance_settings, a 5 s cache
// per process, one audit row per save with the key names, never the values. The keys beginning
// social_ arrive with their migration (Fase 8).
import { writeAudit } from "./audit.mjs";
import { db, tx } from "./db/index.mjs";

const CACHE_MS = 5_000;

const intBetween = (min, max) => (value) => Number.isSafeInteger(value) && value >= min && value <= max;
const atLeast = (min) => (value) => Number.isSafeInteger(value) && value >= min;
const isBoolean = (value) => typeof value === "boolean";

const VALIDATORS = Object.freeze({
  signup_mode: (value) => value === "invite",
  llm_share: isBoolean,
  llm_daily_cap: intBetween(0, 10_000),
  groq_share: isBoolean,
  youtube_cookies_share: isBoolean,
  member_llm_keys_allowed: isBoolean,
  trends_scope: (value) => value === "instance",
  member_max_active_jobs: atLeast(0),
  member_max_running_jobs: atLeast(0),
  member_jobs_per_hour: atLeast(0),
  member_max_source_seconds: atLeast(1),
  member_storage_quota_bytes: (value) => value === null || atLeast(0)(value),
  invite_ttl_hours: intBetween(1, 720),
  reset_ttl_hours: intBetween(1, 168),
});

export const INSTANCE_SETTING_KEYS = Object.freeze(Object.keys(VALIDATORS));

export class InstanceSettingError extends Error {
  constructor(key) {
    super(`Nilai tidak sah untuk ${key}`);
    this.name = "InstanceSettingError";
    this.code = "invalid_request";
    this.key = key;
  }
}

const CACHE = Symbol.for("potongin.instance-settings.cache");
const cache = () => (globalThis[CACHE] ??= new Map());

export function clearInstanceSettingsCache() {
  cache().clear();
}

export function getInstanceSetting(key, { now = Date.now() } = {}) {
  if (!Object.hasOwn(VALIDATORS, key)) throw new InstanceSettingError(key);
  const hit = cache().get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const row = db().prepare("SELECT value_json FROM instance_settings WHERE key = ?").get(key);
  const value = row ? JSON.parse(row.value_json) : null;
  cache().set(key, { at: now, value });
  return value;
}

/** Saves `patch` in one tx after checking every value; `actor` = { kind, userId?, label? }. */
export function setInstanceSettings(patch, actor = {}, { now = Date.now() } = {}) {
  const keys = Object.keys(patch ?? {});
  for (const key of keys) {
    if (!Object.hasOwn(VALIDATORS, key) || !VALIDATORS[key](patch[key])) throw new InstanceSettingError(key);
  }
  if (!keys.length) return;
  tx((connection) => {
    const write = connection.prepare(`UPDATE instance_settings SET value_json = ?, updated_at = ?, updated_by = ? WHERE key = ?`);
    for (const key of keys) write.run(JSON.stringify(patch[key]), now, actor.userId ?? null, key);
    writeAudit({ code: "settings.instance_changed", actorKind: actor.kind ?? "user", actorUserId: actor.userId ?? null, actorLabel: actor.label ?? null, params: { keys }, now });
  });
  clearInstanceSettingsCache();
}
