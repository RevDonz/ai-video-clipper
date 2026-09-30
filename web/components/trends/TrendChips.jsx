import styles from "./TrendChips.module.css";

/**
 * "Nyambung tren: <judul>" chips for one clip on the project page. `chips` comes from
 * clipTrendChips(); the caller renders nothing when it is empty. Titles are plain text
 * (React escapes them).
 */
export default function TrendChips({ chips }) {
  if (!Array.isArray(chips) || chips.length === 0) return null;
  return (
    <ul className={styles.trendChips} aria-label="Tren yang disebut di klip ini">
      {chips.map((chip) => (
        <li key={chip.key} title={chip.kindLabel ? `${chip.kindLabel} · disebut di transkrip klip ini` : "Disebut di transkrip klip ini"}>
          {chip.label}
        </li>
      ))}
    </ul>
  );
}
