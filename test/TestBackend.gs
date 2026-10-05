/**
 * 厝內溝通板：階段 0 測試用後端
 *
 * 用途：
 *   1. doPost：給 GitHub Pages 上的 test.html（A）跨網域呼叫翻譯，驗證 fetch 能不能通。
 *   2. doGet ：把同一份 test.html 用 HtmlService 送出（B），驗證嵌入頁面的麥克風限制。
 *
 * 這支程式不讀寫試算表、不需要任何 PIN，測完即可刪除部署。
 */

/* 允許的語言代碼（LanguageApp 用 zh-TW 與 id） */
var LANGS = ['zh-TW', 'id'];

/* B：以 HtmlService 送出測試頁（專案內需有名為 test 的 HTML 檔） */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('test')
    .setTitle('厝內溝通板 可行性測試（B：Apps Script）')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* A：跨網域 API 入口。前端以 text/plain 傳 JSON 字串，避免預檢請求 */
function doPost(e) {
  var res;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    res = handle_(req);
  } catch (err) {
    res = fail_('bad_input', String(err && err.message || err));
  }
  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

/* B：給頁面內的 google.script.run 呼叫，行為與 doPost 相同 */
function api(req) {
  try {
    return handle_(req || {});
  } catch (err) {
    return fail_('server', String(err && err.message || err));
  }
}

/* 依 action 分派 */
function handle_(req) {
  if (req.action === 'ping') {
    return ok_({ time: new Date().toISOString() });
  }
  if (req.action === 'translate') {
    var text = String(req.text || '').trim();
    if (!text || text.length > 500) return fail_('bad_input', 'text 需為 1 到 500 字');
    if (LANGS.indexOf(req.from) < 0 || LANGS.indexOf(req.to) < 0 || req.from === req.to) {
      return fail_('bad_input', 'from、to 需為 zh-TW 或 id，且不可相同');
    }
    var t0 = Date.now();
    try {
      var out = LanguageApp.translate(text, req.from, req.to);
      return ok_({ text: out, server_ms: Date.now() - t0 });
    } catch (err) {
      // LanguageApp 超過每日次數時會丟出例外
      return fail_('quota', String(err && err.message || err));
    }
  }
  return fail_('bad_input', '未知的 action：' + req.action);
}

function ok_(data) { return { ok: true, data: data }; }
function fail_(code, message) { return { ok: false, error: { code: code, message: message } }; }

/* 在編輯器中手動執行：確認翻譯可用，並完成第一次授權 */
function testTranslate() {
  Logger.log(JSON.stringify(handle_({ action: 'translate', text: '阿嬤，要吃飯了', from: 'zh-TW', to: 'id' })));
  Logger.log(JSON.stringify(handle_({ action: 'translate', text: 'Nenek sudah minum obat', from: 'id', to: 'zh-TW' })));
}
