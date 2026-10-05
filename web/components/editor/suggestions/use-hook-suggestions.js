"use client";

// The hook suggestions' controller and view state (plan §7.1, docs/plans/2026-10-02-editor-mode-cepat.md
// §1.2 HOOK), shared by the Teks panel's list (index.jsx) and the Hook card's compact list
// (CompactSuggestions.jsx). The controller is kept per clip and API client (model.mjs
// `suggestionsFor`), so a view switch or a card closing never asks the server again; the first
// request is made when one of the two lists mounts.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { createApiClient } from "../../../lib/editor/api-client.mjs";
import { runCommands } from "../transcript/actions.mjs";
import { aiView, applyCommand, contentKey, hookItem, sameText, suggestionsFor } from "./model.mjs";

const IDLE = Object.freeze({ phase: "idle", heuristic: [], key: null, error: null, llm: { state: "off", suggestions: [] } });
const noop = () => () => {};

// One client per clip for the page, when the shell passes none, so reopening finds the same
// suggestions (they are kept per client) instead of asking the server again.
const OWN_CLIENTS = new Map();

/** The API client: the shell's, else the fake runtime's (its dev hook), else one per clip. */
export function useEditorApi(api, jobId, clipId) {
  return useMemo(() => {
    if (api) return api;
    const shared = typeof window === "undefined" ? null : window.__potonginEditor?.api;
    if (shared) return shared;
    const key = `${jobId}/${clipId}`;
    if (!OWN_CLIENTS.has(key)) {
      try {
        OWN_CLIENTS.set(key, createApiClient({ jobId, clipId }));
      } catch {
        return null;
      }
    }
    return OWN_CLIENTS.get(key);
  }, [api, jobId, clipId]);
}

/**
 * Everything a suggestions list shows: `{ ready, view, ai, stale, loadingFirst, empty, privacy,
 * current, readOnly, message, use, refresh }`. `use(suggestion)` applies it as one undoable
 * command (origin `suggestion:<id>`); `privacy` is the panel's rule for the privacy line: the AI
 * part is visible and is not a settings notice.
 */
export function useHookSuggestions({ state, dispatch, api }) {
  const doc = state?.doc ?? null;
  const clipId = state?.clipId ?? doc?.clip_id ?? null;
  const client = useEditorApi(api, state?.jobId ?? doc?.base?.job_id, clipId);
  const controller = useMemo(() => suggestionsFor(client, clipId), [client, clipId]);
  const subscribe = useCallback((listener) => (controller ? controller.subscribe(listener) : noop()), [controller]);
  const snapshot = useCallback(() => (controller ? controller.getState() : IDLE), [controller]);
  const view = useSyncExternalStore(subscribe, snapshot, () => IDLE);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (controller && doc) controller.ensure(doc);
  }, [controller, doc]);

  const ai = aiView(view.llm);
  const current = hookItem(doc)?.payload?.text ?? null;
  const use = (suggestion) => {
    const result = runCommands(dispatch, [{ ...applyCommand(doc, suggestion), mergeKey: null }]);
    setMessage(result.ok ? null : result.message);
  };
  return {
    ready: Boolean(controller && doc),
    view,
    ai,
    stale: view.phase === "ready" && view.key !== null && view.key !== contentKey(doc),
    loadingFirst: view.phase === "loading" && view.heuristic.length === 0,
    empty: view.phase === "ready" && view.heuristic.length === 0 && !ai.visible,
    privacy: ai.visible && ai.status !== "notice",
    current,
    isCurrent: (suggestion) => sameText(current, suggestion.text),
    readOnly: state?.status !== "ready",
    message,
    use,
    refresh: () => controller?.request(doc),
  };
}
