// Mode Cepat's card bodies load lazily. A body still loading when its card opens shows "Membuka
// kartu…" and React reveals it up to 300 ms later, or at once on the next render, which a press
// on a card header causes (React Aria's pressed state): the body then grows under the pointer
// between press and release, and the header below never gets its click. QuickPanel loads every
// body when it mounts and hands React.lazy an already settled module, so an opened card renders
// its body at once.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cardModules } from "../components/editor/quick/card-modules.mjs";

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");

test("a preloaded card body settles React.lazy's import at once; before that it waits for the import", async () => {
  const module = { default: function Body() { return null; } };
  let calls = 0;
  const pending = [];
  const release = () => { for (const resolve of pending.splice(0)) resolve(module); };
  const modules = cardModules();
  const card = { file: "quick/Body.jsx", load: () => { calls += 1; return new Promise((resolve) => { pending.push(resolve); }); } };

  // Not loaded yet: the lazy import is the card's own (a pending promise).
  const early = modules.importer(card)();
  assert.equal(typeof early.then, "function");
  assert.equal(calls, 1);

  const preloading = modules.preload([card]);
  release();
  await preloading;
  await early;

  // Loaded: then() calls back in the same tick, so React.lazy reads the module without suspending.
  let seen = null;
  modules.importer(card)().then((value) => { seen = value; });
  assert.equal(seen, module, "settled synchronously");
});

test("a body that fails to preload is loaded again when its card opens", async () => {
  const modules = cardModules();
  let calls = 0;
  const card = { file: "quick/Broken.jsx", load: () => { calls += 1; return Promise.reject(new Error("offline")); } };
  await modules.preload([card]);
  const opened = modules.importer(card)();
  await assert.rejects(opened, /offline/);
  assert.equal(calls, 2);
});

test("QuickPanel preloads every card on mount and builds its lazy bodies from the preloaded modules", () => {
  const source = readFileSync(path.join(editorDir, "quick", "QuickPanel.jsx"), "utf8");
  assert.match(source, /lazy\(MODULES\.importer\(card\)\)/);
  assert.match(source, /useEffect\(\(\) => \{\s*MODULES\.preload\(CARDS\);\s*\}, \[\]\);/);
});
