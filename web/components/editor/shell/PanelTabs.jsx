"use client";

// The right-hand panel of the one-layout editor (rombak 06 §2.1 T1, §8): five tabs, Teks · Tata
// letak · Audio · Logo · Cold open, and only the chosen tab's panel in the DOM, so exactly one tab
// panel is ever visible. ← → move and choose, Home and End go to the ends; a click on the open tab
// keeps it open. React Aria's Tabs directly: HeroUI's tab list adds scroll buttons named in
// English that no prop renames, and five short tabs fit the panel. Panels load lazily from
// panels/index.mjs and get the editor's one props bundle.
import { Suspense, lazy } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { useTranslations } from "use-intl";

import { SHELL_TABS } from "../panels/index.mjs";
import styles from "./editor-shell.module.css";

const loaded = new Map();

function lazyPanel(entry) {
  if (!loaded.has(entry.file)) loaded.set(entry.file, lazy(entry.load));
  return loaded.get(entry.file);
}

/** The tab names, one literal key each (the catalog guard needs literal keys). */
function useTabLabels() {
  const tTab = useTranslations("editor.shell.tabs");
  return { text: tTab("text"), layout: tTab("layout"), audio: tTab("audio"), logo: tTab("logo"), coldopen: tTab("coldOpen") };
}

export default function PanelTabs({ value, onChange, panelProps }) {
  const t = useTranslations("editor.shell");
  const labels = useTabLabels();
  const selected = SHELL_TABS.some((entry) => entry.id === value) ? value : SHELL_TABS[0].id;
  return (
    <Tabs className={styles.tabs} selectedKey={selected} onSelectionChange={(key) => { if (key !== selected) onChange(String(key)); }}>
      <TabList aria-label={t("tabsLabel")} className={styles.tabList}>
        {SHELL_TABS.map((entry) => (
          <Tab key={entry.id} id={entry.id} className={styles.tab} data-tab={entry.id}>{labels[entry.id]}</Tab>
        ))}
      </TabList>
      {SHELL_TABS.map((entry) => {
        const Panel = lazyPanel(entry);
        return (
          <TabPanel key={entry.id} id={entry.id} className={styles.tabPanel} data-panel={entry.id}>
            {/* The tab's name as the level-2 heading its sections (h3) sit under (QG-A11Y heading order). */}
            <h2 className={styles.visuallyHidden}>{labels[entry.id]}</h2>
            <Suspense fallback={<p className={styles.muted}>{t("openingPanel")}</p>}>
              <Panel {...panelProps} />
            </Suspense>
          </TabPanel>
        );
      })}
    </Tabs>
  );
}
