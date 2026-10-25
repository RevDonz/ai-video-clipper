"use client";

// The per-device UI preferences for the app pages (05-ui-dashboard.md §3.6, §3.9): "Pintasan satu
// tombol" from the potongin_shortcuts cookie. On until the cookie is read after mount (the
// server render does not know the device), which only the closed account menu would show.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { readShortcutPref, writeShortcutPref } from "../../lib/ui-prefs.mjs";

const UiPrefsContext = createContext(null);

export function UiPrefsProvider({ children }) {
  const [shortcuts, setShortcutsState] = useState(true);
  useEffect(() => {
    setShortcutsState(readShortcutPref(document.cookie));
  }, []);
  const setShortcuts = useCallback((on) => {
    setShortcutsState(writeShortcutPref(on));
  }, []);
  const value = useMemo(() => ({ shortcuts, setShortcuts }), [shortcuts, setShortcuts]);
  return <UiPrefsContext value={value}>{children}</UiPrefsContext>;
}

/** [on, setOn] for the single-key shortcuts; outside a provider, on and not writable. */
export function useShortcutPref() {
  const prefs = useContext(UiPrefsContext);
  return prefs ? [prefs.shortcuts, prefs.setShortcuts] : [true, () => {}];
}
