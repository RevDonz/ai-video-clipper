// A control database in a temp directory, for tests of anything behind the user database (rombak
// 02 §4.6). Never touches a real volume. `identityFixture` migrates it and makes the bootstrap admin
// through the real boot code; `sessionCookieFor(user)` is the Cookie header of a fresh session.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { bootApp } from "../../lib/db/boot.mjs";
import { closeDb, openDb } from "../../lib/db/index.mjs";
import { migrate } from "../../lib/db/migrate.mjs";
import { clearInstanceSettingsCache } from "../../lib/instance-settings.mjs";
import { S2_COOKIE, createSession } from "../../lib/sessions.mjs";

export const TEST_ENV = Object.freeze({
  APP_USERNAME: "owner",
  APP_PASSWORD: "correct-horse-battery-staple",
  APP_SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  POTONGIN_SETTINGS_SECRET: "test-session-secret-at-least-thirty-two-characters",
});

/** A 0700 temp directory shaped like /control and /data; removed by `t.after`. */
export function tempControl(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "potongin-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dbFile: path.join(root, "potongin.sqlite"),
    settingsDir: path.join(root, "settings"),
    jobsRoot: path.join(root, "data", "jobs"),
    legacySettings: path.join(root, "data", "settings"),
  };
}

function setEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** A migrated DB only: no users. */
export function migratedDb(t) {
  const control = tempControl(t);
  closeDb();
  setEnv(t, { POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: control.jobsRoot });
  t.after(closeDb);
  const connection = openDb({ path: control.dbFile, role: "test" });
  migrate(connection);
  return { ...control, connection };
}

/** The boot sequence on a temp volume: migrated, with the bootstrap admin (and smoke, if `extra` asks). */
export async function identityFixture(t, extra = {}) {
  const control = tempControl(t);
  closeDb();
  clearInstanceSettingsCache();
  const env = {
    ...TEST_ENV, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: control.jobsRoot, ...extra,
  };
  setEnv(t, env);
  t.after(closeDb);
  await bootApp({ env: process.env, log: () => {} });
  return { ...control, env };
}

export function sessionCookieFor(user, { via = "password", now } = {}) {
  const { token, session } = createSession(user.id, { via, now });
  return { cookie: `${S2_COOKIE}=${token}`, token, session };
}
