// How many clips a job makes and how long each may be. Client-safe. The job API, the dashboard
// form and the typed time ranges read these; the engine's ranges use the same numbers
// (src/ai_clipper/time_ranges.py, checked by web/tests/clip-limits.test.mjs). Raising them means
// more render time on the shared CPU quota and more storage per job (GATES "Output sizes").
export const CLIP_LIMITS = Object.freeze({
  count: Object.freeze({ min: 1, max: 10 }),
  seconds: Object.freeze({ min: 5, max: 180 }),
});
