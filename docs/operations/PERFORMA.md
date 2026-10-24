# Umpan balik performa: aturan dan kontrak

Status: **FB-M0 (Fase 0)**. Fitur performa belum dibangun (Fase 9, `POTONGIN_PERFORMANCE` belum
ada). Dokumen ini membekukan aturan dan dua kontrak yang nanti dipakai FB-M1…M6, dan memuat
permintaan contoh CSV ke pemilik.

Sumber: rencana `docs/plans/2026-10-24-rombak/03-sosmed-performa.md` §4, §13, §14 (pemilik topik)
dan `01-arsitektur-data.md` §4.5, §4.7 (DDL). Kalau dokumen ini berbeda dengan dok 03, dok 03 yang
berlaku dan dokumen ini diperbaiki.

## 1. File beku

| File | Isi |
|---|---|
| `resources/performance/rules.v1.json` | dimensi, bucket, hookForm, ambang (§2) |
| `resources/performance/performance-profile.v1.schema.json` | kontrak snapshot profil v1 (§3) |
| `resources/performance/post-registry.v1.json` | enum kontrak registry posting (§4) |

Ketiganya dikunci sha256 JSON kanonik di `web/tests/performance-rules-frozen.test.mjs`.
`tests/test_performance_rules.py` memeriksa daftar arketipe terhadap `ARCHETYPES` engine.

Aturan versi:
- File v1 tidak pernah diubah. Perubahan = file baru (`rules.v2.json`, `post-registry.v2.json`,
  `performance-profile.v2.schema.json`) dengan kunci sha256 sendiri di tes yang sama.
- `rules.v2` (atau mengubah `POTONGIN_PERF_MIN_POSTS`/`POTONGIN_PERF_HORIZON`) wajib menjalankan
  Gate 3 (dok 03 §15.2) dan mencatat hasilnya di §6.
- `metric_horizons.rules_id` dan `selection_keys_json.rulesId` menyimpan id aturan yang dipakai,
  jadi data lama tetap bisa dibaca setelah v2.

## 2. `rules.v1`

| Kunci | Nilai | Arti |
|---|---|---|
| `dimensions` | `archetype`, `durationBucket`, `hookForm` | dimensi profil |
| `archetype` | 12 nilai, sama dengan `ARCHETYPES` (`src/ai_clipper/selection_types.py`) | dibandingkan sebagai himpunan |
| `durationBuckets` | `0-20`, `20-30`, `30-45`, `45-60`, `60+` detik | `[lo, hi)`, durasi = `sourceEnd − sourceStart`, tanpa cold open |
| `hookForm.order` | `none`, `question`, `number`, `quote`, `statement` | dicek berurutan: kosong → `none`; ada `?` → `question`; ada digit `\p{Nd}` → `number`; diawali pembuka kutip → `quote`; selain itu `statement` |
| `hookForm.quoteOpeners` | `"` `“` `'` `‘` `«` | pembuka kutip |
| `minPosts` | 20 | posting terukur minimum sebelum ada profil |
| `minGroup` | 5 | posting minimum per nilai dimensi |
| `minAccountPosts` | 5 | posting minimum per akun untuk median `rel_views` |
| `shrinkK` | 5 | shrinkage ke "seperti biasa" |
| `liftFull` | 0,25 | lift yang memberi boost penuh |
| `capPerDimension` | 0,2 | boost maksimum per dimensi (skala nilai ranking 0–10) |
| `capTotal` | 0,4 | boost gabungan maksimum per kandidat |
| `windowDays` | 180 | posting yang dihitung |
| `staleDays` | 14 | profil berstatus `stale` bila snapshot terbaru lebih tua |
| `editFarOverlap` | 0,8 | overlap di bawah ini (atau hook ditulis ulang) = `far`, keluar dari profil |

Ambang ini default Q11 (bisa diubah pemilik); setelah dibekukan, perubahan = `rules.v2`.

## 3. Kontrak snapshot profil v1

File `<job>/analysis/performance-profile.json`, ditulis `preparePerformanceProfile(job)` di
`web/scripts/primary-worker.mjs` sebelum `run-job.mjs` jalan, dibaca engine lewat
`--performance-profile <path>` (dok 03 §13.4–§13.5). Skema: `performance-profile.v1.schema.json`.

```json
{
  "version": "performance-profile-v1",
  "rulesId": "rules.v1",
  "horizon": "7d",
  "posts": 34,
  "boosts": {
    "archetype": {"humor": 0.2, "practical_tip": 0.08},
    "durationBucket": {"20-30": 0.12},
    "hookForm": {"question": 0.05}
  }
}
```

- Kunci persis: tidak ada kunci lain di tingkat mana pun. Tidak ada id pengguna, id posting, URL,
  atau angka mentah.
- `boosts` selalu memuat ketiga dimensi; dimensi tanpa boost = objek kosong.
- Setiap nilai `0 < x ≤ capPerDimension`, dibulatkan 2 desimal. Boost 0 tidak ditulis.
- `posts ≥ minPosts`. Di bawah itu status `collecting` dan file tidak ditulis (file lama dihapus).
- Engine menolak file yang tidak cocok skema atau `rulesId`-nya beda dengan aturan terpasang:
  profil diabaikan, warning `performance_profile_invalid`, job tetap jalan.
- Tanpa file, argumen `--performance-profile` tidak ditambahkan dan hasil seleksi byte-identik
  dengan tanpa fitur.

## 4. Kontrak registry posting

Tabel `posts` (DDL dok 01 §4.5, migrasi `0005-posts.sql` di Fase 8) adalah registry bersama sosmed
dan umpan balik: satu baris = satu klip yang tampil di satu platform, dari jalur mana pun. Enum di
`post-registry.v1.json` menjadi konstanta beku JS (`POST_ORIGINS`, `EDIT_CLASSES` di
`web/lib/post-registry.mjs`; `SNAPSHOT_SOURCES` di `web/lib/performance-store.mjs`) dan harus sama
persis dengan file ini.

| Kunci | Nilai |
|---|---|
| `providers` | `youtube`, `tiktok`, `instagram` |
| `postOrigins` | `publish` (run sosmed jadi `published`), `csv`, `manual`, `agent` |
| `clipKinds` | `pipeline`, `derived` |
| `editClasses` | `none`, `light`, `far`, `unknown` |
| `excludedReasons` | `edited_far`, `derived`, `manual_exclude` |
| `postErrorCodes` | `social_processing_rejected`, `social_remote_missing` |
| `snapshotSources` (`metric_snapshots.source`) | `api`, `csv`, `manual`, `agent` |
| `horizons` / `horizonQualities` | `1d`, `7d`, `30d` / `exact`, `interpolated`, `missing` |
| `uniqueExternal` | `(owner_id, provider, external_id)` unik selama tidak dihapus |

Aturan:
- `selection_keys_json` = `{"rulesId":"rules.v1","archetype":…,"durationBucket":…,"hookForm":…}`,
  maksimum 1024 byte, dihitung server di `createPost()` dari field engine (`archetype`,
  `sourceStart`, `sourceEnd`, `hookText` engine, bukan teks yang diedit pengguna).
- `selection_keys_json = NULL` bila klip turunan (`clip_kind='derived'`,
  `excluded_reason='derived'`), `edit_class='far'` (`excluded_reason='edited_far'`), atau
  pengguna mengeluarkannya (`manual_exclude`). Klip turunan dikenali dari
  `listJobClips(job)` (`entry.derived !== null`), bukan dari bentuk `clipId`.
- Origin `publish` dibuat saat run menjadi `published` (atau "Sudah terbit" dari `maybe_sent`);
  satu run paling banyak satu posting. Run gagal tidak meninggalkan baris.
- Origin `csv`/`manual`: `edit_class='unknown'`; hanya origin ini yang boleh dihapus (soft delete).
- Origin `agent` hanya menambah snapshot ke posting yang sudah ada.
- `metric_snapshots` append-only; satu-satunya UPDATE: ciut (YouTube > 30 hari tanpa refresh) dan
  soft delete.
- Data privat per pengguna: setiap query memfilter `owner_id = ?`; admin juga hanya melihat
  miliknya.

## 5. Permintaan ke pemilik: contoh CSV ekspor

Header CSV ekspor YouTube Studio, TikTok Studio, dan Instagram belum diketahui. Sampai contohnya
ada, impor hanya menerima template Potongin
(`platform,url,external_id,posted_at,captured_at,views,likes,comments,shares,saves`); file lain
ditolak `performance_import_unknown_columns`. Contoh dibutuhkan sebelum FB-M1 (Fase 9).

Yang diminta, per platform satu file:

| Platform | Laporan | Kolom yang dicari |
|---|---|---|
| YouTube Studio | Analytics → Konten → **Mode lanjutan** → tab Video (atau Shorts) → Ekspor tampilan saat ini → CSV. Kirim isi zip apa adanya (biasanya beberapa file: tabel, grafik, total). | ID atau link video, judul, waktu terbit, tayangan, suka, komentar, bagikan |
| TikTok Studio | Analitik → Konten → unduh data. Kalau tidak ada ekspor per video, kirim yang ada dan tangkapan layar menunya. | link atau ID video, waktu posting, tayangan, suka, komentar, bagikan, simpan (favorit) |
| Instagram | Dasbor profesional atau Meta Business Suite → Insights → Konten → ekspor data (CSV), untuk Reels. | link atau ID media, waktu posting, tayangan/plays, suka, komentar, bagikan, simpan |

Ketentuan:
- **Rentang:** 90 hari terakhir. Kalau bisa, sertakan minimal beberapa klip dari Potongin.
- **Bahasa:** header ikut bahasa tampilan Studio. Kalau sempat, ekspor dua kali: tampilan bahasa
  Indonesia dan bahasa Inggris.
- **Jangan buka lalu simpan ulang di Excel/Sheets.** Format tanggal, pemisah (`,` atau `;`), dan
  angka harus asli.
- **Taruh file di luar repo**, misalnya `~/potongin-csv-contoh/`, lalu beri tahu implementer.
  Repo ini publik: yang masuk repo hanya baris header dan 2–3 baris contoh dengan judul, link,
  ID, dan nama akun diganti teks palsu. Angka boleh tetap.
- Kalau menu di atas tidak ada atau namanya beda, tulis menu yang ada; itu juga data yang dibutuhkan.

Hasilnya mengisi `resources/performance/csv-profiles.v1.json` (`detect`, alias kolom,
`dateFormat`) di FB-M1.

## 6. Catatan re-gate

| Tanggal | Perubahan | Hasil Gate 3 | Run |
|---|---|---|---|
| — | belum ada | — | — |
