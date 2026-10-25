// HeroUI writes some accessible names itself, in English ("Close", "Remove tag", "pagination").
// A page must take such a component from the wrappers in components/ui, which give the
// Indonesian name (05-ui-dashboard.md §3.7), never straight from @heroui/react. The owners are
// read from the installed package, so an upgrade that adds a literal fails here first.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listFiles, readSources } from "./support/ui-guards.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const DIST = path.join(WEB, "node_modules", "@heroui", "react", "dist");
const COMPONENTS = path.join(DIST, "components");

// "aria-label": "Close" and also "aria-label": cond ? "Scroll tabs up" : "…".
const LITERAL_LABEL = /"aria-label":\s*(?:[^,{}\n]*\?\s*)?"[A-Za-z][^"]*"/;

async function componentSources() {
  const dirs = (await readdir(COMPONENTS, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const sources = {};
  for (const dir of dirs) {
    const files = (await readdir(path.join(COMPONENTS, dir))).filter((name) => name.endsWith(".js"));
    sources[dir] = (await Promise.all(files.map((name) => readFile(path.join(COMPONENTS, dir, name), "utf8")))).join("\n");
  }
  return sources;
}

/** Component folders that render a built-in English label, directly or through another one. */
async function labelOwners() {
  const sources = await componentSources();
  const owners = new Set(Object.keys(sources).filter((dir) => LITERAL_LABEL.test(sources[dir])));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [dir, source] of Object.entries(sources)) {
      if (owners.has(dir)) continue;
      const uses = [...source.matchAll(/from '\.\.\/([a-z-]+)\//g)].map((match) => match[1]);
      if (uses.some((used) => owners.has(used))) { owners.add(dir); grew = true; }
    }
  }
  return owners;
}

/** Every name @heroui/react exports, with the component folder it comes from. */
async function exportFolders() {
  const index = await readFile(path.join(DIST, "index.js"), "utf8");
  const folders = {};
  for (const match of index.matchAll(/export \{([^}]*)\} from '\.\/components\/([a-z-]+)\//g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).at(-1);
      if (name) folders[name] = match[2];
    }
  }
  return folders;
}

test("the scan finds HeroUI 3.2.6's own English labels and the components that carry them", async () => {
  const owners = await labelOwners();
  for (const dir of ["close-button", "pagination", "tag", "spinner", "modal", "drawer", "search-field", "toast", "alert-dialog", "tabs"]) {
    assert.ok(owners.has(dir), `${dir} renders a built-in label`);
  }
  assert.ok(!owners.has("button") && !owners.has("switch"), "Button and Switch take their name from their content");
  const folders = await exportFolders();
  assert.equal(folders.CloseButton, "close-button");
  assert.equal(folders.Modal, "modal");
});

test("pages and components take label-owning HeroUI components only through components/ui", async () => {
  const owners = await labelOwners();
  const folders = await exportFolders();
  const files = (await listFiles(WEB, ["app", "components"], [".js", ".jsx", ".mjs"])).filter((file) => !file.startsWith("components/ui/"));
  const found = [];
  for (const { file, source } of await readSources(WEB, files)) {
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@heroui\/react["']/g)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && owners.has(folders[name])) found.push(`${file}: ${name} (${folders[name]})`);
      }
    }
    if (/import\s+\*\s+as\s+\w+\s+from\s+["']@heroui\/react["']/.test(source)) found.push(`${file}: namespace import of @heroui/react`);
  }
  assert.deepEqual(found, [], `use the wrapper in components/ui instead:\n${found.join("\n")}`);
});

test("each wrapper names its control from the Indonesian labels", async () => {
  const labels = await import("../components/ui/aria-labels.mjs");
  for (const [file, keys] of [
    ["CloseButton.jsx", ["close"]],
    ["Modal.jsx", ["close"]],
    ["Drawer.jsx", ["close"]],
    ["SearchField.jsx", ["clearSearch"]],
    ["Pagination.jsx", ["pagination", "prev", "next"]],
    ["TagGroup.jsx", ["removeTag"]],
    ["Toast.jsx", ["dismiss", "notifications"]],
    ["Table.jsx", ["selectAll", "selectRow", "loadingMore"]],
    ["DatePicker.jsx", ["calendar", "prevMonth", "nextMonth"]],
  ]) {
    const source = await readFile(path.join(WEB, "components", "ui", file), "utf8");
    assert.match(source, /from "\.\/aria-labels\.mjs"/, file);
    for (const key of keys) {
      assert.match(source, new RegExp(`ARIA\\.${key}\\b`), `${file} uses ARIA.${key}`);
      assert.match(labels.ARIA[key], /^[A-Z][a-z]/, `ARIA.${key} is an Indonesian label`);
    }
  }
});
