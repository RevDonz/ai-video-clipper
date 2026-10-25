"use client";

// The account menu at the foot of the sidebar and of the Menu drawer (05-ui-dashboard.md §4.2):
// the user's initials and name open a menu with Bahasa (when more than one UI language is on:
// picking one submits the hidden language form, 07 §9.1, so it takes two clicks and a reload),
// "Pintasan satu tombol" (a checked item that writes the potongin_shortcuts cookie, WCAG 2.1.4)
// and Keluar, which submits the shell's hidden logout form (onLogout). Akun (/akun) joins in
// Fase 6.
import { Avatar, Dropdown, Kbd } from "@heroui/react";
import { useRef } from "react";
import { Header, Text } from "react-aria-components";
import { useLocale, useTranslations } from "use-intl";

import { APP_SHORTCUTS } from "../lib/app-shortcuts.mjs";
import { localeOfIntl } from "../lib/i18n/locales.mjs";
import AppIcon from "./AppIcon.jsx";
import { LanguageMenuForm } from "./LanguageSwitcher.jsx";
import { useShortcutPref } from "./ui/UiPrefs.jsx";

const SHORTCUTS_ITEM = "shortcuts";
const LOGOUT_ITEM = "logout";
const LOCALE_PREFIX = "locale-";
const KEYS = Object.fromEntries(APP_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.key]));

const localeKey = (code) => `${LOCALE_PREFIX}${code}`;

export default function AccountMenu({ user, locales, onLogout, placement = "top start" }) {
  const t = useTranslations("shell");
  const current = localeOfIntl(useLocale());
  const [shortcuts, setShortcuts] = useShortcutPref();
  const languageFormRef = useRef(null);
  const name = typeof user?.displayName === "string" ? user.displayName : "";
  const label = name ? t("account.named", { name }) : t("account.title");
  const choosable = Array.isArray(locales) && locales.length > 1;
  const onSelection = (keys) => setShortcuts(keys === "all" || keys.has(SHORTCUTS_ITEM));
  const onLanguage = (keys) => {
    const [key] = keys === "all" ? [] : [...keys];
    const code = typeof key === "string" && key.startsWith(LOCALE_PREFIX) ? key.slice(LOCALE_PREFIX.length) : null;
    if (code && code !== current && locales.some((entry) => entry.code === code)) languageFormRef.current?.submit(code);
  };

  return (
    <>
      <Dropdown>
        <Dropdown.Trigger className="appAccount" aria-label={label}>
          <Avatar size="sm" className="appAvatar" aria-hidden="true">
            <Avatar.Fallback>{user?.initials ? user.initials : <AppIcon name="account" size={16} />}</Avatar.Fallback>
          </Avatar>
          <span className="appAccountName">{name || t("account.title")}</span>
          <AppIcon name="chevron" size={16} className="appAccountChevron" />
        </Dropdown.Trigger>
        <Dropdown.Popover placement={placement} className="appAccountMenu">
          <Dropdown.Menu aria-label={t("account.title")} onAction={(key) => { if (key === LOGOUT_ITEM) onLogout?.(); }}>
            {choosable && (
              <Dropdown.Section
                aria-label={t("account.language")}
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[localeKey(current)]}
                onSelectionChange={onLanguage}
              >
                <Header className="appAccountHeading">{t("account.language")}</Header>
                {locales.map((entry) => (
                  <Dropdown.Item key={entry.code} id={localeKey(entry.code)} textValue={entry.label} className="appAccountItem">
                    <Text slot="label" lang={entry.code}>{entry.label}</Text>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            )}
            <Dropdown.Section
              selectionMode="multiple"
              selectedKeys={shortcuts ? [SHORTCUTS_ITEM] : []}
              onSelectionChange={onSelection}
            >
              <Dropdown.Item id={SHORTCUTS_ITEM} textValue={t("account.shortcuts")} className="appAccountItem">
                <span className="appAccountItemText">
                  <Text slot="label">{t("account.shortcuts")}</Text>
                  <Text slot="description" className="appAccountKeys">
                    <Kbd>{KEYS.create}</Kbd> {t("nav.create")} · <Kbd>{KEYS.search}</Kbd> {t("account.search")}
                  </Text>
                </span>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            </Dropdown.Section>
            <Dropdown.Section>
              <Dropdown.Item id={LOGOUT_ITEM} variant="danger" textValue={t("account.logout")} className="appAccountItem">
                <AppIcon name="logout" size={18} />
                <Text slot="label">{t("account.logout")}</Text>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {choosable && <LanguageMenuForm ref={languageFormRef} />}
    </>
  );
}
