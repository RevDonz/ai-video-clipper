import dynamic from "next/dynamic";

import NotFoundActions from "../components/NotFoundActions.jsx";
import "./status-page.css";

// Above every route, the editor's included: the shell (ui.css, HeroUI) loads only when this renders.
const AppShell = dynamic(() => import("../components/AppShell.jsx"));

export const metadata = {
  title: "Halaman tidak ditemukan",
};

export default function NotFound() {
  return (
    <AppShell className="statusPage">
      <section className="statusBody shell" aria-labelledby="status-title">
        <p className="statusCode">404</p>
        <h1 id="status-title">Halaman tidak ditemukan</h1>
        <p>Alamatnya salah, atau halamannya sudah tidak ada.</p>
        <NotFoundActions />
      </section>
    </AppShell>
  );
}