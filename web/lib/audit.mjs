// The audit log (rombak 01 §4.1, 02 §9.7). The codes are a frozen list, extended by PR; params hold
// values only, never prose: the viewer's language renders them (i18n M7a). Never a secret.
import { db } from "./db/index.mjs";

export const AUDIT_CODES = Object.freeze([
  "bootstrap.admin_created", "smoke.ensured", "auth.break_glass", "user.admin_reset",
  "user.created", "user.enabled", "user.disabled", "user.deleted", "user.role_changed",
  "user.password_changed", "user.password_reset_issued", "user.limits_changed",
  "invite.created", "invite.revoked", "invite.used", "session.revoked_all",
  "token.created", "token.revoked", "token.imported",
  "job.transferred", "job.deleted_by_admin", "job.cancelled_by_admin",
  "settings.instance_changed", "settings.migrated", "settings.defaults_copied",
  "social.connected", "social.disconnected", "social.purged", "social.data_deleted",
  "performance.deleted", "cache.cleared", "download_network.changed",
]);
const KNOWN = new Set(AUDIT_CODES);

export function writeAudit({
  code, actorKind = "system", actorUserId = null, actorLabel = null, targetUserId = null, targetLabel = null,
  jobId = null, params = {}, requestId = null, now = Date.now(),
}) {
  if (!KNOWN.has(code)) throw new Error(`Kode audit tidak dikenal: ${code}`);
  db().prepare(`INSERT INTO audit_events
    (at, code, actor_kind, actor_user_id, actor_label, target_user_id, target_label, job_id, params_json, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(now, code, actorKind, actorUserId, actorLabel, targetUserId, targetLabel, jobId, JSON.stringify(params), requestId);
}
