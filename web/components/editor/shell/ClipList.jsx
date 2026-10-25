"use client";

// The Klip column of the one-layout editor (rombak 06 §3.1, §9): the project's clips in their
// number order on a React Aria GridList, one row each with its number, its duration and "Diubah"
// when it was edited; the open clip is marked. A row opens its clip the way ‹ › does (EditorApp
// saves first). Below 1280 px the column is a 56 px rail whose "Klip" button opens the same list
// in a drawer (React Aria's modal dialog: the page behind is inert, Escape, a tap beside it, Tutup
// or choosing a row closes it, and focus goes back to the button). React Aria directly, not
// HeroUI's Drawer, whose close button carries an English name. Multi-select and Gabungkan come
// with derived clips (F7).
import { useEffect, useMemo, useState } from "react";
import {
  Button, Dialog, DialogTrigger, GridList, GridListItem, Heading, Modal, ModalOverlay,
} from "react-aria-components";
import { useTranslations } from "use-intl";

import { clipEntryView } from "../../../lib/clip-entry-view.mjs";
import tokens from "../editor.module.css";
import styles from "./editor-shell.module.css";

const NARROW = "(max-width: 1279px)";

function useNarrowColumn() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** m:ss of a duration in milliseconds, or null. */
export function clipDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The listing as rows in the project's order (the clip number), with what each row shows. */
export function clipRows(jobId, clips, currentId) {
  const list = Array.isArray(clips) ? clips.filter((clip) => clip && typeof clip === "object") : [];
  const number = (clip) => (Number.isInteger(clip.index) && clip.index >= 1 ? clip.index : Number.POSITIVE_INFINITY);
  return list
    .map((clip, at) => ({ clip, at }))
    .sort((a, b) => number(a.clip) - number(b.clip) || a.at - b.at)
    .map(({ clip }, at) => {
      const view = clipEntryView(jobId, clip);
      return {
        key: view.clipId ?? `row-${at}`,
        index: Number.isInteger(clip.index) ? clip.index : at + 1,
        duration: clipDuration(clip.durationMs),
        edited: clip.edit?.state === "edited",
        current: Boolean(view.clipId) && view.clipId === currentId,
        href: view.editHref,
      };
    });
}

function Rows({ rows, onOpen }) {
  const t = useTranslations("editor.clips");
  const disabled = rows.filter((row) => !row.href).map((row) => row.key);
  return (
    <GridList
      aria-label={t("title")}
      className={styles.clipList}
      items={rows}
      disabledKeys={disabled}
      onAction={(key) => {
        const row = rows.find((item) => item.key === key);
        if (row?.href && !row.current) onOpen(row);
      }}
    >
      {(row) => (
        <GridListItem id={row.key} textValue={t("row", { index: row.index, duration: row.duration ?? "" })}
          className={styles.clipRow} data-current={row.current ? "true" : "false"}>
          <span className={styles.clipNumber}>{t("number", { index: row.index })}</span>
          {row.duration ? <span className={styles.clipDuration}>{row.duration}</span> : null}
          {row.edited ? <span className={styles.clipEdited}>{t("edited")}</span> : null}
          {row.current ? <span className={styles.visuallyHidden}>{t("current")}</span> : null}
        </GridListItem>
      )}
    </GridList>
  );
}

export default function ClipList({ jobId, clips, clipId, onOpen, onDrawerChange }) {
  const t = useTranslations("editor.clips");
  const tAria = useTranslations("aria");
  const narrow = useNarrowColumn();
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => clipRows(jobId, clips, clipId), [jobId, clips, clipId]);
  const changeOpen = (next) => {
    setOpen(next);
    onDrawerChange?.(next);
  };
  // Leaving the narrow layout closes the drawer; the column shows the list itself.
  useEffect(() => {
    if (narrow || !open) return;
    setOpen(false);
    onDrawerChange?.(false);
  }, [narrow, open, onDrawerChange]);

  if (!narrow) {
    return (
      <>
        <h2 className={styles.clipsHead}>
          <span>{t("title")}</span>
          <span>{rows.length}</span>
        </h2>
        <Rows rows={rows} onOpen={onOpen} />
      </>
    );
  }
  return (
    <div className={styles.clipRail}>
      <DialogTrigger isOpen={open} onOpenChange={changeOpen}>
        <Button className={styles.clipRailButton}>{t("open")}</Button>
        {/* Portalled to <body>, outside the editor root: it carries the editor's size tokens itself. */}
        <ModalOverlay className={`${tokens.tokens} ${styles.drawerBackdrop}`} isDismissable>
          <Modal className={styles.drawerPanel}>
            <Dialog className={styles.drawerDialog}>
              {({ close }) => (
                <>
                  <div className={styles.drawerHeader}>
                    <Heading slot="title" className={styles.drawerTitle}>{t("title")}</Heading>
                    <Button className={styles.drawerClose} onPress={close}>{tAria("close")}</Button>
                  </div>
                  <div className={styles.drawerBody}>
                    <Rows rows={rows} onOpen={(row) => { close(); onOpen(row); }} />
                  </div>
                </>
              )}
            </Dialog>
          </Modal>
        </ModalOverlay>
      </DialogTrigger>
    </div>
  );
}
