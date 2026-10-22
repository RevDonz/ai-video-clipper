// Destinations of the app sidebar (components/AppShell.jsx), in display order: the one action
// that starts work, then the pages for the results and the inputs, then the system pages.
const link = (href, label, icon) => Object.freeze({ href, label, icon });

export const PRIMARY_LINK = link("/dashboard", "Buat klip", "create");

export const NAV_GROUPS = Object.freeze([
  Object.freeze({ id: "kerja", label: "Kerja", links: Object.freeze([
    link("/projects", "Riwayat", "history"),
    link("/trends", "Konteks Tren", "trends"),
  ]) }),
  Object.freeze({ id: "sistem", label: "Sistem", links: Object.freeze([
    link("/settings", "Pengaturan", "settings"),
    link("/bantuan", "Bantuan", "help"),
  ]) }),
]);

export const APP_LINKS = Object.freeze([PRIMARY_LINK, ...NAV_GROUPS.flatMap((group) => group.links)]);

// A page under a destination (/projects/<id>) keeps that destination marked as current.
function isCurrent(path, href) {
  return path === href || path.startsWith(`${href}/`);
}

export function navItems(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  return APP_LINKS.map((entry) => ({ ...entry, current: isCurrent(path, entry.href) }));
}

/** The sidebar as drawn: the primary link and the groups, each link marked current or not. */
export function navGroups(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  const mark = (entry) => ({ ...entry, current: isCurrent(path, entry.href) });
  return {
    primary: mark(PRIMARY_LINK),
    groups: NAV_GROUPS.map((group) => ({ id: group.id, label: group.label, links: group.links.map(mark) })),
  };
}
