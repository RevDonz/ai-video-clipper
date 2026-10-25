"use client";

import { useTranslations } from "use-intl";

import { msg } from "../../lib/i18n/descriptor.mjs";

import styles from "./TrendChips.module.css";

/**
 * "Nyambung tren: <judul>" chips for one clip on the project page. `chips` comes from
 * clipTrendChips(), whose label and kind name are descriptors; the caller renders nothing when it
 * is empty. Titles are plain text (React escapes them).
 */
export default function TrendChips({ chips }) {
  const t = useTranslations("project");
  const tAll = useTranslations();
  if (!Array.isArray(chips) || chips.length === 0) return null;
  return (
    <ul className={styles.trendChips} aria-label={t("trendChips.label")}>
      {chips.map((chip) => (
        <li key={chip.key} title={chip.kindLabel ? t("trendChips.kind", { kind: msg(tAll, chip.kindLabel) }) : t("trendChips.plain")}>
          {msg(tAll, chip.label)}
        </li>
      ))}
    </ul>
  );
}
