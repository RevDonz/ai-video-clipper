# Glosarium ID ↔ EN

Istilah tetap Potongin. Penerjemah `en` memakai tabel ini bersama katalog `web/messages/id/`
(`AGENTS.md`, clean-room). Istilah bertanda ★ sama di kedua bahasa. Huruf kapital hanya di awal
(sentence case) di kedua bahasa.

Sumber: rencana rombak `07-i18n.md` §16 dan kata status `05-ui-dashboard.md` §5 (dokumen pemilik
kata status). Kalau berbeda, dokumen itu yang berlaku dan tabel ini diperbarui.

| ID | EN | Catatan |
|---|---|---|
| Potongin ★ | Potongin | Nama produk |
| Klip | Clip | |
| Proyek | Project | Menggantikan "Riwayat" |
| Buat klip | Create clips | Tombol utama dashboard |
| Link video | Video link | |
| Bahasa video | Video language | Nilai `id`/`en`/`auto` |
| Deteksi otomatis | Auto-detect | |
| Tata letak | Layout | Tab editor + chip Buat klip |
| Otomatis | Auto | Mode tata letak |
| Ikuti wajah | Follow face | |
| Potong tengah | Center crop | |
| Latar blur | Blurred background | Mode tata letak. Bukan "Blur background" (lihat catatan) |
| Layar terbagi | Split screen | Hanya editor |
| Arahkan | Guide | Chip Buat klip (fokus dan rentang waktu) |
| Durasi | Length | Chip Buat klip |
| Subtitle (chip Buat klip) | Captions | Gaya teks ucapan di klip |
| Klasik · Karaoke · Bold · Box · Sorot · Sinar | Classic · Karaoke · Bold · Box · Highlight · Glow | Nama gaya caption |
| Terbaik · Urutan video | Best · Video order | Urutan klip di halaman proyek |
| Di luar fokus | Outside focus | Saring klip |
| Diedit | Edited | Klip yang diubah di editor |
| Proses ulang | Run again | Aksi proyek |
| Teks | Text | Tab editor |
| Audio ★ | Audio | Tab editor |
| Logo ★ | Logo | Tab editor |
| Cold open ★ | Cold open | Tab editor |
| Hook ★ | Hook | |
| Hook di video | Hook on video | Switch |
| Caption | Caption | |
| Gaya caption | Caption style | |
| Kata kunci | Keywords | |
| Zona aman | Safe zone | |
| Transkrip | Transcript | |
| Kata · Baris | Words · Lines | Mode transkrip |
| Segmen | Segment | |
| Lihat sumber | View source | |
| Lanjutan | Advanced | Disclosure kontrol halus |
| Pakai di semua klip | Apply to all clips | |
| Perlu dicek | Needs review | Editor dan detail status `status.detail.check` (satu istilah) |
| Hubungkan ulang akun | Reconnect account | Detail status `status.hold.reauth` |
| Menunggu kuota | Waiting for quota | Detail status `status.hold.quota` |
| Catatan | Notes | |
| Kenapa dipilih | Why this clip | |
| Skor | Score | |
| Pratinjau | Preview | |
| Ekspor | Export | |
| Ekspor semua | Export all | |
| Unduh | Download | |
| Terbitkan | Publish | Aksi |
| Jadwalkan | Schedule | |
| Sekarang | Now | |
| Antre | Queued | Status proses. Menggantikan "Menunggu" |
| Diproses | Processing | |
| Selesai | Done | |
| Gagal | Failed | Proses dan postingan |
| Dibatalkan | Cancelled | Proses dan postingan (ejaan sama dengan state `cancelled`, 05 §5) |
| Menghapus | Deleting | Status proses transien (05 §5) |
| Tidak dikenal | Unknown | Status proses (05 §5) |
| Pemeliharaan | Maintenance | Detail status Antre |
| Pengguna nonaktif | User disabled | Detail status Antre, hanya di `/admin/job` (05 §5) |
| Terjadwal | Scheduled | Status postingan |
| Mengunggah | Uploading | |
| Terbit | Published | Status postingan |
| Tren | Trends | Menggantikan "Konteks Tren" |
| Sosial | Social | |
| Analitik | Analytics | |
| Umpan balik | Feedback | Tab Analitik |
| Pengaturan | Settings | |
| Tampilan | Appearance | Tab Pengaturan |
| Sistem | System | |
| Transkripsi | Transcription | |
| Bantuan | Help | |
| Panduan | Guide | |
| Akun | Account | |
| Bahasa | Language | |
| Zona waktu | Time zone | |
| Kata sandi | Password | |
| Masuk | Sign in | |
| Keluar | Sign out | |
| Keluar dari semua perangkat | Sign out everywhere | |
| Admin ★ | Admin | Item navigasi, hanya untuk admin |
| Kelola pengguna | Manage users | |
| Undangan | Invitation | |
| Peran: Admin · Anggota | Role: Admin · Member | |
| Pintasan | Shortcuts | |
| Simpan | Save | |
| Batal | Cancel | |
| Hapus | Delete | |
| Salin | Copy | |
| Ubah | Edit | |
| Tulis ulang | Rewrite | |

Catatan:

- **Latar blur = Blurred background.** `08-fase-test-deploy.md` §4 G0 menulis "Blur background";
  dipakai "Blurred background" dari 07 §16, dokumen pemilik istilah bahasa.
- Nama platform (YouTube, TikTok, Instagram) tidak diterjemahkan.
- Istilah baru wajib ditambahkan ke tabel ini di PR yang memperkenalkannya.
