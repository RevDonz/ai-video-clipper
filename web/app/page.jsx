const features = [
  ["01", "Temukan momen terbaik", "Whisper membaca percakapan dan memilih bagian yang paling layak berdiri sebagai klip."],
  ["02", "Siap format vertikal", "Render 9:16 dengan full-frame blur, center crop, atau face tracking yang mengikuti pembicara."],
  ["03", "Caption siap publikasi", "Setiap hasil dilengkapi judul, caption, CTA, dan hashtag berdasarkan isi klip."],
];

const pipeline = ["Ambil video", "Transkripsi", "Pilih highlight", "Render & subtitle"];

export default function LandingPage() {
  return (
    <main className="landing">
      <nav className="landingNav landingShell">
        <a className="landingBrand" href="/"><span>P</span> Potongin AI</a>
        <div className="landingNavLinks"><a href="#cara-kerja">Cara kerja</a><a href="#fitur">Fitur</a><a href="#privasi">Privasi</a></div>
        <a className="landingNavCta" href="/dashboard">Buka dashboard <span>↗</span></a>
      </nav>

      <section className="landingHero landingShell">
        <div className="landingHeroCopy">
          <div className="landingBadge"><i /> AI video repurposing · Bahasa Indonesia</div>
          <h1>Video panjang,<br /><em>siap jadi konten.</em></h1>
          <p>Temukan highlight, tambahkan subtitle, ubah ke format vertikal, lalu dapatkan caption—semuanya dalam satu alur kerja.</p>
          <div className="landingActions"><a className="landingPrimary" href="/dashboard">Mulai potong video <span>→</span></a><a className="landingSecondary" href="#cara-kerja">Lihat cara kerja</a></div>
          <div className="landingTrust"><span>Whisper lokal</span><b>•</b><span>FFmpeg</span><b>•</b><span>Data di server sendiri</span></div>
        </div>

        <div className="productStage" aria-hidden="true">
          <div className="stageGlow" />
          <div className="stageWindow">
            <div className="stageBar"><div><i /><i /><i /></div><span>potongin.ai / workspace</span><b>ONLINE</b></div>
            <div className="stageBody">
              <div className="stageSidebar"><strong><span>P</span></strong><i className="selected" /><i /><i /><i /><small>AI</small></div>
              <div className="stageContent">
                <div className="stageHeading"><div><small>PROJECT / VIDEO PODCAST</small><h3>3 klip terbaik ditemukan</h3></div><span className="stageFakeButton">Export semua</span></div>
                <div className="stageGrid">
                  {["Rahasia konsisten", "Kesalahan terbesar", "Mulai dari sekarang"].map((title, index) => (
                    <article className="stageClip" key={title}>
                      <div className={`stageVideo stageVideo${index + 1}`}><span>{index === 1 ? "JANGAN TUNGGU\nSEMPURNA" : index === 2 ? "MULAI DARI\nHAL KECIL" : "KONSISTENSI\nITU KUNCI"}</span><b>0:{index === 0 ? "42" : index === 1 ? "35" : "51"}</b></div>
                      <small>CLIP 0{index + 1}</small><h4>{title}</h4><div><i style={{ width: `${78 + index * 7}%` }} /></div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="stageFloat"><span>✓</span><div><small>RENDER SELESAI</small><strong>3 klip siap publish</strong></div></div>
        </div>
      </section>

      <section className="landingProof landingShell"><p>Satu workspace untuk seluruh proses repurposing</p><div><span>YOUTUBE</span><span>WHISPER</span><span>FFMPEG</span><span>SHORTS</span><span>REELS</span><span>TIKTOK</span></div></section>

      <section className="landingProcess landingShell" id="cara-kerja">
        <div className="landingSectionHead"><small>CARA KERJA</small><h2>Dari sumber ke klip,<br />tanpa pindah-pindah alat.</h2><p>Pipeline berjalan otomatis. Anda tetap memegang kendali atas sumber, layout, durasi, dan jumlah hasil.</p></div>
        <div className="pipelineTrack">
          {pipeline.map((item, index) => <div key={item}><b>{String(index + 1).padStart(2, "0")}</b><span>{item}</span>{index < pipeline.length - 1 && <i>→</i>}</div>)}
        </div>
      </section>

      <section className="landingFeatures landingShell" id="fitur">
        {features.map(([number, title, text]) => <article key={number}><small>{number}</small><div className={`featureGlyph glyph${number}`}><i /><b /></div><h3>{title}</h3><p>{text}</p></article>)}
      </section>

      <section className="privacyBand" id="privasi">
        <div className="landingShell"><div><small>SELF-HOSTED BY DESIGN</small><h2>Konten Anda.<br />Tetap milik Anda.</h2></div><div className="privacyCopy"><p>Proses inti berjalan di server sendiri. Video, transkrip, dan hasil render tidak perlu dikirim ke API AI berbayar pihak ketiga.</p><ul><li><span>✓</span> Penyimpanan persisten</li><li><span>✓</span> Tidak ada biaya API per menit</li><li><span>✓</span> Riwayat proyek terpusat</li></ul></div></div>
      </section>

      <section className="landingFinal landingShell"><div className="finalMark">P</div><small>SIAP MENGUBAH VIDEO BERIKUTNYA?</small><h2>Lebih sedikit editing.<br /><em>Lebih banyak publish.</em></h2><a href="/dashboard">Masuk ke dashboard <span>→</span></a></section>

      <footer className="landingFooter landingShell"><a className="landingBrand" href="/"><span>P</span> Potongin AI</a><p>Self-hosted AI video repurposing.</p><div><a href="/dashboard">Dashboard</a><a href="/projects">Riwayat</a></div></footer>
    </main>
  );
}
