"use client";

import { usePathname } from "next/navigation";

import AppHeader from "../components/AppHeader.jsx";
import "./status-page.css";

// The error itself goes to the server log; the page only offers a way forward.
export default function PageError({ reset }) {
  const pathname = usePathname();
  return (
    <main className="statusPage">
      <AppHeader current={pathname} />
      <section className="statusBody shell" role="alert" aria-labelledby="status-title">
        <h1 id="status-title">Halaman ini gagal dimuat</h1>
        <p>Coba lagi. Kalau tetap gagal, muat ulang halaman atau buka Riwayat.</p>
        <div className="statusActions">
          <button type="button" className="btn primary" onClick={() => reset()}>Coba lagi</button>
          <a className="btn" href="/projects">Buka Riwayat</a>
        </div>
      </section>
    </main>
  );
}
