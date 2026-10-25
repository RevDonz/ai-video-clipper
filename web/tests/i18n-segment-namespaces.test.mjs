// The namespaces each dashboard segment's provider loads (rombak 07 §8.2, §8.3): a client screen
// can only render errors.<domain>.* and hints.* when its layout loads them, else errorText falls
// back to the server's Indonesian text and hintText to nothing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { WEB } from "./support/i18n-scan.mjs";
import { loadNamespaces } from "../lib/i18n/catalog.mjs";

async function namespacesOf(layout) {
  const source = await readFile(path.join(WEB, layout), "utf8");
  const match = /<SegmentI18n namespaces=\{(\[[^\]]*\])\}>/.exec(source);
  assert.ok(match, `${layout} wraps its children in SegmentI18n`);
  return JSON.parse(match[1]);
}

const NEEDED = {
  // Buat klip: the storage alert, a refused job, the AI alert.
  "app/dashboard/layout.jsx": ["dashboard", "errors.storage", "errors.download", "errors.llm", "hints"],
  // Proyek: a failed project's reason and suggestion in the list.
  "app/projects/layout.jsx": ["projects", "errors.storage", "errors.download", "hints"],
  // One project: its failure, its hint, the trend chips' kind names, the AI notices.
  "app/projects/[id]/layout.jsx": ["project", "reason", "stage", "errors.storage", "errors.download", "errors.llm", "hints", "trends.kind"],
  // Pengaturan: the AI connection test and the transcription card.
  "app/settings/layout.jsx": ["settings", "errors.llm", "hints"],
};

test("each dashboard segment loads the error and hint namespaces its screens render", async () => {
  for (const [layout, needed] of Object.entries(NEEDED)) {
    const loaded = await namespacesOf(layout);
    for (const name of needed) assert.ok(loaded.includes(name), `${layout} loads ${name}`);
    // Every name is a real namespace or subtree in both catalogs.
    for (const locale of ["id", "en"]) assert.doesNotThrow(() => loadNamespaces(locale, loaded), `${layout} (${locale})`);
  }
});
