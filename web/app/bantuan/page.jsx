import { redirect } from "next/navigation";

import AppShell from "../../components/AppShell.jsx";
import PageHead from "../../components/ui/PageHead.jsx";
import { HELP_PATH, findHelpEntry } from "../../lib/help-catalog.mjs";
import { guideView, helpGroupsView, helpSearchIndex, helpTitles, shortcutsView } from "../../lib/help-view.mjs";
import { getLocale, getT, routeMetadata } from "../../lib/i18n/server.mjs";
import { shellData } from "../../lib/shell-data.mjs";
import HelpGuide from "./HelpGuide.jsx";
import HelpSearch from "./HelpSearch.jsx";
import styles from "./bantuan.module.css";

export async function generateMetadata() {
  return routeMetadata("help");
}

// One error entry. The entry's other codes are anchors too, so /bantuan#<any code> lands here
// without JS; the entry is always rendered, never folded.
function Entry({ entry, labels }) {
  const titleId = `${entry.id}-judul`;
  const [, ...aliases] = entry.anchors;
  return (
    <article id={entry.id} className={styles.entry} tabIndex={-1} aria-labelledby={titleId}>
      {aliases.map((anchor) => <span key={anchor} id={anchor} className={styles.alias} />)}
      <header className={styles.entryHead}>
        <h3 id={titleId}>{entry.title}</h3>
        <code className={styles.code}>{entry.id}</code>
      </header>
      <dl className={styles.facts}>
        {entry.shown.length > 0 && (
          <div className={styles.row}>
            <dt>{labels.shown}</dt>
            <dd>{entry.shown.map((text) => <q key={text} className={styles.shown}>{text}</q>)}</dd>
          </div>
        )}
        <div className={styles.row}>
          <dt>{labels.cause}</dt>
          <dd>{entry.cause}</dd>
        </div>
        <div className={styles.row}>
          <dt>{labels.fix}</dt>
          <dd>
            <ol className={styles.steps}>
              {entry.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </dd>
        </div>
      </dl>
      {entry.action && <a className={styles.action} href={entry.action.href}>{entry.action.label}</a>}
    </article>
  );
}

// The search index over every locale's catalog; the catalogs are read once per process.
let indexOnce = null;
function searchIndex() {
  indexOnce ??= helpSearchIndex(getT).catch((error) => {
    indexOnce = null;
    throw error;
  });
  return indexOnce;
}

export default async function HelpPage({ searchParams }) {
  const params = await searchParams;
  const raw = Array.isArray(params?.q) ? params.q[0] : params?.q;
  const query = typeof raw === "string" ? raw : "";
  const index = await searchIndex();
  // The search form without JS (and a link to /bantuan?q=…): open the best entry directly.
  const found = query.trim() ? findHelpEntry(query, index) : null;
  if (found) redirect(`${HELP_PATH}#${found.entry.id}`);

  const locale = await getLocale();
  const t = await getT(locale, "help");
  const te = await getT(locale, "errors");
  const groups = helpGroupsView(t, te);
  const shortcuts = shortcutsView(t);
  const facts = { shown: t("entry.shown"), cause: t("entry.cause"), fix: t("entry.fix") };
  const search = {
    label: t("search.label"),
    placeholder: t("search.placeholder"),
    submit: t("search.submit"),
    hint: t("search.hint"),
    empty: t("search.empty"),
    noMatch: t("search.noMatch"),
    best: t("search.best"),
    maybe: t("search.maybe"),
  };

  return (
    <AppShell current="/bantuan" {...shellData()}>
      <div className={`shell ${styles.page}`}>
        <PageHead title={t("title")} />

        <HelpSearch initialQuery={query} missed={Boolean(query.trim())} index={index} titles={helpTitles(t)} labels={search} />

        <HelpGuide title={t("guide.title")} topics={guideView(t)} />

        <section id={shortcuts.anchor} className={styles.shortcuts} aria-labelledby={`${shortcuts.anchor}-judul`} tabIndex={-1}>
          <h2 id={`${shortcuts.anchor}-judul`}>{t("shortcuts.title")}</h2>
          <div className={styles.keysScroll}>
            <table className={styles.keys}>
              <thead><tr><th scope="col">{t("shortcuts.key")}</th><th scope="col">{t("shortcuts.does")}</th></tr></thead>
              {shortcuts.groups.map((group) => (
                <tbody key={group.id}>
                  <tr>
                    <th scope="rowgroup" colSpan={2} className={styles.keysGroup}>
                      {group.title} <span>{group.note}</span>
                    </th>
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.keys.map((key, place) => <span key={key}>{place > 0 && ` ${t("shortcuts.or")} `}<kbd>{key}</kbd></span>)}</td>
                      <td>{row.text}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </section>

        <h2 className={styles.referenceTitle}>{t("errors.title")}</h2>

        <nav className={styles.index} aria-label={t("errors.groups")}>
          {groups.map((group) => (
            <a key={group.id} href={`#${group.anchor}`}>
              {group.title}{" "}
              <span aria-hidden="true">{group.entries.length}</span>
              <span className="visuallyHidden">{t("errors.count", { count: group.entries.length })}</span>
            </a>
          ))}
        </nav>

        {groups.map((group) => (
          <section key={group.id} className={styles.group} aria-labelledby={group.anchor}>
            <h2 id={group.anchor}>{group.title}</h2>
            <p className={styles.intro}>{group.intro}</p>
            <div className={styles.entries}>
              {group.entries.map((entry) => <Entry key={entry.id} entry={entry} labels={facts} />)}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
