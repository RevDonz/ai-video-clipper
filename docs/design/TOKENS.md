# Token desain

Sumber: `web/app/globals.css` (`:root`). Arah: `DESIGN.md` (gelap di semua halaman, satu aksen lime,
DM Sans, dial ENERGY 1 / RHYTHM 1 / MOTION 2). Ubah nilai di dua tempat sekaligus;
`web/tests/app-shell.test.mjs` memeriksa keduanya sama dan menghitung ulang kontras AA.

Kontras dihitung dengan `.claude/skills/antislop-human/contrast-check.py`. Batas: teks 4.5:1,
tepi kontrol dan cincin fokus 3:1.

## Warna

| Token | Peran | Hex | Kontras |
|---|---|---|---|
| `--bg` | Latar halaman | `#080907` | dasar |
| `--surface` | Kartu, panel, header | `#11120f` | dasar |
| `--surface-2` | Input, blok di dalam kartu, jalur tab | `#1a1b17` | dasar |
| `--surface-3` | Hover, item terpilih | `#23251f` | dasar |
| `--border` | Garis pemisah dan tepi kartu (hiasan, bukan tepi kontrol) | `#292b25` | 1.31 di surface |
| `--border-strong` | Tepi kontrol: input, tombol, tab aktif | `#6b6d63` | 3.79 bg, 3.57 surface, 3.29 surface-2 |
| `--text` | Teks utama | `#f7f5ed` | 18.28 bg, 17.22 surface, 15.86 surface-2, 14.19 surface-3 |
| `--text-muted` | Teks sekunder, label kecil, placeholder | `#a5a69d` | 8.12 bg, 7.64 surface, 7.04 surface-2, 6.30 surface-3 |
| `--accent` | Satu aksen lime: tombol utama, tanda merek, isi progres | `#dfff58` | 17.66 bg, 13.71 surface-3 |
| `--accent-hover` | Tombol utama saat hover | `#ecff9a` | teks di atasnya 18.06 |
| `--accent-ink` | Teks di atas lime | `#0b0c09` | 17.35 di accent |
| `--focus` | Cincin fokus keyboard | `#8b9dff` | 7.95 bg, 7.49 surface, 6.90 surface-2 |
| `--info` | Tautan, status berjalan, info | `#8b9dff` | 7.95 bg, 6.17 surface-3, 6.84 info-bg |
| `--info-bg` | Latar pesan info | `#151a30` | text 15.74, muted 6.99 |
| `--info-border` | Tepi pesan info (hiasan) | `#3a4680` | 1.94 di info-bg |
| `--danger` | Gagal, hapus | `#ff8b7d` | 8.78 bg, 6.82 surface-3, 7.61 danger-bg |
| `--danger-bg` | Latar pesan bahaya | `#2a1512` | text 15.84, muted 7.03 |
| `--danger-border` | Tepi pesan bahaya (hiasan) | `#7a352c` | 1.95 di danger-bg |
| `--danger-ink` | Teks di atas tombol hapus merah | `#0b0c09` | 8.63 di danger |
| `--success` | Selesai, aktif | `#7fd99a` | 11.68 bg, 9.07 surface-3, 9.54 success-bg |
| `--success-bg` | Latar pesan berhasil | `#10241a` | text 14.92, muted 6.62 |
| `--success-border` | Tepi pesan berhasil (hiasan) | `#2f6b45` | 2.57 di success-bg |
| `--warning` | Peringatan | `#f0c95a` | 12.55 bg, 9.74 surface-3, 9.96 warning-bg |
| `--warning-bg` | Latar pesan peringatan | `#282210` | text 14.50, muted 6.44 |
| `--warning-border` | Tepi pesan peringatan (hiasan) | `#6d5b22` | 2.39 di warning-bg |
| `--sheen` | Kilau yang lewat di isi bar progres (hiasan) | `#ffffff73` | tanpa teks |

Info dan fokus memakai biru yang sama: `#3f5efb` lama hanya 4.00 di latar gelap, jadi dinaikkan.
Merah `#e44e3f` lama menjadi `#ff8b7d` supaya tetap terbaca di latar merah gelap.

## Nama lama

Halaman yang masih memakai nama palet terang langsung ikut gelap:

| Lama | Sekarang |
|---|---|
| `--paper` | `--bg` |
| `--card` | `--surface` |
| `--line` | `--border` |
| `--ink` | `--text` |
| `--muted` | `--text-muted` |
| `--lime` | `--accent` |
| `--blue` | `--info` |
| `--red` | `--danger` |

`--ink` sekarang warna teks terang. Aturan halaman yang memakainya sebagai isi tombol
(`background: var(--ink); color: #fff`) harus pindah ke `.btn.primary` atau `.btn`, dan latar
`#fff` atau `#f8f7f2` pindah ke `--surface-2`.

## Bentuk dan gerak

| Token | Nilai | Dipakai untuk |
|---|---|---|
| `--font` | DM Sans lewat `next/font` (`--font-dm-sans`, disajikan dari app sendiri) | Semua teks; jangan tulis nama font langsung di CSS |
| `--radius-s` / `-m` / `-l` / `-xl` | 8 / 10 / 14 / 20 px | Label kecil / kontrol / kartu dalam / panel |
| `--radius-pill` | 999px | Hanya chip dan status |
| `--dur-1` | 120ms | Hover, tekan tombol |
| `--dur-2` | 200ms | Pindah tab, chip muncul, pesan status |
| `--dur-3` | 320ms | Hasil klip dan banner muncul |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | Hampir semua transisi |
| `--ease-in-out` | `cubic-bezier(.45, 0, .2, 1)` | Animasi berulang (kilau progres, titik muat) |

Dengan `prefers-reduced-motion: reduce`, ketiga durasi menjadi 0ms dan semua animasi berhenti
setelah satu frame.

## Aturan pakai

- Lime hanya untuk satu aksi utama per layar, tanda merek "P", dan isi bar progres.
- Pilihan aktif (kartu layout, tab, menu) memakai tepi terang dan `--surface-3`, bukan lime.
- Status selalu punya teks; warna hanya penguat.
- Kelas dasar di `globals.css`: `.btn` (`.primary`, `.ghost`, `.danger`, `.danger.solid`),
  `.panel` / `.card`, `.chip` (`.ok`, `.info`, `.warning`, `.error`), `.notice` (nada yang sama),
  `.segmented`, `.table` di dalam `.tableWrap`, `.eyebrow`, `.visuallyHidden`.
