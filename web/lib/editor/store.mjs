// The editor store (plan §4.5, Appendix A.2 `createEditorStore`): the one place UI components
// read state from and send commands to.
//
// - Commands (Appendix B) go through the edit session (history.mjs: undo/redo, mergeKey, the
//   pending log). After every change the draft is written to IndexedDB, autosave is notified and
//   a preview plan is requested (latest wins).
// - Autosave PUTs `{...doc, revision: base.revision + 1, parent_sha256: base.etag}` with
//   `If-Match: base.etag`. A 409 replays the pending log onto the server's document (rebase.mjs):
//   merged → saved at once with the notice "Digabung dengan perubahan dari tab lain"; otherwise
//   `state.conflict.groups` feeds the per-part dialog and `resolveConflict(choices)` finishes it.
//   The editor never locks and the draft is kept until everything is saved.
// - On open a draft with the server's etag is restored silently; a draft on an older etag is
//   rebased; a draft whose PUT was in flight re-sends that PUT with the same Idempotency-Key, so
//   a save whose response was lost is recognised instead of applied twice.
// - `BroadcastChannel("potongin-editor")` sets `otherTab` ("Klip ini terbuka di tab lain");
//   `beforeunload` is guarded while work is unsaved; blur and a hidden page flush the save.
//
// State (Appendix A.2 plus): status "loading"|"ready"|"readOnly"|"error", doc, seed, words, etag,
// revision, save "saved"|"dirty"|"saving"|"conflict"|"error", savedAtMs, canUndo, canRedo, plan,
// pending (layers not current: "text"|"audio"|"plate"|"logo"), warnings, selection, commands (the
// pending log), conflict, notice, error, readOnlyReason, notices, engine, otherTab, previewError.
import { createAutosave } from "./autosave.mjs";
import { CommandRejected } from "./commands.mjs";
import { createContext } from "./doc-model.mjs";
import { createDraftStore, createDraftWriter } from "./draft-store.mjs";
import { createEditSession } from "./history.mjs";
import { rebase, replaySteps } from "./rebase.mjs";

export const EDITOR_CHANNEL = "potongin-editor";
export const STORE_MESSAGES = Object.freeze({
  merged: "Digabung dengan perubahan dari tab lain",
  save_error: "Gagal menyimpan; perubahan aman di browser ini",
  schema_too_new: "Editor perlu dimuat ulang",
  load_error: "Klip tidak bisa dibuka",
  conflict: "Klip ini diubah di tab lain",
  other_tab: "Klip ini terbuka di tab lain",
});

function defaultChannel() {
  return typeof window !== "undefined" && typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : null;
}

function defaultLifecycle() {
  return typeof window !== "undefined" && typeof document !== "undefined" ? { window, document } : null;
}

/** GET …/edit in either shape: the CLI's `{seed: <doc>, isSeed}` or `{seed: <bool>}`. */
function normalizeEdit(body) {
  const isSeed = typeof body.isSeed === "boolean" ? body.isSeed : body.seed === true;
  const seedDoc = body.seed && typeof body.seed === "object" ? body.seed : isSeed ? body.doc : null;
  return {
    doc: body.doc, etag: body.etag, isSeed, seedDoc, words: body.words ?? null,
    readOnly: body.readOnly === true, readOnlyReason: body.readOnlyReason ?? null,
    notices: Array.isArray(body.notices) ? body.notices : [], engine: body.engine ?? body.doc?.base?.engine?.compiler ?? null,
  };
}

function pendingLayers(plan, requesting) {
  const layers = [];
  if (requesting) layers.push("text");
  if (plan?.audio && plan.audio.state !== "ready") layers.push("audio");
  if (Array.isArray(plan?.plate?.cells) && plan.plate.cells.some((cell) => cell.state !== "ready")) layers.push("plate");
  if (plan?.logo?.state && plan.logo.state !== "ready") layers.push("logo");
  return layers;
}

export function createEditorStore({
  jobId,
  clipId,
  api,
  previewClient = null,
  draftStore = createDraftStore(),
  now = () => Date.now(),
  newKey = () => globalThis.crypto.randomUUID(),
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  autosave: autosaveOptions = {},
  channel = defaultChannel(),
  lifecycle = defaultLifecycle(),
}) {
  const listeners = new Set();
  let state = Object.freeze({
    status: "loading", phase: null, jobId, clipId, doc: null, seed: null, words: null, etag: null, revision: null,
    save: "saved", savedAtMs: null, canUndo: false, canRedo: false, plan: null, pending: [], warnings: [],
    selection: null, commands: [], conflict: null, notice: null, error: null, readOnlyReason: null, notices: [],
    engine: null, otherTab: false, previewError: null,
  });
  let ctx = null;
  let session = null;
  let base = null;
  let conflictState = null;
  let inflight = null;
  let saveError = null;
  let saveWarnings = [];
  let planSeq = 0;
  let destroyed = false;
  let port = null;
  let detach = null;
  const tabId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const others = new Set();
  const draftWriter = createDraftWriter({ store: draftStore, now });

  const set = (patch) => {
    if (destroyed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener(state);
  };

  const saveState = () => {
    if (conflictState) return "conflict";
    if (inflight && autosave.busy) return "saving";
    const pending = session ? session.pending.length : 0;
    if (saveError && pending) return "error";
    return pending ? "dirty" : "saved";
  };

  const docState = () => ({
    doc: session.doc, canUndo: session.canUndo, canRedo: session.canRedo, commands: session.pending,
  });

  const writeDraft = () => {
    if (!session || !base || destroyed) return;
    const pending = session.pending;
    if (!pending.length && !inflight && !conflictState) {
      draftWriter.remove(clipId);
      return;
    }
    draftWriter.write({ clipId, baseEtag: base.etag, baseDoc: base.doc, commands: pending, doc: session.doc, savedAtMs: now(), inflight });
  };

  const requestPlan = () => {
    if (!previewClient || !session || destroyed) return;
    planSeq += 1;
    const seq = planSeq;
    set({ pending: pendingLayers(state.plan, true) });
    previewClient.plan(session.doc).then((plan) => {
      if (destroyed || seq !== planSeq) return;
      set({ plan, pending: pendingLayers(plan, false), warnings: plan?.warnings ?? saveWarnings, previewError: null });
    }, (error) => {
      if (destroyed || seq !== planSeq || error?.name === "AbortError") return;
      set({ pending: pendingLayers(state.plan, false), previewError: { code: error?.code ?? "preview_failed" } });
    });
  };

  const afterChange = () => {
    set({ ...docState(), save: saveState() });
    writeDraft();
    autosave.notify();
    requestPlan();
  };

  const flushQuietly = () => {
    autosave.flush().catch(() => {});
  };

  function snapshot() {
    if (!session || !base || conflictState || state.status !== "ready") return null;
    const pending = session.pending;
    if (!pending.length) return null;
    return { doc: { ...session.doc, revision: base.doc.revision + 1, parent_sha256: base.etag }, etag: base.etag, count: pending.length };
  }

  const autosave = createAutosave({
    snapshot,
    put: (doc, options) => api.putEdit(doc, options),
    onSaving(snap, key) {
      session.seal();
      session.protect(snap.count);
      inflight = { key, etag: snap.etag, count: snap.count, doc: snap.doc };
      set({ save: "saving" });
      writeDraft();
    },
    onSaved(result, snap) {
      base = { doc: result.doc, etag: result.etag };
      session.saved(snap.count);
      inflight = null;
      saveError = null;
      saveWarnings = Array.isArray(result.warnings) ? result.warnings : [];
      set({ ...docState(), etag: result.etag, revision: result.doc.revision, savedAtMs: now(), error: null, save: saveState(),
        warnings: state.plan?.warnings ?? saveWarnings });
      writeDraft();
    },
    onConflict(error) {
      inflight = null;
      session.protect(0);
      handleConflict(error).catch((failure) => {
        set({ save: "error", error: { code: failure?.code ?? "conflict_failed", message: STORE_MESSAGES.save_error } });
      });
    },
    onError(error, _snap, info) {
      if (!info.retrying) {
        inflight = null;
        session.protect(0);
      }
      saveError = error;
      const message = error?.status === 426 ? STORE_MESSAGES.schema_too_new : STORE_MESSAGES.save_error;
      set({ save: "error", error: { code: error?.code ?? "save_failed", message, retrying: info.retrying } });
      writeDraft();
    },
    newKey,
    now,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    ...autosaveOptions,
  });

  async function handleConflict(error) {
    let theirs = error?.body?.current ?? null;
    let etag = error?.body?.etag ?? null;
    if (!theirs || !etag) {
      const current = normalizeEdit(await api.getEdit({ seed: false }));
      theirs = current.doc;
      etag = current.etag;
    }
    rebaseOnto(theirs, etag);
  }

  /** Rebases the session (base → current, pending log) onto the server's document. */
  function rebaseOnto(theirs, etag, { fromDraft = false } = {}) {
    const result = rebase({ base: base.doc, mine: session.doc, theirs, steps: session.pending, ctx });
    if (result.status === "merged") {
      acceptBase(theirs, etag, result.steps);
      if (result.steps.length || !fromDraft) set({ notice: { code: "merged", message: STORE_MESSAGES.merged } });
      if (session.pending.length) flushQuietly();
      return;
    }
    conflictState = { theirs, etag };
    autosave.pause();
    set({
      save: "conflict",
      conflict: { groups: result.conflicts.map(({ id, label, parts, mine, theirs: saved }) => ({ id, label, parts, mine, theirs: saved })), error: null },
    });
    writeDraft();
  }

  function acceptBase(theirs, etag, steps) {
    base = { doc: theirs, etag };
    session.reset({ base: theirs, steps });
    conflictState = null;
    saveError = null;
    set({ ...docState(), etag, revision: theirs.revision, conflict: null, error: null, save: saveState() });
    writeDraft();
    requestPlan();
    autosave.resume();
  }

  async function restoreDraft(serverDoc, serverEtag) {
    let draft = null;
    try {
      draft = await draftStore.get(clipId);
    } catch {
      return;
    }
    if (!draft || draft.clipId !== clipId || !Array.isArray(draft.commands)) return;
    let baseDoc = draft.baseDoc ?? null;
    let baseEtag = draft.baseEtag;
    let steps = draft.commands;
    let theirs = serverDoc;
    let theirsEtag = serverEtag;
    if (baseEtag !== serverEtag && draft.inflight && draft.inflight.count <= steps.length) {
      try {
        const replayed = await api.putEdit(draft.inflight.doc, { etag: draft.inflight.etag, key: draft.inflight.key });
        if (draft.inflight.etag === serverEtag) {
          theirs = replayed.doc;
          theirsEtag = replayed.etag;
        }
        baseDoc = replayed.doc;
        baseEtag = replayed.etag;
        steps = steps.slice(draft.inflight.count);
      } catch {
        // Not committed, or its receipt is gone: the rebase below decides.
      }
    }
    if (theirsEtag !== serverEtag) {
      base = { doc: theirs, etag: theirsEtag };
      set({ etag: theirsEtag, revision: theirs.revision });
    }
    if (!steps.length) {
      session.reset({ base: theirs, steps: [] });
      set({ ...docState(), save: saveState() });
      writeDraft();
      return;
    }
    if (baseEtag === theirsEtag) {
      try {
        session.reset({ base: theirs, steps });
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error;
        return;
      }
      set({ ...docState(), save: saveState() });
      writeDraft();
      autosave.notify();
      return;
    }
    if (!baseDoc) return;
    try {
      replaySteps(baseDoc, steps, ctx);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      return;
    }
    base = { doc: baseDoc, etag: baseEtag };
    session.reset({ base: baseDoc, steps });
    set({ ...docState() });
    rebaseOnto(theirs, theirsEtag, { fromDraft: true });
  }

  function openChannel() {
    if (!channel) return;
    try {
      port = channel(EDITOR_CHANNEL);
    } catch {
      port = null;
      return;
    }
    port.onmessage = (event) => {
      const message = event?.data;
      if (!message || message.clipId !== clipId || message.tab === tabId) return;
      if (message.type === "open") {
        others.add(message.tab);
        port?.postMessage({ type: "here", clipId, tab: tabId });
      } else if (message.type === "here") others.add(message.tab);
      else if (message.type === "closed") others.delete(message.tab);
      set({ otherTab: others.size > 0 });
    };
    port.postMessage({ type: "open", clipId, tab: tabId });
  }

  function attachLifecycle() {
    const win = lifecycle?.window;
    if (!win) return;
    const doc = lifecycle.document ?? null;
    const onBlur = () => flushQuietly();
    const onVisibility = () => {
      if (doc?.visibilityState === "hidden") flushQuietly();
    };
    const onBeforeUnload = (event) => {
      if (session && (session.pending.length || inflight)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    win.addEventListener("blur", onBlur);
    win.addEventListener("beforeunload", onBeforeUnload);
    doc?.addEventListener("visibilitychange", onVisibility);
    detach = () => {
      win.removeEventListener("blur", onBlur);
      win.removeEventListener("beforeunload", onBeforeUnload);
      doc?.removeEventListener("visibilitychange", onVisibility);
    };
  }

  const ready = (async () => {
    try {
      let body;
      try {
        body = await api.getEdit({ seed: false });
      } catch (error) {
        if (error?.status !== 409 || error?.code !== "analysis_missing") throw error;
        set({ phase: "preparing" });
        await api.prepare({});
        body = await api.getEdit({ seed: false });
      }
      const current = normalizeEdit(body);
      const seedDoc = current.seedDoc ?? normalizeEdit(await api.getEdit({ seed: true })).doc;
      const words = await api.words(current.words.url);
      ctx = createContext({ words, seed: seedDoc });
      base = { doc: current.doc, etag: current.etag };
      session = createEditSession({ doc: current.doc, ctx, now });
      set({
        status: current.readOnly ? "readOnly" : "ready", phase: null, seed: seedDoc, words, etag: current.etag,
        revision: current.doc.revision, readOnlyReason: current.readOnlyReason, notices: current.notices,
        engine: current.engine, ...docState(), save: "saved",
      });
      openChannel();
      attachLifecycle();
      if (!current.readOnly) await restoreDraft(current.doc, current.etag);
      requestPlan();
    } catch (error) {
      const code = error?.code ?? "load_failed";
      set({ status: "error", phase: null, error: { code, message: error?.status === 426 ? STORE_MESSAGES.schema_too_new : STORE_MESSAGES.load_error } });
    }
  })();

  return {
    ready,
    draftWriter,
    get context() {
      return ctx;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Applies an Appendix B command; throws CommandRejected (code + Indonesian message). */
    dispatch(type, args = {}, options = {}) {
      if (state.status === "readOnly") throw new CommandRejected("read_only");
      if (state.status !== "ready" || !session) throw new CommandRejected("not_ready");
      const result = session.dispatch(type, args, options);
      if (result.changed) afterChange();
      return session.doc;
    },
    undo() {
      if (state.status === "ready" && session?.undo()) afterChange();
    },
    redo() {
      if (state.status === "ready" && session?.redo()) afterChange();
    },
    /** Saves now (export, leaving); resolves with the saved etag; rejects on failure or conflict. */
    async flush() {
      await ready;
      if (conflictState) throw new CommandRejected("conflict_unresolved");
      await autosave.flush();
      return base?.etag ?? null;
    },
    /** Answers the per-part dialog: `{ [groupId]: "mine" | "theirs" }` (default "mine"). */
    async resolveConflict(choices = {}) {
      if (!conflictState) return;
      const { theirs, etag } = conflictState;
      const result = rebase({ base: base.doc, mine: session.doc, theirs, steps: session.pending, ctx });
      let resolved;
      if (result.status === "merged") resolved = { steps: result.steps };
      else {
        try {
          resolved = result.resolve(choices);
        } catch (error) {
          if (error instanceof CommandRejected) set({ conflict: { ...state.conflict, error: { code: error.code, message: error.message } } });
          throw error;
        }
      }
      acceptBase(theirs, etag, resolved.steps);
      if (session.pending.length) await autosave.flush().catch(() => {});
    },
    /** Read-only clip ("Transkrip berubah"): start again from the AI version. */
    async startFromSeed() {
      await ready;
      const seedEdit = normalizeEdit(await api.getEdit({ seed: true }));
      const words = await api.words(seedEdit.words.url);
      ctx = createContext({ words, seed: seedEdit.doc });
      session = createEditSession({ doc: base.doc, ctx, now });
      session.dispatch("ResetToSeed", {});
      set({ status: "ready", readOnlyReason: null, seed: seedEdit.doc, words, ...docState(), save: saveState() });
      writeDraft();
      requestPlan();
      autosave.notify();
    },
    retrySave() {
      saveError = null;
      set({ error: null, save: saveState() });
      flushQuietly();
    },
    setSelection(selection) {
      set({ selection });
    },
    dismissNotice() {
      set({ notice: null });
    },
    destroy() {
      if (destroyed) return;
      autosave.destroy();
      detach?.();
      detach = null;
      if (port) {
        try {
          port.postMessage({ type: "closed", clipId, tab: tabId });
        } catch {
          // The channel is already gone.
        }
        port.close?.();
        port = null;
      }
      previewClient?.destroy?.();
      destroyed = true;
      listeners.clear();
    },
  };
}
