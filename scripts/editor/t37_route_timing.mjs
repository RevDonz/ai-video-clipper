// End-to-end timing of GET …/coldopen-suggestions: the route, the python-cli spawn (allowlisted
// env) and `coldopen list`, with a fresh route per call so the in-memory answer never helps
// (plan §7: instant suggestions ≤ 300 ms p95). Prints {samples, p50_ms, p95_ms, max_ms, per_clip}.
// Usage: PYTHON_BIN=… node scripts/editor/t37_route_timing.mjs JOBS_ROOT CLIPS.json REPEAT
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { createColdOpenSuggestionsRoute } from "../../web/lib/coldopen-suggestions.mjs";

const [jobsRoot, clipsFile, repeatText] = process.argv.slice(2);
const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
const repeat = Number(repeatText) || 5;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", JOBS_ROOT: jobsRoot, POTONGIN_EDITOR_V3: "on" };
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

const all = [];
const perClip = [];
for (const { jobId, clipId } of clips) {
  const times = [];
  let status = null;
  let candidates = null;
  for (let i = 0; i < repeat; i += 1) {
    const route = createColdOpenSuggestionsRoute({ authorize: () => null, env, pythonBin: process.env.PYTHON_BIN });
    const request = new Request(`http://local/api/jobs/${jobId}/clips/${clipId}/coldopen-suggestions`, { headers: { Host: "local" } });
    const started = performance.now();
    const response = await route.GET(request, { params: Promise.resolve({ id: jobId, clipId }) });
    const body = await response.json();
    times.push(performance.now() - started);
    status = response.status;
    candidates = Array.isArray(body.candidates) ? body.candidates.length : null;
  }
  all.push(...times);
  perClip.push({ jobId, clipId, status, candidates, p50_ms: Number(quantile(times, 0.5).toFixed(1)), max_ms: Number(Math.max(...times).toFixed(1)) });
}
process.stdout.write(`${JSON.stringify({ samples: all.length, p50_ms: Number(quantile(all, 0.5).toFixed(1)),
  p95_ms: Number(quantile(all, 0.95).toFixed(1)), max_ms: Number(Math.max(...all).toFixed(1)), per_clip: perClip })}\n`);
