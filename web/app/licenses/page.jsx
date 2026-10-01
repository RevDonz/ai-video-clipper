import AppHeader from "../../components/AppHeader.jsx";
import { FONTS, FREETYPE_CREDIT, JASSUB, MEDIABUNNY, WEB } from "./notices.mjs";
import styles from "./licenses.module.css";

export const metadata = {
  title: "Lisensi",
  description: "Lisensi perangkat lunak dan font pihak ketiga yang dipakai Potongin, dengan versi dan kode sumbernya.",
};

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

export default function LicensesPage() {
  return (
    <main>
      <AppHeader />
      <div className={`shell ${styles.page}`}>
        <header className={styles.head}>
          <h1>Lisensi pihak ketiga</h1>
          <p>
            Potongin memakai perangkat lunak dan font dari pihak lain. Di sini tercantum lisensinya, versi
            persisnya, dan tempat kode sumbernya.
          </p>
        </header>

        <section className={styles.block} aria-labelledby="jassub">
          <h2 id="jassub">{JASSUB.name} {JASSUB.version}</h2>
          <p className={styles.use}>{JASSUB.use}</p>
          <dl className={styles.facts}>
            <Row label="Lisensi">{JASSUB.license}</Row>
            <Row label="Paket">npm {JASSUB.name.toLowerCase()}@{JASSUB.version}<span className={styles.hash}>{JASSUB.integrity}</span></Row>
            <Row label="Dikirim ke browser">{JASSUB.files.join(", ")}, tanpa diubah</Row>
            <Row label="Kode sumber">
              <a href={JASSUB.source} className={styles.file}>commit {JASSUB.commit.slice(0, 7)}</a>
              <span className={styles.note}>{JASSUB.sourceNote}</span>
            </Row>
            <Row label="Skrip build">
              <span className={styles.links}>
                {JASSUB.buildScripts.map((script) => <a key={script.href} href={script.href}>{script.label}</a>)}
              </span>
            </Row>
          </dl>

          <h3>Komponen di dalam file WebAssembly</h3>
          <ul className={styles.items}>
            {JASSUB.components.map((component) => (
              <li key={component.name}>
                <span className={styles.name}>{component.name}</span>
                <span className={styles.licence}>{component.license}</span>
                <span className={styles.links}>
                  <a href={component.source}>Kode sumber</a>
                  <Texts hrefs={component.texts} />
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.text}>
            Teks lengkap semua lisensinya, seperti yang dikumpulkan JASSUB:{" "}
            <a href={JASSUB.fullNotice} className={styles.file}>{fileName(JASSUB.fullNotice)}</a>
          </p>
          <p className={styles.text}>
            FriBidi berlisensi LGPL-2.1. Kode sumber setiap komponen dan skrip build JASSUB ada di tautan di
            atas, jadi file WebAssembly ini bisa dibangun ulang, termasuk dengan FriBidi yang sudah diubah.
          </p>
          <p className={styles.credit} lang="en">{FREETYPE_CREDIT}</p>
        </section>

        <section className={styles.block} aria-labelledby="mediabunny">
          <h2 id="mediabunny">{MEDIABUNNY.name} {MEDIABUNNY.version}</h2>
          <p className={styles.use}>{MEDIABUNNY.use}</p>
          <dl className={styles.facts}>
            <Row label="Lisensi">{MEDIABUNNY.license}</Row>
            <Row label="Paket">npm {MEDIABUNNY.name.toLowerCase()}@{MEDIABUNNY.version}<span className={styles.hash}>{MEDIABUNNY.integrity}</span></Row>
            <Row label="Kode sumber">
              <a href={MEDIABUNNY.source} className={styles.file}>tag {MEDIABUNNY.tag}</a>
              <span className={styles.note}>
                Commit {MEDIABUNNY.commit.slice(0, 7)}. Kodenya tidak diubah; browser menerimanya di dalam bundel
                aplikasi web.
              </span>
            </Row>
            <Row label="Teks lisensi"><Texts hrefs={MEDIABUNNY.texts} /></Row>
          </dl>
        </section>

        <section className={styles.block} aria-labelledby="fonts">
          <h2 id="fonts">Font</h2>
          <ul className={styles.items}>
            {FONTS.map((font) => (
              <li key={font.name}>
                <span className={styles.name}>{font.name}</span>
                <span className={styles.licence}>{font.license}</span>
                <span className={styles.detail}>{font.use} {font.copyright}.</span>
                <span className={styles.links}>
                  <a href={font.source}>Sumber</a>
                  <Texts hrefs={font.texts} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="web">
          <h2 id="web">Aplikasi web</h2>
          <ul className={styles.items}>
            {WEB.map((item) => (
              <li key={item.name}>
                <span className={styles.name}>{item.name} {item.version}</span>
                <span className={styles.licence}>{item.license}</span>
                <span className={styles.links}>
                  <a href={item.source}>Kode sumber</a>
                  <Texts hrefs={item.texts} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
