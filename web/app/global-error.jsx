"use client";

import { DM_Sans } from "next/font/google";
import { useEffect, useState } from "react";

import Brand from "../components/Brand.jsx";
import { readLocaleCookie } from "../lib/i18n/cookie.mjs";
import { SOURCE_LOCALE } from "../lib/i18n/locales.mjs";
import sourceErrors from "../messages/id/errors.json";
import "./globals.css";
import "./status-page.css";

// Replaces the root layout when it fails, so it brings its own document, font and a bar with the
// brand only (the sidebar needs the app around it). It cannot ask the server for the language
// (rombak 07 §8.5): the first render is Indonesian from the bundled catalog, then the
// potongin_locale cookie picks another catalog, loaded on demand; if that fails it stays
// Indonesian.
const dmSans = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

const SOURCE = Object.freeze({ code: SOURCE_LOCALE, text: sourceErrors.global });

export default function GlobalError({ reset }) {
  const [view, setView] = useState(SOURCE);
  useEffect(() => {
    const code = readLocaleCookie(document.cookie);
    if (!code || code === SOURCE_LOCALE) return undefined;
    let live = true;
    import(`../messages/${code}/errors.json`)
      .then((loaded) => {
        const global = (loaded.default ?? loaded)?.global;
        if (live && global) setView({ code, text: { ...sourceErrors.global, ...global } });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const { text } = view;
  return (
    <html lang={view.code} className={dmSans.variable} data-theme="dark">
      <body>
        <title>{text.documentTitle}</title>
        <main className="statusPage">
          <header className="statusBar">
            <div className="shell"><Brand /></div>
          </header>
          <section className="statusBody shell" role="alert" aria-labelledby="status-title">
            <h1 id="status-title">{text.title}</h1>
            <p>{text.body}</p>
            <div className="statusActions">
              <button type="button" className="btn primary" onClick={() => reset()}>{text.retry}</button>
              <a className="btn" href="/dashboard">{text.openCreate}</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
