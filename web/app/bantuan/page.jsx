import { redirect } from "next/navigation";

import AppShell from "../../components/AppShell.jsx";
import { HELP_ENTRIES, HELP_GROUPS, HELP_PATH, findHelpEntry, helpAnchors } from "../../lib/help-catalog.mjs";
import { GUIDE_SHORTCUTS, GUIDE_TOPICS } from "../../lib/help-guide.mjs";
import HelpSearch from "./HelpSearch.jsx";
import styles from "./bantuan.module.css";

export const metadata = {
  title: "Bantuan",
  description: "Cara memakai Potongin, dan arti setiap kode error beserta cara memperbaikinya.",
};

// One topic of the guide: steps to follow, or terms with what each means; the editor's topic
// adds the keys worth learning first. Sections, not articles: the error entries are the articles.
function GuideTopic({ topic }) {
  return (
    <section id={topic.id} className={styles.topic} aria-labelledby={`${topic.id}-judul`} tabIndex={-1}>
      <h3 id={`${topic.id}-judul`}>{topic.title}</h3>
      <p className={styles.topicIntro}>{topic.intro}</p>
      {topic.steps && (
        <ol className={styles.guideSteps}>
          {topic.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
      {topic.terms && (
        <dl className={styles.terms}>
          {topic.terms.map((entry) => (
            <div key={entry.title} className={styles.row}>
              <dt>{entry.title}</dt>
              <dd>{entry.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {topic.id === "editor" && (
        <table className={styles.keys}>
          <caption>Pintasan yang paling sering dipakai. Tekan ? di editor untuk daftar lengkapnya.</caption>
          <thead><tr><th scope="col">Tombol</th><th scope="col">Fungsi</th></tr></thead>
          <tbody>
            {GUIDE_SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.id}>
                <td>{shortcut.keys.map((key, index) => <span key={key}>{index > 0 && " atau "}<kbd>{key}</kbd></span>)}</td>
                <td>{shortcut.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {topic.action && <a className={styles.action} href={topic.action.href}>{topic.action.label}</a>}
    </section>
  );
}

function Entry({ entry }) {
  const titleId = `${entry.id}-judul`;
  // The entry's other codes are anchors too, so /bantuan#<any code> lands here without JS.
  const [, ...aliases] = helpAnchors(entry);
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
            <dt>Di layar</dt>
            <dd>{entry.shown.map((text) => <span key={text} className={styles.shown}>“{text}”</span>)}</dd>
          </div>
        )}
        <div className={styles.row}>
          <dt>Penyebab</dt>
          <dd>{entry.cause}</dd>
        </div>
        <div className={styles.row}>
          <dt>Perbaikan</dt>
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

export default async function HelpPage({ searchParams }) {
  const params = await searchParams;
  const raw = Array.isArray(params?.q) ? params.q[0] : params?.q;
  const query = typeof raw === "string" ? raw : "";
  // The search form without JS (and a link to /bantuan?q=…): open the best entry directly.
  const found = query.trim() ? findHelpEntry(query) : null;
  if (found) redirect(`${HELP_PATH}#${found.entry.id}`);

  return (
    <AppShell current="/bantuan">
      <div className={`shell ${styles.page}`}>
        <header className="pageHead">
          <div>
            <h1>Bantuan</h1>
            <p>Cara memakai Potongin, lalu arti setiap pesan error. Tempel pesan error di kotak ini untuk langsung ke perbaikannya.</p>
          </div>
        </header>

        <HelpSearch initialQuery={query} missed={Boolean(query.trim())} />

        <section className={styles.guide} aria-labelledby="panduan">
          <h2 id="panduan">Panduan</h2>
          <nav className={styles.index} aria-label="Topik panduan">
            {GUIDE_TOPICS.map((topic) => <a key={topic.id} href={`#${topic.id}`}>{topic.title}</a>)}
          </nav>
          <div className={styles.topics}>
            {GUIDE_TOPICS.map((topic) => <GuideTopic key={topic.id} topic={topic} />)}
          </div>
        </section>

        <h2 className={styles.referenceTitle}>Pesan error</h2>

        <nav className={styles.index} aria-label="Kelompok bantuan">
          {HELP_GROUPS.map((group) => (
            <a key={group.id} href={`#grup-${group.id}`}>
              {group.title}{" "}
              <span>{HELP_ENTRIES.filter((entry) => entry.group === group.id).length}<span className="visuallyHidden"> entri</span></span>
            </a>
          ))}
        </nav>

        {HELP_GROUPS.map((group) => (
          <section key={group.id} className={styles.group} aria-labelledby={`grup-${group.id}`}>
            <h2 id={`grup-${group.id}`}>{group.title}</h2>
            <p className={styles.intro}>{group.intro}</p>
            <div className={styles.entries}>
              {HELP_ENTRIES.filter((entry) => entry.group === group.id).map((entry) => <Entry key={entry.id} entry={entry} />)}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
