"use client";

// The frame of every signed-in page (05-ui-dashboard.md §4.2, §6.1): a sidebar (brand, job
// badge, the flat NavList, the account menu) beside the page's <main>. Below 1024 px the sidebar
// folds into a top bar whose "Menu" button opens the same list in a Drawer: Escape, Tutup or a
// tap beside it closes it and focus goes back to Menu (React Aria), and the page behind it is
// inert meanwhile. Keluar submits the hidden logout form. N and / are the app's single-key
// shortcuts (lib/app-shortcuts.mjs), off when "Pintasan satu tombol" is off. It also brings the
// UI kit (app/ui.css and components/ui/Providers.jsx) to every signed-in page.
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import "../app/ui.css";
import "./app-shell.css";

import { MENU_QUERY } from "../lib/app-menu.mjs";
import { APP_SHORTCUTS, PAGE_SEARCH_SELECTOR, appShortcut, overlayOpenIn } from "../lib/app-shortcuts.mjs";
import AccountMenu from "./AccountMenu.jsx";
import AppIcon from "./AppIcon.jsx";
import Brand from "./Brand.jsx";
import JobBadge from "./JobBadge.jsx";
import NavList from "./NavList.jsx";
import { useShellData } from "./ShellData.jsx";
import Drawer from "./ui/Drawer.jsx";
import Providers from "./ui/Providers.jsx";
import { useShortcutPref } from "./ui/UiPrefs.jsx";

const CREATE_HREF = APP_SHORTCUTS.find((shortcut) => shortcut.id === "create").href;

function useAppShortcuts() {
  const [shortcuts] = useShortcutPref();
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  useEffect(() => {
    const onKey = (event) => {
      const id = appShortcut(event, { enabled: shortcutsRef.current, overlayOpen: overlayOpenIn(document) });
      if (id === "create" && window.location.pathname !== CREATE_HREF) {
        event.preventDefault();
        window.location.assign(CREATE_HREF);
      } else if (id === "search") {
        const field = document.querySelector(PAGE_SEARCH_SELECTOR);
        if (!field) return;
        event.preventDefault();
        field.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

function Frame({ current, className, user, features, locales, children }) {
  const t = useTranslations("shell");
  const tAria = useTranslations("aria");
  const [open, setOpen] = useState(false);
  const logoutFormRef = useRef(null);
  useAppShortcuts();

  // Past the breakpoint the sidebar is always shown and the Menu button is gone.
  useEffect(() => {
    if (!open) return undefined;
    const media = window.matchMedia(MENU_QUERY);
    const onMedia = (event) => {
      if (!event.matches) setOpen(false);
    };
    media.addEventListener("change", onMedia);
    return () => media.removeEventListener("change", onMedia);
  }, [open]);

  const logout = () => logoutFormRef.current?.requestSubmit();
  const role = user?.role ?? "admin";

  return (
    <div className="appFrame">
      <a className="skipLink" href="#konten">{t("skip")}</a>
      <header className="appSide">
        <div className="appBar">
          <Brand />
          <JobBadge />
          <Drawer isOpen={open} onOpenChange={setOpen}>
            <Drawer.Trigger className="appMenuToggle">
              <AppIcon name="menu" />
              <span>{t("menu")}</span>
            </Drawer.Trigger>
            <Drawer.Backdrop className="appDrawerBackdrop">
              <Drawer.Content placement="left" className="appDrawerContent">
                <Drawer.Dialog className="appDrawer">
                  <Drawer.Header className="appDrawerHead">
                    <Drawer.Heading className="appDrawerTitle">{t("menu")}</Drawer.Heading>
                  </Drawer.Header>
                  <Drawer.Body className="appDrawerBody">
                    <NavList current={current} role={role} features={features} />
                    <AccountMenu user={user} locales={locales} onLogout={logout} placement="top" />
                  </Drawer.Body>
                  <Drawer.CloseTrigger className="appDrawerClose" aria-label={tAria("close")} />
                </Drawer.Dialog>
              </Drawer.Content>
            </Drawer.Backdrop>
          </Drawer>
        </div>
        {!open && (
          <div className="appSideBody">
            <NavList current={current} role={role} features={features} />
            <AccountMenu user={user} locales={locales} onLogout={logout} />
          </div>
        )}
      </header>
      <form ref={logoutFormRef} method="post" action="/api/auth/logout" hidden />
      <main id="konten" className={className} inert={open || undefined}>{children}</main>
    </div>
  );
}

export default function AppShell({ current, className, user, features, locales, children }) {
  const data = useShellData();
  return (
    <Providers>
      <Frame
        current={current}
        className={className}
        user={user ?? data?.user}
        features={features ?? data?.features ?? {}}
        locales={locales ?? data?.locales ?? []}
      >
        {children}
      </Frame>
    </Providers>
  );
}
