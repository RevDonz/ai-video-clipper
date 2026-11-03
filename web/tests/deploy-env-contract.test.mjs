// The deploy's env and mount contract (rombak 01 §1.3, 02 §12, 08 §8.6): /control only where it may
// be, the DB path and the sealing secret per service, the smoke login in the post-deploy check.
// Phases 6 and 7 add social-worker and pot-provider rows here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseCompose } from "./support/compose.mjs";

const repo = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const compose = parseCompose(repo("compose.yaml"));
const script = repo("deploy/production.sh");

const CONTROL_SERVICES = ["app", "primary-worker"];

function mounts(service) {
  return (compose.services[service].volumes ?? []).map((entry) => (typeof entry === "string"
    ? { source: entry.split(":")[0], target: entry.split(":")[1] }
    : { source: entry.source, target: entry.target, subpath: entry.volume?.subpath }));
}

function fn(name) {
  const match = new RegExp(`^${name}\\(\\) [({]\\n([\\s\\S]*?)^[})]\\n`, "m").exec(script);
  assert.ok(match, `deploy/production.sh has no ${name}()`);
  return match[1];
}

test("the volume exists and is a plain named volume", () => {
  assert.ok(Object.hasOwn(compose.volumes, "potongin_control"));
  assert.ok(!compose.volumes.potongin_control, "no driver or external options");
});

test("/control is mounted on app and primary-worker, and on no other service", () => {
  for (const name of CONTROL_SERVICES) {
    assert.ok(mounts(name).some((mount) => mount.source === "potongin_control" && mount.target === "/control"), name);
  }
  for (const name of Object.keys(compose.services).filter((service) => !CONTROL_SERVICES.includes(service))) {
    for (const mount of mounts(name)) {
      assert.notEqual(mount.source, "potongin_control", `${name} mounts the control volume`);
      assert.doesNotMatch(mount.target, /^\/control(\/|$)/, `${name} mounts something at /control`);
    }
  }
});

test("render-worker cannot open /control: no mount, no DB path, no settings dir or secret", () => {
  const worker = compose.services["render-worker"];
  assert.deepEqual(mounts("render-worker"), [{ source: "clipper_data", target: "/data" }]);
  for (const name of ["POTONGIN_DB_PATH", "POTONGIN_SETTINGS_DIR", "POTONGIN_SETTINGS_SECRET", "APP_SESSION_SECRET", "APP_PASSWORD", "E2E_SMOKE_PASSWORD"]) {
    assert.equal(worker.environment[name], undefined, name);
  }
  assert.equal(JSON.stringify(worker).includes("/control"), false);
});

test("the DB path and the settings dir point into the control volume, on exactly those services", () => {
  for (const name of CONTROL_SERVICES) {
    const env = compose.services[name].environment;
    assert.equal(env.POTONGIN_DB_PATH, "/control/potongin.sqlite", name);
    assert.equal(env.POTONGIN_SETTINGS_DIR, "/control/settings", name);
  }
  for (const [name, service] of Object.entries(compose.services)) {
    if (!CONTROL_SERVICES.includes(name)) assert.equal(service.environment?.POTONGIN_DB_PATH, undefined, name);
  }
});

test("POTONGIN_SETTINGS_SECRET is required on both, with the same variable", () => {
  for (const name of CONTROL_SERVICES) {
    assert.match(compose.services[name].environment.POTONGIN_SETTINGS_SECRET, /^\$\{POTONGIN_SETTINGS_SECRET:\?/, name);
  }
});

test("the smoke login and the trusted IP header reach the app only", () => {
  const app = compose.services.app.environment;
  for (const name of ["E2E_SMOKE_USERNAME", "E2E_SMOKE_PASSWORD"]) assert.equal(app[name], `\${${name}:-}`);
  assert.equal(app.AUTH_TRUSTED_CLIENT_IP_HEADER, "${AUTH_TRUSTED_CLIENT_IP_HEADER:-}");
  for (const name of ["primary-worker", "render-worker"]) {
    assert.equal(compose.services[name].environment.E2E_SMOKE_PASSWORD, undefined, name);
  }
});

test("no flag of .env.example goes unused for this phase", () => {
  const example = repo(".env.example");
  for (const name of ["POTONGIN_SETTINGS_SECRET", "E2E_SMOKE_USERNAME", "E2E_SMOKE_PASSWORD", "AUTH_TRUSTED_CLIENT_IP_HEADER"]) {
    assert.match(example, new RegExp(`^${name}=`, "m"), name);
    assert.ok(JSON.stringify(compose.services.app.environment).includes(name), `${name} reaches the app`);
  }
});

test("the post-deploy e2e signs in with the smoke user, never APP_*", () => {
  const body = fn("run_read_only_e2e");
  assert.match(body, /-e E2E_USERNAME="\$E2E_SMOKE_USERNAME"/);
  assert.match(body, /-e E2E_PASSWORD="\$E2E_SMOKE_PASSWORD"/);
  assert.doesNotMatch(body, /APP_USERNAME|APP_PASSWORD/);
  assert.match(body, /e2e\/read-only\.spec\.mjs e2e\/smoke\.spec\.mjs/);
});

test("a missing smoke login, secret or IP header stops the deploy before it builds", () => {
  const body = fn("require_identity_env");
  for (const name of ["POTONGIN_SETTINGS_SECRET", "E2E_SMOKE_USERNAME", "E2E_SMOKE_PASSWORD", "AUTH_TRUSTED_CLIENT_IP_HEADER"]) assert.match(body, new RegExp(`\\b${name}\\b`));
  assert.ok(script.indexOf("\nrequire_identity_env\n") < script.indexOf("compose -p \"$COMPOSE_PROJECT\" build app"));
});

test("the mount check of the deploy matches: /control on app and primary, not on render", () => {
  const body = fn("verify_runtime_identity");
  assert.match(body, /\$\{COMPOSE_PROJECT\}_potongin_control/);
  assert.match(body, /for container in "\$APP_CONTAINER" "\$PRIMARY_CONTAINER"/);
  assert.match(body, /docker inspect "\$RENDER_CONTAINER" --format '.*\/control/);
  assert.match(body, /CONTROL_VOLUME=/);
});

test("the image starts through start-app and allows it a 60 s start", () => {
  const dockerfile = repo("Dockerfile");
  assert.match(dockerfile, /^CMD \["node", "scripts\/start-app\.mjs"\]$/m);
  assert.match(dockerfile, /--start-period=60s/);
  assert.match(dockerfile, /mkdir -p \/control\/settings \/control\/backups && chown -R node:node \/control && chmod 700 \/control \/control\/settings \/control\/backups/);
  assert.match(dockerfile, /^COPY web\/scripts \.\/scripts$/m);
  assert.match(dockerfile, /^COPY web\/lib \.\/lib$/m);
  assert.match(dockerfile, /^COPY resources\/ \.\/resources\/$/m, "common-passwords.txt ships");
});

test("the primary worker's start period covers its wait for the migration", () => {
  const seconds = Number(/^(\d+)s$/.exec(compose.services["primary-worker"].healthcheck.start_period)[1]);
  assert.ok(seconds > 60);
});
