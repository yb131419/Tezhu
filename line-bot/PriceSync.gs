/* ============ 每日價目表同步：產品價目表 → 小乖「價目表」分頁（PV、金額） ============
   來源：試算表「產品價目表」分頁（欄位：品項｜數量｜PV｜金額）。
   每天 8:30 比對，PV 或金額有變動就更新小乖的「價目表」，原值寫進「價目更新紀錄」分頁，並推播到 LINE 與 Telegram。
   保留不動的：每盒顆數（來源沒有這欄）；來源沒有、只在小乖有的品項（不刪除，只列出提醒）。
   新增品項（來源有、小乖沒有）會加進去，每盒顆數預設 90。 */
const SRC_PRICE_SS_ID = '1uGR3C4eUPE0M9J9THJY8266uaGmwopYgaoMz_ROJ3wQ';
const SRC_PRICE_SHEET = '產品價目表';
const PRICE_LOG_SHEET = '價目更新紀錄';

// 只需要執行一次（在編輯器選「priceSyncOn」按執行）：建立紀錄分頁，並設定每天 8:30 的時間觸發器
function priceSyncOn() {
  const ss = ss_();
  if (!ss.getSheetByName(PRICE_LOG_SHEET)) {
    const sh = ss.insertSheet(PRICE_LOG_SHEET);
    sh.appendRow(['日期', '品項', '類型', '舊PV', '舊金額', '新PV', '新金額']);
    sh.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'priceSyncRun').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('priceSyncRun').timeBased().everyDays(1).atHour(8).nearMinute(30).inTimezone('Asia/Taipei').create();
  return '價目表每日同步：已設定，每天 8:30 比對並更新。';
}

// 由時間觸發器執行（8:30），也可以在編輯器手動執行測試
function priceSyncRun() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  let src;
  try {
    src = readPriceSource_();
  } catch (e) {
    console.error('價目表同步：讀取來源失敗：' + e);
    notifyOwner_('⚠️ 價目表同步失敗：讀不到「產品價目表」，今天沒有更新。請確認試算表還在、分頁名稱沒改。');
    return;
  }
  // 來源有效列太少，多半是讀到空白或格式錯，直接停止，避免把價目表清空
  if (src.length < 20) {
    console.error('價目表同步：來源只讀到 ' + src.length + ' 筆，中止。');
    notifyOwner_('⚠️ 價目表同步中止：「產品價目表」只讀到 ' + src.length + ' 筆品項，今天沒有更新，請檢查來源。');
    return;
  }

  const sh = ss_().getSheetByName('價目表');
  if (!sh) {
    console.error('價目表同步：找不到「價目表」分頁（需先在小乖試算一次，讓它自動建立）。');
    return;
  }
  const last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 4).getValues() : [];
  const bot = {};
  rows.forEach((r, i) => {
    const k = normPriceName_(r[0]);
    if (k) bot[k] = { row: i + 2, name: String(r[0]).trim(), pv: toNum_(r[1]), price: toNum_(r[2]), perBox: r[3] };
  });

  const changes = [];
  const srcKeys = {};
  src.forEach(s => {
    const k = normPriceName_(s.name);
    srcKeys[k] = true;
    const b = bot[k];
    if (!b) {
      sh.appendRow([s.name, s.pv, s.price, 90]);
      changes.push({ name: s.name, type: '新增', oPv: '', oPrice: '', nPv: s.pv, nPrice: s.price });
    } else if (b.pv !== s.pv || b.price !== s.price) {
      sh.getRange(b.row, 2, 1, 2).setValues([[s.pv, s.price]]);
      changes.push({ name: b.name, type: '更新', oPv: b.pv, oPrice: b.price, nPv: s.pv, nPrice: s.price });
    }
  });
  const gone = Object.keys(bot).filter(k => !srcKeys[k]).map(k => bot[k].name);

  if (changes.length) {
    const log = ss_().getSheetByName(PRICE_LOG_SHEET);
    if (log) log.getRange(log.getLastRow() + 1, 1, changes.length, 7).setValues(
      changes.map(c => [today, c.name, c.type, c.oPv, c.oPrice, c.nPv, c.nPrice]));
  }
  // 沒有價格變動就不推播（只有來源缺品項時也不推，避免每天重複打擾）
  if (!changes.length) {
    console.log('價目表同步：' + today + ' 沒有變動，不推播。');
    return;
  }
  const lines = ['💰 價目表有更新（' + today + '）', '', '已更新 ' + changes.length + ' 項：'];
  changes.forEach(c => {
    if (c.type === '新增') lines.push('・' + c.name + '（新增）PV ' + c.nPv + '／金額 ' + c.nPrice);
    else lines.push('・' + c.name + '：PV ' + c.oPv + '→' + c.nPv + '，金額 ' + c.oPrice + '→' + c.nPrice);
  });
  if (gone.length) lines.push('', '來源表已沒有、小乖仍保留的品項（未刪除，請確認）：' + gone.join('、'));
  lines.push('', '舊價格都記在「價目更新紀錄」分頁，可查回。');
  notifyOwner_(lines.join('\n'));
}

// 讀來源分頁，回傳 [{name, pv, price}]；跳過空白列、「下拉點選新增」、0 元的贈品與入會項目
function readPriceSource_() {
  const sh = SpreadsheetApp.openById(SRC_PRICE_SS_ID).getSheetByName(SRC_PRICE_SHEET);
  if (!sh) throw new Error('找不到分頁 ' + SRC_PRICE_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const out = [];
  sh.getRange(2, 1, last - 1, 4).getValues().forEach(r => {
    const name = String(r[0]).trim();
    if (!name || name.indexOf('下拉點選') === 0) return;
    const pv = toNum_(r[2]), price = toNum_(r[3]);
    if (!pv && !price) return;
    out.push({ name: name, pv: pv, price: price });
  });
  return out;
}

// 比對用：全形轉半形（含全形括號、全形數字）、去空白
function normPriceName_(v) {
  return String(v || '').normalize('NFKC').replace(/\s+/g, '');
}
function toNum_(v) {
  return Number(String(v).normalize('NFKC').replace(/[,\s]/g, '')) || 0;
}

// 推播到小乖的 LINE 與 Telegram（與神對話每日推送相同的管道）
function notifyOwner_(msg) {
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  try {
    if (owner) push_(owner, msg.slice(0, 4900));
    if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) tgSend_(tgOwner, msg.slice(0, 4000));
  } catch (e) { console.error('價目表同步推播失敗：' + e); }
}

// 版本短碼（tools/stamp_gas.py 自動產生，請勿手動修改）
function gasStampPriceSync_() { return 'e255b7a'; }
