/* ============ 神對話每日迭代結果：傳到小乖對話（LINE 與 Telegram） ============
   排程每天 9:15 左右把當天的摘要寫進試算表「神對話每日摘要」分頁（A 日期、B 摘要、C 劇本網址、D 推送時間，D 空白代表還沒傳）。
   這個函式每天 9:30 左右執行：讀到 D 欄空白的一筆就傳出去，傳過後在 D 欄寫上時間，避免重複傳。 */
const SHEN_DAILY_SHEET = '神對話每日摘要';

// 只需要執行一次（在編輯器選「shenDailyOn」按執行）：建立分頁與標題列，並設定每天 9:30 的時間觸發器
function shenDailyOn() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEN_DAILY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEN_DAILY_SHEET);
    sh.appendRow(['日期', '摘要', '劇本網址', '推送時間']);
    sh.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'shenDailyPush').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('shenDailyPush').timeBased().everyDays(1).atHour(9).nearMinute(30).inTimezone('Asia/Taipei').create();
  return '神對話每日摘要：已設定，每天 9:30 左右傳出。';
}

// 由時間觸發器執行：把 D 欄空白的摘要傳到 LINE 與 Telegram，傳完標記時間
function shenDailyPush() {
  const sh = ss_().getSheetByName(SHEN_DAILY_SHEET);
  if (!sh) return;
  const last = sh.getLastRow();
  if (last < 2) return;
  const rows = sh.getRange(2, 1, last - 1, 4).getValues();
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  rows.forEach((r, i) => {
    const date = r[0], body = String(r[1] || '').trim(), sent = String(r[3] || '').trim();
    if (!body || sent) return;
    const msg = '🌿 神對話每日迭代（' + date + '）\n\n' + body + '\n\n📜 劇本網址：' + (String(r[2] || '').trim() || SHEN_SCRIPT_URL);
    try {
      if (owner) push_(owner, msg.slice(0, 4900));
      if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) tgSend_(tgOwner, msg.slice(0, 4000));
      sh.getRange(i + 2, 4).setValue(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm'));
    } catch (e) { console.error('神對話每日摘要推送失敗：' + e); }
  });
}
