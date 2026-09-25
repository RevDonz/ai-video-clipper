// Editor V3 feature flags (plan §11.0 "Flags"). All are off by default; only the exact value
// "on" (any case) switches one on. `POTONGIN_LLM=off` (global) also switches the editor's LLM part
// off. The render engine is "edit-v2" only when set so; anything else is "legacy".
//
// Server components read these from `process.env` and pass the booleans to the client; the
// variable names are the ones `compose.yaml` passes through and `web/lib/python-cli.mjs` allows.

export const EDITOR_FLAGS = Object.freeze(["POTONGIN_EDITOR_V3", "POTONGIN_EDITOR_UPLOADS", "POTONGIN_EDITOR_LLM", "POTONGIN_RENDER_ENGINE"]);

export function isOn(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "on";
}

/** `{ editorV3, uploads, llm, renderEngine }` from an environment object. */
export function readEditorFlags(env = globalThis.process?.env ?? {}) {
  const llmOff = typeof env.POTONGIN_LLM === "string" && env.POTONGIN_LLM.trim().toLowerCase() === "off";
  return {
    editorV3: isOn(env.POTONGIN_EDITOR_V3),
    uploads: isOn(env.POTONGIN_EDITOR_UPLOADS),
    llm: isOn(env.POTONGIN_EDITOR_LLM) && !llmOff,
    renderEngine: typeof env.POTONGIN_RENDER_ENGINE === "string" && env.POTONGIN_RENDER_ENGINE.trim() === "edit-v2" ? "edit-v2" : "legacy",
  };
}
