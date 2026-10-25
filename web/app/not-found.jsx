// Above every route, the editor's included: the shell comes through LazyAppShell (see there).
import LazyAppShell from "../components/LazyAppShell.jsx";
import NotFoundActions from "../components/NotFoundActions.jsx";
import { getLocale, getT, routeMetadata } from "../lib/i18n/server.mjs";
import "./status-page.css";

export async function generateMetadata() {
  return routeMetadata("notFound");
}

export default async function NotFound() {
  const locale = await getLocale();
  const t = await getT(locale, "errors");
  const tCommon = await getT(locale, "common");
  return (
    <LazyAppShell className="statusPage">
      <section className="statusBody shell" aria-labelledby="status-title">
        <p className="statusCode">404</p>
        <h1 id="status-title">{t("http.s404")}</h1>
        <p>{tCommon("page.notFoundBody")}</p>
        <NotFoundActions />
      </section>
    </LazyAppShell>
  );
}
