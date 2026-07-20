/* Service Worker — SajiPlan */
const CACHE = "sajiplan-v15";
// Aset inti (ringan) yang di-precache saat install — TANPA file data resep,
// supaya kunjungan pertama tidak dipaksa mengunduh bundle besar.
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./api.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
// File data resep (besar): TIDAK di-precache. Tetap di-cache otomatis saat
// pertama kali diminta (waktu buka tab Jelajah), lalu tersedia offline.
const DATA_PATH = "/data/recipes-id.json";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Izinkan halaman memaksa SW baru aktif segera.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Hanya tangani aset milik origin sendiri. Panggilan API (TheMealDB) dibiarkan
  // lewat jaringan tanpa intervensi SW.
  if (url.origin !== self.location.origin) return;

  // Navigasi: network-first agar HTML selalu fresh, fallback ke cache saat offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // File data resep (besar): cache-first. Unduh sekali, lalu selalu dari cache.
  // Tidak di-revalidate tiap load supaya tidak boros bandwidth 16 MB berulang.
  // (Pembaruan data ditangani lewat naik-versi CACHE saat deploy.)
  if (url.pathname.endsWith(DATA_PATH) || url.pathname.endsWith("data/recipes-id.json")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        });
      })
    );
    return;
  }

  // Aset (css/js/ikon): stale-while-revalidate.
  // Sajikan dari cache untuk kecepatan, tapi selalu perbarui cache di latar belakang
  // supaya kode yang diubah tidak "nyangkut" versi lama.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
