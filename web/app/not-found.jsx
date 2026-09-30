import AppHeader from "../components/AppHeader.jsx";
import NotFoundActions from "../components/NotFoundActions.jsx";
import "./status-page.css";

export const metadata = {
  title: "Halaman tidak ditemukan",
};

export default function NotFound() {
  return (
    <main className="statusPage">
      <AppHeader />
      <section className="statusBody shell" aria-labelledby="status-title">
        <p className="statusCode">404</p>
        <h1 id="status-title">Halaman tidak ditemukan</h1>
        <p>Alamatnya salah, atau halamannya sudah tidak ada.</p>
        <NotFoundActions />
      </section>
    </main>
  );
}
