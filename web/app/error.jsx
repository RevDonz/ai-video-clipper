"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "use-intl";

import LazyAppShell from "../components/LazyAppShell.jsx";
import "./status-page.css";

// Above every route, the editor's included: the shell comes through LazyAppShell (see there).
// The error itself goes to the server log; the page only offers a way forward. The words come
// from the root provider's core namespaces (common, errors.http), in the UI language.
export default function PageError({ reset }) {
  const pathname = usePathname();
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  return (
    <LazyAppShell current={pathname} className="statusPage">
      <section className="statusBody shell" role="alert" aria-labelledby="status-title">
        <h1 id="status-title">{tErrors("http.s500")}</h1>
        <p>{tCommon("page.failedBody")}</p>
        <div className="statusActions">
          <button type="button" className="btn primary" onClick={() => reset()}>{tCommon("retry")}</button>
          <a className="btn" href="/projects">{tCommon("page.openProjects")}</a>
        </div>
      </section>
    </LazyAppShell>
  );
}
