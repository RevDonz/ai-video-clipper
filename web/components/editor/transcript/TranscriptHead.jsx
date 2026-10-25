"use client";

// The head of the one-layout editor's transcript (rombak 06 §6, §3.2): its name, Kata | Baris (a
// React Aria ToggleButtonGroup, one view always chosen), and Rapikan n and Ejaan n, which open the
// one review drawer (ReviewDrawer.jsx) on their tab. Ejaan shows only with the editor's LLM.
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { useTranslations } from "use-intl";

import { COPY as SPELLING_COPY } from "../spelling/model.mjs";
import styles from "./transcript-head.module.css";
import { transcriptMode } from "./transcript-view.mjs";

export default function TranscriptHead({ mode, onModeChange, cleanupCount = null, spellingCount = null, llmEnabled = false, reviewTab = null, onOpenReview }) {
  const t = useTranslations("editor");
  return (
    <div className={styles.head}>
      <h2 className={styles.title}>{t("shell.transcript")}</h2>
      <ToggleButtonGroup
        className={styles.modes}
        aria-label={t("transcript.modeLabel")}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[transcriptMode(mode)]}
        onSelectionChange={(keys) => {
          const [next] = [...keys];
          if (next !== undefined) onModeChange?.(transcriptMode(String(next)));
        }}
      >
        <ToggleButton id="words" className={styles.mode}>{t("transcript.modes.words")}</ToggleButton>
        <ToggleButton id="lines" className={styles.mode}>{t("transcript.modes.lines")}</ToggleButton>
      </ToggleButtonGroup>
      <span className={styles.tools}>
        <button type="button" className={styles.tool} aria-haspopup="dialog" aria-expanded={reviewTab === "cleanup"}
          data-cleanup-toggle="" title={t("transcript.cleanupHint")} onClick={() => onOpenReview?.("cleanup")}>
          {cleanupCount !== null ? t("transcript.cleanupCount", { count: cleanupCount }) : t("transcript.cleanup")}
        </button>
        {llmEnabled ? (
          <button type="button" className={styles.tool} aria-haspopup="dialog" aria-expanded={reviewTab === "spelling"}
            data-spelling-toggle="" title={SPELLING_COPY.toggleTitle} onClick={() => onOpenReview?.("spelling")}>
            {spellingCount !== null ? t("transcript.spellingCount", { count: spellingCount }) : t("transcript.spelling")}
          </button>
        ) : null}
      </span>
    </div>
  );
}
