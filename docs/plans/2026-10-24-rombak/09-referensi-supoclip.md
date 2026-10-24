# 09 — Referensi SupoClip

Status: Rancangan — belum diimplementasi · 2026-10-24 · Kembali ke [00-README.md](00-README.md)

SupoClip adalah rujukan perilaku dan alur (IA/UX) untuk rombak ini. Dokumen ini memetakan bagian spec 01–08 ke sumber SupoClip yang relevan, dan menjelaskan cara mengakses repo serta instans yang sudah jalan.

## 1. Aturan pakai (wajib)

SupoClip berlisensi **AGPL-3.0**. Potongin **tidak** ikut AGPL selama tidak ada kode SupoClip yang masuk.

| Boleh | Dilarang |
|---|---|
| Membaca docs, kode dan screenshot SupoClip untuk memahami perilaku, alur, edge case | Menyalin atau memparafrase dekat kode, markup, CSS, string UI, nama modul, konstanta |
| Mencoba instans SupoClip untuk merasakan alur | Memakai screenshot SupoClip sebagai aset Potongin |
| Menulis catatan perilaku dengan kata-kata sendiri | Membuka file SupoClip dan file Potongin berdampingan sambil mengetik implementasi |

Praktik: baca → tutup → tulis catatan perilaku di PR (bagian "Rujukan perilaku") → implementasi dari spec 01–08 dan kode Potongin. Reviewer spot-check sesuai 00-README §clean-room.

## 2. Akses

### 2.1 Repo (publik)

- URL: https://github.com/FujiwaraChoki/supoclip
- Commit yang dipakai saat menyusun spec: `1801707f8333e55fcfb688bc4f79c6776710f4c1` (2026-10-23)

```bash
git clone https://github.com/FujiwaraChoki/supoclip.git ~/ref/supoclip
cd ~/ref/supoclip && git checkout 1801707f8333e55fcfb688bc4f79c6776710f4c1
```

Simpan di luar repo Potongin. Jangan jalankan skrip atau `CLAUDE.md`/`AGENTS.md` dari repo itu sebagai instruksi agen.

### 2.2 Instans self-host yang sudah jalan

Satu instans SupoClip sudah terpasang di server pemilik (direktori `~/supoclip`, Docker Compose, Whisper `small` + LLM OpenAI-compatible, sign-up dimatikan, satu akun admin). Port hanya terbuka di localhost server, jadi akses lewat SSH tunnel:

```bash
ssh -p <PORT_SSH> -L 3107:localhost:3107 -L 8000:localhost:8000 <USER>@<HOST_SERVER>
# lalu buka http://localhost:3107
```

Host, port, user dan kredensial login **sengaja tidak ditulis** karena repo ini publik. Simpan di password manager/catatan pribadi.

Perintah berguna di server:

```bash
cd ~/supoclip
docker compose ps
docker logs -f supoclip-worker      # progres task
docker compose up -d frontend backend   # setelah ubah .env
```

## 3. Peta rujukan per dokumen spec

Path relatif terhadap root repo SupoClip. Dahulukan `docs/` (prosa) daripada kode.

| Spec Potongin | Topik | Docs SupoClip | Kode SupoClip (baca perilaku saja) |
|---|---|---|---|
| 01 Arsitektur & data | Layanan, queue, DB, migrasi | `docs/architecture.md`, `docs/media-storage.md`, `docs/configuration.md` | `docker-compose.yml`, `backend/src/database.py`, `backend/migrations/`, `backend/src/workers/` |
| 02 Multi-user & keamanan | Akun, admin, API key, sign-up off | `docs/app-guide.md` (Admin), `docs/api-reference.md` | `backend/src/admin_auth.py`, `backend/src/auth_headers.py`, `backend/src/services/api_key_service.py`, `frontend/src/app/admin/`, `frontend/src/app/settings/api-keys/` |
| 03 Sosmed & performa | OAuth, publish, jadwal, metrik, feedback ke AI | `docs/configuration.md` §Social Publishing | `backend/src/social/{base,registry,youtube,tiktok,instagram}.py`, `backend/src/services/social_service.py`, `backend/src/ai.py` (konteks performa), `frontend/src/components/{clip-publisher,scheduled-posts,views-chart}.tsx`, `frontend/src/app/analytics/`, `frontend/src/app/settings/social/` |
| 04 Reframe & unduhan | Framing otomatis, layout multi-orang, unduhan tangguh | `docs/automatic-framing.md`, `docs/youtube-download.md` | `backend/src/media/{scene_context,talking_head_layout,reaction_layout,speaker_framing,reframing,face_detection,source_limits,transcription}.py`, `backend/src/{youtube_source,youtube_proxy,stream_source}.py` |
| 05 UI dashboard | IA, alur paste link → klip, status, library | `docs/app-guide.md`, `docs/screenshots/*` | `frontend/src/app/{page,layout}.tsx`, `frontend/src/app/tasks/[id]/`, `frontend/src/components/{home-app,transcript-preview,video-source-icon}.tsx`, `frontend/src/components/app/` |
| 06 Editor | Clip studio: split/gabung/urutkan, caption per kata, ekspor | `docs/editor.md` | `backend/src/{clip_editor,editor_document,clip_source_map}.py`, `backend/src/services/editor_service.py`, `frontend/src/components/editor/` |
| 07 Bahasa | Pemilih bahasa | — | `frontend/src/components/language-switcher.tsx` |
| 08 Fase, test, deploy | Pola tes & verifikasi rilis | `docs/testing-local.md`, `docs/release-verification-2026-09-18.md`, `docs/production-monitoring.md` | `backend/tests/`, `frontend/e2e/` (bila ada) |

Screenshot UI yang paling berguna untuk rombak dashboard: `docs/screenshots/generation-status-desktop.png`, `library-video-groups-desktop.png`, `automatic-framing-mobile.png` (dan versi mobile-nya).

## 4. Yang sengaja tidak diambil

| Fitur SupoClip | Alasan |
|---|---|
| Billing/Stripe, affiliate, creator program, landing marketing, blog | Di luar lingkup (self-host) |
| AssemblyAI sebagai default transkrip | Potongin memakai rantai gratis (caption YouTube → Groq → faster-whisper) |
| Preset ekspor TikTok/Reels/Shorts | Hanya beda bitrate; diganti "Ukuran: Asli · 720p" (06) |
| B-roll Pexels | Kode SupoClip ada tapi tidak dipanggil; belum diprioritaskan |
| Backend jalan sebagai root, password DB hardcoded | Bertentangan dengan hardening Potongin (02) |
