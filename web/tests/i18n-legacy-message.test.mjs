// legacyMessage (rombak 07 §10.3): the Indonesian text a response's "error" field and the worker's
// stageDetail keep for a code, read from web/messages/id/errors.json, the one id source. The
// modules that knew those texts are code lists now (download-errors, dashboard-view storage).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { STORAGE_ERROR_CODES } from "../lib/dashboard-view.mjs";
import { DOWNLOAD_ERROR_CODES } from "../lib/download-errors.mjs";
import { loadNamespace } from "../lib/i18n/catalog.mjs";
import { legacyMessage } from "../lib/i18n/legacy.mjs";

const id = loadNamespace("id", "errors");

test("legacyMessage gives the Indonesian catalog text of a code, and errors.web.unknown for anything else", () => {
  for (const code of DOWNLOAD_ERROR_CODES) assert.equal(legacyMessage(code, "download"), id.download[code], code);
  for (const code of STORAGE_ERROR_CODES) assert.equal(legacyMessage(code, "storage"), id.storage[code], code);
  assert.equal(legacyMessage("job_not_found"), id.web.job_not_found);
  assert.equal(legacyMessage("glyph_unsupported:U+1F602", "edit"), id.edit.glyph_unsupported);
  for (const [code, domain] of [["nope", "web"], ["download_private", "nope"], [null, "web"]]) {
    assert.equal(legacyMessage(code, domain), id.web.unknown, `${domain}.${code}`);
  }
});

test("the worker and the view modules keep no Indonesian copy of the download and storage texts", async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const sources = [await read("lib/download-errors.mjs"), await read("lib/dashboard-view.mjs"), await read("lib/help-catalog.mjs")];
  for (const text of [...Object.values(id.download), ...Object.values(id.storage)]) {
    for (const source of sources) assert.ok(!source.includes(text), text);
  }
  const worker = await read("scripts/run-job.mjs");
  assert.match(worker, /text: legacyMessage\(download\.code, "download"\)/);
  assert.match(await read("lib/i18n/server.mjs"), /export \{ legacyMessage \} from "\.\/legacy\.mjs";/);
});
