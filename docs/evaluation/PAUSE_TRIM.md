# Evaluasi potong jeda di klip otomatis

Evaluasi ini mengukur berapa banyak jeda hening (dead air) yang dibuang dari klip otomatis oleh
potong jeda otomatis, sebelum fitur itu dinyalakan. Ulangi setiap kali aturan jeda di
`src/ai_clipper/edit_v2/cleanup.py` berubah.

Kode: `cleanup.auto_pause_removals` (kontrak: `docs/editor/CONTRACTS.md` §5.58). Harness:
`scripts/eval/pause_trim.py`. Hasil terakhir: `docs/evaluation/pause-trim/result-whisper-2026-10-21.json`
dan `docs/evaluation/pause-trim/result-yt-2026-10-21.json`.

## Aturannya

- Hanya jeda di antara dua kata klip yang lebih dari 0,6 detik dan minimal 80 % hening menurut
  audio timeline. Jeda itu dipendekkan menjadi 0,2 detik (0,1 detik di tiap sisi), dan titik
  potongnya digeser ke bagian yang benar-benar tenang menurut peaks audio klip.
- Tidak pernah dipotong: jeda yang masih ada suaranya (latar, napas, orang lain), jeda dalam
  0,5 detik dari tawa (tag caption atau "wkwk"/"haha" di transkrip), dan jeda dalam 0,5 detik dari
  tag musik, tepuk tangan atau sorakan. Cold open tidak dipotong.
- Kalau sisa klip jadi kurang dari 3 detik, klip itu tidak dipotong sama sekali.

## Data

84 momen berlabel dari benchmark seleksi (`docs/evaluation/gold/*.gold.json`, 7 episode, 12 momen
per episode), dipakai sebagai klip. File episodenya tidak di-commit (folder eval lokal). Diukur
dari timing kata, audio timeline, tag caption YouTube dan peaks audio tiap jendela klip; tidak ada
render.

- **Whisper**: transkrip Whisper (dipakai untuk unggahan), 4 episode yang punya file itu.
- **YouTube**: caption otomatis YouTube (dipakai untuk link YouTube yang punya caption), 7 episode.

## Hasil (2026-10-21)

| | Whisper | YouTube |
|---|---|---|
| Klip | 48 (3.167 dtk) | 84 (5.582 dtk) |
| Jeda dibuang | 59,0 dtk (1,9 %) | 143,4 dtk (2,6 %) |
| Klip yang terpotong | 37 dari 48 | 69 dari 84 |
| Jumlah potongan | 81, rata-rata 0,73 dtk | 215, rata-rata 0,67 dtk |
| Per klip: median / p90 / maks | 1,3 % / 5,3 % / 7,8 % | 1,7 % / 6,1 % / 13,6 % |
| Jeda > 0,6 dtk yang dibiarkan: bersuara / tawa | 265 / 52 | 349 / 73 |

Per episode (persen durasi yang dibuang): Whisper 1,2–2,7 %, YouTube 1,1–5,3 %. Klip 60 detik
rata-rata kehilangan 1,1–1,5 detik jeda kosong, satu klip dari sepuluh 3–4 detik.

Tanpa pemeriksaan peaks (hanya timing kata dan audio timeline) hasilnya sekitar 2,2 % dan 3,0 %:
pemeriksaan titik tenang membatalkan sekitar 15 % dari durasi kandidat. Jeda kata > 0,6 detik menurut
timing kata saja jauh lebih banyak (10–12 % durasi), tapi sebagian besar bersuara dan tidak aman
dipotong.

## Keputusan

Dinyalakan sebagai bawaan (`POTONGIN_AUTO_PAUSE_TRIM=on`, keputusan atas delegasi pemilik,
2026-10-21): hampir 8 dari 10 klip punya jeda hening yang terdengar, tiap potongan rata-rata
0,7 detik, dan tawa serta musik tidak tersentuh. Potongan ini sama dengan saran "Jeda hening"
Rapikan yang memang tercentang bawaan di editor; di editor tiap potongan terlihat dan bisa
dipulihkan. Untuk mematikannya: `POTONGIN_AUTO_PAUSE_TRIM=off` (`docs/editor/OPERASIONAL.md` §2).

## Menjalankan ulang

```bash
nice -n 10 uv run python scripts/eval/pause_trim.py --eval-root <folder eval> \
    --media <folder video> --peaks --out hasil-whisper.json
nice -n 10 uv run python scripts/eval/pause_trim.py --eval-root <folder eval> \
    --media <folder video> --peaks --transcript yt --out hasil-yt.json
```
