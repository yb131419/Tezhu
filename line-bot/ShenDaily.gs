/* ============ 每日合併推送：神對話每日迭代 + 頻道數據，做成一張精緻圖卡傳到小乖對話（LINE 與 Telegram） ============
   9:15：頻道數據更新（chanDailyJob 寫進試算表，並把數字與文字暫存在 CHAN_DAILY_MSG，不直接傳）。
   排程 9:15：把當天的神對話摘要寫進試算表「神對話每日摘要」分頁（A 日期、B 摘要、C 劇本網址（推送時一律改用 SHEN_SCRIPT_URL，不讀 C 欄），D 推送時間，D 空白代表還沒傳）。
   9:30 左右：shenDailyPush 把頻道數據與還沒傳的摘要畫成一張圖卡（Google 簡報轉 PNG，跟試算報表同一套做法），傳到 LINE 與 Telegram；
   圖卡畫不出來時改傳純文字，不會漏掉內容。 */
const SHEN_DAILY_SHEET = '神對話每日摘要';
const SHEN_CARD_FOLDER = '每日回報圖卡';
// 配色沿用小乖的象牙白香檳金（和試算報表、對話頁一致）
const SC_ = { BG: '#F4EFE6', CARD: '#FBF8F2', BOX: '#FFFDF8', GOLD: '#C9A56A', GOLD_D: '#8E6D3A', FRAME: '#E3D3B0',
  INK: '#2A2118', SOFT: '#7A6A55', MUTE: '#9A8A70', RULE: '#E6DCC8', BRAND: '#A8834A' };
const SC_NUMS = ['一', '二', '三', '四', '五', '六'];

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
  return '神對話每日摘要：已設定，每天 9:30 左右與頻道數據合併，做成圖卡傳出。';
}

// 頻道數據裡要放進圖卡的數字（chanDailyJob 會一起存進 CHAN_DAILY_MSG 的 st 欄位）
function chanStats_(d) {
  const v = d.videos || [];
  const pv = v.filter(x => x.avgPct != null);
  return {
    subs: chanNum_(d.subs),
    avg: v.length ? chanNum_(Math.round(v.reduce((s, x) => s + x.views, 0) / v.length)) : '—',
    pct: pv.length ? Math.round(pv.reduce((s, x) => s + x.avgPct, 0) / pv.length) + '%' : '—',
  };
}

// 去掉條列符號與編號；不截斷內容（每一條會依字數自動加高，整段都會顯示）
function scClip_(s) {
  return String(s).replace(/^[\s・•\-*]+/, '').replace(/^\d+[.、)]\s*/, '').trim();
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

// 圖卡版面：{ W, H, build(slideId) }，和 reportLayout_ 一樣交給 layoutPng_ 畫成 PNG
function shenCardLayout_(st, items, dateLine) {
  const W = 720, ROW = 40, ITEMS_TOP = 380;
  // 每一條依字數決定高度：一行約 40 個字（12pt、寬 560pt），一行約 18pt，最少一個 ROW
  const hs = items.map(t => Math.max(ROW, Math.ceil(Array.from(t).length / 40) * 18 + 16));
  const offs = [];
  hs.reduce((acc, h) => { offs.push(acc); return acc + h; }, 0);
  const footY = ITEMS_TOP + hs.reduce((a, b) => a + b, 0) + 22;
  const H = footY + 64;
  const s = st || { subs: '—', avg: '—', pct: '—' };
  const stats = [[s.subs, '訂閱數'], [s.avg, '最近影片平均觀看'], [s.pct, '平均看了']];
  const build = pg => {
    const req = [];
    let k = 0;
    const place = (x, y, w, h) => ({ pageObjectId: pg,
      size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: h, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' } });
    const rect = (x, y, w, h, fill, outline) => {
      const id = 'sc_r_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'RECTANGLE', elementProperties: place(x, y, w, h) } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'shapeBackgroundFill,outline', shapeProperties: {
        shapeBackgroundFill: fill ? { solidFill: { color: { rgbColor: rgb_(fill) } } } : { propertyState: 'NOT_RENDERED' },
        outline: outline ? { outlineFill: { solidFill: { color: { rgbColor: rgb_(outline) } } }, weight: { magnitude: 1, unit: 'PT' } }
          : { propertyState: 'NOT_RENDERED' } } } });
    };
    const text = (x, y, w, h, txt, o) => {
      const id = 'sc_t_' + (k++);
      req.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: place(x, y, w, h) } });
      req.push({ insertText: { objectId: id, text: String(txt), insertionIndex: 0 } });
      req.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'fontFamily,fontSize,bold,foregroundColor', style: {
        fontFamily: o.font, fontSize: { magnitude: o.size, unit: 'PT' }, bold: !!o.bold,
        foregroundColor: { opaqueColor: { rgbColor: rgb_(o.color) } } } } });
      req.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'alignment', style: { alignment: o.align || 'START' } } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'contentAlignment', shapeProperties: { contentAlignment: o.middle ? 'MIDDLE' : 'TOP' } } });
    };
    req.push({ updatePageProperties: { objectId: pg, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb_(SC_.BG) } } } }, fields: 'pageBackgroundFill.solidFill.color' } });
    // 外框：金色細線＋內側一道淡框
    rect(24, 24, W - 48, H - 48, SC_.CARD, SC_.GOLD);
    rect(34, 34, W - 68, H - 68, null, SC_.FRAME);
    text(0, 58, W, 20, 'XIAOGUAI · 小乖每日回報', { font: 'Noto Sans TC', size: 10, bold: true, color: SC_.BRAND, align: 'CENTER' });
    text(0, 80, W, 44, '今日頻道與神對話', { font: 'Noto Serif TC', size: 26, bold: true, color: SC_.INK, align: 'CENTER', middle: true });
    text(0, 128, W, 20, dateLine, { font: 'Noto Sans TC', size: 11, color: SC_.SOFT, align: 'CENTER' });
    rect(96, 166, W - 192, 1, SC_.GOLD, null);
    text(64, 184, 592, 24, '頻道數據', { font: 'Noto Serif TC', size: 14, bold: true, color: SC_.GOLD_D });
    stats.forEach((b, i) => {
      const x = 64 + i * 202;
      rect(x, 216, 188, 92, SC_.BOX, SC_.FRAME);
      text(x, 226, 188, 40, b[0], { font: 'Noto Serif TC', size: 24, bold: true, color: SC_.INK, align: 'CENTER', middle: true });
      text(x, 272, 188, 18, b[1], { font: 'Noto Sans TC', size: 10, color: SC_.SOFT, align: 'CENTER' });
    });
    rect(96, 328, W - 192, 1, SC_.GOLD, null);
    text(64, 344, 592, 24, '神對話每日迭代', { font: 'Noto Serif TC', size: 14, bold: true, color: SC_.GOLD_D });
    items.forEach((t, i) => {
      const y = ITEMS_TOP + offs[i], h = hs[i];
      text(64, y + 8, 28, 24, SC_NUMS[i] || String(i + 1), { font: 'Noto Serif TC', size: 13, bold: true, color: SC_.GOLD_D });
      text(96, y + 6, 560, h - 6, t, { font: 'Noto Sans TC', size: 12, color: SC_.INK });
      rect(64, y + h - 1, 592, 1, SC_.RULE, null);
    });
    text(0, footY, W, 20, '劇本網址　' + SHEN_SCRIPT_URL, { font: 'Noto Sans TC', size: 10, color: SC_.MUTE, align: 'CENTER' });
    return req;
  };
  return { W: W, H: H, build: build };
}

// 把圖卡存進雲端硬碟、設成知道連結的人都能看（LINE 用的圖片網址）
function shenCardUrl_(png) {
  const it = DriveApp.getFoldersByName(SHEN_CARD_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(SHEN_CARD_FOLDER);
  const file = folder.createFile(png.copyBlob());
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

// 由時間觸發器執行（9:30）：頻道數據（今天的）＋還沒傳的摘要，畫成一張圖卡，傳到 LINE 與 Telegram
function shenDailyPush() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const cm = JSON.parse(prop_('CHAN_DAILY_MSG') || 'null');
  const chanText = cm && cm.d === today ? cm.t : '';
  const chanSt = cm && cm.d === today ? cm.st : null;
  const sh = ss_().getSheetByName(SHEN_DAILY_SHEET);
  const pending = [];
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach((r, i) => {
      const body = String(r[1] || '').trim();
      if (body && !String(r[3] || '').trim()) pending.push({ row: i + 2, date: r[0], body: body, url: SHEN_SCRIPT_URL });
    });
  }
  if (!chanText && !pending.length) return;
  const parts = [];
  if (chanText) parts.push(chanText);
  pending.forEach(p => parts.push('🌿 神對話每日迭代（' + p.date + '）\n\n' + p.body + (p.url ? '\n\n📜 劇本網址：' + p.url : '')));
  const msg = parts.join('\n\n━━━━━━━━\n\n');
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  try {
    // 圖卡：摘要每一行一條（全部顯示，不截斷），沒有摘要就寫一句提示
    const items = [];
    pending.forEach(p => String(p.body).split('\n').forEach(l => { const t = scClip_(l); if (t) items.push(t); }));
    const dateLine = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy 年 M 月 d 日') + ' ・ 每日回報';
    const L = shenCardLayout_(chanSt, items.length ? items : ['今天還沒有新的神對話迭代建議。'], dateLine);
    const png = layoutPng_(L, '每日回報_' + today + '.png');
    if (png) {
      const url = shenCardUrl_(png);
      if (owner) lineApi_('push', { to: owner, messages: withQuick_([
        { type: 'image', originalContentUrl: url, previewImageUrl: url },
        { type: 'text', text: '📜 劇本網址：' + SHEN_SCRIPT_URL }]) });
      if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) tgSend_(tgOwner, { text: '📜 劇本網址：' + SHEN_SCRIPT_URL, png: png });
    } else {
      // 圖卡畫不出來：照舊傳純文字，內容不漏
      console.error('每日回報圖卡沒產生，改傳文字。' + (REPORT_ERR_ || ''));
      if (owner) shenChunks_(msg, 4800).forEach(t => push_(owner, t));
      if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) shenChunks_(msg, 3800).forEach(t => tgSend_(tgOwner, t));
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
    pending.forEach(p => sh.getRange(p.row, 4).setValue(now));
    if (chanText) setProp_('CHAN_DAILY_MSG', '');
  } catch (e) { console.error('每日合併推送失敗：' + e); }
}
