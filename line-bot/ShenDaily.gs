/* ============ 每日合併推送：神對話每日迭代 + 頻道數據，做成 3:4 直式圖卡傳到小乖對話（LINE 與 Telegram） ============
   9:15：頻道數據更新（chanDailyJob 寫進試算表，並把數字與文字暫存在 CHAN_DAILY_MSG，不直接傳）。
   排程 9:15：把當天的神對話摘要寫進試算表「神對話每日摘要」分頁（A 日期、B 摘要、C 劇本網址（推送時一律改用 SHEN_SCRIPT_URL，不讀 C 欄），D 推送時間，E 推送錯誤）。
   9:30 左右：shenDailyPush 把頻道數據與還沒傳的摘要排成 3:4 圖卡（900 × 1200，Google 簡報轉 PNG，跟試算報表同一套做法），傳到 LINE 與 Telegram；
   內容多時自動拆成第 1／2／3 頁，不截斷。圖卡畫不出來時改傳純文字，不會漏掉內容。
   只有確實送出（沒有例外）才寫入 D 欄推送時間，並清掉頻道數據暫存；送不出去時寫入 E 欄原因、保留頻道數據，手動再執行就會重試。 */
const SHEN_DAILY_SHEET = '神對話每日摘要';
const SHEN_CARD_FOLDER = '每日回報圖卡';
// 配色沿用小乖的象牙白香檳金（和試算報表、對話頁一致）
const SC_ = { BG: '#F4EFE6', CARD: '#FBF8F2', BOX: '#FFFDF8', GOLD: '#C9A56A', GOLD_D: '#8E6D3A', FRAME: '#E3D3B0',
  INK: '#2A2118', SOFT: '#7A6A55', MUTE: '#9A8A70', RULE: '#E6DCC8', BRAND: '#A8834A' };
const SC_NUMS = ['一', '二', '三', '四', '五', '六'];
// 3:4 直式圖卡尺寸（PT）與版面常數
const SC_PW = 900, SC_PH = 1200, SC_PAD = 72;
const SC_BODY = 30, SC_MUTE = 26, SC_LABEL = 28;

// 只需要執行一次（在編輯器選「shenDailyOn」按執行）：建立分頁與標題列，並設定每天 9:30 的時間觸發器
function shenDailyOn() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEN_DAILY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEN_DAILY_SHEET);
    sh.appendRow(['日期', '摘要', '劇本網址', '推送時間', '推送錯誤']);
    sh.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'shenDailyPush').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('shenDailyPush').timeBased().everyDays(1).atHour(9).nearMinute(30).inTimezone('Asia/Taipei').create();
  return '神對話每日摘要：已設定，每天 9:30 左右與頻道數據合併，做成 3:4 圖卡傳出。';
}

// 頻道數據裡要放進圖卡的數字（chanDailyJob 會一起存進 CHAN_DAILY_MSG 的 st 欄位）
// 平均看了％超過 100 時照原樣顯示，並標記 pctWarn，圖卡上會註明「待確認」
function chanStats_(d) {
  const v = d.videos || [];
  const pv = v.filter(x => x.avgPct != null);
  const pctNum = pv.length ? Math.round(pv.reduce((s, x) => s + x.avgPct, 0) / pv.length) : null;
  return {
    subs: chanNum_(d.subs),
    avg: v.length ? chanNum_(Math.round(v.reduce((s, x) => s + x.views, 0) / v.length)) : '—',
    pct: pctNum == null ? '—' : pctNum + '%',
    pctWarn: pctNum != null && pctNum > 100,
  };
}

// 去掉條列符號與編號；不截斷內容
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

// 把迭代摘要拆成幾列：開頭結論（lead）、①②… 各一列（num）、最後「不確定」一列（muted）
function shenCardItems_(body) {
  const s = String(body || '').replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  // 只認最後一次出現的「不確定：」（句中的「仍不確定」不算）
  const ui = Math.max(s.lastIndexOf('不確定：'), s.lastIndexOf('不確定:'));
  const tail = ui >= 0 ? s.slice(ui).trim() : '';
  const main = ui >= 0 ? s.slice(0, ui) : s;
  const ci = main.search(/[①②③④⑤⑥⑦⑧⑨]/);
  const lead = (ci >= 0 ? main.slice(0, ci) : main).replace(/(頻道)?改善建議[：:]?\s*$/, '').trim();
  const rest = ci >= 0 ? main.slice(ci) : '';
  if (lead) out.push({ num: '', text: lead, lead: true });
  rest.split(/(?=[①②③④⑤⑥⑦⑧⑨])/).forEach(seg => {
    const m = seg.match(/^([①②③④⑤⑥⑦⑧⑨])\s*([\s\S]*)$/);
    if (m) out.push({ num: m[1], text: m[2].replace(/[；;]\s*$/, '').trim() });
  });
  if (tail) out.push({ num: '', text: tail, muted: true });
  return out.length ? out : [{ num: '', text: s, lead: true }];
}

// 把一段結論依句號拆成幾句，讓手機上一句一行好讀
function scSentences_(t) {
  // 句末標點後面接右引號、括號時不拆（例如「……？」）
  return String(t).split(/(?<=[。！？])(?![」』）])/).map(x => x.trim()).filter(Boolean);
}

// 圖卡共用的版面外框：{ W, H, build(slideId) }，交給 layoutPng_ 畫成 PNG。
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
    // 外框：金色細線＋內側一道淡框
    rect(14, 14, W - 28, H - 28, SC_.CARD, SC_.GOLD);
    rect(22, 22, W - 44, H - 44, null, SC_.FRAME);
    draw({ rect: rect, text: text });
    return req;
  };
  return { W: W, H: H, build: build };
}

// 內文區塊的高度估算（CJK 約一字一個字級寬）；回傳行數
function scLines_(text, size, width) {
  const cpl = Math.max(6, Math.floor(width / size));
  return String(text).split('\n').reduce((n, seg) => n + Math.max(1, Math.ceil(Array.from(seg).length / cpl)), 0);
}

// 把各區（今日重點／熱門歸納／頻道改善建議／待確認）攤平成一列列區塊，每個區塊帶高度
function scBlocksFromSections_(sections) {
  const blocks = [];
  sections.forEach((sec, si) => {
    sec.items.forEach((it, ii) => {
      const size = it.muted ? SC_MUTE : SC_BODY;
      const width = SC_PW - SC_PAD * 2 - (it.num ? 64 : 0);
      const textH = scLines_(it.text, size, width) * Math.round(size * 1.5) + 10;
      const head = ii === 0 ? 52 + (si > 0 ? 36 : 0) : 0;
      blocks.push({ label: ii === 0 ? sec.label : null, gap: ii === 0 && si > 0, num: it.num || '',
        text: it.text, size: size, muted: !!it.muted, textH: textH, h: head + textH });
    });
  });
  return blocks;
}

// 依高度把區塊分頁：第 1 頁有數字方塊（較高），之後每頁版面較寬
function scPages_(stats, sections, dateLine) {
  const blocks = scBlocksFromSections_(sections);
  const pages = [];
  let cur = [];
  let used = 0;
  const avail = p => SC_PH - 130 - (p === 0 && stats ? 600 : 300);
  blocks.forEach(b => {
    if (cur.length && used + b.h > avail(pages.length)) { pages.push(cur); cur = []; used = 0; }
    cur.push(b);
    used += b.h;
  });
  if (cur.length || !pages.length) pages.push(cur);
  return pages.map((bl, i) => ({ blocks: bl, stats: i === 0 ? stats : null, index: i + 1, total: pages.length, dateLine: dateLine }));
}

// 一頁 3:4 圖卡：頂部品牌列＋標題＋日期；第 1 頁有三個數字方塊；內容依區分行排列；底部劇本網址
function scPageLayout_(page) {
  const W = SC_PW, H = SC_PH;
  return shenCardPage_(W, H, d => {
    const pg = page.total > 1 ? '　' + page.index + ' / ' + page.total : '';
    d.text(40, 50, W - 80, 40, 'XIAOGUAI · 小乖每日回報' + pg, { font: 'Noto Sans TC', size: 26, bold: true, color: SC_.BRAND });
    d.text(40, 100, W - 80, 110, '每日回報', { font: 'Noto Serif TC', size: 72, bold: true, color: SC_.INK, middle: true });
    d.text(40, 212, W - 80, 50, page.dateLine, { font: 'Noto Sans TC', size: 30, color: SC_.SOFT });
    d.rect(SC_PAD, 276, W - SC_PAD * 2, 1, SC_.GOLD, null);
    let y = 306;
    if (page.stats) {
      const s = page.stats;
      const cells = [[s.subs, '訂閱數'], [s.avg, '最近影片平均觀看'], [s.pct, s.pctWarn ? '平均看了（待確認）' : '平均看了']];
      cells.forEach((c, i) => {
        const x = SC_PAD + i * 258;
        d.rect(x, 306, 240, 240, SC_.BOX, SC_.FRAME);
        d.text(x, 336, 240, 110, c[0], { font: 'Noto Serif TC', size: 58, bold: true, color: SC_.INK, middle: true });
        d.text(x + 8, 452, 224, 76, c[1], { font: 'Noto Sans TC', size: 26, color: c[1].indexOf('待確認') >= 0 ? SC_.BRAND : SC_.SOFT });
      });
      y = 606;
    }
    page.blocks.forEach(b => {
      if (b.gap) y += 36;
      if (b.label) {
        d.text(SC_PAD, y, W - SC_PAD * 2, 44, b.label, { font: 'Noto Sans TC', size: SC_LABEL, bold: true, color: SC_.BRAND, align: 'START' });
        y += 52;
      }
      if (b.num) {
        d.text(SC_PAD, y, 64, b.textH, b.num, { font: 'Noto Sans TC', size: b.size, bold: true, color: SC_.BRAND, align: 'START' });
        d.text(SC_PAD + 64, y, W - SC_PAD * 2 - 64, b.textH, b.text, { font: 'Noto Sans TC', size: b.size, color: SC_.INK, align: 'START' });
      } else {
        d.text(SC_PAD, y, W - SC_PAD * 2, b.textH, b.text, { font: 'Noto Sans TC', size: b.size,
          color: b.muted ? SC_.MUTE : SC_.INK, align: 'START' });
      }
      y += b.textH;
    });
    d.text(40, H - 110, W - 80, 40, '劇本網址　' + SHEN_PAGE_URL, { font: 'Noto Sans TC', size: 22, color: SC_.MUTE });
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

// 推送失敗：不寫推送時間，把原因寫進「推送錯誤」欄，之後手動再執行就會重試
function shenPushFail_(sh, pending, stamp, reason) {
  console.error('每日推送失敗：' + reason);
  if (sh) pending.forEach(p => sh.getRange(p.row, 5).setValue('推送失敗 ' + stamp + '：' + reason));
}

// 由時間觸發器執行（9:30）：頻道數據（今天的）＋還沒傳的摘要，排成 3:4 圖卡，傳到 LINE 與 Telegram
function shenDailyPush() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const stamp = () => Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
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
  console.log('shenDailyPush 開始：' + today + '，頻道數據' + (chanText ? '有' : '無') + '，待推送摘要 ' + pending.length + ' 筆');
  if (!chanText && !pending.length) { console.log('沒有待推送的內容，結束。'); return; }
  const kwLine = shenKeywordLine_();
  const parts = [];
  if (chanText) parts.push(chanText);
  pending.forEach(p => parts.push('🌿 神對話每日迭代（' + p.date + '）\n\n' + p.body + (p.url ? '\n\n📜 劇本網址：' + p.url : '')));
  if (kwLine) parts.push('🔎 ' + kwLine);
  const msg = parts.join('\n\n━━━━━━━━\n\n') + '\n\n' + verTag_();
  const owner = prop_('OWNER_USER_ID'), tgOwner = prop_('TG_OWNER_CHAT_ID');
  const tgOn = !!(tgOwner && prop_('TELEGRAM_BOT_TOKEN'));
  console.log('推送目標：LINE ' + (owner ? '已設定' : '未設定（OWNER_USER_ID 空白）') + '，Telegram ' + (tgOn ? '已設定' : '未設定（TG_OWNER_CHAT_ID 或 TELEGRAM_BOT_TOKEN 空白）'));
  if (!owner && !tgOn) { shenPushFail_(sh, pending, stamp(), '推送目標都沒有設定'); return; }

  const errs = [];
  // 沒設定的管道不算失敗；設定了但沒有成功送出，才算失敗
  let lineOk = !owner, tgOk = !tgOn;
  try {
    // 把摘要拆成幾區：今日重點、熱門歸納（劇本關鍵字）、頻道改善建議（①–⑨）、待確認（不確定）
    const items = [];
    pending.forEach(p => shenCardItems_(p.body).forEach(it => items.push(it)));
    const leads = items.filter(it => it.lead);
    const kw = items.filter(it => it.muted && String(it.text).indexOf('劇本關鍵字') === 0);
    const nums = items.filter(it => it.num);
    const tails = items.filter(it => it.muted && String(it.text).indexOf('劇本關鍵字') !== 0);
    if (kwLine && !kw.length) kw.push({ num: '', text: kwLine, muted: true });
    const sections = [];
    if (leads.length) sections.push({ label: '今日重點', items: leads.reduce((a, it) => a.concat(scSentences_(it.text).map(t => ({ num: '・', text: t }))), []) });
    if (kw.length) {
      const body = String(kw[0].text).replace(/^劇本關鍵字[^：]*：/, '');
      sections.push({ label: '熱門歸納', items: body.split('、').map(t => t.trim()).filter(Boolean).map(t => ({ num: '・', text: t })) });
    }
    if (nums.length) sections.push({ label: '頻道改善建議', items: nums.map(it => ({ num: it.num, text: it.text })) });
    if (tails.length) sections.push({ label: '待確認', items: tails.map(it => ({ text: it.text, muted: true })) });
    if (!sections.length) sections.push({ label: '今日重點', items: [{ text: '今天還沒有新的神對話迭代建議。' }] });
    const dateLine = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy 年 M 月 d 日') + ' ・ 每日回報';
    const pages = scPages_(chanSt, sections, dateLine);
    const pngs = pages.map((p, i) => layoutPng_(scPageLayout_(p), '每日回報_' + today + '_' + (i + 1) + '.png')).filter(Boolean);
    console.log('圖卡：' + pngs.length + ' / ' + pages.length + ' 頁產生成功');
    if (pngs.length === pages.length) {
      const urls = pngs.map(p => shenCardUrl_(p));
      const imgs = urls.map(u => ({ type: 'image', originalContentUrl: u, previewImageUrl: u }));
      if (owner) {
        try {
          // LINE 每次最多 5 則訊息，超過就分批推送
          for (let i = 0; i < imgs.length; i += 5) {
            const batch = imgs.slice(i, i + 5);
            if (i + 5 >= imgs.length) batch.push({ type: 'text', text: '📜 劇本網址：' + SHEN_PAGE_URL });
            const r = lineApi_('push', { to: owner, messages: i === 0 ? withQuick_(batch) : batch });
            console.log('LINE 圖卡推送回應（第 ' + (Math.floor(i / 5) + 1) + ' 批）：' + JSON.stringify(r).slice(0, 300));
          }
          lineOk = true;
        } catch (e) { errs.push('LINE 圖卡：' + e); }
      }
      if (tgOn) {
        try {
          pngs.forEach(p => tgSend_(tgOwner, { text: '📜 劇本網址：' + SHEN_PAGE_URL, png: p }));
          tgOk = true;
        } catch (e) { errs.push('Telegram 圖卡：' + e); }
      }
    } else {
      // 圖卡畫不出來：照舊傳純文字，內容不漏
      console.error('每日回報圖卡沒產生，改傳文字。' + (REPORT_ERR_ || ''));
      if (owner) {
        try { shenChunks_(msg, 4800).forEach(t => push_(owner, t)); lineOk = true; } catch (e) { errs.push('LINE 文字：' + e); }
      }
      if (tgOn) {
        try { shenChunks_(msg, 3800).forEach(t => tgSend_(tgOwner, t)); tgOk = true; } catch (e) { errs.push('Telegram 文字：' + e); }
      }
    }
  } catch (e) { errs.push('產生圖卡：' + e); }

  if (!lineOk || !tgOk || errs.length) {
    shenPushFail_(sh, pending, stamp(), errs.join('；') || '未知錯誤');
    return; // 不寫推送時間、保留頻道數據，之後可手動再執行重試
  }
  console.log('推送完成：LINE ' + (owner ? 'OK' : '未啟用') + '，Telegram ' + (tgOn ? 'OK' : '未啟用'));
  const now = stamp();
  pending.forEach(p => { sh.getRange(p.row, 4).setValue(now); sh.getRange(p.row, 5).setValue(''); });
  if (chanText) setProp_('CHAN_DAILY_MSG', '');
}
