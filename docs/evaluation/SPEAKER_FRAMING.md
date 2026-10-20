# Evaluasi framing pembicara (Ikuti wajah)

Evaluasi ini mengukur seberapa sering crop 9:16 tata letak **Ikuti wajah** tidak memuat orang yang
sedang bicara. Setiap perubahan pada deteksi wajah atau pemilihan pembicara harus dijalankan lewat
evaluasi ini dulu.

Kode: `src/ai_clipper/face_model.py` (YuNet dan gerak mulut), `src/ai_clipper/speaker_track.py`
(pemilihan pembicara), `src/ai_clipper/face_window.py` (pemindaian jendela klip). Harness:
`scripts/eval/speaker_framing.py`. Set: `docs/evaluation/speaker-framing/set-val.json`. Hasil
terakhir: `docs/evaluation/speaker-framing/result-val-2026-10-21.json`.

## Cara kerjanya sekarang

1. Jendela klip didekode sekali. Tiap 0,75 detik satu frame jadi sampel: flag potongan adegan
   dihitung seperti dulu, lalu YuNet (`cv2.FaceDetectorYN`, model OpenCV Zoo
   `face_detection_yunet_2023mar.onnx`, lisensi MIT) mencari wajah di frame yang diperkecil ke
   sisi terpanjang 640 piksel.
2. Sampai sampel berikutnya, sekitar 15 frame per detik dipotong di sekitar mulut tiap wajah. Gerak
   mulut antara dua frame berturut-turut dihitung setelah patch digeser ke posisi paling cocok
   (maks. 4 piksel), jadi kepala yang sedikit bergerak tidak ikut terhitung. Rata-ratanya jadi
   `activity` wajah itu. Setelah perubahan gambar sebesar potongan adegan, sisa interval tidak
   diukur.
3. Wajah di sampel berurutan disambung jadi track (tidak melewati potongan adegan). Wajah yang
   tingginya kurang dari separuh wajah tertinggi di sampel itu dianggap orang di latar dan tidak
   dipilih. Dari sisanya, track dengan rata-rata `activity` tertinggi dalam ±3 sampel (satu shot)
   yang dibingkai, dan baru ditinggalkan kalau track lain unggul ≥ 0,03. Tanpa data gerak mulut,
   wajah terbesar yang dibingkai.
4. Pindah ke pembicara lain yang jaraknya ≥ 22% lebar frame ditandai sebagai potongan, jadi crop
   melompat ke pembicara baru, tidak menggeser melintasi frame.

Render otomatis (`legacy` dan `edit-v2`) dan editor memakai pemindaian yang sama.

## Set evaluasi

- Sumber: anotasi **AVA ActiveSpeaker v1.0** (Google, lisensi CC BY 4.0): kotak setiap wajah yang
  terlihat, kira-kira 25 kali per detik, dengan label bicara terdengar atau tidak. Arsip anotasi
  diunduh dari situs dataset dan dicek sha256-nya.
- Footage film **tidak di-commit**. `fetch` mengunduh tiap jendela 20 detik dari mirror publik
  dataset ke cache di luar repo, lalu meng-encode ulang ke H.264.
- Per film ada dua jenis jendela, dipilih hanya dari anotasi (tanpa melihat hasil detektor):
  - `multi`: 20 detik dengan waktu terbanyak yang menampilkan ≥ 2 wajah sambil ada yang bicara;
  - `single`: 20 detik dengan waktu terbanyak yang menampilkan satu wajah yang sedang bicara,
    tidak tumpang tindih dengan jendela `multi`.
- **Set uji (`set-val.json`)**: split validasi AVA, 24 jendela `multi` dan 26 jendela `single`
  (16,7 menit). Set ini hanya dijalankan sekali, setelah metode dan gerbangnya dikunci.
- **Set pengembangan**: split train AVA (`select --split train`), 52 jendela `multi` yang dipakai
  untuk menyetel parameter. Set ini tidak di-commit karena bisa dibuat ulang dengan perintah itu.

## Metrik

- **Galat** = porsi waktu bicara (langkah 0,1 detik dengan ≥ 1 wajah berlabel bicara terdengar)
  ketika crop 720×1280 tidak memuat titik tengah wajah mana pun yang sedang bicara. Crop dihitung
  persis seperti camera plan: centre mentah, `smooth_face_track`, lalu `layouts.crop_positions`.
- Pembanding:
  - `haar`: detektor sebelumnya (Haar cascade tiap 0,75 detik, wajah terbesar), dibekukan di harness;
  - `largest`: wajah YuNet terbesar, tanpa gerak mulut;
  - `speaker`: detektor sekarang.
- Juga dicatat: potongan per menit (potongan adegan + pindah pembicara), geseran besar per menit
  (centre berpindah ≥ 10% lebar antar sampel tanpa potongan), dan waktu pemindaian.

## Gerbang (dikunci sebelum set uji dijalankan)

| Gerbang | Syarat |
|---|---|
| Galat `multi` | `speaker` ≤ 0,8 × `haar`, dan persentil 97,5 bootstrap (2.000 kali, per jendela) dari selisih `speaker − haar` < 0 |
| Galat `single` | `speaker` ≤ `haar` + 1 poin |
| Per jendela | jendela yang membaik > 10 poin ≥ 3 × jendela yang memburuk > 10 poin |
| Waktu | total waktu pemindaian `speaker` ≤ `haar` |

## Hasil (2026-10-21)

PC pemilik, Python 3.11, OpenCV 4.14.0, `nice -n 10`.

| Set | Jendela | `haar` | `largest` | `speaker` | Bootstrap 95% selisih `speaker − haar` |
|---|---|---|---|---|---|
| Uji `multi` | 24 | 39,0% | 36,9% | **20,7%** | −27,2 s.d. −10,2 poin |
| Uji `single` | 26 | 8,4% | 5,4% | **1,6%** | −10,7 s.d. −3,7 poin |
| Pengembangan `multi` | 52 | 38,8% | 38,2% | 22,8% | −23,8 s.d. −8,5 poin |

- Set uji: 22 jendela membaik > 10 poin, 2 memburuk > 10 poin (`IzvOYVMltkI-multi` 18% → 34%,
  `kMy-6RtoOVU-multi` 19% → 39%). Pada set pengembangan: 29 membaik, 7 memburuk. Jendela yang
  memburuk umumnya adegan film dengan wajah pendengar besar di depan (over-the-shoulder) atau
  orang di latar yang ikut bergerak.
- Gerak kamera (set uji `multi`): geseran besar turun dari 14,6 ke 0,8 per menit; potongan naik
  dari 3,1 (potongan adegan saja) ke 10,3 per menit, karena pindah pembicara sekarang dipotong.
- Waktu pemindaian 50 jendela: `haar` 49,9 detik (4 thread), `speaker` 36,4 detik (1 thread).
- Semua gerbang lolos.

## Waktu

Camera plan untuk jendela 3 menit (anggaran T1.5: ≤ 15 detik dengan 4 CPU; perintah `time`,
`taskset` 4 CPU, PC pemilik sedang dipakai kerja lain, dua kali):

| Sumber | `haar` | `speaker` | CPU `haar` → `speaker` |
|---|---|---|---|
| 720p AV1 30 fps | 13,3 / 12,3 detik | **8,1 / 8,7 detik** | 51 → 15 detik |
| 1080p H.264 30 fps | 15,6 / 17,0 detik | **13,5 / 12,9 detik** | 61 → 31 detik |

Sumber unduhan YouTube Potongin maksimal 720p; 1080p hanya dari unggahan. Hasil ini juga tercatat
di `docs/editor/GATES.md`.

## Yang dicoba dan tidak dipakai

Semua diukur pada set pengembangan (52 jendela `multi`), dengan parameter lain tetap, memakai
skrip penyetelan sebelum versi akhir (versi akhir: 22,8%, selisih < 0,5 poin).

| Percobaan | Galat | Keputusan |
|---|---|---|
| Hanya wajah YuNet terbesar | 38,2% | tidak cukup: setara Haar |
| Jeda audio dari `analysis/audio-timeline.json` (gerak mulut saat hening tidak dihitung) | 22,6% (tanpa: 23,0%) | selisih di bawah derau; tidak dipakai, jadi render tidak perlu membaca artefak audio |
| Batas giliran bicara (`analysis/speaker-changes.json`), disimulasikan dari anotasi: tepat, ±0,3 detik, ±0,5 detik dengan 20% hilang | 22,7%, 23,2%, 23,0% | tidak menambah akurasi; tidak dipakai. File itu juga hanya ditulis oleh CLI subtitle YouTube, bukan oleh pipeline |
| Korelasi gerak mulut dengan RMS audio per 0,1 detik | akurasi pasangan 53% (gerak mulut saja: 78%) | sinyal lemah; tidak dipakai |
| Gerak mulut dikurangi baseline track | lebih buruk dari tanpa | tidak dipakai |
| Bobot ukuran wajah, batas ukuran wajah absolut, 8 atau 30 frame mulut per detik, lebar area mulut 1,2× atau 2,2× | 21,3–23,9% | dalam derau; tetap pada nilai sekarang |

Batas atas: kalau wajah pembicara selalu dipilih dengan benar (oracle dari anotasi), galat set
pengembangan 6,0%. Sisa galat sebagian besar dari salah pilih pembicara, bukan dari deteksi wajah.

## Batasan

- Set ini dari film, bukan podcast. Film punya gerak kamera, wajah menyamping dan pencahayaan gelap
  yang lebih sulit dari podcast studio, jadi angkanya kemungkinan pesimis untuk podcast. Belum ada
  set podcast berlisensi bebas; set podcast dari proyek pemilik bisa ditambahkan kelak tanpa
  meng-commit footage-nya.
- Pemilihan pembicara hanya dari gerak mulut. Orang yang tertawa, mengunyah atau mengangguk bisa
  terbaca sebagai bicara.

## Menjalankan

```bash
# sekali: anotasi + daftar jendela (butuh internet)
uv run python scripts/eval/speaker_framing.py select --split val --cache ~/.cache/potongin-eval \
  --out docs/evaluation/speaker-framing/set-val.json
# unduh jendela film ke cache (± 50 × 20 detik; butuh internet)
uv run python scripts/eval/speaker_framing.py fetch --set docs/evaluation/speaker-framing/set-val.json \
  --cache ~/.cache/potongin-eval --jobs 3
# ukur (± 1–2 menit CPU)
nice -n 10 uv run python scripts/eval/speaker_framing.py run \
  --set docs/evaluation/speaker-framing/set-val.json --cache ~/.cache/potongin-eval --out hasil.json
# waktu camera plan pada satu video lokal (jendela 3 menit di tengah)
nice -n 10 uv run python scripts/eval/speaker_framing.py time --source /path/ke/video.mp4
```

Di GitHub Actions: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=command -f
command='…'` dengan perintah `fetch` lalu `run --out /out/…` di atas (cache di `/tmp`).

Atribusi: AVA ActiveSpeaker, Roth dkk., "AVA-ActiveSpeaker: An Audio-Visual Dataset for Active
Speaker Detection" (2019), anotasi CC BY 4.0 oleh Google.
