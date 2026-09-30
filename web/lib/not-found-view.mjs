// Where the 404 page (app/not-found.jsx) sends the user. Client-safe: no Node built-ins.

const PROJECT_CHILD = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/./i;

/**
 * The links under "Halaman tidak ditemukan", the first one primary. A missing page below a
 * project (an old bookmark to a page that no longer exists) leads back to that project.
 */
export function notFoundLinks(pathname) {
  const project = typeof pathname === "string" ? PROJECT_CHILD.exec(pathname) : null;
  if (project) {
    return [
      { href: `/projects/${project[1]}`, label: "Buka proyek ini", primary: true },
      { href: "/projects", label: "Buka Riwayat", primary: false },
    ];
  }
  return [
    { href: "/projects", label: "Buka Riwayat", primary: true },
    { href: "/dashboard", label: "Buat klip", primary: false },
  ];
}
