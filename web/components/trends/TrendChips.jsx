"use client";

import { useTranslations } from "use-intl";

import styles from "./TrendChips.module.css";

/**
 * "Nyambung tren: <judul>" chips for one clip on the project page. `chips` comes from
 * clipTrendChips(); the caller renders nothing when it is empty. Titles are plain text
 * (React escapes them).
 */
export default function TrendChips({ chips }) {
  const t = useTranslations("project");
  if (!Array.isArray(chips) || chips.length === 0) return null;
  return (
    <ul className={styles.trendChips} aria-label={t("trendChips.label")}>
      {chips.map((chip) => (
        <li key={chip.key} title={chip.kindLabel ? t("trendChips.kind", { kind: chip.kindLabel }) : t("trendChips.plain")}>
          {chip.label}
        </li>
      ))}
    </ul>
  );
}
