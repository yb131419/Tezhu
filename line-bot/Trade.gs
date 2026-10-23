/* ============ 智能下單（IG Group）：卡片＋確認 ============ */
// 這個檔案要跟 Code.gs 放在同一個 Apps Script 專案（在編輯器「+」新增一個檔案，名字隨意，例如 Trade，整份貼進去）。
// 安全規則（使用者要求「要確認才下單」）：
// 1. 沒有排程，AI 也不會下單：要先按「🛒 下單」選商品與方向，看到提案後再按「✅ 確認下單」才會送出。
// 2. 預設 mode = paper（只記錄，不送 IG）。mode = practice 送 IG 模擬帳戶（env = demo）；
//    真錢要 mode = live 且 env = live，兩個都改才會動真錢。
// 3. 登入資料只放在指令碼屬性 TRADE_CFG（一個 JSON），不寫在程式碼裡。用 TradeSetup.gs 一次寫入。
// 4. 提案 5 分鐘內有效；確認時重抓報價，偏離太多就不下單；每日單數與同時持倉都有上限（沿用原本 bot 的設定）。
// 指令碼屬性只用兩個：TRADE_CFG（設定，你自己填）與 TRADE_STATE（提案、每日計數、模擬紀錄，小乖自己寫）。

// 商品對照。epic 必須從 IG 網站的市場頁面複製（見 PR 說明），沒填前會直接拒絕下單。
// sl／tp 是 IG 的「點數距離」，size 是 IG 的下單大小，兩者都要在模擬帳戶確認過再用。
const TRADE_ITEMS = {
  '黃金': { epic: 'MT.D.GC.FBMU3.IP', size: 1, sl: 150, tp: 300, pip: 0.01, prec: 2 },   // 使用者提供，尚未用 IG 行情驗證；可能是特定到期月合約
  '原油': { epic: 'CC.D.LCO.UNC.IP', size: 1, sl: 50, tp: 100, pip: 0.01, prec: 2 },   // 使用者提供，尚未用 IG 行情驗證
  '納指': { epic: 'IX.D.NASDAQ.IFMM.IP', size: 1, sl: 200, tp: 400, pip: 0.1, prec: 1 },   // 美國科技股100指數 現貨 ($1)，由查代碼結果取得，尚未用行情驗證
};
const TRADE_MAX_DAILY = 5;            // 每日最多單數（全商品合計）
const TRADE_MAX_OPEN = 2;             // 同時最多持倉數
const TRADE_TTL_MS = 5 * 60 * 1000;   // 提案 5 分鐘內有效
const TRADE_DRIFT = 0.5;              // 確認時報價離提案超過「停損距離 × 0.5」就不下單

// 小乖的文字指令入口（answer_ 裡呼叫）：不是下單指令就回 null，交給後面的 AI
function tradeAsk_(t) {
  try {
    const q = String(t || '').match(/^查代碼\s*(.+)$/);
    if (q) return tradeEpicSearch_(q[1].trim());
    const s = String(t || '').replace(/\s+/g, '');
    if (/^(尋找下單|智能下單|自動下單|下單卡片|交易|交易卡片)$/.test(s)) return tradeCard_();
    if (s === '下單') return tradePickItem_();
    let m = s.match(/^下單(黃金|原油|納指)$/);
    if (m) return tradePickSide_(m[1]);
    m = s.match(/^(買進|買|賣出|賣)(黃金|原油|納指)$/);
    if (m) return tradePropose_(m[2], /買/.test(m[1]) ? 'buy' : 'sell');
    if (s === '查看持倉') return tradePositions_();
    m = s.match(/^確認下單([A-Za-z0-9]{4,8})?$/);
    if (m) return tradeConfirm_(m[1] || '');
    if (s === '取消下單') return tradeCancel_();
    return null;
  } catch (err) {
    console.error(err);
    return '下單功能出錯了：' + (err && err.message || err) + '\n（沒有送出任何下單）';
  }
}

function tradeCard_() {
  const p = tradePending_();
  const body = '模式：' + tradeModeZh_() + '\n小乖不會自己下單：要先選商品與方向，再按確認。' + (p ? '\n\n⏳ 有一張待確認的提案：\n' + tradeProposalText_(p) : '');
  const rows = [['📊 查看持倉', '🛒 下單'], ['✅ 確認下單', '❌ 取消下單']];
  return { text: '📈 智能下單\n' + body, buttons: rows, flex: tradeFlex_('📈 智能下單', body, rows), alt: '📈 智能下單卡片' };
}

function tradePickItem_() {
  const rows = [Object.keys(TRADE_ITEMS).map(n => '下單' + n), ['📊 查看持倉', '❌ 取消下單']];
  return { text: '要下單哪一個？', buttons: rows, flex: tradeFlex_('🛒 選商品', '選好之後，再選買進或賣出。', rows), alt: '🛒 選商品' };
}

function tradePickSide_(name) {
  const rows = [['🟢 買進' + name, '🔴 賣出' + name], ['❌ 取消下單']];
  return { text: '要買還是賣' + name + '？\n選好會先給你看提案，確認後才會下單。', buttons: rows, flex: tradeFlex_('🛒 ' + name, '要買還是賣？', rows), alt: '🛒 ' + name };
}

// 產生提案：只存在 TRADE_STATE 裡，不會下單
function tradePropose_(name, side) {
  const it = TRADE_ITEMS[name];
  const price = tradeQuote_(it);
  const sig = tradeSignal_(it);
  const dir = side === 'buy' ? 1 : -1;
  const p = {
    id: tradeToken_(), name: name, side: side, size: it.size, price: price,
    sl: tradeRound_(price - dir * it.sl * it.pip, it.prec),
    tp: tradeRound_(price + dir * it.tp * it.pip, it.prec),
    expires: Date.now() + TRADE_TTL_MS, sig: sig.text,
    against: !!sig.signal && sig.signal !== side,
  };
  tradeSaveState_(Object.assign(tradeState_(), { pending: p }));
  const body = tradeProposalText_(p) + '\n\n5 分鐘內按「✅ 確認下單」才會送出；按「❌ 取消下單」就不做。';
  const rows = [['✅ 確認下單', '❌ 取消下單']];
  return { text: '🧾 下單提案（' + tradeModeZh_() + '）\n' + body, buttons: rows, flex: tradeFlex_('🧾 下單提案', body, rows), alt: '🧾 下單提案' };
}

function tradeProposalText_(p) {
  const it = TRADE_ITEMS[p.name];
  return '商品：' + p.name + '（' + it.epic + '）\n' +
    '方向：' + (p.side === 'buy' ? '買進' : '賣出') + ' ' + p.size + ' 單位\n' +
    '參考價：' + p.price.toFixed(it.prec) + '\n' +
    '停損：' + p.sl.toFixed(it.prec) + '（' + it.sl + ' 點）\n' +
    '停利：' + p.tp.toFixed(it.prec) + '（' + it.tp + ' 點）\n' +
    p.sig + (p.against ? '\n⚠️ 這根 K 線的 EMA 交叉方向跟你選的相反' : '') +
    '\n提案代碼：' + p.id;
}

function tradeConfirm_(token) {
  return withLock_(() => {
    const p = tradePending_();
    if (!p) return '目前沒有待確認的下單。\n請先按「🛒 下單」選商品與方向。';
    if (token && token.toUpperCase() !== p.id) return '確認碼對不上，可能是舊的提案，沒有下單。\n請按最新那張卡片的「✅ 確認下單」。';
    tradeSaveState_(Object.assign(tradeState_(), { pending: null }));   // 一次性：不管成不成功都先清掉，避免重複送單
    if (Date.now() > p.expires) return '這張提案已超過 5 分鐘，沒有下單。\n請重新按「🛒 下單」。';

    const it = TRADE_ITEMS[p.name];
    const mode = tradeMode_();
    const env = tradeCfg_().env === 'live' ? 'live' : 'demo';
    if (mode === 'live' && env !== 'live') return '設定不一致：mode 是 live，但 env 不是 live，沒有下單。';
    if (mode === 'practice' && env === 'live') return '設定不一致：mode 是 practice，但 env 是 live，沒有下單。';

    const now = tradeQuote_(it);
    if (Math.abs(now - p.price) > it.sl * it.pip * TRADE_DRIFT) {
      return '報價變動太大（提案 ' + p.price.toFixed(it.prec) + '，現在 ' + now.toFixed(it.prec) + '），沒有下單。\n請重新按「🛒 下單」。';
    }
    const day = tradeDay_();
    if (day.n >= TRADE_MAX_DAILY) return '今天已經下了 ' + day.n + ' 筆，已達每日上限 ' + TRADE_MAX_DAILY + '，沒有下單。';
    if (tradeOpenCount_() >= TRADE_MAX_OPEN) return '同時持倉已達上限 ' + TRADE_MAX_OPEN + ' 筆，沒有下單。';

    if (mode === 'paper') {
      tradeLog_(p, now, '模擬紀錄，沒有送到 IG');
      tradeBump_(day);
      return '📝 模擬下單完成（沒有送到 IG）\n' + tradeProposalText_(p);
    }

    // IG：先送單，拿 dealReference，再用 /confirms 確認是否成交
    const placed = tradeFetch_('post', '/positions/otc', 2, {
      epic: it.epic, expiry: '-', direction: p.side === 'buy' ? 'BUY' : 'SELL', size: p.size, orderType: 'MARKET',
      currencyCode: 'USD', forceOpen: true, guaranteedStop: false,
      stopDistance: it.sl, limitDistance: it.tp,
    });
    const conf = tradeFetch_('get', '/confirms/' + placed.dealReference, 1);
    if (conf.dealStatus !== 'ACCEPTED') return '❌ 下單沒有成交：' + (conf.reason || conf.dealStatus || '未知原因');
    const fillPrice = Number(conf.level);
    tradeBump_(day);
    tradeLog_(p, fillPrice, mode === 'live' ? '真實帳戶' : 'IG 模擬帳戶');
    const done = '✅ 已送出（' + (mode === 'live' ? '真實帳戶' : 'IG 模擬帳戶') + '）\n成交價：' + fillPrice.toFixed(it.prec) +
      '\n停損：' + p.sl.toFixed(it.prec) + '\n停利：' + p.tp.toFixed(it.prec);
    tradeNotify_('📣 成交通知\n' + p.name + ' ' + (p.side === 'buy' ? '買進' : '賣出') + ' ' + p.size + ' 單位\n' + done.split('\n').slice(1).join('\n'));
    return done;
  });
}

function tradeCancel_() {
  const had = tradePending_();
  tradeSaveState_(Object.assign(tradeState_(), { pending: null }));
  return had ? '❌ 已取消，這張提案沒有送出。' : '目前沒有待確認的下單。';
}

function tradePositions_() {
  const positions = tradeFetch_('get', '/positions', 2).positions || [];
  const rows = [['📈 交易', '🛒 下單']];
  let text = positions.length ? '📊 目前持倉（' + positions.length + ' 筆）\n' + positions.map(x =>
    '・' + tradeNameOf_(x.market.epic) + ' ' + (x.position.direction === 'BUY' ? '多' : '空') + ' ' + x.position.dealSize +
    ' 單位，開倉 ' + x.position.level + '，未實現損益 ' + x.position.upl).join('\n') : '📊 目前沒有持倉。';
  const log = tradeLogList_().slice(-3);
  if (tradeMode_() === 'paper' && log.length) text += '\n\n📝 最近的模擬紀錄：\n' + log.map(x => '・' + x.at + ' ' + x.name + ' ' + (x.side === 'buy' ? '買進' : '賣出') + ' @ ' + x.price).join('\n');
  return { text: text, buttons: rows, flex: tradeFlex_('📊 持倉', text, rows), alt: '📊 持倉' };
}

/* ---------- 設定與 IG 連線（登入資料只從 TRADE_CFG 讀） ---------- */
// TRADE_CFG 範例（用 TradeSetup.gs 一次寫入，不要手動貼在屬性欄位裡）：
// {"apiKey":"IG的API金鑰","identifier":"IG登入帳號","password":"IG登入密碼","mode":"paper","env":"demo"}
// 注意：獨立的模擬帳戶能否建立 API 金鑰，目前還沒確認（見 PR 說明）。

function tradeCfg_() {
  try { return JSON.parse(prop_('TRADE_CFG') || '{}'); } catch (e) { return {}; }
}

function tradeMode_() {
  const m = tradeCfg_().mode || 'paper';
  return ['paper', 'practice', 'live'].indexOf(m) >= 0 ? m : 'paper';
}

function tradeModeZh_() {
  return { paper: '模擬（不送單）', practice: 'IG 模擬帳戶', live: '真實帳戶⚠️' }[tradeMode_()];
}

function tradeBase_() {
  return tradeCfg_().env === 'live' ? 'https://api.ig.com/gateway/deal' : 'https://demo-api.ig.com/gateway/deal';
}

// 登入（v2：回傳 CST 與 X-SECURITY-TOKEN 兩個標頭），每次呼叫都重新登入，不把 token 存進屬性
function tradeLogin_() {
  const cfg = tradeCfg_();
  if (!cfg.apiKey || !cfg.identifier || !cfg.password) {
    throw new Error('還沒設定 IG 登入資料，請用 TradeSetup.gs 寫入 TRADE_CFG');
  }
  const res = UrlFetchApp.fetch(tradeBase_() + '/session', {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'X-IG-API-KEY': cfg.apiKey, Version: '2', Accept: 'application/json' },
    payload: JSON.stringify({ identifier: cfg.identifier, password: cfg.password }),
  });
  if (res.getResponseCode() !== 200) throw new Error('IG 登入失敗（' + res.getResponseCode() + '），請檢查 TRADE_CFG 與 API 金鑰');
  const h = res.getHeaders();
  return { cst: h.CST || h.cst, token: h['X-SECURITY-TOKEN'] || h['x-security-token'] };
}

// 呼叫 IG 的 API；version 依 IG 文件對應各端點
function tradeFetch_(method, path, version, body) {
  const cfg = tradeCfg_();
  const auth = tradeLogin_();
  const res = UrlFetchApp.fetch(tradeBase_() + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'X-IG-API-KEY': cfg.apiKey, CST: auth.cst, 'X-SECURITY-TOKEN': auth.token, Version: String(version), Accept: 'application/json' },
    payload: body ? JSON.stringify(body) : null,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { /* 不是 JSON 就用原文 */ }
  if (code >= 400) throw new Error('IG ' + code + '（' + method.toUpperCase() + ' ' + path.split('?')[0] + '）：' + (json.errorCode || text.slice(0, 200)));
  return json;
}

// 查代碼：只讀，用 IG 的市場搜尋找 epic，不下單
function tradeEpicSearch_(term) {
  const res = tradeFetch_('get', '/markets?searchTerm=' + encodeURIComponent(term), 1);
  const list = (res.markets || []).slice(0, 10);
  if (!list.length) return '🔎 找不到「' + term + '」，換個關鍵字再試。（只讀，沒有下單）';
  return '🔎 「' + term + '」的搜尋結果（最多 10 筆，只讀，沒有下單）：\n' +
    list.map(m => '・' + m.instrumentName + (m.expiry ? '（' + m.expiry + '）' : '') + '\n  ' + m.epic).join('\n');
}

function tradeEpicCheck_(it) {
  if (!it.epic || it.epic.indexOf('FILL_IN') === 0) throw new Error('還沒填 Epic 代碼，請從 IG 市場頁面複製（見 PR 說明）');
}

// 報價：用 IG 的 /markets/{epic} 取買價與賣價，取中間價
function tradeQuote_(it) {
  tradeEpicCheck_(it);
  const snap = tradeFetch_('get', '/markets/' + it.epic, 3).snapshot;
  return (Number(snap.bid) + Number(snap.offer)) / 2;
}

// 同 analysis.py：15 分鐘收盤價算 EMA9／EMA21，這根剛好交叉才算訊號
function tradeSignal_(it) {
  tradeEpicCheck_(it);
  const data = tradeFetch_('get', '/prices/' + it.epic + '/MINUTE_15/100', 2);   // 「分鐘數＋筆數」的寫法屬於 v2
  const closes = (data.prices || []).map(c => (Number(c.closePrice.bid) + Number(c.closePrice.ask)) / 2);
  const n = closes.length;
  if (n < 30) return { signal: '', text: 'EMA：K 線不足，無法判斷' };
  const fast = tradeEma_(closes, 9), slow = tradeEma_(closes, 21);
  const cross = fast[n - 2] < slow[n - 2] && fast[n - 1] > slow[n - 1] ? 'buy'
    : fast[n - 2] > slow[n - 2] && fast[n - 1] < slow[n - 1] ? 'sell' : '';
  const trend = fast[n - 1] > slow[n - 1] ? '多頭（快線在慢線上方）' : '空頭（快線在慢線下方）';
  return { signal: cross, text: 'EMA：' + trend + (cross ? '，這根剛交叉' + (cross === 'buy' ? '做多' : '做空') : '') };
}

function tradeEma_(vals, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  vals.forEach((v, i) => {
    if (i < period - 1) { out.push(null); return; }
    prev = prev === null ? vals.slice(0, period).reduce((a, b) => a + b, 0) / period : v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function tradeOpenCount_() { return (tradeFetch_('get', '/positions', 2).positions || []).length; }

// 成交通知（只在真的送出單之後才發，模擬不發）：
// 預設發到 Telegram（不計額度）；LINE 推播要在 TRADE_CFG 設 "notify":{"line":true} 才會發，
// LINE 推播會計入官方帳號每月 200 則免費額度，所以預設關閉。
function tradeNotify_(text) {
  const n = tradeCfg_().notify || {};
  if (n.telegram !== false && prop_('TG_OWNER_CHAT_ID')) {
    try { tgApi_('sendMessage', { chat_id: prop_('TG_OWNER_CHAT_ID'), text: text }); } catch (e) { console.error(e); }
  }
  if (n.line === true && prop_('OWNER_USER_ID')) {
    try { lineApi_('push', { to: prop_('OWNER_USER_ID'), messages: [{ type: 'text', text: text }] }); } catch (e) { console.error(e); }
  }
}

/* ---------- 狀態（TRADE_STATE：提案、每日計數、模擬紀錄） ---------- */

function tradeState_() {
  try { return JSON.parse(prop_('TRADE_STATE') || '{}'); } catch (e) { return {}; }
}

function tradeSaveState_(s) { setProp_('TRADE_STATE', JSON.stringify(s)); }

function tradePending_() {
  const p = tradeState_().pending;
  return p && p.id ? p : null;
}

function tradeDay_() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const d = tradeState_().day || {};
  return d.date === today ? { date: today, n: Number(d.n) || 0 } : { date: today, n: 0 };
}

function tradeBump_(day) {
  tradeSaveState_(Object.assign(tradeState_(), { day: { date: day.date, n: day.n + 1 } }));
}

function tradeLogList_() { return tradeState_().log || []; }

function tradeLog_(p, price, label) {
  const list = tradeLogList_();
  list.push({ at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'), name: p.name, side: p.side, size: p.size, price: Number(price).toFixed(TRADE_ITEMS[p.name].prec), sl: p.sl, tp: p.tp, label: label });
  tradeSaveState_(Object.assign(tradeState_(), { log: list.slice(-20) }));
}

function tradeNameOf_(epic) {
  const hit = Object.keys(TRADE_ITEMS).filter(n => TRADE_ITEMS[n].epic === epic)[0];
  return hit || epic;
}

function tradeRound_(x, prec) { return Number(x.toFixed(prec)); }

function tradeToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); }

// LINE 卡片（Flex）：每一顆按鈕都是「送出一句文字」，所以會走同一套 answer_ 指令，不會直接下單
// 版面與小乖精品選單一致：象牙白底、金色漸層標題、每顆按鈕獨占一行
function tradeFlex_(title, body, rows) {
  const INK = '#2A2118', SOFT = '#9A8B74', LINE = '#E8DCC4';
  const btn = (label, i) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', justifyContent: 'center', paddingAll: '13px', cornerRadius: '12px',
    borderWidth: '1px', borderColor: i ? LINE : '#C9A56A',
    background: i ? undefined : { type: 'linearGradient', angle: '120deg', startColor: '#E9D3A2', endColor: '#C9A56A' },
    backgroundColor: i ? '#FFFFFF' : '#D9BC85',
    action: { type: 'message', label: label, text: label },
    contents: [{ type: 'text', text: label, size: 'sm', weight: 'bold', color: INK, align: 'center' }],
  });
  const labels = [].concat.apply([], rows);
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '16px', background: { type: 'linearGradient', angle: '120deg', startColor: '#E9D3A2', endColor: '#C9A56A' },
      contents: [
        { type: 'text', text: '小乖 · PRIVATE', size: 'xxs', weight: 'bold', color: '#5A4630' },
        { type: 'text', text: title, size: 'xl', weight: 'bold', color: INK, wrap: true, margin: 'sm' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px', backgroundColor: '#FBF7EF', contents: [
        { type: 'text', text: body, wrap: true, size: 'sm', color: SOFT },
        { type: 'separator', color: LINE },
      ].concat(labels.map((label, i) => Object.assign(btn(label, i), { margin: 'sm' }))),
    },
  };
}
