/* ============ 每日合併推送：神對話每日迭代 + 頻道數據，傳到小乖對話（LINE 與 Telegram） ============
   9:15：頻道數據更新（chanDailyJob 寫進試算表，並把要傳的文字暫存在 CHAN_DAILY_MSG，不直接傳）。
   排程 9:15：把當天的神對話摘要寫進試算表「神對話每日摘要」分頁（A 日期、B 摘要、C 劇本網址、D 推送時間，D 空白代表還沒傳）。
   9:30 左右：shenDailyPush 把今天的頻道數據與還沒傳的摘要合併成「一則」訊息傳出，傳完在 D 欄寫上時間，避免重複。 */
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
  return '神對話每日摘要：已設定，每天 9:30 左右與頻道數據合併傳出。';
}

// 由時間觸發器執行（9:30）：頻道數據（今天的）＋還沒傳的摘要，合併成一則訊息傳到 LINE 與 Telegram
function shenDailyPush() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const cm = JSON.parse(prop_('CHAN_DAILY_MSG') || 'null');
  const chanText = cm && cm.d === today ? cm.t : '';
  const sh = ss_().getSheetByName(SHEN_DAILY_SHEET);
  const pending = [];
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach((r, i) => {
      const body = String(r[1] || '').trim();
      if (body && !String(r[3] || '').trim()) pending.push({ row: i + 2, date: r[0], body: body, url: String(r[2] || '').trim() });
    });
  }
  if (!chanText && !pending.length) return;
  const parts = [];
  if (chanText) parts.push(chanText);
  pending.forEach(p => parts.push('🌿 神對話每日迭代（' + p.date + '）\n\n' + p.body + (p.url ? '\n\n📜 劇本網址：' + p.url : '')));
  const msg = parts.join('\n\n━━━━━━━━\n\n');
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  try {
    // 太長就分成數則依序傳，不切掉後面的內容（LINE 單則上限 5000 字，Telegram 單則上限 4096 字）
    if (owner) shenChunks_(msg, 4800).forEach(t => push_(owner, t));
    if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) shenChunks_(msg, 3800).forEach(t => tgSend_(tgOwner, t));
    const now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
    pending.forEach(p => sh.getRange(p.row, 4).setValue(now));
    if (chanText) setProp_('CHAN_DAILY_MSG', '');
  } catch (e) { console.error('每日合併推送失敗：' + e); }
}

// 把長訊息依段落（空行）切成數段，每段不超過 max 字；單一段超過時依字元切（不切斷表情符號）
function shenChunks_(text, max) {
  const out = [];
  let cur = '';
  String(text).split('\n\n').forEach(p => {
    const add = cur ? '\n\n' + p : p;
    if (cur.length + add.length <= max) { cur += add; return; }
    if (cur) out.push(cur);
    cur = '';
    if (p.length <= max) { cur = p; return; }
    let buf = '';
    Array.from(p).forEach(ch => {
      if ((buf + ch).length > max) { out.push(buf); buf = ''; }
      buf += ch;
    });
    cur = buf;
  });
  if (cur) out.push(cur);
  return out;
}
