"use client";

// What HeroUI's components need around them on an app page (05-ui-dashboard.md §3.6): React
// Aria's locale (dates, numbers, the reading direction), taken from the root IntlProvider so it
// is the UI language's (rombak 07 §12), the toast region and the per-device UI preferences
// (UiPrefs.jsx). No RouterProvider:
// links stay plain <a href> with full-document navigation (P12), which the editor's COOP/COEP
// headers need. Rendered by AppShell and PublicCard only, never by the root layout, so the
// editor's bundle does not pull React Aria in.
import { I18nProvider } from "react-aria-components";
import { useLocale } from "use-intl";

import { ToastRegion } from "./Toast.jsx";
import { UiPrefsProvider } from "./UiPrefs.jsx";

export default function Providers({ children }) {
  const locale = useLocale();
  return (
    <I18nProvider locale={locale}>
      <UiPrefsProvider>
        {children}
        <ToastRegion />
      </UiPrefsProvider>
    </I18nProvider>
  );
}
