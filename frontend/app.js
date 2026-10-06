/* 厝內溝通板：前端主程式 */
"use strict";

/* ---------- 設定與本機儲存 ---------- */
const API_URL = (window.CUENEI_CONFIG && window.CUENEI_CONFIG.API_URL) || "";
const K = { token: "cb-token", role: "cb-role", dev: "cb-device-id", label: "cb-device-label", data: "cb-data", tab: "cb-tab", tablet: "cb-tablet", flip: "cb-flip", ok: "cb-checked", sent: "cb-suggested" };
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
  talk:   { zh: "對話", id: "Percakapan", cats: [] },
  rec:    { zh: "錄音", id: "Rekaman", cats: [] },
  add:    { zh: "新增圖卡", id: "Kartu baru", cats: [] },
  sug:    { zh: "建議修正", id: "Perbaikan", cats: [] },
  admin:  { zh: "管理", id: "Kelola", cats: [] },
  set:    { zh: "設定", id: "Pengaturan", cats: [] }
};
const ROLE_TABS = {
  family: ["elder", "family", "talk", "rec", "add", "set"],
  carer: ["carer", "talk", "sug", "set"],
  admin: ["elder", "family", "carer", "talk", "rec", "add", "admin", "set"]
};
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
  AUDIO.clear(); allCards = null; pending = null;
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
    b.onclick = () => { stopAll(); if (activeSR) { try { activeSR.abort() } catch (_) {} } state.tab = k; state.cat = "all"; LS.set(K.tab, k); render(); window.scrollTo(0, 0) };
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
  const special = { set: renderSettings, rec: renderRecordings, talk: renderTalk, add: renderAdd, sug: renderSuggest, admin: renderAdmin }[state.tab];
  if (special) { special(m); return }
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

/* ---------- 即時對話 ---------- */
/* 對話內容只留在畫面上，不存檔、不上傳紀錄（後端只記一次「translate」次數） */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeSR = null;

function renderTalk(m) {
  const mine = state.role === "carer" ? "id" : "zh", other = mine === "id" ? "zh" : "id";
  const flip = LS.get(K.flip, true);
  const tools = h("div", "talk-tools");
  const hint = h("span", "hint", SR
    ? t("按住 🎙 說話，放開就會翻譯。上半部給對面的人看。長輩說台語時請改用圖卡。", "Tahan tombol 🎙 sambil bicara, lepas untuk menerjemahkan. Bagian atas untuk orang di depan Anda.")
    : "這個瀏覽器不支援語音辨識：請點文字框，按鍵盤上的 🎤 語音輸入，說完按「送出」。<span class='idn'> Browser ini tidak mendukung pengenalan suara: ketuk kotak teks, tekan 🎤 di keyboard, lalu tekan “Kirim”.</span>");
  const fb = h("button", "sm"); fb.textContent = flip ? t("上半部：已轉向對面", "Atas: menghadap lawan bicara") : t("上半部：未轉向", "Atas: tidak diputar");
  fb.onclick = () => { LS.set(K.flip, !flip); render() };
  tools.append(hint, fb);
  m.appendChild(tools);
  const wrap = h("div", "talk");
  const top = talkHalf(other, flip), bot = talkHalf(mine, false);
  top.other = bot; bot.other = top;
  wrap.append(top.el, bot.el);
  m.appendChild(wrap);
}

function talkHalf(lang, flip) {
  const isId = lang === "id";
  const el = h("section", "half " + lang + (flip ? " flip" : ""));
  el.style.setProperty("--c", isId ? "#1f7d80" : "#2c67a8");
  el.innerHTML = `<div class="lab"><span>${isId ? "Bahasa Indonesia（看護）" : "華語（家人）"}</span></div>
    <div class="out" aria-live="polite"><span class="ph${isId ? " idn" : ""}">${isId ? (SR ? "Tahan 🎙 lalu bicara, atau ketik." : "Ketik di sini, lalu tekan Kirim.") : (SR ? "按住 🎙 說話，或直接打字。" : "在下面打字，再按送出。")}</span></div>
    <div class="trow"><button class="mic hold" type="button">${isId ? "🎙 Tahan" : "🎙 按住說話"}</button><input type="text" ${isId ? 'class="idn" lang="id"' : 'lang="zh-Hant"'} placeholder="${isId ? "Ketik di sini…" : "在這裡打字…"}" enterkeyhint="send" autocomplete="off"><button class="mic send" type="button">${isId ? "Kirim" : "送出"}</button></div>`;
  const obj = { el, lang, out: el.querySelector(".out") };
  const inp = el.querySelector("input"), mic = el.querySelector(".hold"), send = el.querySelector(".send");

  const go = async text => {
    text = String(text).trim(); if (!text) return;
    inp.value = "";
    const o = obj.other;
    obj.out.innerHTML = `<span class="said">${esc(text)}</span>`;
    o.out.innerHTML = `<span class="ph">${o.lang === "id" ? "Menerjemahkan…" : "翻譯中…"}</span>`;
    try {
      const r = await api("translate", { text, from: isId ? "id" : "zh-TW", to: isId ? "zh-TW" : "id" });
      o.out.innerHTML = `${esc(r.text)}<span class="orig">${esc(text)}</span>`;
      speak(r.text, o.lang === "id" ? "id-ID" : "zh-TW");
      api("log", { action_name: "translate", card_id: "" }).catch(() => {});
    } catch (e) {
      if (!state.token) return;
      const p = errPair(e);
      o.out.innerHTML = `<span class="ph" style="color:var(--emg)">${esc(p[0])} · <span class="idn">${esc(p[1])}</span></span>`;
    }
  };
  send.onclick = () => go(inp.value);
  inp.addEventListener("keydown", e => { if (e.key === "Enter") go(inp.value) });

  if (!SR) { mic.hidden = true; return obj }
  // 按住說話、放開送出
  const idle = mic.textContent, active = isId ? "🎙 Lepas untuk kirim" : "🎙 放開送出";
  let rec = null, text = "";
  const start = e => {
    e.preventDefault();
    if (rec) return;
    stopAll();
    if (activeSR) { try { activeSR.abort() } catch (_) {} }
    let r;
    try { r = new SR() } catch (_) { toast(t("無法啟動語音辨識，請改用打字", "Pengenalan suara gagal, silakan ketik")); return }
    rec = activeSR = r; text = "";
    r.lang = isId ? "id-ID" : "zh-TW"; r.interimResults = true;
    r.continuous = !/Android/i.test(navigator.userAgent);   // Android 的連續模式會重複輸出文字
    r.onresult = ev => { let s = ""; for (const res of ev.results) s += res[0].transcript; text = s; inp.value = s };
    r.onerror = ev => {
      if (ev.error === "aborted") return;
      toast(ev.error === "not-allowed" || ev.error === "service-not-allowed"
        ? t("沒有麥克風權限，請改用打字", "Tidak ada izin mikrofon, silakan ketik")
        : t("聽不清楚，請再說一次", "Tidak terdengar jelas, coba lagi"));
    };
    r.onend = () => {
      mic.classList.remove("on"); mic.textContent = idle;
      if (activeSR === r) activeSR = null;
      rec = null;
      if (text.trim()) go(text);
    };
    try { r.start(); mic.classList.add("on"); mic.textContent = active; if (e.pointerId !== undefined) mic.setPointerCapture(e.pointerId) }
    catch (_) { rec = null; activeSR = null; toast(t("無法啟動語音辨識，請改用打字", "Pengenalan suara gagal, silakan ketik")) }
  };
  const end = () => { if (rec) { try { rec.stop() } catch (_) {} } };
  mic.addEventListener("pointerdown", start);
  mic.addEventListener("pointerup", end);
  mic.addEventListener("pointercancel", end);
  mic.addEventListener("contextmenu", e => e.preventDefault());
  mic.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) start(e) });
  mic.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") end() });
  return obj;
}

/* ---------- 新增圖卡（家人、管理者） ---------- */
const ADD_CATS = [["care", "家人：照護"], ["food", "家人：飲食"], ["home", "家人：家務"], ["daily", "家人：日常"], ["toElder", "看護：對長輩說（台語）"], ["report", "看護：回報家人"], ["elder", "阿嬤專區"]];

/* 常用圖示：按「圖示」欄會展開這份清單，直接點選 */
const ICON_SETS = [
  ["常用", "💬 👍 👎 ✅ ❌ ❓ ❗ 🙏 ❤️ 😊 😢 😣 😴 🤒 🤕 🤢 🥶 🥵"],
  ["飲食", "🍚 🍜 🥣 🍞 🥚 🍎 🍌 🥬 🍖 🐟 💧 🥛 🍵 ☕ 🧃 🥄 🍽️"],
  ["照護", "💊 💉 🩺 🌡️ 🩹 🦷 👂 👁️ 🦵 🦶 ✋ 🚽 🧻 🚿 🛁 🪥 🧼 🧴 🛏️ ♿ 🦽 🦯"],
  ["家務", "🧹 🧺 👕 🧦 🗑️ 🍳 🛒 🪟 🚪 💡 ❄️ 🔥 🔑 📦"],
  ["日常", "☀️ 🌙 🌧️ ⏰ 📺 📻 📞 📱 🚶 🚗 🚑 🏥 🏠 🌳 👓 💰 🎵 👵 👴"]
];
const iconFieldHTML = id => `<label>圖示<button type="button" class="icon-btn" id="${id}" aria-expanded="false" title="按一下選擇圖示"></button></label>`;
const iconPanelHTML = id => `<div class="icon-pick" id="${id}P" hidden></div>`;

/* 圖示選擇器：root 內要有 iconFieldHTML(id) 和 iconPanelHTML(id)；回傳取得目前圖示的函式。
   withSvg 為 true 時多列出內建的尿布圖（只給管理者的編輯畫面用） */
function bindIconPicker(root, id, value, withSvg) {
  const btn = root.querySelector("#" + id), box = root.querySelector("#" + id + "P");
  let cur = String(value || "").trim() || "💬";
  const sets = ICON_SETS.map(s => [s[0], s[1].split(" ")]);
  if (withSvg) sets[2][1] = sets[2][1].concat(Object.keys(ICONS).map(k => "svg:" + k));
  box.innerHTML = sets.map(s => `<h4>${s[0]}</h4><div class="set">${s[1].map(v => `<button type="button" data-v="${esc(v)}">${iconHTML(v)}</button>`).join("")}</div>`).join("") +
    `<label>找不到想要的？自己輸入表情符號<input maxlength="8" autocomplete="off"></label>`;
  const own = box.querySelector("input");
  const show = () => {
    btn.innerHTML = `<span class="em" aria-hidden="true">${iconHTML(cur)}</span><small>更換</small>`;
    box.querySelectorAll("button[data-v]").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === cur ? "true" : "false"));
  };
  const toggle = open => { box.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false") };
  btn.onclick = () => toggle(box.hidden);
  box.querySelectorAll("button[data-v]").forEach(b => b.onclick = () => { cur = b.dataset.v; own.value = ""; show(); toggle(false) });
  own.oninput = () => { const v = own.value.trim(); if (v) { cur = v; show() } };
  show();
  return () => cur;
}

/* 中文打完（離開欄位）就自動帶出印尼文；手動改過的印尼文不會被蓋掉，要重翻請按「自動翻譯」 */
function bindTranslate(zh, idn, btn) {
  let auto = "", lastZh = zh.value.trim();
  const run = async manual => {
    const z = zh.value.trim();
    if (!z) { if (manual) toast("請先輸入中文"); return }
    if (!manual && (z === lastZh || (idn.value.trim() && idn.value !== auto))) return;
    lastZh = z;
    btn.disabled = true; btn.textContent = "翻譯中…";
    try { const r = await api("translate", { text: z, from: "zh-TW", to: "id" }); if (zh.value.trim() === z) idn.value = auto = r.text }
    catch (err) { if (manual && state.token) toast(errPair(err)[0]) }
    btn.disabled = false; btn.textContent = "自動翻譯";
  };
  btn.onclick = () => run(true);
  zh.addEventListener("change", () => run(false));
}

/* 把後端回傳的卡片放進本機資料 */
async function applyCard(card, version) {
  const i = state.data.cards.findIndex(c => c.id === card.id);
  if (i >= 0) state.data.cards[i] = card; else if (hasCat(card.cat)) state.data.cards.push(card);
  state.data.cards.sort((a, b) => a.sort - b.sort);
  if (version) state.data.data_version = version;
  await saveData(state.data);
}

function renderAdd(m) {
  const admin = state.role === "admin";
  const p = h("div", "panel", `<h3>新增圖卡</h3><p>生活中遇到常用但沒有的句子，可以自己加。${admin ? "管理者新增的圖卡會直接生效。" : "送出後要等管理者審核，審核前只有家人看得到。"}圖示按一下就能從常用圖示裡挑；中文打完後會自動帶出印尼文，重要句子建議請看護確認看得懂。</p>
    <div class="form">
      <div class="two">${iconFieldHTML("nE")}<label>放在哪一組<select id="nC">${ADD_CATS.map(c => `<option value="${c[0]}">${c[1]}</option>`).join("")}</select></label></div>
      ${iconPanelHTML("nE")}
      <label>中文<input id="nZ" maxlength="200" placeholder="例如：幫阿公倒茶"></label>
      <label>印尼文<input id="nI" class="idn" lang="id" maxlength="300" placeholder="Bahasa Indonesia"></label>
      <label class="chk"><input type="checkbox" id="nQ"> 這是「要不要／是不是」的問句</label>
      <div class="btns" style="margin-top:4px"><button class="btn" id="nT">自動翻譯</button><button class="btn solid" id="nS">新增圖卡</button></div>
    </div>`);
  m.appendChild(p);
  const q = id => p.querySelector(id);
  const icon = bindIconPicker(p, "nE", "💬");
  bindTranslate(q("#nZ"), q("#nI"), q("#nT"));
  q("#nS").onclick = async e => {
    const z = q("#nZ").value.trim(), i = q("#nI").value.trim();
    if (!z || !i) { toast("中文和印尼文都要填"); return }
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api("addCard", { cat: q("#nC").value, icon: icon(), zh: z, id_text: i, is_question: q("#nQ").checked });
      await applyCard(r.card, r.data_version);
      toast(admin ? "已新增圖卡" : "已送出，等管理者審核");
      render();
    } catch (err) { b.disabled = false; if (state.token) toast(errPair(err)[0]) }
  };
  const mine = state.data.cards.filter(c => c.status === "pending");
  if (mine.length) {
    const p2 = h("div", "panel", `<h3>等待審核的圖卡（${mine.length}）</h3><div class="list"></div>`);
    mine.forEach(c => p2.querySelector(".list").appendChild(h("div", "rowi", `<span class="em" aria-hidden="true" style="font-size:2rem;display:inline-flex">${iconHTML(c.icon)}</span><div class="t">${esc(c.zh)}<small class="idn">${esc(c.id_text)}</small></div><span class="s">${esc(catOf(c.cat).zh)}</span>`)));
    m.appendChild(p2);
  }
}

/* ---------- 建議修正印尼文（看護） ---------- */
let allCards = null;   // 全部圖卡（含看護平常看不到的分類），只放在記憶體
async function renderSuggest(m) {
  m.appendChild(h("div", "panel", `<h3 class="idn">Periksa terjemahan <small style="font-family:var(--zh);font-weight:400">確認印尼文</small></h3><p class="idn" style="margin:0">Tolong baca setiap kartu. Jika kalimatnya sudah benar dan mudah dimengerti, tekan “✓ Benar”. Jika aneh atau salah, tekan “✏️ Perbaiki” dan tulis kalimat yang lebih baik. Keluarga akan memeriksanya.</p>`));
  if (!allCards) {
    const wait = h("p", "hint idn"); wait.textContent = "Memuat…"; m.appendChild(wait);
    try { allCards = await api("allCards") }
    catch (e) { if (state.token) { const p = errPair(e); wait.textContent = p[1] + " · " + p[0] } return }
    if (state.tab !== "sug") return;
    wait.remove();
  }
  const ok = new Set(LS.get(K.ok, [])), sent = new Set(LS.get(K.sent, []));
  const head = h("p", "hint idn"); m.appendChild(head);
  const count = () => { head.textContent = `Sudah diperiksa ${allCards.cards.filter(c => ok.has(c.id) || sent.has(c.id)).length} / ${allCards.cards.length}` };
  count();
  allCards.categories.forEach(cat => {
    const cards = allCards.cards.filter(c => c.cat === cat.key);
    if (!cards.length) return;
    const box = h("div", "panel");
    const hd = tint(h("h3"), cat.color); hd.style.color = "var(--c)"; hd.innerHTML = `<span class="idn">${esc(cat.id_text)}</span> <small style="font-family:var(--zh);font-weight:400;color:var(--muted)">${esc(cat.zh)}</small>`;
    const list = h("div", "list");
    cards.forEach(c => {
      const row = h("div", "rowi wrap", `<span class="em" aria-hidden="true" style="font-size:2rem;display:inline-flex">${iconHTML(c.icon)}</span><div class="t idn" style="font-size:1.1rem;font-weight:700">${esc(c.id_text)}<small style="font-family:var(--zh);font-weight:400">${esc(c.zh)}</small></div>`);
      const st = h("span", "s"), bOk = h("button", "sm"), bFix = h("button", "sm");
      const draw = () => {
        st.textContent = sent.has(c.id) ? "Saran terkirim" : ok.has(c.id) ? "✓ Benar" : "";
        st.className = "s idn" + (ok.has(c.id) || sent.has(c.id) ? " ok" : "");
        bOk.className = "sm idn" + (ok.has(c.id) ? " solid" : "");
      };
      bOk.textContent = "✓ Benar"; bFix.textContent = "✏️ Perbaiki"; bFix.className = "sm idn";
      bOk.onclick = () => { ok.has(c.id) ? ok.delete(c.id) : ok.add(c.id); LS.set(K.ok, [...ok]); draw(); count() };
      bFix.onclick = () => openSuggest(c, () => { sent.add(c.id); LS.set(K.sent, [...sent]); draw(); count() });
      row.append(st, bOk, bFix);
      draw();
      list.appendChild(row);
    });
    box.append(hd, list);
    m.appendChild(box);
  });
}

function openSuggest(c, onSent) {
  const sh = $("#sheet"); sh.classList.remove("tint"); sh.style.setProperty("--c", "var(--accent)");
  sh.innerHTML = `<div class="big2">${esc(c.zh)}</div><div class="note idn">Sekarang: ${esc(c.id_text)}</div>
    <label class="form" style="margin-top:14px"><span class="idn" style="font-weight:700">Kalimat yang lebih baik <small style="font-family:var(--zh);font-weight:400">建議的印尼文</small></span><textarea id="sg" class="idn" lang="id" rows="3" maxlength="300"></textarea></label>
    <div class="btns"><button class="btn solid idn" id="sk">Kirim 送出</button><button class="btn idn" id="sc">Batal 取消</button></div>`;
  const ta = sh.querySelector("#sg"); ta.value = c.id_text;
  sh.querySelector("#sc").onclick = closeSheet;
  sh.querySelector("#sk").onclick = async e => {
    const v = ta.value.trim();
    if (!v || v === c.id_text) { toast("Tulis kalimat yang berbeda dulu"); return }
    const b = e.currentTarget; b.disabled = true;
    try { await api("suggest", { card_id: c.id, new_text: v }); toast("Terima kasih! Saran sudah dikirim ke keluarga."); closeSheet(); onSent() }
    catch (err) { b.disabled = false; if (state.token) toast(errPair(err)[1]) }
  };
  $("#ov").classList.add("open");
  sh.scrollTop = 0;
  ta.focus();
}

/* ---------- 管理（管理者） ---------- */
let pending = null, adminCat = "";

function renderAdmin(m) {
  // ---- 待審核 ----
  const p1 = h("div", "panel", `<h3>待審核</h3><p>家人新增的圖卡，以及看護建議的印尼文。</p><div id="pd"><p class="hint" style="margin:0">讀取中…</p></div><div class="btns"><button class="btn" id="pr">重新整理</button></div>`);
  m.appendChild(p1);
  const pd = p1.querySelector("#pd");
  const load = async () => {
    try { pending = await api("listPending") } catch (e) { if (state.token) pd.innerHTML = `<p class="hint" style="margin:0;color:var(--emg)">${esc(errPair(e)[0])}</p>`; return }
    if (state.tab === "admin") drawPending();
  };
  const drawPending = () => {
    pd.innerHTML = "";
    if (!pending.cards.length && !pending.suggestions.length) { pd.innerHTML = '<p class="hint" style="margin:0">目前沒有待審核的項目。</p>'; return }
    const list = h("div", "list"); pd.appendChild(list);
    pending.cards.forEach(c => {
      const row = h("div", "rowi wrap", `<span class="em" aria-hidden="true" style="font-size:2rem;display:inline-flex">${iconHTML(c.icon)}</span><div class="t"><b>新圖卡</b>（${esc(catOf(c.cat).zh)}）<br>${esc(c.zh)}<small class="idn">${esc(c.id_text)}</small></div>`);
      const act = async (b, changes, msg) => {
        b.disabled = true;
        try { const r = await api("updateCard", Object.assign({ id: c.id }, changes)); await applyCard(r.card, r.data_version); toast(msg); pending.cards = pending.cards.filter(x => x.id !== c.id); drawPending() }
        catch (e) { b.disabled = false; if (state.token) toast(errPair(e)[0]) }
      };
      const ok = h("button", "sm solid"); ok.textContent = "通過"; ok.onclick = () => act(ok, { status: "active" }, "已通過，圖卡生效");
      const ed = h("button", "sm"); ed.textContent = "編輯"; ed.onclick = () => openEditor(c, load);
      const no = h("button", "sm"); no.textContent = "不採用"; no.onclick = () => act(no, { status: "hidden" }, "已設為隱藏");
      row.append(ok, ed, no);
      list.appendChild(row);
    });
    pending.suggestions.forEach(sg => {
      const card = cardById(sg.card_id);
      const row = h("div", "rowi wrap", `<div class="t"><b>印尼文建議</b>（${esc((ROLE_NAMES[sg.by_role] || [sg.by_role])[0])}）<br>${esc(card ? card.zh : sg.card_id)}<small class="idn">原本：${esc(sg.old_text)}</small><span class="idn" style="display:block;font-weight:700">建議：${esc(sg.new_text)}</span></div>`);
      const act = async (b, accept) => {
        b.disabled = true;
        try {
          const r = await api("reviewSuggestion", { row: sg.row, accept });
          if (accept && card) { card.id_text = sg.new_text; state.data.data_version = r.data_version; await saveData(state.data) }
          toast(accept ? "已接受，圖卡印尼文已更新" : "已拒絕");
          pending.suggestions = pending.suggestions.filter(x => x.row !== sg.row); drawPending();
        } catch (e) { b.disabled = false; if (state.token) toast(errPair(e)[0]) }
      };
      const ok = h("button", "sm solid"); ok.textContent = "接受"; ok.onclick = () => act(ok, true);
      const no = h("button", "sm"); no.textContent = "拒絕"; no.onclick = () => act(no, false);
      row.append(ok, no);
      list.appendChild(row);
    });
  };
  p1.querySelector("#pr").onclick = load;
  if (pending) drawPending();
  load();

  // ---- 圖卡管理 ----
  const cats = state.data.categories;
  if (!cats.some(c => c.key === adminCat)) adminCat = cats.length ? cats[0].key : "";
  const p2 = h("div", "panel", `<h3>圖卡管理</h3><p>修改文字、圖示、排序，或把不用的圖卡隱藏。也可以直接在試算表的 Cards 分頁修改。</p>
    <div class="form"><label>分類<select id="ac">${cats.map(c => `<option value="${esc(c.key)}"${c.key === adminCat ? " selected" : ""}>${esc(c.zh)}</option>`).join("")}</select></label></div><div class="list" id="al" style="margin-top:8px"></div>`);
  m.appendChild(p2);
  p2.querySelector("#ac").onchange = e => { adminCat = e.target.value; render() };
  state.data.cards.filter(c => c.cat === adminCat).forEach(c => {
    const tag = c.status === "hidden" ? "隱藏" : c.status === "pending" ? "待審核" : "";
    const row = h("div", "rowi", `<span class="em" aria-hidden="true" style="font-size:2rem;display:inline-flex">${iconHTML(c.icon)}</span><div class="t"${c.status === "hidden" ? ' style="opacity:.55"' : ""}>${esc(c.zh)}<small class="idn">${esc(c.id_text)}</small></div><span class="s${tag ? " bad" : ""}">${tag}</span>`);
    const ed = h("button", "sm"); ed.textContent = "編輯"; ed.onclick = () => openEditor(c, render);
    row.appendChild(ed);
    p2.querySelector("#al").appendChild(row);
  });

  // ---- PIN ----
  const p3 = h("div", "panel", `<h3>更改 PIN</h3><p>更改後，該角色的所有裝置都要用新 PIN 重新登入。更換看護時，請更改看護的 PIN。三組 PIN 不可相同。</p>
    <div class="form"><label>角色<select id="pRole"><option value="carer">看護</option><option value="family">家人（含客廳平板）</option><option value="admin">管理者</option></select></label>
    <label>新的 PIN（6 位數字）<input id="pNew" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"></label>
    <div class="btns" style="margin-top:4px"><button class="btn solid" id="pSet">更改 PIN</button></div></div>`);
  m.appendChild(p3);
  p3.querySelector("#pSet").onclick = async e => {
    const role = p3.querySelector("#pRole").value, pin = p3.querySelector("#pNew").value.trim();
    if (!/^\d{6}$/.test(pin)) { toast("PIN 需為 6 位數字"); return }
    const name = ROLE_NAMES[role][0];
    if (!confirm(`確定要更改「${name}」的 PIN 嗎？${role === "admin" ? "這台裝置也會被登出，要用新 PIN 重新登入。" : "該角色的裝置都要重新登入。"}`)) return;
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api("setPin", { role, pin });
      p3.querySelector("#pNew").value = "";
      if (role === "admin") { clearSession(); toast("管理者 PIN 已更改，請用新 PIN 登入"); showLogin(); return }
      toast(`已更改「${name}」的 PIN，${r.revoked} 台裝置需重新登入`);
    } catch (err) { if (state.token) toast(err && err.code === "bad_input" && err.message ? err.message : errPair(err)[0]) }
    b.disabled = false;
  };

  m.appendChild(h("div", "panel", `<h3>使用紀錄</h3><p style="margin:0">每次點圖卡、翻譯、緊急的時間與裝置，記在試算表的 Log 分頁（不記對話內容）。不想記錄時，在 Apps Script 的指令碼屬性新增 <b>LOG_ENABLED</b>，值填 <b>false</b>。</p>`));
}

/* 圖卡編輯浮層（管理者） */
function openEditor(c, onDone) {
  const cats = state.data.categories;
  const sh = tint($("#sheet"), catOf(c.cat).color);
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  sh.innerHTML = `<h3 style="margin:0 0 10px">編輯圖卡</h3><div class="form">
    <div class="two">${iconFieldHTML("eE")}<label>分類<select id="eC">${cats.map(x => opt(x.key, x.zh, c.cat)).join("")}</select></label></div>
    ${iconPanelHTML("eE")}
    <label>中文<input id="eZ" maxlength="200"></label>
    <label>印尼文<input id="eI" class="idn" lang="id" maxlength="300"></label>
    <div class="two" style="grid-template-columns:1fr 1fr"><label>點開時播放<select id="eP">${[["", "依分類預設"], ["id", "印尼語"], ["tw", "台語錄音"], ["zh", "華語"], ["auto", "依角色"]].map(x => opt(x[0], x[1], c.play)).join("")}</select></label>
    <label>狀態<select id="eS">${[["active", "使用中"], ["pending", "待審核"], ["hidden", "隱藏"]].map(x => opt(x[0], x[1], c.status)).join("")}</select></label></div>
    <div class="two" style="grid-template-columns:1fr 1fr"><label>排序（小的在前）<input id="eO" type="number" inputmode="numeric"></label><label class="chk" style="align-self:end;min-height:48px"><input type="checkbox" id="eQ"> 這是問句</label></div>
    <div class="btns" style="margin-top:4px"><button class="btn solid" id="eOk">儲存</button><button class="btn" id="eT">自動翻譯</button><button class="btn" id="eNo">取消</button></div></div>`;
  const q = id => sh.querySelector(id);
  q("#eZ").value = c.zh; q("#eI").value = c.id_text; q("#eO").value = c.sort; q("#eQ").checked = c.is_question;
  const icon = bindIconPicker(sh, "eE", c.icon, true);
  bindTranslate(q("#eZ"), q("#eI"), q("#eT"));
  q("#eNo").onclick = closeSheet;
  q("#eOk").onclick = async e => {
    const zh = q("#eZ").value.trim(), idt = q("#eI").value.trim();
    if (!zh || !idt) { toast("中文和印尼文都要填"); return }
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api("updateCard", { id: c.id, icon: icon(), cat: q("#eC").value, zh, id_text: idt, play: q("#eP").value, status: q("#eS").value, sort: Number(q("#eO").value) || 0, is_question: q("#eQ").checked });
      await applyCard(r.card, r.data_version);
      toast("已儲存");
      closeSheet();
      if (onDone) onDone();
    } catch (err) { b.disabled = false; if (state.token) toast(errPair(err)[0]) }
  };
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
    "「阿嬤」：長輩點卡片，播印尼語給看護聽。「家人」：交辦事情，播印尼語。「對話」：按住 🎙 說話，放開就翻譯給對方聽。「錄音」：用台語錄下「對長輩說」的句子，看護點卡片時會播您的聲音。「新增圖卡」：加上常用但沒有的句子。上方會依時間表顯示現在這個時段常用的句子。紅色「緊急」按鈕隨時可用，會顯示處理步驟。沒有網路時，圖卡、發音、台語錄音和緊急步驟仍可使用。",
    "Ketuk kartu untuk memutar suara. “Bicara ke Nenek / Kakek” diputar dalam bahasa Taiwan (rekaman keluarga). “Lapor ke Keluarga” diputar dalam bahasa Mandarin. “Percakapan”: tahan tombol 🎙 sambil bicara, lepas untuk menerjemahkan. “Perbaikan”: periksa kalimat bahasa Indonesia di setiap kartu. Di bagian atas ada kartu yang sering dipakai pada jam ini. Tombol merah “Darurat” selalu bisa dipakai dan menampilkan langkah-langkahnya. Tanpa internet, kartu dan suara tetap bisa dipakai.")}</p>`));
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
