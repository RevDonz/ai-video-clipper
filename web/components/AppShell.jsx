"use client";

// The frame of every signed-in page: a sidebar (brand, job badge, Buat klip, the work pages, the
// system pages, Keluar) beside the page's <main>. Below 1024 px the sidebar folds into a top bar
// whose "Menu" button opens it as a drawer (lib/app-menu.mjs): Escape, Tutup or a tap on the
// dimmed page closes it and focus goes back to the button; the page behind it is inert meanwhile.
// It also brings the UI kit (app/ui.css and components/ui/Providers.jsx) to every signed-in page.
import { useEffect, useRef, useState } from "react";

import "../app/ui.css";

import { INITIAL_MENU, MENU_QUERY, menuButtonView, menuReducer } from "../lib/app-menu.mjs";
import { navGroups } from "../lib/app-nav.mjs";
import AppIcon from "./AppIcon.jsx";
import Brand from "./Brand.jsx";
import JobBadge from "./JobBadge.jsx";
import Providers from "./ui/Providers.jsx";

export default function AppShell({ current, className, children }) {
  const [menu, setMenu] = useState(INITIAL_MENU);
  const toggleRef = useRef(null);
  const menuRef = useRef(null);
  const dispatch = (event) => setMenu((state) => menuReducer(state, event));
  const { primary, groups } = navGroups(current);
  const button = menuButtonView(menu);

  useEffect(() => {
    if (!menu.open) return undefined;
    menuRef.current?.querySelector("a[href], button")?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "escape" });
      }
    };
    // Past the breakpoint the sidebar is always shown and the button is gone.
    const media = window.matchMedia(MENU_QUERY);
    const onMedia = (event) => {
      if (!event.matches) dispatch({ type: "wide" });
    };
    document.addEventListener("keydown", onKey);
    media.addEventListener("change", onMedia);
    return () => {
      document.removeEventListener("keydown", onKey);
      media.removeEventListener("change", onMedia);
    };
  }, [menu.open]);

  useEffect(() => {
    if (!menu.open && menu.returnFocus) toggleRef.current?.focus();
  }, [menu]);

  const followed = () => dispatch({ type: "navigate" });

  return (
    <Providers>
      <div className="appFrame" data-menu-open={menu.open ? "" : undefined}>
        <a className="skipLink" href="#konten">Langsung ke isi</a>
        <header className="appSide">
          <div className="appBar">
            <Brand />
            <JobBadge />
            <button
              ref={toggleRef}
              type="button"
              className="appMenuToggle"
              aria-expanded={button.expanded}
              aria-controls="app-menu"
              onClick={() => dispatch({ type: "toggle" })}
            >
              <AppIcon name={button.icon} />
              <span>{button.label}</span>
            </button>
          </div>
          <div id="app-menu" ref={menuRef} className="appMenu">
            <nav className="appNav" aria-label="Menu utama">
              <a className="appCreate" href={primary.href} aria-current={primary.current ? "page" : undefined} onClick={followed}>
                <AppIcon name={primary.icon} />
                <span>{primary.label}</span>
              </a>
              {groups.map((group) => (
                <div key={group.id} className="appNavGroup">
                  <p id={`app-nav-${group.id}`} className="appNavLabel">{group.label}</p>
                  <ul aria-labelledby={`app-nav-${group.id}`}>
                    {group.links.map((entry) => (
                      <li key={entry.href}>
                        <a className="appNavLink" href={entry.href} aria-current={entry.current ? "page" : undefined} onClick={followed}>
                          <AppIcon name={entry.icon} />
                          <span>{entry.label}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <form className="appLogout" method="post" action="/api/auth/logout">
              <button type="submit">
                <AppIcon name="logout" />
                <span>Keluar</span>
              </button>
            </form>
          </div>
        </header>
        <div className="appScrim" aria-hidden="true" onClick={() => dispatch({ type: "close" })} />
        <main id="konten" className={className} inert={menu.open || undefined}>{children}</main>
      </div>
    </Providers>
  );
}
