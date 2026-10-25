import AppShell from "../../components/AppShell.jsx";
import { getLocale, getT, routeMetadata } from "../../lib/i18n/server.mjs";
import { shellData } from "../../lib/shell-data.mjs";
import { FONTS, FREETYPE_CREDIT, JASSUB, MEDIABUNNY, UI, WEB } from "./notices.mjs";
import styles from "./licenses.module.css";

export async function generateMetadata() {
  return routeMetadata("licenses");
}

const fileName = (href) => href.slice(href.lastIndexOf("/") + 1);

function Texts({ hrefs }) {
  return hrefs.map((href) => (
    <a key={href} href={href} className={styles.file}>{fileName(href)}</a>
  ));
}

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The page's own words are help.licenses.* in the UI language; the notices (names, versions,
// licence names and texts, what each part does) are notices.mjs, kept as published.
export default async function LicensesPage() {
  const t = await getT(await getLocale(), "help");
  return (
    <AppShell {...shellData()}>
      <div className={`shell ${styles.page}`}>
        <header className="pageHead">
          <div>
            <h1>{t("licenses.title")}</h1>
          </div>
        </header>

        <section className={styles.block} aria-labelledby="jassub">
          <h2 id="jassub">{JASSUB.name} {JASSUB.version}</h2>
          <p className={styles.use}>{JASSUB.use}</p>
          <dl className={styles.facts}>
            <Row label={t("licenses.license")}>{JASSUB.license}</Row>
            <Row label={t("licenses.package")}>{t("licenses.npm", { name: JASSUB.name.toLowerCase(), version: JASSUB.version })}<span className={styles.hash}>{JASSUB.integrity}</span></Row>
            <Row label={t("licenses.shipped")}>{t("licenses.shippedFiles", { files: JASSUB.files.join(", ") })}</Row>
            <Row label={t("licenses.source")}>
              <a href={JASSUB.source} className={styles.file}>{t("licenses.commit", { commit: JASSUB.commit.slice(0, 7) })}</a>
              <span className={styles.note}>{JASSUB.sourceNote}</span>
            </Row>
            <Row label={t("licenses.buildScripts")}>
              <span className={styles.links}>
                {JASSUB.buildScripts.map((script) => <a key={script.href} href={script.href}>{script.label}</a>)}
              </span>
            </Row>
          </dl>

          <h3>{t("licenses.wasmParts")}</h3>
          <ul className={styles.items}>
            {JASSUB.components.map((component) => (
              <li key={component.name}>
                <span className={styles.name}>{component.name}</span>
                <span className={styles.licence}>{component.license}</span>
                <span className={styles.links}>
                  <a href={component.source}>{t("licenses.source")}</a>
                  <Texts hrefs={component.texts} />
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.text}>
            {t("licenses.fullNotice")}{" "}
            <a href={JASSUB.fullNotice} className={styles.file}>{fileName(JASSUB.fullNotice)}</a>
          </p>
          <p className={styles.text}>{t("licenses.fribidi")}</p>
          <p className={styles.credit} lang="en">{FREETYPE_CREDIT}</p>
        </section>

        <section className={styles.block} aria-labelledby="mediabunny">
          <h2 id="mediabunny">{MEDIABUNNY.name} {MEDIABUNNY.version}</h2>
          <p className={styles.use}>{MEDIABUNNY.use}</p>
          <dl className={styles.facts}>
            <Row label={t("licenses.license")}>{MEDIABUNNY.license}</Row>
            <Row label={t("licenses.package")}>{t("licenses.npm", { name: MEDIABUNNY.name.toLowerCase(), version: MEDIABUNNY.version })}<span className={styles.hash}>{MEDIABUNNY.integrity}</span></Row>
            <Row label={t("licenses.source")}>
              <a href={MEDIABUNNY.source} className={styles.file}>{t("licenses.tag", { tag: MEDIABUNNY.tag })}</a>
              <span className={styles.note}>{t("licenses.bundled", { commit: MEDIABUNNY.commit.slice(0, 7) })}</span>
            </Row>
            <Row label={t("licenses.licenseText")}><Texts hrefs={MEDIABUNNY.texts} /></Row>
          </dl>
        </section>

        <section className={styles.block} aria-labelledby="fonts">
          <h2 id="fonts">{t("licenses.fonts")}</h2>
          <ul className={styles.items}>
            {FONTS.map((font) => (
              <li key={font.name}>
                <span className={styles.name}>{font.name}</span>
                <span className={styles.licence}>{font.license}</span>
                <span className={styles.detail}>{font.use} {font.copyright}.</span>
                <span className={styles.links}>
                  <a href={font.source}>{t("licenses.fontSource")}</a>
                  <Texts hrefs={font.texts} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="web">
          <h2 id="web">{t("licenses.web")}</h2>
          <ul className={styles.items}>
            {WEB.map((item) => (
              <li key={item.name}>
                <span className={styles.name}>{item.name} {item.version}</span>
                <span className={styles.licence}>{item.license}</span>
                <span className={styles.links}>
                  <a href={item.source}>{t("licenses.source")}</a>
                  <Texts hrefs={item.texts} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="ui">
          <h2 id="ui">{t("licenses.ui")}</h2>
          <ul className={styles.items}>
            {UI.map((item) => (
              <li key={item.name}>
                <span className={styles.name}>{item.name}</span>
                <span className={styles.licence}>{[...new Set(item.packages.map((entry) => entry.license))].join(", ")}</span>
                <span className={styles.detail}>
                  {item.use} {item.packages.map((entry) => `${entry.name}@${entry.version}`).join(", ")}.
                  {item.licenseNote ? ` ${item.licenseNote}` : ""}
                </span>
                <span className={styles.links}>
                  <a href={item.source}>{t("licenses.source")}</a>
                  <Texts hrefs={item.texts} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
