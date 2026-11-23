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

// 把迭代摘要拆成卡片的幾列：開頭結論、①②… 各一列、最後「不確定」一列（小字）
function shenCardItems_(body) {
  const s = String(body || '').replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  // 只認最後一次出現的「不確定：」（句中的「仍不確定」不算）
  const ui = Math.max(s.lastIndexOf('不確定：'), s.lastIndexOf('不確定:'));
  const tail = ui >= 0 ? s.slice(ui).trim() : '';
  const main = ui >= 0 ? s.slice(0, ui) : s;
  const ci = main.search(/[①②③④⑤⑥⑦⑧⑨]/);
  const lead = (ci >= 0 ? main.slice(0, ci) : main).replace(/改善建議[：:]?\s*$/, '').trim();
  const rest = ci >= 0 ? main.slice(ci) : '';
  if (lead) out.push({ num: '', text: lead, lead: true });
  rest.split(/(?=[①②③④⑤⑥⑦⑧⑨])/).forEach(seg => {
    const m = seg.match(/^([①②③④⑤⑥⑦⑧⑨])\s*([\s\S]*)$/);
    if (m) out.push({ num: m[1], text: m[2].replace(/[；;]\s*$/, '').trim() });
  });
  if (tail) out.push({ num: '', text: tail, muted: true });
  return out.length ? out : [{ num: '', text: s, lead: true }];
}

// 圖卡共用的版面外框：{ W, H, build(slideId) }，交給 layoutPng_ 畫成 PNG。內容置中、字級盡量放大（手機上好讀）
function shenCardPage_(W, H, draw) {
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
      req.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, fields: 'alignment', style: { alignment: o.align || 'CENTER' } } });
      req.push({ updateShapeProperties: { objectId: id, fields: 'contentAlignment', shapeProperties: { contentAlignment: o.middle ? 'MIDDLE' : 'TOP' } } });
    };
    req.push({ updatePageProperties: { objectId: pg, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb_(SC_.BG) } } } }, fields: 'pageBackgroundFill.solidFill.color' } });
    // 外框：金色細線＋內側一道淡框（貼近邊緣，讓內容有最大可用空間）
    rect(14, 14, W - 28, H - 28, SC_.CARD, SC_.GOLD);
    rect(22, 22, W - 44, H - 44, null, SC_.FRAME);
    draw({ rect: rect, text: text });
    return req;
  };
  return { W: W, H: H, build: build };
}

// 第一張：今日頻道數據（三個數字方塊放大填滿）＋ 結論文字，內容置中
function shenStatsCardLayout_(st, dateLine, leads) {
  const W = 720, BOX_TOP = 300, BOX_H = 300, LEAD_TOP = BOX_TOP + BOX_H + 50, PAD = 44;
  const s = st || { subs: '—', avg: '—', pct: '—' };
  const stats = [[s.subs, '訂閱數'], [s.avg, '最近影片平均觀看'], [s.pct, '平均看了']];
  const hs = (leads || []).map(it => Math.max(70, Math.ceil(Array.from(it.text).length / 15) * 56 + 30));
  const offs = [];
  hs.reduce((acc, h) => { offs.push(acc); return acc + h; }, 0);
  const footY = LEAD_TOP + hs.reduce((a, b) => a + b, 0) + 30;
  const H = footY + 90;
  return shenCardPage_(W, H, d => {
    d.text(40, 50, W - 80, 40, 'XIAOGUAI · 小乖每日回報', { font: 'Noto Sans TC', size: 28, bold: true, color: SC_.BRAND });
    d.text(40, 94, W - 80, 120, '今日頻道數據', { font: 'Noto Serif TC', size: 66, bold: true, color: SC_.INK, middle: true });
    d.text(40, 216, W - 80, 52, dateLine, { font: 'Noto Sans TC', size: 32, color: SC_.SOFT });
    d.rect(60, 282, W - 120, 1, SC_.GOLD, null);
    stats.forEach((b, i) => {
      const x = 52 + i * 212;
      d.rect(x, BOX_TOP, 200, BOX_H, SC_.BOX, SC_.FRAME);
      d.text(x, BOX_TOP + 36, 200, 130, b[0], { font: 'Noto Serif TC', size: 64, bold: true, color: SC_.INK, middle: true });
      d.text(x + 6, BOX_TOP + 178, 188, 100, b[1], { font: 'Noto Sans TC', size: 30, color: SC_.SOFT });
    });
    d.rect(60, LEAD_TOP - 22, W - 120, 1, SC_.GOLD, null);
    (leads || []).forEach((it, i) => {
      const y = LEAD_TOP + offs[i], h = hs[i];
      d.text(PAD, y + 8, W - PAD * 2, h - 8, it.text, { font: 'Noto Sans TC', size: 38, bold: true, color: SC_.INK });
    });
    d.text(40, footY, W - 80, 44, '劇本網址　' + SHEN_PAGE_URL, { font: 'Noto Sans TC', size: 24, color: SC_.MUTE });
  });
}

// 第二張：神對話每日改善建議。上半是改善建議（①–⑤）與不確定，下半「劇本關鍵字」獨立成框，各區分開、置中
function shenIterCardLayout_(items, dateLine) {
  const W = 720, LABEL_Y = 300, TOP = 350, PAD = 44, SEC_GAP = 36;
  const isKw = it => it.muted && String(it.text).indexOf('劇本關鍵字') === 0;
  const main = items.filter(it => !isKw(it));
  const kw = items.filter(isKw);
  // 估高：38pt 一行約 17 字、行高 56；註腳 32pt 一行約 19 字、行高 46
  const hOf = it => {
    const n = Array.from(it.text).length;
    if (it.muted) return Math.max(70, Math.ceil(n / 19) * 46 + 30);
    return Math.max(100, Math.ceil(n / 17) * 56 + 40);
  };
  const hs = main.map(hOf);
  const mainEnd = TOP + hs.reduce((a, b) => a + b, 0);
  const m = kw.length ? String(kw[0].text).match(/^(劇本關鍵字[^：]*)：([\s\S]*)$/) : null;
  const kwHead = m ? m[1] : '劇本關鍵字';
  const kwBody = m ? m[2] : kw.map(it => it.text).join('\n');
  const KW_TOP = mainEnd + SEC_GAP + 20;
  const kwH = kw.length ? Math.max(130, Math.ceil(Array.from(kwBody).length / 19) * 46 + 116) : 0;
  const footY = (kw.length ? KW_TOP + kwH : mainEnd) + 40;
  const H = footY + 90;
  return shenCardPage_(W, H, d => {
    d.text(40, 50, W - 80, 40, 'XIAOGUAI · 小乖每日回報', { font: 'Noto Sans TC', size: 28, bold: true, color: SC_.BRAND });
    d.text(40, 94, W - 80, 120, '神對話每日改善建議', { font: 'Noto Serif TC', size: 66, bold: true, color: SC_.INK, middle: true });
    d.text(40, 216, W - 80, 52, dateLine, { font: 'Noto Sans TC', size: 32, color: SC_.SOFT });
    d.rect(60, 282, W - 120, 1, SC_.GOLD, null);
    d.text(PAD, LABEL_Y, W - PAD * 2, 40, '改善建議', { font: 'Noto Sans TC', size: 30, bold: true, color: SC_.BRAND });
    let y = TOP;
    main.forEach((it, i) => {
      const h = hs[i];
      if (it.muted) {
        d.text(PAD, y + 12, W - PAD * 2, h - 12, it.text, { font: 'Noto Sans TC', size: 32, color: SC_.MUTE });
      } else {
        const body = it.num ? it.num + '　' + it.text : it.text;
        d.text(PAD, y + 14, W - PAD * 2, h - 14, body, { font: 'Noto Sans TC', size: 38, bold: !it.num, color: SC_.INK });
      }
      d.rect(60, y + h - 1, W - 120, 1, SC_.RULE, null);
      y += h;
    });
    if (kw.length) {
      // 關鍵字獨立成框：標題在框內上方，內容置中
      d.rect(60, KW_TOP, W - 120, kwH, SC_.BOX, SC_.FRAME);
      d.text(PAD, KW_TOP + 18, W - PAD * 2, 40, kwHead, { font: 'Noto Sans TC', size: 30, bold: true, color: SC_.BRAND });
      d.text(PAD + 20, KW_TOP + 62, W - PAD * 2 - 40, kwH - 74, kwBody, { font: 'Noto Sans TC', size: 32, color: SC_.SOFT });
    }
    d.text(40, footY, W - 80, 44, '劇本網址　' + SHEN_PAGE_URL, { font: 'Noto Sans TC', size: 24, color: SC_.MUTE });
  });
}

// 把圖卡存進雲端硬碟、設成知道連結的人都能看（LINE 用的圖片網址）
function shenCardUrl_(png) {
  const it = DriveApp.getFoldersByName(SHEN_CARD_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(SHEN_CARD_FOLDER);
  const file = folder.createFile(png.copyBlob());
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

// 每日回報要帶上「劇本關鍵字」分頁的前幾名（最新一次搜尋字詞，依觀看次數排序）；沒有資料就回傳空字串
function shenKeywordLine_() {
  const kw = ss_().getSheetByName(CHAN_KEYWORD_SHEET);
  if (!kw || kw.getLastRow() < 2) return '';
  const rows = kw.getRange(2, 1, kw.getLastRow() - 1, 3).getValues()
    .filter(r => String(r[1] || '').trim())
    .sort((a, b) => Number(b[2]) - Number(a[2]))
    .slice(0, 5);
  if (!rows.length) return '';
  const t0 = rows[0][0];
  const when = t0 instanceof Date ? Utilities.formatDate(t0, 'Asia/Taipei', 'yyyy-MM-dd') : String(t0 || '').trim();
  return '劇本關鍵字（' + when + '）：' + rows.map(r => String(r[1]).trim() + ' ' + Number(r[2]) + ' 次').join('、');
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
      if (body && !String(r[3] || '').trim()) pending.push({ row: i + 2, date: r[0], body: body, url: SHEN_PAGE_URL });
    });
  }
  if (!chanText && !pending.length) return;
  const kwLine = shenKeywordLine_();
  const parts = [];
  if (chanText) parts.push(chanText);
  pending.forEach(p => parts.push('🌿 神對話每日迭代（' + p.date + '）\n\n' + p.body + (p.url ? '\n\n📜 劇本網址：' + p.url : '')));
  if (kwLine) parts.push('🔎 ' + kwLine);
  const msg = parts.join('\n\n━━━━━━━━\n\n') + '\n\n' + verTag_();
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  try {
    // 圖卡：摘要每一行一條（全部顯示，不截斷），沒有摘要就寫一句提示
    const items = [];
    pending.forEach(p => shenCardItems_(p.body).forEach(it => items.push(it)));
    if (kwLine) items.push({ num: '', text: kwLine, muted: true });
    const dateLine = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy 年 M 月 d 日') + ' ・ 每日回報';
    const itemList = items.length ? items : [{ num: '', text: '今天還沒有新的神對話迭代建議。', lead: true }];
    // 兩張圖分開傳：第一張頻道數據，第二張神對話每日迭代（字級加大）
    // 結論放在第一張（頻道數據下方），改善建議放在第二張，兩張都留足空間
    const leads = itemList.filter(it => it.lead);
    const rest = itemList.filter(it => !it.lead);
    const pngStats = layoutPng_(shenStatsCardLayout_(chanSt, dateLine, leads), '每日回報_頻道_' + today + '.png');
    const pngIter = layoutPng_(shenIterCardLayout_(rest.length ? rest : [{ num: '', text: '本批沒有其他改善建議。', muted: true }], dateLine), '每日回報_神對話_' + today + '.png');
    const pngs = [pngStats, pngIter].filter(Boolean);
    if (pngs.length) {
      const urls = pngs.map(p => shenCardUrl_(p));
      if (owner) lineApi_('push', { to: owner, messages: withQuick_(urls.map(u => ({ type: 'image', originalContentUrl: u, previewImageUrl: u }))
        .concat([{ type: 'text', text: '📜 劇本網址：' + SHEN_PAGE_URL }])) });
      if (tgOwner && prop_('TELEGRAM_BOT_TOKEN')) pngs.forEach(p => tgSend_(tgOwner, { text: '📜 劇本網址：' + SHEN_PAGE_URL, png: p }));
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
