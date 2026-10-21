import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CLIP_LIMITS } from "../lib/clip-limits.mjs";
import { normalizeChoices } from "../lib/dashboard-choices.mjs";
import { jobFormProblems } from "../lib/dashboard-view.mjs";
import { parseJobOptions, validatePersistedJobOptions } from "../lib/jobs.mjs";
import { TIME_RANGE_LIMITS } from "../lib/time-ranges.mjs";

// Reviewed 2026-10-21 against the render cost under the production CPU quota (GATES "Output
// sizes (PF-SIZE)", T4.3 cpu_quota_6, the per-clip timeout row) and the per-job storage reserve:
// the limits stay where they were. The PR text of the batch records the numbers.
test("a job has 1 to 10 clips of 5 to 180 seconds", () => {
  assert.deepEqual(CLIP_LIMITS, { count: { min: 1, max: 10 }, seconds: { min: 5, max: 180 } });
});

test("the job API, stored jobs, the form and the saved choices use the same limits", () => {
  const form = { renderMode: "fit-blur", limit: "10", minDuration: "5", maxDuration: "180" };
  assert.equal(parseJobOptions(form).limit, 10);
  assert.throws(() => parseJobOptions({ ...form, limit: "11" }));
  assert.throws(() => parseJobOptions({ ...form, limit: "0" }));
  assert.throws(() => parseJobOptions({ ...form, maxDuration: "180.5" }));
  assert.throws(() => parseJobOptions({ ...form, minDuration: "4.5" }));

  const stored = { renderMode: "fit-blur", limit: 10, minDuration: 5, maxDuration: 180 };
  assert.equal(validatePersistedJobOptions(stored).limit, 10);
  assert.throws(() => validatePersistedJobOptions({ ...stored, limit: 11 }));
  assert.throws(() => validatePersistedJobOptions({ ...stored, maxDuration: 181 }));

  const valid = { sourceType: "upload", video: { name: "a.mp4" }, limit: "10", minDuration: "5", maxDuration: "180" };
  assert.deepEqual(jobFormProblems(valid), {});
  assert.deepEqual(jobFormProblems({ ...valid, limit: "11" }), { limit: "Isi 1 sampai 10 klip." });
  assert.deepEqual(jobFormProblems({ ...valid, maxDuration: "181" }), { maxDuration: "Isi 5 sampai 180 detik." });

  assert.equal(normalizeChoices({ limit: "10" }).limit, "10");
  assert.notEqual(normalizeChoices({ limit: "11" }).limit, "11");
  assert.deepEqual([TIME_RANGE_LIMITS.min, TIME_RANGE_LIMITS.max, TIME_RANGE_LIMITS.ranges], [5, 180, 10]);
});

test("the dashboard fields and the engine's ranges name the same limits", async () => {
  const page = await readFile(new URL("../app/dashboard/page.jsx", import.meta.url), "utf8");
  assert.match(page, /id="clip-limit"[^>]*min=\{CLIP_LIMITS\.count\.min\} max=\{CLIP_LIMITS\.count\.max\}/);
  for (const id of ["min-duration", "max-duration"]) {
    assert.match(page, new RegExp(`id="${id}"[^>]*min=\\{CLIP_LIMITS\\.seconds\\.min\\} max=\\{CLIP_LIMITS\\.seconds\\.max\\}`), id);
  }
  const engine = await readFile(new URL("../../src/ai_clipper/time_ranges.py", import.meta.url), "utf8");
  assert.match(engine, /^MIN_RANGE_SECONDS = 5$/m);
  assert.match(engine, /^MAX_RANGE_SECONDS = 180$/m);
  assert.match(engine, /^MAX_RANGES = 10$/m);
});
