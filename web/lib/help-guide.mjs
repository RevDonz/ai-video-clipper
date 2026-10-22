// The learning half of the help page (/bantuan): how Potongin is used, one topic per page or
// part of the product, in the order a new user meets them. The error reference is
// help-catalog.mjs. Limits, presets and names come from the lists the pages use; the editor's
// card and tool names are written out here and tests/help-guide.test.mjs holds them to the
// editor's registries. Client-safe: no Node built-ins.

import { CLIP_LIMITS } from "./clip-limits.mjs";
import { CAPTION_STYLE_CHOICES, DURATION_PRESETS, LAYOUT_CHOICES, OPTION_SECTIONS } from "./dashboard-choices.mjs";
import { SHORTCUTS } from "./editor/shortcuts.mjs";

const presets = DURATION_PRESETS.filter((preset) => preset.id !== "custom");
const custom = DURATION_PRESETS.find((preset) => preset.id === "custom");
const sectionTitle = (id) => OPTION_SECTIONS.find((section) => section.id === id).title;
const term = (title, text) => Object.freeze({ title, text });

export const GUIDE_TOPICS = Object.freeze([
  Object.freeze({
    id: "mulai",
    title: "Membuat klip pertama",
    intro: "Satu video panjang jadi beberapa klip pendek, dari satu halaman.",
    steps: Object.freeze([
      "Buka Buat klip, lalu tempel link YouTube atau pilih file video (MP4, MOV, MKV, WEBM). File juga bisa ditarik ke halaman.",
      "Cek Jumlah klip, Durasi klip, Rasio, dan Layout. Pilihan ini diingat untuk job berikutnya di browser ini.",
      "Tekan Buat klip. Progres per tahap tampil di panel Hasil dan di menu samping; job tetap berjalan di server walau halamannya ditutup.",
      "Setelah selesai, tonton klipnya, unduh MP4, atau salin caption. Semua proyek tersimpan di Riwayat.",
    ]),
    action: Object.freeze({ href: "/dashboard", label: "Buka Buat klip" }),
  }),
  Object.freeze({
    id: "pilihan",
    title: "Pilihan di Buat klip",
    intro: "Yang selalu terlihat dipakai hampir setiap kali; sisanya dilipat dengan ringkasan pilihannya.",
    terms: Object.freeze([
      term("Jumlah klip", `${CLIP_LIMITS.count.min} sampai ${CLIP_LIMITS.count.max} klip per video.`),
      term("Durasi klip", `${presets.map((preset) => `${preset.name} ${preset.min}–${preset.max} detik`).join(", ")}, atau ${custom.name} antara ${CLIP_LIMITS.seconds.min}–${CLIP_LIMITS.seconds.max} detik.`),
      term("Rasio", "9:16 untuk TikTok, Reels, dan Shorts; 1:1 untuk feed."),
      term("Layout", `${LAYOUT_CHOICES.map((layout) => `${layout.name}: ${layout.description.charAt(0).toLowerCase()}${layout.description.slice(1)}`).join(" ")} Layar terbagi diatur per klip di editor.`),
      term(sectionTitle("look"), `${CAPTION_STYLE_CHOICES.length} gaya subtitle dengan posisi dan ukurannya, kalimat terkuat diputar di depan, dan teks hook di 4 detik pertama. Pratinjau 9:16 di sampingnya mengikuti pilihan Anda.`),
      term(sectionTitle("moments"), "Kata kunci fokus mendahulukan momen yang membahasnya. Rentang waktu, misalnya 10.30-12.05, menjadikan bagian itu satu klip apa adanya. Kosongkan keduanya untuk pemilihan otomatis."),
      term(sectionTitle("format"), "Bahasa yang diucapkan di video (Indonesia, Inggris, atau deteksi otomatis) dan resolusi 720p atau 1080p. 1080p lebih tajam, tapi render lebih lama."),
      term("Subtitle .srt", "Untuk file unggahan, tambahkan .srt (maksimal 2 MB) supaya transkrip diambil dari file itu, bukan dari audio."),
    ]),
  }),
  Object.freeze({
    id: "riwayat",
    title: "Riwayat dan proyek",
    intro: "Semua hasil ada di Riwayat, per proyek atau per klip.",
    steps: Object.freeze([
      "Tampilan Proyek: satu baris per video, dengan pencarian dan saringan status. Tampilan Klip: semua klip dari semua proyek.",
      "Buka proyek untuk menonton tiap klip, menyalin judul atau caption, dan mengunduh satu klip atau semuanya sebagai ZIP.",
      "Judul dan deskripsi bisa diubah langsung, atau ditulis ulang dengan Tulis ulang.",
      "Hapus proyek menghapus video sumber dan semua klipnya dari server. Tidak bisa dibatalkan.",
    ]),
    action: Object.freeze({ href: "/projects", label: "Buka Riwayat" }),
  }),
  Object.freeze({
    id: "editor",
    title: "Editor klip",
    intro: "Buka dari tombol Edit klip di proyek atau Riwayat. Editor butuh layar minimal 1024 px.",
    terms: Object.freeze([
      term("Cepat", "Kartu Hook, Caption, Teks caption, Cold open, Tata letak, serta Logo & Musik di samping pratinjau. Cocok untuk merapikan kemasan."),
      term("Lengkap", "Ikon alat di kiri (Transkrip, Teks, Cold open, Tata letak, Logo, Musik), panel alat yang dipilih di kanan pratinjau, timeline di bawah. Potong per kata dari transkrip di sini."),
      term("Simpan dan ekspor", "Perubahan tersimpan otomatis. Perlu dicek menunjukkan hal yang sebaiknya diperiksa sebelum ekspor; Ekspor membuat file MP4 dari hasil edit."),
    ]),
  }),
  Object.freeze({
    id: "tren",
    title: "Konteks Tren",
    intro: "Daftar topik, orang, jokes, dan hashtag yang sedang ramai, dikirim agen Anda atau ditambah manual.",
    steps: Object.freeze([
      "Tren aktif ikut dipakai untuk judul, hook, deskripsi, dan hashtag klip.",
      "Momen yang menyebut tren di transkripnya naik sedikit; momen bagus tanpa tren tetap bisa terpilih.",
      "Matikan Pakai konteks tren kalau job berikutnya tidak perlu tren.",
    ]),
    action: Object.freeze({ href: "/trends", label: "Buka Konteks Tren" }),
  }),
  Object.freeze({
    id: "pengaturan",
    title: "Pengaturan",
    intro: "Berlaku untuk job berikutnya.",
    steps: Object.freeze([
      "AI pemilih momen: penyedia dicoba dari atas; kalau semua gagal, heuristik lokal yang memilih. Hanya model gratis bisa dinyalakan.",
      "Transkripsi, logo dan watermark teks bawaan, serta cookies YouTube untuk video yang meminta login.",
      "Tentang sistem: komponen yang dipakai server ini, untuk disertakan saat melaporkan masalah.",
    ]),
    action: Object.freeze({ href: "/settings", label: "Buka Pengaturan" }),
  }),
]);

// The editor keys worth learning first, as the editor's own map writes them ("?" lists them all).
const FIRST_KEYS = ["playPause", "frameBack", "frameForward", "undo", "redo", "trimStart", "trimEnd", "export", "help"];
export const GUIDE_SHORTCUTS = Object.freeze(FIRST_KEYS.map((id) => {
  const { keys, description } = SHORTCUTS.find((entry) => entry.id === id);
  return Object.freeze({ id, keys, description });
}));
