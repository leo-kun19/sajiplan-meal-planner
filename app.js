/* ============================================================
   SajiPlan — perencana makan & daftar belanja (PWA, vanilla)
   ============================================================ */
(function () {
  "use strict";

  const DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
  const MEALS = [
    { key: "breakfast", label: "Pagi" },
    { key: "lunch", label: "Siang" },
    { key: "dinner", label: "Malam" },
  ];
  const STORE_KEY = "sajiplan_state_v3";
  const STORE_KEY_OLD = "sajiplan_state_v2";

  // Lokal Indonesia untuk rencana berbasis tanggal nyata.
  const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

  let weekOffset = 0; // 0 = minggu ini, -1 minggu lalu, +1 minggu depan

  // Senin sebagai awal minggu (kebiasaan kalender Indonesia).
  function startOfWeek(offset) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const wd = (d.getDay() + 6) % 7; // 0 = Senin
    d.setDate(d.getDate() - wd + offset * 7);
    return d;
  }
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function weekDates(offset) {
    const s = startOfWeek(offset);
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(s); x.setDate(s.getDate() + i); return x; });
  }
  function isToday(d) { return ymd(d) === ymd(new Date()); }

  let state = loadState();
  let pickerTarget = null;
  let discoverCache = []; // hasil jelajah terakhir (untuk import cepat)

  /* ---------- Persistence ---------- */
  function defaultState() { return { recipes: [], plan: {}, checked: {} }; }

  function loadState() {
    // Coba v3 dulu.
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { console.warn("State v3 rusak:", e); }

    // Migrasi dari v2 (plan berbasis nama hari + slot = id string).
    try {
      const old = localStorage.getItem(STORE_KEY_OLD);
      if (old) {
        const o = JSON.parse(old);
        const migrated = migrateV2(o);
        localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch (e) { console.warn("Migrasi v2 gagal:", e); }

    return defaultState();
  }

  // v2: plan[NamaHari][meal] = recipeId  ->  v3: plan[tanggalISO][meal] = {id, servings}
  // Rencana v2 dipetakan ke minggu ini (offset 0) berdasarkan urutan hari.
  function migrateV2(o) {
    const st = Object.assign(defaultState(), { recipes: o.recipes || [], checked: o.checked || {} });
    const dates = weekDates(0);
    if (o.plan) {
      DAYS.forEach((dayName, i) => {
        const dp = o.plan[dayName];
        if (!dp) return;
        const key = ymd(dates[i]);
        st.plan[key] = {};
        Object.keys(dp).forEach((meal) => {
          const rid = dp[meal];
          if (rid) st.plan[key][meal] = { id: rid, servings: 0 }; // 0 = pakai porsi resep
        });
      });
    }
    return st;
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      // Kuota penuh: beri tahu jelas, jangan gagal diam-diam (point 4).
      const quota = e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014);
      toast(quota ? "Penyimpanan penuh. Hapus beberapa resep tersimpan atau ekspor data." : "Gagal menyimpan data.");
      return false;
    }
  }

  // Perkiraan pemakaian localStorage untuk peringatan dini (point 4).
  function storageUsage() {
    try {
      const bytes = (localStorage.getItem(STORE_KEY) || "").length;
      return bytes; // ~1 char = 1 byte untuk JSON ASCII; cukup untuk estimasi
    } catch (e) { return 0; }
  }
  const STORAGE_WARN = 4 * 1024 * 1024; // ~4MB, ambang peringatan sebelum limit ~5MB

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- DOM helpers ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    (kids || []).forEach((c) => { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }

  function checkSVG() {
    return el("span", { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' }).firstChild;
  }

  const getRecipe = (id) => state.recipes.find((r) => r.id === id) || null;
  function trimNum(n) { const x = Number(n); return isFinite(x) ? parseFloat(x.toFixed(2)).toString() : n; }

  // Pecah instruksi (teks panjang) menjadi langkah-langkah.
  function splitSteps(text) {
    if (!text) return [];
    let raw = text.replace(/\r/g, "\n");
    // TheMealDB sering memakai "STEP 1", penomoran "1.", atau baris baru.
    let parts;
    if (/step\s*\d+/i.test(raw)) {
      parts = raw.split(/step\s*\d+[:.)]?/i);
    } else if (/\n\s*\d+[.)]\s/.test(raw)) {
      parts = raw.split(/\n\s*\d+[.)]\s/);
    } else if (raw.indexOf("\n") > -1) {
      parts = raw.split(/\n+/);
    } else {
      parts = raw.split(/(?<=[.!?])\s+(?=[A-Z])/);
    }
    return parts.map((p) => p.trim()).filter((p) => p.length > 1);
  }

  /* ============================================================
     RENCANA (berbasis tanggal nyata, lokal Indonesia)
     ============================================================ */
  function renderPlan() {
    const dates = weekDates(weekOffset);
    renderWeekHeader(dates);

    const grid = $("#planGrid");
    grid.innerHTML = "";
    dates.forEach((date) => {
      const key = ymd(date);
      const dayName = DAYS[(date.getDay() + 6) % 7];
      const slots = MEALS.map((m) => {
        const slot = state.plan[key] && state.plan[key][m.key];
        const r = slot ? getRecipe(slot.id) : null;
        const fill = r
          ? el("div", { class: "slot__fill" }, [
              r.image ? el("img", { class: "slot__thumb", src: r.image, alt: "", loading: "lazy" }) : null,
              el("button", {
                class: "slot__name slot__name--link",
                title: "Lihat detail",
                onclick: () => openDetail(r.id),
              }, [r.name + (slot.servings ? " · " + slot.servings + " porsi" : "")]),
              el("button", { class: "slot__clear", "aria-label": "Hapus " + r.name, onclick: () => setSlot(key, m.key, null) }, ["×"]),
            ])
          : el("div", { class: "slot__fill" }, [
              el("button", { class: "slot__add", onclick: () => openPicker(key, m.key) }, ["+ pilih resep"]),
            ]);
        return el("div", { class: "slot" }, [el("span", { class: "slot__meal" }, [m.label]), fill]);
      });

      grid.appendChild(el("div", { class: "day" + (isToday(date) ? " day--today" : "") }, [
        el("div", { class: "day__label" }, [
          el("div", { class: "day__idx" }, [String(date.getDate()).padStart(2, "0") + " " + MONTHS_ID[date.getMonth()].slice(0, 3)]),
          el("div", { class: "day__name" }, [dayName]),
          isToday(date) ? el("div", { class: "day__today" }, ["Hari ini"]) : null,
        ]),
        ...slots,
      ]));
    });
  }

  function renderWeekHeader(dates) {
    const head = $("#weekHead");
    if (!head) return;
    const first = dates[0], last = dates[6];
    let label;
    if (first.getMonth() === last.getMonth()) {
      label = first.getDate() + "–" + last.getDate() + " " + MONTHS_ID[first.getMonth()] + " " + first.getFullYear();
    } else {
      label = first.getDate() + " " + MONTHS_ID[first.getMonth()].slice(0, 3) + " – " + last.getDate() + " " + MONTHS_ID[last.getMonth()].slice(0, 3) + " " + last.getFullYear();
    }
    const rel = weekOffset === 0 ? "Minggu ini" : weekOffset === -1 ? "Minggu lalu" : weekOffset === 1 ? "Minggu depan" : (weekOffset < 0 ? Math.abs(weekOffset) + " minggu lalu" : weekOffset + " minggu lagi");
    head.innerHTML = "";
    head.append(
      el("button", { class: "week-nav__btn", "aria-label": "Minggu sebelumnya", onclick: () => { weekOffset--; renderPlan(); renderShopping(); } }, ["‹"]),
      el("div", { class: "week-nav__label" }, [
        el("div", { class: "week-nav__range" }, [label]),
        el("div", { class: "week-nav__rel" }, [rel]),
      ]),
      el("button", { class: "week-nav__btn", "aria-label": "Minggu berikutnya", onclick: () => { weekOffset++; renderPlan(); renderShopping(); } }, ["›"]),
    );
    const todayBtn = $("#weekTodayBtn");
    if (todayBtn) todayBtn.hidden = weekOffset === 0;
  }

  function setSlot(dateKey, meal, rid, servings) {
    if (!state.plan[dateKey]) state.plan[dateKey] = {};
    if (rid) state.plan[dateKey][meal] = { id: rid, servings: servings || 0 };
    else {
      delete state.plan[dateKey][meal];
      if (!Object.keys(state.plan[dateKey]).length) delete state.plan[dateKey]; // bersihkan hari kosong
    }
    saveState();
    renderPlan();
    renderShopping();
  }

  /* ============================================================
     KOLEKSI RESEP
     ============================================================ */
  function renderRecipes() {
    const list = $("#recipeList");
    list.innerHTML = "";
    $("#recipeEmpty").hidden = state.recipes.length > 0;
    list.hidden = state.recipes.length === 0;

    state.recipes.forEach((r) => {
      const ings = r.ingredients || [];
      const shown = ings.slice(0, 4).map((ing) => el("li", { class: "tag" }, [ing.name]));
      if (ings.length > 4) shown.push(el("li", { class: "tag tag--more" }, ["+" + (ings.length - 4)]));

      const hasSteps = !!(r.instructions && r.instructions.trim());

      list.appendChild(el("article", { class: "r-card" }, [
        el("div", {
          class: "r-card__open",
          role: "button",
          tabindex: "0",
          "aria-label": "Lihat detail " + r.name,
          onclick: () => openDetail(r.id),
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(r.id); } },
        }, [
          r.image ? el("div", { class: "r-card__media" }, [el("img", { src: r.image, alt: r.name, loading: "lazy" })]) : null,
          el("h3", { class: "r-card__name" }, [r.name]),
          el("div", { class: "r-card__meta" }, [r.servings + " porsi · " + ings.length + " bahan" + (r.area ? " · " + r.area : "")]),
          ings.length ? el("ul", { class: "r-card__ings" }, shown) : null,
          hasSteps ? el("span", { class: "r-card__steps" }, ["Lihat cara masak →"]) : null,
        ]),
        el("div", { class: "r-card__acts" }, [
          el("button", { class: "icon-btn", "aria-label": "Edit " + r.name, onclick: () => openRecipeModal(r.id), html: iconEdit() }),
          el("button", { class: "icon-btn", "aria-label": "Hapus " + r.name, onclick: () => deleteRecipe(r.id), html: iconTrash() }),
        ]),
      ]));
    });
  }

  const iconEdit = () => '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const iconTrash = () => '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function deleteRecipe(id) {
    if (!confirm("Hapus resep ini? Resep juga dilepas dari rencana.")) return;
    state.recipes = state.recipes.filter((r) => r.id !== id);
    Object.keys(state.plan).forEach((dateKey) => {
      MEALS.forEach((m) => {
        const slot = state.plan[dateKey][m.key];
        if (slot && slot.id === id) delete state.plan[dateKey][m.key];
      });
      if (!Object.keys(state.plan[dateKey]).length) delete state.plan[dateKey];
    });
    saveState();
    renderRecipes(); renderPlan(); renderShopping();
    toast("Resep dihapus.");
  }

  /* ---------- Detail resep + cara masak ----------
     Bisa dipanggil dengan id (resep di koleksi) ATAU objek resep langsung
     (hasil Jelajah yang belum disimpan). */
  function openDetail(idOrRecipe) {
    const r = typeof idOrRecipe === "string" ? getRecipe(idOrRecipe) : idOrRecipe;
    if (!r) return;
    const fromDiscover = typeof idOrRecipe !== "string";
    const ings = r.ingredients || [];
    const steps = splitSteps(Array.isArray(r.steps) ? r.steps.join("\n") : r.instructions);
    const alreadySaved = fromDiscover && state.recipes.some((x) => x.sourceId === r.id);
    const baseServ = r.servings || 0;
    let curServ = baseServ || 2; // porsi yang sedang ditampilkan (bisa diubah)

    // Render daftar bahan dengan skala porsi.
    function ingList() {
      const factor = baseServ ? (curServ / baseServ) : 1;
      return el("ul", { class: "detail__ings" }, ings.map((ing) => el("li", {}, [
        el("span", {}, [ing.name]),
        el("span", { class: "detail__qty" }, [
          (ing.qty && ing.unit !== "secukupnya") ? trimNum((Number(ing.qty) || 0) * factor) + " " + ing.unit : "secukupnya",
        ]),
      ])));
    }

    // Stepper porsi (hanya berguna bila resep punya porsi dasar & ada bahan terukur).
    const ingWrap = el("div", {}, [ingList()]);
    function setServ(v) {
      curServ = Math.max(1, Math.min(99, v));
      stepLabel.textContent = curServ + " porsi";
      ingWrap.innerHTML = "";
      ingWrap.appendChild(ingList());
    }
    const stepLabel = el("span", { class: "stepper__val" }, [curServ + " porsi"]);
    const stepper = baseServ ? el("div", { class: "stepper" }, [
      el("span", { class: "stepper__lbl" }, ["Skala porsi"]),
      el("div", { class: "stepper__ctrl" }, [
        el("button", { class: "stepper__btn", type: "button", "aria-label": "Kurangi porsi", onclick: () => setServ(curServ - 1) }, ["−"]),
        stepLabel,
        el("button", { class: "stepper__btn", type: "button", "aria-label": "Tambah porsi", onclick: () => setServ(curServ + 1) }, ["+"]),
      ]),
    ]) : null;

    const body = el("div", { class: "detail" }, [
      r.image ? el("div", { class: "detail__hero" }, [el("img", { src: r.image, alt: r.name })]) : null,
      el("div", { class: "detail__meta" }, [
        r.category ? el("span", { class: "pill" }, [r.category]) : null,
        r.area ? el("span", { class: "pill" }, [r.area]) : null,
        baseServ ? el("span", { class: "pill" }, ["asli " + baseServ + " porsi"]) : null,
      ]),

      fromDiscover ? el("button", {
        class: "solid-btn detail__save" + (alreadySaved ? " is-saved" : ""),
        type: "button",
        onclick: (e) => importMeal(r, e.currentTarget),
      }, [alreadySaved ? "✓ Sudah di koleksi" : "+ Simpan ke koleksi"]) : null,

      el("h4", { class: "detail__h" }, ["Bahan"]),
      stepper,
      ings.length ? ingWrap : el("p", { class: "detail__empty" }, ["Belum ada bahan."]),

      el("h4", { class: "detail__h" }, ["Cara Masak"]),
      steps.length
        ? el("ol", { class: "detail__steps" }, steps.map((s) => el("li", {}, [s])))
        : el("p", { class: "detail__empty" }, ["Resep ini belum punya langkah memasak. Tambahkan lewat tombol Edit, atau impor dari tab Jelajah untuk dapat langkah otomatis."]),

      (r.youtube || r.source) ? el("div", { class: "detail__links" }, [
        r.youtube ? el("a", { class: "solid-btn solid-btn--sm", href: r.youtube, target: "_blank", rel: "noopener", onclick: () => hideModal("#detailModal") }, [
          el("span", { html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5A2.7 2.7 0 0 0 2.4 7.2 28 28 0 0 0 2 12a28 28 0 0 0 .4 4.8 2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 22 12a28 28 0 0 0-.4-4.8zM10 15V9l5 3z" fill="currentColor"/></svg>' }).firstChild,
          "Cari video di YouTube",
        ]) : null,
        r.source ? el("a", { class: "ghost-btn ghost-btn--sm", href: r.source, target: "_blank", rel: "noopener", onclick: () => hideModal("#detailModal") }, ["Sumber resep ↗"]) : null,
      ]) : null,
    ]);

    $("#detailTitle").textContent = r.name;
    const c = $("#detailBody");
    c.innerHTML = "";
    c.appendChild(body);
    showModal("#detailModal");
  }

  /* ---------- Modal resep ---------- */
  function ingRow(ing) {
    ing = ing || { name: "", qty: "", unit: "" };
    return el("div", { class: "ing-row" }, [
      el("input", { type: "text", placeholder: "Nama bahan", value: ing.name, "data-f": "name", "aria-label": "Nama bahan" }),
      el("input", { type: "text", placeholder: "jml + satuan", value: ing.qty ? trimNum(ing.qty) + (ing.unit && ing.unit !== "secukupnya" ? " " + ing.unit : "") : (ing.unit && ing.unit !== "secukupnya" ? ing.unit : ""), "data-f": "measure", "aria-label": "Takaran" }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Hapus bahan", onclick: (e) => e.target.closest(".ing-row").remove(), html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' }),
    ]);
  }

  function openRecipeModal(id) {
    const r = id ? getRecipe(id) : null;
    $("#modalTitle").textContent = r ? "Edit Resep" : "Resep Baru";
    $("#recipeId").value = r ? r.id : "";
    $("#recipeImage").value = r && r.image ? r.image : "";
    $("#recipeMeta").value = r ? JSON.stringify({ area: r.area || "", category: r.category || "" }) : "";
    $("#recipeName").value = r ? r.name : "";
    $("#recipeServings").value = r ? r.servings : 2;
    $("#importBanner").hidden = true;

    const rows = $("#ingredientRows");
    rows.innerHTML = "";
    const ings = (r && r.ingredients && r.ingredients.length) ? r.ingredients : [null, null, null];
    ings.forEach((ing) => rows.appendChild(ingRow(ing)));

    showModal("#recipeModal");
    setTimeout(() => $("#recipeName").focus(), 60);
  }

  // Parse "2 tbsp" / "200 g" / "secukupnya" dari satu input bebas.
  function parseMeasureField(raw) {
    raw = (raw || "").trim();
    if (!raw) return { qty: 0, unit: "secukupnya" };
    const m = raw.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*(.*)$/);
    if (!m) return { qty: 0, unit: raw };
    let qty = m[1];
    if (qty.indexOf("/") > -1 || qty.indexOf(" ") > -1) {
      qty = qty.split(" ").reduce((acc, p) => {
        if (p.indexOf("/") > -1) { const f = p.split("/"); return acc + (parseFloat(f[0]) / parseFloat(f[1])); }
        return acc + parseFloat(p);
      }, 0);
    } else qty = parseFloat(qty);
    const unit = (m[2] || "").trim() || "pcs";
    return { qty: qty, unit: unit };
  }

  function readRecipeForm() {
    const ingredients = $$("#ingredientRows .ing-row").map((row) => {
      const name = $('[data-f="name"]', row).value.trim();
      const parsed = parseMeasureField($('[data-f="measure"]', row).value);
      return { name: name, qty: parsed.qty, unit: parsed.unit };
    }).filter((i) => i.name);

    let meta = {};
    try { meta = JSON.parse($("#recipeMeta").value || "{}"); } catch (e) {}

    return {
      id: $("#recipeId").value || uid(),
      name: $("#recipeName").value.trim(),
      servings: Math.max(1, parseInt($("#recipeServings").value, 10) || 1),
      image: $("#recipeImage").value || "",
      area: meta.area || "",
      category: meta.category || "",
      ingredients: ingredients,
    };
  }

  function submitRecipe(e) {
    e.preventDefault();
    const data = readRecipeForm();
    if (!data.name) return toast("Nama resep wajib diisi.");
    if (!data.ingredients.length) return toast("Tambahkan minimal satu bahan.");
    const idx = state.recipes.findIndex((r) => r.id === data.id);
    if (idx >= 0) state.recipes[idx] = data; else state.recipes.push(data);
    saveState();
    renderRecipes(); renderPlan(); renderShopping();
    hideModal("#recipeModal");
    toast(idx >= 0 ? "Resep diperbarui." : "Resep disimpan.");
  }

  /* ---------- Picker ---------- */
  function openPicker(dateKey, meal) {
    pickerTarget = { dateKey, meal };
    const label = (MEALS.find((m) => m.key === meal) || {}).label || "";
    const d = new Date(dateKey + "T00:00:00");
    const dayName = DAYS[(d.getDay() + 6) % 7];
    const dateLabel = dayName + ", " + d.getDate() + " " + MONTHS_ID[d.getMonth()];
    $("#pickerTitle").textContent = label + " · " + dateLabel;
    const list = $("#pickerList");
    list.innerHTML = "";
    $("#pickerEmpty").hidden = state.recipes.length > 0;
    list.hidden = state.recipes.length === 0;

    state.recipes.forEach((r) => {
      list.appendChild(el("button", {
        class: "picker-item", type: "button",
        onclick: () => { setSlot(pickerTarget.dateKey, pickerTarget.meal, r.id, r.servings || 0); hideModal("#pickerModal"); toast('"' + r.name + '" ditambahkan.'); },
      }, [
        r.image ? el("img", { src: r.image, alt: "", loading: "lazy" }) : null,
        el("div", {}, [
          el("div", { class: "picker-item__name" }, [r.name]),
          el("div", { class: "picker-item__meta" }, [(r.servings || "?") + " porsi · " + (r.ingredients || []).length + " bahan"]),
        ]),
      ]));
    });
    showModal("#pickerModal");
  }

  /* ============================================================
     JELAJAH (API)
     ============================================================ */
  let catsLoaded = false;

  async function loadCategories() {
    if (catsLoaded) return;
    try {
      const cats = await MealAPI.categories();
      const box = $("#catChips");
      box.innerHTML = "";
      cats.forEach((c) => {
        box.appendChild(el("button", { class: "chip", type: "button", "data-cat": c, onclick: () => selectCategory(c) }, [c]));
      });
      catsLoaded = true;
    } catch (e) { /* diam; pencarian tetap bisa */ }
  }

  function setStatus(node) {
    const s = $("#discoverStatus");
    s.innerHTML = "";
    if (node) {
      s.hidden = false;
      s.appendChild(node);
      const foot = $("#discoverFoot");
      if (foot) foot.hidden = true; // sembunyikan footer saat loading/empty
    } else {
      s.hidden = true;
    }
  }
  function loadingStatus(text) {
    return el("div", {}, [el("div", { class: "spinner" }), el("div", {}, [text])]);
  }

  async function selectCategory(cat) {
    $$("#catChips .chip").forEach((c) => c.classList.toggle("is-active", c.dataset.cat === cat));
    $("#searchInput").value = "";
    setStatus(loadingStatus("Memuat kategori " + cat + "…"));
    $("#discoverList").innerHTML = "";
    try {
      const meals = await MealAPI.byCategory(cat);
      renderDiscover(meals);
    } catch (e) { setStatus(el("div", {}, ["Gagal memuat. Periksa koneksi."])); }
  }

  async function doSearch(q) {
    $$("#catChips .chip").forEach((c) => c.classList.remove("is-active"));
    setStatus(loadingStatus(q ? 'Mencari "' + q + '"…' : "Memuat resep populer…"));
    $("#discoverList").innerHTML = "";
    try {
      const meals = await MealAPI.search(q);
      if (!meals.length) { setStatus(el("div", {}, ['Tidak ada hasil untuk "' + q + '". Coba kata lain seperti "ayam", "tempe", atau "udang".'])); return; }
      renderDiscover(meals);
    } catch (e) { setStatus(el("div", {}, ["Gagal memuat resep. Coba muat ulang halaman."])); }
  }

  async function doRandom() {
    setStatus(loadingStatus("Mengambil resep acak…"));
    $("#discoverList").innerHTML = "";
    $$("#catChips .chip").forEach((c) => c.classList.remove("is-active"));
    try {
      const meals = await MealAPI.random();
      renderDiscover(Array.isArray(meals) ? meals : (meals ? [meals] : []));
    } catch (e) { setStatus(el("div", {}, ["Gagal memuat resep acak."])); }
  }

  /* ---------- Infinite scroll ---------- */
  const DISCOVER_BATCH = 24;
  let discoverItems = [];
  let discoverShown = 0;
  let discoverObserver = null;

  function discoverCard(meal, i) {
    const saved = state.recipes.some((r) => r.sourceId && r.sourceId === meal.id);
    return el("article", { class: "d-card", style: "animation-delay:" + Math.min((i % DISCOVER_BATCH) * 35, 350) + "ms" }, [
      el("div", {
        class: "d-card__open",
        role: "button",
        tabindex: "0",
        "aria-label": "Lihat detail " + meal.name,
        onclick: () => openDetail(meal),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(meal); } },
      }, [
        el("div", { class: "d-card__media" }, [
          el("img", { src: meal.image, alt: meal.name, loading: "lazy" }),
          meal.category ? el("span", { class: "d-card__cat" }, [meal.category]) : null,
        ]),
        el("div", { class: "d-card__body" }, [
          el("h3", { class: "d-card__name" }, [meal.name]),
          el("div", { class: "d-card__area" }, [(meal.ingredients ? meal.ingredients.length + " bahan" : meal.area) + " · lihat resep"]),
        ]),
      ]),
      el("button", {
        class: "solid-btn solid-btn--sm d-card__add" + (saved ? " is-saved" : ""),
        type: "button",
        onclick: (e) => importMeal(meal, e.currentTarget),
      }, [saved ? "✓ Tersimpan" : "+ Simpan ke koleksi"]),
    ]);
  }

  function appendBatch() {
    const list = $("#discoverList");
    const end = Math.min(discoverShown + DISCOVER_BATCH, discoverItems.length);
    const frag = document.createDocumentFragment();
    for (let i = discoverShown; i < end; i++) frag.appendChild(discoverCard(discoverItems[i], i));
    list.appendChild(frag);
    discoverShown = end;
    updateDiscoverFoot();
  }

  function updateDiscoverFoot() {
    const foot = $("#discoverFoot");
    const remaining = discoverItems.length - discoverShown;
    if (remaining > 0) {
      foot.hidden = false;
      foot.innerHTML = "";
      foot.appendChild(el("div", { class: "spinner spinner--sm" }));
      foot.appendChild(el("span", {}, ["Memuat lagi… (" + discoverShown + "/" + discoverItems.length + ")"]));
    } else if (discoverItems.length) {
      foot.hidden = false;
      foot.innerHTML = "";
      foot.appendChild(el("span", { class: "discover-foot__end" }, [discoverItems.length + " resep · sudah semua"]));
    } else {
      foot.hidden = true;
    }
  }

  function renderDiscover(meals) {
    setStatus(null);
    discoverCache = meals;
    discoverItems = meals;
    discoverShown = 0;
    const list = $("#discoverList");
    list.innerHTML = "";
    appendBatch();

    // Observer pada sentinel: tambah batch saat mendekati bawah.
    if (discoverObserver) discoverObserver.disconnect();
    const sentinel = $("#discoverSentinel");
    discoverObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && discoverShown < discoverItems.length) appendBatch();
    }, { rootMargin: "600px 0px" });
    discoverObserver.observe(sentinel);
  }

  async function importMeal(meal, btn) {
    // Sudah ada? jangan dobel.
    if (state.recipes.some((r) => r.sourceId === meal.id)) { toast("Sudah ada di koleksi."); return; }
    let full = meal;
    // hasil "byCategory" tidak punya ingredients -> ambil detail
    if (!meal.ingredients) {
      if (btn) { btn.disabled = true; btn.textContent = "Memuat…"; }
      try { full = await MealAPI.detail(meal.id); }
      catch (e) { toast("Gagal mengambil detail."); if (btn) { btn.disabled = false; btn.textContent = "+ Simpan ke koleksi"; } return; }
    }
    const recipe = {
      id: uid(),
      sourceId: full.id,
      name: full.name,
      servings: 2,
      image: full.image,
      area: full.area || "",
      category: full.category || "",
      instructions: Array.isArray(full.steps) ? full.steps.join("\n") : (full.instructions || ""),
      youtube: full.youtube || "",
      source: full.source || "",
      ingredients: full.ingredients || [],
    };
    state.recipes.push(recipe);
    const ok = saveState();
    renderRecipes();
    if (btn) {
      btn.classList.add("is-saved");
      btn.disabled = false;
      // Teks menyesuaikan konteks: tombol lebar di detail vs tombol kartu.
      btn.textContent = btn.classList.contains("detail__save") ? "✓ Sudah di koleksi" : "✓ Tersimpan";
    }
    if (ok) {
      toast('"' + recipe.name + '" disimpan ke koleksi.');
      // Peringatan dini bila penyimpanan mendekati batas (point 4).
      if (storageUsage() > STORAGE_WARN) {
        setTimeout(() => toast("Penyimpanan hampir penuh. Pertimbangkan ekspor data sebagai cadangan."), 2600);
      }
    }
  }

  /* ============================================================
     BELANJA
     ============================================================ */
  // Normalisasi satuan agar bahan yang sama dengan ejaan/satuan berbeda
  // (mis. "gr" vs "gram" vs "g", atau "200 g" + "0.3 kg") bisa dijumlahkan.
  const WEIGHT = { g: 1, gr: 1, gram: 1, grm: 1, kg: 1000, kilo: 1000, kilogram: 1000, ons: 100, hg: 100 };
  const VOLUME = { ml: 1, cc: 1, mililiter: 1, l: 1000, ltr: 1000, liter: 1000, litre: 1000 };

  function unitFamily(unit) {
    const u = (unit || "").toLowerCase().trim();
    if (WEIGHT[u] != null) return "weight";
    if (VOLUME[u] != null) return "volume";
    return null;
  }
  function toBase(qty, unit) {
    const u = (unit || "").toLowerCase().trim();
    if (WEIGHT[u] != null) return qty * WEIGHT[u]; // -> gram
    if (VOLUME[u] != null) return qty * VOLUME[u]; // -> ml
    return qty;
  }
  // Tampilkan dalam satuan yang enak dibaca: gram naik ke kg di >= 1000, dst.
  function fromBase(base, family) {
    if (family === "weight") return base >= 1000 ? { qty: base / 1000, unit: "kg" } : { qty: base, unit: "gram" };
    if (family === "volume") return base >= 1000 ? { qty: base / 1000, unit: "liter" } : { qty: base, unit: "ml" };
    return { qty: base, unit: "" };
  }

  function buildList() {
    const map = new Map();
    Object.keys(state.plan).forEach((dateKey) => {
      const dp = state.plan[dateKey];
      Object.keys(dp).forEach((meal) => {
        const slot = dp[meal];
        const r = getRecipe(slot.id);
        if (!r) return;
        // Faktor skala porsi: porsi yang direncanakan / porsi asli resep (point 1).
        const planned = slot.servings || r.servings || 0;
        const baseServ = r.servings || 0;
        const factor = (planned && baseServ) ? (planned / baseServ) : 1;
        (r.ingredients || []).forEach((ing) => {
          const name = ing.name.trim();
          const fam = ing.unit === "secukupnya" ? null : unitFamily(ing.unit);
          const groupUnit = fam || (ing.unit || "");
          const key = name.toLowerCase() + "|" + (fam ? fam : groupUnit);
          if (!map.has(key)) map.set(key, { name: name, family: fam, unit: ing.unit || "", base: 0, hasQty: false, from: new Set() });
          const e = map.get(key);
          e.from.add(r.name);
          if (ing.qty && ing.unit !== "secukupnya") {
            e.base += toBase((Number(ing.qty) || 0) * factor, ing.unit);
            e.hasQty = true;
          }
        });
      });
    });

    // Susun bentuk akhir tiap item (qty + unit tampilan).
    return Array.from(map.values()).map((e) => {
      let qty, unit;
      if (e.family) { const f = fromBase(e.base, e.family); qty = f.qty; unit = f.unit; }
      else { qty = e.base; unit = e.unit; }
      return { name: e.name, qty: qty, unit: unit, hasQty: e.hasQty, from: e.from };
    }).sort((a, b) => a.name.localeCompare(b.name, "id"));
  }
  const shopKey = (it) => it.name.toLowerCase() + "|" + it.unit;

  function renderShopping() {
    const list = $("#shoppingList");
    const items = buildList();
    list.innerHTML = "";
    $("#shoppingEmpty").hidden = items.length > 0;

    const meta = $("#shopMeta");
    if (items.length) {
      const done = items.filter((it) => state.checked[shopKey(it)]).length;
      meta.hidden = false;
      meta.innerHTML = "";
      meta.append(
        el("div", { class: "shop-meta__stat" }, [el("span", { class: "shop-meta__num" }, [String(items.length)]), el("span", { class: "shop-meta__lbl" }, ["Bahan"])]),
        el("div", { class: "shop-meta__stat" }, [el("span", { class: "shop-meta__num" }, [done + "/" + items.length]), el("span", { class: "shop-meta__lbl" }, ["Sudah dibeli"])]),
      );
    } else { meta.hidden = true; }

    items.forEach((it) => {
      const key = shopKey(it);
      const done = !!state.checked[key];
      const qtyTxt = (it.hasQty && it.unit !== "secukupnya") ? trimNum(it.qty) + " " + it.unit : "secukupnya";
      const fromList = Array.from(it.from);
      const fromTxt = fromList.length > 2 ? fromList.slice(0, 2).join(", ") + " +" + (fromList.length - 2) : fromList.join(", ");

      const box = el("span", { class: "shop-item__box" }, [checkSVG()]);
      const li = el("li", { class: "shop-item" + (done ? " is-done" : "") }, [
        box,
        el("div", { class: "shop-item__txt" }, [
          el("div", { class: "shop-item__name" }, [it.name]),
          el("div", { class: "shop-item__qty" }, [qtyTxt]),
        ]),
        el("div", { class: "shop-item__from" }, [fromTxt]),
      ]);
      li.addEventListener("click", () => { state.checked[key] = !state.checked[key]; saveState(); renderShopping(); });
      list.appendChild(li);
    });
  }

  function clearChecks() { state.checked = {}; saveState(); renderShopping(); toast("Centang direset."); }

  /* ============================================================
     UI plumbing
     ============================================================ */
  function showModal(s) {
    // Pastikan hanya SATU modal terbuka pada satu waktu (cegah modal bertumpuk).
    $$(".modal").forEach((m) => { if ("#" + m.id !== s) m.hidden = true; });
    $(s).hidden = false;
    syncScrollLock();
  }
  function hideModal(s) {
    $(s).hidden = true;
    syncScrollLock();
  }
  // Kunci scroll body HANYA jika benar-benar ada modal terbuka.
  // Ini mencegah body "nyangkut" overflow:hidden (mis. setelah klik link
  // target=_blank dari dalam modal lalu kembali ke tab ini).
  function syncScrollLock() {
    const anyOpen = $$(".modal").some((m) => !m.hidden);
    document.body.style.overflow = anyOpen ? "hidden" : "";
  }

  function switchTab(tab) {
    $$(".dock__tab").forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("is-active", active);
      if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $$(".view").forEach((v) => (v.hidden = v.dataset.view !== tab));
    window.scrollTo({ top: 0 });
    if (tab === "discover") { loadCategories(); if (!discoverCache.length && !$("#discoverList").children.length) doSearch(""); }
  }

  function bind() {
    $$(".dock__tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("#addRecipeBtn").addEventListener("click", () => openRecipeModal(null));
    $("#addIngredientBtn").addEventListener("click", () => $("#ingredientRows").appendChild(ingRow()));
    $("#recipeForm").addEventListener("submit", submitRecipe);
    $("#clearChecksBtn").addEventListener("click", clearChecks);
    $("#randomBtn").addEventListener("click", doRandom);
    const todayBtn = $("#weekTodayBtn");
    if (todayBtn) todayBtn.addEventListener("click", () => { weekOffset = 0; renderPlan(); renderShopping(); });
    $("#searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("#searchInput").value.trim();
      if (q) doSearch(q);
    });
    $$("[data-close]").forEach((n) => n.addEventListener("click", () => { const m = n.closest(".modal"); if (m) hideModal("#" + m.id); }));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".modal").forEach((m) => hideModal("#" + m.id)); });

    // Pengaman: saat tab kembali terlihat/fokus, pastikan kunci scroll sesuai
    // kondisi modal (mencegah body "mentok" tak bisa di-scroll).
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncScrollLock(); });
    window.addEventListener("pageshow", syncScrollLock);
    window.addEventListener("focus", syncScrollLock);
  }

  function seedIfEmpty() {
    if (state.recipes.length) return;
    state.recipes = [
      { id: uid(), name: "Nasi Goreng Kampung", servings: 2, image: "", area: "Indonesia", category: "Telur",
        instructions: "Haluskan bawang putih dan cabai.\nPanaskan minyak, tumis bumbu hingga harum.\nMasukkan telur, orak-arik hingga matang.\nMasukkan nasi, aduk rata.\nTambahkan kecap manis dan garam, aduk hingga tercampur.\nSajikan selagi hangat.",
        ingredients: [
        { name: "Nasi putih", qty: 400, unit: "g" }, { name: "Telur", qty: 2, unit: "butir" },
        { name: "Bawang putih", qty: 3, unit: "siung" }, { name: "Kecap manis", qty: 2, unit: "sdm" },
        { name: "Garam", qty: 0, unit: "secukupnya" },
      ] },
      { id: uid(), name: "Sup Ayam Bening", servings: 4, image: "", area: "Indonesia", category: "Ayam",
        instructions: "Rebus air hingga mendidih.\nMasukkan ayam, masak hingga empuk.\nTambahkan bawang putih yang sudah digeprek.\nMasukkan wortel, masak hingga lunak.\nBumbui dengan garam secukupnya.\nSajikan hangat.",
        ingredients: [
        { name: "Ayam", qty: 500, unit: "g" }, { name: "Wortel", qty: 2, unit: "buah" },
        { name: "Bawang putih", qty: 2, unit: "siung" }, { name: "Air", qty: 1, unit: "liter" },
      ] },
    ];
    saveState();
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        // Jika ada SW baru menunggu, minta langsung aktif.
        function promote(worker) {
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage("SKIP_WAITING");
            }
          });
        }
        if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage("SKIP_WAITING");
        reg.addEventListener("updatefound", () => promote(reg.installing));
      }).catch((e) => console.warn("SW:", e));

      // Saat SW baru mengambil alih, muat ulang sekali agar memakai kode terbaru.
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    });
  }

  function installPrompt() {
    let deferred = null;
    const btn = $("#installBtn");
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
    btn.addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; btn.hidden = true; });
    window.addEventListener("appinstalled", () => (btn.hidden = true));
  }

  function init() {
    seedIfEmpty();
    bind();
    renderPlan();
    renderRecipes();
    renderShopping();
    installPrompt();
    registerSW();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
