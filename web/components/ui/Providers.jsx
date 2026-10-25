"use client";

// What HeroUI's components need around them on an app page (05-ui-dashboard.md §3.6): React
// Aria's locale (dates, numbers, the reading direction) and the toast region. No RouterProvider:
// links stay plain <a href> with full-document navigation (P12), which the editor's COOP/COEP
// headers need. Rendered by AppShell and PublicCard only, never by the root layout, so the
// editor's bundle does not pull React Aria in.
import { I18nProvider } from "react-aria-components";

import { ToastRegion } from "./Toast.jsx";

export default function Providers({ locale = "id-ID", children }) {
  return (
    <I18nProvider locale={locale}>
      {children}
      <ToastRegion />
    </I18nProvider>
  );
}
