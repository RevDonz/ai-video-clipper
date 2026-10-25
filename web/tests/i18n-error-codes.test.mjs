// Every error code has its text in every locale (rombak 07 §10.2, §14; i18n M2): the codes of
// download-errors, STORAGE_ERROR_CODES, llm.py ERROR_CODES, edit_v2/errors.py, COMMAND_MESSAGES,
// editor-ai and lib/error-codes.mjs each have errors.<messageId> in web/messages/<locale>/errors.json.
// errors.edit.* in Indonesian is exactly Python's _MESSAGES (this replaces the JS mirror's drift
// test as the guard of the editor's messages), and no domain holds a key without a code.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { STORAGE_ERROR_CODES } from "../lib/dashboard-view.mjs";
import { DOWNLOAD_ERROR_CODES, downloadErrorMessage } from "../lib/download-errors.mjs";
import { COMMAND_MESSAGES } from "../lib/editor/commands.mjs";
import { MESSAGES as EDITOR_AI_MESSAGES, TASK_ERROR_CODES } from "../lib/editor-ai.mjs";
import {
  EDIT_WEB_CODES,
  EDITOR_AI_ROUTE_CODES,
  ERROR_DOMAINS,
  HTTP_STATUSES,
  STATUS_CODES,
  WEB_ERROR_CODES,
  messageIdFor,
} from "../lib/error-codes.mjs";
import { SOURCE_LOCALE } from "../lib/i18n/locales.mjs";

const run = promisify(execFile);
const WEB = fileURLToPath(new URL("..", import.meta.url));
const MESSAGES_DIR = path.join(WEB, "messages");

function pythonBin() {
  return process.env.PYTHON_BIN || "../.venv/bin/python";
}

async function python(script) {
  const { stdout } = await run(pythonBin(), ["-c", script], { cwd: WEB, env: { PATH: process.env.PATH } });
  return JSON.parse(stdout);
}

const llmCodes = () => python("import json; from ai_clipper.llm import ERROR_CODES; print(json.dumps(list(ERROR_CODES)))");
const editMessages = () => python("import json; from ai_clipper.edit_v2.errors import _MESSAGES; print(json.dumps(_MESSAGES, ensure_ascii=False))");

async function locales() {
  const entries = await readdir(MESSAGES_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function errorsOf(locale) {
  return JSON.parse(await readFile(path.join(MESSAGES_DIR, locale, "errors.json"), "utf8"));
}

const keyOf = (messageId) => messageId.split(".");
function hasText(errors, messageId) {
  const [domain, code] = keyOf(messageId);
  return typeof errors?.[domain]?.[code] === "string" && errors[domain][code].trim() !== "";
}

async function registry() {
  const python = { llm: await llmCodes(), edit: Object.keys(await editMessages()) };
  return {
    web: [...WEB_ERROR_CODES],
    http: HTTP_STATUSES.map((status) => `s${status}`),
    download: [...DOWNLOAD_ERROR_CODES],
    storage: [...STORAGE_ERROR_CODES],
    llm: python.llm,
    edit: [...python.edit, ...EDIT_WEB_CODES],
    editor: Object.keys(COMMAND_MESSAGES),
    editor_ai: [...new Set([...TASK_ERROR_CODES, ...EDITOR_AI_ROUTE_CODES])],
  };
}

test("every code of every domain has errors.<messageId> in every locale", async () => {
  const codes = await registry();
  assert.equal(codes.llm.length, 20, "llm.py ERROR_CODES");
  assert.equal(codes.edit.length - EDIT_WEB_CODES.length, 70, "edit_v2 _MESSAGES");
  for (const locale of await locales()) {
    const errors = await errorsOf(locale);
    const missing = [];
    for (const [domain, list] of Object.entries(codes)) {
      for (const code of list) if (!hasText(errors, messageIdFor(code, domain))) missing.push(`${domain}.${code}`);
    }
    assert.deepEqual(missing, [], `${locale}: errors.<messageId> missing`);
  }
});

test("errors.edit.* in Indonesian is exactly edit_v2's _MESSAGES", async () => {
  const python = await editMessages();
  const edit = (await errorsOf(SOURCE_LOCALE)).edit;
  for (const [code, text] of Object.entries(python)) assert.equal(edit[code], text, code);
});

test("no domain of the catalog holds a key without a code", async () => {
  const codes = await registry();
  for (const locale of await locales()) {
    const errors = await errorsOf(locale);
    for (const [domain, list] of Object.entries(codes)) {
      const extra = Object.keys(errors[domain] ?? {}).filter((key) => !list.includes(key));
      assert.deepEqual(extra, [], `${locale}: errors.${domain} keys without a code`);
    }
    for (const domain of Object.keys(errors)) assert.ok(ERROR_DOMAINS.includes(domain), `${locale}: unknown domain ${domain}`);
  }
});

test("the registries list each code once, and the status codes are web codes", () => {
  for (const [name, list] of Object.entries({ WEB_ERROR_CODES, EDIT_WEB_CODES, EDITOR_AI_ROUTE_CODES })) {
    assert.equal(new Set(list).size, list.length, `${name} has a duplicate`);
  }
  for (const code of Object.values(STATUS_CODES)) assert.ok(WEB_ERROR_CODES.includes(code), code);
  for (const code of Object.keys(EDITOR_AI_MESSAGES)) assert.ok(EDITOR_AI_ROUTE_CODES.includes(code), `editor-ai MESSAGES ${code}`);
});

test("a web-only edit code is not also an edit_v2 code", async () => {
  const python = await editMessages();
  for (const code of EDIT_WEB_CODES) assert.equal(python[code], undefined, code);
});

test("a messageId is the domain and the base code, never with the errors. prefix", () => {
  assert.equal(messageIdFor("glyph_unsupported:U+1F602", "edit"), "edit.glyph_unsupported");
  assert.equal(messageIdFor("unauthorized"), "web.unauthorized");
  assert.equal(messageIdFor("timeout", "nope"), "web.timeout");
});

async function hintsOf(locale) {
  return JSON.parse(await readFile(path.join(MESSAGES_DIR, locale, "hints.json"), "utf8"));
}

test("every download, storage and AI code has its hint in every locale; download-errors names exactly those hints", async () => {
  const codes = { download: [...DOWNLOAD_ERROR_CODES], storage: [...STORAGE_ERROR_CODES], llm: await llmCodes() };
  for (const locale of await locales()) {
    const hints = await hintsOf(locale);
    for (const [domain, list] of Object.entries(codes)) {
      assert.deepEqual(Object.keys(hints[domain] ?? {}).sort(), [...list].sort(), `${locale}: hints.${domain}`);
    }
  }
  const id = await hintsOf(SOURCE_LOCALE);
  for (const code of DOWNLOAD_ERROR_CODES) {
    assert.deepEqual(downloadErrorMessage(code), { text: { key: `errors.download.${code}` }, hint: { key: `hints.download.${code}` } }, code);
    assert.equal(typeof id.download[code], "string", code);
  }
});
