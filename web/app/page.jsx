import Brand from "../components/Brand.jsx";
import LandingClip from "../components/LandingClip.jsx";
import { LANDING_MEDIA } from "../lib/landing-media.mjs";
import styles from "./landing.module.css";

// What the app does today, in the order a job runs (web/scripts/run-job.mjs, src/ai_clipper).
const steps = [
  ["Ambil video", "Link YouTube atau file unggahan."],
  ["Transkrip", "Subtitle YouTube kalau rapi, selain itu Whisper di server sendiri."],
  ["Pilih momen", "AI mencari momen dengan hook terkuat. Tanpa AI, heuristik lokal yang memilih."],
  ["Render", "Klip 9:16 dengan subtitle, teks hook, dan cold open."],
];

// The automatic part, four equal parts of one strip. The editor follows as its own wide row
// because it is the one feature with a screen of its own (and a screen-size limit).
const features = [
  ["hook", "Hook di detik pertama", "Kalimat terkuat bisa diputar lebih dulu, teks hook tampil 4 detik pertama, dan subtitle karaoke mengikuti setiap kata."],
  ["focus", "Cari momen tentang topik", "Isi kata kunci seperti “prank” atau “tips kerja”. Klip yang membahasnya didahulukan dan diberi label."],
  ["caption", "Caption siap salin", "Setiap klip punya judul, deskripsi, dan hashtag. Tren yang sedang ramai ikut dipakai kalau transkripnya menyebutnya."],
  ["layout", "Tata letak", "Ikuti wajah, potong tengah, atau latar blur. Di editor, bingkai bisa digeser sendiri dan layar terbagi menumpuk dua potongan."],
];

// The example's footage, an open film (docs/design/LANDING.md), credited where it is shown and
// in the footer as its licence asks.
const FILM_PAGE = "https://commons.wikimedia.org/wiki/File:Elephants_Dream_(2006)_1080p24.webm";

export default function LandingPage() {
  const { hasil, editor, sebelum } = LANDING_MEDIA;
  return (
    <main className={styles.landing}>
      <header className={`${styles.shell} ${styles.nav}`}>
        <Brand />
        <nav className={styles.navLinks} aria-label="Bagian halaman">
          <a href="#contoh">Contoh</a>
          <a href="#cara-kerja">Cara kerja</a>
          <a href="#fitur">Fitur</a>
          <a href="#privasi">Privasi</a>
        </nav>
        <a className={styles.navCta} href="/dashboard">Buat klip</a>
      </header>

      <section className={`${styles.shell} ${styles.hero}`} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <h1 id="hero-title">Video panjang,<br /><em>siap jadi konten.</em></h1>
          <p>Tempel link YouTube atau unggah video berbahasa Indonesia atau Inggris. Potongin memilih momen dengan hook terkuat, lalu merender klip 9:16 lengkap dengan subtitle, teks hook, dan caption.</p>
          <div className={styles.actions}>
            <a className={styles.primary} href="/dashboard">Mulai potong video</a>
            <a className={styles.secondary} href="#cara-kerja">Lihat cara kerja</a>
          </div>
        </div>

        <figure className={styles.stage}>
          <div className={styles.window}>
            <img
              src={hasil.src}
              width={hasil.width}
              height={hasil.height}
              fetchPriority="high"
              alt="Panel Hasil Potongin: tiga klip 9:16 dari film Elephants Dream, klip kedua terbuka dengan teks hook dan skornya."
            />
          </div>
          <figcaption>Panel Hasil dari proyek <a href="#contoh">contoh di bawah</a>.</figcaption>
        </figure>
      </section>

      <section className={`${styles.shell} ${styles.example}`} id="contoh" aria-labelledby="contoh-title">
        <div className={styles.sectionHead}>
          <h2 id="contoh-title">Satu adegan, sebelum dan sesudah.</h2>
          <p>Video 16:9 masuk, klip 9:16 keluar. Potongan mengikuti wajah, teks hook di atas, subtitle menyala per kata.</p>
        </div>
        <div className={styles.compare}>
          <figure className={styles.before}>
            <div className={styles.beforeFrame}>
              <img
                src={sebelum.src}
                width={sebelum.width}
                height={sebelum.height}
                loading="lazy"
                decoding="async"
                alt="Frame 16:9 dari Elephants Dream menit 8:09: Emo membungkuk di antara kabel, di sisi kiri gambar."
              />
            </div>
            <figcaption className={styles.compareBar}><strong>Sebelum</strong><span>Video 16:9, menit 8:09 dari film 10:58</span></figcaption>
          </figure>
          <LandingClip className={styles.after} frameClassName={styles.afterFrame} barClassName={styles.compareBar} buttonClassName={styles.pause}>
            <strong>Sesudah</strong><span>11 detik pertama klip 1:03</span>
          </LandingClip>
        </div>
        <p className={styles.exampleNote}>
          Sumber: film terbuka <a href={FILM_PAGE}>Elephants Dream</a> (2006), dialog bahasa Inggris. Klip ini dibuat tanpa AI: heuristik lokal memilih momennya, tata letak Ikuti wajah. Di halaman ini tanpa suara.
        </p>
      </section>

      <section className={`${styles.shell} ${styles.process}`} id="cara-kerja" aria-labelledby="cara-kerja-title">
        <div className={styles.sectionHead}>
          <h2 id="cara-kerja-title">Dari link ke klip, dalam satu alur.</h2>
          <p>Anda memilih sumber, jumlah klip, durasi, dan layout. Sisanya berjalan otomatis di server.</p>
        </div>
        <ol className={styles.steps}>
          {steps.map(([title, text], index) => (
            <li key={title}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <strong>{title}</strong>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${styles.shell} ${styles.features}`} id="fitur" aria-labelledby="fitur-title">
        <h2 id="fitur-title" className={styles.featuresTitle}>Yang dikerjakan Potongin</h2>
        <div className={styles.featureRow}>
          {features.map(([glyph, title, text]) => (
            <article key={glyph}>
              <div className={`${styles.glyph} ${styles[glyph]}`} aria-hidden="true"><i /><i /><i /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
        <article className={styles.editorRow} aria-labelledby="editor-title">
          <div className={styles.editorCopy}>
            <h3 id="editor-title">Editor</h3>
            <p>Buka klip mana pun dari panel Hasil. Potong per kata dari transkrip, ganti teks hook dan gaya caption, atur cold open, tambah logo dan musik, lalu ekspor ulang.</p>
            <p className={styles.editorNote}>Editor butuh layar minimal 1024 px.</p>
          </div>
          <div className={styles.editorShot}>
            <img
              src={editor.src}
              width={editor.width}
              height={editor.height}
              loading="lazy"
              decoding="async"
              alt="Editor Potongin: transkrip per kata di kiri, pratinjau klip 9:16 dengan teks hook dan caption, lalu timeline video, teks, hook dan audio di bawah."
            />
          </div>
        </article>
      </section>

      <section className={styles.privacy} id="privasi" aria-labelledby="privasi-title">
        <div className={`${styles.shell} ${styles.privacyInner}`}>
          <h2 id="privasi-title">Video Anda tetap di server Anda.</h2>
          <div className={styles.privacyCopy}>
            <p>Video, audio, dan hasil render disimpan di server sendiri. Yang dikirim ke penyedia AI hanya teks transkrip, ditambah kata kunci fokus dan tren kalau dipakai, dan hanya ke penyedia yang Anda atur. Audio hanya keluar dari server kalau Anda menyalakan transkripsi lewat Groq di Pengaturan. Matikan AI di Pengaturan, semua pemrosesan tetap berjalan di server.</p>
            <ul>
              <li>Riwayat proyek tersimpan dan bisa dihapus.</li>
              <li>AI bisa dibatasi ke model gratis.</li>
              <li>Tanpa AI, momen tetap dipilih heuristik lokal.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className={`${styles.shell} ${styles.final}`} aria-labelledby="final-title">
        <span className={styles.mark} aria-hidden="true">P</span>
        <h2 id="final-title">Lebih sedikit edit manual.<br /><em>Lebih banyak klip terbit.</em></h2>
        <a className={styles.primary} href="/dashboard">Mulai potong video</a>
      </section>

      <footer className={`${styles.shell} ${styles.footer}`}>
        <Brand />
        <p>Klip pendek dari video panjang, diproses di server sendiri.</p>
        <nav aria-label="Tautan aplikasi">
          <a href="/dashboard">Buat klip</a>
          <a href="/projects">Riwayat</a>
        </nav>
        <p className={styles.credits}>
          Video contoh: <a href={FILM_PAGE}>Elephants Dream</a> (2006), © Blender Foundation dan Netherlands Media Art Institute, www.elephantsdream.org, lisensi <a href="https://creativecommons.org/licenses/by/2.5/">CC BY 2.5</a>. Potongan 16:9, klip 9:16 dan kedua tangkapan layar dibuat dengan Potongin.
        </p>
      </footer>
    </main>
  );
}
