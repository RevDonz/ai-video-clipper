import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildNextRevision,
  classifyEditorSaveFailure,
  createEditorSaveAttempt,
  currentCaptionCue,
  loadEditorWorkspace,
  loadEditorView,
  shouldWarnUnsaved,
  validateEditorDocument,
  validateSavedEditorResponse,
  validateEditorDraft,
} from "../lib/editor-view.mjs";

const CANDIDATE_ID = `cand_${"a".repeat(64)}`;
const ETAG = `"${"b".repeat(64)}"`;

function manifest() {
  return {
    edit_manifest_version: "clip-edit-v1.0",
    identity: {
      selection_version: "selection-v2.0", candidate_id: CANDIDATE_ID,
      candidate_artifact_sha256: "c".repeat(64), source_sha256: "d".repeat(64),
      candidate_start: 10, candidate_end: 20, profile: "standard",
    },
    revision: 1, parent_revision_sha256: null,
    timeline: { start: 10, end: 20 },
    visual: { canvas_width: 720, canvas_height: 1280, render_mode: "fit-blur", safe_area: { top: .05, right: .05, bottom: .05, left: .05 }, focal_x: null, focal_y: null },
    caption_style: { preset: "clean", position: "bottom", font_family: "Inter", font_size: 42, color: "#FFFFFF", keyword_color: "#DFFF58", background_color: "#000000", background_opacity: .65, max_chars_per_line: 32, max_lines: 2, emphasis: "none" },
    captions: [{ cue_id: "cue-0001", index: 0, start: 10, end: 12, text: "Halo dunia", original_text_sha256: "e".repeat(64) }],
    overlays: [], audio: { gain_db: 0, normalize: false },
    audit: { created_at: "2026-08-30T01:02:03.456Z", updated_at: "2026-08-30T01:02:03.456Z", editor_schema: "editor-web-v1" },
  };
}

test("draft validation accepts the exact editable contract", () => {
  assert.deepEqual(validateEditorDraft(manifest()), { valid: true, errors: {} });
});

test("draft validation rejects controls, non-scalars, bounds, and unsupported face tracking", () => {
  const draft = manifest();
  draft.captions[0].text = `bad\n${"x".repeat(500)}\ud800`;
  draft.visual.render_mode = "face-track";
  draft.caption_style.font_size = 97;
  draft.caption_style.emphasis = "keyword";
  draft.audio.gain_db = -25;
  draft.overlays = [{ kind: "title", text: "x".repeat(101), x: .5, y: .5, max_width: .8 }];
  const result = validateEditorDraft(draft);
  assert.equal(result.valid, false);
  for (const key of ["captions.0.text", "visual.render_mode", "caption_style.font_size", "caption_style.emphasis", "audio.gain_db", "title.text"]) assert.ok(result.errors[key], key);
});

test("revision builder preserves immutable shape and advances the saved parent", () => {
  const snapshot = manifest();
  const draft = structuredClone(snapshot);
  draft.captions[0].text = "Teks baru";
  const next = buildNextRevision(snapshot, draft, ETAG, "2026-08-30T02:03:04.005Z");
  assert.equal(next.revision, 2);
  assert.equal(next.parent_revision_sha256, "b".repeat(64));
  assert.equal(next.audit.updated_at, "2026-08-30T02:03:04.005Z");
  assert.deepEqual(next.identity, snapshot.identity);
  assert.deepEqual(next.timeline, snapshot.timeline);
  assert.equal(next.captions[0].text, "Teks baru");
  assert.notEqual(next, draft);
});

test("retry attempt reuses UUID only for identical retryable payload and ETag", () => {
  let count = 0;
  const uuid = () => `323e4567-e89b-42d3-a456-42661417400${++count}`;
  const body = buildNextRevision(manifest(), manifest(), ETAG, "2026-08-30T02:03:04.005Z");
  const first = createEditorSaveAttempt(null, body, ETAG, uuid);
  const regenerated = structuredClone(body);
  regenerated.audit.updated_at = "2026-08-30T02:03:05.006Z";
  const retry = createEditorSaveAttempt({ ...first, retryable: true }, regenerated, ETAG, uuid);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.equal(retry.serialized, first.serialized);
  const changed = structuredClone(body); changed.audio.normalize = true;
  assert.notEqual(createEditorSaveAttempt({ ...first, retryable: true }, changed, ETAG, uuid).idempotencyKey, first.idempotencyKey);
});

test("draft validation rejects overlay footprints outside safe area", () => {
  const draft = manifest();
  draft.visual.safe_area.left = .2;
  draft.visual.safe_area.right = .2;
  draft.overlays = [{ kind: "title", text: "Judul", x: .5, y: .5, max_width: .8 }];
  const result = validateEditorDraft(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors["title.position"]);
});

test("current cue uses source-relative playback and clamps gaps", () => {
  const cues = [
    { cue_id: "one", start: 10, end: 12, text: "Satu" },
    { cue_id: "two", start: 12.5, end: 15, text: "Dua" },
  ];
  assert.equal(currentCaptionCue(cues, 1, 10)?.cue_id, "one");
  assert.equal(currentCaptionCue(cues, 2.25, 10), null);
  assert.equal(currentCaptionCue(cues, 3, 10)?.cue_id, "two");
});

test("conflicts lock editing while 503 and network failures remain retryable", () => {
  assert.deepEqual(classifyEditorSaveFailure(409, { code: "revision_conflict" }), { lock: true, retryable: false, kind: "conflict", message: "Dokumen berubah di tempat lain. Editor dikunci; muat ulang lalu terapkan kembali perubahan Anda." });
  assert.equal(classifyEditorSaveFailure(409, { code: "selection_changed" }).lock, true);
  assert.equal(classifyEditorSaveFailure(503, { code: "backend_unavailable" }).retryable, true);
  assert.equal(classifyEditorSaveFailure(0, {}).retryable, true);
});

test("editor loader requests all committed APIs in parallel with one signal and prioritizes 401", async () => {
  const controller = new AbortController();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/caption-cues")) return new Response("{}", { status: 401 });
    throw new Error("network failure");
  };
  const result = await loadEditorView("job id", "candidate/id", { fetchImpl, signal: controller.signal });
  assert.equal(result.type, "redirect");
  assert.equal(result.location, `/login?next=${encodeURIComponent("/projects/job%20id/candidates/candidate%2Fid/edit")}`);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.options.cache === "no-store" && call.options.signal === controller.signal));
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/jobs/job%20id", "/api/jobs/job%20id/candidates",
    "/api/jobs/job%20id/candidates/candidate%2Fid/caption-cues",
    "/api/jobs/job%20id/candidates/candidate%2Fid/edit",
  ]);
});

test("editor loader returns candidate, cues, manifest and quoted ETag", async () => {
  const data = manifest();
  const fetchImpl = async (url) => {
    if (url.endsWith("/candidates")) return Response.json({ available: true, selectionVersion: "selection-v2.0", candidates: [{ id: CANDIDATE_ID, start: 10, end: 20, profile: "standard", text: "Candidate" }] });
    if (url.endsWith("/caption-cues")) return Response.json({ candidateId: CANDIDATE_ID, candidateArtifactSha256: "c".repeat(64), selectionVersion: "selection-v2.0", cues: data.captions });
    if (url.endsWith("/edit")) return new Response(JSON.stringify(data), { headers: { ETag: ETAG, "Content-Type": "application/json" } });
    return Response.json({ job: { id: "job" } });
  };
  const result = await loadEditorView("job", CANDIDATE_ID, { fetchImpl });
  assert.equal(result.type, "loaded");
  assert.equal(result.candidate.id, CANDIDATE_ID);
  assert.equal(result.manifest.revision, 1);
  assert.equal(result.etag, ETAG);
});

test("workspace loader rejects mixed candidate, cue, and manifest generations before display", async () => {
  const data = manifest();
  const fetchImpl = async (url) => {
    if (url.endsWith("/candidates")) return Response.json({ available: true, selectionVersion: "selection-v2.0", candidates: [{ id: CANDIDATE_ID, start: 10, end: 20, profile: "standard", text: "Candidate" }] });
    if (url.endsWith("/caption-cues")) return Response.json({ candidateId: CANDIDATE_ID, candidateArtifactSha256: "f".repeat(64), selectionVersion: "selection-v2.0", cues: [{ id: "different-cue", start: 10, end: 11, text: "Import optional", originalTextSha256: "1".repeat(64) }] });
    if (url.endsWith("/edit")) return new Response(JSON.stringify(data), { headers: { ETag: ETAG, "Content-Type": "application/json" } });
    return Response.json({ job: { id: "job" } });
  };
  await assert.rejects(loadEditorWorkspace("job", CANDIDATE_ID, { fetchImpl }), (error) => error.name === "EditorSelectionChanged" && error.kind === "selection-changed");
});

test("manifest captions are authoritative even when optional imported cue identities differ", async () => {
  const data = manifest();
  const fetchImpl = async (url) => {
    if (url.endsWith("/candidates")) return Response.json({ available: true, selectionVersion: "selection-v2.0", candidates: [{ id: CANDIDATE_ID, start: 10, end: 20, profile: "standard", text: "Candidate" }] });
    if (url.endsWith("/caption-cues")) return Response.json({ candidateId: CANDIDATE_ID, candidateArtifactSha256: "c".repeat(64), selectionVersion: "selection-v2.0", cues: [{ id: "import-only", start: 10, end: 11, text: "Optional", originalTextSha256: "1".repeat(64) }] });
    if (url.endsWith("/edit")) return new Response(JSON.stringify(data), { headers: { ETag: ETAG, "Content-Type": "application/json" } });
    return Response.json({ job: { id: "job" } });
  };
  const loaded = await loadEditorWorkspace("job", CANDIDATE_ID, { fetchImpl });
  assert.deepEqual(loaded.manifest.captions, data.captions);
  assert.equal(loaded.cues[0].id, "import-only");
});

test("strict document validation rejects malformed canonical responses", () => {
  assert.equal(validateEditorDocument(manifest()).valid, true);
  const malformed = manifest();
  malformed.identity.extra = "not canonical";
  assert.equal(validateEditorDocument(malformed).valid, false);
});

test("save response validation ignores object key ordering but requires the complete submitted manifest", () => {
  const submitted = buildNextRevision(manifest(), manifest(), ETAG, "2026-08-30T02:03:04.005Z");
  const reordered = Object.fromEntries(Object.entries(structuredClone(submitted)).reverse());
  reordered.identity = Object.fromEntries(Object.entries(reordered.identity).reverse());
  reordered.visual.safe_area = Object.fromEntries(Object.entries(reordered.visual.safe_area).reverse());
  reordered.captions[0] = Object.fromEntries(Object.entries(reordered.captions[0]).reverse());
  assert.equal(validateSavedEditorResponse(reordered, `"${"1".repeat(64)}"`, submitted).valid, true);
  assert.equal(validateSavedEditorResponse(submitted, `W/"${"1".repeat(64)}"`, submitted).valid, false);

  const mutations = [
    ["manifest version", (value) => { value.edit_manifest_version = "clip-edit-v2.0"; }],
    ["identity", (value) => { value.identity.candidate_artifact_sha256 = "2".repeat(64); }],
    ["revision", (value) => { value.revision -= 1; }],
    ["parent", (value) => { value.parent_revision_sha256 = "3".repeat(64); }],
    ["timeline", (value) => { value.timeline.end = 19; value.identity.candidate_end = 19; }],
    ["visual", (value) => { value.visual.render_mode = "center-crop"; value.visual.focal_x = .5; value.visual.focal_y = .5; }],
    ["caption style", (value) => { value.caption_style.font_size = 43; }],
    ["captions", (value) => { value.captions[0].text = "Server mengganti caption"; }],
    ["nested cue", (value) => { value.captions[0].end = 11.5; }],
    ["overlays", (value) => { value.overlays = [{ kind: "title", text: "Server title", x: .5, y: .1, max_width: .8 }]; }],
    ["audio", (value) => { value.audio.normalize = true; }],
    ["audit", (value) => { value.audit.updated_at = "2026-08-30T02:03:05.006Z"; }],
  ];
  for (const [label, mutate] of mutations) {
    const returned = structuredClone(submitted);
    mutate(returned);
    assert.equal(validateSavedEditorResponse(returned, `"${"1".repeat(64)}"`, submitted).valid, false, label);
  }
});

test("unsaved warning covers dirty drafts and saves in flight", () => {
  assert.equal(shouldWarnUnsaved(false, false), false);
  assert.equal(shouldWarnUnsaved(true, false), true);
  assert.equal(shouldWarnUnsaved(false, true), true);
});

test("editor page source preserves preview and save semantics", async () => {
  const source = await readFile(new URL("../app/projects/[id]/candidates/[candidateId]/edit/page.jsx", import.meta.url), "utf8");
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /loadEditorWorkspace\(id, candidateId/);
  assert.match(source, /\/api\/jobs\/\$\{encodeURIComponent\(id\)\}\/preview-source/);
  assert.match(source, /currentTime = timeline\.start/);
  assert.match(source, /currentCaptionCue/);
  assert.match(source, /If-Match/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /1200/);
  assert.match(source, /Preview perkiraan/);
  assert.match(source, /Render final segera tersedia/);
  assert.match(source, /Face-track belum didukung/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /<fieldset/);
  assert.match(source, /<legend/);
  assert.match(source, /beforeunload/);
  assert.match(source, /preventDefault\(\)/);
  assert.match(source, /returnValue/);
  assert.match(source, /window\.confirm\([^)]*perubahan/si);
  assert.match(source, /mounted\.current = true/);
  assert.match(source, /lifecycleGeneration/);
  assert.match(source, /validateSavedEditorResponse\(payload, nextEtag, attempt\.manifest\)/);
  assert.match(source, /if \(!savedValidation\.valid\) \{[\s\S]*?queued\.current = false;[\s\S]*?Server mungkin sudah menyimpan; muat ulang direkomendasikan/);
  assert.match(source, /catch \(error\) \{[\s\S]*?retryAttempt\.current = \{ \.\.\.attempt, retryable: true \}/);
  assert.ok(source.indexOf("if (!savedValidation.valid)") < source.indexOf("snapshotRef.current = deepCopy(payload)"));
  assert.match(source, /aria-invalid/);
  assert.match(source, /editorValidationSummary/);
  assert.match(source, /placeholder posisi\/ukuran/i);
});
