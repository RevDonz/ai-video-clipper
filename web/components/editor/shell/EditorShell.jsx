"use client";

// The one-layout editor's frame (rombak 06 §3): the top bar, the Klip column, the stage with its
// transport, the transcript, one panel on the right and the folded Linimasa detail, in one grid
// whose areas move per breakpoint (editor-shell.module.css). It only places what EditorApp hands
// it; the store, the player and the dialogs stay there. The children keep this order, so Tab goes
// top bar, clips, stage, transcript, panel, timeline.
import { useTranslations } from "use-intl";

import tokens from "../editor.module.css";
import styles from "./editor-shell.module.css";

export default function EditorShell({ topBar, clips, stage, transcript, panel, timeline, children, rootProps = {} }) {
  const t = useTranslations("editor");
  return (
    <div className={`${tokens.tokens} ${styles.shell}`} data-editor-root="" data-editor-shell="v2" {...rootProps}>
      {topBar}
      <aside className={styles.clips} data-slot="clips" aria-label={t("clips.title")}>{clips}</aside>
      <main className={styles.stage} data-slot="stage">{stage}</main>
      <section className={styles.transcript} data-slot="transcript" aria-label={t("shell.transcript")}>{transcript}</section>
      <aside className={styles.panel} data-slot="panel" aria-label={t("shell.tabsLabel")}>{panel}</aside>
      <div className={styles.timeline} data-slot="timeline-detail">{timeline}</div>
      {children}
    </div>
  );
}
