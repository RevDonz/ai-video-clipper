# Transkripsi Whisper: default, hasil uji, dan cara menggantinya

Terakhir diperbarui: 2026-09-24.

Dokumen ini untuk video **tanpa subtitle YouTube** (upload sendiri, atau YouTube tanpa
caption). Video yang subtitle YouTube-nya layak tidak memakai Whisper sama sekali
(`--captions-dir`, lihat `docs/plans/2026-09-24-selection-v3-llm-hooks.md`).

## Ringkasan

- **Masalah.** Whisper `small` dengan pengaturan bawaan kehilangan tanda baca di 3 dari 5
  episode uji: `0dzvz9JZFIM` (2% segmen bertanda baca), 25 menit pertama `rBg0ZcwjVKQ`, dan
  `o9g9Tt9UP-I` (1%). Tanpa tanda baca, unit kalimat dan deteksi pertanyaan melemah, dan
  pemeriksa kualitas melaporkan `no_punctuation` atau `punctuation_collapse`.
- **Penyebab.** Bawaan Whisper adalah `condition_on_previous_text=True`: teks jendela 30 detik
  sebelumnya menjadi prompt jendela berikutnya. Begitu satu jendela keluar tanpa tanda baca,
  jendela-jendela berikutnya meniru gaya itu sampai akhir file, atau sampai prompt kebetulan
  di-reset. Kejadiannya acak. Potongan 10 menit dari episode yang sama bisa rusak atau tidak,
  tergantung audio sebelumnya: `0dzvz9JZFIM` rusak di file penuh, tetapi potongannya 97%
  bertanda baca.
- **Default baru** (`src/ai_clipper/transcribe.py`, berlaku otomatis untuk semua job):
  - `condition_on_previous_text=False`. Tiap jendela ditranskripsi sendiri, jadi kerusakan
    tidak bisa menular.
  - Prompt pendek berbahasa Indonesia santai yang bertanda baca (koma, tanda tanya, titik)
    dipasang di depan **setiap** jendela 30 detik, bukan hanya jendela pertama.
- **Hasil `small` di 3 episode penuh (66–73 menit):**
  - segmen bertanda baca naik dari 2% / 1% / 59% menjadi **91% / 93% / 96%**
    (`0dzvz9JZFIM` / `o9g9Tt9UP-I` / `rBg0ZcwjVKQ`);
  - blok 5 menit terburuk 83–89% (dulu 0%), tanpa `no_punctuation` maupun
    `punctuation_collapse`;
  - kepadatan akhir kalimat 15–16 per 100 kata (subtitle YouTube 12–14);
  - akurasi kata setara bawaan: WER rata-rata di 4 potongan 0,256, bawaan 0,260;
  - waktu proses justru 21% lebih singkat (tabel Kecepatan).
- **Model tetap `small`** untuk produksi CPU. `large-v3-turbo` lebih akurat per kata (WER
  terhadap subtitle YouTube sekitar 30% lebih rendah), tetapi sekitar 1,9× lebih lambat. Cara
  pindah ada di bawah. `medium` (diuji di satu potongan) 1,5× lebih lambat daripada turbo dan
  tidak lebih akurat, jadi tidak disarankan.
- **Tidak ada pass ulang tanda baca.** Dengan default baru, tidak ada lagi blok yang runtuh
  (penjelasan di bawah).

## Pengaturan

Semua variabel boleh kosong; kosong berarti memakai default.

| Variabel `.env` | Flag CLI | Default | Arti |
|---|---|---|---|
| `WHISPER_MODEL` | `--model` | `small` (worker web) | Nama model faster-whisper: `tiny`, `small`, `medium`, `large-v3-turbo`, … |
| `WHISPER_CONDITION_ON_PREVIOUS_TEXT` | `--condition-on-previous-text` / `--no-condition-on-previous-text` | `false` | `true` = perilaku lama Whisper. Tidak disarankan. |
| `WHISPER_INITIAL_PROMPT` | `--initial-prompt TEKS` | prompt bawaan (di bawah) | Contoh gaya tulisan. `off` atau `none` = tanpa prompt. Maksimal 400 karakter; spasi dan baris baru dirapikan jadi satu spasi. |
| `WHISPER_PROMPT_EVERY_WINDOW` | `--prompt-every-window` / `--no-prompt-every-window` | `true` | `true`: prompt dipasang di depan setiap jendela 30 detik (slot `hotwords` faster-whisper). `false`: hanya di jendela pertama (`initial_prompt` asli Whisper). |

- Boolean menerima `true/false`, `1/0`, `yes/no`, atau `on/off`.
- Nilai yang tidak valid menggagalkan job sejak awal dengan pesan
  `Error: WHISPER_… harus …`. Isi nilainya tidak ditampilkan.
- Flag CLI menang atas variabel lingkungan.

Prompt bawaan (versi 2):

> Oke, jadi gini. Sebenernya gue juga nggak nyangka, literally. Terus, kenapa bisa kayak
> gitu? Ya, karena emang gitu, kan?

Prompt ini hanya contoh **gaya**: bahasa santai, koma, tanda tanya, dan titik. Karena
Whisper mendengarnya sebelum setiap jendela, kata-kata di dalamnya sedikit "dipancing" ke
transkrip. Karena itu prompt hanya memakai kata-kata yang memang sangat sering muncul di
podcast.

Versi 1 sempat memakai sapaan "Halo, apa kabar? Baik, alhamdulillah. …". Di satu episode
penuh, ucapan "however, dok" jadi tertulis "Apa kabar? Apa kabar, dok?". Kalau Anda
menulis prompt sendiri, pakai kalimat umum bertanda baca dan hindari frasa khas. Nama tamu
atau istilah yang memang sering muncul boleh ditambahkan, karena memancing kata yang benar
justru membantu.

### Docker Compose

`compose.yaml` hanya meneruskan variabel yang tertulis di bagian `environment`. Default baru
berlaku tanpa pengaturan apa pun, karena default ada di kode. Ketiga variabel sudah diteruskan
ke service `app` dan `primary-worker` (kosong = default), jadi cukup isi di `.env` server lalu
`docker compose up -d`:

```yaml
      WHISPER_CONDITION_ON_PREVIOUS_TEXT: ${WHISPER_CONDITION_ON_PREVIOUS_TEXT:-}
      WHISPER_INITIAL_PROMPT: ${WHISPER_INITIAL_PROMPT:-}
      WHISPER_PROMPT_EVERY_WINDOW: ${WHISPER_PROMPT_EVERY_WINDOW:-}
```

## Cara pindah ke `large-v3-turbo`

1. Di `.env` server, isi `WHISPER_MODEL=large-v3-turbo`, lalu jalankan
   `docker compose up -d` (atau restart worker lokal).
   - Jangan ubah pengaturan lain. Turbo **wajib** memakai prompt di setiap jendela: dengan
     prompt hanya di jendela pertama, turbo kehilangan tanda baca di 2 dari 3 potongan uji (3%
     dan 5% segmen bertanda baca).
2. Job pertama mengunduh model sekitar 1,6 GB dari Hugging Face (`small` sekitar 0,5 GB).
   - Model berjalan `int8` di CPU. Memori puncak proses sekitar 1,7 GB (`small` sekitar
     1,0–1,3 GB), jauh di bawah batas `mem_limit: 10g` worker.
   - Di Docker, cache model ada di dalam container (`/home/node/.cache/huggingface`), bukan
     di volume `/data`. Artinya model diunduh ulang setiap kali container dibuat ulang (setiap
     deploy image baru). Hal ini juga berlaku untuk `small`.
   - Untuk menyimpan cache, tambahkan `HF_HOME: /data/hf-cache` di `environment` worker.
3. Perkirakan waktunya. Di Ryzen 7 5700G dengan 4 thread (bawaan CTranslate2), turbo butuh
   sekitar 1,9× waktu `small`. Untuk episode 70 menit, itu kira-kira 19 menit, sedangkan
   `small` 10 menit (tabel Kecepatan). Di VM dengan CPU lebih lemah, kalikan lagi.
   - Aplikasi belum punya pengaturan jumlah thread.
   - Dengan 8 thread, turbo 17% lebih cepat (diukur lewat skrip uji, bukan lewat
     aplikasi).
4. Untuk kembali, isi `WHISPER_MODEL=small` atau hapus barisnya.

## Hasil uji

### Cara uji

- **Mesin dan versi:** Ryzen 7 5700G (8 core/16 thread), faster-whisper 1.2.1, CTranslate2
  4.8.1, `int8`, 4 thread per proses (bawaan).
- **Opsi tetap seperti produksi:** `language=id`, `beam_size=5`, `vad_filter=True`,
  `word_timestamps=True`.
- **Beban mesin.** Mesin dipakai agen lain selama uji (load rata-rata 15–30 di 16 thread).
  Karena itu waktu di tabel kualitas tidak dipakai. Angka kecepatan ada di tabel tersendiri.
- **Potongan 10 menit** (audio mono 16 kHz dari ffmpeg):
  - yang diminta: `0dzvz9JZFIM` 20:00–30:00, `o9g9Tt9UP-I` 10:00–20:00, dan `rBg0ZcwjVKQ`
    05:00–15:00;
  - 10 menit pertama tiap episode, karena di file penuh kerusakan tanda baca dimulai di menit
    awal lalu menjalar.
- **Episode penuh** diproses lewat jalur kode yang sebenarnya (`load_whisper_model` →
  `transcribe_video`) dari file sumber asli (`source.mp4` atau `audio.m4a`). Pembandingnya
  adalah transkrip Whisper lama di `artifacts/eval/<id>/transcript.json`.
- **Metrik:**
  - **Segmen bertanda baca**: persentase segmen yang berakhir dengan `.?!`, sama dengan cara
    hitung pemeriksa kualitas. Di bawah 20% dilaporkan `no_punctuation`.
  - **`.?!` per 100 kata**: kepadatan akhir kalimat, dibandingkan subtitle YouTube pada
    rentang yang sama. Metrik ini lebih adil daripada persentase segmen, karena segmen
    `cond=False` lebih panjang dan sering berisi beberapa kalimat. Angka yang jauh di atas
    YouTube berarti kalimat terpotong-potong.
  - **`?`**: jumlah tanda tanya.
  - **Kata**: jumlah kata yang titik tengahnya ada di detik 5–595 potongan.
  - **WER vs YT**: word error rate kasar terhadap subtitle YouTube. Sebelum dihitung, teks
    dijadikan huruf kecil, tanda baca dibuang, tanda hubung diganti spasi, dan varian umum
    disamakan (gua/gue, gak/nggak, dan sebagainya). Subtitle YouTube sendiri tidak sempurna,
    jadi angka ini untuk **membandingkan konfigurasi**, bukan akurasi mutlak.
    `o9g9Tt9UP-I` tidak punya subtitle YouTube.
  - **Durasi bulat**: persentase segmen yang durasinya tepat bilangan bulat detik (tanda
    timestamp terkuantisasi). Semua konfigurasi berada di 0–3%, jauh di bawah batas
    peringatan 80%, jadi kolom ini tidak ditampilkan.
  - **Kata Inggris**: jumlah kata sisipan bahasa Inggris yang umum (however, literally,
    basically, actually, which, you know, …) di jendela yang sama. Angka ini untuk melihat
    apakah sisipan bahasa Inggris masih ditulis apa adanya atau diterjemahkan.
  - **Loop**: jumlah `repetition_loop` dari pemeriksa kualitas.

Setiap sel berisi tiga angka, untuk tiga episode dengan urutan di judul. `–` berarti tidak diukur
atau tidak ada acuan.

#### Potongan yang diminta (0dzvz9JZFIM / o9g9Tt9UP-I / rBg0ZcwjVKQ)

| Konfigurasi | Segmen bertanda baca | `.?!` per 100 kata | `?` | Kata | WER vs YT | Kata Inggris | Loop |
|---|---|---|---|---|---|---|---|
| *subtitle YouTube (acuan)* | – | 18,0 / – / 11,1 | 41 / – / 18 | 1360 / – / 1536 | – | 2 / – / 1 | – |
| small, bawaan (baseline) | 97 / 0 / 2 | 21,4 / 0,0 / 0,5 | 25 / 0 / 7 | 1236 / 1298 / 1418 | 0,271 / – / 0,239 | 1 / 21 / 2 | 0 |
| small + cond=False | 89 / 81 / 79 | 16,9 / 14,5 / 12,4 | 28 / 26 / 21 | 1283 / 1338 / 1460 | 0,265 / – / 0,226 | 1 / 10 / 2 | 0 |
| small + prompt v1 awal (cond=True) | 93 / 99 / 89 | 20,4 / 22,8 / 18,1 | 29 / 15 / 11 | 1253 / 1343 / 1467 | 0,253 / – / 0,211 | 1 / 16 / 2 | 0 |
| small + cond=False + prompt v1 awal | 78 / 85 / 80 | 16,0 / 14,8 / 13,1 | 33 / 27 / 22 | 1279 / 1342 / 1461 | 0,270 / – / 0,225 | 1 / 14 / 2 | 0 |
| small + cond=False + prompt v1 tiap jendela | 92 / 92 / 97 | 18,5 / 14,8 / 14,5 | 39 / 25 / 29 | 1272 / 1363 / 1455 | 0,277 / – / 0,240 | 1 / 6 / 4 | 1 |
| small + prompt v2 tiap jendela (cond=True) | – / 95 / – | – / 17,5 / – | – / 27 / – | – / 1296 / – | – / – / – | – / 19 / – | 0 |
| **small + cond=False + prompt v2 tiap jendela (default)** | 95 / 95 / 97 | 19,2 / 16,7 / 14,5 | 42 / 35 / 32 | 1273 / 1360 / 1473 | 0,279 / – / 0,229 | 1 / 9 / 3 | 0 |
| medium + cond=False + prompt v1 tiap jendela | – / – / 99 | – / – / 13,4 | – / – / 32 | – / – / 1458 | – / – / 0,180 | – / – / 2 | 0 |
| medium + cond=False + prompt v2 tiap jendela | – / – / 100 | – / – / 14,9 | – / – / 38 | – / – / 1476 | – / – / 0,165 | – / – / 2 | 0 |
| turbo + cond=False + prompt v1 awal | 5 / 54 / 3 | 2,0 / 11,2 / 1,4 | 15 / 22 / 10 | 1190 / 1302 / 1405 | 0,231 / – / 0,200 | 1 / 11 / 2 | 0 |
| turbo + prompt v1 awal (cond=True) | – / – / 100 | – / – / 19,4 | – / – / 35 | – / – / 1491 | – / – / 0,153 | – / – / 2 | 0 |
| turbo + cond=False + prompt v1 tiap jendela | 97 / 96 / 95 | 19,5 / 15,5 / 14,6 | 51 / 29 / 31 | 1262 / 1301 / 1463 | 0,199 / – / 0,162 | 1 / 6 / 2 | 0 |
| turbo + cond=False + prompt v2 tiap jendela | 99 / 98 / 99 | 19,0 / 16,2 / 12,7 | 60 / 30 / 29 | 1244 / 1341 / 1469 | 0,197 / – / 0,161 | 1 / 8 / 1 | 0 |

#### 10 menit pertama tiap episode (0dzvz9JZFIM / o9g9Tt9UP-I / rBg0ZcwjVKQ)

| Konfigurasi | Segmen bertanda baca | `.?!` per 100 kata | `?` | Kata | WER vs YT | Kata Inggris | Loop |
|---|---|---|---|---|---|---|---|
| *subtitle YouTube (acuan)* | – | 12,0 / – / 12,0 | 34 / – / 17 | 1285 / – / 1516 | – | 1 / – / 3 | – |
| small, bawaan (baseline) | 89 / 4 / 4 | 20,9 / 0,9 / 1,4 | 32 / 12 / 14 | 1192 / 1357 / 1411 | 0,267 / – / 0,265 | 0 / 13 / 3 | 0 |
| small + cond=False | 74 / 72 / 78 | 13,2 / 10,7 / 13,9 | 32 / 18 / 25 | 1241 / 1397 / 1445 | 0,274 / – / 0,245 | 0 / 12 / 2 | 1 |
| small + prompt v1 awal (cond=True) | 95 / 97 / 97 | 22,3 / 16,3 / 22,4 | 34 / 17 / 28 | 1214 / 1382 / 1423 | 0,268 / – / 0,246 | 0 / 16 / 3 | 1 |
| small + cond=False + prompt v1 awal | 81 / 75 / 73 | 14,8 / 10,6 / 13,1 | 29 / 18 / 24 | 1250 / 1394 / 1440 | 0,293 / – / 0,248 | 0 / 10 / 2 | 2 |
| small + cond=False + prompt v1 tiap jendela | 91 / 85 / 95 | 17,1 / 13,8 / 16,4 | 41 / 20 / 33 | 1236 / 1425 / 1447 | 0,265 / – / 0,250 | 0 / 6 / 3 | 0 |
| **small + cond=False + prompt v2 tiap jendela (default)** | 96 / 90 / 94 | 18,8 / 14,5 / 15,7 | 48 / 26 / 32 | 1238 / 1438 / 1449 | 0,254 / – / 0,263 | 0 / 17 / 2 | 0 |

Catatan tabel:

- `cond=False` saja (tanpa prompt) sudah menyembuhkan keruntuhan, tetapi 20–28% segmen tetap
  tanpa tanda baca.
- Prompt yang hanya di jendela pertama hampir tidak berpengaruh kalau `cond=False`, karena
  jendela kedua dan seterusnya tidak melihatnya.
- Prompt di setiap jendela menaikkan segmen bertanda baca menjadi 85–97% tanpa menaikkan WER.
  Rata-rata di 6 potongan: v2 94,5% (terendah 90%) dan v1 92%. Tanpa prompt hasilnya 79%.
- `cond=True` + prompt awal memberi persentase segmen tertinggi dan WER terendah untuk `small`
  (rata-rata 0,245, default 0,256). Di episode penuh `o9g9Tt9UP-I` pun tidak runtuh (95%).
  Kekurangannya:
  - kalimat terpotong-potong: 18–23 akhir kalimat per 100 kata, sedangkan YouTube 11–18;
  - tanda tanya lebih sedikit (139 di episode penuh, default 261);
  - prosesnya 43% lebih lambat daripada default (tabel Kecepatan);
  - mekanisme penularan tetap ada. Prompt hanya menjadi jangkar di awal, jadi satu jendela
    rusak masih bisa menular.

  Karena itu konfigurasi ini tidak dijadikan default. Kalau ingin mencobanya:
  `WHISPER_CONDITION_ON_PREVIOUS_TEXT=true` dan `WHISPER_PROMPT_EVERY_WINDOW=false`.
- Turbo hanya bertanda baca kalau prompt dipasang di setiap jendela. Dengan pengaturan itu
  WER-nya paling rendah: 0,197 dan 0,161, dibandingkan 0,279 dan 0,229 untuk `small` dengan
  default yang sama.
- Prompt v2 tiap jendela dengan `cond=True` (hanya diuji di satu potongan) memberi hasil mirip,
  tetapi 2× lebih lambat, karena setiap jendela membawa prompt sekaligus teks sebelumnya.
- `medium` (satu potongan) memberi WER 0,165–0,180. Itu lebih baik daripada `small` (0,229),
  tetapi tidak lebih baik daripada turbo (0,161), sementara prosesnya 1,5× lebih lambat daripada
  turbo.

### Episode penuh

| Episode | Konfigurasi | Segmen bertanda baca | Blok 5 menit terburuk | `.?!` per 100 kata | `?` | Loop | Frasa prompt | Peringatan | Waktu (RTF, load) |
|---|---|---|---|---|---|---|---|---|---|
| 0dzvz9JZFIM | subtitle YouTube (acuan) | 77% | 52% | 14,1 | 188 | 1 | 6 | – | – |
| 0dzvz9JZFIM | small, bawaan (transkrip eval lama) | 2% | 0% | 0,7 | 52 | 1 | 4 | `no_punctuation` | – |
| 0dzvz9JZFIM | **small + cond=False + prompt v2 tiap jendela (default)** | 91% | 83% | 15,6 | 217 | 5 | 5 | – | 40 mnt (0,58, 16) |
| o9g9Tt9UP-I | small, bawaan (transkrip eval lama) | 1% | 0% | 0,5 | 43 | 1 | 0 | `no_punctuation` | – |
| o9g9Tt9UP-I | small + prompt v1 awal (cond=True) | 95% | 75% | 21,6 | 139 | 1 | 2 | – | 55 mnt (0,75, 25) |
| o9g9Tt9UP-I | small + cond=False + prompt v1 awal | 87% | 67% | 13,3 | 173 | 2 | 2 | – | 46 mnt (0,63, 24) |
| o9g9Tt9UP-I | small + cond=False + prompt v1 tiap jendela | 91% | 84% | 15,2 | 217 | 1 | 7 | – | 44 mnt (0,60, 22) |
| o9g9Tt9UP-I | **small + cond=False + prompt v2 tiap jendela (default)** | 93% | 89% | 16,0 | 261 | 2 | 2 | – | 41 mnt (0,57, 13) |
| rBg0ZcwjVKQ | subtitle YouTube (acuan) | 71% | 65% | 12,1 | 115 | 0 | 2 | – | – |
| rBg0ZcwjVKQ | small, bawaan (transkrip eval lama) | 59% | 0% | 12,5 | 85 | 0 | 2 | `punctuation_collapse:0-1500` | – |
| rBg0ZcwjVKQ | small + cond=False + prompt v1 tiap jendela | 96% | 91% | 14,4 | 198 | 0 | 2 | – | 35 mnt (0,52, 20) |
| rBg0ZcwjVKQ | **small + cond=False + prompt v2 tiap jendela (default)** | 96% | 88% | 14,9 | 213 | 0 | 2 | – | 40 mnt (0,60, 17) |

- **Blok 5 menit terburuk**: persentase segmen bertanda baca pada blok 5 menit yang paling
  buruk. Kolom ini menunjukkan apakah ada bagian yang runtuh.
- **Frasa prompt**: berapa kali frasa khas prompt v1 ("apa kabar", "alhamdulillah", "cerita
  sedikit", "bahas pelan", "bisa begitu") muncul. Angka acuan YouTube dan baseline menunjukkan
  bahwa frasa itu juga muncul secara alami. Angka 7 pada prompt v1 tiap jendela berasal dari
  "however, dok" yang tertulis "Apa kabar? Apa kabar, dok?". Karena itu default dipindah ke
  prompt v2. Frasa prompt v2 ("literally", "nggak nyangka", "jadi gini", "emang gitu",
  "kayak gitu") muncul sama seringnya dengan transkrip lama di ketiga episode, jadi tidak
  terlihat kebocoran.
- **Loop default di `0dzvz9JZFIM` (5).** Empat di antaranya memang ucapan berulang yang juga
  ada di subtitle YouTube ("Bang, bang, bang, bang, bang, bang.", "No no no no no", "bergerak
  terus, bergerak terus, …"). Satu adalah halusinasi: "Bukan gue." diulang 8 kali dan menutup
  sekitar 6 detik ucapan lain.
- **Waktu** hanya untuk perbandingan kasar, karena diukur saat mesin sedang sibuk. Lihat tabel
  Kecepatan.

### Kecepatan

Diukur berurutan di potongan `rBg0ZcwjVKQ` (10 menit, 597 detik ucapan setelah VAD), saat
mesin agak sepi (load 6–10 di 16 thread). Waktu tidak termasuk memuat model. Hasil transkrip
identik dengan run sebelumnya, jadi kualitasnya sama dengan tabel di atas.

| Konfigurasi | Thread | Waktu | RTF (waktu ÷ durasi audio) | 70 menit audio ≈ | Memori puncak | WER vs YT |
|---|---|---|---|---|---|---|
| small, bawaan (baseline) | 4 | 111 dtk | 0,185 | 13 mnt | 1,3 GB* | 0,239 |
| **small, default baru** | 4 | 87 dtk | **0,146** | **10 mnt** | 1,3 GB* | 0,229 |
| small + prompt v1 awal (cond=True) | 4 | 125 dtk | 0,208 | 15 mnt | 1,3 GB* | 0,211 |
| small, default baru | 8 | 78 dtk | 0,130 | 9 mnt | 1,0 GB | 0,229 |
| large-v3-turbo, default baru | 4 | 164 dtk | 0,273 | 19 mnt | 1,7 GB | 0,161 |
| large-v3-turbo, default baru | 8 | 136 dtk | 0,227 | 16 mnt | 1,7 GB | 0,161 |
| medium, default baru | 4 | 239 dtk | 0,398 | 28 mnt | 1,7 GB | 0,165 |

\* Tiga baris `small` pertama berjalan dalam satu proses, jadi angka memorinya adalah puncak
gabungan. Satu proses `small` saja memakai 1,0 GB.

- **Default baru lebih cepat 21% daripada bawaan.** Dekoder tidak lagi membawa teks jendela
  sebelumnya (maksimal 223 token), hanya prompt pendek (37 token).
- **Episode penuh** di tabel sebelumnya (RTF 0,52–0,75) diukur saat mesin sibuk (load 13–25).
  Di mesin yang sepi, RTF-nya diperkirakan mendekati angka di atas.

## Kenapa tidak ada "pass ulang" tanda baca

Rencana awalnya: kalau pemeriksa kualitas melaporkan `no_punctuation` atau
`punctuation_collapse`, ulangi hanya blok yang rusak dengan `condition_on_previous_text=False`.
Setelah diukur, langkah ini tidak diperlukan:

- `condition_on_previous_text=False` sudah menjadi default. Pass ulang dengan opsi yang sama
  hanya menggandakan waktu blok itu.
- Di ketiga episode penuh dengan default baru, tidak ada blok 5 menit yang runtuh (blok
  terburuk tetap 83–89% bertanda baca) dan tidak ada `no_punctuation`.

Kalau suatu saat `WHISPER_CONDITION_ON_PREVIOUS_TEXT=true` dipakai lagi dan peringatan itu
muncul, solusinya kembali ke default, bukan menambah pass ulang.

## Batasan yang diketahui

- **Kata bahasa Inggris kadang diterjemahkan.** Tanpa konteks jendela sebelumnya, Whisper
  dengan `language=id` kadang menerjemahkan sisipan bahasa Inggris. Contohnya, "however, dok"
  tertulis "Bagaimanapun, dok" atau "Apa pun, dok". Transkrip lama yang tanpa tanda baca
  masih menulis "however". Turbo juga melakukannya ("Bagaimana, dok").
  - Di potongan `o9g9Tt9UP-I` (episode dokter yang banyak menyisipkan bahasa Inggris), kolom
    "Kata Inggris" turun dari 21 (bawaan) menjadi 9 (default).
  - Di 10 menit pertama episode yang sama, angkanya naik dari 13 menjadi 17.
  - Prompt v1 yang seluruhnya berbahasa Indonesia lebih parah (6). Karena itu prompt v2 memuat
    satu sisipan ("literally").
  - Caption yang di-burn bisa ikut berbeda dari ucapan, jadi periksa di editor kalau kalimat
    itu dipakai.
- **Loop pendek masih bisa terjadi.** Contohnya "Bukan gue." diulang 8 kali dan menutup
  sekitar 6 detik ucapan (episode penuh `0dzvz9JZFIM`), atau "tunggu, tunggu, …" selama 8 detik
  (potongan, prompt v1). Pemeriksa kualitas menandainya `repetition_loop`, dan segmen itu tidak
  dipakai sebagai hook.
  - Transkrip default memunculkan 0–5 kode `repetition_loop` per episode penuh, sedangkan
    transkrip lama 0–1.
  - Sebagian besar kode itu ucapan berulang yang asli dan juga ada di subtitle YouTube
    ("Bang, bang, bang, …", "No no no no no").
- **Segmen lebih panjang.** Dengan `cond=False`, Whisper membuat lebih sedikit segmen, dan
  satu segmen bisa berisi beberapa kalimat. Satu segmen muncul kira-kira setiap 3 detik
  untuk `small` (dulu setiap 2 detik) dan setiap 5–7 detik untuk turbo. Unit kalimat
  (`sentences.py`) tetap dipecah di tanda baca per kata dan di jeda, jadi pemilihan klip tidak
  dirugikan.
- **Nama dan istilah** masih sering salah tulis dengan `small`, misalnya "Inucul kan" untuk
  "ih lucu", atau "Mixplater" untuk "mix platter". Turbo menulis keduanya dengan benar.
- Tanda tanya pada kalimat santai tanpa intonasi tanya masih bisa terlewat. Deteksi pertanyaan
  di `sentences.py` juga memakai kata tanya (apa, kenapa, gimana, …), jadi tidak hanya
  bergantung pada `?`.
