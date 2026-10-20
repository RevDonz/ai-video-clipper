// The help page (/bantuan): one entry per error code a user can meet, with its cause and the
// steps that fix it, the search behind the page's box, and the links other pages put under
// their error messages. Client-safe: no Node built-ins.
//
// The codes come from three places, and tests/help-catalog.test.mjs fails when one of them has
// no entry here: the download codes (download-errors.mjs), the storage admission codes
// (dashboard-view.mjs) and the AI codes (ERROR_CODES in src/ai_clipper/llm.py, the connection
// test's codes in llm-settings-actions.mjs and the AI fallbacks a job records in its warnings).

import { STORAGE_ERROR_CODES, storageMessage } from "./dashboard-view.mjs";
import { DOWNLOAD_ERROR_CODES, DOWNLOAD_ERROR_PATTERNS, downloadErrorMessage } from "./download-errors.mjs";

export const HELP_PATH = "/bantuan";
// A longer paste keeps only its end: a log ends with the line that made it fail.
export const MAX_HELP_QUERY = 4000;

export const HELP_GROUPS = Object.freeze([
  Object.freeze({ id: "unduhan", title: "Unduhan YouTube", intro: "Server gagal mengambil video dari link YouTube. Pesannya muncul di Buat Klip dan di halaman proyek." }),
  Object.freeze({ id: "penyimpanan", title: "Penyimpanan server", intro: "Server menolak job baru, atau menghentikannya, karena ruang penyimpanan." }),
  Object.freeze({ id: "ai", title: "AI pemilih momen", intro: "Penyedia AI di Pengaturan gagal dipakai. Job tetap jalan: momen dipilih dengan heuristik lokal." }),
]);

const BUAT_KLIP = Object.freeze({ href: "/dashboard", label: "Buka Buat Klip" });
const RIWAYAT = Object.freeze({ href: "/projects", label: "Buka Riwayat" });
const PENGATURAN = Object.freeze({ href: "/settings", label: "Buka Pengaturan" });
const UPLOAD = "Unggah file videonya langsung lewat Unggah file di Buat Klip.";
const TEST_AGAIN = "Simpan, lalu jalankan Tes koneksi.";

function download(code, fields) {
  return { group: "unduhan", id: code, shown: [downloadErrorMessage(code).text], action: BUAT_KLIP, ...fields };
}

function storage(code, fields) {
  return { group: "penyimpanan", id: code, shown: [storageMessage(code)], action: RIWAYAT, ...fields };
}

// AI entries are anchored at llm_<code>: the engine's codes ("timeout", "auth") are too plain
// to stand alone in a URL. `codes` are the codes as the engine and the settings page write them.
function ai(code, fields) {
  return { group: "ai", id: `llm_${code}`, codes: [code], action: PENGATURAN, ...fields };
}

const ENTRIES = [
  download("download_private", {
    title: "Video privat",
    cause: "Pemilik video menyetelnya privat. Server hanya bisa mengunduh video yang bisa ditonton tanpa login.",
    steps: [
      "Buka link-nya di jendela penyamaran. Kalau YouTube meminta login, videonya memang privat.",
      "Minta pemiliknya mengubah visibilitas ke Publik atau Tidak publik, lalu buat ulang proyeknya.",
      `Atau ${UPLOAD.charAt(0).toLowerCase()}${UPLOAD.slice(1)}`,
    ],
  }),
  download("download_unavailable", {
    title: "Video dihapus atau tidak tersedia",
    cause: "Videonya sudah dihapus, kanalnya ditutup, atau link-nya terpotong sehingga ID videonya tidak lengkap.",
    steps: [
      "Buka link-nya di browser dan pastikan videonya masih bisa diputar.",
      "Salin ulang link dari tombol Bagikan di YouTube, lalu buat ulang proyeknya.",
      "Kalau videonya memang sudah hilang, unggah file aslinya.",
    ],
  }),
  download("download_age_restricted", {
    title: "Video dibatasi usia",
    cause: "YouTube meminta login untuk video yang dibatasi usia. Server mengunduh tanpa akun YouTube, jadi permintaan itu tidak bisa dipenuhi.",
    steps: [UPLOAD],
  }),
  download("download_members_only", {
    title: "Video khusus member atau berbayar",
    cause: "Video ini hanya untuk member kanal atau pembelinya. Server tidak punya akses itu.",
    steps: [UPLOAD, "Kalau file-nya tidak ada, pilih video yang bisa ditonton semua orang."],
  }),
  download("download_geo_blocked", {
    title: "Video diblokir di wilayah server",
    cause: "Pemilik video membatasinya ke negara tertentu, dan server berada di luar negara itu. Video yang bisa diputar di perangkat Anda belum tentu bisa diunduh server.",
    steps: [UPLOAD],
  }),
  download("download_bot_check", {
    title: "YouTube menahan unduhan dari server",
    cause: "YouTube menahan permintaan dari alamat IP server: meminta bukti bukan bot atau membatasi jumlah permintaan (HTTP 429).",
    steps: [
      UPLOAD,
      "Atau buat ulang proyeknya nanti.",
      "Pemilik server: kalau terjadi di banyak video, alamat IP server sedang ditandai YouTube. Potongin belum mendukung cookies YouTube.",
    ],
  }),
  download("download_ytdlp_outdated", {
    title: "Pengunduh YouTube perlu diperbarui",
    cause: "YouTube mengubah cara videonya disajikan, dan versi yt-dlp di server belum mengikutinya. Gejalanya: format tidak tersedia, data gagal diekstrak, atau HTTP 403.",
    steps: [
      `Sementara itu, ${UPLOAD.charAt(0).toLowerCase()}${UPLOAD.slice(1)}`,
      "Pemilik server: naikkan versi yt-dlp lewat PR pembaruan mingguan, atau ikuti langkah “YouTube rusak: naikkan yt-dlp” di panduan operasional.",
    ],
  }),
  download("download_stalled", {
    title: "Unduhan macet",
    cause: "Progres unduhan berhenti dan tidak bergerak selama 2 menit (bawaan), jadi worker menghentikan unduhannya. Biasanya koneksi server ke YouTube melambat atau terputus.",
    steps: ["Buat ulang proyeknya beberapa menit lagi.", `Kalau terus macet, ${UPLOAD.charAt(0).toLowerCase()}${UPLOAD.slice(1)}`],
  }),
  download("download_failed", {
    title: "Unduhan gagal karena sebab lain",
    cause: "yt-dlp berhenti dengan pesan yang belum dikenali Potongin.",
    steps: [
      "Buka link-nya di browser dan pastikan videonya bisa diputar.",
      "Buat ulang proyeknya.",
      "Kalau gagal lagi, tempel Detail teknis (Buat Klip) atau Pesan dari server (halaman proyek) ke kolom cari di halaman ini.",
    ],
  }),

  storage("storage_quota_exhausted", {
    title: "Kuota penyimpanan server penuh",
    cause: "Proyek yang tersimpan sudah memakai seluruh kuota penyimpanan job. Potongin tidak pernah menghapus proyek sendiri, jadi job baru ditolak sampai ada ruang.",
    steps: [
      "Unduh klip yang masih dibutuhkan, lalu hapus proyek yang tidak dipakai lagi di Riwayat. Penghapusan ini permanen.",
      "Tekan Periksa lagi di Buat Klip, lalu buat ulang proyeknya.",
      "Pemilik server: naikkan JOBS_STORAGE_QUOTA_BYTES atau perbesar volume penyimpanan.",
    ],
    fragments: ["penyimpanan server tidak cukup", "kuota penyimpanan", "storage quota exhausted"],
  }),
  storage("storage_free_space_low", {
    title: "Ruang kosong disk server terlalu sedikit",
    cause: "Ruang kosong di disk server turun di bawah batas aman. Disk itu juga bisa terisi oleh hal lain di server, bukan hanya proyek Potongin.",
    steps: [
      "Hapus proyek yang tidak dipakai lagi di Riwayat.",
      "Pemilik server: kosongkan disk (misalnya cache build Docker dan image lama) atau perbesar volume, lalu tekan Periksa lagi di Buat Klip.",
    ],
    fragments: ["storage free space", "ruang kosong penyimpanan"],
  }),
  storage("storage_admission_unavailable", {
    title: "Status penyimpanan tidak bisa diperiksa",
    cause: "Server gagal menghitung pemakaian penyimpanan, misalnya karena pemindaian folder job melewati batas waktu atau catatan reservasinya hilang. Job baru ditolak supaya disk tidak penuh tanpa ketahuan.",
    steps: [
      "Tunggu sebentar, tekan Periksa lagi di Buat Klip, lalu coba lagi.",
      "Pemilik server: kalau terus terjadi, periksa log worker. Folder job harus berada di satu mount.",
    ],
    codes: ["storage_admission_unavailable", "storage_admission_lost"],
    fragments: ["pemeriksaan penyimpanan tidak tersedia", "admission reservation was lost", "storage admission"],
    action: BUAT_KLIP,
  }),

  ai("quota_exhausted", {
    title: "Kuota gratis AI habis",
    cause: "Penyedia membatasi jumlah permintaan gratis, biasanya per hari. Model itu dilewati sementara, lalu model atau penyedia berikutnya dicoba.",
    steps: [
      "Tunggu kuota harian pulih.",
      "Tambahkan penyedia gratis lain di Urutan penyedia supaya job berikutnya tetap memakai AI.",
      "Atau isi Model cadangan dengan model gratis lain dari penyedia yang sama.",
    ],
    fragments: ["kuota gratis habis", "kuota", "harus menunggu lama", "quota", "free-models-per-day"],
  }),
  ai("rate_limited", {
    title: "Kena rate limit penyedia AI",
    cause: "Terlalu banyak permintaan dalam waktu singkat untuk model itu (HTTP 429). Potongin menunggu dan mencoba lagi sebelum pindah ke model berikutnya.",
    steps: [
      "Tunggu sebentar, lalu jalankan Tes koneksi lagi.",
      "Turunkan Batas permintaan/menit penyedia itu di Pengaturan.",
      "Tambahkan penyedia gratis lain di Urutan penyedia sebagai cadangan.",
    ],
    fragments: ["kena rate limit", "rate limit", "rate_limit", "free-models-per-min"],
  }),
  ai("auth", {
    title: "API key ditolak",
    cause: "Penyedia menolak API key (HTTP 401 atau 403): key-nya salah, sudah dicabut, atau milik penyedia lain.",
    steps: [
      "Buat key baru di situs penyedia lewat tautan Ambil API key di kartunya.",
      "Tekan Ganti di kolom API key, tempel key baru, lalu Simpan.",
      "Jalankan Tes koneksi.",
    ],
    fragments: ["api key ditolak", "invalid api key", "incorrect api key", "invalid_api_key", "unauthorized"],
  }),
  ai("missing_api_key", {
    title: "API key belum diisi",
    cause: "Penyedia ini butuh API key, tetapi kolomnya kosong. Kalau ada penyedia lain di daftar, penyedia ini dilewati.",
    steps: ["Ambil API key di situs penyedia lewat tautan Ambil API key.", `Tempel di kolom API key. ${TEST_AGAIN}`],
    fragments: ["api key belum diisi", "belum diisi"],
  }),
  ai("key_unreadable", {
    title: "API key tersimpan tidak bisa dibuka",
    cause: "Key disimpan terenkripsi dengan rahasia sesi server (APP_SESSION_SECRET). Kalau rahasia itu berganti, key lama tidak bisa dibuka lagi.",
    steps: [
      "Tekan Isi ulang di kolom API key, tempel key-nya lagi, lalu Simpan.",
      "Pemilik server: jangan ganti APP_SESSION_SECRET kecuali memang perlu.",
    ],
    fragments: ["key tersimpan tidak bisa dibuka"],
  }),
  ai("payment_required", {
    title: "Model butuh kredit berbayar",
    cause: "Model atau penyedia ini tidak gratis, atau Hanya model gratis menyala sementara modelnya berbayar.",
    steps: [
      "Pilih model gratis lewat Ambil daftar model. Di OpenRouter, namanya berakhiran :free.",
      "Atau pakai penyedia gratis lain di Urutan penyedia.",
    ],
    codes: ["payment_required", "not_free"],
    fragments: ["berbayar", "butuh kredit", "hanya-gratis", "tidak punya model gratis", "tidak ada model gratis", "payment required", "insufficient credits"],
  }),
  ai("model_not_found", {
    title: "Model tidak ditemukan",
    cause: "ID modelnya salah atau sudah dipensiunkan penyedia. Untuk model gratis OpenRouter, penyebabnya bisa juga setelan privasi akun yang belum mengizinkan endpoint gratis.",
    steps: [
      "Tekan Ambil daftar model dan pilih model yang tersedia.",
      "OpenRouter: izinkan endpoint gratis di pengaturan privasi akun OpenRouter.",
      TEST_AGAIN,
    ],
    fragments: ["model tidak ditemukan", "tidak ditemukan atau tidak tersedia", "id model mungkin sudah berganti", "model not found", "no endpoints found", "not a valid model"],
  }),
  ai("timeout", {
    title: "AI terlalu lama menjawab",
    cause: "Penyedia tidak menjawab dalam batas waktu permintaan, atau seluruh pemilihan momen dengan AI melewati 20 menit. Momen lalu dipilih tanpa AI.",
    steps: [
      "Naikkan Batas waktu (detik) penyedia itu.",
      "Untuk model reasoning, set Penalaran (reasoning effort) ke none supaya jawabannya jauh lebih cepat.",
      "Atau pilih model atau penyedia yang lebih cepat.",
    ],
    codes: ["timeout", "deadline"],
    fragments: ["batas waktu", "tidak menjawab", "tidak selesai memilih momen", "timed out", "timeout"],
  }),
  ai("network", {
    title: "Server penyedia tidak bisa dihubungi",
    cause: "Server Potongin gagal terhubung ke alamat penyedia: Base URL salah, server sendiri (misalnya Hermes, 9Router atau Ollama) mati, atau koneksi internet server terputus.",
    steps: [
      "Periksa Base URL di kartu penyedia.",
      "Untuk server sendiri, pastikan servernya menyala dan bisa dicapai dari server Potongin.",
      "Jalankan Tes koneksi lagi.",
    ],
    fragments: ["tidak bisa dihubungi", "tidak bisa terhubung", "connection refused", "econnrefused", "name or service not known"],
  }),
  ai("context_length", {
    title: "Transkrip terlalu panjang untuk model",
    cause: "Potongan transkrip yang dikirim melebihi batas konteks model, atau permintaannya terlalu besar untuk penyedia (HTTP 413).",
    steps: [
      "Turunkan Batas konteks (token) penyedia itu sampai sesuai batas modelnya.",
      "Atau pilih model dengan konteks lebih panjang.",
    ],
    codes: ["context_length", "too_large"],
    fragments: ["terlalu panjang untuk model", "terlalu besar untuk", "context length", "context_length_exceeded", "too many tokens", "request too large"],
  }),
  ai("context_too_small", {
    title: "Batas konteks terlalu kecil",
    cause: "Batas konteks yang diatur terlalu kecil untuk memuat instruksi dan potongan transkrip sekaligus.",
    steps: ["Naikkan Batas konteks (token), atau turunkan Maks. token jawaban.", TEST_AGAIN],
    fragments: ["anggaran konteks", "konteks llm terlalu kecil"],
  }),
  ai("truncated", {
    title: "Jawaban AI terpotong",
    cause: "Model mencapai batas token jawaban sebelum selesai. Model reasoning paling sering kena karena fase berpikirnya ikut memakai token.",
    steps: ["Naikkan Maks. token jawaban.", "Untuk model reasoning, set Penalaran (reasoning effort) ke none."],
    fragments: ["jawaban terpotong", "terpotong karena batas token", "terpotong"],
  }),
  ai("bad_response", {
    title: "Jawaban AI tidak bisa dibaca",
    cause: "Model menjawab, tetapi bukan JSON yang diminta, atau respons servernya rusak.",
    steps: ["Ubah Mode JSON penyedia itu (Aktif atau Nonaktif), lalu jalankan Tes koneksi.", "Kalau tetap gagal, pilih model lain."],
    codes: ["bad_response", "bad_json", "unexpected_reply"],
    fragments: ["bukan json", "json yang valid", "objek json", "model menjawab json", "tidak bisa dibaca"],
  }),
  ai("content_filter", {
    title: "Jawaban diblokir filter konten",
    cause: "Filter keamanan penyedia memblokir jawaban model, biasanya karena isi transkripnya dianggap sensitif.",
    steps: ["Pindahkan penyedia lain ke urutan teratas, atau pilih model lain."],
    fragments: ["filter konten", "content filter", "content_filter"],
  }),
  ai("no_moments", {
    title: "AI tidak menemukan momen yang valid",
    cause: "AI menjawab, tetapi tidak satu pun momennya muat di batas durasi klip setelah dirapikan ke batas kalimat.",
    steps: [
      "Longgarkan durasi minimum dan maksimum klip di Buat Klip.",
      "Periksa videonya: video dengan sedikit ucapan memberi sedikit bahan untuk AI.",
    ],
    fragments: ["tidak memberi satu pun momen", "tidak ada momen llm"],
    action: BUAT_KLIP,
  }),
  ai("config_invalid", {
    title: "Pengaturan AI tidak valid",
    cause: "Ada isian penyedia yang ditolak, misalnya Base URL tidak valid, ID model berisi spasi, atau angka di luar rentang.",
    steps: ["Buka Pengaturan dan perbaiki isian yang ditandai.", TEST_AGAIN],
    codes: ["config_invalid", "unknown_provider"],
    fragments: ["konfigurasi penyedia ini tidak valid", "konfigurasi llm tidak valid", "pengaturan ai tidak valid", "penyedia tidak dikenal", "tidak dikenal"],
  }),
  ai("not_configured", {
    title: "AI mati atau belum diatur",
    cause: "AI dimatikan di Pengaturan, atau belum ada penyedia yang lengkap. Momen dipilih dengan heuristik lokal.",
    steps: [
      "Nyalakan Aktifkan AI (LLM) di Pengaturan.",
      "Tambah minimal satu penyedia gratis dan isi API key-nya.",
      TEST_AGAIN,
    ],
    codes: ["not_configured", "disabled"],
    aliases: ["llm_unavailable"],
    fragments: ["penyedia belum lengkap atau key tersimpan tidak bisa dibuka", "penyedia belum lengkap", "ai sedang dimatikan", "ai dimatikan", "llm dimatikan", "belum dikonfigurasi", "belum diatur"],
  }),
  ai("http", {
    title: "Penyedia AI mengembalikan error",
    cause: "Penyedia menjawab dengan kode HTTP lain. Kode 5xx berarti server penyedia sedang bermasalah; kode 4xx biasanya karena pengaturan.",
    steps: ["Untuk 5xx: tunggu sebentar, lalu jalankan Tes koneksi lagi.", "Untuk 4xx: periksa model, Base URL dan Mode JSON, lalu jalankan Tes koneksi."],
    codes: ["unknown"],
    fragments: ["server penyedia sedang error", "penyedia menolak permintaan", "mengembalikan http", "tes gagal (kode"],
  }),
];

const QUOTES = /["'`‘’‚‛“”„‟«»]/g;

/** The text as the search compares it: NFKC, lower case, no quote marks, single spaces. */
export function normalizeErrorText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").toLowerCase().replace(QUOTES, "").replace(/\s+/g, " ").trim();
}

const fragmentText = (value) => normalizeErrorText(value).replace(/[.!?]+$/, "");

function freezeEntry({ id, group, title, cause, steps, shown = [], codes = [id], aliases = [], fragments = [], action = null }) {
  return Object.freeze({
    id, group, title, cause, action,
    steps: Object.freeze([...steps]),
    shown: Object.freeze([...shown]),
    codes: Object.freeze([...codes]),
    aliases: Object.freeze([...aliases]),
    fragments: Object.freeze([...fragments]),
  });
}

export const HELP_ENTRIES = Object.freeze(ENTRIES.map(freezeEntry));

// Every name an entry answers to: its id, its codes (AI codes also as llm_<code>) and aliases.
const BY_CODE = new Map();
for (const entry of HELP_ENTRIES) {
  const names = [entry.id, ...entry.codes, ...entry.aliases, ...(entry.group === "ai" ? entry.codes.map((code) => `llm_${code}`) : [])];
  for (const name of new Set(names)) {
    if (BY_CODE.has(name) && BY_CODE.get(name) !== entry) throw new Error(`help code ${name} has two entries`);
    BY_CODE.set(name, entry);
  }
}

const ANCHOR = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const ANCHORS = new Map(HELP_ENTRIES.map((entry) => [
  entry,
  Object.freeze([entry.id, ...[...BY_CODE].filter(([name, owner]) => owner === entry && name !== entry.id && ANCHOR.test(name)).map(([name]) => name)]),
]));

/** The element ids the page gives an entry: its id first, then every other code that is a safe id. */
export function helpAnchors(entry) {
  return ANCHORS.get(entry) ?? [];
}

const WRAPPED = /^llm_(?:failed|unavailable):([a-z0-9_]+)$/;
const HTTP_STATUS = /^(?:llm_)?http_\d{3}$/;

/** The entry for a code as the system writes it ("download_private", "quota_exhausted", "llm_failed:deadline", "http_503"), or null. */
export function helpEntry(code) {
  if (typeof code !== "string") return null;
  let name = code.trim().toLowerCase();
  name = WRAPPED.exec(name)?.[1] ?? name;
  if (HTTP_STATUS.test(name)) name = "llm_http";
  return BY_CODE.get(name) ?? null;
}

/** "/bantuan#<anchor>" for a code with an entry, else null. */
export function helpHref(code) {
  const entry = helpEntry(code);
  return entry ? `${HELP_PATH}#${entry.id}` : null;
}

const DOWNLOAD_CODES = new Set(DOWNLOAD_ERROR_CODES);
const STORAGE_CODES = new Set(STORAGE_ERROR_CODES);

/** The help link for a storage admission code (the dashboard's banner, a refused job), else null. */
export function storageHelpHref(code) {
  return STORAGE_CODES.has(code) ? helpHref(code) : null;
}

/** The help link for a failed job whose failure has a code (download or storage), else null. */
export function jobHelpHref(job) {
  if (job?.status !== "failed") return null;
  if (DOWNLOAD_CODES.has(job.errorCode)) return helpHref(job.errorCode);
  return storageHelpHref(typeof job.error === "string" ? job.error.trim() : null);
}

/**
 * The help link for an AI fallback, from the selection summary's warnings: the first reason
 * with an entry ("llm_unavailable:<code>", "llm_failed:<code>"), else AI off or not set up.
 */
export function llmWarningHelpHref(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter((item) => typeof item === "string") : [];
  const reasons = [
    ...list.filter((item) => /^llm_(?:unavailable|failed):/.test(item)),
    ...list.filter((item) => /^llm_(?:unavailable|disabled|not_configured)$/.test(item)),
  ];
  for (const reason of reasons) {
    const href = helpHref(reason);
    if (href) return href;
  }
  return null;
}

// --- Search ------------------------------------------------------------------------------------

// A code the text marks as one: "[quota_exhausted]", "kode: timeout", "#download_private",
// "llm_failed:rate_limited". Single-word codes count only here; "timeout" in a sentence is a word.
const MARKED_CODE = /\[([a-z0-9_:]+)\]|\b(?:kode|code)\s*[:=]\s*([a-z0-9_:]+)|#([a-z0-9_]+)|\b(llm_(?:failed|unavailable):[a-z0-9_]+)/g;
const BARE_CODE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

function codeIn(text) {
  for (const match of text.matchAll(MARKED_CODE)) {
    const entry = helpEntry(match.slice(1).find(Boolean));
    if (entry) return entry;
  }
  for (const [name] of text.matchAll(BARE_CODE)) {
    const entry = helpEntry(name);
    if (entry) return entry;
  }
  return null;
}

const FRAGMENTS = new Map(HELP_ENTRIES.map((entry) => [
  entry,
  [...new Set([...entry.shown, ...entry.fragments].map(fragmentText).filter(Boolean))],
]));
const PATTERNS = new Map(DOWNLOAD_ERROR_PATTERNS.map(([code, pattern]) => [code, new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)]));

// How much of the text an entry's known fragments (and, for a download code, the classifier's
// pattern) account for: the longest, most specific evidence wins. A fragment inside a longer
// hit of the same entry is not counted twice.
function fragmentScore(entry, text) {
  const hits = FRAGMENTS.get(entry).filter((fragment) => text.includes(fragment));
  let score = hits
    .filter((fragment) => !hits.some((other) => other !== fragment && other.includes(fragment)))
    .reduce((sum, fragment) => sum + fragment.length, 0);
  const pattern = PATTERNS.get(entry.id);
  if (pattern) for (const [match] of text.matchAll(pattern)) score += match.length;
  return score;
}

function bestBy(score) {
  let best = null;
  let bestScore = 0;
  for (const entry of HELP_ENTRIES) {
    const value = score(entry);
    if (value > bestScore) [best, bestScore] = [entry, value];
  }
  return best;
}

const STOPWORDS = new Set(["yang", "dan", "ini", "itu", "untuk", "dengan", "dari", "atau", "ada", "apa", "saat", "bisa", "tidak", "sudah", "the", "and", "for", "with", "this", "that", "error", "gagal"]);
const WORDS = new Map(HELP_ENTRIES.map((entry) => [
  entry,
  normalizeErrorText([entry.id, entry.title, entry.cause, ...entry.steps, ...entry.shown, ...entry.codes, ...entry.fragments].join(" ")),
]));

// Last resort for loose words: the entry whose text holds most of them (at least 60 %).
function wordsScore(entry, words) {
  const hits = words.filter((word) => WORDS.get(entry).includes(word)).length;
  return hits / words.length >= 0.6 ? hits : 0;
}

/**
 * The entry that best explains a pasted error, as `{ entry, by }`: by "code" when the text names
 * one, else by "text" (known message fragments), else by "words"; null when nothing fits.
 */
export function findHelpEntry(value) {
  if (typeof value !== "string") return null;
  const text = normalizeErrorText(value.slice(-MAX_HELP_QUERY));
  if (!text) return null;
  const coded = codeIn(text);
  if (coded) return { entry: coded, by: "code" };
  const quoted = bestBy((entry) => fragmentScore(entry, text));
  if (quoted) return { entry: quoted, by: "text" };
  const words = [...new Set(text.match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((word) => !STOPWORDS.has(word));
  const loose = words.length ? bestBy((entry) => wordsScore(entry, words)) : null;
  return loose ? { entry: loose, by: "words" } : null;
}
