// "Pakai di semua klip" in the editor (CONTRACTS §5.53), DOM-free: the texts and the controller
// the shell builds once per clip (`createApplyAll`). The controller saves the clip first (the
// store's flush gives the etag the server copies from), sends one batch per click and keeps, per
// group, `{phase: "idle"|"running"|"done"|"undoing"|"undone"|"error", result, undo, message}`,
// so Mode Cepat and Mode Lengkap show the same result. After a lost answer (network or 5xx) the
// next click reuses the Idempotency-Key while the saved etag is the same, so the server replays
// the batch instead of finding its own writes and skipping them as "diubah manual".

export const APPLY_GROUPS = Object.freeze({
  captions: Object.freeze({ button: "Pakai caption di semua klip", note: "Klip yang caption-nya sudah diubah tidak ikut." }),
  logo: Object.freeze({ button: "Pakai logo di semua klip", note: "Logo dan teks watermark. Klip yang sudah diubah tidak ikut." }),
  layout: Object.freeze({ button: "Pakai tata letak di semua klip", note: "Tanpa bingkai manual. Klip yang tata letaknya sudah diubah tidak ikut." }),
});

const SKIP_TEXT = Object.freeze({
  edited: "sudah diubah manual",
  not_ready: "belum disiapkan",
  read_only: "transkripnya berubah",
  conflict: "berubah saat diterapkan",
  invalid: "tidak muat di klip ini",
  changed: "sudah diubah lagi",
});

const count = (list) => (Array.isArray(list) ? list.length : 0);

/** "Dipakai di n klip · k dilewati" (plus "· m sudah sama" when some already matched). */
export function applySummary(result) {
  const applied = count(result?.applied);
  const skipped = count(result?.skipped);
  const same = count(result?.unchanged);
  if (!applied && !skipped) return same ? "Semua klip lain sudah sama" : "Tidak ada klip lain";
  const parts = [`Dipakai di ${applied} klip`, `${skipped} dilewati`];
  if (same) parts.push(`${same} sudah sama`);
  return parts.join(" · ");
}

export function undoSummary(result) {
  const skipped = count(result?.skipped);
  const text = `Dikembalikan di ${count(result?.restored)} klip`;
  return skipped ? `${text} · ${skipped} dilewati` : text;
}

/** "Klip 3: sudah diubah manual", one line per skipped clip. */
export function skippedLines(list) {
  return (Array.isArray(list) ? list : []).map((item) => `Klip ${item.index}: ${SKIP_TEXT[item.reason] ?? "dilewati"}`);
}

export function applyErrorText(error, action = "apply") {
  if (error?.code === "conflict_unresolved") return "Selesaikan bentrok perubahan dulu";
  // The source was saved in another tab; this tab's store learns it only on its next save.
  if (error?.code === "revision_conflict") return "Klip ini diubah di tab lain; muat ulang dulu";
  if (error?.status === 429) return "Terlalu banyak permintaan; tunggu sebentar";
  if (action === "undo" && error?.status === 404) return "Sudah tidak bisa diurungkan";
  return action === "undo" ? "Gagal mengurungkan; coba lagi" : "Gagal menerapkan; coba lagi";
}

const IDLE = Object.freeze({ phase: "idle", result: null, undo: null, message: null });
const lost = (error) => !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;

export function createApplyAll({ api, flush, newKey }) {
  const states = new Map();
  const pending = new Map(); // group → {key, etag} of a batch whose answer was lost
  const listeners = new Set();
  let others = null;

  const get = (group) => states.get(group) ?? IDLE;
  const set = (group, patch) => {
    states.set(group, Object.freeze({ ...get(group), ...patch }));
    for (const listener of [...listeners]) listener();
  };

  return {
    get,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** How many other clips the job has (null until the listing arrives). */
    others: () => others,
    setClips(clips, clipId) {
      others = Array.isArray(clips) ? clips.filter((clip) => clip?.clipId !== clipId).length : null;
      for (const listener of [...listeners]) listener();
    },
    async apply(group) {
      const phase = get(group).phase;
      if (phase === "running" || phase === "undoing") return;
      set(group, { phase: "running", message: null });
      let etag;
      try {
        etag = await flush();
      } catch (error) {
        set(group, { phase: "error", result: null, undo: null, message: applyErrorText(error) });
        return;
      }
      const reuse = pending.get(group);
      const key = reuse && reuse.etag === etag ? reuse.key : newKey();
      pending.set(group, { key, etag });
      try {
        const result = await api.applyToAll({ group, etag }, key);
        pending.delete(group);
        set(group, { phase: "done", result, undo: null, message: null });
      } catch (error) {
        if (!lost(error)) pending.delete(group);
        set(group, { phase: "error", result: null, undo: null, message: applyErrorText(error) });
      }
    },
    async undo(group) {
      const current = get(group);
      if (current.phase !== "done" || !current.result?.batchId) return;
      set(group, { phase: "undoing", message: null });
      try {
        const undo = await api.undoApplyAll(current.result.batchId);
        set(group, { phase: "undone", undo, message: null });
      } catch (error) {
        set(group, { phase: "done", message: applyErrorText(error, "undo") });
      }
    },
  };
}
