import Brand from "../components/Brand.jsx";
import LandingClip from "../components/LandingClip.jsx";
import { PACK_IMAGES, imageSrc } from "../components/editor/panels/pack-images.js";
import { getLocale, getT } from "../lib/i18n/server.mjs";
import { LANDING_MEDIA } from "../lib/landing-media.mjs";
import styles from "./landing.module.css";

// The public landing (rombak 07 §8.3: a server component on getT). The copy is in
// messages/*/landing.json, the layout names in layout.json and the caption style names in
// dashboard.json, so the page reads in the visitor's language.

// The example's footage, an open film (docs/design/LANDING.md), credited where it is shown and
// in the footer as its licence asks.
const FILM_PAGE = "https://commons.wikimedia.org/wiki/File:Elephants_Dream_(2006)_1080p24.webm";
const LICENSE_PAGE = "https://creativecommons.org/licenses/by/2.5/";

// The layout classes of the drawings (landing.module.css), by layout mode: the three Buat klip
// offers, then the editor's own.
const LAYOUT_FRAMES = Object.freeze([["fit_blur", "fit-blur"], ["camera", "face-track"], ["fill_center", "center-crop"], ["split", "split"]]);
// The letter of the brand mark (components/Brand.jsx draws the same one): a glyph, not copy.
const BRAND_MARK = "P";
const STYLE_IDS = Object.freeze(["classic", "karaoke", "bold", "box", "sorot", "sinar"]);

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const { hasil, editor, sebelum } = LANDING_MEDIA;
  const locale = await getLocale();
  const t = await getT(locale, "landing");
  const tLayout = await getT(locale, "layout");
  const tChoice = await getT(locale, "dashboard");
  const film = (chunks) => <a href={FILM_PAGE}>{chunks}</a>;

  // What a job does today, in the order it runs (web/scripts/run-job.mjs, src/ai_clipper), and who
  // does each part: the person at both ends, the server in between.
  const steps = [
    ["anda", "source", t("how.source.title"), t("how.source.text")],
    ["potongin", "transcript", t("how.transcript.title"), t("how.transcript.text")],
    ["potongin", "moments", t("how.moments.title"), t("how.moments.text")],
    ["potongin", "render", t("how.render.title"), t("how.render.text")],
    ["anda", "review", t("how.review.title"), t("how.review.text")],
  ];
  const actors = { anda: t("how.you"), potongin: t("how.potongin") };
  const layoutNames = { fit_blur: tLayout("names.fit_blur"), camera: tLayout("names.camera"), fill_center: tLayout("names.fill_center"), split: tLayout("names.split") };
  const layoutTexts = { fit_blur: t("looks.layout.fit_blur"), camera: t("looks.layout.camera"), fill_center: t("looks.layout.fill_center"), split: t("looks.layout.split") };
  const styleNames = {
    classic: tChoice("style.classic"), karaoke: tChoice("style.karaoke"), bold: tChoice("style.bold"),
    box: tChoice("style.box"), sorot: tChoice("style.sorot"), sinar: tChoice("style.sinar"),
  };
  const styleTexts = {
    classic: t("looks.style.classic"), karaoke: t("looks.style.karaoke"), bold: t("looks.style.bold"),
    box: t("looks.style.box"), sorot: t("looks.style.sorot"), sinar: t("looks.style.sinar"),
  };
  // Smaller features, each one sentence: a list, not cards, because none needs a picture.
  const extras = [
    ["focus", t("features.focus.title"), t("features.focus.text")],
    ["ranges", t("features.ranges.title"), t("features.ranges.text")],
    ["trends", t("features.trends.title"), t("features.trends.text")],
    ["coldOpen", t("features.coldOpen.title"), t("features.coldOpen.text")],
  ];

  return (
    <main className={styles.landing}>
      <header className={`${styles.shell} ${styles.nav}`}>
        <Brand />
        <nav className={styles.navLinks} aria-label={t("nav.label")}>
          <a href="#contoh">{t("nav.example")}</a>
          <a href="#cara-kerja">{t("nav.how")}</a>
          <a href="#gaya">{t("nav.looks")}</a>
          <a href="#fitur">{t("nav.features")}</a>
          <a href="#privasi">{t("nav.privacy")}</a>
        </nav>
        <a className={styles.navCta} href="/dashboard">{t("nav.cta")}</a>
      </header>

      <section className={`${styles.shell} ${styles.hero}`} aria-labelledby="hero-title">
        <h1 id="hero-title">{t("hero.title1")}<br /><em>{t("hero.title2")}</em></h1>
        <div className={styles.heroCopy}>
          <p>{t("hero.body")}</p>
          <div className={styles.actions}>
            <a className={styles.primary} href="/dashboard">{t("hero.start")}</a>
            <a className={styles.secondary} href="#contoh">{t("hero.see")}</a>
          </div>
        </div>
      </section>

      <section className={`${styles.shell} ${styles.example}`} id="contoh" aria-labelledby="contoh-title">
        <div className={styles.exampleHead}>
          <h2 id="contoh-title">{t("example.title")}</h2>
          <p>{t("example.body")}</p>
        </div>
        <div className={styles.stage}>
          <figure className={styles.before}>
            <div className={styles.beforeFrame}>
              <img src={sebelum.src} width={sebelum.width} height={sebelum.height} fetchPriority="high" alt={t("example.beforeAlt")} />
              {/* The 9:16 window the clip took from this frame: it glides from the middle to the figure. */}
              <span className={styles.crop} aria-hidden="true"><b>9:16</b></span>
            </div>
            <div className={styles.track} aria-hidden="true">
              <span className={styles.marker}><b>8:09</b></span>
            </div>
            <figcaption className={styles.stageBar}><strong>{t("example.before")}</strong><span>{t("example.beforeNote")}</span></figcaption>
          </figure>
          <span className={styles.flow} aria-hidden="true" />
          <LandingClip className={styles.after} frameClassName={styles.phone} barClassName={styles.stageBar} buttonClassName={styles.pause}
            labels={{ video: t("example.video"), play: t("example.play"), pause: t("example.pause") }}>
            <strong>{t("example.after")}</strong><span>{t("example.afterNote")}</span>
          </LandingClip>
        </div>
        <p className={styles.exampleNote}>{t.rich("example.note", { film })}</p>
      </section>

      <section className={`${styles.shell} ${styles.process}`} id="cara-kerja" aria-labelledby="cara-kerja-title">
        <div className={styles.sectionHead}>
          <h2 id="cara-kerja-title">{t("how.title")}</h2>
          <p>{t("how.body")}</p>
        </div>
        <ol className={styles.lanes}>
          {steps.map(([actor, id, title, text]) => (
            <li key={id} data-actor={actor}>
              <span className={styles.actor}>{actors[actor]}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${styles.shell} ${styles.looks}`} id="gaya" aria-labelledby="gaya-title">
        <div className={styles.sectionHead}>
          <h2 id="gaya-title">{t("looks.title")}</h2>
          <p>{t("looks.body")}</p>
        </div>
        <ul className={styles.styleList}>
          {STYLE_IDS.map((id) => (
            <li key={id}>
              <img src={imageSrc(PACK_IMAGES[id])} width={320} height={80} loading="lazy" decoding="async" alt={t("looks.styleAlt", { name: styleNames[id] })} />
              <strong>{styleNames[id]}</strong>
              <span>{styleTexts[id]}</span>
            </li>
          ))}
        </ul>
        <div className={styles.layoutRow}>
          <h3>{t("looks.layoutsTitle")}</h3>
          <ul className={styles.layoutList}>
            {LAYOUT_FRAMES.map(([mode, frame]) => (
              <li key={mode}>
                <span className={`${styles.frame} ${styles[frame]}`} aria-hidden="true"><i /><i /></span>
                <strong>{layoutNames[mode]}</strong>
                <span>{layoutTexts[mode]}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={`${styles.shell} ${styles.features}`} id="fitur" aria-labelledby="fitur-title">
        <h2 id="fitur-title" className={styles.featuresTitle}>{t("features.title")}</h2>
        <article className={styles.showcase} aria-labelledby="hasil-title">
          <div className={styles.showcaseCopy}>
            <h3 id="hasil-title">{t("features.results.title")}</h3>
            <p>{t("features.results.body")}</p>
          </div>
          <div className={styles.shot}>
            <img src={hasil.src} width={hasil.width} height={hasil.height} loading="lazy" decoding="async" alt={t("features.results.alt")} />
          </div>
        </article>
        <article className={`${styles.showcase} ${styles.showcaseEditor}`} aria-labelledby="editor-title">
          <div className={styles.showcaseCopy}>
            <h3 id="editor-title">{t("features.editor.title")}</h3>
            <p>{t("features.editor.body")}</p>
            <p className={styles.editorNote}>{t("features.editor.note")}</p>
          </div>
          <div className={styles.shot}>
            <img src={editor.src} width={editor.width} height={editor.height} loading="lazy" decoding="async" alt={t("features.editor.alt")} />
          </div>
        </article>
        <dl className={styles.extras}>
          {extras.map(([id, title, text]) => (
            <div key={id}>
              <dt>{title}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.privacy} id="privasi" aria-labelledby="privasi-title">
        <div className={`${styles.shell} ${styles.privacyInner}`}>
          <h2 id="privasi-title">{t("privacy.title")}</h2>
          <div className={styles.privacyCopy}>
            <p>{t("privacy.body")}</p>
            <ul>
              <li>{t("privacy.projects")}</li>
              <li>{t("privacy.free")}</li>
              <li>{t("privacy.local")}</li>
            </ul>
          </div>
        </div>
      </section>

      <section className={`${styles.shell} ${styles.final}`} aria-labelledby="final-title">
        <span className={styles.mark} aria-hidden="true">{BRAND_MARK}</span>
        <h2 id="final-title">{t("final.title1")}<br /><em>{t("final.title2")}</em></h2>
        <a className={styles.primary} href="/dashboard">{t("final.cta")}</a>
      </section>

      <footer className={`${styles.shell} ${styles.footer}`}>
        <Brand />
        <p>{t("footer.tagline")}</p>
        <nav aria-label={t("footer.nav")}>
          <a href="/dashboard">{t("footer.create")}</a>
          <a href="/projects">{t("footer.projects")}</a>
          <a href="/bantuan">{t("footer.help")}</a>
        </nav>
        <p className={styles.credits}>
          {t.rich("footer.credits", { film, license: (chunks) => <a href={LICENSE_PAGE}>{chunks}</a> })}
        </p>
      </footer>
    </main>
  );
}
