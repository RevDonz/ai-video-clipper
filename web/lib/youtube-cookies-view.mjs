// The Pengaturan "Cookies YouTube" card, DOM-free: the state from GET /api/settings/youtube-cookies,
// the card's copy and its messages (web/lib/youtube-cookies.mjs is the server side).

// Equal to MAX_COOKIES_FILE_BYTES on the server (by test); checked before a file goes out.
export const MAX_COOKIES_UPLOAD_BYTES = 1024 * 1024;
export const COOKIES_ACCEPT = ".txt,text/plain";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROBLEMS = new Set(["unreadable", "corrupt", "secret_missing"]);
const SESSION_TEXT = "Sesi login berakhir. Muat ulang halaman untuk masuk lagi.";

function validCookies(cookies) {
  return Boolean(cookies) && typeof cookies === "object" && Number.isSafeInteger(cookies.count) && cookies.count >= 1
    && typeof cookies.signedIn === "boolean" && typeof cookies.uploadedAt === "string" && ISO_TIME.test(cookies.uploadedAt);
}

/** `{cookies: {count, signedIn, uploadedAt} | null, problem, secretConfigured}` from an answer. */
export function youtubeCookiesState(payload) {
  const cookies = validCookies(payload?.cookies)
    ? { count: payload.cookies.count, signedIn: payload.cookies.signedIn, uploadedAt: payload.cookies.uploadedAt }
    : null;
  return {
    cookies,
    problem: PROBLEMS.has(payload?.problem) ? payload.problem : null,
    secretConfigured: payload?.secretConfigured === true,
  };
}

const count = (value) => value.toLocaleString("id-ID");

export function youtubeCookiesCopy() {
  return {
    where: "Dipakai pengunduh saat YouTube meminta login atau menahan unduhan dari server.",
    hint: "File cookies.txt (format Netscape) dari browser yang sudah masuk ke YouTube. Maksimal 1 MB.",
    notSignedIn: "Tidak ada cookie login di file ini. Masuk ke YouTube dulu, lalu ekspor ulang.",
    unreadable: "Cookies tersimpan tidak bisa dibuka. Unggah ulang.",
    secretMissing: "Kunci enkripsi pengaturan belum tersedia di server, jadi cookies belum bisa disimpan.",
    facts: [
      "Pakai akun Google terpisah, bukan akun utama Anda.",
      "Disimpan terenkripsi. Isinya tidak ditampilkan lagi dan hanya dipakai saat video diunduh.",
      "Cookies bisa kedaluwarsa. Kalau unduhan ditahan lagi, ekspor ulang lalu unggah.",
    ],
  };
}

/** "42 cookie tersimpan". */
export function cookiesCountText(cookies) {
  return `${count(cookies.count)} cookie tersimpan`;
}

/** "Diunggah 21 Okt 2026, 15.00", or null for a date the browser cannot read. */
export function cookiesUploadedText(cookies) {
  const date = new Date(cookies?.uploadedAt ?? "");
  if (Number.isNaN(date.getTime())) return null;
  return `Diunggah ${date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}`;
}

const ERRORS = Object.freeze({
  cookies_json: "File ini berformat JSON. Ekspor ulang sebagai cookies.txt (format Netscape).",
  cookies_utf16: "File ini tersimpan sebagai UTF-16. Simpan ulang sebagai UTF-8, lalu unggah lagi.",
  cookies_not_text: "File ini bukan teks. Pilih file cookies.txt.",
  cookies_not_netscape: "Isinya bukan cookies.txt format Netscape (tujuh kolom dipisah tab).",
  cookies_empty: "File ini tidak berisi cookie.",
  cookies_no_youtube: "Tidak ada cookie YouTube di file ini. Ekspor saat youtube.com terbuka.",
  cookies_expired: "Semua cookie YouTube di file ini sudah kedaluwarsa. Ekspor ulang.",
  cookies_too_large: "File terlalu besar. Maksimal 1 MB.",
  unsupported_media_type: "File harus berupa teks cookies.txt.",
  secret_missing: "Kunci enkripsi pengaturan belum tersedia di server.",
  settings_unavailable: "Folder pengaturan di server belum bisa dipakai.",
  csrf_rejected: "Permintaan ditolak. Muat ulang halaman, lalu coba lagi.",
});

/** The message of a refused upload or removal: `{status, code}` from the answer (status 0: offline). */
export function cookiesErrorMessage({ status, code } = {}) {
  if (status === 401) return SESSION_TEXT;
  if (status === 0) return "Koneksi terputus. Coba lagi.";
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : "Cookies gagal disimpan. Coba lagi.";
}

/** "42 cookie YouTube tersimpan." plus what the check dropped. */
export function cookiesSavedMessage({ cookies, skipped }) {
  const dropped = [
    skipped?.otherSites > 0 ? `${count(skipped.otherSites)} dari situs lain` : null,
    skipped?.expired > 0 ? `${count(skipped.expired)} kedaluwarsa` : null,
    skipped?.invalid > 0 ? `${count(skipped.invalid)} baris rusak` : null,
  ].filter(Boolean);
  const saved = `${count(cookies.count)} cookie YouTube tersimpan.`;
  return dropped.length ? `${saved} Dibuang: ${dropped.join(", ")}.` : saved;
}
