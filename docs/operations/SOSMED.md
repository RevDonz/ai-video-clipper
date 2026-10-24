# Sosmed: batas platform, kewajiban data, dan pendaftaran app

Terakhir diperbarui: 2026-10-24. Semua sumber di dokumen ini diakses 2026-10-24.

Dokumen ini hasil SOS-M0 (rencana `2026-10-24-rombak`, dok 03 §11.6 dan §19, dok 08 Fase 0).
Isinya: setiap angka platform bertanda **[V]** di dok 03, dicek terhadap dokumentasi resmi
(`developers.google.com`, `developers.tiktok.com`, `developers.facebook.com`), lalu checklist
pendaftaran app untuk pemilik.

Aturan pakai:

- Kalau angka di sini berbeda dengan dok 03, **angka di sini yang berlaku** dan konstanta kode
  mengikutinya (dok 03, konvensi di kepala dokumen). Usulan perbaikan dok 03 ada di §1.
- Platform mengubah angka tanpa pemberitahuan. Sebelum SOS-M2 dan sebelum setiap pengajuan audit,
  cek ulang baris yang dipakai dan perbarui tanggal akses.
- Repo ini publik. `<PUBLIC>` berarti `POTONGIN_PUBLIC_URL` (`https://<host>`, tanpa path dan
  tanpa garis miring akhir). Domain, email kontak, client id, client secret, dan app secret tidak
  pernah ditulis di sini (§11).

Status kolom "Cek": **cocok** = sama dengan dok 03; **beda** = dok resmi berbeda, pakai nilai di
sini; **tidak tertulis** = dok resmi tidak menyebut angkanya, nilai dok 03 tetap nilai kerja dan
diuji di SOS-M2.

## 1. Ringkasan: yang berbeda dari dok 03

Urut dari dampak terbesar. Kolom terakhir adalah usulan perubahan untuk dok 03 (dok 03 tidak
diubah di PR ini).

| # | Dok 03 | Dokumentasi resmi | Usulan untuk dok 03 |
|---|---|---|---|
| 1 | §10.5: angka mentah YouTube diciutkan jadi `relViews` setelah 30 hari; "pembolehan agregat turunan diverifikasi di SOS-M0". §13: profil performa memakai views. | Kebijakan developer YouTube III.E.4: klien **tidak boleh** "access or use API Data to create new or derived data or metrics", contohnya "a score that factors in likes, total views". Pengecualian hanya untuk developer analitik yang sudah diaudit dan mengajukan izin lewat formulir perpanjangan kuota (berlaku sejak 2026-06-01). | Agregat turunan **tidak diizinkan** tanpa izin itu. Data YouTube dari API (`source='api'`) tidak masuk `rel_views`, `metric_horizons`, maupun profil performa sampai pemilik mendapat izin metrik turunan. Penciutan `aggregate_json` diganti: tidak ada nilai turunan dari data API YouTube. Lihat §5.1. |
| 2 | §10.5: nilai mentah YouTube yang tidak di-refresh > 30 hari dihapus atau di-refresh. | Statistik (views, likes, jumlah komentar) dari Authorized Data **boleh disimpan lebih dari 30 hari**, asal setiap 30 hari klien memastikan izin pengguna belum dicabut dan videonya belum dihapus. | Ganti aturan "ciutkan setelah 30 hari" dengan "cek ulang izin dan keberadaan video setiap ≤ 30 hari; gagal cek → hapus". Untuk posting > 90 hari (`stopped=1`) tetap perlu satu panggilan cek per ≤ 30 hari, atau hapus nilainya. |
| 3 | §5.2, §10.2: `videos.insert` 1600 unit dari kuota 10000/hari → ± 5 unggahan/hari. | Sejak 2026-06-01 `videos.insert` punya bucket kuota sendiri: 1 unit per panggilan, default **100 panggilan per hari**. 10000 unit/hari tetap untuk endpoint lain. | Pisahkan `SOCIAL_YT_DAILY_UNITS` (10000, metrik dan baca) dari batas unggah baru `SOCIAL_YT_DAILY_UPLOADS` (default 100). Jatah per pengguna = `max(1, floor(100 / pengguna_aktif_youtube))`. Celah §19.7 (1 unggahan/hari bila > 5 pengguna) hampir hilang. |
| 4 | §5.3: Instagram `upload_type=resumable` lewat `rupload.facebook.com` adalah jalur utama. | Dok Content Publishing: `upload_type=resumable` "Only for apps that have implemented Facebook Login for Business". Kolom Instagram Login hanya mencantumkan host `graph.instagram.com`. | Untuk Instagram Login, jalur utama menjadi **URL media publik** (`video_url`, §11.3 dok 03), jadi pengecualian WAF/bot §11.4 wajib terpasang sebelum Instagram dinyalakan. Resumable tetap dicoba sekali di sandbox SOS-M2; kalau ternyata jalan, boleh jadi jalur utama lagi. Lihat §6.2. |
| 5 | §11.6 TikTok: "Verifikasi domain tidak diperlukan (`FILE_UPLOAD`)". | Daftar app TikTok: untuk app yang dibuat setelah 2024-09-09, URL Ketentuan, URL Kebijakan Privasi, dan URL Web **wajib diverifikasi** (URL properties) sebelum diajukan review. | Ubah checklist: verifikasi URL properties wajib untuk `<PUBLIC>`, `/privasi`, `/ketentuan`. Yang tidak perlu hanya verifikasi prefix URL media (itu khusus `PULL_FROM_URL`). |
| 6 | §5.3: aplikasi belum diaudit → semua posting `SELF_ONLY`, jumlah kreator dibatasi. | Belum diaudit: paling banyak **5 pengguna** memposting per 24 jam, dan **akun TikTok pengguna harus privat** saat memposting (galat `unaudited_client_can_only_post_to_private_accounts`). | Tambah angka 5 pengguna/24 jam, syarat akun privat, dan pemetaan galat itu di §8 dok 03. Drawer menjelaskan bahwa akun harus diset privat selama app belum diaudit. |
| 7 | §5.3: PKCE S256 untuk TikTok. | Login Kit Web tidak menyebut PKCE; `code_verifier` "required for mobile and desktop app only". Panduan desktop memakai hex SHA-256, bukan base64url RFC 7636. | TikTok web: `pkce=false`, `state` tetap wajib. |
| 8 | §5.3 `describe`: `fields=open_id,display_name,avatar_url,username` dengan scope `user.info.basic`. | `username` butuh scope `user.info.profile`. | Hapus `username` dari `describe` (pakai `display_name`), atau tambah scope `user.info.profile`. Usulan: hapus, supaya scope tetap tiga. |
| 9 | §5.3 syarat UX Direct Post: satu kalimat persetujuan musik. | Ada tiga varian kalimat, tergantung pilihan konten komersial; saklar interaksi tidak boleh tercentang bawaan; konten bermerek tidak boleh privat; tombol terbit nonaktif bila saklar komersial menyala tanpa pilihan. | Lengkapi §5.3 dan kunci katalog dengan §6.3 dokumen ini (tiga kunci, bukan satu). |
| 10 | §5.4: `content_publishing_limit` 100 per 24 jam. | Dok Content Publishing menulis 100; bagian carousel dan referensi `content_publishing_limit` menulis `quota_total` "currently 50". | Jangan menulis angka tetap. Pakai `config.quota_total` dari API (dok 03 sudah begitu); angka di UI dan tes memakai nilai respons. |
| 11 | §5.4 poll container setiap 15 dtk. | Meta menyarankan "querying a container's status once per minute, for no more than 5 minutes". | Poll 60 dtk, paling lama 5 menit, lalu `reconcile` di tick berikutnya. |
| 12 | §5.4 Reels 3 dtk–15 menit; tidak ada batas ukuran. | Reels: 3 dtk–15 menit, **≤ 300 MB**, MP4/MOV dengan moov atom di depan, 23–60 fps, lebar maks 1920 px, AAC ≤ 48 kHz. | Tambah `maxBytes` 300 MB untuk Instagram; `validate` menolak file lebih besar dengan kode baru atau `social_file_too_large`. |
| 13 | §7.5: `issued_at` signed_request ≤ 1 jam **[V]**. | Dok callback hapus data memperlihatkan payload `{algorithm, expires, issued_at, user_id}`; tidak ada batas umur. | Batas 1 jam bukan aturan Meta. Pertahankan sebagai pilihan kita (tolak payload basi), tambah cek `expires` bila ada dan bukan 0. Hapus tanda [V]. |
| 14 | §11.6 Meta: App Review untuk `content_publish` + `manage_insights`. | Advanced Access (wajib untuk akun yang tidak punya peran di app) butuh App Review dan Business Verification; App Review mencantumkan `instagram_business_basic` juga. Akun tester harus publik dan ditambahkan di App Roles. | App Review untuk ketiga permission. Checklist tester ditambah: akun profesional, publik, diundang lewat App Roles dan menerima undangannya. |
| 15 | §5.2: unggahan dari proyek API yang belum diaudit dipaksa privat **[V]**. | Referensi `videos.insert` (diperbarui 2026-10-15): "Videos uploaded from unverified API projects are not restricted to private viewing mode." Riwayat revisi masih memuat entri 2020-07-28 yang mewajibkan privat, dan tidak ada entri yang mencabutnya. | Sumber resmi saling bertentangan. Pertahankan `apps.youtube.audited=false` (paksa privat) sebagai default yang aman. Di SOS-M2 unggah satu video uji dari proyek Testing dengan `public` lalu cek statusnya; pemilik memutuskan flag dari hasil itu. |
| 16 | §5.3: TikTok tidak punya callback putus akun. | TikTok punya webhook `authorization.removed` (token sudah dicabut saat event datang). | Opsional: tambah webhook ini di SOS-M2 untuk purge otomatis. Tidak wajib untuk audit. |
| 17 | §11.6 Google: "domain terotorisasi". | Domain terotorisasi wajib dibuktikan kepemilikannya lewat **Google Search Console** oleh akun Google yang menjadi Owner/Editor proyek. | Tambah langkah Search Console di checklist (§7, §9.1). |

Risiko audit yang perlu dibaca pemilik (bukan angka, tapi bisa menggagalkan review):

- **TikTok, pedoman berbagi konten:** contoh penggunaan yang tidak diterima termasuk "An app that
  copies arbitrary contents from other platforms to TikTok" dan "A utility tool to help upload
  contents to the account(s) you or your team manages". Potongin memotong video YouTube lalu
  memposting klipnya ke TikTok. Saat audit, demo dan deskripsi app harus memperlihatkan bahwa
  pengguna memposting klip dari konten miliknya sendiri, diedit di Potongin. Kalau sebagian besar
  pengguna memotong video orang lain, audit TikTok bisa ditolak.
- **TikTok, watermark:** "API Clients should not add promotional watermarks/logos to creators'
  content." Watermark Potongin hanya teks milik pengguna (`web/lib/default-watermark.mjs`, kosong
  bawaan), jadi aman selama Potongin tidak menambahkan merek sendiri.
- **TikTok, review app:** URL web tidak boleh halaman login atau landing kosong ("must have an
  externally facing fully developed website"); tautan Privasi dan Ketentuan harus terlihat tanpa
  membuka menu.
- **YouTube:** III.E.4 juga melarang mengganti angka API dengan angka hitungan sendiri. Halaman
  analitik menampilkan views dan likes YouTube apa adanya, bukan hasil olahan.

## 2. YouTube Data API v3

| Item (dok 03) | Nilai resmi | Cek | Sumber |
|---|---|---|---|
| Biaya `videos.insert` 1600 unit | 1 unit di bucket "Video Uploads", 100 panggilan/hari. Riwayat: ± 1600 → ± 100 unit (2025-12-04), lalu bucket sendiri (2026-06-01). | beda | [Y1], [Y2], [Y4] |
| Kuota harian 10000 unit | "100 search.list calls, 100 videos.insert calls, and 10,000 units per day combined for all other endpoints". Reset tengah malam waktu Pasifik. | beda (dipecah) | [Y3], [Y2], [Y9] |
| `videos.list` 1 unit, batch 50 | 1 unit. Dok `id` hanya menyebut "comma-separated list"; batas 50 tertulis untuk `maxResults`, yang tidak berlaku bersama `id`. | cocok (biaya); tidak tertulis (50) | [Y5] |
| Alternatif metrik | `videos.batchGetStats`: 1 unit, bucket sendiri, default 10000 unit/hari, menerima `youtube.readonly`. Layak dipertimbangkan untuk refresh metrik di SOS-M5. | baru | [Y4], [Y6] |
| Ukuran maks 256 GB | "Maximum file size: 256GB"; MIME `video/*`, `application/octet-stream`. | cocok | [Y1] |
| Judul ≤ 100 karakter, deskripsi ≤ 5000 byte | Judul 100 karakter, deskripsi 5000 byte; keduanya tanpa `<` dan `>`. | cocok | [Y7] |
| Shorts ≤ 180 dtk | Tidak tertulis di tiga domain resmi developer. Batas Shorts ada di Bantuan YouTube, di luar daftar sumber SOS-M0. | tidak tertulis | — |
| Sesi resumable ± 1 minggu | "each resumable session URI has a finite lifetime and eventually expires"; URI kedaluwarsa → 404. Lama tidak disebut. | tidak tertulis | [Y8] |
| Chunk kelipatan 256 KiB, 308 + `Range` | Chunk kelipatan 256 KB kecuali chunk terakhir, ukuran sama tiap chunk; 308 dengan header `Range` (indeks dari 0); tanpa `Range` berarti belum ada byte. | cocok | [Y8] |
| Nilai `uploadStatus` | `deleted`, `failed`, `processed`, `rejected`, `uploaded`. | cocok | [Y7] |
| Proyek belum diaudit → privat | Bertentangan, lihat §1 baris 15. | beda (konflik) | [Y1], [Y2] |
| Scope `youtube.upload`, `youtube.readonly` | `youtube.upload` ("Manage your YouTube videos") ada di daftar scope `videos.insert`. `youtube.readonly` ("View your YouTube account") cukup untuk `videos.list`, `channels.list`, `batchGetStats`. Klasifikasi sensitif tampil di konsol saat scope ditambahkan. | cocok | [Y1], [G1] |
| Refresh token 7 hari saat *Testing* | "external user type and a publishing status of "Testing" is issued a refresh token expiring in 7 days". Batas 100 refresh token per akun Google per client id. | cocok | [G2] |
| `access_type=offline`, `prompt=consent` | `refresh_token` "is only returned on the first authorization"; `prompt=consent` memaksa layar izin dan token baru. | cocok | [G3] |
| PKCE S256 | Tidak tertulis untuk alur web server (parameter yang didokumentasikan: `client_id`, `redirect_uri`, `response_type`, `scope`, `access_type`, `state`, `include_granted_scopes`, `login_hint`, `prompt`; tukar kode memakai `client_secret`). | tidak tertulis | [G3] |
| Verifikasi app | Brand verification (Search Console untuk setiap domain, review manual biasanya 2–3 hari kerja), lalu verifikasi scope sensitif (biasanya 3–5 hari kerja; video demo di YouTube Studio status *Unlisted*, alur izin dalam bahasa Inggris, bilah alamat memperlihatkan client id). Branding harus *published* sebelum verifikasi akses data. | baru | [G4], [G5] |
| Audit YouTube API Services | Wajib sebelum minta kuota tambahan; lewat "YouTube API Services - Audit and Quota Extension Form". | cocok | [Y9] |

## 3. TikTok (Login Kit + Content Posting API, Direct Post)

| Item (dok 03) | Nilai resmi | Cek | Sumber |
|---|---|---|---|
| Scope `user.info.basic`, `video.publish`, `video.list` | `video.publish` untuk Direct Post dan status; `video.list` untuk `video/query`; `user.info.basic` untuk `open_id`, `union_id`, `avatar_url`, `display_name`. | cocok | [T1], [T2] |
| `describe` `username` | `username` butuh `user.info.profile`. | beda | [T2] |
| PKCE S256 | Hanya untuk desktop/mobile; web tidak. | beda | [T3], [T4] |
| Token akses ± 24 jam, refresh ± 365 hari, refresh bisa berganti | `expires_in` 86400 dtk; `refresh_expires_in` 31536000 dtk; "The returned refresh_token may be different than the one passed in the payload." Revoke: `POST https://open.tiktokapis.com/v2/oauth/revoke/`. | cocok | [T5] |
| Redirect URI | HTTPS, absolut, statis (tanpa query, tanpa `#`), < 512 karakter, maks 10 per app, harus sama persis. | baru | [T3] |
| Caption ≤ 2200 | `title` maks 2200 "UTF-16 runes". Hitung dengan panjang UTF-16, bukan code point. | cocok (satuan diperjelas) | [T6] |
| `upload_url` ± 1 jam | "The upload_url is valid for one hour after issuance." Kedaluwarsa → 403. | cocok | [T6], [T7] |
| Aturan chunk | Chunk 5–64 MB; file < 5 MB satu chunk penuh; file > 64 MB wajib dipecah; chunk terakhir menampung sisa (hingga 128 MB); `total_chunk_count = floor(video_size / chunk_size)`; 1–1000 chunk; berurutan. 206 = chunk diterima, 201 = selesai, 416 = `Content-Range` tidak cocok. Chunk 10 MiB dok 03 sah. | cocok | [T7] |
| Batas video | MP4/WebM/MOV; H.264/H.265/VP8/VP9; ≤ 4 GB; ≤ 10 menit lewat API (dan ≤ `max_video_post_duration_sec` kreator); 23–60 fps; sisi 360–4096 px. | baru | [T7], [T8] |
| `creator_info` | Field `creator_avatar_url` (berlaku 2 jam), `creator_username`, `creator_nickname`, `privacy_level_options`, `comment_disabled`, `duet_disabled`, `stitch_disabled`, `max_video_post_duration_sec`. | cocok | [T8] |
| Status dan ejaan `publicaly_available_post_id` | Status `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED`. Ejaan field `publicaly_available_post_id` (salah eja dari TikTok, dipakai apa adanya). `fail_reason`: `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed`, `internal`, `video_pull_failed`, `photo_pull_failed`, `publish_cancelled`, `auth_removed`, `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk`. | cocok | [T9] |
| `video/query` batch 20 | "Up to 20 video IDs can be included per request." Field statistik: `view_count`, `like_count`, `comment_count`, `share_count`. | cocok | [T10] |
| Batas laju | Per token pengguna: `video/init` 6/menit, `creator_info` 20/menit, `status/fetch` 30/menit. Per app: `user/info`, `video/query`, `video/list` 600/menit (jendela geser 1 menit). Lewat batas → 429 `rate_limit_exceeded`. Nilai kerja dok 03 (poll 10 dtk, metrik 1 per 10 dtk) masih di bawah batas. | baru | [T6], [T8], [T9], [T11] |
| Batas posting per kreator | "typically around 15 posts per day/ creator account", bisa berbeda per kreator; ada batas kreator aktif per 24 jam per app. Galat: `spam_risk_too_many_posts`, `reached_active_user_cap`, `spam_risk_user_banned_from_posting`. | cocok (angka kini diketahui) | [T6], [T12] |
| Belum diaudit | Konten "restricted to private viewing mode"; maks 5 pengguna/24 jam; akun harus privat saat memposting. | beda (lebih ketat) | [T6], [T12], [T13] |
| Syarat UX Direct Post | Lihat §6.3. | beda (lebih lengkap) | [T12] |
| `PULL_FROM_URL` butuh verifikasi domain | Benar; galat `url_ownership_unverified`. Tidak dipakai. | cocok | [T6], [T13] |
| Review app | Review "several days to two weeks". App baru wajib demo di sandbox; maks 5 video, 50 MB per video; semua produk dan scope terlihat di video; domain di video sama dengan URL web. Sandbox: maks 10 akun target. Sandbox tidak membuka Content Posting API untuk video publik. | baru | [T14], [T15], [T16] |

## 4. Instagram API dengan Instagram Login

| Item (dok 03) | Nilai resmi | Cek | Sumber |
|---|---|---|---|
| Scope tiga | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. Nilai lama `business_*` diganti. | cocok | [M1], [M3], [M5] |
| Tanpa PKCE, `state` wajib | Parameter authorize: `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`. Kode berlaku 1 jam, sekali pakai; `#_` di ujung redirect bukan bagian dari kode. | cocok | [M1] |
| Token | Short-lived lewat `POST https://api.instagram.com/oauth/access_token` → long-lived lewat `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` (60 hari). Refresh `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`: token ≥ 24 jam, belum kedaluwarsa, izin `instagram_business_basic`. Tidak di-refresh 60 hari → mati. | cocok | [M1] |
| `describe` | `GET /me?fields=user_id,username,name,profile_picture_url` (juga `account_type`: `Business` atau `Media_Creator`). | cocok | [M2] |
| `content_publishing_limit` 100/24 jam | Konflik 100 vs 50, lihat §1 baris 10. Endpoint mengembalikan `config.quota_total`, `config.quota_duration` (86400) dan `quota_usage`. | beda (pakai nilai API) | [M3], [M4] |
| Reels 3 dtk–15 menit | 3 dtk–15 menit; ≤ 300 MB; detail §1 baris 12. | cocok + tambahan | [M4] |
| Caption ≤ 2200, ≤ 30 hashtag | "Maximum 2200 characters, 30 hashtags, and 20 @ tags." | cocok | [M4] |
| Resumable `rupload` + `offset` | Header `Authorization: OAuth <token>`, `offset` ("first byte being upload, generally 0"), `file_size`; alternatif header `file_url`. Cara melanjutkan unggahan putus tidak dijelaskan. Hanya untuk Facebook Login for Business. | beda | [M3], [M4] |
| Container `EXPIRED` ± 24 jam | "The container was not published within 24 hours and has expired." Status: `EXPIRED`, `ERROR`, `FINISHED`, `IN_PROGRESS`, `PUBLISHED`. | cocok | [M3] |
| Insights | `GET /<media id>/insights`, izin `instagram_business_manage_insights`. Metrik Reels: `views`, `likes`, `comments`, `shares`, `saved`, `total_interactions`. Data bisa telat sampai 48 jam; disimpan Meta sampai 2 tahun; data kosong dikembalikan sebagai set kosong, bukan 0. | cocok | [M6] |
| Batas laju Graph | Per pasangan app–pengguna: `4800 × jumlah impresi` panggilan per 24 jam bergulir. Nilai kerja dok 03 (≤ 60 insights/jam) jauh di bawahnya. | cocok | [M5] |
| `signed_request` | HMAC-SHA256 dengan app secret; payload `algorithm`, `expires`, `issued_at`, `user_id`. Callback hapus data menjawab `{url, confirmation_code}`. Batas umur 1 jam tidak tertulis. | beda (lihat §1 baris 13) | [M7] |
| Akses dan review | Standard Access: hanya pengguna yang punya peran di app. Advanced Access: butuh App Review dan Business Verification. App harus terhubung ke bisnis yang sudah lolos Business Verification sebelum dipublikasikan. | cocok | [M5], [M8] |

## 5. Kewajiban data dan retensi

### 5.1 YouTube (Developer Policies, diperbarui 2026-10-15) [Y10], [Y11]

- **Token** boleh disimpan selama perlu, untuk tujuan izin yang diberikan.
- **Statistik** (views, likes, jumlah komentar) dari Authorized Data boleh disimpan lebih dari 30
  hari, dengan cek setiap 30 hari bahwa izin belum dicabut dan video belum dihapus.
- **Data Authorized lain** (judul, deskripsi, nama kanal): hapus atau refresh setelah 30 hari.
- **Metrik turunan dilarang**, termasuk skor yang memakai views atau likes, kecuali developer
  analitik yang sudah diaudit dan disetujui untuk "Additional policies for derived metrics and data
  storage" (diajukan lewat formulir perpanjangan kuota, pilih kasus penggunaan "Analytics &
  Reporting"). Bila disetujui: statistik dan metrik turunan boleh disimpan sampai 36 bulan.
  Akibatnya untuk Potongin: `relViews`, `metric_horizons.rel_views`, dan profil performa (§13 dok
  03) tidak boleh memakai data API YouTube tanpa persetujuan itu.
- **Agregasi** hanya per pemilik konten dan hanya terlihat oleh pemilik itu; tidak boleh
  menggabungkan data dari pemilik konten yang berbeda.
- **Hapus atas permintaan:** pengguna harus bisa meminta hapus data; hapus secepatnya, paling lama
  7 hari. Hal yang sama berlaku bila pengguna menghapus akun Potongin atau mencabut izin di
  halaman keamanan Google. Dok 03 (purge saat putus akun) sudah memenuhi.
- **Halaman privasi** wajib: menyebut bahwa Potongin memakai YouTube API Services, menautkan
  Kebijakan Privasi Google (`http://www.google.com/policies/privacy`), menjelaskan data apa yang
  diambil, disimpan, dan dipakai, menjelaskan pencabutan lewat
  `https://security.google.com/settings/security/permissions`, dan cara menghubungi pemilik.
- **Halaman ketentuan** wajib menautkan Ketentuan Layanan YouTube (`https://www.youtube.com/t/terms`)
  dan menyatakan bahwa pengguna terikat padanya.
- **Pilihan privasi:** klien yang mengunggah harus menampilkan pilihan `public`, `private`,
  `unlisted` dengan jelas dan tidak mengubah privasi tanpa persetujuan pengguna.

Data YouTube yang diunggah pengguna sendiri lewat CSV ekspor YouTube Studio bukan API Data. Apakah
CSV boleh masuk profil performa adalah keputusan pemilik; dokumen ini hanya mencatat bahwa larangan
III.E.4 ditulis untuk API Data.

### 5.2 TikTok [T17]

- Dok developer yang dicek tidak menyebut aturan 30 hari untuk data API.
- Event webhook `authorization.removed` dikirim saat pengguna memutus app, akun dihapus atau
  dibanned; TikTok mengulang pengiriman sampai 72 jam. Callback harus HTTPS dan langsung
  menjawab 200.
- Halaman privasi harus menjelaskan cara meminta hapus data.

### 5.3 Meta / Instagram [M7], [M9]

- Semua app yang mengakses data pengguna wajib memberi cara meminta hapus data: URL instruksi atau
  callback hapus data. Callback harus memulai penghapusan dan menjawab JSON `{url,
  confirmation_code}`; kalau tidak, callback bisa dicabut atau app dinonaktifkan.
- Mode Live butuh: email kontak, URL Kebijakan Privasi, URL Ketentuan Layanan, URL atau callback
  hapus data, ikon app.
- Data yang dibuat saat mode Development (misalnya posting uji) hanya terlihat oleh pengguna
  berperan, lalu terlihat publik setelah app pindah ke Live.

## 6. Keputusan SOS-M0

### 6.1 TikTok memakai `FILE_UPLOAD`

Tetap jalur utama. `FILE_UPLOAD` tidak butuh verifikasi prefix URL media; `PULL_FROM_URL` butuh
dan tidak dipakai. Verifikasi URL properties tetap wajib untuk URL web, privasi, dan ketentuan
(§1 baris 5).

### 6.2 Instagram: resumable atau URL publik

Dok resmi menulis resumable hanya untuk Facebook Login for Business. Keputusan: untuk Instagram
Login, **URL media publik adalah jalur utama**. Akibatnya:

- `/api/social/media/<token>` (dok 03 §11.3) dibangun di SOS-M2 sebagai jalur utama, bukan cadangan.
- Pengecualian WAF/bot dan aturan nginx §11.4 dok 03 wajib terpasang sebelum Instagram dinyalakan.
- Di SOS-M2, satu uji sandbox mencoba `upload_type=resumable` dengan token Instagram User. Kalau
  berhasil dan bisa dilanjutkan dengan `offset`, catat di sini dan pemilik boleh membalik urutan.

### 6.3 Teks wajib TikTok (kunci katalog)

Dok 03 hanya menyiapkan `social.tiktok.consent`. TikTok mensyaratkan tiga varian. Teks Inggris
dikutip dari pedoman TikTok [T12]; dok TikTok tidak mengatur terjemahan.

| Kunci (usulan) | Kapan | Teks Inggris resmi | Tautan |
|---|---|---|---|
| `social.tiktok.consent` | Tanpa konten komersial, atau hanya "Merek sendiri" | By posting, you agree to TikTok's Music Usage Confirmation. | "Music Usage Confirmation" → `https://www.tiktok.com/legal/page/global/music-usage-confirmation/en` |
| `social.tiktok.consentBranded` | "Konten bermerek", sendiri atau bersama "Merek sendiri" | By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation. | "Branded Content Policy" → `https://www.tiktok.com/legal/page/global/bc-policy/en`; "Music Usage Confirmation" → tautan di atas |
| `social.tiktok.commercialMissing` | Saklar komersial menyala tanpa pilihan (teks hover tombol terbit yang nonaktif) | You need to indicate if your content promotes yourself, a third party, or both. | — |

Usulan teks Indonesia (perlu persetujuan pemilik; tautan tetap ke halaman resmi TikTok):

- `social.tiktok.consent`: "Dengan memposting, kamu menyetujui Konfirmasi Penggunaan Musik TikTok."
- `social.tiktok.consentBranded`: "Dengan memposting, kamu menyetujui Kebijakan Konten Bermerek dan
  Konfirmasi Penggunaan Musik TikTok."
- `social.tiktok.commercialMissing`: "Pilih apakah kontenmu mempromosikan dirimu, pihak ketiga, atau
  keduanya."

Syarat UX lain dari pedoman yang sama, untuk `PublishDrawer` (SOS-M4):

- Tampilkan nama kreator (`creator_nickname`).
- Tolak klip yang lebih panjang dari `max_video_post_duration_sec`.
- Pilihan privasi hanya dari `privacy_level_options`, dipilih manual, **tanpa nilai bawaan**.
- Komentar, Duet, Stitch: **tidak ada yang tercentang bawaan**; nonaktif dan abu-abu bila kreator
  mematikannya.
- Pengungkapan konten komersial: saklar mati bawaan. "Merek sendiri" → label "Promotional
  content"; "Konten bermerek" (sendiri atau keduanya) → label "Paid partnership".
- Konten bermerek tidak boleh privat: nonaktifkan "Hanya saya" atau pindahkan ke publik dan beri
  tahu pengguna.
- Tampilkan pratinjau klip; kirim byte hanya setelah pengguna setuju.
- Setelah terbit, beri tahu bahwa TikTok butuh beberapa menit sebelum posting terlihat.
- Teks bawaan (caption, hashtag) bisa diedit pengguna. Jangan tambahkan watermark atau logo promosi.

## 7. Verifikasi domain per platform

| Platform | Perlu? | Apa yang diverifikasi | Cara | Kapan |
|---|---|---|---|---|
| Google | Ya | "Top private domain" dari beranda, privasi, ketentuan, dan redirect URI | Google Search Console, oleh akun Google yang Owner/Editor di proyek | Sebelum *Publish branding*; bisa sekarang begitu domain ada |
| TikTok | Ya | URL web, URL privasi, URL ketentuan (URL properties) | Rekaman DNS untuk domain, atau file tanda tangan untuk prefix URL; URL yang menjawab 3xx gagal; harus domain, bukan IP | Sebelum mengajukan review; di sandbox hanya diwajibkan untuk Content Posting API |
| Meta | Tidak untuk Instagram Login | — (isi App Domains di Pengaturan Dasar) | Business Verification adalah verifikasi bisnis, bukan domain | Business Verification sebelum Advanced Access |

## 8. Halaman privasi dan ketentuan: rencana sementara

Masalah: konsol ketiga platform butuh `<PUBLIC>/privasi` dan `<PUBLIC>/ketentuan`, sedangkan
halaman itu baru dibangun di SOS-M6 (Fase 8). TikTok juga menolak URL web berupa halaman login,
dan tautan privasi serta ketentuan harus terlihat di halaman depan tanpa membuka menu.

Rencana:

1. **Sekarang (mode testing):** Google dan Meta mengizinkan app Testing/Development tanpa review.
   Isi kolom URL dengan `<PUBLIC>/privasi` dan `<PUBLIC>/ketentuan` walau halamannya belum ada;
   akses hanya untuk test user. TikTok menulis "In Sandbox, verification is only required for the
   Content Posting API"; kalimat itu tidak jelas apakah `FILE_UPLOAD` di sandbox juga butuh URL
   terverifikasi. Kalau konsol meminta, verifikasi domain lewat DNS dulu (tidak butuh halaman).
2. **Sebelum pengajuan review pertama:** pindahkan halaman statis `/privasi` dan `/ketentuan`
   dari SOS-M6 ke PR kecil tersendiri (halaman teks saja, akses publik exact-path di
   `web/proxy.js`, tanpa fitur sosmed). Halaman depan menautkan keduanya di footer. Teks draf
   disiapkan implementer, disetujui pemilik (Q7 dok 08), dengan isi minimum §11.5 dok 03 ditambah
   kewajiban §5.1 dokumen ini.
3. **Jangan** memakai hosting lain (misalnya halaman di domain berbeda): Google dan TikTok
   memverifikasi domain, dan TikTok mensyaratkan domain di video demo sama dengan URL web.

## 9. Checklist pendaftaran pemilik

Placeholder: `<PUBLIC>` = `POTONGIN_PUBLIC_URL`. Redirect URI harus sama persis dengan yang
dikirim kode (dok 03 §11.1). Kredensial disimpan menurut §11.

### 9.1 Google / YouTube

**Bisa sekarang (mode testing)**

- [ ] Pilih domain publik HTTPS untuk `<PUBLIC>`; catat di catatan pribadi, bukan di repo.
- [ ] Buat proyek Google Cloud; aktifkan YouTube Data API v3.
- [ ] Layar izin OAuth: tipe *External*, status *Testing*. Isi nama app, logo, email dukungan,
      beranda `<PUBLIC>/`, privasi `<PUBLIC>/privasi`, ketentuan `<PUBLIC>/ketentuan`, domain
      terotorisasi = top private domain `<PUBLIC>`.
- [ ] Tambah scope `https://www.googleapis.com/auth/youtube.upload` dan
      `https://www.googleapis.com/auth/youtube.readonly`; catat klasifikasi yang tampil di konsol.
- [ ] Tambah test user (akun Google pemilik dan penguji).
- [ ] Buat OAuth client tipe *Web application*; redirect URI `<PUBLIC>/api/social/callback/youtube`.
- [ ] Verifikasi kepemilikan domain di Google Search Console dengan akun yang Owner/Editor proyek.
- [ ] Catat di §10: tanggal proyek dibuat, status *Testing*. Ingat: refresh token mati setelah 7
      hari selama *Testing*; koneksi uji perlu dihubungkan ulang.

**Nanti setelah Fase 8 (verifikasi/audit)**

- [ ] `/privasi` dan `/ketentuan` hidup di `<PUBLIC>` (§8 langkah 2).
- [ ] Brand verification → *Publish branding* (hasil berlaku 7 hari bila belum dipublikasikan).
- [ ] Verifikasi scope sensitif: video demo *Unlisted* di YouTube, alur izin berbahasa Inggris,
      bilah alamat memperlihatkan client id, setiap scope dipakai di layar (SOS-M2/M4 harus jadi).
- [ ] Audit YouTube API Services lewat "Audit and Quota Extension Form"; ajukan izin metrik
      turunan di formulir yang sama bila profil performa ingin memakai data API YouTube (§5.1).
- [ ] Ganti status ke *In production* setelah verifikasi lolos.

### 9.2 TikTok

**Bisa sekarang (mode testing)**

- [ ] Buat akun developer; buat atau gabung organisasi (disarankan TikTok), pilih organisasi
      sebagai pemilik app.
- [ ] Buat app: ikon 1024 × 1024 (JPEG/PNG ≤ 5 MB), nama khusus tanpa kata "TikTok", kategori,
      deskripsi, platform *Web*, URL web `<PUBLIC>/`.
- [ ] Tambah produk Login Kit (redirect URI `<PUBLIC>/api/social/callback/tiktok`) dan Content
      Posting API dengan konfigurasi Direct Post aktif.
- [ ] Tambah scope `user.info.basic`, `video.publish`, `video.list`.
- [ ] Buat sandbox; tambah akun TikTok uji sebagai target user (maks 10, akun milik sendiri).
- [ ] Akun uji diset **privat** (syarat app belum diaudit).
- [ ] Catat di §10: tanggal app dan sandbox dibuat.

**Nanti setelah Fase 8 (verifikasi/audit)**

- [ ] Verifikasi URL properties untuk `<PUBLIC>/`, `<PUBLIC>/privasi`, `<PUBLIC>/ketentuan`
      (DNS untuk domain, atau file tanda tangan untuk prefix).
- [ ] Halaman depan `<PUBLIC>/` adalah situs lengkap (bukan halaman login) dengan tautan Privasi
      dan Ketentuan terlihat tanpa menu.
- [ ] Ajukan review app: jelaskan tiap produk dan scope, unggah 1–5 video demo (≤ 50 MB) yang
      direkam di sandbox, domain di video sama dengan URL web, semua syarat UX §6.3 terlihat.
- [ ] Ajukan audit Content Posting API (Direct Post) untuk mencabut batas privat.
- [ ] Baca risiko audit di §1 (konten dari platform lain).

### 9.3 Meta / Instagram

**Bisa sekarang (mode testing)**

- [ ] Buat app Meta: kasus penggunaan *Other*, tipe *Business*; isi nama app dan email kontak.
- [ ] Tambah produk Instagram → *API setup with Instagram login*.
- [ ] Siapkan akun Instagram profesional (Business atau Creator) yang publik untuk uji; tambahkan
      di App Roles atau Instagram → API setup, lalu terima undangannya dari akun Instagram itu.
- [ ] Business login settings: OAuth redirect `<PUBLIC>/api/social/callback/instagram`,
      Deauthorize callback `<PUBLIC>/api/social/meta/deauthorize`, Data deletion request
      `<PUBLIC>/api/social/meta/data-deletion`.
- [ ] Pengaturan Dasar: App Domains (host `<PUBLIC>`), URL privasi `<PUBLIC>/privasi`, URL
      ketentuan `<PUBLIC>/ketentuan`.
- [ ] Hubungkan app ke business portfolio (boleh sekarang atau nanti).
- [ ] Catat di §10: tanggal app dibuat, mode Development.

**Nanti setelah Fase 8 (verifikasi/audit)**

- [ ] Business Verification untuk business portfolio (dokumen bisnis; perlu untuk Advanced Access
      dan untuk mempublikasikan app).
- [ ] App Review untuk `instagram_business_basic`, `instagram_business_content_publish`,
      `instagram_business_manage_insights`: app bisa dibuka penguji Meta dari luar, langkah demi
      langkah, rekaman layar per permission. Callback deauthorize dan hapus data harus sudah
      hidup (SOS-M2).
- [ ] Ikon app diunggah; pindah ke mode Live setelah review lolos.
- [ ] Pengecualian WAF/bot untuk `/api/social/media/*` terpasang (§6.2).

## 10. Catatan tiket dan status app (diisi pemilik)

Isi tanggal dalam format `YYYY-MM-DD`. Kolom "Nomor tiket" hanya nomor atau label dari konsol,
bukan client id atau secret. Status: `belum` / `testing` / `diajukan` / `disetujui` / `ditolak`.

| Platform | Langkah | Status | Tanggal dibuat/diajukan | Tanggal hasil | Nomor tiket | Catatan |
|---|---|---|---|---|---|---|
| Google | Proyek + layar izin (Testing) | belum | `<YYYY-MM-DD>` | — | — | |
| Google | Verifikasi domain (Search Console) | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | — | |
| Google | Brand verification | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |
| Google | Verifikasi scope sensitif | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |
| Google | Audit YouTube API Services | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |
| TikTok | App + sandbox | belum | `<YYYY-MM-DD>` | — | — | |
| TikTok | URL properties | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | — | |
| TikTok | Review app | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |
| TikTok | Audit Direct Post | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |
| Meta | App (Development) | belum | `<YYYY-MM-DD>` | — | — | |
| Meta | Business Verification | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |
| Meta | App Review | belum | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<tiket>` | |

Perkiraan lama review dari dok resmi: Google brand verification manual 2–3 hari kerja, scope
sensitif 3–5 hari kerja; TikTok review app beberapa hari sampai 2 minggu. Audit YouTube, audit
Direct Post TikTok, dan App Review Meta tidak menyebut lama.

## 11. Tempat kredensial

- Tidak pernah di repo, di issue, di PR, atau di log.
- Sampai kartu "Aplikasi sosial" (SocialAppsCard, SOS-M1, Fase 6) ada: simpan client id, client
  secret, dan app secret Instagram di pengelola kata sandi pemilik.
- Setelah SOS-M1: admin memasukkannya di Pengaturan → Sistem → "Aplikasi sosial"; tersimpan di
  `${POTONGIN_SETTINGS_DIR}/social-apps.json` (0600, disegel dengan purpose `social-app`).
- Domain publik: di `.env` produksi (`POTONGIN_PUBLIC_URL`) dan catatan pribadi pemilik.

## 12. Disk produksi

Dok 08 Fase 0 meminta disk produksi diukur (baseline 81%) dan dicatat di sini atau di
`UNDUHAN_M0.md`, untuk batas cache unduhan dan pin media sosmed. Agen tidak punya akses produksi.
**Perlu pemilik:** ukur dan isi baris ini.

| Tanggal | Volume | Ukuran | Terpakai | Bebas | Catatan |
|---|---|---|---|---|---|
| `<YYYY-MM-DD>` | `/data` | `<GiB>` | `<GiB> (<%>)` | `<GiB>` | diukur pemilik |

## 13. Sumber

Semua diakses 2026-10-24. Tanggal dalam kurung = "Last updated"/"Updated" di halaman itu.

**Google / YouTube**

- [Y1] Videos: insert (2026-10-15) — https://developers.google.com/youtube/v3/docs/videos/insert
- [Y2] Revision history (entri 2020-07-28, 2025-12-04, 2026-06-01, 2026-06-03) — https://developers.google.com/youtube/v3/revision_history
- [Y3] Getting started, Quota usage (2026-10-15) — https://developers.google.com/youtube/v3/getting-started
- [Y4] Quota calculator (2026-10-15) — https://developers.google.com/youtube/v3/determine_quota_cost
- [Y5] Videos: list (2026-10-15) — https://developers.google.com/youtube/v3/docs/videos/list
- [Y6] Videos: batchGetStats — https://developers.google.com/youtube/v3/docs/videos/batchGetStats
- [Y7] Videos resource (2026-10-15) — https://developers.google.com/youtube/v3/docs/videos
- [Y8] Resumable uploads (2026-10-15) — https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- [Y9] Quota and compliance audits (2026-10-15) — https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- [Y10] Developer Policies, III.A dan III.E.4 (2026-10-15) — https://developers.google.com/youtube/terms/developer-policies
- [Y11] Additional policies for derived metrics and data storage — https://developers.google.com/youtube/terms/derived-metrics-policy
- [G1] OAuth 2.0 scopes — https://developers.google.com/identity/protocols/oauth2/scopes
- [G2] Using OAuth 2.0, refresh token expiration (2026-10-16) — https://developers.google.com/identity/protocols/oauth2
- [G3] OAuth 2.0 for web server applications (2026-10-16) — https://developers.google.com/identity/protocols/oauth2/web-server
- [G4] Brand verification (2026-08-19) — https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- [G5] Sensitive scope verification (2026-08-19) — https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification

**TikTok**

- [T1] Scopes reference — https://developers.tiktok.com/doc/tiktok-api-scopes
- [T2] Get user info (2026-10-23) — https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
- [T3] Login Kit for Web (2026-08-04) — https://developers.tiktok.com/doc/login-kit-web
- [T4] Login Kit for Desktop — https://developers.tiktok.com/doc/login-kit-desktop
- [T5] User access token management (2026-08-04) — https://developers.tiktok.com/doc/oauth-user-access-token-management
- [T6] Direct Post reference (2026-08-24) — https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- [T7] Media transfer guide — https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
- [T8] Query creator info (2026-08-04) — https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
- [T9] Get post status (2026-08-04) — https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
- [T10] Query videos (2026-08-24) — https://developers.tiktok.com/doc/tiktok-api-v2-video-query
- [T11] Rate limits (2026-08-04) — https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit
- [T12] Content sharing guidelines (2026-08-04) — https://developers.tiktok.com/doc/content-sharing-guidelines
- [T13] Content Posting API, get started (2026-08-04) — https://developers.tiktok.com/doc/content-posting-api-get-started
- [T14] App review FAQ (2026-08-04) — https://developers.tiktok.com/doc/getting-started-faq
- [T15] App review guidelines (2026-08-04) — https://developers.tiktok.com/doc/app-review-guidelines
- [T16] Register your app (2026-08-04) dan Add a sandbox — https://developers.tiktok.com/doc/getting-started-create-an-app, https://developers.tiktok.com/doc/add-a-sandbox
- [T17] Webhook events — https://developers.tiktok.com/doc/webhooks-events

**Meta / Instagram**

- [M1] Business Login for Instagram (2026-03-13) — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- [M2] Get started, Instagram Login (2024-12-02) — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
- [M3] Content publishing (2026-10-20) — https://developers.facebook.com/docs/instagram-platform/content-publishing
- [M4] IG User Media (2026-09-28) dan IG User Content Publishing Limit (2024-07-23) — https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media, https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
- [M5] Instagram Platform overview (2026-09-28) dan Instagram API with Instagram Login (2025-01-21) — https://developers.facebook.com/docs/instagram-platform/overview, https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
- [M6] Instagram Media Insights (2026-09-11) — https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- [M7] Data deletion request callback (2025-11-07) — https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
- [M8] Create a Meta app for the Instagram API (2025-05-14) — https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app
- [M9] Basic settings (2023-10-18) dan App modes (2025-05-05) — https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings, https://developers.facebook.com/docs/development/build-and-test/app-modes
