/* 厝內溝通板：前端主程式（階段 3：加上台語錄音同步、IndexedDB 快取、離線） */
"use strict";

/* ---------- 設定與本機儲存 ---------- */
const API_URL = (window.CUENEI_CONFIG && window.CUENEI_CONFIG.API_URL) || "";
const K = { token: "cb-token", role: "cb-role", dev: "cb-device-id", label: "cb-device-label", data: "cb-data", tab: "cb-tab", tablet: "cb-tablet" };
/* 客廳平板模式是「這台裝置」的設定，不是角色 */
const tabletMode = () => LS.get(K.tablet, false);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch (e) { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) {} },
  del(k) { try { localStorage.removeItem(k) } catch (e) {} }
};
function deviceId() {
  let id = LS.get(K.dev, "");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, "");
    LS.set(K.dev, id);
  }
  return id;
}

/* ---------- IndexedDB：圖卡資料（kv）與台語錄音（audio） ---------- */
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open("cuenei", 1) } catch (e) { rej(e); return }
    r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("audio") };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbTx(store, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode), out = fn(tx.objectStore(store));
    tx.oncomplete = () => res(out && out.result);
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}
const dbGet = (store, key) => dbTx(store, "readonly", os => os.get(key));
const dbPut = (store, key, val) => dbTx(store, "readwrite", os => os.put(val, key));
const dbDel = (store, key) => dbTx(store, "readwrite", os => os.delete(key));
const dbClear = store => dbTx(store, "readwrite", os => os.clear());

/* 圖卡資料：存 IndexedDB；不能用時退回 localStorage */
async function saveData(d) {
  state.data = d;
  try { await dbPut("kv", "data", d); LS.del(K.data) } catch (e) { LS.set(K.data, d) }
}
async function loadData() {
  try { const d = await dbGet("kv", "data"); if (d) return d } catch (e) {}
  return LS.get(K.data, null);   // 舊版存在 localStorage，或 IndexedDB 不能用
}

/* 台語錄音：啟動時全部讀進記憶體，點卡片時不用再等磁碟或網路 */
const AUDIO = new Map();   // card_id → { blob, updated }
async function loadAudio() {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const cur = db.transaction("audio").objectStore("audio").openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) { res(); return } AUDIO.set(c.key, c.value); c.continue() };
      cur.onerror = () => rej(cur.error);
    });
  } catch (e) {}
}
function setAudio(id, blob, updated) {
  AUDIO.set(id, { blob, updated });
  return dbPut("audio", id, { blob, updated }).catch(() => {});
}
function dropAudio(id) { AUDIO.delete(id); return dbDel("audio", id).catch(() => {}) }
function b64ToBlob(b64, mime) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "audio/webm" });
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] || "");
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* 各分頁包含的分類，以及各角色看得到的分頁 */
const TAB_DEFS = {
  elder:  { zh: "阿嬤", id: "Nenek", cats: ["elder"] },
  family: { zh: "家人", id: "Keluarga", cats: ["care", "food", "home", "daily"] },
  carer:  { zh: "看護", id: "Perawat", cats: ["toElder", "report"] },
  rec:    { zh: "錄音", id: "Rekaman", cats: [] },
  set:    { zh: "設定", id: "Pengaturan", cats: [] }
};
const ROLE_TABS = { family: ["elder", "family", "rec", "set"], carer: ["carer", "set"], admin: ["elder", "family", "carer", "rec", "set"] };
const canRecord = () => state.role === "family" || state.role === "admin";
const ROLE_NAMES = { admin: ["管理者", "Admin"], family: ["家人", "Keluarga"], carer: ["看護", "Perawat"] };

const state = {
  token: LS.get(K.token, ""), role: LS.get(K.role, ""), label: LS.get(K.label, ""),
  data: null, tab: LS.get(K.tab, ""), cat: "all"
};

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function h(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e }
/* 看護介面以印尼文為主 */
const t = (zh, id) => state.role === "carer" ? id : zh;
let toastT;
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2800) }

/* ---------- 後端呼叫 ---------- */
/* 一律 POST、Content-Type 用 text/plain，避免瀏覽器送出預檢請求 */
const RETRY_ACTIONS = ["version", "bootstrap", "translate", "getAudio"];   // 只有讀取類會自動重試一次
const API_TIMEOUT_MS = 60000;
async function post(body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
      signal: ctl.signal
    });
    return await r.json();
  } finally { clearTimeout(timer) }
}
async function api(action, params) {
  const body = Object.assign({ action, token: state.token }, params || {});
  let res;
  try { res = await post(body) }
  catch (e) {
    if (!RETRY_ACTIONS.includes(action)) throw { code: "network" };
    try { res = await post(body) } catch (e2) { throw { code: "network" } }
  }
  if (!res || !res.ok) {
    const err = (res && res.error) || { code: "server" };
    if (err.code === "auth" && action !== "login" && state.token) authLost();
    throw err;
  }
  return res.data;
}
const ERR = {
  auth: ["PIN 不正確", "PIN salah"],
  locked: ["輸入錯誤次數過多，請 15 分鐘後再試", "Terlalu sering salah. Coba lagi 15 menit lagi"],
  network: ["連線失敗或伺服器太久沒回應，請再試一次", "Koneksi gagal atau server terlalu lama, coba lagi"],
  quota: ["今日翻譯次數已達上限", "Batas terjemahan hari ini sudah habis"],
  forbidden: ["這個角色不能執行此操作", "Peran ini tidak boleh melakukan ini"]
};
const ERR_DEFAULT = ["發生錯誤，請再試一次", "Terjadi kesalahan, coba lagi"];
const errPair = e => ERR[e && e.code] || ERR_DEFAULT;
const errText = e => { const p = errPair(e); return t(p[0], p[1]) };

/* 權杖失效（例如管理者改了 PIN）：清掉本機資料，回到 PIN 畫面 */
function authLost() {
  clearSession();
  toast("請重新輸入 PIN · Masukkan PIN lagi");
  showLogin();
}
function clearSession() {
  state.token = ""; state.role = ""; state.data = null; state.tab = ""; state.cat = "all";
  [K.token, K.role, K.data, K.tab].forEach(LS.del);
  AUDIO.clear();
  dbClear("kv").catch(() => {}); dbClear("audio").catch(() => {});
}

/* ---------- 資料 ---------- */
const catOf = key => (state.data.categories.find(c => c.key === key)) || { key, zh: key, id_text: key, color: "#5b6b73", default_play: "id" };
const cardById = id => state.data.cards.find(c => c.id === id);
const cardsOf = key => state.data.cards.filter(c => c.cat === key && c.status !== "hidden");
const hasCat = key => state.data.categories.some(c => c.key === key);

/* 與後端比對版本，不同才重新下載圖卡；再補齊有變動的台語錄音。回傳是否有任何更新 */
async function sync(force, onProgress) {
  let changed = false;
  if (force || !state.data || (await api("version")).data_version !== state.data.data_version) {
    const d = await api("bootstrap");
    state.role = d.role; LS.set(K.role, d.role);
    await saveData(d);
    changed = true;
  }
  if (await syncAudio(onProgress)) changed = true;
  return changed;
}

/* 依 audio_updated 比對，只下載變動的錄音，每次最多 20 筆 */
const AUDIO_BATCH = 20;
let audioSyncing = null;
function syncAudio(onProgress) {
  if (!audioSyncing) audioSyncing = doSyncAudio(onProgress).finally(() => { audioSyncing = null });
  return audioSyncing;
}
async function doSyncAudio(onProgress) {
  let changed = false;
  for (const id of [...AUDIO.keys()]) {
    const c = cardById(id);
    if (!c || !c.has_audio) { await dropAudio(id); changed = true }   // 錄音已被刪除
  }
  const want = state.data.cards.filter(c => c.has_audio && (!AUDIO.has(c.id) || AUDIO.get(c.id).updated !== c.audio_updated)).map(c => c.id);
  for (let i = 0; i < want.length; i += AUDIO_BATCH) {
    if (onProgress) onProgress(i, want.length);
    const r = await api("getAudio", { card_ids: want.slice(i, i + AUDIO_BATCH) });
    for (const id of Object.keys(r.audio || {})) {
      const a = r.audio[id];
      await setAudio(id, b64ToBlob(a.base64, a.mime), a.updated);
      changed = true;
    }
  }
  if (onProgress && want.length) onProgress(want.length, want.length);
  return changed;
}
function syncQuietly() {
  if (!state.token || !navigator.onLine) return;
  sync(false).then(changed => { if (changed && appStarted && !sheetOpen()) render() }).catch(() => {});
}

/* 目前時段與提示卡；BATH、GARB 依星期換成對應的卡 */
function currentSlot() {
  const d = new Date(), m = d.getHours() * 60 + d.getMinutes(), dow = d.getDay();
  const toM = s => { const p = String(s).split(":"); return +p[0] * 60 + +p[1] };
  const slots = state.data.slots;
  const s = slots.find(s => m >= toM(s.from) && m < toM(s.to)) || slots[0];
  if (!s) return null;
  const fix = ids => ids.map(i => i === "BATH" ? ([2, 4, 6].includes(dow) ? "c5" : "c4") : i === "GARB" ? (dow === 0 ? "h5" : "h4") : i);
  return { from: s.from, to: s.to, zh: s.zh, id_text: s.id_text, fam: fix(s.family_cards), car: fix(s.carer_cards) };
}

/* ---------- 圖示與顏色 ---------- */
const ICONS = {
  diaper: '<svg viewBox="0 0 64 64" role="img" aria-label="尿布"><path d="M6 14h52v10c0 16-11 28-26 30C17 52 6 40 6 24z" fill="#fff" stroke="#3a6fb0" stroke-width="3" stroke-linejoin="round"/><path d="M6 14h52v7H6z" fill="#cfe2f7" stroke="#3a6fb0" stroke-width="3" stroke-linejoin="round"/><rect x="1" y="16" width="11" height="9" rx="2" fill="#f2b84b" stroke="#3a6fb0" stroke-width="2.5"/><rect x="52" y="16" width="11" height="9" rx="2" fill="#f2b84b" stroke="#3a6fb0" stroke-width="2.5"/><path d="M24 29c0 8 3 14 8 17 5-3 8-9 8-17" fill="#dcecfb" stroke="#9cc0e6" stroke-width="2"/></svg>',
  diaperWet: '<svg viewBox="0 0 64 64" role="img" aria-label="濕尿布"><path d="M4 18h46v9c0 14-10 25-23 27C14 52 4 41 4 27z" fill="#fff" stroke="#3a6fb0" stroke-width="3" stroke-linejoin="round"/><path d="M4 18h46v6H4z" fill="#cfe2f7" stroke="#3a6fb0" stroke-width="3" stroke-linejoin="round"/><path d="M19 31c0 7 3 12 8 15 5-3 8-8 8-15" fill="#9fc8f0" stroke="#5b9ad8" stroke-width="2"/><path d="M55 6c0 0-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z" fill="#2f86de"/><path d="M57 28c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8z" fill="#2f86de"/></svg>'
};
function iconHTML(icon) {
  const s = String(icon || "");
  if (/^svg:/i.test(s) && ICONS[s.slice(4)]) return ICONS[s.slice(4)];
  return esc(s);
}
/* 把分類顏色套到元素上；深色模式用往白色混合後的較亮版本 */
function tint(el, hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) hex = "#5b6b73";
  const n = parseInt(hex.slice(1), 16);
  const mix = v => Math.round(v + (255 - v) * 0.45);
  const light = "rgb(" + [n >> 16, (n >> 8) & 255, n & 255].map(mix).join(",") + ")";
  el.classList.add("tint");
  el.style.removeProperty("--c");   // 清掉先前直接指定的顏色（緊急、PIN 浮層）
  el.style.setProperty("--cl", hex);
  el.style.setProperty("--cd", light);
  return el;
}

/* ---------- 發音 ---------- */
const TTS_OK = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices() } catch (e) { voices = [] } }
if (TTS_OK) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices }

/* Android 的語音代碼像 zh_TW_#Hant，先整理成 zh-tw 再比對 */
const normLang = l => String(l || "").toLowerCase().replace(/_/g, "-").replace(/-#.*$/, "");
function pickVoice(lang) {
  const want = lang.toLowerCase(), base = want.split("-")[0];
  const list = voices.map(v => ({ v, l: normLang(v.lang), raw: String(v.lang).toLowerCase() }));
  let c = list.filter(x => x.l === want);
  if (!c.length && base === "zh") c = list.filter(x => x.l.startsWith("zh") && /hant/.test(x.raw) && !/-(hk|mo)/.test(x.l));
  if (!c.length && base === "id") c = list.filter(x => /^(id|in)(-|$)/.test(x.l));   // 舊版 Android 把印尼語寫成 in
  if (!c.length) c = list.filter(x => x.l.split("-")[0] === base);
  const best = c.find(x => x.v.localService) || c[0];
  return best ? best.v : null;
}
let curAudio = null;
function stopAll() { try { speechSynthesis.cancel() } catch (e) {} if (curAudio) { curAudio.pause(); curAudio = null } }
function speak(text, lang) {
  stopAll();
  if (!TTS_OK) { toast(t("這個瀏覽器無法發音，請改用 Chrome 開啟", "Browser ini tidak bisa bersuara, gunakan Chrome")); return }
  const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = .85;
  const v = pickVoice(lang); if (v) u.voice = v;
  if (!v && voices.length && lang === "id-ID") toast(t("找不到印尼語語音，請見「設定」→ 裝置檢查", "Suara Indonesia tidak ditemukan, lihat Pengaturan"));
  speechSynthesis.speak(u);
}
/* 播家人錄的台語；沒有錄音或這台裝置播不了時，用華語代替 */
function playBlob(blob, onFail) {
  stopAll();
  const url = URL.createObjectURL(blob), a = new Audio(url);
  curAudio = a;
  let failed = false;
  const fail = () => { if (failed) return; failed = true; URL.revokeObjectURL(url); if (curAudio === a) curAudio = null; if (onFail) onFail() };
  a.onended = () => URL.revokeObjectURL(url);
  a.onerror = fail;
  a.play().catch(fail);
}
function playTw(card) {
  const rec = AUDIO.get(card.id);
  if (!rec) {
    speak(card.zh, "zh-TW");
    toast(t("這張還沒有台語錄音，先用華語播放", "Belum ada rekaman bahasa Taiwan, diputar dalam bahasa Mandarin"));
    return;
  }
  playBlob(rec.blob, () => {
    speak(card.zh, "zh-TW");
    toast(t("這台裝置播不了這段錄音，先用華語播放", "Rekaman tidak bisa diputar di perangkat ini, diputar dalam bahasa Mandarin"));
  });
}

/* ---------- 分頁與圖卡 ---------- */
function tabsForRole() { return (ROLE_TABS[state.role] || ["set"]).filter(k => !TAB_DEFS[k].cats.length || TAB_DEFS[k].cats.some(hasCat)) }

function renderTabs() {
  const n = $("#tabs"); n.innerHTML = "";
  tabsForRole().forEach(k => {
    const d = TAB_DEFS[k], b = h("button");
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", state.tab === k);
    b.innerHTML = state.role === "carer" ? `<span class="idn">${d.id}</span><small style="font-family:var(--zh)">${d.zh}</small>` : `${d.zh}<small>${d.id}</small>`;
    b.onclick = () => { stopAll(); state.tab = k; state.cat = "all"; LS.set(K.tab, k); render(); window.scrollTo(0, 0) };
    n.appendChild(b);
  });
}

function cardEl(c, idFirst) {
  const b = tint(h("button", "card" + (c.status === "pending" ? " pending" : "")), catOf(c.cat).color);
  const lines = idFirst
    ? `<span class="l1 idn">${esc(c.id_text)}</span><span class="l2">${esc(c.zh)}</span>`
    : `<span class="l1">${esc(c.zh)}</span><span class="l2 idn">${esc(c.id_text)}</span>`;
  b.innerHTML = `<span class="em" aria-hidden="true">${iconHTML(c.icon)}</span>${lines}` +
    (c.is_question ? `<span class="q">${idFirst ? "Pertanyaan" : "問句"}</span>` : "") +
    (c.status === "pending" ? '<span class="tag">待審核</span>' : AUDIO.has(c.id) ? `<span class="tag ok">${idFirst ? "Taiwan ✓" : "台語 ✓"}</span>` : "");
  b.onclick = () => openCard(c);
  return b;
}

function nowStrip(forCarer) {
  const s = currentSlot();
  if (!s) return document.createDocumentFragment();
  const box = h("div", "now");
  box.innerHTML = forCarer
    ? `<div class="when"><span class="idn">Sekarang ${esc(s.from)}–${esc(s.to)}　${esc(s.id_text)}</span><small style="font-family:var(--zh)">現在：${esc(s.zh)}</small></div>`
    : `<div class="when">現在 ${esc(s.from)}–${esc(s.to)}　${esc(s.zh)}<small>Sekarang: ${esc(s.id_text)}</small></div>`;
  (forCarer ? s.car : s.fam).map(cardById).filter(c => c && c.status !== "hidden").forEach(c => {
    const b = tint(h("button", "chip"), catOf(c.cat).color);
    b.innerHTML = `<span class="ci" aria-hidden="true">${iconHTML(c.icon)}</span><span${forCarer ? ' class="idn"' : ""}>${esc(forCarer ? c.id_text : c.zh)}</span>`;
    b.onclick = () => openCard(c);
    box.appendChild(b);
  });
  return box;
}

function section(key, idFirst) {
  const cat = catOf(key), frag = document.createDocumentFragment();
  const head = tint(h("h2", "sec"), cat.color);
  head.innerHTML = idFirst ? `<span class="idn">${esc(cat.id_text)}</span> <small style="font-family:var(--zh)">${esc(cat.zh)}</small>` : `${esc(cat.zh)} <small>${esc(cat.id_text)}</small>`;
  const g = h("div", "grid");
  cardsOf(key).forEach(c => g.appendChild(cardEl(c, idFirst)));
  frag.append(head, g);
  return frag;
}

function render() {
  const tabs = tabsForRole();
  // 預設分頁：客廳平板模式先顯示「阿嬤」，其餘先顯示自己角色的主分頁
  if (!tabs.includes(state.tab)) state.tab = (tabletMode() && tabs.includes("elder")) ? "elder" : tabs.includes("family") ? "family" : tabs[0];
  renderTabs();
  const m = $("#main"); m.innerHTML = "";
  if (state.tab === "set") { renderSettings(m); return }
  if (state.tab === "rec") { renderRecordings(m); return }
  if (!TTS_OK) {
    const b = h("div", "panel", `<h3 style="color:var(--emg)">${t("這個瀏覽器無法發音", "Browser ini tidak bisa bersuara")}</h3><p style="margin:0">${t("圖卡仍可看文字。要有聲音，請改用 Chrome 開啟。", "Kartu tetap bisa dibaca. Agar ada suara, buka dengan Chrome.")}</p>`);
    m.appendChild(b);
  }
  const cats = TAB_DEFS[state.tab].cats.filter(hasCat);
  if (state.tab === "elder") {
    const g = h("div", "grid elder");
    cats.forEach(k => cardsOf(k).forEach(c => g.appendChild(cardEl(c, false))));
    m.appendChild(g);
    const p = h("p", "hint"); p.style.marginTop = "14px"; p.textContent = "阿嬤點一下，就會用印尼語說給看護聽。";
    m.appendChild(p);
  } else if (state.tab === "family") {
    m.appendChild(nowStrip(false));
    const f = h("div", "cats");
    [{ key: "all", zh: "全部", id_text: "Semua" }].concat(cats.map(catOf)).forEach(c => {
      const b = h("button", "", `${esc(c.zh)}<small>${esc(c.id_text)}</small>`);
      if (c.key === "all") b.style.setProperty("--c", "var(--ink)"); else tint(b, c.color);
      if (c.key === "all") b.style.setProperty("--on-c", "var(--bg)");
      b.setAttribute("aria-pressed", state.cat === c.key);
      b.onclick = () => { state.cat = c.key; render() };
      f.appendChild(b);
    });
    m.appendChild(f);
    cats.filter(k => state.cat === "all" || state.cat === k).forEach(k => m.appendChild(section(k, false)));
  } else {
    m.appendChild(nowStrip(true));
    const p = h("p", "hint idn");
    p.textContent = "Kartu hijau-biru: diputar dalam bahasa Taiwan untuk Nenek/Kakek. Kartu biru: diputar dalam bahasa Mandarin untuk keluarga.";
    m.appendChild(p);
    cats.forEach(k => m.appendChild(section(k, true)));
  }
}

/* ---------- 大卡 ---------- */
const sheetOpen = () => $("#ov").classList.contains("open");
let activePad = null;   // 浮層或登入畫面上的 PIN 鍵盤，供實體鍵盤輸入
let recCleanup = null;  // 錄音浮層關閉時要停掉麥克風
function closeSheet() { stopAll(); if (recCleanup) { recCleanup(); recCleanup = null } $("#ov").classList.remove("open"); if (appStarted) activePad = null }
$("#ov").addEventListener("click", e => { if (e.target.id === "ov") closeSheet() });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheetOpen()) { closeSheet(); return }
  if (activePad && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) activePad.key(e.key);
});

function openCard(c) {
  const cat = catOf(c.cat), sh = tint($("#sheet"), cat.color);
  const carer = state.tab === "carer" || state.role === "carer";
  let play = c.play || cat.default_play || "id";
  if (play === "auto") play = carer ? "zh" : "id";   // 緊急卡：看護播華語給家人聽，其他人播印尼語給看護聽
  const idFirst = carer || play === "zh";
  sh.innerHTML = `<div class="em" aria-hidden="true">${iconHTML(c.icon)}</div>` +
    (idFirst ? `<div class="big1 idn">${esc(c.id_text)}</div><div class="big2">${esc(c.zh)}</div>`
             : `<div class="big1">${esc(c.zh)}</div><div class="big2 idn">${esc(c.id_text)}</div>`) +
    `<div id="extra"></div><div class="btns" id="bt"></div><div class="note" id="nt"></div>`;
  const bt = sh.querySelector("#bt");
  const mk = (label, cls, fn) => { const b = h("button", "btn " + (cls || "")); b.textContent = label; b.onclick = fn; bt.appendChild(b); return b };
  mk("🔊 印尼語 Indonesia", "", () => speak(c.id_text, "id-ID"));
  mk("🔊 華語 Mandarin", "", () => speak(c.zh, "zh-TW"));
  if (play === "tw" || c.cat === "emg" || AUDIO.has(c.id)) mk(AUDIO.has(c.id) ? "🔊 台語 Taiwan" : "🔊 台語（未錄）", "", () => playTw(c));
  if (canRecord() && state.tab !== "elder" && REC_CATS.includes(c.cat)) mk(AUDIO.has(c.id) ? "🎙 重錄台語" : "🎙 錄台語", "", () => openRecorder(c));
  mk("關閉 Tutup", "solid", closeSheet);

  if (c.is_question) {
    // 回答以「另一方」的語言播放：問的是印尼語，就用華語回答給家人聽
    const ansZh = play === "id";
    const yn = h("div", "yn", `<button class="y">要／是<small>Ya</small></button><button class="n">不要／不是<small>Tidak</small></button>`);
    yn.querySelector(".y").onclick = () => ansZh ? speak("好，要", "zh-TW") : speak("Ya", "id-ID");
    yn.querySelector(".n").onclick = () => ansZh ? speak("不要", "zh-TW") : speak("Tidak", "id-ID");
    sh.querySelector("#extra").appendChild(yn);
  }
  const steps = c.cat === "emg" && state.data.emergency_steps[c.id];
  if (steps) {
    const ol = h("ol", "steps");
    steps.forEach(s => ol.appendChild(h("li", "", idFirst
      ? `<div><div class="idn">${esc(s.id_text)}</div><div class="s2" style="font-family:var(--zh)">${esc(s.zh)}</div></div>`
      : `<div><div>${esc(s.zh)}</div><div class="s2">${esc(s.id_text)}</div></div>`)));
    const a = h("a", "call"); a.href = "tel:119"; a.textContent = "📞 撥打 119 / Telepon 119";
    sh.querySelector("#extra").append(ol, a);
  }
  $("#ov").classList.add("open");
  sh.scrollTop = 0;
  setTimeout(() => { if (play === "id") speak(c.id_text, "id-ID"); else if (play === "tw") playTw(c); else speak(c.zh, "zh-TW") }, 150);
  api("log", { action_name: c.cat === "emg" ? "emergency" : "card", card_id: c.id }).catch(() => {});
}

function openEmergency() {
  if (!state.data) return;
  const sh = $("#sheet"); sh.classList.remove("tint"); sh.style.setProperty("--c", "var(--emg)");
  sh.innerHTML = `<div class="emg-intro"><b>發生什麼事？</b> <span class="idn">Apa yang terjadi?</span></div><div class="grid" id="eg"></div><div class="btns"><button class="btn solid" id="ec">關閉 Tutup</button></div>`;
  const g = sh.querySelector("#eg");
  cardsOf("emg").forEach(c => g.appendChild(cardEl(c, state.tab === "carer" || state.role === "carer")));
  sh.querySelector("#ec").onclick = closeSheet;
  $("#ov").classList.add("open");
  sh.scrollTop = 0;
}
$("#emgBtn").onclick = openEmergency;

/* ---------- 台語錄音（家人、管理者） ---------- */
const REC_CATS = ["toElder", "emg", "daily"];   // 錄音清單的順序：對長輩說 → 緊急 → 日常
const REC_MAX_SECONDS = 15;
const REC_MAX_BYTES = 1024 * 1024;

function renderRecordings(m) {
  const cats = REC_CATS.filter(hasCat);
  const all = cats.reduce((a, k) => a.concat(cardsOf(k)), []);
  const done = all.filter(c => AUDIO.has(c.id)).length;
  m.appendChild(h("div", "panel", `<h3>台語錄音　已錄 ${done} / ${all.length}</h3><p style="margin:0">請用台語唸出每一句。看護點卡片時，會播放您的聲音給長輩聽。錄一次，所有裝置都能播放。先錄「對長輩說」和「緊急」這兩組最重要。</p>`));
  cats.forEach(k => {
    const cat = catOf(k), box = h("div", "panel");
    const head = tint(h("h3"), cat.color); head.style.color = "var(--c)"; head.textContent = cat.zh;
    const list = h("div", "list");
    cardsOf(k).forEach(c => {
      const has = AUDIO.has(c.id);
      const row = h("div", "rowi", `<span class="em" aria-hidden="true" style="font-size:2.2rem;display:inline-flex">${iconHTML(c.icon)}</span><div class="t">${esc(c.zh)}<small class="idn">${esc(c.id_text)}</small></div><span class="s ${has ? "ok" : ""}">${has ? "已錄" : "未錄"}</span>`);
      if (has) { const pb = h("button", "sm"); pb.textContent = "▶"; pb.setAttribute("aria-label", "播放 " + c.zh); pb.onclick = () => playTw(c); row.appendChild(pb) }
      const rb = h("button", "sm" + (has ? "" : " solid")); rb.textContent = has ? "重錄" : "🎙 錄音"; rb.onclick = () => openRecorder(c); row.appendChild(rb);
      list.appendChild(row);
    });
    box.append(head, list);
    m.appendChild(box);
  });
}

/* 選 Safari 與 Chrome 都播得了的格式：優先 mp4（AAC），不行才用 webm */
function recMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  return ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(x => MediaRecorder.isTypeSupported(x)) || "";
}
function fileMime(f) {
  if (f.type && f.type.startsWith("audio/")) return f.type;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  return { m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", "3gp": "audio/3gpp", amr: "audio/amr" }[ext] || f.type || "";
}

/* 錄音浮層：錄音（或選檔）→ 試聽 → 確認上傳 */
function openRecorder(c) {
  stopAll();
  const sh = tint($("#sheet"), catOf(c.cat).color);
  let stream = null, recorder = null, timer = null, take = null, busy = false;   // take：{ blob, mime } 待上傳的錄音
  const stopMic = () => { clearInterval(timer); if (recorder && recorder.state === "recording") { recorder.onstop = null; recorder.stop() } if (stream) stream.getTracks().forEach(x => x.stop()); stream = null; recorder = null };
  recCleanup = stopMic;

  const draw = (status, bad) => {
    const has = AUDIO.has(c.id), recording = !!recorder;
    sh.innerHTML = `<div class="em" aria-hidden="true">${iconHTML(c.icon)}</div><div class="big1">${esc(c.zh)}</div><div class="big2 idn">${esc(c.id_text)}</div>
      <div class="note" id="rs" role="status" style="font-size:1rem;${bad ? "color:var(--emg);font-weight:700" : ""}">${esc(status || (take ? "錄好了，請先試聽，沒問題再按「確認上傳」。" : has ? "這張已經有台語錄音，重錄會取代原本的。" : "請用台語唸出這一句，最長 " + REC_MAX_SECONDS + " 秒。"))}</div>
      <div class="btns" id="rb"></div>`;
    const bt = sh.querySelector("#rb");
    const mk = (label, cls, fn) => { const b = h("button", "btn " + (cls || "")); b.textContent = label; b.onclick = fn; b.disabled = busy; bt.appendChild(b); return b };
    if (recording) { mk("■ 停止錄音", "danger solid-danger", () => recorder && recorder.stop()).disabled = false; return }
    if (take) {
      mk("▶ 試聽", "", () => playBlob(take.blob, () => toast("這台裝置無法試聽這段錄音")));
      mk("✔ 確認上傳", "solid", upload);
      mk("🎙 重錄", "", start);
    } else {
      mk(has ? "🎙 重錄" : "🎙 開始錄音", "solid", start);
      mk("📁 選擇錄音檔", "", pickFile);
      if (has) { mk("▶ 播放目前的", "", () => playTw(c)); mk("刪除錄音", "danger", remove) }
    }
    mk("關閉", "", closeSheet);
  };

  async function start() {
    stopAll(); take = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { draw("這台裝置無法直接錄音，請改按「選擇錄音檔」。", true); return }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch (e) { draw("這裡無法使用麥克風（" + e.name + "），請改按「選擇錄音檔」。", true); return }
    const mime = recMime(), chunks = [];
    try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream) }
    catch (e) { stopMic(); draw("無法開始錄音，請改按「選擇錄音檔」。", true); return }
    const rec = recorder;
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) };
    rec.onstop = () => {
      const type = (rec.mimeType || mime || "audio/webm");
      stopMic();
      const blob = new Blob(chunks, { type });
      if (!blob.size) { draw("沒有錄到聲音，請再試一次。", true); return }
      take = { blob, mime: type };
      draw();
    };
    rec.start();
    let left = REC_MAX_SECONDS;
    draw("錄音中… 剩 " + left + " 秒");
    timer = setInterval(() => {
      left--;
      const el = sh.querySelector("#rs"); if (el) el.textContent = "錄音中… 剩 " + left + " 秒";
      if (left <= 0 && rec.state === "recording") rec.stop();
    }, 1000);
  }

  function pickFile() {
    const inp = h("input"); inp.type = "file"; inp.accept = "audio/*"; inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      const mime = fileMime(f);
      if (!mime.startsWith("audio/")) { draw("這不是錄音檔，請選擇音訊檔案。", true); return }
      if (f.size > REC_MAX_BYTES) { draw("檔案超過 1 MB，請錄短一點（15 秒內）。", true); return }
      take = { blob: f, mime };
      draw();
    };
    inp.click();
  }

  async function upload() {
    if (!take || busy) return;
    if (take.blob.size > REC_MAX_BYTES) { draw("錄音超過 1 MB，請錄短一點。", true); return }
    busy = true; draw("上傳中，請稍候…");
    try {
      const r = await api("uploadAudio", { card_id: c.id, base64: await blobToB64(take.blob), mime: take.mime });
      await setAudio(c.id, take.blob, r.audio_updated);
      c.has_audio = true; c.audio_updated = r.audio_updated;
      state.data.data_version = r.data_version;
      await saveData(state.data);
      take = null; busy = false;
      toast("台語錄音已上傳，其他裝置下次開啟時會自動下載");
      closeSheet(); render();
    } catch (e) {
      busy = false;
      if (state.token) draw("上傳失敗：" + errPair(e)[0], true);
    }
  }

  async function remove() {
    if (busy || !confirm("確定要刪除這張的台語錄音嗎？")) return;
    busy = true; draw("刪除中…");
    try {
      const r = await api("deleteAudio", { card_id: c.id });
      await dropAudio(c.id);
      c.has_audio = false; c.audio_updated = "";
      state.data.data_version = r.data_version;
      await saveData(state.data);
      busy = false;
      toast("已刪除");
      closeSheet(); render();
    } catch (e) {
      busy = false;
      if (state.token) draw("刪除失敗：" + errPair(e)[0], true);
    }
  }

  draw();
  $("#ov").classList.add("open");
  sh.scrollTop = 0;
}

/* ---------- PIN 鍵盤 ---------- */
/* onSubmit(pin) 回傳錯誤訊息字串，或 null 代表成功 */
function pinPad(onSubmit) {
  const wrap = h("div"), dots = h("div", "dots"), msg = h("div", "pin-msg"), pad = h("div", "pad");
  msg.setAttribute("role", "alert");
  let pin = "", busy = false;
  for (let i = 0; i < 6; i++) dots.appendChild(h("span"));
  const draw = () => { [...dots.children].forEach((d, i) => d.classList.toggle("on", i < pin.length)); pad.querySelectorAll("button").forEach(b => b.disabled = busy) };
  const press = async k => {
    if (busy) return;
    if (k === "back") pin = pin.slice(0, -1);
    else if (pin.length < 6) { pin += k; msg.textContent = "" }
    draw();
    if (pin.length === 6) {
      busy = true; draw();
      // 後端有時要等好幾秒，先讓使用者知道有在處理
      msg.classList.add("wait"); msg.textContent = "確認中，請稍候… · Mohon tunggu…";
      const slow = setTimeout(() => { msg.textContent = "伺服器回應較慢，請再等一下… · Server lambat, mohon tunggu…" }, 6000);
      const err = await onSubmit(pin);
      clearTimeout(slow);
      busy = false; pin = "";
      msg.classList.remove("wait"); msg.textContent = err || "";
      draw();
    }
  };
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"].forEach(k => {
    const b = h("button", k === "" ? "blank" : "");
    b.type = "button"; b.textContent = k === "back" ? "⌫" : k;
    if (k === "back") b.setAttribute("aria-label", "刪除 Hapus");
    if (k === "") { b.tabIndex = -1; b.setAttribute("aria-hidden", "true") } else b.onclick = () => press(k);
    pad.appendChild(b);
  });
  wrap.append(dots, msg, pad);
  return { el: wrap, key: k => { if (/^\d$/.test(k)) press(k); else if (k === "Backspace") press("back") } };
}

/* ---------- 登入流程 ---------- */
let appStarted = false;

function showLogin() {
  appStarted = false; closeSheet(); stopTimers();
  $("#top").hidden = true;
  const m = $("#main"); m.innerHTML = "";
  const g = h("div", "gate", `<h1>厝內溝通板</h1><p class="sub">Papan Komunikasi Rumah</p><h2>請輸入 PIN</h2><p class="sub">Masukkan PIN</p>`);
  activePad = pinPad(async pin => {
    try {
      const d = await api("login", { pin, device_id: deviceId(), device_label: state.label });
      state.token = d.token; state.role = d.role;
      LS.set(K.token, d.token); LS.set(K.role, d.role);
      if (d.bootstrap) await saveData(d.bootstrap);   // 登入時已附上圖卡資料
    } catch (e) { const p = errPair(e); return p[0] + " · " + p[1] }
    activePad = null;
    state.label ? firstLoad() : showNaming();
    return null;
  });
  g.appendChild(activePad.el);
  m.appendChild(g);
}

function showNaming() {
  const m = $("#main"); m.innerHTML = "";
  const presets = { carer: ["HP Perawat（看護手機）"], family: ["家人手機", "客廳平板"], admin: ["管理者手機", "管理者電腦"] }[state.role] || [];
  const g = h("div", "gate", `<h2>幫這台裝置取個名字</h2><p class="sub">Beri nama perangkat ini</p>
    <input class="field" id="nm" maxlength="40" autocomplete="off" aria-label="裝置名稱 Nama perangkat">
    <div class="presets" id="ps"></div>
    <div class="btns" style="justify-content:center"><button class="btn solid" id="ok">確定 · Simpan</button></div>`);
  m.appendChild(g);
  const inp = g.querySelector("#nm");
  inp.value = presets[0] || "";
  presets.forEach(p => { const b = h("button", "btn"); b.textContent = p; b.onclick = () => { inp.value = p }; g.querySelector("#ps").appendChild(b) });
  g.querySelector("#ok").onclick = () => {
    const name = inp.value.trim();
    if (!name) { inp.focus(); return }
    state.label = name; LS.set(K.label, name);
    if (name === "客廳平板") LS.set(K.tablet, true);   // 取這個名字就直接開啟客廳平板模式
    api("setLabel", { device_label: name }).catch(() => {});
    firstLoad();
  };
}

/* 第一次下載：圖卡資料（登入時通常已附上）加上全部台語錄音，顯示進度 */
async function firstLoad() {
  const m = $("#main"); m.innerHTML = "";
  const g = h("div", "gate", `<h2>下載資料中…</h2><p class="sub">Mengunduh data…</p><div class="progress"><i id="pg"></i></div><div class="pin-msg wait" id="lm"></div>`);
  m.appendChild(g);
  const bar = g.querySelector("#pg"), msg = g.querySelector("#lm");
  const prog = (done, total) => { bar.style.width = (25 + 75 * done / total) + "%"; msg.textContent = `台語錄音 ${done} / ${total} · Rekaman ${done} / ${total}` };
  requestAnimationFrame(() => { bar.style.width = "25%" });
  if (!state.data) {
    try { await sync(true, prog) }
    catch (e) {
      if (!state.token) return;   // 權杖失效時已回到 PIN 畫面
      if (!state.data) {
        const p = errPair(e);
        msg.classList.remove("wait"); msg.textContent = p[0] + " · " + p[1];
        const b = h("button", "btn solid"); b.textContent = "再試一次 · Coba lagi"; b.onclick = firstLoad;
        g.appendChild(b);
        return;
      }
    }
  } else {
    // 錄音沒下載完也先進主畫面，之後會在背景補齊
    try { await syncAudio(prog) } catch (e) { if (!state.token) return }
  }
  bar.style.width = "100%";
  startApp();
}

function startApp() {
  appStarted = true; activePad = null;
  $("#top").hidden = false;
  render();
  startTimers();
}

/* ---------- 定時工作：時段更新、平板常亮、凌晨重新整理 ---------- */
let slotTimer = null, reloadTimer = null, wakeLock = null;
function startTimers() {
  stopTimers();
  slotTimer = setInterval(() => { if (["family", "carer"].includes(state.tab) && !sheetOpen()) render() }, 5 * 60 * 1000);
  if (tabletMode()) {
    // 客廳平板每天凌晨 3:00 自動重新整理一次
    const now = new Date(), next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    reloadTimer = setTimeout(() => { if (navigator.onLine) location.reload(); else startTimers() }, next - now);
  }
  applyWake();
}
function stopTimers() { clearInterval(slotTimer); clearTimeout(reloadTimer); releaseWake() }
async function applyWake() {
  if (!tabletMode() || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { wakeLock = await navigator.wakeLock.request("screen") } catch (e) {}
}
function releaseWake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null } }

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !appStarted) return;
  applyWake();
  syncQuietly();
  if (["family", "carer"].includes(state.tab) && !sheetOpen()) render();
});
function showOffline() { $("#offline").hidden = navigator.onLine }
window.addEventListener("online", () => { showOffline(); if (appStarted) syncQuietly() });
window.addEventListener("offline", showOffline);

/* ---------- 設定 ---------- */
function browserName() {
  const ua = navigator.userAgent;
  if (/; wv\)/.test(ua)) return t("App 內建瀏覽器（發音、麥克風常受限制）", "Browser dalam aplikasi (sering terbatas)");
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/CriOS|Chrome/.test(ua)) return "Chrome";
  if (/Safari/.test(ua)) return "Safari";
  return t("其他", "Lainnya");
}

function renderSettings(m) {
  const row = (label, id, text) => `<div class="rowi"><div class="t">${label}</div><span class="s" id="${id}">${text}</span></div>`;
  const mark = (id, ok, text) => { const e = $("#" + id); if (!e) return; e.textContent = text; e.className = "s " + (ok ? "ok" : "bad") };
  const untested = t("未測試", "Belum diuji");

  // ---- 裝置檢查 ----
  const p0 = h("div", "panel", `<h3>${t("裝置檢查", "Pemeriksaan perangkat")}</h3><p>${t("功能有問題時，先看這裡。", "Jika ada masalah, periksa di sini dulu.")}</p><div class="list">` +
    row(t("目前瀏覽器", "Browser"), "cBr", esc(browserName())) +
    row(t("語音播放", "Pemutaran suara"), "cTts", "") +
    row(t("華語語音", "Suara Mandarin"), "cZh", "") +
    row(t("印尼語語音", "Suara Indonesia"), "cId", "") +
    row(t("麥克風", "Mikrofon"), "cMic", untested) +
    row(t("後端連線", "Koneksi server"), "cApi", untested) +
    row(t("翻譯", "Terjemahan"), "cTr", untested) +
    `</div><div class="btns"><button class="btn" id="tZh">${t("測試華語", "Uji Mandarin")}</button><button class="btn" id="tId">${t("測試印尼語", "Uji Indonesia")}</button><button class="btn" id="tMic">${t("測試麥克風", "Uji mikrofon")}</button><button class="btn" id="tApi">${t("測試連線與翻譯", "Uji koneksi & terjemahan")}</button></div>
    <p style="margin:12px 0 0">${t("三星手機若沒有印尼語聲音：到手機「設定」搜尋「文字轉語音」，把偏好引擎改為 <b>Google 語音服務</b>，再到該引擎的設定裡下載「印尼語」語音資料。", "Jika tidak ada suara Indonesia di HP Samsung: buka Pengaturan HP, cari “Text-to-speech”, pilih mesin <b>Speech Services by Google</b>, lalu unduh data suara Bahasa Indonesia.")}</p>`);
  m.appendChild(p0);
  const vz = pickVoice("zh-TW"), vi = pickVoice("id-ID");
  const none = t("找不到", "Tidak ditemukan");
  mark("cTts", TTS_OK, TTS_OK ? t("可以", "Bisa") : t("不支援，請改用 Chrome", "Tidak didukung, gunakan Chrome"));
  if (TTS_OK && !voices.length) { $("#cZh").textContent = $("#cId").textContent = t("按下方測試確認", "Tekan tombol uji di bawah") }
  else { mark("cZh", !!vz, vz ? vz.name + "（" + vz.lang + "）" : none); mark("cId", !!vi, vi ? vi.name + "（" + vi.lang + "）" : none) }
  p0.querySelector("#tZh").onclick = () => speak("阿嬤，要吃飯了", "zh-TW");
  p0.querySelector("#tId").onclick = () => speak("Nenek, waktunya makan", "id-ID");
  p0.querySelector("#tMic").onclick = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { mark("cMic", false, t("不支援", "Tidak didukung")); return }
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(x => x.stop()); mark("cMic", true, t("可以", "Bisa")) }
    catch (e) { mark("cMic", false, t("被擋住", "Diblokir") + "（" + e.name + "）") }
  };
  p0.querySelector("#tApi").onclick = async () => {
    const t0 = performance.now();
    try { await api("version"); mark("cApi", true, Math.round(performance.now() - t0) + " ms") }
    catch (e) { mark("cApi", false, errText(e)); return }
    const t1 = performance.now();
    try { const r = await api("translate", { text: "阿嬤，要吃飯了", from: "zh-TW", to: "id" }); mark("cTr", true, r.text + "（" + Math.round(performance.now() - t1) + " ms）") }
    catch (e) { mark("cTr", false, errText(e)) }
  };

  // ---- 這台裝置 ----
  const rn = ROLE_NAMES[state.role] || [state.role, state.role];
  const p1 = h("div", "panel", `<h3>${t("這台裝置", "Perangkat ini")}</h3><div class="list">` +
    row(t("角色", "Peran"), "dRole", esc(t(rn[0], rn[1]))) +
    row(t("名稱", "Nama"), "dName", esc(state.label)) +
    row(t("資料版本", "Versi data"), "dVer", esc(state.data.data_version)) +
    row(t("台語錄音", "Rekaman bahasa Taiwan"), "dAud", AUDIO.size + " / " + state.data.cards.filter(c => c.has_audio).length) +
    `</div><div class="btns"><button class="btn" id="bSync">${t("重新下載資料", "Unduh ulang data")}</button><button class="btn" id="bName">${t("改名稱", "Ganti nama")}</button><button class="btn danger" id="bOut">${t("登出", "Keluar")}</button></div>`);
  m.appendChild(p1);
  p1.querySelector("#bSync").onclick = async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await sync(true); toast(t("資料已更新", "Data sudah diperbarui")); render() }
    catch (err) { if (state.token) { toast(errText(err)); b.disabled = false } }
  };
  p1.querySelector("#bName").onclick = () => {
    const name = (prompt(t("裝置名稱", "Nama perangkat"), state.label) || "").trim().slice(0, 40);
    if (!name) return;
    state.label = name; LS.set(K.label, name);
    api("setLabel", { device_label: name }).catch(() => {});
    render();
  };
  p1.querySelector("#bOut").onclick = () => {
    if (!confirm(t("登出後要重新輸入 PIN 才能使用，確定嗎？", "Setelah keluar, PIN harus dimasukkan lagi. Lanjutkan?"))) return;
    api("logout").catch(() => {});
    clearSession();
    showLogin();
  };

  // ---- 客廳平板模式：這台裝置專屬的設定，看護手機不需要 ----
  if (state.role !== "carer") {
    const on = tabletMode(), sup = "wakeLock" in navigator;
    const p2 = h("div", "panel", `<h3>客廳平板模式</h3><p>放在客廳給阿嬤用的平板請開啟：預設顯示「阿嬤」分頁、螢幕保持常亮、每天凌晨 3:00 自動重新整理一次。${sup ? "" : "<br><b>這個瀏覽器不支援螢幕常亮</b>，請到平板的系統設定把螢幕逾時調長。"}</p><div class="btns" style="margin-top:0"><button class="btn${on ? " solid" : ""}" id="bTab">${on ? "已開啟（點一下關閉）" : "已關閉（點一下開啟）"}</button></div>`);
    p2.querySelector("#bTab").onclick = () => { LS.set(K.tablet, !on); startTimers(); render() };
    m.appendChild(p2);
  }

  // ---- 使用說明 ----
  m.appendChild(h("div", "panel", `<h3>${t("使用說明", "Cara pakai")}</h3><p style="margin:0">${t(
    "「阿嬤」：長輩點卡片，播印尼語給看護聽。「家人」：交辦事情，播印尼語。「看護」：介面以印尼文為主，「對長輩說」播家人錄的台語，「回報家人」播華語。上方會依時間表顯示現在這個時段常用的句子。紅色「緊急」按鈕隨時可用，會顯示處理步驟。",
    "Ketuk kartu untuk memutar suara. “Bicara ke Nenek / Kakek” diputar dalam bahasa Taiwan (rekaman keluarga). “Lapor ke Keluarga” diputar dalam bahasa Mandarin. Di bagian atas ada kartu yang sering dipakai pada jam ini. Tombol merah “Darurat” selalu bisa dipakai dan menampilkan langkah-langkahnya.")}</p>`));
}

/* ---------- 啟動 ---------- */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
(async function boot() {
  showOffline();
  if (!API_URL) {
    $("#main").appendChild(h("div", "panel", "<h3>尚未設定後端網址</h3><p style='margin:0'>請在 config.js 填入 API_URL。</p>"));
    return;
  }
  if (!state.token) { showLogin(); return }
  state.data = await loadData();
  await loadAudio();
  if (state.data) { startApp(); syncQuietly() }   // 有快取就直接進入，背景再比對版本
  else if (!state.label) showNaming();
  else firstLoad();
})();
