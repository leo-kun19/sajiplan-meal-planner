# Deploy SajiPlan ke Netlify

SajiPlan adalah situs statis (HTML/CSS/JS + JSON). Tidak perlu build step.
Konfigurasi sudah disiapkan di `netlify.toml`.

## Cara tercepat — drag & drop (tanpa Git)

1. Buka https://app.netlify.com/drop
2. Seret seluruh folder proyek (`seikou`) ke area drop.
3. Tunggu beberapa detik — situs langsung online di URL acak
   (mis. `https://sajiplan-abc123.netlify.app`).
4. Selesai. Buka URL-nya di HP/desktop, lalu pasang sebagai aplikasi (PWA).

## Lewat Git (rekomendasi untuk update berkelanjutan)

1. Inisialisasi & push ke GitHub:
   ```bash
   git init
   git add .
   git commit -m "SajiPlan: perencana makan & daftar belanja"
   git branch -M main
   git remote add origin https://github.com/<username>/sajiplan.git
   git push -u origin main
   ```
2. Di Netlify: "Add new site" → "Import an existing project" → pilih repo.
3. Build command: kosongkan. Publish directory: `.` (titik).
4. Deploy. Setiap `git push` berikutnya akan otomatis re-deploy.

## Lewat Netlify CLI

```bash
npm install -g netlify-cli
netlify deploy            # preview
netlify deploy --prod     # produksi
```

## Catatan
- Service worker (`sw.js`) di-set agar tidak di-cache lama, jadi update versi
  langsung terdeteksi pengguna (lihat header di `netlify.toml`).
- Semua path relatif, jadi situs jalan baik di domain root maupun subpath.
- File `frontend.md`, `humanize.md`, dan `tools/` boleh ikut ter-upload (tidak
  mengganggu), atau hapus dulu kalau ingin folder publik lebih bersih.
- HTTPS otomatis dari Netlify — wajib untuk PWA/service worker, sudah beres.
```
