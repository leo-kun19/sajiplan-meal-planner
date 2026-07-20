/*
 * Bangun bundle resep Indonesia HALAL untuk SajiPlan.
 *
 * Sumber data : github.com/terarush/api-resepMakananIndonesia (~14.9k resep, dari Cookpad)
 * Proses      : filter halal -> urut by Loves -> (opsi) ambil N teratas/kategori
 *               -> scrape og:image dari Cookpad -> tulis data/recipes-id.json
 *
 * ANTI-DUPLIKASI & RESUME:
 *   Gambar di-cache di tools/image-cache.json dengan kunci URL halaman Cookpad.
 *   - Cache di-seed dari data/recipes-id.json yang sudah ada (gambar lama dipakai ulang).
 *   - Selama scrape, URL yang sudah ada di cache TIDAK di-fetch lagi.
 *   - Cache di-flush ke disk berkala, jadi job yang terputus bisa dilanjutkan
 *     hanya dengan menjalankan ulang skrip ini (lanjut dari posisi terakhir).
 *
 * KONFIG via environment variable (cocok untuk VPS):
 *   PER_CATEGORY = jumlah/kategori (default: 0 = AMBIL SEMUA)
 *   CONCURRENCY  = worker paralel scrape (default: 5)
 *   SCRAPE_DELAY = jeda ms tiap request per worker (default: 300)
 *   SKIP_IMAGES  = "1" untuk lewati scraping gambar (cepat, tanpa foto baru)
 *
 * Contoh di VPS:
 *   node tools/build_recipes.mjs                # semua resep, dengan gambar
 *   CONCURRENCY=8 SCRAPE_DELAY=200 node tools/build_recipes.mjs
 *   PER_CATEGORY=300 node tools/build_recipes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, "data", "recipes-id.json");
const CACHE_FILE = path.join(__dirname, "image-cache.json");

const DATA_URL = "https://raw.githubusercontent.com/terarush/api-resepMakananIndonesia/refs/heads/main/data/indonesian_food_recipes.json";

const PER_CATEGORY = parseInt(process.env.PER_CATEGORY || "0", 10);   // 0 = semua
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5", 10);
const SCRAPE_DELAY = parseInt(process.env.SCRAPE_DELAY || "300", 10);
const SKIP_IMAGES = process.env.SKIP_IMAGES === "1";
const FLUSH_EVERY = 100; // simpan cache tiap N gambar baru

/* ---------- Filter halal ---------- */
const HARAM_SUBSTR = [
  "babi", "pork", "bacon", "lard", "ham hock", "angciu", "ang ciu", "ang-ciu",
  "lapchiong", "lap chiong", "lapcheong", "char siu", "charsiu", "samcan", "sam can",
  "saikoro babi", "minyak babi", "lemak babi", "kuah babi", "b2 ", "se'i babi",
];
const HARAM_WORD = [
  "ham", "bir", "beer", "wine", "rum", "arak", "sake", "mirin", "soju",
  "wiski", "whisky", "whiskey", "vodka", "rhum", "brandy", "tuak", "ciu",
];
const substrRe = new RegExp(HARAM_SUBSTR.map(esc).join("|"), "i");
const wordRe = new RegExp("\\b(" + HARAM_WORD.map(esc).join("|") + ")\\b", "i");
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isHalal(text) { return !substrRe.test(text) && !wordRe.test(text); }

/* ---------- Util parsing (sama seperti sebelumnya) ---------- */
function splitList(raw) {
  return (raw || "").split("--").map((p) => p.trim()).filter((p) => p && p !== ":");
}
function splitSteps(raw) {
  let t = (raw || "").replace(/\r/g, "\n").trim();
  if (/\n\s*\d+[).]/.test(t)) return t.split(/\n+/).map((s) => s.replace(/^\s*\d+[).]\s*/, "").trim()).filter(Boolean);
  if (t.includes("--")) return splitList(t);
  if (t.includes("\n")) return t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return t.split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter((s) => s.length > 1);
}
const UNITS = ["gram","gr","g","kg","ml","liter","ltr","sdm","sdt","buah","butir","siung",
  "lembar","batang","ruas","ekor","papan","ikat","bungkus","potong","genggam","biji",
  "sendok","cm","ons","gelas","keping","kaleng","saset","sachet","bonggol"];
function parseIngredient(line) {
  line = line.trim().replace(/[:：]$/, "");
  const m = line.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*[.,]?\d+)\s*(.*)$/);
  if (!m) return { name: line, qty: 0, unit: "secukupnya" };
  let qtyRaw = m[1].replace(",", ".");
  let qty;
  if (qtyRaw.includes("/") || qtyRaw.includes(" ")) {
    qty = qtyRaw.split(" ").reduce((a, tok) => {
      if (tok.includes("/")) { const [x, y] = tok.split("/"); return a + (parseFloat(y) ? parseFloat(x) / parseFloat(y) : 0); }
      return a + (parseFloat(tok) || 0);
    }, 0);
    qty = Math.round(qty * 1000) / 1000;
  } else qty = parseFloat(qtyRaw);
  const rest = m[2].trim();
  const parts = rest.split(/\s+/);
  let unit, name;
  if (parts[0] && UNITS.includes(parts[0].toLowerCase())) {
    unit = parts[0].toLowerCase();
    name = parts.slice(1).join(" ").trim() || unit;
  } else { unit = "pcs"; name = rest; }
  return { name: name || rest || line, qty, unit };
}
function pageUrl(u) {
  if (!u) return "";
  return u.startsWith("http") ? u : "https://cookpad.com" + u;
}
function ytSearch(name) {
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent("resep " + name);
}
// ID stabil dari nomor resep Cookpad (tetap sama antar-build, jadi badge
// "tersimpan" di koleksi user tidak rusak walau data di-rebuild).
function stableId(url, fallbackIndex) {
  const m = (url || "").match(/\/resep\/(\d+)/);
  return m ? "ck-" + m[1] : "id-" + fallbackIndex;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, ...opts });
      if (r.ok) return await r.text();
      if (r.status === 404) return null; // halaman hilang, jangan retry
    } catch (e) { /* retry */ }
    await sleep(800 * (i + 1));
  }
  return null;
}
async function scrapeImage(url) {
  const html = await fetchText(url);
  if (!html) return "";
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1] : "";
}

/* ---------- Cache gambar (anti-duplikasi + resume) ---------- */
function loadImageCache() {
  const cache = new Map();
  // 1) dari cache khusus (hasil run sebelumnya yang mungkin terputus)
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const obj = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      for (const [k, v] of Object.entries(obj)) cache.set(k, v);
    } catch (e) { /* abaikan cache rusak */ }
  }
  // 2) seed dari bundle yang sudah ada (gambar lama dipakai ulang)
  if (fs.existsSync(OUT)) {
    try {
      const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
      for (const r of (old.recipes || [])) {
        if (r.source && r.image && !cache.has(r.source)) cache.set(r.source, r.image);
      }
    } catch (e) { /* abaikan */ }
  }
  return cache;
}
function saveImageCache(cache) {
  const obj = {};
  for (const [k, v] of cache) obj[k] = v;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
}

/* ---------- Main ---------- */
async function main() {
  const t0 = Date.now();
  process.stdout.write("Mengunduh dataset… ");
  const arr = JSON.parse(await fetchText(DATA_URL));
  console.log(arr.length + " resep mentah.");

  const imageCache = loadImageCache();
  console.log(`Cache gambar awal: ${imageCache.size} entri (dipakai ulang, tidak di-scrape lagi).`);

  // kelompokkan per kategori + filter halal
  const byCat = new Map();
  for (const row of arr) {
    const title = (row.Title || "").trim();
    const ing = row.Ingredients || "";
    const steps = row.Steps || "";
    const cat = (row.Category || "Lainnya").trim();
    if (!title || !ing) continue;
    if (!isHalal(title + " " + ing + " " + steps)) continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(row);
  }

  // pilih resep (semua, atau N teratas/kategori), hindari judul duplikat
  const chosen = [];
  const seen = new Set();
  for (const [cat, rows] of byCat) {
    rows.sort((a, b) => (parseInt(b.Loves) || 0) - (parseInt(a.Loves) || 0));
    let taken = 0;
    for (const row of rows) {
      const key = row.Title.trim().toLowerCase();
      if (seen.has(key)) continue;
      const ingredients = splitList(row.Ingredients).map(parseIngredient);
      if (!ingredients.length) continue;
      seen.add(key);
      chosen.push({ row, cat });
      taken++;
      if (PER_CATEGORY > 0 && taken >= PER_CATEGORY) break;
    }
    console.log(`  ${cat}: ${taken}/${rows.length} halal`);
  }

  const mode = SKIP_IMAGES ? "TANPA gambar" : `dengan gambar (jeda ${SCRAPE_DELAY}ms × ${CONCURRENCY} worker)`;
  console.log(`\nTotal terpilih: ${chosen.length}. Membangun ${mode}…`);

  const out = new Array(chosen.length);
  let idx = 0, done = 0, withImg = 0, fromCache = 0, fetched = 0, newSinceFlush = 0;

  async function worker() {
    while (idx < chosen.length) {
      const my = idx++;
      const { row, cat } = chosen[my];
      const url = pageUrl(row.URL);

      let image = "";
      if (!SKIP_IMAGES) {
        if (imageCache.has(url)) {
          image = imageCache.get(url);     // pakai ulang -> tidak fetch
          fromCache++;
        } else {
          image = await scrapeImage(url);  // baru -> fetch
          imageCache.set(url, image);
          fetched++;
          newSinceFlush++;
          await sleep(SCRAPE_DELAY);
          if (newSinceFlush >= FLUSH_EVERY) { saveImageCache(imageCache); newSinceFlush = 0; }
        }
      }
      if (image) withImg++;

      out[my] = {
        id: stableId(url, my + 1),
        name: row.Title.trim(),
        category: cat,
        area: "Indonesia",
        loves: parseInt(row.Loves) || 0,
        image,
        ingredients: splitList(row.Ingredients).map(parseIngredient),
        steps: splitSteps(row.Steps),
        youtube: ytSearch(row.Title.trim()),
        source: url,
      };
      done++;
      if (done % 25 === 0 || done === chosen.length) {
        const pct = ((done / chosen.length) * 100).toFixed(1);
        process.stdout.write(`\r  ${done}/${chosen.length} (${pct}%) · cache:${fromCache} fetch:${fetched} gambar:${withImg}     `);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (!SKIP_IMAGES) saveImageCache(imageCache);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: out.length, recipes: out }));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n\nSelesai dalam ${mins} menit.`);
  console.log(`  Resep: ${out.length} · dengan gambar: ${withImg} · dari cache: ${fromCache} · scrape baru: ${fetched}`);
  console.log(`  Ditulis: ${OUT} (${mb} MB)`);
}

main().catch((e) => { console.error("\nGAGAL:", e); process.exit(1); });
