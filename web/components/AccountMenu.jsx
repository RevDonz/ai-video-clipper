"use client";

// The account menu at the foot of the sidebar and of the Menu drawer (05-ui-dashboard.md §4.2):
// the user's initials and name open a menu with "Pintasan satu tombol" (a checked item that
// writes the potongin_shortcuts cookie, WCAG 2.1.4) and Keluar, which submits the shell's hidden
// logout form (onLogout). Akun (/akun) joins in Fase 6.
import { Avatar, Dropdown, Kbd } from "@heroui/react";
import { Text } from "react-aria-components";
import { useTranslations } from "use-intl";

import { APP_SHORTCUTS } from "../lib/app-shortcuts.mjs";
import AppIcon from "./AppIcon.jsx";
import { useShortcutPref } from "./ui/UiPrefs.jsx";

const SHORTCUTS_ITEM = "shortcuts";
const LOGOUT_ITEM = "logout";
const KEYS = Object.fromEntries(APP_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.key]));

export default function AccountMenu({ user, onLogout, placement = "top start" }) {
  const t = useTranslations("shell");
  const [shortcuts, setShortcuts] = useShortcutPref();
  const name = typeof user?.displayName === "string" ? user.displayName : "";
  const label = name ? t("account.named", { name }) : t("account.title");
  const onSelection = (keys) => setShortcuts(keys === "all" || keys.has(SHORTCUTS_ITEM));

  return (
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
          {/* i18n M1 adds the Bahasa section here, first in the menu: a Dropdown.Section with
              selectionMode="single" whose onAction fills the hidden locale form and calls
              requestSubmit() (05 §4.2), shown only when more than one locale is enabled. */}
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
  );
}
