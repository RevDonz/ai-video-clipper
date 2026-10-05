"use client";

// The body of a card its task has not built yet (Z0 scaffold): it says so and opens the panel
// that does the same work in Mode Lengkap. Each card file replaces it.
import PillButton from "../ui/PillButton.jsx";
import styles from "./quick.module.css";

export default function CardPlaceholder({ panel, showLengkap }) {
  return (
    <div className={styles.placeholder} data-card-placeholder="">
      <p className={styles.note}>Kartu ini belum tersedia di Mode Cepat.</p>
      <PillButton onClick={() => showLengkap?.(panel)} disabled={typeof showLengkap !== "function"}>
        Atur di Mode Lengkap
      </PillButton>
    </div>
  );
}
