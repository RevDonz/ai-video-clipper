#!/usr/bin/env node
// The editor's performance budget report (plan §10.3; T4.3): every PF-* budget with its newest
// evidence under docs/editor/evidence/W<n>/ (W4 first), the measured value against the budget
// and pass/fail. Numbers only; it reads evidence and measures nothing itself.
//
//   node scripts/perf/editor_budgets.mjs [--json] [--evidence docs/editor/evidence]
//
// Exit 0 when every budget has evidence and passes, 1 otherwise (the nightly job keeps the
// report as an artifact).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const firstRun = (json) => Object.values(json.runs ?? {})[0] ?? {};
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value * 10) / 10} ms` : "–");

// gate → newest-first evidence files and how each states its value.
export const BUDGETS = [
  {
    gate: "PF-PIPELINE",
    budget: "fit-blur, center-crop ≤ 1.35×; face-track ≤ 1.6× (per job)",
    files: ["W4/T4.3-PF-PIPELINE.json", "W2/T2.Z2-PF-PIPELINE.json"],
    read: (json) => ({
      pass: json.pass === true,
      value: Object.entries(json.layouts ?? {})
        .map(([layout, row]) => `${layout} ${row.worst_ratio ?? row.ratio}×`).join(", "),
    }),
  },
  {
    gate: "PF-AUDIO",
    budget: "≤ 1,000 ms p95 (90 s clip with music)",
    files: ["W4/T4.3-PF-AUDIO.json", "W3/W3Z-PF-AUDIO-rerun.json", "W3/W3Z-PF-AUDIO.json"],
    read: (json) => {
      const run = firstRun(json);
      const p95 = run.with_music_ms?.p95 ?? json.with_music_ms?.p95;
      return { pass: Number.isFinite(p95) && p95 <= 1000, value: `with music p95 ${ms(p95)}` };
    },
  },
  {
    gate: "PF-PLAN",
    budget: "server ≤ 200 ms p95",
    files: ["W4/T4.3-PF-PLAN.json", "W2/T2.Z2-PF-PLAN.json"],
    read: (json) => {
      const p95 = firstRun(json).http_ms?.p95;
      return { pass: Number.isFinite(p95) && p95 <= 200, value: `HTTP p95 ${ms(p95)}` };
    },
  },
  {
    gate: "PF-TRUTH",
    budget: "≤ 600 ms p95",
    files: ["W4/T4.3-PF-TRUTH.json", "W2/T2.Z2-PF-TRUTH.json"],
    read: (json) => {
      const p95 = firstRun(json).http_ms?.p95;
      return { pass: Number.isFinite(p95) && p95 <= 600, value: `p95 ${ms(p95)}` };
    },
  },
  {
    gate: "PF-CELLS",
    budget: "60 s clip ≤ 15 s (fit-blur, center-crop), ≤ 25 s (face-track)",
    files: ["W4/T4.3-PF-CELLS.json", "W2/T2.Z2-PF-CELLS.json"],
    read: (json) => {
      const run = firstRun(json);
      const cases = (run.cases ?? []).map((c) => `${c.layout ?? c.role} ${c.seconds ?? c.total_s} s`);
      return { pass: run.pass === true, value: cases.join(", ") };
    },
  },
  {
    gate: "PF-OPEN",
    budget: "first ≤ 3.0 s p95, repeat ≤ 2.0 s p95, first cell ≤ 2.0 s",
    files: ["W4/T4.3-PF-OPEN.json", "W3/W3Z-PF-OPEN.json"],
    read: (json) => ({
      pass: json.pass === true,
      value: `first ${ms(json.firstMs?.p95)}, repeat ${ms(json.repeatMs?.p95)}, cell ${ms(json.firstCellAfterPrepareMs)}`,
    }),
  },
  {
    gate: "PF-SAVE",
    budget: "PUT ≤ 300 ms p95",
    files: ["W4/T4.3-PF-SAVE.json", "W2/T2.Z-PF-SAVE.json"],
    read: (json) => ({ pass: json.pass === true, value: `p95 ${ms(json.p95_ms)}` }),
  },
  {
    gate: "PF-SEEK",
    budget: "≤ 50 ms p95",
    files: ["W4/T4.3-PF-SEEK.json", "W2/T2.Z-PF-SEEK.json"],
    read: (json) => ({ pass: json.pass === true, value: `p95 ${ms(json.summary?.p95)}` }),
  },
  {
    gate: "PF-PLAY",
    budget: "0 drops at cuts; ≤ 1 per 10 s",
    files: ["W4/T4.3-PF-PLAY.json", "W2/T2.Z-PF-PLAY.json"],
    read: (json) => ({ pass: json.pass === true, value: `${(json.cases ?? []).length} clips` }),
  },
  {
    gate: "PF-LIBASS",
    budget: "≤ 12 ms p95 per changed frame",
    files: ["W4/T4.3-PF-LIBASS.json", "W2/T2.Z-PF-LIBASS.json"],
    read: (json) => ({ pass: json.pass === true, value: `p95 ${ms(json.summary?.p95)}` }),
  },
  {
    gate: "PF-MEM",
    budget: "≤ 1.2 GB (300 s clip)",
    files: ["W4/T4.3-PF-MEM.json", "W2/T2.Z-PF-MEM.json"],
    read: (json) => ({ pass: json.pass === true, value: `${(json.peak_bytes / 1e9).toFixed(3)} GB` }),
  },
  {
    gate: "PF-RENDER",
    budget: "p50 ≤ 0.4×, p95 ≤ 0.6× (report)",
    files: ["W4/T4.3-PF-RENDER.json", "W2/T2.Z-PF-RENDER.json"],
    read: (json) => {
      const run = firstRun(json);
      const pass = run.pass ?? json.pass;
      return { pass: pass !== false, value: `p50 ${run.p50_x ?? run.p50 ?? "–"}×, p95 ${run.p95_x ?? run.p95 ?? "–"}×` };
    },
  },
  {
    gate: "Retention soak",
    budget: "1,000 saves + 50 exports + cache churn inside the caps",
    files: ["W4/T4.3-retention-soak.json"],
    read: (json) => ({
      pass: json.pass === true,
      value: `${json.saves} saves, ${json.exports} exports, cache ≤ ${json.cap_bytes} B`,
    }),
  },
];

export function report(evidenceRoot) {
  return BUDGETS.map(({ gate, budget, files, read }) => {
    const file = files.find((name) => existsSync(path.join(evidenceRoot, name)));
    if (!file) return { gate, budget, file: null, pass: false, value: "no evidence" };
    try {
      const json = JSON.parse(readFileSync(path.join(evidenceRoot, file), "utf8"));
      return { gate, budget, file, ...read(json) };
    } catch {
      return { gate, budget, file, pass: false, value: "unreadable evidence" };
    }
  });
}

export function markdown(rows) {
  const lines = ["| Budget | Target | Measured | Evidence | Result |", "|---|---|---|---|---|"];
  for (const row of rows) {
    lines.push(`| ${row.gate} | ${row.budget} | ${row.value} | ${row.file ?? "–"} | ${row.pass ? "pass" : "FAIL"} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--evidence");
  const evidenceRoot = at >= 0 ? path.resolve(args[at + 1]) : path.join(ROOT, "docs", "editor", "evidence");
  const rows = report(evidenceRoot);
  process.stdout.write(`${args.includes("--json") ? JSON.stringify(rows, null, 2) : markdown(rows)}\n`);
  process.exitCode = rows.every((row) => row.pass) ? 0 : 1;
}
