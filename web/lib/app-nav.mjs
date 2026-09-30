// Destinations of the shared header (components/AppHeader.jsx), in display order.
export const APP_LINKS = Object.freeze([
  Object.freeze({ href: "/dashboard", label: "Buat Klip" }),
  Object.freeze({ href: "/projects", label: "Riwayat" }),
  Object.freeze({ href: "/trends", label: "Konteks Tren" }),
  Object.freeze({ href: "/settings", label: "Pengaturan" }),
]);

// A page under a destination (/projects/<id>) keeps that destination marked as current.
export function navItems(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  return APP_LINKS.map((link) => ({
    ...link,
    current: path === link.href || path.startsWith(`${link.href}/`),
  }));
}
