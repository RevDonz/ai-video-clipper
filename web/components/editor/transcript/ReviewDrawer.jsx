"use client";

// Rapikan and Ejaan in one drawer (rombak 06 §2.1 T3, §6, §10 #31–#32): a React Aria modal on the
// right edge, over the panel column, so the transcript stays in view with the words Rapikan
// proposes marked. Two tabs, Rapikan (CleanupReview.jsx) and, with the editor's LLM, Ejaan
// (spelling/SpellingReview.jsx); only the open tab's list runs, so Ejaan asks the LLM only when
// it is chosen. Escape, a click beside it and Tutup close it, and focus goes back to the button
// that opened it. React Aria directly, as the Klip drawer (shell/ClipList.jsx): HeroUI's Drawer
// names its close button in English.
import { Button, Dialog, Heading, Modal, ModalOverlay, Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { useTranslations } from "use-intl";

import tokens from "../editor.module.css";
import styles from "./review-drawer.module.css";
import { reviewTabs } from "./transcript-view.mjs";

export default function ReviewDrawer({ tab, onTabChange, onClose, llmEnabled = false, counts = {}, cleanup, spelling }) {
  const t = useTranslations("editor.transcript");
  const tAria = useTranslations("aria");
  const tabs = reviewTabs({ llmEnabled });
  const label = (id) => {
    const count = counts[id] ?? null;
    if (id === "spelling") return count !== null ? t("spellingCount", { count }) : t("spelling");
    return count !== null ? t("cleanupCount", { count }) : t("cleanup");
  };
  // Portalled to <body>, outside the editor root: the overlay carries the editor's size tokens.
  return (
    <ModalOverlay className={`${tokens.tokens} ${styles.backdrop}`} isDismissable isOpen={tab !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal className={styles.panel}>
        <Dialog className={styles.dialog} data-review-drawer="">
          <div className={styles.header}>
            <Heading slot="title" className={styles.title}>{t("review.title")}</Heading>
            <Button className={styles.close} onPress={onClose}>{tAria("close")}</Button>
          </div>
          <Tabs className={styles.tabs} selectedKey={tab ?? tabs[0]} onSelectionChange={(key) => onTabChange(String(key))}>
            <TabList className={styles.tabList} aria-label={t("review.tabsLabel")}>
              {tabs.map((id) => <Tab key={id} id={id} className={styles.tab} data-review-tab={id}>{label(id)}</Tab>)}
            </TabList>
            <TabPanel id="cleanup" className={styles.tabPanel}>{cleanup}</TabPanel>
            {llmEnabled ? <TabPanel id="spelling" className={styles.tabPanel}>{spelling}</TabPanel> : null}
          </Tabs>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
