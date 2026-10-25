// Editor V3 feature flags (plan §11.0 "Flags"). All are off by default; only the exact value
// "on" (any case) switches one on. `POTONGIN_LLM=off` (global) also switches the editor's LLM part
// off. The automatic clips' render engine is "edit-v2" unless POTONGIN_RENDER_ENGINE says
// "legacy" (any case, outer spaces ignored: the rollback switch), the same reading as
// edit_v2.render_edit.engine_from_env (CONTRACTS §5.48).
//
// POTONGIN_EDITOR_SHELL picks the editor's shell (rombak 06 §17, 08 Fase 10): "v2" (any case,
// outer spaces ignored) is the one-layout editor, anything else the two-view one, so "legacy"
// rolls it back. Removed with the old shell in F10.
//
// Server components read these from `process.env` and pass the values to the client; the
// variable names are the ones `compose.yaml` passes through to the app.

export const EDITOR_FLAGS = Object.freeze([
  "POTONGIN_EDITOR_V3", "POTONGIN_EDITOR_UPLOADS", "POTONGIN_EDITOR_LLM", "POTONGIN_RENDER_ENGINE", "POTONGIN_EDITOR_SHELL",
]);

export function isOn(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "on";
}

/** `{ editorV3, uploads, llm, renderEngine, shell }` from an environment object. */
export function readEditorFlags(env = globalThis.process?.env ?? {}) {
  const llmOff = typeof env.POTONGIN_LLM === "string" && env.POTONGIN_LLM.trim().toLowerCase() === "off";
  return {
    editorV3: isOn(env.POTONGIN_EDITOR_V3),
    uploads: isOn(env.POTONGIN_EDITOR_UPLOADS),
    llm: isOn(env.POTONGIN_EDITOR_LLM) && !llmOff,
    renderEngine: typeof env.POTONGIN_RENDER_ENGINE === "string" && env.POTONGIN_RENDER_ENGINE.trim().toLowerCase() === "legacy" ? "legacy" : "edit-v2",
    shell: typeof env.POTONGIN_EDITOR_SHELL === "string" && env.POTONGIN_EDITOR_SHELL.trim().toLowerCase() === "v2" ? "v2" : "legacy",
  };
}

/**
 * The flags GET /api/jobs adds to the jobs list: `editor` (the history offers "Edit klip") and
 * `renderEngine` (the dashboard offers only the caption looks that engine renders).
 */
export function jobListFlags(env = globalThis.process?.env ?? {}) {
  const flags = readEditorFlags(env);
  return { editor: flags.editorV3, renderEngine: flags.renderEngine };
}
