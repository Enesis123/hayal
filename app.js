// Hayal — yazıdan resim. Cloudflare FLUX, Netlify Function üzerinden (anahtar orada gizli).

// Çizim adresi (Netlify Function); ?worker=... ile geçici olarak değiştirilebilir
const WORKER_URL = new URLSearchParams(location.search).get("worker") || "https://hayal-enes.netlify.app/api/draw";

const STYLES = [
  { name: "Serbest", text: "" },
  { name: "Gerçekçi", text: "photorealistic, detailed, natural lighting, 35mm photo" },
  { name: "Anime", text: "anime style, vibrant colors, clean lineart, studio quality" },
  { name: "Çizgi film", text: "cartoon illustration, bold outlines, flat colors, playful" },
  { name: "Yağlı boya", text: "oil painting, visible brush strokes, rich texture, classical" },
  { name: "Suluboya", text: "watercolor painting, soft washes, paper texture" },
  { name: "3B", text: "3d render, soft studio lighting, octane, high detail" },
  { name: "Piksel", text: "pixel art, 16-bit, crisp pixels, retro game" },
  { name: "Logo", text: "minimal flat vector logo, simple shapes, white background" },
];

// Bedeller sunucudakiyle aynı (1024×1024 resim başına nöron), kalan sayısını tahmin etmek için
const MODELS = [
  { key: "fast", name: "Hızlı", note: "FLUX.1 · ~5 sn", cost: 77 },
  { key: "good", name: "Kaliteli", note: "FLUX.2 klein", cost: 104 },
  { key: "master", name: "Usta", note: "FLUX.2 dev · yazı, detay", cost: 1200 },
];

const $ = (id) => document.getElementById(id);
const state = { style: 0, model: 0, count: 1, busy: false };

// ---- Kota tahmini: bu tarayıcının bugün harcadığı nöron (Cloudflare günü UTC'de döner) ----
const today = () => new Date().toISOString().slice(0, 10);
function loadUsage() {
  try {
    const u = JSON.parse(localStorage.getItem("hayal-usage") || "{}");
    return u.day === today() ? u : { day: today(), spent: 0, capacity: 10000 };
  } catch {
    return { day: today(), spent: 0, capacity: 10000 };
  }
}
function saveUsage(u) {
  try { localStorage.setItem("hayal-usage", JSON.stringify(u)); } catch { /* gizli pencere */ }
}
function addUsage(cost, capacity) {
  const u = loadUsage();
  u.spent += cost;
  if (capacity) u.capacity = capacity;
  saveUsage(u);
  renderQuota();
}
function markExhausted(capacity) {
  const u = loadUsage();
  if (capacity) u.capacity = capacity;
  u.spent = u.capacity;
  saveUsage(u);
  renderQuota();
}
function renderQuota() {
  const u = loadUsage();
  const left = Math.max(0, u.capacity - u.spent);
  const counts = MODELS.map((m) => `${m.name} ~${Math.floor(left / m.cost)}`).join(" · ");
  $("quota").textContent = left
    ? `Bugün kalan (tahmini): ${counts}`
    : "Bugünkü kota bitti, gece 03:00'te sıfırlanır.";
}

// ---- Galeri: resimler IndexedDB'de durur (localStorage'a sığmaz) ----
const db = new Promise((resolve, reject) => {
  const req = indexedDB.open("hayal", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("images", { keyPath: "id" });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(mode, fn) {
  const tx = (await db).transaction("images", mode);
  const result = await new Promise((resolve, reject) => {
    const req = fn(tx.objectStore("images"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return result;
}
const saveImage = (item) => store("readwrite", (s) => s.put(item));
const deleteImage = (id) => store("readwrite", (s) => s.delete(id));
const allImages = () => store("readonly", (s) => s.getAll());
const clearImages = () => store("readwrite", (s) => s.clear());

// ---- Çizim motorları ----
function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

async function draw(prompt, style, model) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, style, model: model.key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.quota) markExhausted(data.capacity);
    throw new Error(data.error || `Hata ${res.status}`);
  }
  addUsage(data.cost || model.cost, data.capacity);
  return { blob: base64ToBlob(data.image), engine: model.name, english: data.prompt };
}

// ---- Arayüz ----
function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}

function renderControls() {
  $("styles").innerHTML = "";
  STYLES.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = s.name;
    b.setAttribute("aria-pressed", i === state.style);
    b.onclick = () => { state.style = i; renderControls(); };
    $("styles").append(b);
  });
  $("models").innerHTML = "";
  MODELS.forEach((m, i) => {
    const b = document.createElement("button");
    b.className = "model";
    b.innerHTML = `<b>${m.name}</b><small>${m.note}</small>`;
    b.setAttribute("aria-pressed", i === state.model);
    b.onclick = () => { state.model = i; renderControls(); };
    $("models").append(b);
  });
  $("count").innerHTML = "";
  [1, 2, 3, 4].forEach((n) => {
    const b = document.createElement("button");
    b.textContent = n;
    b.setAttribute("aria-pressed", n === state.count);
    b.onclick = () => { state.count = n; renderControls(); };
    $("count").append(b);
  });
}

const urls = new Map(); // id → objectURL, her seferinde yeniden yaratmamak için
function urlFor(item) {
  if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.blob));
  return urls.get(item.id);
}

function fileName(item) {
  const slug = item.prompt.toLowerCase().replace(/[^a-z0-9çğıöşü]+/g, "-").slice(0, 40).replace(/^-|-$/g, "");
  return `hayal-${slug || "resim"}.jpg`;
}

async function shareImage(item) {
  const file = new File([item.blob], fileName(item), { type: item.blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* vazgeçildi */ }
  } else {
    downloadImage(item);
  }
}

function downloadImage(item) {
  const a = document.createElement("a");
  a.href = urlFor(item);
  a.download = fileName(item);
  a.click();
}

// Pano sadece PNG kabul ediyor, JPEG'i canvas'tan geçir
async function copyImage(item) {
  try {
    const bmp = await createImageBitmap(item.blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    setStatus("Panoya kopyalandı.");
  } catch {
    setStatus("Kopyalanamadı, İndir'i kullan.", true);
  }
}

function toolButton(label, title, onclick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title;
  b.onclick = onclick;
  return b;
}

function cardFor(item) {
  const card = document.createElement("div");
  card.className = "card";
  const pic = document.createElement("div");
  pic.className = "pic";
  const img = document.createElement("img");
  img.src = urlFor(item);
  img.alt = item.prompt;
  img.loading = "lazy";
  pic.append(img);
  pic.onclick = () => openViewer(urlFor(item));

  const meta = document.createElement("div");
  meta.className = "meta";
  const p = document.createElement("div");
  p.className = "prompt";
  p.textContent = item.prompt;
  p.title = item.english || item.prompt;
  const engine = document.createElement("div");
  engine.className = "engine";
  engine.textContent = `${item.engine}${item.styleName && item.styleName !== "Serbest" ? " · " + item.styleName : ""}`;

  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(
    toolButton("⤓", "İndir", () => downloadImage(item)),
    toolButton("↗", "Paylaş", () => shareImage(item)),
    toolButton("⧉", "Kopyala", () => copyImage(item)),
    toolButton("↻", "Aynı tarifle tekrar çiz", () => {
      $("prompt").value = item.prompt;
      const idx = STYLES.findIndex((s) => s.name === item.styleName);
      state.style = idx < 0 ? 0 : idx;
      const mi = MODELS.findIndex((m) => m.key === item.modelKey);
      state.model = mi < 0 ? 0 : mi;
      state.count = 1;
      renderControls();
      generate();
    }),
    toolButton("✕", "Sil", async () => {
      await deleteImage(item.id);
      URL.revokeObjectURL(urls.get(item.id));
      urls.delete(item.id);
      card.remove();
      if (!$("grid").querySelector(".card")) renderGallery();
    }),
  );
  meta.append(p, engine, tools);
  card.append(pic, meta);
  return card;
}

function placeholder() {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = '<div class="pic"><div class="spinner"></div></div><div class="meta"><div class="prompt">Çiziliyor…</div></div>';
  return card;
}

async function renderGallery() {
  const items = (await allImages()).sort((a, b) => b.id - a.id);
  $("grid").innerHTML = "";
  if (!items.length) {
    $("grid").innerHTML = '<div class="empty">Henüz resim yok. Yukarıya bir şey yaz.</div>';
    return;
  }
  items.forEach((it) => $("grid").append(cardFor(it)));
}

function openViewer(src) {
  $("viewer").querySelector("img").src = src;
  $("viewer").classList.add("open");
}
$("viewer").onclick = () => $("viewer").classList.remove("open");

async function generate() {
  const prompt = $("prompt").value.trim();
  if (!prompt) { $("prompt").focus(); return; }
  if (state.busy) return;
  state.busy = true;
  $("go").disabled = true;

  const style = STYLES[state.style];
  const model = MODELS[state.model];
  const n = state.count;
  setStatus(n > 1 ? `${n} resim çiziliyor…` : "Çiziliyor…");
  $("grid").querySelector(".empty")?.remove();

  const started = performance.now();
  let ok = 0, lastError = "";
  const jobs = Array.from({ length: n }, async (_, i) => {
    const slot = placeholder();
    $("grid").prepend(slot);
    try {
      const out = await draw(prompt, style.text, model);
      const item = {
        id: Date.now() * 10 + i, prompt, english: out.english, engine: out.engine,
        styleName: style.name, modelKey: model.key, blob: out.blob,
      };
      await saveImage(item);
      slot.replaceWith(cardFor(item));
      ok++;
    } catch (e) {
      lastError = e.message;
      slot.classList.add("fail");
      slot.querySelector(".pic").textContent = e.message;
      slot.querySelector(".prompt").textContent = prompt;
    }
  });
  await Promise.all(jobs);

  const secs = ((performance.now() - started) / 1000).toFixed(1);
  if (ok === n) setStatus(`Bitti (${secs} sn).`);
  else if (ok) setStatus(`${ok}/${n} resim çizildi. Hata: ${lastError}`, true);
  else setStatus(`Çizilemedi: ${lastError}`, true);

  state.busy = false;
  $("go").disabled = false;
}

$("go").onclick = generate;
$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
});
$("clear").onclick = async () => {
  if (!confirm("Galerideki bütün resimler silinsin mi?")) return;
  await clearImages();
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
  renderGallery();
};

renderControls();
renderGallery();
renderQuota();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js");
}
