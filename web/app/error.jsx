"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

import "./status-page.css";

// Above every route, the editor's included: the shell (ui.css, HeroUI) loads only when this renders.
const AppShell = dynamic(() => import("../components/AppShell.jsx"));

// The error itself goes to the server log; the page only offers a way forward.
export default function PageError({ reset }) {
  const pathname = usePathname();
  return (
    <AppShell current={pathname} className="statusPage">
      <section className="statusBody shell" role="alert" aria-labelledby="status-title">
        <h1 id="status-title">Halaman ini gagal dimuat</h1>
        <p>Coba lagi. Kalau tetap gagal, muat ulang halaman atau buka Riwayat.</p>
        <div className="statusActions">
          <button type="button" className="btn primary" onClick={() => reset()}>Coba lagi</button>
          <a className="btn" href="/projects">Buka Riwayat</a>
        </div>
      </section>
    </AppShell>
  );
}