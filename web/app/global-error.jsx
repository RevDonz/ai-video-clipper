"use client";

import { DM_Sans } from "next/font/google";

import Brand from "../components/Brand.jsx";
import "./globals.css";
import "./status-page.css";

// Replaces the root layout when it fails, so it brings its own document, font and header.
const dmSans = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

export default function GlobalError({ reset }) {
  return (
    <html lang="id" className={dmSans.variable}>
      <body>
        <title>Gagal dimuat · Potongin</title>
        <main className="statusPage">
          <header className="appHeader">
            <div className="appHeaderInner shell"><Brand /></div>
          </header>
          <section className="statusBody shell" role="alert" aria-labelledby="status-title">
            <h1 id="status-title">Potongin gagal dimuat</h1>
            <p>Coba lagi. Kalau tetap gagal, muat ulang halaman.</p>
            <div className="statusActions">
              <button type="button" className="btn primary" onClick={() => reset()}>Coba lagi</button>
              <a className="btn" href="/dashboard">Buka Buat Klip</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
