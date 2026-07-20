# Build dataset penuh di VPS

Skrip `build_recipes.mjs` mengambil resep dari dataset Cookpad, memfilter halal,
men-scrape gambar, dan menulis `data/recipes-id.json`.

## Yang perlu disiapkan
- Node.js 18+ (punya `fetch` bawaan). Cek: `node --version`
- File `tools/image-cache.json` ikut serta — ini berisi **950 gambar yang sudah
  ada** supaya TIDAK di-scrape ulang (anti-duplikasi).

## Salin proyek ke VPS
```bash
# dari mesin lokal (atau clone dari Git):
scp -r ./seikou user@vps-ip:~/seikou
# atau: git clone <repo> && cd seikou
```

## Jalankan (mode B: SEMUA resep + gambar)
Karena prosesnya ~2 jam, jalankan dengan `nohup`/`screen`/`tmux` agar tetap
berjalan walau sesi SSH terputus.

```bash
cd ~/seikou

# opsi 1: tmux (paling nyaman, bisa dipantau)
tmux new -s build
node tools/build_recipes.mjs
#  -> Ctrl+B lalu D untuk detach. Sambung lagi: tmux attach -t build

# opsi 2: nohup (jalan di background, log ke file)
nohup node tools/build_recipes.mjs > build.log 2>&1 &
tail -f build.log
```

### Lebih cepat (opsional)
VPS biasanya punya bandwidth bagus, jadi bisa lebih agresif:
```bash
CONCURRENCY=8 SCRAPE_DELAY=200 node tools/build_recipes.mjs
```
Kalau Cookpad mulai menolak (gambar banyak yang kosong), turunkan lagi:
`CONCURRENCY=4 SCRAPE_DELAY=400`.

## Kalau terputus di tengah jalan
Cukup **jalankan ulang perintah yang sama**. Skrip menyimpan progres gambar ke
`tools/image-cache.json` tiap 100 gambar, jadi saat dijalankan lagi ia melewati
semua URL yang sudah pernah di-scrape dan lanjut dari sisanya. Tidak ada
duplikasi fetch.

## Hasil
- `data/recipes-id.json` — bundle final (~14 MB, ~14.873 resep).
- `tools/image-cache.json` — cache gambar (boleh ikut di-commit; jadi modal
  resume untuk build berikutnya).

## Bawa hasilnya kembali & deploy
```bash
# dari lokal:
scp user@vps-ip:~/seikou/data/recipes-id.json ./data/recipes-id.json
scp user@vps-ip:~/seikou/tools/image-cache.json ./tools/image-cache.json
```
Lalu naikkan versi cache service worker (`sw.js`, ubah `CACHE = "sajiplan-vN"`)
agar pengguna menarik data baru, dan deploy ulang ke Netlify.

## Variasi konfigurasi
| Tujuan | Perintah |
|--------|----------|
| Semua resep + gambar (mode B) | `node tools/build_recipes.mjs` |
| Semua resep, tanpa gambar baru (cepat) | `SKIP_IMAGES=1 node tools/build_recipes.mjs` |
| Batasi 300/kategori | `PER_CATEGORY=300 node tools/build_recipes.mjs` |
| Lebih cepat | `CONCURRENCY=8 SCRAPE_DELAY=200 node tools/build_recipes.mjs` |
