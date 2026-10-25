// Above every route, the editor's included: the shell comes through LazyAppShell (see there).
import LazyAppShell from "../components/LazyAppShell.jsx";
import NotFoundActions from "../components/NotFoundActions.jsx";
import { routeMetadata } from "../lib/i18n/server.mjs";
import "./status-page.css";

export async function generateMetadata() {
  return routeMetadata("notFound");
}

export default function NotFound() {
  return (
    <LazyAppShell className="statusPage">
      <section className="statusBody shell" aria-labelledby="status-title">
        <p className="statusCode">404</p>
        <h1 id="status-title">Halaman tidak ditemukan</h1>
        <p>Alamatnya salah, atau halamannya sudah tidak ada.</p>
        <NotFoundActions />
      </section>
    </LazyAppShell>
  );
}
