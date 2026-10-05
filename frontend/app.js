/* 厝內溝通板：前端主程式（階段 2：登入、圖卡、時段提示、緊急、發音） */
"use strict";

/* ---------- 設定與本機儲存 ---------- */
const API_URL = (window.CUENEI_CONFIG && window.CUENEI_CONFIG.API_URL) || "";
const K = { token: "cb-token", role: "cb-role", dev: "cb-device-id", label: "cb-device-label", data: "cb-data", tab: "cb-tab", wake: "cb-wake" };
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

/* 各分頁包含的分類，以及各角色看得到的分頁 */
const TAB_DEFS = {
  elder:  { zh: "阿嬤", id: "Nenek", cats: ["elder"] },
  family: { zh: "家人", id: "Keluarga", cats: ["care", "food", "home", "daily"] },
  carer:  { zh: "看護", id: "Perawat", cats: ["toElder", "report"] },
  set:    { zh: "設定", id: "Pengaturan", cats: [] }
};
const ROLE_TABS = { board: ["elder", "family", "set"], family: ["family", "set"], carer: ["carer", "set"], admin: ["elder", "family", "carer", "set"] };
const ROLE_NAMES = { admin: ["管理者", "Admin"], family: ["家人", "Keluarga"], carer: ["看護", "Perawat"], board: ["客廳平板", "Tablet ruang tamu"] };

const state = {
  token: LS.get(K.token, ""), role: LS.get(K.role, ""), label: LS.get(K.label, ""),
  data: LS.get(K.data, null), tab: LS.get(K.tab, ""), cat: "all", setUnlocked: false
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
  state.token = ""; state.role = ""; state.data = null; state.setUnlocked = false;
  [K.token, K.role, K.data, K.tab].forEach(LS.del);
}

/* ---------- 資料 ---------- */
const catOf = key => (state.data.categories.find(c => c.key === key)) || { key, zh: key, id_text: key, color: "#5b6b73", default_play: "id" };
const cardById = id => state.data.cards.find(c => c.id === id);
const cardsOf = key => state.data.cards.filter(c => c.cat === key && c.status !== "hidden");
const hasCat = key => state.data.categories.some(c => c.key === key);

/* 與後端比對版本，不同才重新下載；回傳資料是否有更新 */
async function sync(force) {
  if (!force && state.data) {
    const v = await api("version");
    if (v.data_version === state.data.data_version) return false;
  }
  const d = await api("bootstrap");
  state.data = d; state.role = d.role;
  LS.set(K.data, d); LS.set(K.role, d.role);
  return true;
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
/* 播台語錄音。錄音同步在階段 3 加入，目前一律先用華語代替 */
function playTw(card) {
  speak(card.zh, "zh-TW");
  toast(t("這張還沒有台語錄音，先用華語播放", "Belum ada rekaman bahasa Taiwan, diputar dalam bahasa Mandarin"));
}

/* ---------- 分頁與圖卡 ---------- */
function tabsForRole() { return (ROLE_TABS[state.role] || ["set"]).filter(k => k === "set" || TAB_DEFS[k].cats.some(hasCat)) }

function renderTabs() {
  const n = $("#tabs"); n.innerHTML = "";
  tabsForRole().forEach(k => {
    const d = TAB_DEFS[k], b = h("button");
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", state.tab === k);
    b.innerHTML = state.role === "carer" ? `<span class="idn">${d.id}</span><small style="font-family:var(--zh)">${d.zh}</small>` : `${d.zh}<small>${d.id}</small>`;
    b.onclick = () => { stopAll(); state.tab = k; state.cat = "all"; state.setUnlocked = false; LS.set(K.tab, k); render(); window.scrollTo(0, 0) };
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
    (c.status === "pending" ? '<span class="tag">待審核</span>' : "");
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
  if (!tabs.includes(state.tab)) state.tab = tabs[0];
  renderTabs();
  const m = $("#main"); m.innerHTML = "";
  if (state.tab === "set") { renderSettings(m); return }
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
function closeSheet() { stopAll(); $("#ov").classList.remove("open"); if (appStarted) activePad = null }
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
  if (play === "tw" || c.cat === "emg") mk("🔊 台語 Taiwan", "", () => playTw(c));
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

/* ---------- PIN 鍵盤（登入與平板設定共用） ---------- */
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
      if (d.bootstrap) { state.data = d.bootstrap; LS.set(K.data, d.bootstrap) }   // 登入時已附上資料
    } catch (e) { const p = errPair(e); return p[0] + " · " + p[1] }
    activePad = null;
    if (!state.label) showNaming(); else if (state.data) startApp(); else firstLoad();
    return null;
  });
  g.appendChild(activePad.el);
  m.appendChild(g);
}

function showNaming() {
  const m = $("#main"); m.innerHTML = "";
  const presets = { board: ["客廳平板"], carer: ["HP Perawat（看護手機）"], family: ["家人手機", "家人平板"], admin: ["管理者手機", "管理者電腦"] }[state.role] || [];
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
    api("setLabel", { device_label: name }).catch(() => {});
    if (state.data) startApp(); else firstLoad();
  };
}

/* 第一次下載資料（階段 3 會在這裡加上錄音下載的進度） */
async function firstLoad() {
  const m = $("#main"); m.innerHTML = "";
  const g = h("div", "gate", `<h2>下載資料中…</h2><p class="sub">Mengunduh data…</p><div class="progress"><i id="pg"></i></div><div class="pin-msg" id="lm"></div>`);
  m.appendChild(g);
  const bar = g.querySelector("#pg");
  requestAnimationFrame(() => { bar.style.width = "35%" });
  try {
    await sync(true);
    bar.style.width = "100%";
    startApp();
  } catch (e) {
    if (!state.token) return;   // 權杖失效時已回到 PIN 畫面
    const p = errPair(e);
    g.querySelector("#lm").textContent = p[0] + " · " + p[1];
    const b = h("button", "btn solid"); b.textContent = "再試一次 · Coba lagi"; b.onclick = firstLoad;
    g.appendChild(b);
  }
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
  if (state.role === "board") {
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
  if (state.role !== "board" || !LS.get(K.wake, true) || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
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
  // 客廳平板放在公共空間，進設定前要再輸入管理者或家人的 PIN
  if (state.role === "board" && !state.setUnlocked) {
    const p = h("div", "panel", `<h3>設定已上鎖</h3><p>請輸入管理者或家人的 PIN。</p><div class="btns" style="margin-top:0"><button class="btn solid" id="ul">輸入 PIN</button></div>`);
    p.querySelector("#ul").onclick = openUnlock;
    m.appendChild(p);
    return;
  }
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

  // ---- 客廳平板：螢幕常亮 ----
  if (state.role === "board") {
    const on = LS.get(K.wake, true), sup = "wakeLock" in navigator;
    const p2 = h("div", "panel", `<h3>螢幕常亮</h3><p>${sup ? "開啟後，平板停在這個頁面時螢幕不會自動關閉。每天凌晨 3:00 會自動重新整理一次。" : "這個瀏覽器不支援螢幕常亮，請到平板的系統設定把螢幕逾時調長。"}</p><div class="btns" style="margin-top:0"><button class="btn${on ? " solid" : ""}" id="bWake" ${sup ? "" : "disabled"}>${on ? "已開啟（點一下關閉）" : "已關閉（點一下開啟）"}</button></div>`);
    p2.querySelector("#bWake").onclick = () => { LS.set(K.wake, !on); releaseWake(); applyWake(); render() };
    m.appendChild(p2);
  }

  // ---- 使用說明 ----
  m.appendChild(h("div", "panel", `<h3>${t("使用說明", "Cara pakai")}</h3><p style="margin:0">${t(
    "「阿嬤」：長輩點卡片，播印尼語給看護聽。「家人」：交辦事情，播印尼語。「看護」：介面以印尼文為主，「對長輩說」播家人錄的台語，「回報家人」播華語。上方會依時間表顯示現在這個時段常用的句子。紅色「緊急」按鈕隨時可用，會顯示處理步驟。",
    "Ketuk kartu untuk memutar suara. “Bicara ke Nenek / Kakek” diputar dalam bahasa Taiwan (rekaman keluarga). “Lapor ke Keluarga” diputar dalam bahasa Mandarin. Di bagian atas ada kartu yang sering dipakai pada jam ini. Tombol merah “Darurat” selalu bisa dipakai dan menampilkan langkah-langkahnya.")}</p>`));
}

/* 平板設定解鎖：用 PIN 向後端登入一次確認角色，確認後立刻把那個權杖登出 */
function openUnlock() {
  const sh = $("#sheet"); sh.classList.remove("tint"); sh.style.setProperty("--c", "var(--accent)");
  sh.innerHTML = `<div class="gate" style="padding-top:0"><h2>請輸入管理者或家人的 PIN</h2></div>`;
  activePad = pinPad(async pin => {
    let d;
    try { d = await api("login", { pin, device_id: deviceId(), device_label: state.label }) }
    catch (e) { return errPair(e)[0] }
    fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "logout", token: d.token }) }).catch(() => {});
    if (d.role !== "admin" && d.role !== "family") return "這組 PIN 不能開啟設定";
    state.setUnlocked = true;
    closeSheet(); render();
    return null;
  });
  const g = sh.querySelector(".gate");
  g.appendChild(activePad.el);
  const c = h("div", "btns"); c.style.justifyContent = "center";
  const b = h("button", "btn"); b.textContent = "取消"; b.onclick = closeSheet; c.appendChild(b);
  g.appendChild(c);
  $("#ov").classList.add("open");
}

/* ---------- 啟動 ---------- */
showOffline();
if (!API_URL) {
  $("#main").appendChild(h("div", "panel", "<h3>尚未設定後端網址</h3><p style='margin:0'>請在 config.js 填入 API_URL。</p>"));
} else if (!state.token) {
  showLogin();
} else if (state.data) {
  startApp();        // 有快取就直接進入，背景再比對版本
  syncQuietly();
} else if (!state.label) {
  showNaming();
} else {
  firstLoad();
}
