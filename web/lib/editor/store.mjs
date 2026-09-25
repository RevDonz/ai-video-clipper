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
// - Drafts are per tab (`<clipId>#<tabId>`; the tab id lives in sessionStorage, so it survives a
//   reload, and a duplicated tab takes a new one). On open, this tab's draft is restored (same
//   etag: silently; older etag: rebased; a PUT that was in flight is re-sent with its
//   Idempotency-Key, so a save whose response was lost is recognised, not applied twice); drafts
//   of closed tabs of the clip are merged in; drafts of live tabs are left to them.
// - `BroadcastChannel("potongin-editor")` sets `otherTab` ("Klip ini terbuka di tab lain") and
//   tells live tabs apart from closed ones; `beforeunload` is guarded while work is unsaved; blur
//   and a hidden page flush the save.
//
// State (Appendix A.2 plus): status "loading"|"ready"|"readOnly"|"error", doc, seed, words, etag,
// revision, save "saved"|"dirty"|"saving"|"conflict"|"error", savedAtMs, canUndo, canRedo, plan,
// pending (layers not current: "text"|"audio"|"plate"|"logo"), warnings, selection, commands (the
// pending log), conflict, notice, error, readOnlyReason, notices, engine, otherTab, previewError.
import { randomUuid } from "./api-client.mjs";
import { createAutosave } from "./autosave.mjs";
import { CommandRejected } from "./commands.mjs";
import { createContext } from "./doc-model.mjs";
import { createDraftStore, createDraftWriter, draftKey } from "./draft-store.mjs";
import { createEditSession } from "./history.mjs";
import { rebase, replaySteps } from "./rebase.mjs";

export const EDITOR_CHANNEL = "potongin-editor";
export const TAB_ID_KEY = "potongin-editor-tab";
/** How long an opening tab waits for live tabs to answer before it adopts other tabs' drafts. */
export const DISCOVERY_MS = 150;
export const STORE_MESSAGES = Object.freeze({
  merged: "Digabung dengan perubahan dari tab lain",
  save_error: "Gagal menyimpan; perubahan aman di browser ini",
  schema_too_new: "Editor perlu dimuat ulang",
  load_error: "Klip tidak bisa dibuka",
  conflict: "Klip ini diubah di tab lain",
  other_tab: "Klip ini terbuka di tab lain",
  draft_conflict: "Perubahan dari tab lain yang belum tersimpan tidak bisa digabung otomatis; drafnya tetap disimpan",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function defaultChannel() {
  return typeof window !== "undefined" && typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : null;
}

function defaultLifecycle() {
  return typeof window !== "undefined" && typeof document !== "undefined" ? { window, document } : null;
}

function defaultTabStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readTabId(storage) {
  try {
    const value = storage?.getItem(TAB_ID_KEY);
    if (typeof value === "string" && UUID.test(value)) return value;
  } catch {
    // sessionStorage can throw (disabled storage): the tab gets a fresh id per load.
  }
  return newTabId(storage);
}

function newTabId(storage) {
  const id = randomUuid();
  try {
    storage?.setItem(TAB_ID_KEY, id);
  } catch {
    // Not persisted: a reload of this tab then adopts its own draft as a closed tab's.
  }
  return id;
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
  newKey = () => randomUuid(),
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  autosave: autosaveOptions = {},
  channel = defaultChannel(),
  lifecycle = defaultLifecycle(),
  tabStorage = defaultTabStorage(),
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
  let tabId = readTabId(tabStorage);
  const instance = randomUuid();
  const others = new Map(); // live instances of this clip in other tabs → their tab ids
  const draftWriter = createDraftWriter({ store: draftStore, now });
  const ownKey = () => draftKey(clipId, tabId);

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
      draftWriter.remove(ownKey());
      return;
    }
    draftWriter.write({ key: ownKey(), clipId, tabId, baseEtag: base.etag, baseDoc: base.doc, commands: pending, doc: session.doc,
      savedAtMs: now(), inflight });
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

  const sleep = (ms) => new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });

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

  /**
   * Rebases the session (base → current, pending log) onto the server's document. Merged work is
   * saved at once, except while drafts are being restored (the caller saves when it is done).
   */
  function rebaseOnto(theirs, etag, { restoring = false } = {}) {
    const result = rebase({ base: base.doc, mine: session.doc, theirs, steps: session.pending, ctx });
    if (result.status === "merged") {
      acceptBase(theirs, etag, result.steps);
      if (result.steps.length) set({ notice: { code: "merged", message: STORE_MESSAGES.merged } });
      if (session.pending.length && !restoring) flushQuietly();
      return true;
    }
    conflictState = { theirs, etag };
    autosave.pause();
    set({
      save: "conflict",
      conflict: { groups: result.conflicts.map(({ id, label, parts, mine, theirs: saved }) => ({ id, label, parts, mine, theirs: saved })), error: null },
    });
    writeDraft();
    return false;
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

  /** Restores one draft as this tab's work. Returns "none", "restored" or "rebased". */
  async function restoreDraft(draft, serverDoc, serverEtag) {
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
      session.reset({ base: theirs, steps: [] });
      set({ ...docState(), etag: theirsEtag, revision: theirs.revision, save: saveState() });
    }
    if (!steps.length) return "none";
    if (baseEtag === theirsEtag) {
      try {
        session.reset({ base: theirs, steps });
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error;
        return "none";
      }
      set({ ...docState(), save: saveState() });
      return "restored";
    }
    if (!baseDoc) return "none";
    try {
      replaySteps(baseDoc, steps, ctx);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      return "none";
    }
    base = { doc: baseDoc, etag: baseEtag };
    session.reset({ base: baseDoc, steps });
    set({ ...docState() });
    rebaseOnto(theirs, theirsEtag, { restoring: true });
    return "rebased";
  }

  /** Merges a closed tab's draft into the current work; false keeps that draft for later. */
  function adoptDraft(draft) {
    if (!draft.baseDoc || conflictState) return false;
    let mine;
    try {
      mine = replaySteps(draft.baseDoc, draft.commands, ctx).doc;
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      return false;
    }
    const result = rebase({ base: draft.baseDoc, mine, theirs: session.doc, steps: draft.commands, ctx });
    if (result.status !== "merged") {
      set({ notice: { code: "draft_conflict", message: STORE_MESSAGES.draft_conflict } });
      return false;
    }
    if (result.steps.length) {
      session.reset({ base: base.doc, steps: [...session.pending, ...result.steps] });
      set({ ...docState(), save: saveState(), notice: { code: "merged", message: STORE_MESSAGES.merged } });
    }
    return true;
  }

  /** This tab's draft first, then the drafts of closed tabs; live tabs keep theirs. */
  async function restoreDrafts(serverDoc, serverEtag) {
    let drafts;
    try {
      drafts = (await draftStore.list(clipId)) ?? [];
    } catch {
      return;
    }
    drafts = drafts.filter((draft) => draft && draft.clipId === clipId && Array.isArray(draft.commands));
    if (!drafts.length) return;
    if (port) await sleep(DISCOVERY_MS);
    const live = new Set(others.values());
    const key = ownKey();
    const own = drafts.find((draft) => draft.key === key && draft.commands.length) ?? null;
    const orphans = drafts.filter((draft) => draft.key !== key && !live.has(draft.tabId) && draft.commands.length)
      .sort((a, b) => (b.savedAtMs ?? 0) - (a.savedAtMs ?? 0));
    const primary = own ?? orphans.shift() ?? null;
    let outcome = "none";
    if (primary) {
      outcome = await restoreDraft(primary, serverDoc, serverEtag);
      if (primary !== own) draftWriter.remove(primary.key);
    }
    for (const orphan of orphans) {
      if (adoptDraft(orphan)) draftWriter.remove(orphan.key);
    }
    writeDraft();
    if (!session.pending.length || conflictState) return;
    if (outcome === "rebased") flushQuietly();
    else autosave.notify();
  }

  function openChannel() {
    if (!channel) return;
    try {
      port = channel(EDITOR_CHANNEL);
    } catch {
      port = null;
      return;
    }
    const post = (type) => port?.postMessage({ type, clipId, tab: tabId, instance });
    port.onmessage = (event) => {
      const message = event?.data;
      if (!message || message.clipId !== clipId || message.instance === instance) return;
      if (message.type === "open") {
        others.set(message.instance, message.tab);
        post("here");
      } else if (message.type === "here") {
        others.set(message.instance, message.tab);
        if (message.tab === tabId) {
          // A duplicated tab (copied sessionStorage) answered with our id: this newer tab moves.
          tabId = newTabId(tabStorage);
          post("here");
        }
      } else if (message.type === "closed") others.delete(message.instance);
      set({ otherTab: others.size > 0 });
    };
    post("open");
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
      if (!current.readOnly) await restoreDrafts(current.doc, current.etag);
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
    /** This tab's draft key (`<clipId>#<tabId>`). */
    get draftKey() {
      return ownKey();
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
          port.postMessage({ type: "closed", clipId, tab: tabId, instance });
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
