# Handoff: status dan cara melanjutkan

Terakhir diperbarui 2026-10-02 (editor W4 selesai, lihat §4). Semua hasil ada di branch GitHub di
bawah. Dokumen ini untuk agen atau device mana pun yang melanjutkan. Aturan proyek: `AGENTS.md`;
arah desain: `DESIGN.md`.

## 1. Sudah live di produksi (`main`)

- Selection V3 (pemilihan momen dengan LLM gratis + heuristik), halaman Pengaturan AI (key
  terenkripsi), server LLM sendiri/9Router, thumbnail klip, Whisper bertanda baca, heuristik v3.1.
- Upload > 10 MB (route upload tidak lewat proxy).
- Konteks Tren (`docs/plans/2026-09-25-konteks-tren.md`) dan Fokus klip
  (`docs/plans/2026-09-25-fokus-klip.md`).
- Jalur A (PR #14): tampilan selalu terbaru tanpa label versi, tema gelap di semua halaman, editor
  kandidat lama dipensiunkan di sisi web, penjaga UI di CI; perbaikan rate limit login (PR #15);
  workflow `editor-gates.yml` untuk tes berat (PR #16).
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
- **Editor lama (kandidat V2) dipensiunkan**, termasuk backend-nya (W4). Job lama tetap bisa
  dilihat dan diunduh; baseline benchmark tetap jalan.
- **Mesin render baru** untuk klip otomatis (`POTONGIN_RENDER_ENGINE=edit-v2`) menyala begitu
  PF-PIPELINE masuk anggaran per tata letak di PC pemilik (sudah, W4). Perubahan tampilan dan file
  yang lebih besar (encode kualitas tinggi) sudah disetujui.
- **Rilis setelah W4 dengan flag menyala bila gerbangnya lolos:** editor; unggahan setelah QG-SEC
  lengkap; saran AI setelah gerbang keras QG-AI otomatis (penilaian 30 klip oleh pemilik menyusul).
  Pra-centang kata pengisi di Rapikan tetap mati sampai pemilik mengonfirmasi labelnya.
- **Masuk ke editor** mudah ditemukan dan tanpa langkah "Siapkan" manual (W3, dipertahankan).
- **Caption bawaan (K5)** tetap di posisi klip otomatis (klip yang tidak diubah mengekspor file
  otomatis); pemberitahuan area aman TikTok dibuat informatif (catatan biru, tanpa centang).
- Rencana editor dan semua keputusan K1–K15: `docs/plans/2026-09-24-editor-v3-esensial.md` §12.

## 3. Jalur A: UI "selalu terbaru" + tema gelap (selesai, di `main`)

Dashboard satu alur tanpa V1/V2/"Mode lama", tanpa label versi di mana pun, halaman dan route web
editor lama dihapus (tautan lama diarahkan ke halaman proyek), semua halaman gelap sesuai
`DESIGN.md`. Job baru selalu memakai seleksi terbaru; API menolak v1/v2; default CLI ikut
terbaru. Digabung lewat PR #14. Modul backend editor lama dihapus kemudian di jalur B (W4, T4.1).

Catatan terbuka untuk pemilik: pilihan "Tanpa LLM" per job hilang dari dashboard (AI diatur di
Pengaturan; API masih menerima `llmMode=off`).

## 4. Jalur B: Editor (W1–W4 selesai, menunggu titik cek 3 dan PR)

Rencana lengkap: `docs/plans/2026-09-24-editor-v3-esensial.md`. Kontrak, hasil gerbang, panduan
dan operasional: `docs/editor/{CONTRACTS,GATES,PANDUAN-EDITOR,OPERASIONAL,UJI-PENERIMAAN}.md`.

- **`editor-w4-integration`: W1 + W2 + W3 + W4, di atas `main` `b1ab3e0`**, PR #18 ke `main` dengan
  judul "feat: clip editor (Esensial)" (belum di-merge). W4 = T4.1 (backend editor lama dihapus) →
  T4.2 (keamanan, QG-SEC lengkap) → T4.3 (render otomatis klip paralel, janitor, retensi) → T4.4
  (gerbang CI: smoke paritas di setiap PR, penjaga toolchain, nightly; halaman `/licenses`;
  panduan final) → T4.5 (13 uji penerimaan, QG-A11Y, catatan caption K5), lalu integrasi T4.Z.
  Hasil gerbangnya: `docs/editor/GATES.md` bagian "W4 Siap rilis". Verifikasi rilis menemukan satu
  pemblokir (penjaga deploy dan ekspor `cancelled`) dan enam temuan kecil; semuanya sudah ditangani
  di bagian "W4 verifier findings: fixes".
- **Bawaan rilis di `compose.yaml`:** `POTONGIN_EDITOR_V3=on`, `POTONGIN_EDITOR_UPLOADS=on`,
  `POTONGIN_EDITOR_LLM=on`, `POTONGIN_RENDER_ENGINE=edit-v2`. Cara mematikan satu flag di server:
  `docs/editor/OPERASIONAL.md` §2 (baris di `.env`, lalu `docker compose up -d`, tanpa build).
- Branch tugas `editor-w4-t4.1` … `editor-w4-t4.5` sudah masuk; tidak perlu dilanjutkan.

Langkah berikutnya:
1. **Titik cek pemilik 3** (± 60 menit; paketnya di luar repo, `editor-w4/checkpoint3.md` di
   scratchpad sesi integrasi):
   - uji U1–U7 dengan stopwatch di 1366×768 dan 1920×1080 (`docs/editor/UJI-PENERIMAAN.md`);
   - penilaian 30 saran hook AI (lulus ≥ 21/30). Flag LLM sudah menyala karena gerbang otomatisnya
     lolos; kalau penilaian gagal, matikan `POTONGIN_EDITOR_LLM` dan perbaiki prompt di W5;
   - konfirmasi 490 label kata pengisi; kalau presisi tetap ≥ 0,9, ubah `precheck` di
     `resources/lexicon/id-fillers.v1.json` ke `true` lewat PR.
2. **Keputusan pemilik sebelum deploy:** kuota CPU `primary-worker` (dengan `cpus: 6`, render
   otomatis potong tengah/ikuti wajah ± 2× `legacy`; naikkan kuota, terima, atau `legacy` dulu) dan
   P-LOGO (1 dari 18 frame lewat batas oleh caption di bawah logo transparan).
3. **Merge PR ke `main` (merge rebase)** → deploy otomatis. Setelah deploy: buka satu proyek,
   **Edit klip**, ekspor satu klip; proses satu video baru untuk melihat render otomatis baru.
   Rollback seluruh rilis = revert PR, **tanpa** ikut me-revert penjaga deploy
   (`fix(deploy): a cancelled export is not live work for the deploy guard`): penjaga lama di
   `main` menganggap ekspor yang dibatalkan masih jalan dan menahan deploy rollback. Paling aman,
   commit itu masuk `main` lebih dulu lewat PR kecil sendiri (`docs/editor/GATES.md`, Open 49).
4. **Sisa teknis (W5 atau sesudahnya):** P-AUD klip VFR sintetis 16 sampel lebih pendek (Open 12)
   membuat nightly merah; PF-AUDIO dengan musik tipis di runner 4 vCPU; halaman `/licenses` masih
   di balik login.

Gerbang berat jalan di GitHub Actions, bukan di PC pemilik: `editor-gates.yml` (`suite=full`,
`suite=image`, `suite=command`) dan `ci-cd.yml` (PR: tes + penjaga toolchain + smoke paritas;
`-f suite=nightly|toolchain` lewat dispatch). Di worktree, perintah pemindai rahasia (gitleaks)
perlu folder `.git` repo utama ikut di-mount (beserta `safe.directory`); tanpa itu ia memindai 0
commit.

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
