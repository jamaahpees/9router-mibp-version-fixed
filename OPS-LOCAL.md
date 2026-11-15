# Catatan operasional instance ini

Bukan dokumentasi upstream. Isinya hanya hal yang spesifik untuk deployment
di VPS ini, supaya image swap berikutnya tidak menghilangkan pengamanannya.

## Membuat ulang container

```sh
docker rename 9router 9router-prev-<nama>
docker update --restart=no 9router-prev-<nama> >/dev/null
docker stop 9router-prev-<nama>

docker run -d --name 9router --restart always \
  --network 9router-net -p 20128:20128 \
  --memory=2g --memory-swap=2g \
  -v 9router-data:/app/data \
  9router-custom:<tag>
```

`--memory=2g --memory-swap=2g` = batas keras 2 GB tanpa swap tambahan. Kombo
yang salah konfigurasi pernah membuat proses berputar sampai RSS 2,1 GB plus
1,7 GB swap dan instance hang, jadi lebih baik kena OOM-kill lalu
`restart=always` menghidupkan ulang daripada seluruh VPS kehabisan memori.
Pemakaian normal: 90-250 MB.

`docker update --memory=... 9router` bisa dipakai untuk container yang sudah
jalan, tetapi **tidak ikut** kalau container dibuat ulang. Karena itu flag di
atas wajib ada di setiap `docker run`.

## Rollback

Container lama sengaja disimpan (`9router-prev-*`) dengan `restart=no`.
Untuk kembali:

```sh
docker stop 9router && docker rename 9router 9router-broken
docker rename 9router-prev-<nama> 9router
docker update --restart=always 9router
docker start 9router
```

## Database

- Live: volume `9router-data`, berkas `db/data.sqlite`.
- Backup terverifikasi terbaru disimpan satu saja per instance di
  `/root/safe-backups/`, dibuat dengan `sqlite3 "$DB" ".backup '<tujuan>'"`
  lalu dicek `pragma quick_check`. Backup lama dihapus setelah yang baru lolos.
- Kenaikan `SCHEMA_VERSION` memicu backup pra-skema otomatis oleh
  `src/lib/db/migrate.js` di dalam volume (`db/backups/`).
