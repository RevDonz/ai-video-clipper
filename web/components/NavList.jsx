"use client";

// The app's main navigation (05-ui-dashboard.md §4.2): one labelled nav landmark with the list of
// lib/app-nav.mjs, Buat klip first as the strong neutral button. Drawn twice by the shell (the
// sidebar and the Menu drawer), never both at once.
import { useTranslations } from "use-intl";

import { navLinks } from "../lib/app-nav.mjs";
import AppIcon from "./AppIcon.jsx";

// The catalog key of every entry, written out so each t() names its key (tests/i18n-usage).
function useNavLabels() {
  const t = useTranslations("shell");
  return {
    "shell.nav.create": t("nav.create"),
    "shell.nav.projects": t("nav.projects"),
    "shell.nav.social": t("nav.social"),
    "shell.nav.analytics": t("nav.analytics"),
    "shell.nav.trends": t("nav.trends"),
    "shell.nav.settings": t("nav.settings"),
    "shell.nav.admin": t("nav.admin"),
    "shell.nav.help": t("nav.help"),
  };
}

export default function NavList({ current, role, features }) {
  const tAria = useTranslations("aria");
  const labels = useNavLabels();
  const links = navLinks(current, { role, features });
  const [primary, ...rest] = links;
  return (
    <nav className="appNav" aria-label={tAria("mainMenu")}>
      <a className="appCreate" href={primary.href} aria-current={primary.current ? "page" : undefined}>
        <AppIcon name={primary.icon} />
        <span>{labels[primary.labelKey]}</span>
      </a>
      <ul className="appNavList">
        {rest.map((link) => (
          <li key={link.href}>
            <a className="appNavLink" href={link.href} aria-current={link.current ? "page" : undefined}>
              <AppIcon name={link.icon} />
              <span>{labels[link.labelKey]}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
