// The browser lane's marker model (web/components/editor/timeline/lanes/markers.mjs) over the
// cases written by scripts/editor/t37_gates.py `markers`: prints {cases, markers, mismatches}.
// Usage: node scripts/editor/t37_markers_check.mjs CASES.json
import { readFileSync } from "node:fs";

import { buildMarkers } from "../../web/components/editor/timeline/lanes/markers.mjs";

const FIELDS = ["kind", "src", "seg", "s", "e", "f0", "f1"];
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const wordsCache = new Map();
let markers = 0;
const mismatches = [];
for (const kase of input.cases) {
  if (!wordsCache.has(kase.words)) wordsCache.set(kase.words, JSON.parse(readFileSync(kase.words, "utf8")));
  const got = buildMarkers(wordsCache.get(kase.words), kase.doc).markers
    .map((marker) => Object.fromEntries(FIELDS.map((key) => [key, marker[key]])));
  markers += kase.markers.length;
  const want = JSON.stringify(kase.markers);
  if (JSON.stringify(got) !== want) {
    const wanted = new Set(kase.markers.map((marker) => JSON.stringify(marker)));
    const extra = got.filter((marker) => !wanted.has(JSON.stringify(marker)));
    mismatches.push({ clip: kase.clip, doc: kase.name, expected: kase.markers.length, got: got.length, first_extra: extra.slice(0, 3) });
  }
}
process.stdout.write(`${JSON.stringify({ cases: input.cases.length, markers, mismatches })}\n`);
