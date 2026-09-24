# Penyedia LLM untuk Selection V3 (gratis atau murah, bisa diganti kapan saja)

Selection V3 memakai LLM untuk memilih momen dan hook. Semua penyedia dipanggil lewat API
**OpenAI-compatible Chat Completions** (`POST {base_url}/chat/completions`) oleh
`src/ai_clipper/llm.py`, jadi ganti penyedia cukup lewat variabel lingkungan tanpa ubah kode.

- Tanpa LLM pun aplikasi tetap jalan: pemilih heuristik (tanpa internet) dipakai sebagai cadangan.
- Yang dikirim ke penyedia hanya **teks transkrip**, tidak pernah videonya.
- API key tidak pernah muncul di log, pesan error, manifest, cache, atau output `--check`.

## Pengaturan AI di UI (cara yang disarankan)

Semua pengaturan LLM bisa diatur dari dashboard, menu **Pengaturan** (`/settings`), tanpa
mengedit `.env` dan tanpa restart container. Job berikutnya langsung memakai pengaturan baru.

- **Status AI**: rantai penyedia yang benar-benar dipakai job berikutnya (sama dengan badge di
  halaman Buat Klip) dan sumbernya: "pengaturan di halaman ini" atau ".env server".
- **Aktifkan AI (LLM)** dan **Hanya model gratis**: saklar global (setara `POTONGIN_LLM=off` dan
  `POTONGIN_LLM_FREE_ONLY=1`).
- **Daftar penyedia**: urutan failover (tombol ↑/↓), saklar aktif per penyedia, hapus, dan
  "Tambah penyedia" dari preset (dengan tautan ke halaman pembuatan API key). Di bagian yang
  sama ada **Server OpenAI-compatible** dan **9Router (gateway)** untuk menambah server sendiri,
  sampai 3 server (lihat [Beberapa server sendiri](#beberapa-server-sendiri-hermes-9router)).
- Per penyedia: **Nama server** (hanya server sendiri, mis. "Hermes" atau "9Router"; tampil di
  daftar dan badge status), **API key** (hanya bisa diisi/diganti/dihapus, tidak pernah
  ditampilkan lagi; statusnya "Belum diisi" atau "Tersimpan ✓"), **Base URL** (wajib untuk
  server sendiri), **Model**
  plus tombol **Ambil daftar model** (server mengambil `{base_url}/models` dengan key tersimpan),
  **Model cadangan**, dan **Pengaturan lanjutan** (reasoning effort, konteks token, token output,
  timeout, batas permintaan/menit, percobaan ulang, temperature, mode JSON).
- **Tes koneksi**: menjalankan `python -m ai_clipper.llm --check --json` untuk satu penyedia
  saja memakai pengaturan tersimpan, lalu menampilkan model yang menjawab dan waktunya (atau
  kode error seperti `auth`, `model_not_found`, `timeout`).

> **Reasoning effort `none`** mematikan fase "berpikir" model reasoning. Untuk Hermes
> (server `custom` milik sendiri) ini membuat jawaban ±0,4 detik, bukan ±20 detik, dan jawaban
> tidak terpotong pada transkrip panjang.

### Beberapa server sendiri (Hermes, 9Router)

Rantai failover boleh berisi sampai **3 server OpenAI-compatible milik sendiri** sekaligus,
misalnya Hermes yang di-host sendiri **dan** gateway 9Router. Masing-masing punya ID tetap
(`custom`, `custom2`, `custom3`), nama tampilan sendiri, base URL, API key, model, model
cadangan, reasoning effort, konteks, dan timeout sendiri. Server baru mendapat ID pertama yang
masih kosong; konfigurasi `custom` lama tetap jalan tanpa diubah.

- **Nama** hanya untuk tampilan (daftar, badge "LLM aktif: ollama-cloud → Hermes → 9Router",
  CLI). Engine tidak membacanya dan nama tidak dikirim ke server mana pun. Maksimal 40 karakter,
  tanpa karakter kontrol, dan tidak boleh sama dengan nama server lain.
- **Key terikat ke servernya sendiri.** Key setiap server disegel untuk ID-nya (key `custom2`
  tidak bisa dibuka sebagai `custom`) dan hanya dikirim ke skema + host + port tempat key itu
  diisi. Memindahkan base URL 9Router ke host lain, ke port lain, atau ke alamat Hermes (dan
  sebaliknya) ditolak sampai key diisi ulang. Mengganti nama, urutan, atau path di server yang
  sama tetap memakai key lama.
- **Hanya model gratis** tidak menyaring server sendiri: server itu dianggap milik Anda. Kalau
  gateway meneruskan ke model berbayar, itu tanggung jawab pengaturan di gateway. Badge
  menambahkan "(hanya model gratis; server sendiri tidak disaring)" selama ada server sendiri
  di rantai.
- **Konteks token**: bawaan server sendiri 32.768. Pipeline memakai konteks **terkecil** di
  seluruh rantai (lihat di bawah), jadi isi "Konteks token" setiap server sesuai model di
  belakangnya (Hermes misalnya 65.536), supaya satu server tidak memotong semua permintaan.
- Dari `.env`: `POTONGIN_LLM_PROVIDERS=custom,custom2,...` plus
  `POTONGIN_LLM_CUSTOM_*`, `POTONGIN_LLM_CUSTOM2_*`, `POTONGIN_LLM_CUSTOM3_*` (akhiran sama
  dengan penyedia lain: `BASE_URL`, `MODEL`, `API_KEY`, `FALLBACK_MODELS`,
  `REASONING_EFFORT`, `CONTEXT_TOKENS`, `MAX_OUTPUT_TOKENS`, `TIMEOUT`, ... ditambah `NAME`).
  Tombol impor membawa semuanya, termasuk nama.

#### 9Router

[9Router](https://github.com/decolua/9router) adalah gateway OpenAI-compatible yang meneruskan
ke banyak penyedia dengan fallback sendiri. API-nya di **port 20128**
(`http://localhost:20128/v1`, dashboard di `http://localhost:20128/dashboard`), model ditulis
dengan awalan penyedia (mis. `kr/glm-5`) atau nama *combo* yang Anda buat di dashboard 9Router.
Tombol **Ambil daftar model** membaca `GET /v1/models` 9Router (model + combo).

1. Di Pengaturan, **Tambah penyedia → 9Router (gateway)**. Nama "9Router" dan base URL
   `http://host.docker.internal:20128/v1` sudah terisi; isi model (atau pilih dari daftar) dan
   key, simpan, lalu **Tes koneksi**.
2. Service `app` dan `primary-worker` di `compose.yaml` sudah punya
   `extra_hosts: ["host.docker.internal:host-gateway"]`, jadi gateway yang jalan di host Docker
   terjangkau lewat `host.docker.internal`. Di luar Docker (dev lokal) pakai
   `http://localhost:20128/v1`.
3. 9Router harus mendengarkan di alamat yang bisa dicapai container, bukan hanya `127.0.0.1`
   (`HOSTNAME=0.0.0.0`; image Docker 9Router sudah begitu, publish dengan `-p 20128:20128`).
   Cek dari container, hanya kode status yang dicetak (401 berarti terjangkau tapi butuh key):

   ```bash
   docker compose exec app node -e "fetch('http://host.docker.internal:20128/v1/models').then(r=>console.log(r.status))"
   ```

   Base URL `http://` hanya diizinkan untuk `localhost` dan `host.docker.internal`, jadi nama
   container seperti `http://9router:20128/v1` ditolak; pakai `host.docker.internal` atau
   `https://`.
4. Port 20128 yang terbuka di `0.0.0.0` bisa terjangkau dari internet (port yang di-publish
   Docker tidak diblokir `ufw`). Aktifkan `REQUIRE_API_KEY=true` di 9Router, buat API key di
   dashboard-nya dan isi di Pengaturan, lalu tutup port 20128 di firewall penyedia VM. Bawaan
   9Router tidak mewajibkan key, jadi port yang terbuka tanpa key berarti siapa pun bisa
   memakai akun-akun yang terhubung ke 9Router.

> **Peringatan langganan.** 9Router bisa meneruskan **langganan konsumen** (Claude Pro/Max
> lewat Claude Code, ChatGPT/Codex, GitHub Copilot, Cursor). Memakai langganan itu untuk
> layanan otomatis seperti Potongin (setiap job mengirim transkrip tanpa interaksi manusia)
> kemungkinan besar **melanggar ketentuan penyedianya** dan bisa membuat akun dibatasi atau
> diblokir. Untuk job, arahkan 9Router ke model gratis atau API key resmi, bukan ke
> langganan pribadi. Halaman Pengaturan menandai merah model utama/cadangan berawalan `cc/`,
> `cx/`, `gh/`, atau `cu/` pada server 9Router (peringatan, tidak diblokir).

### Pindah dari `.env` (sekali saja)

Selama belum ada pengaturan tersimpan, halaman Pengaturan menampilkan konfigurasi dari `.env`
server dan tombol **Impor dari konfigurasi server (.env)**. Satu klik menyalin urutan penyedia,
model, tuning, dan semua API key (terenkripsi) ke pengaturan. Mengubah lalu menyimpan halaman
juga otomatis membawa key dari `.env` untuk penyedia yang key-nya tidak diubah.

Dari terminal (hasilnya sama, tanpa menampilkan key):

```bash
docker compose exec app node scripts/llm-settings.mjs import-env   # tolak menimpa; --force untuk menimpa
docker compose exec app node scripts/llm-settings.mjs show         # pengaturan + status, tanpa key
docker compose exec app node scripts/llm-settings.mjs path         # lokasi file
# di luar container: baca variabel LLM dari file dotenv (lokasi & secret tetap dari proses ini)
JOBS_ROOT=/data/jobs APP_SESSION_SECRET=... node web/scripts/llm-settings.mjs import-env --env-file .env
```

Setelah pengaturan tersimpan, **semua** variabel `POTONGIN_LLM_*` dan `*_API_KEY` dari `.env`
diabaikan oleh worker (tidak dicampur), jadi yang tampil di halaman Pengaturan adalah yang
dipakai. `.env` hanya menjadi cadangan kalau file pengaturan belum ada.

### Penyimpanan dan keamanan

- File: `<folder data>/settings/llm-settings.json` (Docker: `/data/settings`, di luar
  `/data/jobs` sehingga tidak pernah bisa diunduh lewat rute file). Lokasi bisa diganti dengan
  `POTONGIN_SETTINGS_DIR` (path absolut, tidak boleh di dalam `JOBS_ROOT`). File ditulis atomik
  (tmp + fsync + rename) dengan izin `0600`, folder `0700`.
- API key dienkripsi AES-256-GCM dengan kunci turunan HKDF-SHA256 dari
  `POTONGIN_SETTINGS_SECRET` (kalau diisi) atau `APP_SESSION_SECRET`. Service `app` dan
  `primary-worker` harus melihat secret yang sama (sudah diatur di `compose.yaml`). Nilai
  contoh dari `.env.example` ditolak: isi secret acak sendiri (mis. `openssl rand -hex 32`).
- Kalau secret berubah, key lama tidak bisa dibuka: halaman Pengaturan menandainya
  "Key tersimpan tidak bisa dibuka — isi ulang" dan penyedia itu dilewati sampai key diisi
  ulang. Isi `POTONGIN_SETTINGS_SECRET` sendiri kalau ingin bisa merotasi `APP_SESSION_SECRET`
  tanpa mengisi ulang key.
- Key tersimpan terikat ke server tujuannya (skema + host + port dari base URL, atau URL bawaan
  penyedia). Kalau base URL diganti ke server lain, simpan ditolak sampai API key diisi ulang,
  supaya mengedit URL di halaman ini tidak bisa dipakai untuk mengirim key lama ke alamat lain.
  Ganti path di server yang sama (mis. `/v1` → `/openai/v1`) tetap memakai key lama.
- Kalau file pengaturan rusak, job tetap jalan dengan LLM dimatikan (heuristik), bukan diam-diam
  kembali ke `.env`; halaman Pengaturan menampilkan pesan dan menyimpan ulang akan menimpanya.
- Key hanya diberikan ke proses engine (dan hanya ke penyedianya sendiri saat tes). yt-dlp,
  log, respons API, dan halaman tidak pernah menerima key maupun secret. Base URL wajib
  `https://` (atau `http://` untuk localhost/`host.docker.internal`), dan alamat link-local /
  metadata cloud (mis. `169.254.169.254`) selalu ditolak.

## Konfigurasi lewat `.env` (cadangan)

Bagian di bawah ini menjelaskan variabel lingkungan yang dibaca engine. Variabel ini dipakai
kalau belum ada pengaturan dari UI, dan menjadi sumber tombol impor.

> **ID model sering berubah.** Semua angka dan nama model di bawah dicek pada
> **24 September 2026**. Setiap default bisa ditimpa lewat `POTONGIN_LLM_MODEL` /
> `POTONGIN_LLM_<PENYEDIA>_MODEL`. Kalau `--check` menjawab `model_not_found`, ganti ID modelnya.

## Rekomendasi gratis

Susunan yang disarankan untuk podcast Indonesia (dan dipakai di `.env` sekarang):

```dotenv
POTONGIN_LLM_PROVIDERS=ollama-cloud,openrouter,gemini,groq
POTONGIN_LLM_FREE_ONLY=1
```

Penyedia dicoba **berurutan**. Kalau satu penyedia gagal (kuota habis, rate limit, key salah,
server error), otomatis pindah ke penyedia berikutnya. Penyedia yang key-nya kosong dilewati
saja, jadi cukup isi key penyedia yang Anda punya.

| Urutan | Penyedia | Kenapa | Batas gratis (perkiraan) |
|---|---|---|---|
| 1 | **Ollama Cloud** (`ollama-cloud`) | `gpt-oss:120b` cepat (±2 dtk di uji coba), JSON rapi, prompt tidak dicatat/dilatih | kredit awal paket Free untuk model "starter", 1 permintaan bersamaan |
| 2 | **OpenRouter** (`openrouter`) | banyak model `:free` + router `openrouter/free` yang otomatis memilih model gratis | 20 permintaan/menit; 50/hari (1.000/hari setelah pernah beli ≥10 kredit) |
| 3 | **Google AI Studio** (`gemini`) | konteks 1 juta token, bahasa Indonesia bagus | Flash-Lite ±500 permintaan/hari, Flash ±20/hari (lihat angka live di AI Studio) |
| 4 | **Groq** (`groq`) | sangat cepat | 30 RPM, 1.000 RPD, **8.000 token/menit**, 200.000 token/hari |

Alternatif gratis lain: **Cerebras** (1 juta token/hari, 5 permintaan/menit) dan **Mistral**
paket Experiment. **Ollama lokal** gratis dan paling privat, tetapi lambat di mesin tanpa GPU.

Hasil uji langsung (24 Sep 2026, contoh 10 kalimat podcast sintetis, `--check` + ekstraksi):

- `ollama-cloud` / `gpt-oss:120b`: ping 0,7 dtk; ekstraksi momen 1,9 dtk dengan JSON lengkap
  (judul dan alasan dalam bahasa Indonesia).
- `openrouter`: `qwen/qwen3.8-27b:free` dan `google/gemma-4-31b-it:free` sempat kena rate limit
  upstream, lalu router `openrouter/free` menjawab dalam ±30 dtk. Model gratis OpenRouter
  kualitasnya bervariasi: satu jawaban Qwen hanya berisi `start_id`. Validasi di
  `llm_selection` tetap wajib.

## Cara setup

### 1. Ambil API key (pilih satu atau lebih)

| Penyedia | Halaman key | Variabel |
|---|---|---|
| Ollama Cloud | https://ollama.com/settings/keys | `OLLAMA_API_KEY` |
| OpenRouter | https://openrouter.ai/settings/keys | `OPENROUTER_API_KEY` |
| Google AI Studio | https://aistudio.google.com/apikey | `GEMINI_API_KEY` (atau `GOOGLE_API_KEY`) |
| Groq | https://console.groq.com/keys | `GROQ_API_KEY` |
| Cerebras | https://cloud.cerebras.ai | `CEREBRAS_API_KEY` |
| Mistral | https://console.mistral.ai/api-keys | `MISTRAL_API_KEY` |
| DeepSeek (berbayar murah) | https://platform.deepseek.com/api_keys | `DEEPSEEK_API_KEY` |
| OpenAI (berbayar) | https://platform.openai.com/api-keys | `OPENAI_API_KEY` |

**Khusus OpenRouter:** model `:free` hanya bisa dipakai kalau di
https://openrouter.ai/settings/privacy Anda mengizinkan endpoint gratis (yang boleh
mencatat/melatih prompt). Kalau belum diizinkan, semua model gratis menjawab 404
"No endpoints found matching your data policy" (kode `model_not_found`).

**Khusus Gemini:** supaya benar-benar gratis, pakai key dari project **tanpa billing**. Project
yang billing-nya aktif ditagih sesuai harga paid tier.

### 2. Isi `.env`

```dotenv
# --- LLM untuk pemilihan hook (Selection V3) ---
POTONGIN_LLM_PROVIDERS=ollama-cloud,openrouter,gemini,groq
OLLAMA_API_KEY=...
OPENROUTER_API_KEY=...
GEMINI_API_KEY=
GROQ_API_KEY=
POTONGIN_LLM_FREE_ONLY=1
# Opsional, contoh override per penyedia:
# POTONGIN_LLM_GEMINI_MODEL=gemini-3.8-flash
# POTONGIN_LLM_OPENROUTER_FALLBACK_MODELS=google/gemma-4-31b-it:free,openrouter/free
# Matikan LLM sementara tanpa menghapus key:
# POTONGIN_LLM=off
```

Cukup satu penyedia? Pakai `POTONGIN_LLM_PROVIDER=gemini` (tunggal) plus key-nya.

### 3. Teruskan variabel ke container (Docker Compose)

Tidak perlu kalau Anda memakai halaman Pengaturan. Untuk cadangan/impor: `compose.yaml` hanya
meneruskan variabel yang ditulis di bagian `environment:` (termasuk `POTONGIN_LLM_CUSTOM_*`,
`POTONGIN_LLM_CUSTOM2_*`, dan `POTONGIN_LLM_CUSTOM3_*` untuk server sendiri). Pipeline LLM
berjalan di service **`primary-worker`** (dan `app` kalau dashboard ingin menampilkan status
LLM), jadi dua service itu perlu blok seperti ini. Nilai kosong dianggap "pakai default":

```yaml
      POTONGIN_LLM: ${POTONGIN_LLM:-}
      POTONGIN_LLM_PROVIDER: ${POTONGIN_LLM_PROVIDER:-}
      POTONGIN_LLM_PROVIDERS: ${POTONGIN_LLM_PROVIDERS:-}
      POTONGIN_LLM_FREE_ONLY: ${POTONGIN_LLM_FREE_ONLY:-}
      POTONGIN_LLM_MODEL: ${POTONGIN_LLM_MODEL:-}
      POTONGIN_LLM_FALLBACK_MODELS: ${POTONGIN_LLM_FALLBACK_MODELS:-}
      POTONGIN_LLM_BASE_URL: ${POTONGIN_LLM_BASE_URL:-}
      POTONGIN_LLM_TIMEOUT: ${POTONGIN_LLM_TIMEOUT:-}
      POTONGIN_LLM_RPM: ${POTONGIN_LLM_RPM:-}
      POTONGIN_LLM_CONTEXT_TOKENS: ${POTONGIN_LLM_CONTEXT_TOKENS:-}
      POTONGIN_LLM_MAX_OUTPUT_TOKENS: ${POTONGIN_LLM_MAX_OUTPUT_TOKENS:-}
      POTONGIN_LLM_REASONING_EFFORT: ${POTONGIN_LLM_REASONING_EFFORT:-}
      OLLAMA_API_KEY: ${OLLAMA_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      GROQ_API_KEY: ${GROQ_API_KEY:-}
      CEREBRAS_API_KEY: ${CEREBRAS_API_KEY:-}
      MISTRAL_API_KEY: ${MISTRAL_API_KEY:-}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
```

Tambahkan juga variabel `POTONGIN_LLM_<PENYEDIA>_*` yang Anda pakai. Service `app` dan
`primary-worker` sudah punya `extra_hosts: ["host.docker.internal:host-gateway"]`, jadi
Ollama lokal, 9Router, atau server lain di host Docker terjangkau lewat
`http://host.docker.internal:<port>/v1`.

### 4. Cek koneksi

```bash
# lokal
.venv/bin/python -m ai_clipper.llm --check
# di container
docker compose exec primary-worker python -m ai_clipper.llm --check
# daftar preset + model default
.venv/bin/python -m ai_clipper.llm --show-presets
```

`--check` menampilkan konfigurasi (tanpa key) lalu mengirim ping JSON kecil (`{"ok": true}`)
ke **setiap** penyedia di daftar, contohnya:

```
OK: ollama-cloud / gpt-oss:120b menjawab {"ok": true} dalam 0.71 s (token masuk 100, keluar 67).
Dilewati [gemini]: API key untuk gemini belum diisi: set GEMINI_API_KEY ...
Ringkasan: 2 dari 4 penyedia siap. Urutan failover: ollama-cloud -> openrouter.
```

Exit code `0` artinya minimal satu penyedia siap, `1` artinya tidak ada. Tambahkan `--json`
untuk keluaran mesin (dipakai dashboard untuk status LLM).

## Detail per penyedia

Semua penyedia di bawah **didokumentasikan** mendukung `response_format: {"type": "json_object"}`,
kecuali Gemini yang hanya mendokumentasikan structured output lewat JSON schema. Klien tetap
aman untuk semuanya. Kalau penyedia menolak `response_format`, `temperature`, `max_tokens`,
atau `reasoning_effort` (HTTP 400), klien mengulang sekali tanpa parameter itu dan
mengingatnya per model. Jawaban dalam code fence, blok `<think>`, atau field `reasoning`
juga tetap terbaca.

| Preset | base_url | Model default → cadangan | Key | Default klien (rpm / konteks token) |
|---|---|---|---|---|
| `ollama-cloud` | `https://ollama.com/v1` | `gpt-oss:120b` → `qwen3.5:397b`, `gemma4:31b` | `OLLAMA_API_KEY` | 10 / 131.072 |
| `openrouter` | `https://openrouter.ai/api/v1` | `qwen/qwen3.8-27b:free` → `google/gemma-4-31b-it:free`, `openrouter/free` | `OPENROUTER_API_KEY` | 16 / 131.072 |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`, `gemini-3.8-flash` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | 10 / 131.072 |
| `groq` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` → `qwen/qwen3.8-27b`, `openai/gpt-oss-20b` | `GROQ_API_KEY` | 25 / 8.000 |
| `cerebras` | `https://api.cerebras.ai/v1` | `gpt-oss-120b` → `qwen-3.8-27b` | `CEREBRAS_API_KEY` | 5 / 30.000 |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-small-latest` → `mistral-medium-latest` | `MISTRAL_API_KEY` | 50 / 32.000 |
| `deepseek` | `https://api.deepseek.com` | `deepseek-flash` → `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | – / 131.072 |
| `openai` | `https://api.openai.com/v1` | `gpt-6-luna` | `OPENAI_API_KEY` | – / 131.072 |
| `ollama` (lokal) | `http://localhost:11434/v1` | `qwen3.5:9b` | tidak perlu | – / 8.192 |
| `custom`, `custom2`, `custom3` | wajib `POTONGIN_LLM_CUSTOM<n>_BASE_URL` | wajib `POTONGIN_LLM_CUSTOM<n>_MODEL` | opsional | – / 32.768 |

"Konteks" di sini adalah **anggaran total satu permintaan** (prompt + output) yang dipakai
`llm_selection` untuk memotong transkrip. Transkrip podcast 65 menit sekitar 20–25 ribu token,
jadi dengan 131.072 (ollama-cloud, openrouter, gemini) satu episode muat dalam satu permintaan
propose.

Pipeline (`--selection-mode v3`) dan benchmark memakai **konteks terkecil di seluruh rantai
failover** (`llm_request_budget`), supaya penyedia mana pun yang akhirnya menjawab bisa menerima
prompt yang sama. Token output diambil dari penyedia pertama, maksimal separuh konteks. Jadi
kalau `groq` (8.000) ikut di `POTONGIN_LLM_PROVIDERS`, semua permintaan dipotong ke 8.000 token:
episode panjang dipecah menjadi banyak potongan, sedangkan satu job hanya boleh memakai 3
permintaan LLM (batas waktu 300 detik). Bagian yang tidak sempat dikirim tidak pernah dilihat
LLM (peringatan `llm_partial`), dan slot klip yang kurang diisi heuristik. Posisi di daftar
tidak mengubah ini. Jadi jangan masukkan penyedia berkonteks kecil ke rantai job kecuali Anda
menerima akibatnya, atau naikkan `POTONGIN_LLM_GROQ_CONTEXT_TOKENS` kalau kuota Anda
mengizinkan.

### Ollama Cloud (`ollama-cloud`)

- Paket Free: "starter usage credits" untuk sekumpulan model starter (mis. `gpt-oss:120b`,
  `gemma4:31b`, `qwen3.5:397b`), 1 permintaan bersamaan. Pro $20/bulan.
- Nama model untuk API langsung ke ollama.com **tanpa** akhiran `-cloud` (daftar:
  `curl https://ollama.com/api/tags`).
- Privasi: "Prompt or response data is never logged or trained on."
- Kalau model tidak termasuk paket Anda (penyedia menjawab 402, atau 403 yang menyebut
  langganan/kredit; kode `payment_required`), klien pindah ke model cadangan. Kalau kredit
  sesi/mingguan habis (429 yang menyebut batas mingguan/sesi), model dilewati sementara.

### OpenRouter (`openrouter`)

- Model gratis ber-ID `...:free`. `openrouter/free` adalah router yang memilih model gratis
  secara acak sesuai kebutuhan request (termasuk structured output).
- Batas: 20 RPM; 50 permintaan/hari untuk akun yang belum pernah beli kredit, 1.000/hari
  setelah beli ≥10 kredit. Kuota harian habis → kode `quota_exhausted`, model dilewati ±15 menit.
- Privasi: endpoint gratis umumnya boleh mencatat/melatih prompt (harus diizinkan di
  pengaturan privasi, lihat di atas).
- Header opsional `HTTP-Referer` / `X-Title` dikirim dari `POTONGIN_LLM_HTTP_REFERER` /
  `POTONGIN_LLM_APP_TITLE` (default judul "Potongin").

### Google AI Studio (`gemini`)

- Endpoint OpenAI-compatible masih beta menurut Google. Structured output didokumentasikan
  lewat JSON schema. Kalau `json_object` ditolak, klien otomatis mengulang tanpa itu.
- Semua model Flash/Flash-Lite punya free tier (Gemini 3.1 Pro Preview tidak). Batas per
  model **tidak dipublikasikan statis**; lihat https://aistudio.google.com/rate-limit.
  Sumber sekunder (Sep 2026): Flash ±20 permintaan/hari, Flash-Lite ±500/hari. Karena itu
  default-nya Flash-Lite. Untuk kualitas terbaik set
  `POTONGIN_LLM_GEMINI_MODEL=gemini-3.8-flash` (cukup ±1 episode/hari).
- Privasi: di free tier, konten **boleh dipakai Google untuk meningkatkan produk**. Di paid
  tier tidak.

### Groq (`groq`)

- Free tier (dicek 11 Sep 2026): 30 RPM, 1.000 RPD, 8.000 token/menit, 200.000 token/hari
  untuk `openai/gpt-oss-120b`. Llama 3.x keluar dari free tier sejak 16 Agustus 2026.
- Batas 8.000 token/menit berarti satu permintaan harus kecil. Karena itu default konteksnya
  8.000 dan output 3.000.
- JSON Object Mode tersedia di semua model (prompt harus menyebut "JSON"; klien menambahkan
  instruksi itu otomatis). Kalau Groq gagal membuat JSON (`json_validate_failed`), klien
  mengulang tanpa `response_format`.
- Privasi: input/output tidak disimpan secara default (kecuali log sementara ≤30 hari untuk
  investigasi). Bisa mengaktifkan Zero Data Retention.

### Cerebras (`cerebras`)

- Free tier: 5 RPM, 30K token/menit (uncached), 1 juta token/hari; konteks free 65K
  (`gpt-oss-120b`) / 64K (`qwen-3.8-27b`). Mendukung `json_object` dan `json_schema`.
- Privasi: Cerebras menyatakan tidak menyimpan input/output inferensi.

### Mistral (`mistral`)

- Paket **Experiment** gratis, sekitar 1 permintaan/detik (angka komunitas); angka resmi
  hanya ada di Admin Console → Limits. Mendukung `json_object`.
- Privasi: di paket Experiment, data API **dipakai untuk training kecuali Anda opt-out** di
  Admin Console → Privacy.
- Alias `-latest` bisa dipindah Mistral ke model baru; cek `GET /v1/models`.

### DeepSeek (`deepseek`), berbayar tapi sangat murah

- `deepseek-flash` (V4.1 Flash, konteks 1 juta): input ±$0,15–0,30 dan output ±$0,60–1,20 per
  1 juta token. Di luar jam sibuk diskon 50%. Satu episode (±45K token masuk, ±10K keluar) kira-kira
  $0,01–0,03.
- JSON mode butuh kata "json" di prompt. DeepSeek bisa sesekali mengembalikan konten kosong;
  klien menanganinya dengan satu kali "nudge", lalu model cadangan.
- Privasi: data diproses dan disimpan di **Republik Rakyat Tiongkok**. Tidak bisa dipakai kalau
  `POTONGIN_LLM_FREE_ONLY=1`.

### OpenAI (`openai`), berbayar

- `gpt-6-luna`: $0,10 input / $0,50 output per 1 juta token, konteks 1,05 juta. Ini model
  reasoning, jadi klien memakai `max_completion_tokens`. Tidak bisa dipakai kalau
  `POTONGIN_LLM_FREE_ONLY=1`.

### Ollama lokal (`ollama`)

- Gratis, tanpa key, transkrip tidak keluar dari mesin. Install Ollama, lalu jalankan
  `ollama pull qwen3.5:9b` (alternatif Indonesia: `gemma4:12b`, atau build komunitas
  SEA-LION / Sahabat-AI).
- Konteks default Ollama hanya **4K** di mesin <24 GB VRAM. Jalankan server dengan
  `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`, lalu samakan `POTONGIN_LLM_CONTEXT_TOKENS`.
- Di CPU Ryzen 7 5700G (tanpa GPU) perkiraannya 15–20 menit per episode untuk model 8–9B.
  Karena itu timeout default 900 dtk.
- Dari dalam Docker: `POTONGIN_LLM_BASE_URL=http://host.docker.internal:11434/v1` plus
  `extra_hosts` di compose.

### Server lain (`custom`, `custom2`, `custom3`)

Hermes, 9Router, LM Studio, vLLM, llama.cpp server, Together, Fireworks, dan server
OpenAI-compatible lain; sampai tiga sekaligus. Wajib base URL (tanpa `/chat/completions`) dan
model: `POTONGIN_LLM_CUSTOM_BASE_URL` / `POTONGIN_LLM_CUSTOM_MODEL` (atau
`POTONGIN_LLM_BASE_URL` / `POTONGIN_LLM_MODEL` kalau servernya penyedia pertama), dan
`POTONGIN_LLM_CUSTOM2_*` / `POTONGIN_LLM_CUSTOM3_*` untuk server kedua dan ketiga. Key opsional
lewat `POTONGIN_LLM_CUSTOM<n>_API_KEY`. Lihat
[Beberapa server sendiri](#beberapa-server-sendiri-hermes-9router).

## Referensi variabel

Nilai kosong selalu berarti "pakai default".

| Variabel | Arti |
|---|---|
| `POTONGIN_LLM` | `off` (atau `0`/`false`) mematikan LLM walau sudah dikonfigurasi |
| `POTONGIN_LLM_PROVIDER` | satu penyedia, atau daftar dipisah koma; menang atas `..._PROVIDERS` |
| `POTONGIN_LLM_PROVIDERS` | daftar penyedia berurutan untuk failover |
| `POTONGIN_LLM_FREE_ONLY` | `1`: hanya model gratis. OpenRouter disaring ke `:free`/`openrouter/free`; DeepSeek/OpenAI dilewati; server sendiri (`custom`, `custom2`, `custom3`) tidak disaring |
| `POTONGIN_LLM_API_KEY` | key untuk penyedia **pertama**; kalau kosong dipakai variabel khas penyedia (`GEMINI_API_KEY`, …) |
| `POTONGIN_LLM_BASE_URL` | override URL penyedia pertama (wajib untuk `custom`). `http://` hanya untuk `localhost`, `127.0.0.1`, `::1`, `host.docker.internal` |
| `POTONGIN_LLM_MODEL` | override model penyedia **pertama** |
| `POTONGIN_LLM_FALLBACK_MODELS` | daftar model cadangan penyedia pertama, dipisah koma; `none` = tanpa cadangan |
| `POTONGIN_LLM_TIMEOUT` | detik per permintaan |
| `POTONGIN_LLM_RPM` | batas permintaan/menit di sisi klien; `0`/`off` = tanpa batas |
| `POTONGIN_LLM_JSON_MODE` | `true`/`false`, kirim `response_format` JSON |
| `POTONGIN_LLM_CONTEXT_TOKENS` | anggaran token per permintaan (untuk memotong transkrip), min. 512 |
| `POTONGIN_LLM_MAX_OUTPUT_TOKENS` | batas token jawaban |
| `POTONGIN_LLM_MAX_RETRIES` | percobaan ulang untuk 429/5xx/timeout (0–10, default 3) |
| `POTONGIN_LLM_TEMPERATURE` | 0–2, default 0,2 |
| `POTONGIN_LLM_REASONING_EFFORT` | `none`/`minimal`/`low`/`medium`/`high`. Opsional; `low` menghemat kuota token model reasoning (gpt-oss, Gemini 3, Qwen) |
| `POTONGIN_LLM_HTTP_REFERER`, `POTONGIN_LLM_APP_TITLE` | header atribusi OpenRouter |
| `POTONGIN_LLM_<PENYEDIA>_<NAMA>` | override khusus satu penyedia, mis. `POTONGIN_LLM_GROQ_MODEL`, `POTONGIN_LLM_OLLAMA_CLOUD_API_KEY`, `POTONGIN_LLM_GEMINI_CONTEXT_TOKENS`, `POTONGIN_LLM_CUSTOM2_BASE_URL` |
| `POTONGIN_LLM_CUSTOM_NAME`, `..._CUSTOM2_NAME`, `..._CUSTOM3_NAME` | nama tampilan server sendiri di dashboard (maks. 40 karakter); hanya dibaca dashboard, tidak ada versi tanpa nama penyedia |

Variabel tanpa nama penyedia untuk key, URL, model, dan cadangan hanya berlaku untuk
**penyedia pertama di daftar**. Variabel tuning (timeout, RPM, konteks, dll.) berlaku untuk
semua penyedia, kecuali ditimpa varian `POTONGIN_LLM_<PENYEDIA>_...`.

## Apa yang terjadi saat gagal

| Kode | Arti | Tindakan klien |
|---|---|---|
| `rate_limited` | HTTP 429 sementara | tunggu `Retry-After` (maks. 60 dtk) atau backoff eksponensial + jitter, ulang s.d. `MAX_RETRIES`, lalu model berikutnya |
| `quota_exhausted` | kuota harian/mingguan habis atau `Retry-After` > 60 dtk | model dilewati sementara (±15 menit atau sesuai `Retry-After`) |
| `timeout`, `network`, `http_5xx`, `bad_response` | gangguan sementara | ulang dengan backoff, lalu model berikutnya |
| `auth` | HTTP 401/403, key salah | berhenti di penyedia ini (tanpa ulang), lanjut ke penyedia berikutnya di daftar |
| `payment_required` | HTTP 402 / 403 karena butuh kredit/langganan | model berikutnya |
| `model_not_found` | HTTP 404 / model sudah dihapus | model berikutnya |
| `bad_json` | jawaban bukan objek JSON | ulang sekali dengan tambahan "Return ONLY one valid JSON object.", lalu model berikutnya |
| `truncated` | `finish_reason=length` | model berikutnya; naikkan `MAX_OUTPUT_TOKENS` |
| `context_length`, `too_large` | prompt kebesaran | model berikutnya; perkecil `CONTEXT_TOKENS` |
| `missing_api_key`, `not_free`, `config_invalid` | konfigurasi | penyedia dilewati (daftar) atau LLM tidak dipakai (tunggal) |

Kalau semua penyedia gagal, Selection V3 memakai pemilih heuristik dan mencatat
`status: "fallback"` beserta kode error di manifest.

## Cache

Jawaban LLM yang berhasil disimpan sebagai file JSON atomik (kunci: SHA-256 dari penyedia,
model, prompt, temperatur, dan batas token). Menjalankan ulang job yang sama tidak menghabiskan
kuota lagi. File cache tidak berisi prompt maupun API key.

## Sumber (diakses 24 September 2026)

- Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- Gemini models: https://ai.google.dev/gemini-api/docs/models ·
  pricing/free tier/data: https://ai.google.dev/gemini-api/docs/pricing ·
  rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini free RPD (sekunder): https://www.scriptbyai.com/gemini-api-free-tier-limits/
- Groq OpenAI compatibility: https://console.groq.com/docs/openai ·
  models: https://console.groq.com/docs/models ·
  JSON mode: https://console.groq.com/docs/structured-outputs ·
  data: https://console.groq.com/docs/your-data
- Groq free tier (sekunder, dicek 11 Sep 2026): https://klymentiev.com/blog/groq-pricing
- OpenRouter limits: https://openrouter.ai/docs/api/reference/limits ·
  API: https://openrouter.ai/docs/api/reference/overview ·
  free router: https://openrouter.ai/docs/guides/routing/routers/free-router ·
  daftar model gratis (23 Sep 2026): https://costgoat.com/pricing/openrouter-free-models ·
  404 data policy: https://openrouter.zendesk.com/hc/en-us/articles/51690904755227
- Cerebras rate limits: https://inference-docs.cerebras.ai/support/rate-limits ·
  models: https://inference-docs.cerebras.ai/models/overview ·
  OpenAI compat: https://inference-docs.cerebras.ai/resources/openai ·
  structured outputs: https://inference-docs.cerebras.ai/capabilities/structured-outputs
- Mistral models: https://docs.mistral.ai/getting-started/models/models_overview/ ·
  API: https://docs.mistral.ai/api ·
  opt-out training: https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training ·
  Experiment plan (komunitas): https://github.com/DrDavidHall/mistral-api-workshop/blob/main/docs/free-tier-experiment-plan.md
- DeepSeek API: https://api-docs.deepseek.com/ ·
  harga: https://api-docs.deepseek.com/quick_start/pricing ·
  JSON mode: https://api-docs.deepseek.com/guides/json_mode ·
  privasi: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- OpenAI models: https://developers.openai.com/api/docs/models ·
  `gpt-6-luna`: https://developers.openai.com/api/docs/models/gpt-6-luna
- 9Router (port 20128, `/v1`, `REQUIRE_API_KEY`, awalan model, langganan yang diteruskan):
  https://github.com/decolua/9router
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility ·
  cloud: https://docs.ollama.com/cloud · pricing/privasi: https://ollama.com/pricing ·
  context length: https://docs.ollama.com/context-length · library: https://ollama.com/library
