/* ============================================================
   Sumber resep LOKAL — masakan Indonesia (halal).
   Data dibundel di data/recipes-id.json (hasil build dari
   dataset Cookpad: github.com/terarush/api-resepMakananIndonesia).
   Tidak ada panggilan ke server pihak ketiga saat runtime,
   jadi cepat & jalan offline.
   ============================================================ */
window.MealAPI = (function () {
  "use strict";

  const DATA_URL = "data/recipes-id.json";
  let cache = null;        // array resep
  let loadingPromise = null;

  function load() {
    if (cache) return Promise.resolve(cache);
    if (loadingPromise) return loadingPromise;
    loadingPromise = fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error("Gagal memuat data resep (" + r.status + ")"); return r.json(); })
      .then((d) => { cache = (d.recipes || []).map(normalize); return cache; });
    return loadingPromise;
  }

  // Pastikan tiap resep punya bentuk konsisten.
  function normalize(r) {
    return {
      id: r.id,
      name: r.name,
      image: r.image || "",
      category: r.category || "",
      area: r.area || "Indonesia",
      loves: r.loves || 0,
      ingredients: r.ingredients || [],
      steps: r.steps || [],
      youtube: r.youtube || "",
      source: r.source || "",
    };
  }

  const norm = (s) => (s || "").toLowerCase().trim();

  // Jarak Levenshtein ringkas (untuk toleransi typo pada pencarian).
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let cur = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Cocokkan token query ke teks dengan toleransi typo.
  function fuzzyToken(token, hay, words) {
    if (hay.indexOf(token) > -1) return true;          // substring persis
    if (token.length < 4) return false;                // token pendek: harus persis
    // Bandingkan ke tiap kata; toleransi ~20% panjang token (min 1, maks 2).
    const tol = Math.min(2, Math.max(1, Math.floor(token.length * 0.2)));
    for (const w of words) {
      if (Math.abs(w.length - token.length) > tol) continue;
      if (editDistance(token, w) <= tol) return true;
    }
    return false;
  }

  async function search(query) {
    const all = await load();
    const q = norm(query);
    if (!q) return all.slice().sort((a, b) => b.loves - a.loves);
    const tokens = q.split(/\s+/);

    // Tahap 1: cocok substring (cepat, hasil paling relevan).
    const exact = all.filter((r) => {
      const hay = norm(r.name) + " " + norm(r.category);
      return tokens.every((t) => hay.indexOf(t) > -1);
    });
    if (exact.length) return exact.sort((a, b) => b.loves - a.loves);

    // Tahap 2: fallback fuzzy (toleransi typo) hanya bila tahap 1 kosong.
    return all.filter((r) => {
      const hay = norm(r.name) + " " + norm(r.category);
      const words = hay.split(/\s+/);
      return tokens.every((t) => fuzzyToken(t, hay, words));
    }).sort((a, b) => b.loves - a.loves);
  }

  async function byCategory(cat) {
    const all = await load();
    const c = norm(cat);
    return all.filter((r) => norm(r.category) === c).sort((a, b) => b.loves - a.loves);
  }

  async function detail(id) {
    const all = await load();
    return all.find((r) => r.id === id) || null;
  }

  async function random(n) {
    const all = await load();
    const pool = all.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return n ? pool.slice(0, n) : (pool[0] || null);
  }

  async function categories() {
    const all = await load();
    const set = new Map(); // cat -> count
    all.forEach((r) => set.set(r.category, (set.get(r.category) || 0) + 1));
    // urutkan dari kategori terbanyak
    return Array.from(set.keys()).sort((a, b) => set.get(b) - set.get(a));
  }

  return { search, byCategory, detail, random, categories, load };
})();
