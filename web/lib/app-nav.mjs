// The app sidebar (components/NavList.jsx, 05-ui-dashboard.md §4.1): one flat list in display
// order, Buat klip first. An entry with a role shows only for that role, one with a feature only
// when features[feature] is true (lib/ui-features.mjs). Labels are catalog keys (messages/*/shell.json).

const link = (fields) => Object.freeze(fields);

export const NAV_LINKS = Object.freeze([
  link({ href: "/dashboard", labelKey: "shell.nav.create", icon: "create", primary: true }),
  link({ href: "/projects", labelKey: "shell.nav.projects", icon: "projects" }),
  link({ href: "/sosial", labelKey: "shell.nav.social", icon: "social", feature: "social" }),
  link({ href: "/analitik", labelKey: "shell.nav.analytics", icon: "analytics", feature: "analytics" }),
  link({ href: "/trends", labelKey: "shell.nav.trends", icon: "trends" }),
  link({ href: "/settings", labelKey: "shell.nav.settings", icon: "settings" }),
  link({ href: "/admin/pengguna", labelKey: "shell.nav.admin", icon: "admin", role: "admin", feature: "admin", match: "/admin" }),
  link({ href: "/bantuan", labelKey: "shell.nav.help", icon: "help" }),
]);

// A page under a destination (/projects/<id>) keeps that destination marked as current.
function isCurrent(path, base) {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The entries the user sees, each with `current`. Before the user database the env login is the
 * admin, hence the default role.
 */
export function navLinks(pathname, { role = "admin", features = {} } = {}) {
  const path = typeof pathname === "string" ? pathname : "";
  return NAV_LINKS
    .filter((entry) => (!entry.role || entry.role === role) && (!entry.feature || features?.[entry.feature] === true))
    .map((entry) => ({
      href: entry.href,
      labelKey: entry.labelKey,
      icon: entry.icon,
      ...(entry.primary ? { primary: true } : {}),
      current: isCurrent(path, entry.match ?? entry.href),
    }));
}
