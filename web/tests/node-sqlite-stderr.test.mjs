// Rombak 01 §8.3: on the pinned Node 24, importing node:sqlite writes nothing to stderr, with the
// environment compose gives each service that runs Node. Several processes read a child's stderr,
// so a runtime warning there is a behaviour change, not noise. The DB module (web/lib/db/) arrives
// in Fase 4; until then the runtime module itself is the import under test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// The runner stage's ENV (Dockerfile), under every compose service.
const IMAGE_ENV = { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", HOSTNAME: "0.0.0.0" };
const NODE_SERVICES = ["app", "primary-worker", "render-worker"];

// The `environment:` map of one compose service, with ${VAR:-default} read as its default and
// ${VAR:?message} as a placeholder (compose refuses to start without it).
function composeEnvironment(service) {
  const block = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, "m"));
  assert.ok(block, `compose.yaml has no service ${service}`);
  const env = block[1].match(/^    environment:\n((?:      .*\n|\s*\n)+)/m);
  assert.ok(env, `${service} has no environment map`);
  const result = {};
  for (const line of env[1].split("\n")) {
    const entry = line.match(/^      ([A-Z][A-Z0-9_]*): ?(.*)$/);
    if (!entry) continue;
    result[entry[1]] = entry[2]
      .replace(/^"(.*)"$/, "$1")
      .replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, "$1")
      .replace(/\$\{[A-Z0-9_]+:\?[^}]*\}/g, "set");
  }
  return result;
}

function importSqlite(env) {
  const script = `import("node:sqlite").then(({ DatabaseSync }) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run(1);
    process.stdout.write(String(db.prepare("SELECT v FROM t").get().v));
    db.close();
  });`;
  return spawnSync(process.execPath, ["-e", script], { cwd: WEB, env, encoding: "utf8", timeout: 30_000 });
}

test("the tests run on the Node major that package.json engines pins", () => {
  assert.deepEqual(pkg.engines, { node: ">=24 <25" });
  assert.equal(Number(process.versions.node.split(".")[0]), 24);
});

for (const service of NODE_SERVICES) {
  test(`node:sqlite writes nothing to stderr with the ${service} environment`, () => {
    const env = { PATH: process.env.PATH, ...IMAGE_ENV, ...composeEnvironment(service) };
    const result = importSqlite(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "1");
    assert.equal(result.stderr, "");
  });
}

test("the clean stderr does not come from a warning switch in compose", () => {
  // If Node starts warning again, 01 §8.3 sets the switch on the DB-owning services only and
  // strips it from child environments; that is a separate, tested change.
  for (const service of NODE_SERVICES) {
    assert.equal(composeEnvironment(service).NODE_OPTIONS, undefined, service);
  }
  assert.ok(Object.keys(composeEnvironment("app")).includes("JOBS_ROOT"), "the compose reader sees the map");
});
