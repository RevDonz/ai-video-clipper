"use client";

// Pengaturan's one save bar (05-ui-dashboard.md §6.10). A card that keeps a draft calls
// useSettingsCard(id, tab, { dirty, save, discard }); the bar appears while any card is dirty, and
// Simpan saves the dirty cards one after another (lib/settings-save-model.mjs), then says
// "Tersimpan" or "{count} gagal" and moves focus to the first card that failed. Uploads (logo,
// cookies.txt) are not drafts: they save the moment a file is picked.
import { Button } from "@heroui/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { toast } from "../../components/ui/Toast.jsx";
import { dirtyTabs, saveDirtyCards, saveOutcome } from "../../lib/settings-save-model.mjs";

const SaveContext = createContext(null);

/** The id of a card's focus target: its region, which carries tabIndex={-1}. */
export const cardDomId = (id) => `settings-card-${id}`;

export function SettingsSaveProvider({ onShowTab, children }) {
  const t = useTranslations("settings");
  const cards = useRef(new Map());
  const [dirty, setDirty] = useState({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(0);
  const showTab = useRef(onShowTab);
  showTab.current = onShowTab;

  const register = useCallback((id, entry) => {
    cards.current.set(id, entry);
    return () => {
      cards.current.delete(id);
      setDirty((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    };
  }, []);
  const mark = useCallback((id, tab, value) => {
    setDirty((current) => (current[id]?.dirty === value && current[id]?.tab === tab ? current : { ...current, [id]: { tab, dirty: value } }));
  }, []);

  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  const savingNow = useRef(false);
  const tabs = useMemo(() => dirtyTabs(Object.entries(dirty).map(([id, item]) => ({ id, ...item }))), [dirty]);
  const anyDirty = tabs.size > 0;
  // The cards in registration order, each with the dirty flag it last reported.
  const list = useCallback(
    () => [...cards.current.values()].map((entry) => ({ ...entry.current, dirty: dirtyNow.current[entry.current.id]?.dirty === true })),
    [],
  );

  useEffect(() => {
    if (!anyDirty) {
      setFailed(0);
      return undefined;
    }
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const saveAll = useCallback(async () => {
    if (savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    setFailed(0);
    try {
      const outcome = saveOutcome(await saveDirtyCards(list()));
      if (outcome.kind === "saved") toast.success(t("bar.saved"));
      if (outcome.kind === "partial") {
        setFailed(outcome.failedCount);
        toast.danger(t("bar.failed", { count: outcome.failedCount }));
        showTab.current?.(outcome.first.tab);
        // The tab's panel shows on the next frame; then the card can take focus.
        requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(cardDomId(outcome.first.id))?.focus()));
      }
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }, [list, t]);

  const discardAll = useCallback(() => {
    for (const card of list()) if (card.dirty) card.discard?.();
    setFailed(0);
  }, [list]);

  const value = useMemo(() => ({ register, mark, saveAll, tabs, saving }), [register, mark, saveAll, tabs, saving]);
  return (
    <SaveContext value={value}>
      {children}
      {(anyDirty || saving) && <SaveBar saving={saving} failed={failed} onSave={saveAll} onDiscard={discardAll} />}
    </SaveContext>
  );
}

function SaveBar({ saving, failed, onSave, onDiscard }) {
  const t = useTranslations("settings");
  const state = saving ? t("bar.saving") : failed ? t("bar.failed", { count: failed }) : t("bar.unsaved");
  return (
    <div className="settingsSaveBar" role="region" aria-label={t("bar.region")}>
      <p className="settingsSaveState" data-tone={failed && !saving ? "error" : "dirty"} role="status" aria-live="polite">
        <span className="settingsSaveDot" aria-hidden="true" />
        {state}
      </p>
      <div className="settingsSaveActions">
        <Button variant="secondary" onPress={onDiscard} isDisabled={saving}>{t("bar.discard")}</Button>
        <Button variant="primary" onPress={onSave} isDisabled={saving}>{saving ? t("bar.saving") : t("bar.save")}</Button>
      </div>
    </div>
  );
}

/** The tabs that hold unsaved changes. */
export function useDirtyTabs() {
  return useContext(SaveContext)?.tabs ?? new Set();
}

/** Simpan from inside a card (Enter in one of its fields): the same as the bar's button. */
export function useSaveAll() {
  const context = useContext(SaveContext);
  return useCallback(() => context?.saveAll(), [context]);
}

/**
 * Registers a draft card with the bar. `save()` resolves `{ ok }` and shows its own errors;
 * `discard()` puts the draft back to what is stored.
 */
export function useSettingsCard(id, tab, { dirty, save, discard }) {
  const context = useContext(SaveContext);
  const entry = useRef({ id, tab, save, discard });
  entry.current = { id, tab, save, discard };
  const register = context?.register;
  const mark = context?.mark;
  useEffect(() => register?.(id, entry), [register, id]);
  useEffect(() => {
    mark?.(id, tab, Boolean(dirty));
  }, [mark, id, tab, dirty]);
}
