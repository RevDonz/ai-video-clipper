import Brand from "../components/Brand.jsx";
import styles from "./landing.module.css";

// What the app does today, in the order a job runs (web/scripts/run-job.mjs, src/ai_clipper).
const steps = [
  ["Ambil video", "Link YouTube atau file unggahan."],
  ["Transkrip", "Subtitle YouTube kalau rapi, selain itu Whisper di server sendiri."],
  ["Pilih momen", "AI mencari momen dengan hook terkuat. Tanpa AI, heuristik lokal yang memilih."],
  ["Render", "Klip 9:16 dengan subtitle, teks hook, dan cold open."],
];

const features = [
  ["hook", "Hook di detik pertama", "Kalimat terkuat bisa diputar lebih dulu, teks hook tampil 4 detik pertama, dan subtitle karaoke mengikuti setiap kata."],
  ["focus", "Cari momen tentang topik", "Isi kata kunci seperti “prank” atau “tips kerja”. Klip yang membahasnya didahulukan dan diberi label."],
  ["caption", "Caption siap salin", "Setiap klip punya judul, deskripsi, dan hashtag. Tren yang sedang ramai ikut dipakai kalau transkripnya menyebutnya."],
];

// Sample clips for the picture of the Hasil panel; labelled as an example under it.
const sampleClips = [
  ["Jangan tunggu sempurna", "Mulai dari yang kecil", 42],
  ["Kesalahan terbesar saya", "Kesalahan yang terus diulang", 35],
  ["Ini yang bikin konsisten", "Rahasia konsisten", 51],
];

export default function LandingPage() {
  return (
    <main className={styles.landing}>
      <header className={`${styles.shell} ${styles.nav}`}>
        <Brand />
        <nav className={styles.navLinks} aria-label="Bagian halaman">
          <a href="#cara-kerja">Cara kerja</a>
          <a href="#fitur">Fitur</a>
          <a href="#privasi">Privasi</a>
        </nav>
        <a className={styles.navCta} href="/dashboard">Buat klip</a>
      </header>

      <section className={`${styles.shell} ${styles.hero}`} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <h1 id="hero-title">Video panjang,<br /><em>siap jadi konten.</em></h1>
          <p>Tempel link YouTube atau unggah video berbahasa Indonesia. Potongin memilih momen dengan hook terkuat, lalu merender klip 9:16 lengkap dengan subtitle, teks hook, dan caption.</p>
          <div className={styles.actions}>
            <a className={styles.primary} href="/dashboard">Mulai potong video</a>
            <a className={styles.secondary} href="#cara-kerja">Lihat cara kerja</a>
          </div>
        </div>

        <figure className={styles.stage}>
          <div className={styles.window} aria-hidden="true">
            <div className={styles.windowHead}><strong>Hasil</strong><span>Selesai · 100%</span></div>
            <div className={styles.windowProgress}><i /></div>
            <div className={styles.sampleGrid}>
              {sampleClips.map(([hook, title, seconds], index) => (
                <div className={styles.sample} key={title}>
                  <div className={styles.sampleFrame}>
                    <b>{hook}</b>
                    <i />
                    <span>mulai <mark>dari</mark> sekarang</span>
                  </div>
                  <small>Klip {index + 1} · {seconds} detik</small>
                  <strong>{title}</strong>
                  <div className={styles.sampleActions}><span>Unduh MP4</span><span>Salin caption</span></div>
                </div>
              ))}
            </div>
          </div>
          <figcaption>Contoh tampilan panel Hasil.</figcaption>
        </figure>
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
      </section>

      <section className={styles.privacy} id="privasi" aria-labelledby="privasi-title">
        <div className={`${styles.shell} ${styles.privacyInner}`}>
          <h2 id="privasi-title">Video Anda tetap di server Anda.</h2>
          <div className={styles.privacyCopy}>
            <p>Video, audio, dan hasil render disimpan di server sendiri. Yang dikirim ke penyedia AI hanya teks transkrip, ditambah kata kunci fokus dan tren kalau dipakai, dan hanya ke penyedia yang Anda atur. Matikan AI di Pengaturan, semua pemrosesan tetap berjalan di server.</p>
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
      </footer>
    </main>
  );
}
