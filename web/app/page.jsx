import Brand from "../components/Brand.jsx";
import LandingClip from "../components/LandingClip.jsx";
import { PACK_IMAGES, imageSrc } from "../components/editor/panels/pack-images.js";
import { CAPTION_STYLE_CHOICES, LAYOUT_CHOICES } from "../lib/dashboard-choices.mjs";
import { LANDING_MEDIA } from "../lib/landing-media.mjs";
import styles from "./landing.module.css";

// What a job does today, in the order it runs (web/scripts/run-job.mjs, src/ai_clipper), and who
// does each part: the person at both ends, the server in between.
const steps = [
  ["anda", "Tempel link atau unggah", "Link YouTube atau file MP4, MOV, MKV, WEBM. Pilih jumlah klip, durasi, dan layout."],
  ["potongin", "Ambil dan transkrip", "Subtitle YouTube kalau rapi, selain itu Whisper di server sendiri."],
  ["potongin", "Pilih momen", "AI dari penyedia yang Anda atur menilai hook tiap momen. Tanpa AI, heuristik lokal yang memilih."],
  ["potongin", "Render", "Klip 9:16 atau 1:1 dengan subtitle, teks hook, dan kalimat terkuat di depan."],
  ["anda", "Cek dan unduh", "Tonton di panel Hasil, rapikan di editor kalau perlu, lalu unduh MP4 dan salin caption."],
];
const ACTOR = { anda: "Anda", potongin: "Potongin" };

// Tata letak: the three the dashboard offers (named as the editor names them), then the editor's own.
const layouts = [
  ...LAYOUT_CHOICES.map((layout) => [layout.id, layout.name, layout.description]),
  ["split", "Layar terbagi", "Dua potongan bertumpuk, 30/70 atau 50/50. Diatur per klip di editor."],
];

// Smaller features, each one sentence: a list, not cards, because none needs a picture.
const extras = [
  ["Cari momen tentang topik", "Isi kata kunci seperti “prank” atau “tips kerja”. Klip yang membahasnya didahulukan dan diberi label."],
  ["Rentang waktu sendiri", "Tulis 10.30-12.05 dan rentang itu jadi satu klip apa adanya; sisa slot diisi momen lain."],
  ["Konteks Tren", "Tren yang sedang ramai ikut dipakai untuk judul, hook, dan hashtag kalau transkripnya menyebutnya."],
  ["Kalimat terkuat di depan", "Kalimat hook diputar dulu beberapa detik, lalu klip mulai dari awal."],
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
          <a href="#gaya">Gaya</a>
          <a href="#fitur">Fitur</a>
          <a href="#privasi">Privasi</a>
        </nav>
        <a className={styles.navCta} href="/dashboard">Buat klip</a>
      </header>

      <section className={`${styles.shell} ${styles.hero}`} aria-labelledby="hero-title">
        <h1 id="hero-title">Tempel link,<br /><em>klipnya menyusul.</em></h1>
        <div className={styles.heroCopy}>
          <p>Potongin mencari momen dengan hook terkuat di video panjang berbahasa Indonesia atau Inggris, memotongnya ke 9:16 atau 1:1, lalu menambah subtitle, teks hook, dan caption siap salin.</p>
          <div className={styles.actions}>
            <a className={styles.primary} href="/dashboard">Mulai potong video</a>
            <a className={styles.secondary} href="#contoh">Lihat contohnya</a>
          </div>
        </div>
      </section>

      <section className={`${styles.shell} ${styles.example}`} id="contoh" aria-labelledby="contoh-title">
        <div className={styles.exampleHead}>
          <h2 id="contoh-title">Satu adegan, sebelum dan sesudah.</h2>
          <p>Video 16:9 masuk, klip 9:16 keluar. Potongan mengikuti wajah, teks hook di atas, subtitle menyala per kata.</p>
        </div>
        <div className={styles.stage}>
          <figure className={styles.before}>
            <div className={styles.beforeFrame}>
              <img
                src={sebelum.src}
                width={sebelum.width}
                height={sebelum.height}
                fetchPriority="high"
                alt="Frame 16:9 dari Elephants Dream menit 8:09: Emo membungkuk di antara kabel, di sisi kiri gambar."
              />
              {/* The 9:16 window the clip took from this frame: it glides from the middle to the figure. */}
              <span className={styles.crop} aria-hidden="true"><b>9:16</b></span>
            </div>
            <div className={styles.track} aria-hidden="true">
              <span className={styles.marker}><b>8:09</b></span>
            </div>
            <figcaption className={styles.stageBar}><strong>Sebelum</strong><span>Video 16:9, menit 8:09 dari film 10:58</span></figcaption>
          </figure>
          <span className={styles.flow} aria-hidden="true" />
          <LandingClip className={styles.after} frameClassName={styles.phone} barClassName={styles.stageBar} buttonClassName={styles.pause}>
            <strong>Sesudah</strong><span>11 detik pertama klip 1:03</span>
          </LandingClip>
        </div>
        <p className={styles.exampleNote}>
          Sumber: film terbuka <a href={FILM_PAGE}>Elephants Dream</a> (2006), dialog bahasa Inggris. Klip ini dibuat tanpa AI: heuristik lokal memilih momennya, tata letak Ikuti wajah. Di halaman ini tanpa suara.
        </p>
      </section>

      <section className={`${styles.shell} ${styles.process}`} id="cara-kerja" aria-labelledby="cara-kerja-title">
        <div className={styles.sectionHead}>
          <h2 id="cara-kerja-title">Anda memilih, server mengerjakan.</h2>
          <p>Dua langkah ada di tangan Anda, di awal dan di akhir. Di antaranya Potongin bekerja sendiri dan progresnya tampil per tahap.</p>
        </div>
        <ol className={styles.lanes}>
          {steps.map(([actor, title, text]) => (
            <li key={title} data-actor={actor}>
              <span className={styles.actor}>{ACTOR[actor]}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${styles.shell} ${styles.looks}`} id="gaya" aria-labelledby="gaya-title">
        <div className={styles.sectionHead}>
          <h2 id="gaya-title">Gaya subtitle yang siap pakai.</h2>
          <p>Contoh di bawah dirender dari gaya yang sama dengan klipnya. Posisi atas, tengah, atau bawah dalam tiga ukuran; per klip bisa diubah lagi di editor.</p>
        </div>
        <ul className={styles.styleList}>
          {CAPTION_STYLE_CHOICES.map((style) => (
            <li key={style.id}>
              <img src={imageSrc(PACK_IMAGES[style.id])} width={320} height={80} loading="lazy" decoding="async" alt={`Gaya ${style.name}: tulisan “Halo semua” seperti tampil di klip.`} />
              <strong>{style.name}</strong>
              <span>{style.description}</span>
            </li>
          ))}
        </ul>
        <div className={styles.layoutRow}>
          <h3>Tata letak</h3>
          <ul className={styles.layoutList}>
            {layouts.map(([id, name, text]) => (
              <li key={id}>
                <span className={`${styles.frame} ${styles[id]}`} aria-hidden="true"><i /><i /></span>
                <strong>{name}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={`${styles.shell} ${styles.features}`} id="fitur" aria-labelledby="fitur-title">
        <h2 id="fitur-title" className={styles.featuresTitle}>Yang dikerjakan Potongin</h2>
        <article className={styles.showcase} aria-labelledby="hasil-title">
          <div className={styles.showcaseCopy}>
            <h3 id="hasil-title">Klip yang siap diunggah</h3>
            <p>Setiap klip datang dengan judul, deskripsi, hashtag, teks hook, dan skornya. Salin caption atau unduh MP4 langsung dari panel Hasil.</p>
          </div>
          <div className={styles.shot}>
            <img
              src={hasil.src}
              width={hasil.width}
              height={hasil.height}
              loading="lazy"
              decoding="async"
              alt="Panel Hasil Potongin: tiga klip 9:16 dari film Elephants Dream, klip kedua terbuka dengan teks hook dan skornya."
            />
          </div>
        </article>
        <article className={`${styles.showcase} ${styles.showcaseEditor}`} aria-labelledby="editor-title">
          <div className={styles.showcaseCopy}>
            <h3 id="editor-title">Editor</h3>
            <p>Buka klip mana pun dari panel Hasil. Potong per kata dari transkrip, ganti teks hook dan gaya caption, atur cold open, tambah logo dan musik, lalu ekspor ulang.</p>
            <p className={styles.editorNote}>Editor butuh layar minimal 1024 px.</p>
          </div>
          <div className={styles.shot}>
            <img
              src={editor.src}
              width={editor.width}
              height={editor.height}
              loading="lazy"
              decoding="async"
              alt="Editor Potongin, Mode Lengkap: ikon alat di kiri, pratinjau klip 9:16 di tengah, transkrip per kata di kanan, timeline di bawah."
            />
          </div>
        </article>
        <dl className={styles.extras}>
          {extras.map(([title, text]) => (
            <div key={title}>
              <dt>{title}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
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
          <a href="/bantuan">Bantuan</a>
        </nav>
        <p className={styles.credits}>
          Video contoh: <a href={FILM_PAGE}>Elephants Dream</a> (2006), © Blender Foundation dan Netherlands Media Art Institute, www.elephantsdream.org, lisensi <a href="https://creativecommons.org/licenses/by/2.5/">CC BY 2.5</a>. Potongan 16:9, klip 9:16 dan kedua tangkapan layar dibuat dengan Potongin.
        </p>
      </footer>
    </main>
  );
}
