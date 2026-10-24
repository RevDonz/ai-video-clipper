// Rombak 01 §8.3 and 02 §3.1: processes whose output another process reads, or that must stay
// DB-free, never load the SQLite layer. Static import graph from each entry, relative imports
// followed, bare packages left alone: no module under web/lib/db/ and no node:sqlite import.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WEB = fileURLToPath(new URL("..", import.meta.url));
// render-storage-admission: render-worker reads its stdout (RENDER_STORAGE_CLI).
// run-job: child of primary-worker; it gets owner decisions through its env (02 §9.2).
const ENTRIES = ["scripts/render-storage-admission.mjs", "scripts/run-job.mjs"];

const SPECIFIERS = [
  /\bimport\s+[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s+[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIERS) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

// Every module reachable from `entry` (paths relative to `root`), and the bare specifiers seen.
async function importGraph(root, entry) {
  const modules = new Set();
  const bare = new Set();
  const queue = [path.join(root, entry)];
  while (queue.length) {
    const file = queue.pop();
    const relative = path.relative(root, file);
    if (modules.has(relative)) continue;
    modules.add(relative);
    for (const specifier of specifiers(await readFile(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(path.resolve(path.dirname(file), specifier));
      else bare.add(specifier);
    }
  }
  return { modules: [...modules].sort(), bare: [...bare].sort() };
}

function violations({ modules, bare }) {
  return [
    ...modules.filter((name) => name.split(path.sep).join("/").startsWith("lib/db/")),
    ...bare.filter((name) => name === "node:sqlite" || name === "sqlite"),
  ];
}

for (const entry of ENTRIES) {
  test(`${entry} reaches neither web/lib/db nor node:sqlite`, async () => {
    const graph = await importGraph(WEB, entry);
    assert.ok(graph.modules.length > 1, `${entry}: the walker followed its imports`);
    assert.deepEqual(violations(graph), []);
  });
}

test("the walker sees the storage admission modules the render CLI loads", async () => {
  const { modules } = await importGraph(WEB, "scripts/render-storage-admission.mjs");
  assert.ok(modules.includes(path.join("lib", "render-storage-admission.mjs")));
  assert.ok(modules.includes(path.join("lib", "storage-admission.mjs")));
});

test("the walker flags a DB import two hops away, static, re-exported or dynamic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sqlite-boundary-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "lib", "db"), { recursive: true });
    await writeFile(path.join(root, "lib", "db", "index.mjs"), 'import { DatabaseSync } from "node:sqlite";\nexport { DatabaseSync };\n');
    for (const [name, line] of [
      ["static", 'import { DatabaseSync } from "./db/index.mjs";'],
      ["reexport", 'export { DatabaseSync } from "./db/index.mjs";'],
      ["dynamic", 'export const open = () => import("./db/index.mjs");'],
    ]) {
      await writeFile(path.join(root, "lib", `${name}.mjs`), `${line}\n`);
      await writeFile(path.join(root, "scripts", `${name}.mjs`), `import "../lib/${name}.mjs";\n`);
      const graph = await importGraph(root, path.join("scripts", `${name}.mjs`));
      assert.deepEqual(violations(graph), [path.join("lib", "db", "index.mjs"), "node:sqlite"], name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
