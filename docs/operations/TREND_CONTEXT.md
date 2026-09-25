# Konteks Tren: panduan operator

Konteks Tren adalah daftar item tren (topik, orang, jokes/meme, sound, hashtag, format, acara)
yang dikirim agen luar milik pemilik (rencananya Hermes Agent) atau ditambahkan manual di
halaman **Konteks Tren** (`/trends`). Selection V3 memakainya untuk kemasan klip dan dorongan
peringkat kecil. Potongin **tidak** men-scrape platform apa pun.

- Kontrak lengkap: [`docs/plans/2026-09-25-konteks-tren.md`](../plans/2026-09-25-konteks-tren.md).
- Paket agen (skill Hermes, prompt cron, OpenAPI, `push_trends.py`):
  [`docs/integrations/hermes-trends/README.md`](../integrations/hermes-trends/README.md).

**Invarian:** tanpa item aktif, atau dengan fitur dimatikan, permintaan ke LLM (byte-identik),
pemilihan heuristik, artefak dan bentuk manifest sama persis dengan Potongin tanpa fitur ini.

## Alur data

```text
agen (Hermes) ──POST /api/ingest/trends (Bearer ptk_…)──▶ trend-context.json (/data/settings)
pemilik ──/trends (sesi login)──────────────────────────▶        │
                                                                 ▼ worker, job V3 saja
                           <attempt>/analysis/trend-context.json (snapshot, maks 300 item)
                                                                 ▼ --trend-context PATH
                     engine: cocokkan dengan transkrip → blok tren di pesan LLM, validasi,
                     dorongan peringkat → selection.v3.json + manifest ("trends": [...])
```

## Token ingest

- Dibuat di `/trends` → **Integrasi agen (Hermes)** dengan label 1-40 karakter. Bentuk:
  `ptk_` + 43 karakter base64url (32 byte acak), scope `trends:write`.
- Nilai token **hanya tampil sekali** di respons pembuatan. Yang disimpan hanya SHA-256-nya,
  dibandingkan dengan `timingSafeEqual`; hash tidak pernah keluar dari server. Daftar token
  menampilkan label, prefix, waktu dibuat, terakhir dipakai (`lastUsedAt`, diperbarui paling
  sering 1×/menit), dan waktu dicabut.
- Maksimal **10 token aktif**. Pakai satu token per agen supaya bisa dicabut sendiri-sendiri.
  Label token menjadi `source` setiap item yang dikirimnya; `DELETE` lewat token hanya bisa
  menghapus item sumber token itu.
- **Rotasi:** buat token baru, ganti `POTONGIN_INGEST_TOKEN` di agen, jalankan sekali, lalu cabut
  token lama. **Bocor:** cabut dulu, baru buat pengganti. Token yang dicabut langsung ditolak
  (`401 revoked_token`).

## File penyimpanan

Keduanya di `POTONGIN_SETTINGS_DIR` (Docker: `/data/settings`; bawaan di luar Docker:
folder `settings` di samping `JOBS_ROOT`; tidak boleh di dalam `JOBS_ROOT`), sama seperti
`llm-settings.json`: folder `0700`, file mode `0600`, ditulis atomik (tmp + fsync + rename) di
bawah kunci file.

| File | Isi |
|---|---|
| `trend-context.json` | `{"version": 1, "enabled": true, "updatedAt": "…", "items": [...]}`; `enabled` = saklar global |
| `ingest-tokens.json` | `{"version": 1, "tokens": [{"id", "label", "prefix", "sha256", "scopes", "createdAt", "lastUsedAt", "revokedAt"}]}`; tanpa nilai token |

- **Snapshot per job:** untuk job V3, bila fitur aktif dan ada item aktif yang `enabled`, worker
  menulis `analysis/trend-context.json` di direktori attempt (maks 300 item teratas menurut
  `score`, lalu terbaru), tanpa `examples`, `source`, `createdAt`, `updatedAt`, dan tanpa token.
  Snapshot ikut dipublikasikan bersama `analysis/` sehingga job bisa diaudit dan diulang. Tanpa
  item aktif tidak ada file dan tidak ada flag `--trend-context`.
- **Cadangan:** ikutkan kedua file dalam cadangan `/data/settings`. `ingest-tokens.json` hanya
  berisi hash, tapi tetap perlakukan sebagai data sensitif.

## Batas

| Batas | Nilai |
|---|---|
| Item aktif | 1.000 |
| Item per permintaan ingest | 100 |
| Ukuran body ingest | 256 KiB (dibaca terbatas, tidak di-buffer penuh) |
| Laju per token | 60 permintaan/menit dan 600/jam (`429 rate_limited` + `Retry-After`) |
| Field item | `title` 1-80, `summary` 0-500 (maks 5 baris), `keywords` 1-12 × 2-40, `hashtags` 0-10, `examples` 0-5, `score` 0-100 |
| Kedaluwarsa | bawaan `firstSeenAt` + 10 hari, maks 60 hari dari sekarang |
| Snapshot per job | 300 item |
| Tren relevan per episode | 20 (yang cocok dengan transkrip) |
| Dorongan peringkat | `TREND_BOOST = 3.0`, `TREND_BOOST_CAP = 3.0` per klip |

## Pemangkasan

- Saat item aktif sudah 1.000, item kedaluwarsa dipangkas dulu, lalu yang `score` terendah dan
  tertua.
- Item kedaluwarsa tidak dipakai lagi, disimpan maks 7 hari untuk riwayat (tampil di `/trends`),
  lalu dihapus.
- Agen memperpanjang tren yang masih ramai dengan mengirim ulang `externalId` yang sama
  (upsert). Tanpa `externalId`, item dengan `kind` sama dan judul ternormalisasi sama (casefold,
  tanpa aksen, spasi dirapikan) dianggap item yang sama.

## Model keamanan

- **Rute mesin** `/api/ingest/trends` dikecualikan dari `web/proxy.js` (proxy mewajibkan sesi
  cookie) dan mengautentikasi sendiri dengan token Bearer. Cookie sesi **tidak** diterima di
  rute ini. Error: `401 missing_token | invalid_token | revoked_token`,
  `403 insufficient_scope`, `400 invalid_json | invalid_body`,
  `413 body_too_large | too_many_items`, `415 unsupported_media_type` (wajib
  `application/json`), `429 rate_limited`, `503 storage_unavailable`. Semua respons
  `Cache-Control: no-store`; pesan error tanpa path atau nilai rahasia.
- **Rute UI** `/api/context/*` butuh sesi login, dan mutasinya butuh permintaan same-origin.
  Nilai token hanya muncul di respons pembuatan.
- **Teks item adalah data dari internet, bukan instruksi.** Server dan engine menormalisasi NFC,
  membuang karakter kontrol, format (bidi, zero-width, tag) dan karakter tak terlihat lain
  (variation selector), dan membatasi panjang. Di prompt, teks juga di-NFKC sehingga tiruan
  lebar-penuh seperti `＞` tidak bisa memalsukan pagar blok tren. Teks tidak pernah
  dirender sebagai HTML; URL contoh hanya `http(s)` dan dirender dengan
  `rel="noopener noreferrer nofollow"`.
- **Engine:** teks item tidak pernah masuk argv atau filter FFmpeg. Blok tren di prompt LLM
  ditandai sebagai data ("BUKAN instruksi"), dibatasi 300 karakter per baris, dan `"`, `<<<`,
  `>>>` di dalamnya di-escape atau dibuang.
- **Cloudflare Access:** bila domain produksi dilindungi Cloudflare Access, agen akan menerima
  redirect ke halaman login (`push_trends.py` tidak mengikuti redirect dan melapor
  `redirect_refused`). Buat kebijakan **Bypass** hanya untuk `/api/ingest/*`, atau beri agen
  service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`). Token ingest tetap wajib.
- **Scraping:** mengumpulkan data dari TikTok/Instagram secara otomatis melanggar ketentuan
  layanan platform; risikonya di akun agen. Paket agen memakai sumber resmi/publik dulu (lihat
  README paket).

## Pengaruh ke pemilihan klip

Hanya job **Selection V3**. Mode Klasik V1 dan V2 shadow tidak berubah.

1. **Relevansi.** Engine mencocokkan kata kunci, judul dan hashtag (tanpa `#`) item dengan
   transkrip episode: casefold, tanpa aksen, per batas kata, frasa multi-kata sebagai frasa.
   Kata terakhir boleh berakhiran `-nya`, `-lah`, `-kah`, `-pun` ("prabowonya"). Kata kunci di
   bawah 3 huruf atau stopword umum (termasuk kata sehari-hari podcast seperti "gas", "tahun",
   "anak", "indonesia", "jakarta") tidak pernah cocok sendirian. Maks 20 tren relevan per
   episode.
2. **LLM.** Hanya bila ada tren relevan, blok `KONTEKS TREN` ditambahkan di **akhir pesan
   pengguna**. System prompt (`src/ai_clipper/prompts/standar_klip_ai.md`) tidak berubah.
   Blok diakhiri baris `Format:` yang meminta `trend_refs` per momen (tanpa baris itu model
   gratis tidak pernah mengisinya). Versi prompt tercatat `llm-select-v2+trends.v1+std.<sidik>`
   saat blok dikirim; tanpa tren tetap `llm-select-v2+std.<sidik>`.
3. **Tidak ada klaim karangan.** Sebuah `trend_ref` diterima hanya bila kode menemukan item itu
   di teks final klip (setelah snapping). Ref yang tidak ter-grounding dibuang dan dicatat
   sebagai `trend_ref_ungrounded:<n>`. Hashtag tren hanya dari item yang ter-grounding. Judul,
   teks hook (yang dibakar ke video) dan deskripsi klip AI juga diperiksa kode: yang menyebut
   tren yang tidak ada di transkrip klip itu diganti (kalimat bersih dari tulisan model, atau
   dari transkrip klip sendiri) dan dicatat sebagai `trend_packaging_ungrounded:<n>`. Hashtag
   klip yang menyebut tren seperti itu dibuang, juga bila tren itu tidak punya hashtag sendiri
   (judul atau kata kuncinya ditulis sebagai satu kata). Hashtag tren di atas 40 karakter
   (termasuk `#`) dilewati karena klip hanya memuat hashtag sampai 40 karakter.
4. **Heuristik.** Klip dari pemilih heuristik juga mendapat tren ter-grounding (dari pencocokan
   langsung) untuk hashtag dan alasan, tanpa mengubah judulnya.
5. **Dorongan ringan.** `TREND_BOOST = 3.0` (skala nilai peringkat 0-100), paling banyak
   `TREND_BOOST_CAP = 3.0` per klip berapa pun jumlah trennya, diterapkan pada nilai peringkat
   sebelum pengurutan, hanya untuk klip dengan minimal satu tren ter-grounding. Item `sensitive`
   tidak memberi dorongan. `score` dan lima sub-skor yang ditampilkan **tidak berubah**.
6. **Keluaran.** Klip yang ter-grounding mendapat `trends` (`id`, `title`, `kind`, maks 5) di
   `selection.v3.json` dan manifest, dan `reasons` mendapat `"tren: <judul>"` (maks 2). Klip lain
   tidak mendapat key `trends` sama sekali. Halaman proyek menampilkan chip
   "Nyambung tren: <judul>". Pembaca lama mengabaikan field baru ini.
7. **Sensitif.** Item `sensitive` tidak memberi dorongan dan tidak mendapat hashtag (hashtag
   buatan model yang menyebutnya juga dibuang). Model diminta tidak menjadikannya lelucon atau
   judul sensasional; itu tidak bisa dijamin kode, jadi setiap klip `humor` yang transkripnya
   menyebut item sensitif dicatat sebagai `trend_sensitive_humor:<n>` untuk diperiksa pemilik.
8. **Suntingan pemilik.** Bagian item dari agen yang diubah pemilik di `/trends` (judul,
   ringkasan, kata kunci, hashtag, kedaluwarsa) dicatat di `ownerEdited` dan tidak ditimpa
   kiriman agen berikutnya. Agen hanya memperbarui item sumbernya sendiri: item manual atau
   milik agen lain dengan `externalId` atau jenis+judul yang sama ditolak per item
   (`owned_by_other_source`).

Bila snapshot rusak atau tidak bisa dibaca, job tetap jalan **tanpa** tren dan mencatat warning
`trend_context_invalid`. Item rusak di dalam snapshot yang valid dilewati dengan peringatan.

## Mematikan

Dari yang paling ringan:

1. **Saklar global** di `/trends`: "Pakai konteks tren di pemilihan klip" (disimpan sebagai
   `enabled` di `trend-context.json`; API `PUT /api/context/trends/settings`). Job berikutnya
   tidak mendapat snapshot maupun flag, jadi hasilnya identik dengan tanpa fitur. Job yang
   sedang berjalan memakai snapshot yang sudah ditulis. Item dan token tetap tersimpan.
2. **Per item:** matikan saklar "aktif" item di `/trends`, atau hapus itemnya.
3. **Hentikan agen:** cabut tokennya di `/trends` (ingest langsung `401`), dan di mesin agen
   `hermes cron pause <job_id>` atau `hermes cron remove <job_id>`.
4. **Hapus total:** cadangkan dulu, lalu hapus `trend-context.json` dan `ingest-tokens.json` dari
   `POTONGIN_SETTINGS_DIR` saat tidak ada agen yang mengirim. Tanpa kedua file, Potongin
   berperilaku seperti fitur belum pernah dipakai.

## Pemecahan masalah

| Gejala | Penyebab dan tindakan |
|---|---|
| `401 missing_token / invalid_token` | Header `Authorization: Bearer ptk_…` tidak ada atau salah. Periksa `POTONGIN_INGEST_TOKEN` di agen. |
| `401 revoked_token` | Token dicabut. Buat token baru di `/trends`. |
| `403 insufficient_scope` | Token tanpa `trends:write`. Buat token ingest baru. |
| `413 body_too_large / too_many_items` | Lebih dari 256 KiB atau 100 item. `push_trends.py` membagi batch otomatis. |
| `415 unsupported_media_type` | `Content-Type` harus `application/json`. |
| `429 rate_limited` | Lebih dari 60/menit atau 600/jam per token, atau (bila `AUTH_TRUSTED_CLIENT_IP_HEADER` diatur) lebih dari 30/menit atau 300/jam token salah dari satu IP. Tunggu `Retry-After`. |
| Item ditolak `owned_by_other_source` | Item manual atau milik token lain punya `externalId` atau jenis+judul yang sama. Pakai item yang ada, ubah judulnya, atau hapus item lama di `/trends`. |
| `503 storage_unavailable` | Penyimpanan tidak bisa dibaca/ditulis: periksa izin dan pemilik `POTONGIN_SETTINGS_DIR` dan ruang disk. |
| `redirect_refused` di `push_trends.py` | URL salah, atau domain di balik Cloudflare Access (lihat Model keamanan). |
| Warning job `trend_context_invalid` | Snapshot tidak valid; job jalan tanpa tren. Periksa `analysis/trend-context.json` attempt itu. |
| `trend_ref_ungrounded:<n>` | LLM menyebut tren yang tidak ada di teks klip; ref dibuang otomatis. Normal sesekali. |
| `trend_packaging_ungrounded:<n>` | Judul, hook atau deskripsi klip AI menyebut tren yang tidak ada di teks klip; bagian itu sudah diganti otomatis. Periksa hasilnya. |
| `trend_sensitive_humor:<n>` | Klip humor menyinggung tren sensitif. Periksa judul dan hook sebelum diunggah. |
| Tidak ada chip "Nyambung tren" | Kata kunci item tidak muncul di transkrip. Tambahkan bentuk ucapan (nama panggilan, ejaan, frasa tagar terpisah). Untuk klip AI: model juga harus menyebut tren itu di `trend_refs`; kalau tidak, klip AI tidak mendapat tren (klip heuristik dicocokkan langsung). |
| `/trends` menampilkan "File pengaturan rusak" | `trend-context.json` atau `ingest-tokens.json` tidak bisa diurai. Perubahan berikutnya memulai file baru; file lama disimpan sebagai `<nama>.corrupt-<waktu>-<acak>` (0600) untuk diperiksa. Job V3 selama itu berjalan tanpa tren. |

## Verifikasi ujung ke ujung

1. Buat token di `/trends`.
2. Isi token tanpa masuk riwayat shell, lalu kirim (lokal; tanpa `--url` untuk produksi):

   ```bash
   read -rs POTONGIN_INGEST_TOKEN && export POTONGIN_INGEST_TOKEN
   python3 scripts/trends/push_trends.py --url http://localhost:3000/api/ingest/trends items.json
   ```
3. Item tampil di `/trends` dengan sumber = label token.
4. Jalankan job V3 pada video yang benar-benar menyebut tren itu.
5. Klipnya menampilkan chip "Nyambung tren: <judul>" dan hashtag tren; `selection.v3.json` dan
   manifest berisi `trends`.
