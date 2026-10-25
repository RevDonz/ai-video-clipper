"use client";

// Pengaturan (05-ui-dashboard.md §6.10): five tabs kept in step with the hash (#ai, #transkripsi,
// #tampilan, #youtube, #sistem: the ids of the sections they replaced, so old links still land on
// the right tab), every panel kept mounted so a draft survives a tab switch, and one save bar for
// all of them (SettingsSave.jsx). A tab with unsaved changes carries a dot.
import { Description, Kbd, Switch } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";

import AppShell from "../../components/AppShell.jsx";
import PageHead from "../../components/ui/PageHead.jsx";
import Tabs from "../../components/ui/Tabs.jsx";
import { useShortcutPref } from "../../components/ui/UiPrefs.jsx";
import { APP_SHORTCUTS } from "../../lib/app-shortcuts.mjs";
import { SETTINGS_TABS, hashForTab, tabFromHash } from "../../lib/settings-tabs.mjs";
import AiSettings from "./AiSettings.jsx";
import DefaultLogoCard from "./DefaultLogoCard.jsx";
import DefaultWatermarkCard from "./DefaultWatermarkCard.jsx";
import { SettingsSaveProvider, useDirtyTabs } from "./SettingsSave.jsx";
import SystemCard from "./SystemCard.jsx";
import TranscriptionCard from "./TranscriptionCard.jsx";
import YoutubeCookiesCard from "./YoutubeCookiesCard.jsx";
import "./settings.css";

const KEYS = Object.fromEntries(APP_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.key]));

// "Pintasan satu tombol": the same preference (cookie potongin_shortcuts) as the account menu.
function ShortcutSwitch() {
  const tShell = useTranslations("shell");
  const [on, setOn] = useShortcutPref();
  return (
    <section className="settingsCard" aria-label={tShell("account.shortcuts")}>
      <Switch isSelected={on} onChange={setOn} className="settingsSwitch">
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          {tShell("account.shortcuts")}
        </Switch.Content>
        <Description className="settingsKeys">
          <Kbd>{KEYS.create}</Kbd> {tShell("nav.create")} · <Kbd>{KEYS.search}</Kbd> {tShell("account.search")}
        </Description>
      </Switch>
    </section>
  );
}

function SettingsTabs({ tab, onSelect }) {
  const t = useTranslations("settings");
  const dirty = useDirtyTabs();
  const labels = {
    ai: t("tab.ai"),
    transkripsi: t("tab.transcription"),
    tampilan: t("tab.appearance"),
    youtube: t("tab.youtube"),
    sistem: t("tab.system"),
  };
  return (
    <Tabs selectedKey={tab} onSelectionChange={onSelect} className="settingsTabs">
      <Tabs.List aria-label={t("title")} className="settingsTabList">
        {SETTINGS_TABS.map((id) => (
          <Tabs.Tab key={id} id={id} aria-label={dirty.has(id) ? t("unsavedTab", { tab: labels[id] }) : undefined}>
            {labels[id]}
            {dirty.has(id) && <span className="settingsTabDot" aria-hidden="true">●</span>}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel id="ai" shouldForceMount className="settingsPanel">
        <AiSettings />
      </Tabs.Panel>
      <Tabs.Panel id="transkripsi" shouldForceMount className="settingsPanel">
        <TranscriptionCard />
      </Tabs.Panel>
      <Tabs.Panel id="tampilan" shouldForceMount className="settingsPanel">
        <DefaultLogoCard />
        <DefaultWatermarkCard />
        <ShortcutSwitch />
      </Tabs.Panel>
      <Tabs.Panel id="youtube" shouldForceMount className="settingsPanel">
        <YoutubeCookiesCard />
      </Tabs.Panel>
      <Tabs.Panel id="sistem" shouldForceMount className="settingsPanel">
        <SystemCard />
        <p className="settingsLinks">
          <a className="settingsLink" href="/licenses">{t("system.licenses")}</a>
        </p>
      </Tabs.Panel>
    </Tabs>
  );
}

function SettingsBody() {
  const t = useTranslations("settings");
  const [tab, setTab] = useState(SETTINGS_TABS[0]);

  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const select = useCallback((key) => {
    const id = tabFromHash(String(key));
    setTab(id);
    const hash = hashForTab(id);
    if (hash && window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
  }, []);

  return (
    <SettingsSaveProvider onShowTab={select}>
      <div className="shell settingsShell">
        <PageHead title={t("title")} />
        <SettingsTabs tab={tab} onSelect={select} />
      </div>
    </SettingsSaveProvider>
  );
}

export default function SettingsPage() {
  return (
    <AppShell current="/settings" className="settingsPage">
      <SettingsBody />
    </AppShell>
  );
}
