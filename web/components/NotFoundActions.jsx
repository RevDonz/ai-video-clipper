"use client";

import { useEffect, useState } from "react";

import { notFoundLinks } from "../lib/not-found-view.mjs";

// The 404 HTML is prerendered without the requested path, so the first render uses the
// general links (as the server did) and the project link appears once the path is known.
export default function NotFoundActions() {
  const [pathname, setPathname] = useState(null);
  useEffect(() => {
    setPathname(window.location.pathname);
  }, []);
  const links = notFoundLinks(pathname);
  return (
    <div className="statusActions">
      {links.map((link) => (
        <a key={link.href} className={link.primary ? "btn primary" : "btn"} href={link.href}>{link.label}</a>
      ))}
    </div>
  );
}
