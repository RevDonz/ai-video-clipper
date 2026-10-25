"use client";

// The app shell for the root 404 and error boundaries. They sit above every route, the editor
// included, and Next ships a boundary's CSS and JS with every page, even through next/dynamic
// (measured on the Fase 1 F0 build: +26 KB CSS and +48 KB JS gzip on the editor). So the page
// first renders its content in a plain <main>, and the shell (with ui.css and HeroUI) is fetched
// by a plain import() once the boundary has really mounted in the browser.
import { useEffect, useState } from "react";

export default function LazyAppShell({ current, className, children }) {
  const [Shell, setShell] = useState(null);
  useEffect(() => {
    let live = true;
    import("./AppShell.jsx").then((module) => {
      if (live) setShell(() => module.default);
    });
    return () => {
      live = false;
    };
  }, []);
  if (Shell) return <Shell current={current} className={className}>{children}</Shell>;
  return <main id="konten" className={className}>{children}</main>;
}
