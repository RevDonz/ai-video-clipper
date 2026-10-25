"use client";

// What the editor kit's React Aria and HeroUI parts need around them (rombak 06 §16, KA7): React
// Aria's locale, taken from the editor's IntlProvider so dates, numbers and the reading
// direction follow the UI language. The editor's own counterpart of components/ui/Providers.jsx,
// which the editor never imports. No RouterProvider: every link stays a full-document <a href>,
// which the editor's COOP/COEP headers need.
import { I18nProvider } from "react-aria-components";
import { useLocale } from "use-intl";

export default function KitProvider({ children }) {
  const locale = useLocale();
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}
