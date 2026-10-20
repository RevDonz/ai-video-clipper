// `cp .env.example .env && docker compose up` must start: .env.example holds every variable compose
// requires, and its storage values are STORAGE_RETENTION.md's baseline and pass the real parser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseStorageAdmissionConfig } from "../lib/storage-admission.mjs";

const repoFile = (name) => readFile(new URL(`../../${name}`, import.meta.url), "utf8");

function dotenvValues(text) {
  const values = new Map();
  for (const match of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) values.set(match[1], match[2]);
  return values;
}

async function envExample() {
  return dotenvValues(await repoFile(".env.example"));
}

test("every variable compose.yaml requires has a value in .env.example", async () => {
  const required = new Set([...(await repoFile("compose.yaml")).matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)]
    .map((match) => match[1]));
  assert.ok(required.has("JOBS_STORAGE_QUOTA_BYTES") && required.has("APP_SESSION_SECRET"));
  const values = await envExample();
  for (const name of required) {
    assert.ok(values.has(name), `${name} is missing from .env.example`);
    assert.notEqual(values.get(name).trim(), "", `${name} is empty in .env.example`);
  }
});

test(".env.example carries the storage baseline of STORAGE_RETENTION.md", async () => {
  const doc = await repoFile("docs/operations/STORAGE_RETENTION.md");
  const block = doc.match(/```dotenv\n([\s\S]*?)```/);
  assert.ok(block, "STORAGE_RETENTION.md has a dotenv block");
  const baseline = dotenvValues(block[1]);
  assert.equal(baseline.size, 8);
  const values = await envExample();
  for (const [name, value] of baseline) {
    assert.match(name, /^JOBS_STORAGE_/);
    assert.equal(values.get(name), value, name);
  }
});

test(".env.example's storage values pass the storage admission parser", async () => {
  const config = parseStorageAdmissionConfig(Object.fromEntries(await envExample()));
  assert.equal(config.quotaBytes, 32212254720n);
  assert.equal(config.minimumFreeBytes, 16106127360n);
  assert.equal(config.activeReserveBytes, 2147483648n);
});
