# Deploy di VM — Docker, Nginx Proxy Manager, Cloudflare

## 1. Jalankan container

```bash
git clone git@github.com:RevDonz/ai-video-clipper.git
cd ai-video-clipper
cp .env.example .env
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Data input, status job, transcript, dan hasil klip disimpan pada named volume
`clipper_data`. Upgrade aplikasi tidak menghapus volume tersebut.

Untuk VM CPU kecil, ubah `.env` menjadi `WHISPER_MODEL=tiny`. Model `small`
memberi transkripsi lebih baik tetapi lebih lambat dan memakai RAM lebih banyak.

## 2. Nginx Proxy Manager (UI)

Bila Nginx Proxy Manager juga berjalan sebagai container, sambungkan container NPM
ke network aplikasi terlebih dahulu (ganti nama container bila berbeda):

```bash
docker network connect ai-video-clipper_default nginx-proxy-manager
```

Buat **Proxy Host**:

- Domain Names: `clip.domainanda.com`
- Scheme: `http`
- Forward Hostname/IP: `ai-video-clipper`
- Forward Port: `3000`
- Websockets Support: aktif
- Block Common Exploits: aktif

Advanced configuration:

```nginx
client_max_body_size 500M;
proxy_connect_timeout 60s;
proxy_send_timeout 3600s;
proxy_read_timeout 3600s;
send_timeout 3600s;
```

Pada tab SSL, minta sertifikat Let's Encrypt dan aktifkan **Force SSL** serta
**HTTP/2 Support**. Jika memakai Cloudflare Origin Certificate, pasang
sertifikat origin tersebut di NPM dan gunakan mode SSL Cloudflare `Full (strict)`.

> Web MVP ini belum memiliki akun/login. Lindungi dengan Cloudflare Access atau
> Access List Nginx Proxy Manager sebelum membuka domain ke publik.

## 3. Cloudflare DNS

1. Tambahkan record `A` untuk subdomain ke public IP VM.
2. Aktifkan proxy (awan oranye).
3. SSL/TLS mode: `Full (strict)`.
4. Aktifkan Always Use HTTPS.
5. Jangan cache `/api/*` melalui Cache Rules.

Batas upload Cloudflare bergantung paket akun. Jika upload file besar ditolak di
edge, gunakan input URL YouTube, naikkan paket, atau buat hostname upload terpisah
yang tidak diproxy. Jangan menurunkan keamanan SSL ke mode Flexible.

## 4. Operasional

```bash
# Log web dan job runner
docker compose logs -f app

# Status dan health
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health

# Update aplikasi
git pull --ff-only origin main
docker compose build
docker compose up -d

# Lihat pemakaian volume
docker system df
docker exec ai-video-clipper du -sh /data/jobs
```

Jangan menjalankan `docker compose down -v` kecuali memang ingin menghapus semua
video dan hasil job. Penghapusan data produksi harus dilakukan dengan kebijakan
retensi yang eksplisit.
