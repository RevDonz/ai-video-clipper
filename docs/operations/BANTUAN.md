# Halaman bantuan (`/bantuan`): satu entri per kode error

Terakhir diperbarui: 2026-10-21.

`/bantuan` menjelaskan setiap kode error yang bisa ditemui pengguna: judul, pesan yang tampil di
layar (kalau ada), penyebab, dan langkah perbaikan. Halaman ini di balik login seperti halaman
lain (`web/proxy.js`) dan bisa dibuka dari tautan "Bantuan" di header.

## Satu sumber kebenaran

Semua entri ada di `web/lib/help-catalog.mjs`. Kodenya diambil dari tiga tempat, dan tes gagal
kalau ada kode tanpa entri:

| Sumber kode | Konstanta | Jangkar | Tes yang menjaga |
|---|---|---|---|
| Unduhan YouTube | `DOWNLOAD_ERROR_CODES` di `web/lib/download-errors.mjs` | `#<kode>`, mis. `#download_bot_check` | `web/tests/help-catalog.test.mjs` |
| Penyimpanan server | `STORAGE_ERROR_CODES` di `web/lib/dashboard-view.mjs` (+ `storage_admission_lost` dari editor) | `#<kode>`, mis. `#storage_quota_exhausted` | `web/tests/help-catalog.test.mjs` |
| AI (LLM) | `ERROR_CODES` di `src/ai_clipper/llm.py`, `CHECK_CODES` di `web/lib/llm-settings-actions.mjs`, peringatan `llm_failed:<kode>`/`llm_unavailable`/`llm_disabled`/`llm_not_configured` dari `pipeline.py` dan `selection_v3.py` | `#llm_<kode>`, mis. `#llm_quota_exhausted` | `tests/test_llm_error_codes.py` (daftar `ERROR_CODES` cocok dengan semua `LLMError(...)` di paket) dan `web/tests/help-catalog.test.mjs` (setiap kode punya entri) |

Kode AI diberi awalan `llm_` karena kode mesinnya (`timeout`, `auth`, `network`) terlalu umum
untuk berdiri sendiri di URL. Beberapa kode berbagi satu entri (mis. `bad_json`, `bad_response`
dan `unexpected_reply`; semua `http_<status>`); setiap kode lain yang aman jadi id tetap mendapat
jangkar sendiri di entri itu, jadi `/bantuan#llm_bad_json` juga mendarat di entri yang benar.

### Menambah kode baru

1. Tambahkan kodenya di sumbernya (mis. `PATTERNS` dan `MESSAGES` di `download-errors.mjs`, atau
   `LLMError("kode_baru", ...)` lalu `ERROR_CODES` di `llm.py`).
2. Tambahkan entri di `ENTRIES` (`help-catalog.mjs`): judul, penyebab, 1–4 langkah, dan potongan
   pesan yang dikenal (`fragments`) kalau pesannya tidak memuat kodenya.
3. Jalankan `uv run pytest tests/test_llm_error_codes.py` dan
   `cd web && node --test tests/help-catalog.test.mjs`.

## Kolom cari

Pengguna menempelkan teks error; entri yang paling cocok terbuka (alamatnya mendapat `#<kode>`,
entrinya naik ke permukaan bertepi terang dan mendapat fokus). Urutannya:

1. **Kode.** Kode yang ditandai (`[quota_exhausted]`, `kode: timeout`, `#download_private`,
   `llm_failed:rate_limited`) menang, lalu token bergaris bawah apa pun yang dikenal
   (`download_bot_check`, `http_503`). Kode satu kata (`timeout`) hanya dihitung kalau ditandai.
2. **Potongan pesan.** Pesan yang tampil di layar, pesan mesin, dan balasan penyedia yang umum,
   ditambah pola klasifikasi unduhan dari `download-errors.mjs`. Entri dengan bukti terpanjang
   menang.
3. **Kata.** Kalau tidak ada yang cocok, entri yang memuat paling sedikit 60 % kata pencarian.

Teks dibandingkan tanpa beda huruf besar, tanda kutip, atau spasi ganda. Tempelan panjang hanya
dibaca 4000 karakter terakhirnya, tempat log menaruh baris error.

Tanpa JavaScript, form-nya GET ke `/bantuan?q=…`; server mengarahkan ke `/bantuan#<kode>` entri
yang cocok, atau menampilkan "Belum ada entri yang cocok" dengan teks yang sama di kolom cari.
Jangkar `#<kode>` bekerja tanpa JavaScript.

## Tautan "Cara memperbaiki"

- **Buat Klip:** kotak gagal job dengan kode unduhan atau penyimpanan, banner penyimpanan, dan
  pesan job yang ditolak karena penyimpanan.
- **Halaman proyek:** pemberitahuan "Proses gagal" untuk kode unduhan atau penyimpanan, dan
  "AI gagal dipakai" untuk alasan AI yang tercatat di peringatan job.
- **Pengaturan:** hasil Tes koneksi yang gagal.

Kegagalan tanpa kode (mis. render gagal) tidak mendapat tautan; teks teknisnya tetap di "Detail
teknis" dan "Pesan dari server", dan bisa ditempel ke kolom cari.
