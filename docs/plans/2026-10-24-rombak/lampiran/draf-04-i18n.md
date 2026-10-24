## Koreksi

Desain sudah dicek terhadap kode Potongin (`web/proxy.js`, `app/layout.jsx`, `app/global-error.jsx`, `next.config.mjs`, `playwright.config.mjs`, `compose.yaml`, `lib/**`, `components/**`, `src/ai_clipper/{edit_v2/errors,llm,selection_v3}.py`, `docs/editor/{CONTRACTS,GATES}.md`) dan terhadap tiga rencana yang sudah ada. Sumber eksternal yang dicek: registry npm (`use-intl` dan `next-intl` 4.14.9), dokumentasi use-intl "core library", listing jsDelivr `@react-aria/searchfield` (34 locale, tidak ada `id`), dan `unpkg @heroui/react@3.2.6/dist/components/close-button/close-button.js`. Repo SupoClip tidak dibuka.

| # | Severity | Masalah | Perbaikan |
|---|---|---|---|
| K1 | **Kritis** | Pemilih bahasa di `/login` mengirim POST ke `/api/account/preferences`, padahal route itu memakai `requireUser`. Matcher di `proxy.js` hanya mengecualikan `login` dan `api/auth/login`, jadi pengunjung yang belum login akan mendapat 401 "Sesi login diperlukan". Masalah yang sama kena `/undangan/[token]` dan `/atur-ulang-sandi/[token]`. | Buat satu route publik `POST /api/locale`. Isinya: cookie saja, `sameOriginMutation`, nilai harus ada di registry, dan rate limit ringan. Route ini dikecualikan di matcher dan dicantumkan di `proxy-matcher.test.mjs` beserta alasannya. Sejak MU-M2, route yang sama juga menulis `users.locale` kalau ada sesi. `/api/account/preferences` hanya untuk Zona waktu. |
| K2 | **Tinggi** | Rencana menyeragamkan semua error menjadi `{error:{code,messageId,params}}`. Ini melanggar kontrak yang sudah ada: CONTRACTS:1710 memakai bentuk datar `{error, code, messageId}`, sedangkan :552/:1014 memakai bentuk bersarang. Ada 33 pembaca klien yang membaca `body.error` sebagai string, dan agen Hermes (`api/ingest/trends`) adalah klien eksternal. Rencana juga menghapus `message` setelah satu siklus, yang mematahkan image rollback. | Perubahannya **aditif saja**. Setiap route mempertahankan bentuk sesuai kontraknya. Field `code`, `messageId`, dan `params` (opsional) ditambahkan. String `error` Indonesia **tetap ada** untuk log, agen, dan image lama. `lib/api-error.mjs` menormalkan kedua bentuk. Klien tidak pernah menampilkan `error` kalau `messageId` ada. |
| K3 | **Tinggi** | Kunci `errors.<code>` bisa bentrok antar-domain. Contohnya `invalid_request` (edit, editor_ai, web), `too_large` (edit, llm), `rate_limited` (llm, web), dan `not_found`. `messageId` `editor.<code>` (42 kode di `COMMAND_MESSAGES`, `commands.mjs:170`) belum tercantum di rencana dan bertabrakan dengan namespace UI `editor.*`. Kode yang membawa detail (`glyph_unsupported:U+1F602`, `base_code()` di `errors.py`) juga belum ditangani. | Kunci katalog = `errors.` + `messageId` apa adanya: `errors.edit.range_invalid`, `errors.editor.hook_missing`, `errors.editor_ai.<c>`, `errors.llm.<c>`, `errors.download.<c>`, `errors.storage.<c>`, `errors.web.<c>`. `messageId` yang sudah ada tidak diubah. Detail setelah `:` menjadi parameter `{detail}`. |
| K4 | **Tinggi** | Beberapa angka meleset: `edit_v2/errors.py` punya 70 kode (bukan 81) dan `llm.py ERROR_CODES` punya 20 (bukan 18). `"id-ID"` hanya ada di 18 file (bukan 22), ditambah `toLocaleLowerCase("id")` di `llm-settings{,-view}.mjs` dan `localeCompare(…, "id-ID")` di `trend-view.mjs:313`. Error literal Indonesia ada sekitar 67 baris di 24 file. Selector teks e2e sekitar 1.866 baris di 44 spec. `getByTestId` dipakai 32 kali. | Angka diperbaiki di §0. Estimasi dan daftar tes memakai angka ini. |
| K5 | **Tinggi** | use-intl **tidak punya integrasi RSC** (dokumentasi core library). Halaman server (`bantuan`, `licenses`, `not-found`) merender `AppShell` yang client. `IntlProvider` yang bersarang **mengganti** pesan, tidak menggabungkannya. Rute editor berada di bawah `projects/layout.jsx`. | Aturan: server component memakai `getT(locale)` (`createTranslator`), client component memakai `useTranslations`. `<I18n>` dipasang di root layout dengan namespace inti. Segment layout memasang provider bersarang dengan pesan **gabungan** (inti + rute). Halaman editor memasang provider sendiri berisi `editor.*`. |
| K6 | **Tinggi** | Membaca `cookies()` di root layout membuat **semua** rute jadi dynamic, termasuk landing `/` dan halaman client yang sekarang diprerender statis. Rencana hanya menyebut landing. | Diterima secara sadar. M0 mengukur TTFB `/`, `/dashboard`, dan `/login` sebelum dan sesudah. HTML diberi `Cache-Control: private, no-store`. `VM_NGINX_CLOUDFLARE.md` diperbarui. |
| K7 | **Tinggi** | HeroUI v3 menulis label Inggris sendiri, terpisah dari React Aria (`close-button.js`: `"aria-label": "Close"`). Rencana hanya membahas React Aria. | Wrapper `components/ui/*` juga menimpa label bawaan HeroUI. Tes `heroui-default-labels` memindai `node_modules/@heroui/react/dist/**` untuk literal `"aria-label": "` dan gagal kalau komponen yang dipakai belum dibungkus. Tes ini juga menangkap label baru saat upgrade. |
| K8 | **Tinggi** | Rendering caption harus **terbukti** tidak bergantung locale UI, bukan sekadar dinyatakan. Yang ada sekarang aman: ASS dirender di server, JASSUB memakai ASS yang sama (G-DET), dan `caption-lines.mjs:126` memakai `toLocaleUpperCase("id")` sebagai konten. Tetapi belum ada tes yang menguncinya. | `content-language-isolation.test.mjs` diperluas: digest plan, ASS, dan `render_key` dari dokumen yang sama harus identik antara sesi `id` dan `en`. `parity-text` tetap dijalankan hanya di `id`. |
| K9 | Sedang | Prosa Indonesia dari Python di luar `report()` belum tercakup. Contohnya alasan seleksi `_with_reason` di `selection_v3.py` ("Pengisi dari heuristik…", "Cold open: kalimat hook …") dan catatan di `ranking.py`, `features.py`, `pipeline.py`, yang tampil di "Kenapa dipilih" dan di peringatan. | Tambahkan `reason_codes` dan `warning_codes` (+params) secara aditif di manifest. Alasan yang ditulis LLM adalah konten dan tidak diterjemahkan. Job lama tampil apa adanya. Ini masuk M5. |
| K10 | Sedang | Pencarian Bantuan mencocokkan teks error yang ditempel (`shown` di `help-catalog.mjs`). Pengguna bisa menempel pesan dari locale lain, dari job lama, atau dari log. | Indeks pencarian memuat teks `shown` dari **semua** locale plus kode. Teks entri tampil dalam locale aktif. |
| K11 | Sedang | Allowlist per file untuk `Intl` konten tidak cocok. `project-view.mjs` mencampur tanggal UI (:54) dengan lowercase untuk pencarian (:131), dan `trend-view.mjs` mencampur tanggal UI dengan sort. | Allowlist dibuat per call-site. Panggilan konten dipindah ke `lib/content-text.mjs` (`contentLower(text, lang)`, dll.), dan tes melarang locale literal di luar `lib/i18n/` dan `lib/content-text.mjs`. |
| K12 | Sedang | Mengganti mirror JS `shell-model.mjs` hanya dengan tes keberadaan kunci menghilangkan bukti drift G-FAIL (`editor-shell-model.test.mjs`). | Teks `errors.edit.*` di `messages/id.json` harus **sama persis** dengan `_MESSAGES` Python (dibaca lewat subproses, seperti `help-catalog.test.mjs:39`). Locale lain cukup wajib punya kuncinya. G-FAIL menjadi "kode tetap + pesan Indonesia + entri di setiap locale". |
| K13 | Sedang | `look-preview.mjs:53` `HOOK_SAMPLE = "Teks hook"` dipakai untuk menghitung lebar kotak dari panjang teks. Kalau diterjemahkan, geometri dan tes `look-preview` ikut berubah. | `lookPreview()` menerima teks contoh sebagai argumen. Tes geometri memakai teks tetap. Label contoh diterjemahkan. |
| K14 | Sedang | `compose.yaml` menulis env per service secara eksplisit (`:165`), jadi `POTONGIN_LOCALES` di `.env` saja tidak sampai ke app. Proyek `en-smoke` di `run_read_only_e2e` akan gagal (dan memicu rollback otomatis) selama produksi masih `id`. | Tambahkan `POTONGIN_LOCALES: ${POTONGIN_LOCALES:-id}` ke service `app`, masukkan ke `deploy-env-contract` dan `.env.example`. `en-smoke` berjalan di CI dengan `id,en`, dan baru masuk `run_read_only_e2e` di M9. |
| K15 | Sedang | Clean-room: copy English paling rawan disalin dari UI SupoClip, yang memang berbahasa Inggris. | Dilarang membuka atau menyalin string UI SupoClip. `en.json` diterjemahkan dari `id.json` dan glosarium Potongin. Reviewer melakukan spot-check `en.json` dan setiap PR mencatat "sumber copy: id.json + glosarium". |
| K16 | Sedang | `i18n-hardcoded` "tanpa dependensi baru" butuh parser JSX, padahal tidak ada di deps. | Pilihan: heuristik regex dengan ratchet (false positive diterima lewat baseline), atau devDependency `@babel/parser` (MIT) dengan persetujuan pemilik. `next/dist/compiled/*` tidak boleh dipakai karena internal. |
| K17 | Sedang | Lisensi belum lengkap. use-intl juga menarik `@schummar/icu-type-parser` dan `icu-minify`. | Semua dependensi transitif dicantumkan di `/licenses`, test-first. |
| K18 | Sedang | Metadata belum dicakup: ada 12 `export const metadata` (termasuk `title.template` dan description landing) plus `<title>` di `global-error`. | Pakai `generateMetadata` per locale. Namespace `meta`. |
| K19 | Sedang | Estimasi kurang. M0 belum menghitung 18 file `Intl`, provider di 6 layout, dan 8 tes. M2 belum menghitung 24 file, 33 pembaca klien, dan normalisasi dua bentuk error. M5 belum mencakup reason codes. Penulisan ulang 46 tes regex `.jsx` dan sekitar 39 file asersi literal belum dianggarkan. | M0 6, M2 6, M5 3, ditambah migrasi tes sekitar 4 (tersebar). Totalnya sekitar **42–45 hari-dev** (§7). |
| K20 | Rendah | Nama file unduhan (`zipSaveName`, `${name}.srt`), slug, anchor `#<kode>`, dan `Content-Disposition` belum disebut sebagai bagian yang netral bahasa. | Ditulis eksplisit: semuanya tidak diterjemahkan. |
| K21 | Rendah | `users.time_zone` bukan inti i18n, dan Q4 rencana ini sama dengan roadmap Q10. | Zona waktu pindah ke M7 (Jadwal). Q4 digabung dengan roadmap Q10. |
| K22 | Rendah | Cookie dibaca `document.cookie` di `global-error`, sehingga tidak boleh HttpOnly. `__Host-` juga mewajibkan Secure, yang gagal di e2e lokal lewat http. | Nama `potongin_locale`, tidak HttpOnly (bukan rahasia), Secure di produksi. Nilainya selalu divalidasi dengan registry. |
| K23 | Info | Terverifikasi benar: `use-intl@4.14.9` (MIT, peer react ^19, sekitar 99 KB) dan `next-intl@4.14.9` (`@swc/core`, `@parcel/watcher`, `next-intl-swc-plugin-extractor`, `@eloqnt/*`, `negotiator`, sekitar 410 KB). React Aria tidak punya `id`. Kode yang sekarang **tidak** memakai locale implisit (0 `toLocaleString()` tanpa argumen), jadi `use.locale:"id-ID"` di Playwright aman. | Tetap seperti rencana. |

---

# Rencana i18n Potongin (revisi): Bahasa Indonesia + English, bisa ditambah bahasa lain

Rencana ini hanya baca. Belum ada file yang diubah, dibangun, dipasang, atau dijalankan. Path ditulis relatif terhadap ``. Rencana ini menyesuaikan diri dengan roadmap 01 beserta review-nya, dashboard 02, dan editor 03.

## 0. Audit kondisi sekarang

| Area | Temuan |
|---|---|
| Copy UI | Teks ditulis langsung di 80 file `app` dan 132 file JS/JSX `components` (sebagian besar di `components/editor`). Ada sekitar 438 baris teks JSX, 92 `aria-label` literal, 35 berbentuk template, dan 51 berbentuk ekspresi. |
| Modul view/lib | Kalimat Indonesia dirakit di `lib/*-view.mjs`, `dashboard-choices`, `stage-summary`, `clip-text`, `llm-presets`, `source-language`, `selection-v3-view` (label arketipe dan skor). Ada sekitar 1.022 literal unik, sekitar 405 di antaranya editor. |
| Bantuan | `help-catalog.mjs` (470 baris; kelompok unduhan, penyimpanan, AI) dan `help-guide.mjs` (95 baris). Ini volume prosa terbesar. Pencarian mencocokkan teks `shown`. |
| Error server | Tiga bentuk: string saja; datar `{error, code, messageId}` (`security-headers`, `asset-upload`, `default-logo`; CONTRACTS:1710); bersarang `{error:{code,messageId}}` (`preview-lane`, `camera-progress`, poll AI; CONTRACTS:552/1014). Ada sekitar 67 baris literal di 24 file dan 33 pembaca klien `body.error`. Peta pesan tersebar di `clip-edit`, `editor-ai`, `clips-zip`, `transcription-settings`, `trend-context`, `download-errors`, `llm-settings-actions`, `clip-library`. |
| Domain messageId | `edit.<code>` (Python, 70 kode + detail `code:detail`), `editor.<code>` (42 kode `COMMAND_MESSAGES` di klien), `editor_ai.<code>`. `llm.py ERROR_CODES` berisi 20 kode. |
| Python ke UI | `pipeline.py report()` sekitar 23 panggilan berisi kalimat. `run-job.mjs`/`primary-job-queue.mjs` menulis `stageDetail` (11 tempat). Alasan dan peringatan seleksi berupa prosa (`selection_v3.py _with_reason`, `ranking.py`, `features.py`). |
| Format | `"id-ID"` di 18 file, `toLocaleLowerCase("id")` di 2 file, `localeCompare("id-ID")` di 1 file, `DisplayNames(["id"])` di 2 file. Beberapa file mencampur penggunaan UI dan konten. |
| Bahasa konten (bukan UI) | `jobs.mjs` (hashtag dan judul heuristik), `caption-lines.mjs:126`, pencarian `clip-library.mjs` dan `project-view.mjs:131`, `--language` di `run-job.mjs:57`, prompt LLM, cek ejaan. |
| `<html lang>` dan metadata | `lang="id"` di `layout.jsx` dan `global-error.jsx` (dikunci `app-shell.test.mjs:257`). Ada 12 `metadata` Indonesia. |
| HeroUI/React Aria | React Aria tidak punya locale `id` (34 locale). HeroUI sendiri menulis label Inggris, misalnya `CloseButton` "Close". |
| Proxy | Matcher hanya mengecualikan `login` dan `api/auth/login` untuk pengunjung yang belum login. |
| Render | ASS dirender di server. Pratinjau JASSUB memakai ASS yang sama (G-DET). Tidak ada locale implisit di kode. |
| Tes | 47 spec e2e dengan sekitar 1.866 baris selector teks. 149 file unit, 46 di antaranya me-regex source `.jsx`, sekitar 39 dengan asersi literal Indonesia. Playwright tanpa `locale`. |
| Aturan copy | `AGENTS.md:19`, roadmap §2.9, dashboard §1.8, dan G-FAIL mewajibkan Indonesia. Semuanya diamandemen (§9). |

## 1. Library

**`use-intl@4.14.9` (MIT), dipin persis, ditambah glue sendiri di `web/lib/i18n/`. Tidak memakai `next-intl`.**

- `next-intl` membawa `@swc/core` (native), `@parcel/watcher`, plugin extractor, `@eloqnt/*`, dan wajib membungkus `next.config.mjs` (yang memuat header COOP/COEP). Kita tidak butuh routing berprefix.
- use-intl memberi ICU (plural, select, `t.rich`/`t.markup`), `useFormatter`, `createTranslator`, `createFormatter`, serta `timeZone` dan `now` di provider. **Tidak ada integrasi RSC**, jadi server memakai `createTranslator`.
- Glue sekitar 200 baris:
  - `locales.mjs` (registry)
  - `resolve.mjs`
  - `server.mjs` (`getLocale()`, `getT(locale, ns)`, `messagesFor(locale, ns[])`, `getFormat(locale)`)
  - `client.jsx` (`<I18n>` = `IntlProvider` + `I18nProvider` React Aria)
  - `format.mjs`
  - `errors.mjs` (`errorKey(messageId)`, `errorText`)
- Di luar `lib/i18n` ada `lib/content-text.mjs` untuk operasi bahasa konten.
- Lisensi: `use-intl`, `intl-messageformat`, `@formatjs/*`, `icu-minify`, dan `@schummar/icu-type-parser` masuk `/licenses`, test-first.
- **Cadangan** kalau pemilik menolak dependensi baru: kamus sendiri dengan `Intl.PluralRules` dan format katalog yang kompatibel ICU, sehingga bisa pindah ke use-intl nanti tanpa menulis ulang.

## 2. Resolusi locale

### 2.1 Registry

```
web/messages/id.json   sumber kebenaran
web/messages/en.json
web/lib/i18n/locales.mjs:
  LOCALES = [{code:"id", intl:"id-ID", label:"Bahasa Indonesia"},
             {code:"en", intl:"en-US", label:"English"}]
  DEFAULT_LOCALE = "id"
```

- Menambah bahasa = satu file JSON plus satu baris registry. Label bahasa ditulis dalam bahasanya sendiri.
- Flag `POTONGIN_LOCALES=id|id,en` (default `id`) dibaca server saat runtime. Flag ini masuk `compose.yaml` service `app`, `.env.example`, `env-example.test`, dan `deploy-env-contract`. Kode yang tidak aktif jatuh ke `id`.

### 2.2 Urutan

1. `users.locale`, setelah MU-M2.
2. Cookie `potongin_locale` (Path=/, SameSite=Lax, Secure di produksi, 1 tahun, tidak HttpOnly).
3. `Accept-Language`, hanya kalau cookie tidak ada. Pencocokan q-value sederhana, `in` dianggap `id`.
4. `id`.

### 2.3 Mengganti bahasa

- **`POST /api/locale` (publik):**
  - Body `locale` dari form native, jadi jalan tanpa JS.
  - Memakai `sameOriginMutation`, nilai harus ada di registry dan aktif menurut flag, dengan rate limit ringan.
  - Menulis cookie lalu `303` ke `Referer` same-origin, atau ke `/`.
  - Dikecualikan di matcher `proxy.js` dan dicantumkan di `proxy-matcher.test.mjs` dengan alasan "cookie preferensi, tanpa data pengguna".
  - Sejak MU-M2: kalau ada sesi valid, route ini juga menulis `users.locale`.
- Pemilih bahasa ada di menu akun shell dan di `/login`, `/undangan/[token]`, `/atur-ulang-sandi/[token]`. Bentuknya `<select>` native + [Simpan], lalu muat ulang penuh.
- **Sebelum multi-user** (login env tunggal), bahasa disimpan di cookie saja, per perangkat.
- **Setelah MU-M2:**
  - Saat login, `users.locale` disalin ke cookie.
  - Kalau `users.locale` masih NULL, nilainya diisi dari cookie atau Accept-Language.
  - Tidak ada baca DB per request, dan `proxy.js` tetap tanpa DB.
- **Rollback:** image lama mengabaikan cookie dan kolom, lalu tampil Indonesia.

### 2.4 Server dan render

- `app/layout.jsx` membaca locale, memasang `<html lang>`, dan membungkus `<I18n>` dengan namespace inti (`common`, `shell`, `status`, `aria`, `errors.web`).
- Segment layout (`dashboard`, `projects`, `settings`, `trends`, dll.) memasang provider bersarang dengan pesan **gabungan** inti + rute. Halaman editor memasang provider sendiri (`editor.*`, `errors.edit/editor/editor_ai`, inti).
- Server component (`bantuan`, `licenses`, `not-found`, landing, `login`) memakai `getT`. Komponen yang memanggil `useTranslations` wajib `"use client"` dan berada di bawah `<I18n>`. Tes statis memeriksa aturan ini.
- `generateMetadata` per locale (namespace `meta`) menggantikan 12 `metadata` statis.
- `global-error.jsx`: membaca `document.cookie`, lalu mengimpor statis `common` dan `errors.global` untuk semua locale (kecil).
- Semua rute jadi dynamic karena `cookies()` di root layout. Ini diterima. HTML diberi `private, no-store`, TTFB diukur di M0, dan `deploy/VM_NGINX_CLOUDFLARE.md` diperbarui.

### 2.5 URL

Tanpa prefix locale. Alasannya: header COOP/COEP editor, `editorHref`, matcher, tanpa router klien, tautan `/bantuan#kode` dan `?klip=N`, callback OAuth, dan media publik. Slug tetap Indonesia. Nama file unduhan, anchor, dan `Content-Disposition` netral bahasa dan tidak diterjemahkan.

## 3. Katalog

### 3.1 Namespace

```
common  shell  auth  meta  dashboard  projects  project  status  stage  reason
settings  trends  social  analytics  admin  account  help  landing  legal  aria
editor.{shell,transcript,text,layout,audio,logo,coldOpen,segments,export,checks,shortcuts}
errors.{web,download,storage,llm,edit,editor,editor_ai,http,global}
email (kalau SMTP disetujui)
```

`status` menggantikan `lib/status-words.mjs` usulan dashboard K16, dengan dua set: proses dan postingan.

### 3.2 Aturan kunci

- **Penamaan** `namespace.area.item` dalam camelCase. Kunci error = `errors.` + `messageId` apa adanya (`errors.edit.range_invalid`). Kode ber-detail `x:detail` dirender dengan `{detail}`.
- **Literal penuh** di `t("…")`. Kunci dinamis hanya lewat `errorText`, `stageText`, `reasonText`, atau map eksplisit, dengan daftar kode yang diuji lengkap.
- **Tidak ada kalimat dari potongan.** Contoh: `"{count, plural, other {# klip}}"` di id; `one`/`other` di en; `dashboard.summary.format` = `"{language} · {resolution}"`.
- **Fallback:** `en` di-deep-merge di atas `id` saat dimuat. Kunci yang hilang tampil Indonesia di produksi dan dilog sekali. Di tes, kunci hilang membuat tes gagal (`onError`).
- **Modul view tetap murni.** `lib/*-view.mjs` mengembalikan `{key, values}`, `{code}`, atau `{messageId, params}`. Tes view memeriksa deskriptor, ditambah satu snapshot teks `id`.
- **Copy tetap pendek di semua bahasa**: label, bukan kalimat, tanpa kalimat basa-basi. Glosarium tetap ada di DESIGN.md: Cold open, Hook, Klip → Clip, Proyek → Project, Buat klip → Create clips, Tata letak → Layout.

### 3.3 Format UI dan konten

- **UI:** semua tanggal, angka, ukuran file, detik editor, `notation:"compact"`, dan `DisplayNames([uiLocale])` memakai `useFormatter` atau `getFormat(locale)`. Konstanta modul (`const SECONDS = new Intl.NumberFormat("id-ID")`) diganti cache per locale. Waktu relatif dirender di klien dengan `now` dari server.
- **Konten:** `lib/content-text.mjs` (`contentLower`, `contentUpper`, `contentCompare`) dengan bahasa dari `job.options.videoLanguage`, atau `id` untuk data lama. Dipakai oleh `jobs.mjs`, `caption-lines.mjs`, pencarian `clip-library.mjs`/`project-view.mjs`, dan folding nama `llm-settings*`.
- **`look-preview`:** teks contoh dioper sebagai argumen. Geometri diuji dengan teks tetap.

### 3.4 Tes CI (`node --test`)

| Tes | Gagal bila |
|---|---|
| `i18n-catalog` | Set kunci beda antar-locale; ada pesan kosong; ICU gagal di-parse (`intl-messageformat`); argumen `{x}` beda; kategori plural tidak sesuai `Intl.PluralRules`; ada kunci yatim |
| `i18n-usage` | `t("…")` tidak ada di `id.json`; ada kunci tak terpakai (kecuali daftar kode) |
| `i18n-hardcoded` (ratchet) | Ada teks JSX, `aria-label`/`placeholder`/`title`/`alt`/`label` literal, `toast("…")`, atau kalimat di view module. Baseline per file hanya boleh turun. Allowlist: "Potongin", simbol, `parity-harness/**`, `__dev__/**`, teks lisensi. Parser: regex heuristik atau `@babel/parser` (Q6) |
| `i18n-intl-literal` | Locale literal dipakai di `Intl.*`, `toLocale*`, atau `localeCompare` di luar `lib/i18n/` dan `lib/content-text.mjs` |
| `i18n-registry` | `LOCALES` ≠ `messages/*.json`; default bukan `id`; flag memuat kode tak dikenal |
| `i18n-resolve` | Urutan DB > cookie > Accept-Language > `id` dilanggar; `in`=`id` gagal; q-value salah; kode nonaktif tidak jatuh ke `id` |
| `i18n-rsc-boundary` | File yang memanggil `useTranslations` tidak `"use client"`; server component memanggil hook |
| `i18n-error-codes` | Kode dari `download-errors`, `STORAGE_ERROR_CODES`, `llm.py ERROR_CODES` (subproses Python), `edit_v2/errors.py`, `COMMAND_MESSAGES`, `editor-ai`, atau `lib/error-codes.mjs` belum punya `errors.<messageId>` di semua locale. Teks `errors.edit.*` di `id.json` **sama persis** dengan `_MESSAGES` Python (pengganti mirror G-FAIL) |
| `heroui-default-labels` | Literal `"aria-label": "…"` di `@heroui/react/dist` milik komponen yang dipakai tidak tertutup wrapper |
| `content-language-isolation` | argv/env anak `run-job`, `python-cli`, `editor-ai`, `clip-text-api` beda antara sesi `id` dan `en`; atau digest plan, ASS, dan `render_key` dokumen yang sama beda antar-locale |
| `proxy-matcher` (diubah) | `/api/locale` tidak terdaftar dengan alasan |

Pseudo-locale `qps` hanya untuk dev, tidak masuk registry produksi.

## 4. Error server, API, dan Python

### 4.1 Kontrak (aditif)

- Setiap route **mempertahankan bentuknya sesuai CONTRACTS**: datar `{error, code, messageId}` atau bersarang `{error:{code, messageId, …}}`.
- Route lama yang hanya mengirim string mendapat tambahan `code`, `messageId`, dan `params?`. String `error` Indonesia **tetap ada**, untuk log, agen Hermes, dan image lama.
- Registry `web/lib/error-codes.mjs` menampung domain `web.*`: `invalid_request`, `unauthorized`, `csrf_rejected`, `rate_limited`, `queue_capacity_reached`, `job_service_unavailable`, `request_too_large`, `login_invalid`, `user_queue_full`, `quota_exceeded`, plus kode baru dari multi-user, sosmed, dan unduhan.
- Kontrak ini dicatat di CONTRACTS dalam satu § baru, bersama alokasi §5.59–§5.64.

### 4.2 Klien

- `lib/api-error.mjs` menormalkan string, bentuk datar, dan bentuk bersarang menjadi `{code, messageId, params, legacyText}`.
- `errorText(t, err)`: kunci `errors.<messageId>`. Kalau tidak ada `messageId`, pakai `legacyText`. Kalau itu juga tidak ada, pakai `errors.web.unknown`.
- `hint` dan tautan `/bantuan#<code>` tetap sama.
- Peta pesan di `download-errors`, `storageMessage`, `upload-client`, `shell-model`, `commands.mjs`, `clip-text-api`, `trend-view STATUS_MESSAGES`, dll. hanya menyimpan daftar kode. Teks Indonesia untuk respons server dipindah ke satu helper server `legacyMessage(code)` yang membaca `id.json`.

### 4.3 Python

- `edit_v2/errors.py _MESSAGES` tetap ada (log, dev, string `error`). UI memakai `message_id()`.
- G-FAIL menjadi: "kode tetap + pesan Indonesia + entri di setiap locale". Buktinya `i18n-error-codes`. 13 tes Python tidak berubah.
- `llm.py ERROR_CODES` (20) dipetakan ke `errors.llm.<code>`. Anchor Bantuan `llm_<code>` tetap.
- **Progres:** `report(stage, %, detail)` mendapat tambahan `stage_code` dan `stage_params`. Literal `stageDetail` di `run-job.mjs`/`primary-job-queue.mjs` mendapat `stageCode`. UI merender `stage.<code>`. Job lama tetap menampilkan `stageDetail`. Label V2 hilang dari layar ("Latest only").
- **Alasan dan peringatan seleksi:** `reason_codes`/`warning_codes` (+params) ditambahkan secara aditif di manifest dari `selection_v3.py`, `ranking.py`, `features.py`, `pipeline.py`. Alasan yang ditulis LLM adalah konten dan tidak diterjemahkan. Job lama tampil apa adanya.
- `job.error` tetap teks teknis di disclosure detail.

### 4.4 Audit, notifikasi, email

- `audit_events`, status posting, dan notifikasi disimpan sebagai `code` + `params`, lalu dirender dalam bahasa penonton.
- Email (kalau SMTP disetujui): namespace `email.*`, dirender dalam `users.locale` penerima. Undangan memakai bahasa pilihan admin, default bahasa admin. Isinya label pendek.

## 5. Editor, HeroUI/React Aria, waktu

### 5.1 Editor: bahasa UI ≠ bahasa konten

- **Diterjemahkan:** label tab (Teks · Tata letak · Audio · Logo · Cold open), toolbar, nama paket caption, Perlu dicek/Catatan, `errors.edit.*`, `errors.editor.*`.
- **Tidak pernah diterjemahkan:** teks caption, kata transkrip, hook, judul, deskripsi, hashtag, saran LLM, dan bahasa cek ejaan. Semuanya mengikuti `videoLanguage`/`sourceLanguage`. Dokumen edit, ASS, plan, dan `render_key` tidak boleh menyimpan atau bergantung pada teks UI (dikunci tes isolasi, K8).
- Nama bahasa di "Bahasa video" diterjemahkan, tetapi nilainya tetap `id|en|auto`.
- Detik di `TranscriptPanel`, `TextPanel`, `CleanupReview`, dan `model.mjs` serta jam di `ExportDialog` mengikuti locale UI.
- Editor tidak punya pemilih bahasa sendiri. Ganti bahasa = muat ulang penuh, aman untuk COOP/COEP. Pesan disajikan inline dan same-origin.
- `parity-text` dan screenshot editor dijalankan hanya di `id`.

### 5.2 HeroUI/React Aria

- `components/ui/Providers.jsx`: `<I18nProvider locale={registry.intl}>`. Tetap **tanpa RouterProvider**.
- Wrapper `components/ui/*` (`SearchField`, `Modal`, `Drawer`, `CloseButton`, `Table`, `DatePicker`, `TagGroup`, `Pagination`, `ToastProvider`, `Disclosure`) mengisi label dari `aria.*` di **semua** locale. Cakupannya label React Aria (tidak ada untuk `id`) **dan** label hardcode HeroUI ("Close" dan sejenisnya).
- Editor (RAC langsung untuk `GridList`/`FileTrigger`) memakai aturan yang sama.
- E2E `aria-names.spec`:
  - Di `id`: tolak "Close", "Clear search", "Dismiss", "Select all", "Previous", "Next", "Calendar", "Remove", "Loading".
  - Di `en`: tolak kata Indonesia umum.
  - Istilah glosarium (Hook, Cold open, Logo, Audio) masuk allowlist.

### 5.3 Waktu dan zona (bagian M7)

- Zona dari `users.time_zone` (IANA). Kalau NULL, pakai zona browser yang dikirim sekali. Fallback `Asia/Jakarta`.
- `IntlProvider` menerima `timeZone` dan `now` dari server.
- DatePicker memakai `ZonedDateTime`. Disimpan sebagai ISO UTC plus zona asal.
- Nama zona pendek tetap ditampilkan (bukan `hideTimeZone`).
- `hourCycle` ikut keputusan roadmap Q10.

## 6. Tes dan E2E

1. `playwright.config.mjs` `use.locale:"id-ID"` di semua proyek (termasuk `mobile-chromium`). `e2e/support/harness.mjs` memasang cookie `potongin_locale=id`. Selector teks yang ada tetap valid selama `id.json` sama dengan copy layar saat ini. Aman karena kode tidak memakai locale implisit.
2. **Proyek `en-smoke`** (desktop-chromium, `en-US`, cookie `en`): `smoke`, `read-only`, `app-shell`, `aria-names`, satu alur Buat klip sampai `/projects/[id]`, buka editor, dan `editor-first-frame`. Di CI berjalan dengan `POTONGIN_LOCALES=id,en`. Baru masuk `run_read_only_e2e` pasca-deploy di M9.
3. Spec baru atau yang ditulis ulang: role + nama lewat helper `e2e/support/i18n.mjs` (`L("dashboard.submit")`). `data-testid` hanya untuk elemen tanpa nama stabil. Ratchet ringan di `e2e/` menolak literal teks di spec baru.
4. Unit:
   - 46 tes regex `.jsx` diubah memeriksa `t("kunci")` atau deskriptor, dengan asersi setara (tidak dihapus).
   - Sekitar 39 file asersi literal beralih ke `{key, values}` + satu snapshot `id`.
   - `app-shell.test.mjs:257` diubah ke `lang={locale}`.
   - `help-catalog.test` memeriksa kunci.
   - `editor-shell-model.test` diganti oleh `i18n-error-codes`.
5. Tes berat tetap di GitHub Actions. Di PC pemilik hanya tes `i18n-*` yang ditargetkan.

## 7. Milestone

**Prinsip.** Fondasi dibangun bersama Fase 0–1 dashboard. Layar yang ditulis ulang lahir dengan kunci dan dua bahasa di PR fasenya. Editor diterjemahkan dalam fase-fase editor.

| Milestone | Ikut fase | Isi | Kriteria terima | Hari |
|---|---|---|---|---|
| **M0 Fondasi** | Dashboard Fase 0 (setelah G0) | `use-intl` dipin; `lib/i18n/*`, `lib/content-text.mjs`; `messages` inti; provider root + segment; `<html lang>` dan `generateMetadata`; migrasi 18 file `Intl` + 3 file konten; tes §3.4 dengan baseline; Playwright; flag di compose/.env/kontrak; lisensi | `next build` hijau; screenshot shell `id` sama; `en` bisa dimuat lewat cookie di dev; tes `i18n-*` hijau; CSS dan bundle editor tidak berubah; TTFB tercatat | 6 |
| **M1 Shell + pemilih + login** | Dashboard Fase 1 | `shell`, `auth`, `errors.http/global`; `POST /api/locale` publik + matcher; pemilih di menu akun dan `/login`; not-found, error, global-error | Ganti bahasa ≤ 2 klik, bertahan setelah reload, jalan tanpa JS di `/login`; pengunjung tanpa cookie mengikuti Accept-Language; `en-smoke` shell+login hijau di CI; ratchet 0 di `AppShell`, `login`, `not-found`, `error` | 3 |
| **M2 Kode error** | Bersama Dashboard Fase 2 | `lib/error-codes.mjs`, `lib/api-error.mjs`; `code` + `messageId` aditif di 49 route; 33 pembaca klien; peta pesan jadi daftar kode; `errors.*` id+en; amandemen G-FAIL dan CONTRACTS | `i18n-error-codes` hijau; tidak ada error tanpa `code` (ratchet 0 di `app/api`); tes route dan kontrak lama hijau tanpa diubah; agen tren tidak terdampak | 6 |
| **M3 Per layar** | Dashboard Fase 2–6 dan 10 | Buat klip, Detail + penampil, Proyek, Pengaturan, Tren, Bantuan/error/lisensi; view module → deskriptor | Per fase: ratchet 0 untuk file yang disentuh; `en-smoke` diperluas; screenshot `en` 360 px tanpa scroll horizontal | 6 |
| **M4 Bantuan** | Dashboard Fase 10 | `help-catalog` dan `help-guide` → `help.*`; indeks pencarian semua locale | `help-page.test` (tanpa JS) hijau di kedua bahasa; pesan `id` yang ditempel di UI `en` tetap ketemu | 3 |
| **M5 Kode dari worker** | Paralel, sebelum M3 Detail | `stage_code`/`stageCode`; `reason_codes`/`warning_codes`; namespace `stage` dan `reason` | Job baru tampil dalam bahasa UI; job lama tetap tampil; tes `report`, seleksi, dan `project-view` hijau; gold benchmark seleksi byte-identik | 3 |
| **M6 Preferensi di DB** | Setelah MU-M2 | Kolom `users.locale` (migrasi aditif); sinkron login ↔ cookie; `/api/locale` menulis DB kalau ada sesi; Bahasa di `/akun` | Perangkat kedua memakai bahasa dari DB; image lama mengabaikan kolom; `db-migrations` hijau | 1,5 |
| **M7 Sosmed/Analitik/Admin** | Dashboard Fase 7–9 (terblokir backend) | `admin`, `social`, `analytics`; `users.time_zone` dan DatePicker berzona; status dan audit berbasis kode; `email.*` kalau SMTP ada | Jadwal yang dibuat di `en` zona X tampil benar di `id` zona Y; e2e `publish` di dua locale | 4 |
| **M8 Editor** | Editor Fase 0–10 | Fase 0: provider + `aria.*` di wrapper RAC/HeroUI. Tiap fase: `editor.*` untuk area yang dirombak; `errors.editor.*` | Ratchet 0 di `components/editor/**` setelah Fase 10; `parity-text` dan screenshot `id` tidak berubah; tes isolasi (plan/ASS identik) hijau; `en-smoke` buka editor dan ekspor | 9 |
| **M9 Rilis `en`** | Setelah M3+M4 (dan M8 menurut Q2) | `POTONGIN_LOCALES=id,en` di produksi; `en-smoke` masuk `run_read_only_e2e`; review copy oleh pemilik | Ratchet 0 di semua rute yang terlihat pengguna; pemilik setuju | 0,5 + review |
| **Migrasi tes** (tersebar) | M0–M3 | 46 tes regex, sekitar 39 file literal, helper e2e | Asersi setara, tidak ada yang dihapus | ≈ 4 |
| **Total** | | | | **≈ 42–45 hari-dev**, sekitar 10 di antaranya menumpang PR fase lain |

**Dampak ke estimasi lain:**
- Dashboard (52–66) naik sekitar 25 (M0–M4, M7, migrasi tes).
- Editor (sekitar 81) naik sekitar 9.
- Roadmap fitur naik sekitar 4,5 (M5, M6).

## 8. Risiko

| Risiko | Mitigasi |
|---|---|
| Churn: sekitar 1.400 literal ditambah prosa Bantuan selagi layar dirombak | Kunci dibuat saat layar ditulis ulang; ratchet per file |
| Copy `en` bertele-tele atau merusak layout 360 px | Aturan label berlaku untuk semua bahasa; `qps` di dev; screenshot `en` per fase |
| Label Inggris di `id` (React Aria tanpa `id`; HeroUI menulis "Close") | Wrapper wajib; tes `heroui-default-labels`; e2e `aria-names` |
| Locale UI bocor ke engine, LLM, atau render | `content-language-isolation` (argv/env + digest plan/ASS); `videoLanguage` satu-satunya sumber bahasa konten |
| Perubahan bentuk error mematahkan klien atau agen | Aditif saja; `error` string tetap; `api-error.mjs` menormalkan |
| Semua rute jadi dynamic | Ukur TTFB di M0; `private, no-store` |
| Cache edge menyajikan bahasa yang salah | HTML tidak di-cache; catatan di `VM_NGINX_CLOUDFLARE.md` |
| Hydration mismatch tanggal | `timeZone` dan `now` dari server; waktu relatif di klien |
| Job lama berisi prosa Indonesia | Ditampilkan apa adanya (legacy) |
| Rollback otomatis karena `en-smoke` | Masuk pasca-deploy baru di M9 |
| Clean-room: copy en mirip SupoClip | Larangan eksplisit; sumber = `id.json` + glosarium; spot-check reviewer |
| Dependensi baru | Pin persis, MIT, tanpa native; cadangan kamus dengan format ICU yang sama |

## 9. Amandemen dokumen (bersama G0b, menunggu persetujuan)

- **`AGENTS.md:19`**: "Copy UI ditulis di `web/messages/id.json` (sumber) dan diterjemahkan ke setiap locale di registry. Pendek, berupa label, di semua bahasa. Bahasa konten mengikuti `videoLanguage`." Tambah klausul clean-room untuk copy `en`.
- **`DESIGN.md`**: bagian "Bahasa" (pemilih, slug tetap, glosarium).
- **Roadmap §2.9** dan **dashboard §1.8, §4.8–4.9**: "Indonesia" → "dari katalog, locale aktif".
- **`docs/editor/GATES.md` G-FAIL**: "kode tetap + pesan Indonesia + entri di setiap locale".
- **CONTRACTS**: § baru untuk `messageId`/`params` aditif dan `stage_code`/`reason_codes`.
- **`proxy-matcher`**: entri `/api/locale` beserta alasannya.
- Dokumen operasional, self-check deploy, dan CLI tetap Indonesia dan di luar lingkup.

## 10. Pertanyaan untuk pemilik (6)

1. **Copy English:** implementer menulis draf dari glosarium dan pemilik mereview per fase. Setuju? Apakah `/privasi`, `/ketentuan`, dan landing `/` juga perlu versi English?
2. **Kapan `en` dinyalakan:**
   - (a) setelah dashboard selesai, dengan editor sementara memakai fallback Indonesia;
   - (b) setelah editor selesai dirombak;
   - (c) ekstraksi cepat editor yang sekarang (+5 hari, sebagian terbuang).

   Usulan: (b) untuk semua pengguna, dan (a) sebelumnya hanya untuk admin.
3. **Bahasa awal pengguna baru:** ikut Accept-Language, atau selalu `id`? Undangan memakai bahasa pilihan admin?
4. **Format jam dan zona:** digabung dengan roadmap Q10.
5. **Default "Bahasa video"** untuk pengguna dengan UI `en`: tetap Indonesia, atau Deteksi otomatis? Pilihan ini juga menentukan bahasa judul, hashtag, dan caption dari LLM.
6. **Dependensi:** setuju menambah `use-intl` (runtime), dan `@babel/parser` (devDependency, untuk tes teks hardcode)? Kalau tidak, dipakai kamus sendiri dan heuristik regex.