#!/usr/bin/env node
// A completed project for the production read-only browser specs (e2e/read-only.spec.mjs,
// e2e/smoke.spec.mjs) and the landing screenshots (e2e/landing-shots.spec.mjs) on a CI server
// whose jobs root is otherwise empty: three clips of the current method that play
// (web/public/landing/sesudah.mp4, the landing's own 9:16 clip of Elephants Dream), with title,
// description, hashtags, hook text and scores, their .srt, and the job record in the layout the
// worker writes (job.json, output/clip-NN.*). Nothing from a real user.
//
//   node scripts/seed-e2e-project.mjs <JOBS_ROOT>   prints the job id
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const E2E_JOB_ID = "5e2e0000-0000-4000-8000-00000000c11b";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const VIDEO = path.join(WEB, "public", "landing", "sesudah.mp4");
const SRT = "1\n00:00:00,000 --> 00:00:02,000\nKamu dengar itu?\n";

const CLIPS = [
  {
    title: "Mesin yang tidak pernah berhenti", hookText: "Tempat ini tidak pernah tidur",
    description: "Proog membawa Emo masuk lebih dalam ke mesin raksasa.", hashtags: ["#elephantsdream", "#animasi"],
    archetype: "curiosity_gap", score: 7.6, scores: { hook: 7.8, standalone: 7.4, payoff: 7.2, emotion: 7.9, shareability: 7.5 },
  },
  {
    title: "Kamu dengar itu?", hookText: "Dengar baik-baik",
    description: "Satu pertanyaan, lalu semua suara mesin berhenti.", hashtags: ["#elephantsdream", "#blender"],
    archetype: "story_twist", score: 8.4, scores: { hook: 8.8, standalone: 8.1, payoff: 8.3, emotion: 8.6, shareability: 8.2 },
  },
  {
    title: "Jangan sentuh kabelnya", hookText: "Satu langkah salah",
    description: "Emo hampir menyentuh kabel yang salah.", hashtags: ["#elephantsdream", "#shortfilm"],
    archetype: "conflict", score: 6.9, scores: { hook: 7.1, standalone: 6.8, payoff: 6.6, emotion: 7.0, shareability: 6.9 },
  },
];

function clip(entry, position) {
  const index = position + 1;
  const base = `/api/jobs/${E2E_JOB_ID}/files/output/clip-${String(index).padStart(2, "0")}`;
  const start = 30 * index;
  return {
    index,
    start,
    end: start + 8,
    duration: 8,
    text: entry.description,
    ...entry,
    selectionSource: "llm",
    reasons: ["Dibuka dengan pertanyaan yang langsung dijawab."],
    sourceStart: start,
    sourceEnd: start + 8,
    videoUrl: `${base}.mp4`,
    downloadUrl: `${base}.mp4?download=1`,
    subtitleUrl: `${base}.srt?download=1`,
  };
}

/** Writes the project under `jobsRoot` and returns its id. */
export async function seedE2eProject(jobsRoot, { now = new Date() } = {}) {
  const job = path.join(path.resolve(jobsRoot), E2E_JOB_ID);
  const output = path.join(job, "output");
  await mkdir(output, { recursive: true });
  const clips = CLIPS.map(clip);
  for (const { index } of clips) {
    const name = `clip-${String(index).padStart(2, "0")}`;
    await copyFile(VIDEO, path.join(output, `${name}.mp4`));
    await writeFile(path.join(output, `${name}.srt`), SRT);
  }
  const at = now.toISOString();
  const record = {
    id: E2E_JOB_ID,
    status: "completed",
    progress: 100,
    stage: "completed",
    stageCode: "clips_ready",
    stageDetail: "Semua klip siap digunakan",
    createdAt: at,
    updatedAt: at,
    source: { type: "upload", name: "elephants-dream.mp4", size: 1000 },
    options: { renderMode: "fit-blur", limit: 3, minDuration: 5, maxDuration: 60, captionStyle: "karaoke", hookOverlay: true },
    clips,
  };
  await writeFile(path.join(job, "job.json"), `${JSON.stringify(record, null, 2)}\n`);
  return E2E_JOB_ID;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write("usage: node scripts/seed-e2e-project.mjs <JOBS_ROOT>\n");
    process.exit(2);
  }
  process.stdout.write(`${await seedE2eProject(root)}\n`);
}
