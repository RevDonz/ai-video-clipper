import { DM_Sans } from "next/font/google";

import I18n from "../lib/i18n/client.jsx";
import { CORE } from "../lib/i18n/catalog.mjs";
import { localeEntry } from "../lib/i18n/locales.mjs";
import { getLocale, getT, providerProps } from "../lib/i18n/server.mjs";
import "./globals.css";

// Downloaded at build time and served from this app; globals.css reads it through --font.
const dmSans = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

export async function generateMetadata() {
  const t = await getT(await getLocale(), "meta");
  return {
    title: { default: t("root.title"), template: t("root.titleTemplate") },
    description: t("root.description"),
  };
}

export const viewport = {
  themeColor: "#080907",
  colorScheme: "dark",
};

// Only the use-intl provider sits at the root (rombak 07 §8.1); segments nest their own with the
// core namespaces plus theirs (components/SegmentI18n.jsx).
export default async function RootLayout({ children }) {
  const i18n = await providerProps(CORE);
  const locale = i18n.locale;
  const entry = localeEntry(locale);
  return (
    <html lang={locale} dir={entry.dir} className={dmSans.variable} data-theme="dark">
      <body><I18n {...i18n}>{children}</I18n></body>
    </html>
  );
}
