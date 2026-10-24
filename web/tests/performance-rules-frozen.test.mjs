// FB-M0 (rencana 2026-10-24-rombak, dok 03 §13.1, §13.4, §4.1): the performance rules, the
// profile snapshot v1 contract and the post-registry contract are frozen. Each frozen file is
// locked by the sha256 of its canonical JSON; a change ships as a new file (rules.v2.json, …)
// with its own lock and a Gate 3 re-run (03 §15.4), never as an edit of the v1 file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DIR = path.join(REPO, "resources", "performance");

const FROZEN = Object.freeze({
  "rules.v1.json": "56eb12118720980c1b640a3d26320215ffb03366ab257fdf04246d28a9d3e4d7",
  "performance-profile.v1.schema.json": "ce67e5325f3ecf5f043795b032885255215c4fe00dc638ed2268087048cc730c",
  "post-registry.v1.json": "40377c090133450d50984f4e37986b731109d3b596545a266e750359562a8c41",
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const load = (name) => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
const sha = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const rules = load("rules.v1.json");
const schema = load("performance-profile.v1.schema.json");
const registry = load("post-registry.v1.json");

test("every frozen v1 file matches its lock", () => {
  for (const [name, digest] of Object.entries(FROZEN)) {
    assert.equal(sha(load(name)), digest, `${name} changed: add a v2 file instead (03 §15.4)`);
  }
});

// csv-profiles.v1.json (FB-M1) is not frozen: its aliases grow as owner samples arrive (03 §14.1).
test("every rules, registry and schema file in resources/performance is locked and named by its id", () => {
  for (const name of readdirSync(DIR)) {
    if (!/^(rules|post-registry|[a-z-]+\.v\d+\.schema)(\.v\d+)?\.json$/.test(name)) continue;
    assert.ok(Object.hasOwn(FROZEN, name), `${name} has no lock in FROZEN`);
  }
  for (const name of readdirSync(DIR).filter((entry) => /^rules\.v\d+\.json$/.test(entry))) {
    assert.equal(load(name).rulesId, name.replace(/\.json$/, ""));
  }
});

test("rules.v1 holds the thresholds of 03 §13.1 and Q11", () => {
  assert.equal(rules.rulesId, "rules.v1");
  assert.deepEqual(rules.dimensions, ["archetype", "durationBucket", "hookForm"]);
  assert.equal(rules.minPosts, 20);
  assert.equal(rules.minGroup, 5);
  assert.equal(rules.minAccountPosts, 5);
  assert.equal(rules.shrinkK, 5);
  assert.equal(rules.liftFull, 0.25);
  assert.equal(rules.capPerDimension, 0.2);
  assert.equal(rules.capTotal, 0.4);
  assert.equal(rules.windowDays, 180);
  assert.equal(rules.staleDays, 14);
  assert.equal(rules.editFarOverlap, 0.8);
  assert.deepEqual(
    Object.keys(rules).sort(),
    [
      "archetype", "capPerDimension", "capTotal", "dimensions", "durationBuckets", "editFarOverlap",
      "hookForm", "liftFull", "minAccountPosts", "minGroup", "minPosts", "rulesId", "shrinkK",
      "staleDays", "windowDays",
    ],
  );
});

test("rules.v1 duration buckets cover [0, ∞) without gaps, as [lo, hi)", () => {
  const buckets = rules.durationBuckets;
  assert.deepEqual(buckets.map((bucket) => bucket[2]), ["0-20", "20-30", "30-45", "45-60", "60+"]);
  assert.equal(buckets[0][0], 0);
  assert.equal(buckets.at(-1)[1], null);
  for (let index = 1; index < buckets.length; index += 1) {
    assert.equal(buckets[index][0], buckets[index - 1][1]);
    assert.ok(buckets[index - 1][0] < buckets[index - 1][1]);
  }
});

test("rules.v1 hookForm order and quote openers", () => {
  assert.deepEqual(rules.hookForm.order, ["none", "question", "number", "quote", "statement"]);
  assert.deepEqual(rules.hookForm.quoteOpeners, ["\"", "“", "'", "‘", "«"]);
});

test("rules.v1 archetypes equal ARCHETYPES in selection_types.py as a set", () => {
  const source = readFileSync(path.join(REPO, "src", "ai_clipper", "selection_types.py"), "utf8");
  const block = source.match(/^ARCHETYPES = frozenset\(\s*\{([^}]*)\}/m);
  assert.ok(block, "ARCHETYPES literal not found");
  const python = [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(rules.archetype).size, rules.archetype.length);
  assert.deepEqual([...rules.archetype].sort(), [...python].sort());
});

// The subset of JSON Schema 2020-12 the snapshot schema uses; enough to check the examples and
// the rejections below without a validator dependency.
function validate(node, value, at = "$") {
  const errors = [];
  const fail = (message) => errors.push(`${at}: ${message}`);
  if (node.const !== undefined && value !== node.const) fail(`expected ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) fail("not in enum");
  if (node.type === "integer" && !Number.isInteger(value)) fail("not an integer");
  if (node.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) fail("not a number");
  if (node.type === "string" && typeof value !== "string") fail("not a string");
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) fail("below minimum");
    if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) fail("not above exclusiveMinimum");
    if (node.maximum !== undefined && value > node.maximum) fail("above maximum");
  }
  if (node.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [...errors, `${at}: not an object`];
    for (const key of node.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (node.propertyNames && !node.propertyNames.enum.includes(key)) fail(`key ${key} not allowed`);
      const sub = node.properties?.[key] ?? (node.additionalProperties === false ? null : node.additionalProperties);
      if (sub === null) fail(`unexpected key ${key}`);
      else if (sub && typeof sub === "object") errors.push(...validate(sub, child, `${at}.${key}`));
    }
  }
  return errors;
}

test("snapshot v1 schema follows rules.v1", () => {
  assert.equal(schema.$id, "performance-profile.v1");
  assert.equal(schema.properties.version.const, "performance-profile-v1");
  assert.equal(schema.properties.rulesId.const, rules.rulesId);
  assert.deepEqual(schema.properties.horizon.enum, ["1d", "7d", "30d"]);
  assert.equal(schema.properties.posts.minimum, rules.minPosts);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["version", "rulesId", "horizon", "posts", "boosts"]);
  const boosts = schema.properties.boosts;
  assert.equal(boosts.additionalProperties, false);
  assert.deepEqual(boosts.required, rules.dimensions);
  assert.deepEqual(Object.keys(boosts.properties), rules.dimensions);
  const allowed = {
    archetype: rules.archetype,
    durationBucket: rules.durationBuckets.map((bucket) => bucket[2]),
    hookForm: rules.hookForm.order,
  };
  for (const dimension of rules.dimensions) {
    const node = boosts.properties[dimension];
    assert.deepEqual(node.propertyNames.enum, allowed[dimension]);
    assert.equal(node.additionalProperties.exclusiveMinimum, 0);
    assert.equal(node.additionalProperties.maximum, rules.capPerDimension);
  }
});

test("snapshot v1 examples validate; ids, raw numbers and out-of-cap boosts do not", () => {
  assert.ok(schema.examples.length >= 1);
  for (const example of schema.examples) assert.deepEqual(validate(schema, example), []);
  const base = schema.examples[0];
  const bad = [
    { ...base, ownerId: "u1" },
    { ...base, version: "performance-profile-v2" },
    { ...base, rulesId: "rules.v2" },
    { ...base, horizon: "14d" },
    { ...base, posts: 19 },
    { ...base, boosts: { ...base.boosts, archetype: { humor: 0.21 } } },
    { ...base, boosts: { ...base.boosts, archetype: { humor: 0 } } },
    { ...base, boosts: { ...base.boosts, hookForm: { exclamation: 0.1 } } },
    { ...base, boosts: { archetype: {}, durationBucket: {} } },
    { ...base, boosts: { ...base.boosts, views: { all: 0.1 } } },
  ];
  for (const profile of bad) assert.notDeepEqual(validate(schema, profile), [], JSON.stringify(profile));
});

test("post-registry v1 holds the enums of 03 §4.1 and 01 §4.5", () => {
  assert.equal(registry.registryId, "post-registry.v1");
  assert.equal(registry.rulesId, rules.rulesId);
  assert.deepEqual(registry.providers, ["youtube", "tiktok", "instagram"]);
  assert.deepEqual(registry.postOrigins, ["publish", "csv", "manual", "agent"]);
  assert.deepEqual(registry.clipKinds, ["pipeline", "derived"]);
  assert.deepEqual(registry.editClasses, ["none", "light", "far", "unknown"]);
  assert.deepEqual(registry.excludedReasons, ["edited_far", "derived", "manual_exclude"]);
  assert.deepEqual(registry.postErrorCodes, ["social_processing_rejected", "social_remote_missing"]);
  assert.deepEqual(registry.snapshotSources, ["api", "csv", "manual", "agent"]);
  assert.deepEqual(registry.horizons, schema.properties.horizon.enum);
  assert.deepEqual(registry.horizonQualities, ["exact", "interpolated", "missing"]);
  assert.deepEqual(registry.selectionKeys.keys, ["rulesId", ...rules.dimensions]);
  assert.equal(registry.selectionKeys.maxBytes, 1024);
  assert.deepEqual(registry.uniqueExternal, ["owner_id", "provider", "external_id"]);
  for (const list of Object.values(registry).filter(Array.isArray)) {
    assert.equal(new Set(list).size, list.length);
  }
});
