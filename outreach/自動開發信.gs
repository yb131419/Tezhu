/**
 * 自動開發信原型（Google Apps Script + Gemini 免費層）
 *
 * 流程：整理名單（去重、黑名單）→ 產生草稿（Gemini）→ 人工審核 → 定時寄信 → 退訂 → 每日摘要
 * 金鑰只放在指令碼屬性 GEMINI_API_KEY，不寫在程式碼裡。
 * 本程式不做自動爬取，名單請人工貼入「名單」分頁。
 */

const SHEET_LIST = '名單';
const SHEET_UNSUB = '退訂名單';
const SHEET_SETTING = '設定';
const SHEET_SUMMARY = '每日摘要';

const STATUS = {
  WAIT_GEN: '待產生',
  REVIEW: '待審',
  APPROVED: '已核准',
  SENT: '已寄出',
  UNSUB: '已退訂',
  SKIP: '略過'
};

const LIST_HEADERS = ['ID', '公司名稱', '公開資訊', '產業', '地區', '公開商務信箱', '來源網址', '搜尋日期', '狀態', '草稿主旨', '草稿內容', '核准人', '寄送時間', '錯誤訊息', '退訂代碼'];
const UNSUB_HEADERS = ['信箱', '退訂時間', '來源'];
const SUMMARY_HEADERS = ['日期', '寄出數', '退訂數', '錯誤數'];

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_DRAFTS_PER_RUN = 10;   // 每次執行最多產生幾筆草稿，避免超過 GAS 執行時間上限
const DRAFT_INTERVAL_MS = 3000;  // 每次呼叫 Gemini 之間的間隔
const SEND_INTERVAL_MS = 5000;   // 每封信之間的間隔
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 療效與誇大用語：草稿產生時與寄出前都會檢查，可依產品內容增修
const BANNED_WORDS = ['治癒', '治療', '療效', '根治', '包治', '保證有效', '特效', '無副作用'];

// ===== 選單 =====

function onOpen() {
  SpreadsheetApp.getUi().createMenu('小乖開發信')
    .addItem('1. 整理名單（去重與黑名單）', 'dedupeAndCheckBlacklist')
    .addItem('2. 產生草稿（待產生 → 待審）', 'generateDrafts')
    .addItem('3. 立即寄出已核准信件', 'sendApprovedEmails')
    .addItem('4. 寄出今日摘要', 'sendDailySummary')
    .addSeparator()
    .addItem('建立欄位與觸發器（第一次使用）', 'setupTriggers')
    .addToUi();
}

// ===== 階段 4 前置：觸發器與欄位 =====

// 建立或重建本專案的定時觸發器（會先刪除舊的觸發器）
function setupTriggers() {
  initSheets_();
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('generateDrafts').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('sendApprovedEmails').timeBased().everyDays(1).atHour(10).create();
  ScriptApp.newTrigger('sendDailySummary').timeBased().everyDays(1).atHour(21).create();
}

// 確認各分頁有必要的欄位，缺少的會補在最後面
function initSheets_() {
  ensureHeaders_(sheet_(SHEET_LIST), LIST_HEADERS);
  ensureHeaders_(sheet_(SHEET_UNSUB), UNSUB_HEADERS);
  ensureHeaders_(sheet_(SHEET_SUMMARY), SUMMARY_HEADERS);
}

// ===== 階段 1：去重與黑名單檢查 =====

function dedupeAndCheckBlacklist() {
  initSheets_();
  const list = readTable_(SHEET_LIST);
  const black = getBlacklist_();
  const seen = {};
  const pending = ['', STATUS.WAIT_GEN, STATUS.REVIEW, STATUS.APPROVED];

  list.rows.forEach(function (r) {
    if (!r['公司名稱'] && !r['公開商務信箱']) return;   // 空白列略過
    if (!r['退訂代碼']) markRow_(list, r, { '退訂代碼': makeCode_() });

    const email = normEmail_(r['公開商務信箱']);
    const isDup = !!seen[email];
    seen[email] = true;

    const status = String(r['狀態'] || '');
    if (pending.indexOf(status) < 0) return;    // 已寄出、已退訂、略過不再處理

    let reason = '';
    if (!EMAIL_RE.test(email)) reason = '信箱格式不正確';
    else if (black[email]) reason = '在退訂名單中';
    else if (isDup) reason = '信箱重複';

    if (reason) markRow_(list, r, { '狀態': STATUS.SKIP, '錯誤訊息': reason });
  });
}

// ===== 階段 2：呼叫 Gemini 產生草稿 =====

function generateDrafts() {
  dedupeAndCheckBlacklist();
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('尚未設定 GEMINI_API_KEY，請到「專案設定 → 指令碼屬性」新增');

  const s = getSettings_();
  const list = readTable_(SHEET_LIST);
  const targets = list.rows.filter(function (r) { return r['狀態'] === STATUS.WAIT_GEN; })
    .slice(0, MAX_DRAFTS_PER_RUN);
  let done = 0;

  for (const r of targets) {
    try {
      const draft = callGemini_(apiKey, r, s);
      checkBanned_(draft.subject + draft.body);
      markRow_(list, r, {
        '草稿主旨': draft.subject,
        '草稿內容': draft.body,
        '狀態': STATUS.REVIEW,
        '錯誤訊息': ''
      });
      done++;
    } catch (err) {
      // 失敗時狀態維持「待產生」，錯誤訊息寫在該列
      markRow_(list, r, { '錯誤訊息': err.message });
      if (err.quota) {
        notifyOwner_('Gemini 配額已用完', err.message + '\n已停止本次產生草稿，請明天再試。');
        break;
      }
    }
    Utilities.sleep(DRAFT_INTERVAL_MS);
  }
  return done;
}

function callGemini_(apiKey, row, s) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt_(row, s) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.6 }
    }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code === 429) {
    const e = new Error('Gemini 配額或頻率已達上限（429）');
    e.quota = true;
    throw e;
  }
  if (code !== 200) throw new Error('Gemini 回應錯誤 ' + code + '：' + res.getContentText().slice(0, 200));

  const body = JSON.parse(res.getContentText());
  const candidate = (body.candidates || [])[0];
  if (!candidate || !candidate.content) throw new Error('Gemini 沒有回傳內容（可能被安全規則擋下）');

  const draft = JSON.parse(candidate.content.parts[0].text);
  if (!draft.subject || !draft.body) throw new Error('草稿格式不正確，缺少主旨或內容');
  return { subject: String(draft.subject), body: String(draft.body) };
}

// 提示詞包含合規要求：不得有療效宣稱、必須附退訂方式、寄件人與聯絡資訊
function buildPrompt_(row, s) {
  return [
    '你是專業的商務開發信撰寫人員，請用繁體中文（台灣用語）撰寫一封寄給公司窗口的開發信。',
    '收件公司：' + String(row['公司名稱'] || '') + '（產業：' + String(row['產業'] || '') + '，地區：' + String(row['地區'] || '') + '）',
    '寄件人：' + s.senderName + '，公司：' + s.company,
    '產品定位：' + s.productPositioning,
    '',
    '必須遵守的規定：',
    '1. 不得有任何療效宣稱或醫療保證，不得使用「治癒、治療、根治、保證有效」等用語。',
    '2. 只能根據上述資料撰寫，不可臆測收件公司的健康狀況或任何個人資料。',
    '3. 內文必須附上退訂方式說明，例如：若不希望再收到此類信件，請回覆告知或點擊信末連結退訂。',
    '4. 內文必須包含寄件人名稱、公司名稱與聯絡方式：' + s.contact + '。',
    '5. 語氣專業、簡潔，約 200 字以內，不要使用誇大用語。',
    '',
    '請只回傳 JSON，格式為：{"subject": "主旨", "body": "信件內文（純文字）"}'
  ].join('\n');
}

// ===== 階段 4：寄信（定時觸發） =====

function sendApprovedEmails() {
  const s = getSettings_();
  if (!s.unsubUrl) throw new Error('設定分頁缺少「退訂連結網址」，為合規需要，未設定前不寄信。');

  const today = dayOf_(new Date());
  const black = getBlacklist_();
  const list = readTable_(SHEET_LIST);
  const sentToday = list.rows.filter(function (r) { return dayOf_(r['寄送時間']) === today; }).length;
  let remaining = s.dailyLimit - sentToday;
  const queue = list.rows.filter(function (r) {
    return r['狀態'] === STATUS.APPROVED && !r['寄送時間'];
  });
  let sent = 0;

  for (const r of queue) {
    if (remaining <= 0) break;
    const email = normEmail_(r['公開商務信箱']);

    // 寄信前再次檢查退訂名單
    if (email && getBlacklist_()[email]) {
      markRow_(list, r, { '狀態': STATUS.SKIP, '錯誤訊息': '在退訂名單中，未寄出' });
      continue;
    }

    try {
      sendOne_(r, email, s);
      markRow_(list, r, { '狀態': STATUS.SENT, '寄送時間': new Date(), '錯誤訊息': '' });
      remaining--;
      sent++;
    } catch (err) {
      // 失敗時狀態維持「已核准」，下次可重試
      markRow_(list, r, { '錯誤訊息': err.message });
      if (/quota|too many times/i.test(err.message)) {
        notifyOwner_('Gmail 寄信額度已達上限', err.message + '\n已停止本次寄信。');
        break;
      }
    }
    Utilities.sleep(SEND_INTERVAL_MS);
  }
  return sent;
}

function sendOne_(r, email, s) {
  if (!EMAIL_RE.test(email)) throw new Error('信箱格式不正確');
  if (!r['退訂代碼']) throw new Error('缺少退訂代碼，請先執行「整理名單」');
  const subject = String(r['草稿主旨'] || '');
  const draft = String(r['草稿內容'] || '');
  if (!subject || !draft) throw new Error('草稿為空，無法寄出');
  checkBanned_(subject + draft);

  const body = buildMailBody_(draft, s, String(r['退訂代碼']));
  const options = { name: s.senderName };
  if (s.contact.indexOf('@') >= 0) options.replyTo = s.contact;
  GmailApp.sendEmail(email, subject, body, options);
}

// 信末固定附上寄件人、聯絡方式與退訂連結，即使草稿漏寫也會補上
function buildMailBody_(draft, s, token) {
  const sep = s.unsubUrl.indexOf('?') >= 0 ? '&' : '?';
  return draft.trim() + '\n\n' +
    '------------------------------\n' +
    '寄件人：' + s.senderName + '（' + s.company + '）\n' +
    '聯絡方式：' + s.contact + '\n' +
    '若您不希望再收到此類信件，請點擊以下連結退訂，系統會立即將您排除：\n' +
    s.unsubUrl + sep + 't=' + token + '\n';
}

function checkBanned_(text) {
  const hit = BANNED_WORDS.filter(function (w) { return text.indexOf(w) >= 0; });
  if (hit.length) throw new Error('含有療效或誇大用語：' + hit.join('、') + '，請修改後再寄');
}

// ===== 階段 5：退訂 Web App（doGet） =====

// 部署為網頁應用程式後，退訂連結會指向這裡，網址帶的是不可猜測的退訂代碼
function doGet(e) {
  const token = String((e && e.parameter && e.parameter.t) || '');
  const ok = /^[0-9a-f]{32}$/i.test(token) && unsubscribeByToken_(token);
  const msg = ok
    ? '已完成退訂，之後將不再收到此寄件人的信件。'
    : '退訂連結無效或已失效。若仍需協助，請直接回信告知我們。';
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>退訂</title></head>' +
    '<body style="font-family:sans-serif;padding:16px;line-height:1.6"><h2>' + msg + '</h2></body></html>'
  ).setTitle('退訂');
}

function unsubscribeByToken_(token) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const list = readTable_(SHEET_LIST);
    const row = list.rows.find(function (r) { return String(r['退訂代碼'] || '') === token; });
    if (!row) return false;

    const email = normEmail_(row['公開商務信箱']);
    const unsub = readTable_(SHEET_UNSUB);
    const exists = unsub.rows.some(function (r) { return normEmail_(r['信箱']) === email; });
    if (email && !exists) unsub.sheet.appendRow([email, new Date(), '退訂連結']);

    markRow_(list, row, { '狀態': STATUS.UNSUB });
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ===== 階段 6：每日摘要 =====

function sendDailySummary() {
  const today = dayOf_(new Date());
  const list = readTable_(SHEET_LIST).rows;
  const unsub = readTable_(SHEET_UNSUB).rows;

  const sent = list.filter(function (r) { return dayOf_(r['寄送時間']) === today; }).length;
  const unsubCount = unsub.filter(function (r) { return dayOf_(r['退訂時間']) === today; }).length;
  const errors = list.filter(function (r) { return String(r['錯誤訊息'] || '') !== ''; }).length;

  sheet_(SHEET_SUMMARY).appendRow([today, sent, unsubCount, errors]);

  notifyOwner_(today + ' 每日摘要', [
    '日期：' + today,
    '今日寄出：' + sent + ' 封',
    '今日退訂：' + unsubCount + ' 筆',
    '目前有錯誤訊息的筆數：' + errors + '（請到「名單」分頁查看）'
  ].join('\n'));
}

// ===== 共用工具 =====

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet() ||
    SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
}

function sheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('找不到分頁：' + name);
  return sh;
}

// 讀取「設定」分頁：第一欄為項目，第二欄為值
function getSettings_() {
  const values = sheet_(SHEET_SETTING).getDataRange().getValues();
  const kv = {};
  values.slice(1).forEach(function (r) {
    if (r[0]) kv[String(r[0]).trim()] = String(r[1] || '').trim();
  });
  return {
    dailyLimit: Number(kv['每日寄信上限']) || 20,
    senderName: kv['寄件人名稱'] || '',
    company: kv['公司名稱'] || '',
    contact: kv['聯絡方式'] || '',
    unsubUrl: kv['退訂連結網址'] || '',
    ownerEmail: kv['通知信箱'] || '',
    productPositioning: kv['產品定位'] || ''
  };
}

// 讀取整張表，每列轉成「欄位名稱 → 值」，並記下列號 _row
function readTable_(sheetName) {
  const sh = sheet_(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const rows = values.slice(1).map(function (v, i) {
    const obj = { _row: i + 2 };
    headers.forEach(function (h, j) { obj[h] = v[j]; });
    return obj;
  });
  return { sheet: sh, headers: headers, rows: rows };
}

// 依欄位名稱寫入多個欄位（不靠欄位順序，使用者調整欄位也不會寫錯）
function markRow_(table, row, fields) {
  Object.keys(fields).forEach(function (name) {
    const i = table.headers.indexOf(name);
    if (i < 0) throw new Error('找不到欄位：' + name);
    table.sheet.getRange(row._row, i + 1).setValue(fields[name]);
  });
}

function ensureHeaders_(sh, required) {
  const lastCol = Math.max(1, sh.getLastColumn());
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  required.forEach(function (name) {
    if (headers.indexOf(name) < 0) {
      headers.push(name);
      sh.getRange(1, headers.length).setValue(name);
    }
  });
}

function getBlacklist_() {
  const black = {};
  readTable_(SHEET_UNSUB).rows.forEach(function (r) {
    const e = normEmail_(r['信箱']);
    if (e) black[e] = true;
  });
  return black;
}

function normEmail_(v) {
  return String(v || '').trim().toLowerCase();
}

// 退訂代碼：32 位十六進位隨機字串，不以信箱當參數
function makeCode_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function dayOf_(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// 通知自己的信箱（信箱存放在「設定」分頁，不寫在程式碼裡）
function notifyOwner_(subject, body) {
  const owner = getSettings_().ownerEmail;
  if (!owner) {
    console.warn('未設定通知信箱，略過通知：' + subject);
    return;
  }
  GmailApp.sendEmail(owner, '[小乖開發信] ' + subject, body);
}
