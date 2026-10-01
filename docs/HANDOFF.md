# Handoff: status dan cara melanjutkan

Terakhir diperbarui 2026-10-01. Pekerjaan agen dihentikan pemilik untuk menghemat token; semua hasil
sementara ada di branch GitHub di bawah. Dokumen ini untuk agen atau device mana pun yang
melanjutkan. Aturan proyek: `AGENTS.md`; arah desain: `DESIGN.md`.

## 1. Sudah live di produksi (`main`)

- Selection V3 (pemilihan momen dengan LLM gratis + heuristik), halaman Pengaturan AI (key
  terenkripsi), server LLM sendiri/9Router, thumbnail klip, Whisper bertanda baca, heuristik v3.1.
- Upload > 10 MB (route upload tidak lewat proxy).
- Konteks Tren (`docs/plans/2026-09-25-konteks-tren.md`) dan Fokus klip
  (`docs/plans/2026-09-25-fokus-klip.md`).
- Skill antislop (mode during), `AGENTS.md`, `DESIGN.md`.

Deploy terjadi otomatis lewat CI setiap ada merge ke `main`.

## 2. Keputusan pemilik yang berlaku

- **Selalu terbaru:** tanpa label versi di tampilan, tanpa mode lama; yang lebih baik langsung
  menggantikan yang lama.
- **Desain:** gelap di semua halaman, DM Sans, satu aksen lime, gerak halus (`DESIGN.md`).
- **LLM:** penyedia gratis dulu; jangan pindah ke model berbayar tanpa bertanya.
- **Konteks Tren:** tren hanya untuk kemasan + dorongan ringan, selalu di-ground ke transkrip.
- **Fokus klip:** "utamakan, sisanya diisi" (klip yang cocok duluan, sisa slot diisi dan diberi
  label).
- **Editor lama (kandidat V2) dipensiunkan.** Job lama tetap bisa dilihat dan diunduh.
- **Mesin render baru** untuk klip otomatis dinyalakan begitu render-nya dipercepat (sekarang
  1,4–2× lebih lambat). Encode kualitas tinggi (file ± 2,3× lebih besar) sudah disetujui.
- Rencana editor dan semua keputusan K1–K15: `docs/plans/2026-09-24-editor-v3-esensial.md` §12.

## 3. Jalur A: UI "selalu terbaru" + tema gelap (selesai, menunggu PR)

Tujuan: dashboard satu alur tanpa V1/V2/"Mode lama", tanpa label versi di mana pun, editor lama
dipensiunkan (halaman dan route web-nya dihapus, tautan lama diarahkan ke halaman proyek), semua
halaman non-editor gelap sesuai `DESIGN.md`. Job baru selalu memakai seleksi terbaru; API menolak
v1/v2; default CLI ikut terbaru. Modul backend lama dibiarkan dulu (dihapus di jalur B).

| Branch | Isi | Status |
|---|---|---|
| `ui-dark-tokens` | token gelap + header bersama | selesai |
| `ui-dark-p1` | login, landing, dashboard, default API/CLI | selesai (wip ditinjau dan ditulis ulang) |
| `ui-dark-p2` | riwayat, halaman proyek, pensiun editor lama | selesai (wip ditinjau dan ditulis ulang) |
| `ui-dark-p3` | Pengaturan, Konteks Tren, halaman 404/galat | selesai |
| `feat/ui-latest-dark` | semuanya di atas `main` + sambungan + penjaga CI | selesai, siap PR |

Langkah:
1. Selesai: p1 dan p2 diselesaikan dari commit "wip"; p3 dicek.
2. Selesai: digabung ke `feat/ui-latest-dark` (riwayat linear di atas `main` `0b07bb8`).
3. Selesai: semua tes (§6), screenshot semua halaman di 1366 dan 390 px, audit antislop (kontras
   dengan `python3 .claude/skills/antislop-human/contrast-check.py`), cari sisa kata versi
   (V1|V2|V3|Selection V|Mode lama|mesin lama|mesin baru|llm-select) di teks yang terlihat.
4. Belum: PR ke `main` (merge rebase) → deploy.
5. Selesai: penjaga CI (label versi di tampilan, warna di luar token, kontras di bawah AA).

Hasil integrasi:
- p1, p2, p3 di-cherry-pick di atas `ui-dark-tokens`; konflik di `globals.css`, `jobs.mjs` dan
  `TrendChips` diselesaikan, gaya global yang tak dipakai lagi dibuang.
- Sambungan: riwayat dan halaman proyek menyembunyikan teks tahap/galat yang menyebut versi
  (sama seperti dashboard, `web/lib/stage-detail.mjs`); label sumber "V1" yang tak terpakai
  dihapus; kilau bar progres memakai token `--sheen`; tautan kecil di Pengaturan dan Konteks Tren
  jadi target 44 px; input tanggal kini menampilkan cincin fokus.
- Penjaga CI `web/tests/ui-guards.test.mjs` (jalan di `npm test`): kata versi di string dan teks
  JSX (`app`, `components`, `lib`, `scripts`), warna di luar token `:root`, dan setiap pasangan
  teks/latar yang dipakai stylesheet di bawah AA. Tiap penjaga dibuktikan gagal pada pelanggaran
  yang ditanam.

Catatan terbuka untuk pemilik:
pilihan "Tanpa LLM" per job hilang dari dashboard (AI diatur di Pengaturan; API masih menerima
`llmMode=off`); route status render `/api/jobs/<id>/renders/<renderId>` dibiarkan untuk editor
baru.

## 4. Jalur B: Editor (W3 sebagian, lalu W4)

Rencana lengkap: `docs/plans/2026-09-24-editor-v3-esensial.md` (§11.3 W3, §11.4 W4). Kontrak dan hasil
gerbang ada di branch editor: `docs/editor/{CONTRACTS,GATES,PANDUAN-EDITOR}.md`.

- `editor-w3-base`: `main` (sebelum `AGENTS.md`) + W1 + W2, sudah di-rebase dan lolos semua tes
  (3.783 tes Python, 983 tes web). W1 (mesin render tunggal) dan W2 (editor bisa dipakai)
  selesai dan terverifikasi.
- Branch tugas W3 (semua sebagian, berbasis `editor-w3-base`):

| Branch | Fitur |
|---|---|
| `editor-w3-t3.1` | unggah aset (+ pengecualian proxy) |
| `editor-w3-t3.2` | logo / watermark |
| `editor-w3-t3.3` | musik + ducking (commit terakhir "wip") |
| `editor-w3-t3.4` | saran hook AI |
| `editor-w3-t3.5` | Rapikan (kata pengisi, gagap, jeda) |
| `editor-w3-t3.6` | ganti tata letak + face-track |
| `editor-w3-t3.7` | waveform + penanda (commit terakhir "wip") |

Langkah:
1. Selesaikan tiap tugas dari commit terakhirnya (TDD, gerbang di rencana §11.3).
2. Integrasi T3.Z: cherry-pick t3.1 → t3.7 ke `editor-w3-integration`, sambungkan registry, editor
   digelapkan sesuai `DESIGN.md`, tanpa istilah versi/mesin di tampilan, gerbang W3, panduan.
3. W4 (rencana §11.4) dengan perubahan dari pemilik:
   - editor lama dipensiunkan: T4.1 tidak lagi memperbaiki 8 bug-nya; hapus jalur backend lama
     setelah jalur A menghapus sisi web-nya;
   - T4.3 mempercepat render mesin baru, lalu `POTONGIN_RENDER_ENGINE` dinyalakan ke mesin baru;
   - tombol "Edit klip" harus mudah ditemukan (dari riwayat dan kartu klip) dan tanpa langkah
     "Siapkan untuk editor" manual (pemilik tidak menemukannya saat mencoba);
   - tes web "a live lock heartbeat prevents overlap beyond the stale interval" sering gagal di
     CI: buat deterministik (jam palsu), jangan hanya memperpanjang waktu.
4. Rebase ke `main` terbaru (akan ada konflik dengan jalur A di halaman proyek), PR, deploy.
5. Titik cek pemilik 3: uji U1–U7, penilaian 30 saran hook AI, konfirmasi daftar kata pengisi.

Gerbang paritas diukur di image produksi (`docker build -t ai-video-clipper:editor .`): FFmpeg
5.1.9 dan libass 0.17.1 dipin lewat snapshot Debian; `resources/toolchain.json` masuk kunci
render.

## 5. Lain-lain yang tertunda

- Judul klip fokus dari heuristik masih kasar: satu permintaan LLM untuk merapikan judulnya.
- ~~Perbarui `docs/ROADMAP.md` dengan keputusan 2026-09-30.~~ Selesai di `feat/ui-latest-dark`.
- Pemilik: ganti API key LLM dan password server yang pernah tertempel di chat.

## 6. Menyiapkan lingkungan di device baru

```bash
git clone https://github.com/RevDonz/ai-video-clipper.git && cd ai-video-clipper
git fetch origin && git switch <branch>
uv sync --frozen --extra vision --extra web --extra transcribe   # Python 3.11+, FFmpeg di PATH
(cd web && npm ci && npx playwright install chromium)
uv run ruff check src tests && uv run pytest        # pyproject sudah memakai -q; jangan tambah -q lagi
(cd web && npm test && npm run build)
```

Menjalankan aplikasi lokal: `web` (Next.js) + `web/scripts/primary-worker.mjs` dengan env
`JOBS_ROOT`, `POTONGIN_SETTINGS_DIR`, `APP_USERNAME`, `APP_PASSWORD`, `APP_SESSION_SECRET` (acak,
≥ 32 karakter, simpan, karena key LLM terenkripsi dengannya), `PYTHON_BIN`/`AI_CLIPPER_BIN` dari
`.venv`, `MAX_UPLOAD_BYTES`, dan `JOBS_STORAGE_*`/`PRIMARY_*` seperti di `compose.yaml` dan
`docs/operations/STORAGE_RETENTION.md`. Key LLM diisi lewat halaman Pengaturan. Untuk editor:
`POTONGIN_EDITOR_V3=on`, render worker (`python -m ai_clipper.render_worker --watch`), dan
`resources/toolchain.json` lokal (`python -m ai_clipper.edit_v2.toolchain write …`, lihat
`docs/editor/PANDUAN-EDITOR.md` di branch editor).

## 7. Hemat token

- Satu jalur dulu (A lebih kecil dan hasilnya langsung terlihat), baru B.
- Sedikit agen: untuk bagian kecil cukup satu pembangun + satu pemeriksa.
- Lanjutkan dari commit yang ada; jangan mulai ulang tugas yang sudah punya banyak commit.
