# Handoff: status dan cara melanjutkan

Terakhir diperbarui 2026-10-01 (W3 editor selesai, lihat §4). Semua hasil ada di branch GitHub di
bawah. Dokumen ini untuk agen atau device mana pun yang
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

## 4. Jalur B: Editor (W3 selesai, lalu W4)

Rencana lengkap: `docs/plans/2026-09-24-editor-v3-esensial.md` (§11.4 W4). Kontrak, hasil gerbang
dan panduan ada di branch editor: `docs/editor/{CONTRACTS,GATES,PANDUAN-EDITOR}.md`.

- **`editor-w3-integration`: W1 + W2 + W3, di atas `main` terbaru** (jalur A: tema gelap, tanpa
  label versi, editor lama dipensiunkan). T3.1–T3.7 digabung (riwayat linear), lalu di-rebase ke
  `main` `b1ab3e0`. Semua fitur Esensial tersambung: unggah aset, logo, musik + ducking, saran hook
  AI, Rapikan, ganti tata letak + face-track, waveform + penanda, saran cold open. Editor gelap
  dengan token yang sama dengan halaman lain (penjaga UI CI lolos untuk editor). Hasil gerbang W3:
  `docs/editor/GATES.md` bagian W3.
- **Masuk ke editor (masukan pemilik):** tombol "Edit klip" di setiap kartu klip (tombol pertama)
  dan di Riwayat; tidak ada langkah "Siapkan untuk editor" lagi: editor menyiapkan proyek sendiri
  saat klip dibuka dan menampilkan progresnya.
- **Flag tetap mati secara bawaan:** `POTONGIN_EDITOR_V3`, `POTONGIN_EDITOR_UPLOADS`,
  `POTONGIN_EDITOR_LLM` = `off`, `POTONGIN_RENDER_ENGINE=legacy`.
- Branch tugas `editor-w3-t3.1` … `editor-w3-t3.7` sudah masuk; tidak perlu dilanjutkan.

Langkah berikutnya:
1. **Titik cek pemilik 3** (± 60 menit): uji U1–U7 dengan stopwatch, penilaian 30 saran hook AI
   (lulus ≥ 21/30, lalu `POTONGIN_EDITOR_LLM=on`), konfirmasi 490 label kata pengisi (lalu
   pra-centang kata pengisi di Rapikan dinyalakan), keputusan P-LOGO (1 dari 18 frame). Paketnya
   disiapkan agen W3 di luar repo (`checkpoint3.md`, lembar QG-AI dan label).
2. **W4** (rencana §11.4) dengan perubahan dari pemilik:
   - T4.1: editor lama sudah dipensiunkan; hapus jalur backend lamanya;
   - T4.3: percepat render editor (PF-CELLS latar blur di mesin 4 vCPU masih tipis), lalu
     `POTONGIN_RENDER_ENGINE` dinyalakan ke render editor;
   - P-AUD: klip VFR 16 sampel lebih pendek dari rencana (Open 12, jalur audio sumber kompiler);
   - lane pratinjau: sel yang dihapus < 30 detik setelah dibuat tidak dibuat ulang (Open 24);
   - tes web "a live lock heartbeat prevents overlap beyond the stale interval" sering gagal di
     CI: buat deterministik (jam palsu), jangan hanya memperpanjang waktu;
   - tinjauan keamanan, lalu `POTONGIN_EDITOR_UPLOADS=on`.
3. PR `editor-w3-integration` → `main` (merge rebase) setelah W4, lalu deploy.

Gerbang berat jalan di GitHub Actions, bukan di PC pemilik: `scripts/editor/w3_exit_gates.sh
<bagian>` lewat `editor-gates.yml` (`suite=command`), plus `suite=full` dan `suite=image`. Di
worktree, perintah pemindai rahasia (gitleaks) perlu folder `.git` repo utama ikut di-mount
(beserta `safe.directory`); tanpa itu ia memindai 0 commit.

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
