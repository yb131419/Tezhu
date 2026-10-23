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
const TRADE_MAX_SIZE = 5;             // 單筆最多下單數量（防止誤打大數字）
let TRADE_AUTH_ = null;               // 同一次執行內共用一組登入，不用每個呼叫都登入一次
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
    m = s.match(/^(買進|買|賣出|賣)(黃金|原油|納指)(\d+)?$/);   // 可在後面加數量，例如「買進納指 2」，不加就用預設數量
    if (m) return tradePropose_(m[2], /買/.test(m[1]) ? 'buy' : 'sell', m[3]);
    if (s === '查看持倉') return tradePositions_();
    m = s.match(/^確認下單([A-Za-z0-9]{4,8})?$/);
    if (m) return tradeConfirm_(m[1] || '');
    if (s === '取消下單') return tradeCancel_();
    // 提醒推送後回覆「確認」或「否」：只有在有待確認的提案時才算下單指令，否則照常交給小乖
    if ((s === '確認' || s === '否') && tradePending_()) return s === '確認' ? tradeConfirm_('') : tradeCancel_();
    if (s === '下單紀錄') return tradeRecords_();
    if (s === '交易提醒') return tradeRemindStatus_('');
    if (s === '開啟提醒' || s === '關閉提醒') {
      tradeRemindSwitch_(s === '開啟提醒');
      return tradeRemindStatus_(s === '開啟提醒' ? '已開啟，之後有交易訊號會推送提案到 Telegram。' : '已關閉，之後不會再推送提醒。');
    }
    return null;
  } catch (err) {
    console.error(err);
    return '下單功能出錯了：' + (err && err.message || err) + '\n（沒有送出任何下單）';
  }
}

function tradeCard_() {
  const p = tradePending_();
  const adv = tradeAdviceRows_();
  const body = '模式：' + tradeModeZh_() + '\n小乖不會自己下單：要先選商品與方向，再按確認。' + (p ? '\n\n⏳ 有一張待確認的提案：\n' + tradeProposalText_(p) : '');
  const rows = [['📊 查看持倉', '🛒 下單'], ['📜 下單紀錄'], ['✅ 確認下單', '❌ 取消下單']];
  return { text: '📈 智能下單\n' + tradeAdviceText_(adv) + '\n\n' + body, buttons: rows, flex: tradeFlex_('📈 智能下單', body, rows, tradeAdviceFlex_(adv)), alt: '📈 智能下單卡片' };
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
function tradePropose_(name, side, sizeText) {
  const it = TRADE_ITEMS[name];
  const size = sizeText ? Number(sizeText) : it.size;
  if (!(size >= 1 && size <= TRADE_MAX_SIZE)) return '數量要在 1 到 ' + TRADE_MAX_SIZE + ' 之間，沒有產生提案。';
  const price = tradeQuote_(it);
  const sig = tradeSignal_(it);
  const dir = side === 'buy' ? 1 : -1;
  const p = {
    id: tradeToken_(), name: name, side: side, size: size, price: price,
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
    p.sig + (p.against ? '\n⚠️ 這根 K 線的 EMA 方向跟你選的相反' : '') +
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

// 下單紀錄：列出最近 10 筆（模擬與實際送單成交都會記在這裡），只讀
function tradeRecords_() {
  const list = tradeLogList_().slice(-10).reverse();
  const rows = [['📈 智能下單', '📊 查看持倉']];
  if (!list.length) return { text: '📜 還沒有下單紀錄。', buttons: rows };
  const text = '📜 下單紀錄（最近 ' + list.length + ' 筆）\n' + list.map(x =>
    '・' + x.at + ' ' + x.name + ' ' + (x.side === 'buy' ? '買進' : '賣出') + ' ' + x.size + ' 單位 @ ' + x.price + '（' + x.label + '）').join('\n');
  return { text: text, buttons: rows, flex: tradeFlex_('📜 下單紀錄', text, rows), alt: '📜 下單紀錄' };
}

function tradePositions_() {
  const positions = tradeFetch_('get', '/positions', 2).positions || [];
  const rows = [['📈 交易', '🛒 下單']];
  // IG 的 /positions 回傳 position.size（數量）、position.level（開倉價），損益要用市場的 bid／offer 自己算（約略值，帳戶幣別）
  let text = positions.length ? '📊 目前持倉（' + positions.length + ' 筆）\n' + positions.map(x => {
    const buy = x.position.direction === 'BUY';
    const open = Number(x.position.level);
    const now = buy ? Number(x.market.bid) : Number(x.market.offer);
    const upl = (buy ? now - open : open - now) * Number(x.position.size);
    return '・' + tradeNameOf_(x.market.epic) + ' ' + (buy ? '多' : '空') + ' ' + x.position.size +
      ' 單位，開倉 ' + open + '，未實現損益 約 ' + upl.toFixed(2);
  }).join('\n') : '📊 目前沒有持倉。';
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
  if (TRADE_AUTH_) return TRADE_AUTH_;
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
  TRADE_AUTH_ = { cst: h.CST || h.cst, token: h['X-SECURITY-TOKEN'] || h['x-security-token'] };
  return TRADE_AUTH_;
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
  // 「分鐘數＋筆數」的寫法屬於 v2；要算 EMA200 需要至少 200 根，所以取 300 根
  const data = tradeFetch_('get', '/prices/' + it.epic + '/MINUTE_15/300', 2);
  // 最後一根可能還沒收盤，判斷只用已收盤的 K 線；bar 是這根已收盤 K 線的時間，用來避免重複提醒
  const all = data.prices || [];
  const closed = all.slice(0, -1);
  const closes = closed.map(c => (Number(c.closePrice.bid) + Number(c.closePrice.ask)) / 2);
  const n = closes.length;
  const barInfo = closed[n - 1] || {};
  const bar = barInfo.snapshotTimeUTC || barInfo.snapshotTime || '';
  if (n < 30) return { signal: '', bar: '', text: 'EMA：K 線不足，無法判斷' };
  const fast = tradeEma_(closes, 9), slow = tradeEma_(closes, 21);
  const cross = fast[n - 2] < slow[n - 2] && fast[n - 1] > slow[n - 1] ? 'buy'
    : fast[n - 2] > slow[n - 2] && fast[n - 1] < slow[n - 1] ? 'sell' : '';
  const trend = fast[n - 1] > slow[n - 1] ? '多頭' : '空頭';
  const dir = fast[n - 1] > slow[n - 1] ? 'buy' : 'sell';   // 目前趨勢方向，只用來給參考，不是交叉訊號
  // 參考線（只顯示，不影響交叉判斷）：6、12、21、32、200 週期，K 線不足的就不顯示
  const refs = [6, 12, 21, 32, 200].filter(p => n >= p).map(p => ({ period: p, value: tradeEma_(closes, p)[n - 1].toFixed(it.prec) }));
  return { signal: cross, bar: bar, dir: dir, text: 'EMA 趨勢：' + trend + (cross ? '（這根剛交叉）' : '') +
    '\n' + refs.map(r => 'EMA' + r.period + '：' + r.value).join('\n') };
}

/* ---------- 自動提醒：EMA 交叉時推送提案，按確認才送單 ---------- */

// 開始提醒（在編輯器執行一次，或從卡片按「開啟提醒」）：建立每 5 分鐘的觸發器。需要授權「管理觸發條件」
function tradeRemindOn() { tradeRemindSwitch_(true); }

// 停止提醒（在編輯器執行一次，或從卡片按「關閉提醒」）：刪除觸發器。已推送的提案仍可手動取消
function tradeRemindOff() { tradeRemindSwitch_(false); }

// 開關共用：只改觸發器與 TRADE_REMIND 狀態，不動判斷與下單邏輯
function tradeRemindSwitch_(on) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'tradeRemindTick_') ScriptApp.deleteTrigger(t); });
  if (on) ScriptApp.newTrigger('tradeRemindTick_').timeBased().everyMinutes(5).create();
  setProp_('TRADE_REMIND', on ? 'on' : 'off');
  console.log(on ? '提醒已開始，每 5 分鐘檢查一次' : '提醒已停止');
}

// 卡片上的「交易提醒」：顯示目前狀態，並提供開啟與關閉按鈕（只控制提醒，不送單）
function tradeRemindStatus_(note) {
  const on = prop_('TRADE_REMIND') === 'on';
  const rows = [on ? ['🔕 關閉提醒'] : ['🔔 開啟提醒'], ['📈 智能下單']];
  const text = '🔔 交易提醒：' + (on ? '開啟中（每 5 分鐘檢查一次，只推送提案，不會自動送單）' : '已關閉') + (note ? '\n' + note : '');
  return { text: text, buttons: rows, flex: tradeFlex_('🔔 交易提醒', text, rows), alt: '🔔 交易提醒' };
}

// 觸發器每 5 分鐘呼叫一次：只推送提案，不送單
function tradeRemindTick_() {
  try {
    if (prop_('TRADE_REMIND') !== 'on') return;
    const cur = tradePending_();
    if (cur && cur.expires > Date.now()) return;   // 已有待確認的提案，不重複推送
    const day = tradeDay_();
    if (day.n >= TRADE_MAX_DAILY || tradeOpenCount_() >= TRADE_MAX_OPEN) return;
    const seen = tradeState_().alerts || {};
    for (const name of Object.keys(TRADE_ITEMS)) {
      const sig = tradeSignal_(TRADE_ITEMS[name]);
      if (!sig.signal || !sig.bar || seen[name] === sig.bar) continue;   // 同一根 K 線只提醒一次
      seen[name] = sig.bar;
      tradeSaveState_(Object.assign(tradeState_(), { alerts: seen }));
      tradeRemindSend_(name, sig.signal);
      return;   // 一次只提醒一個商品，避免同時出現多張提案
    }
  } catch (err) {
    console.error(err);
  }
}

// 同一張提案同時推到 Telegram（按鈕＋文字）與 LINE（快速回覆按鈕＋文字）。
// LINE 推播會計入官方帳號每月 200 則額度；可在 TRADE_CFG 的 notify.remindLine 設為 false 關掉
function tradeRemindSend_(name, side) {
  const res = tradePropose_(name, side);
  const head = '🔔 智能下單提醒\n' + res.text;
  const chat = prop_('TG_OWNER_CHAT_ID');
  if (chat) {
    tgApi_('sendMessage', {
      chat_id: chat,
      text: head + '\n\n回覆「確認」送出，回覆「否」取消，或直接按下方按鈕。',
      reply_markup: { inline_keyboard: [[{ text: '✅ 確認下單', callback_data: 'trade_ok' }, { text: '❌ 否', callback_data: 'trade_no' }]] },
    });
  }
  const notify = tradeCfg_().notify || {};
  if (notify.remindLine !== false && prop_('OWNER_USER_ID')) {
    try {
      lineApi_('push', { to: prop_('OWNER_USER_ID'), messages: [{
        type: 'text', text: head + '\n\n回覆「確認」送出，回覆「否」取消，或直接按下方按鈕。',
        quickReply: { items: [
          { type: 'action', action: { type: 'message', label: '✅ 確認下單', text: '確認下單' } },
          { type: 'action', action: { type: 'message', label: '❌ 否', text: '否' } },
        ] },
      }] });
    } catch (err) {
      console.error('LINE 提醒推送失敗：' + err);
    }
  }
}

// Telegram 按鈕（Code.gs 的 handleTelegram_ 會把 callback_query 交給這裡）：只接受主人的按鈕
function tradeTgCallback_(cq) {
  const owner = prop_('TG_OWNER_CHAT_ID');
  if (!owner || !cq.message || String(cq.message.chat.id) !== owner) return;
  let reply = '';
  if (cq.data === 'trade_ok') reply = tradeConfirm_('');
  else if (cq.data === 'trade_no') reply = tradeCancel_();
  else return;
  tgApi_('answerCallbackQuery', { callback_query_id: cq.id, text: '已處理' });
  tgApi_('sendMessage', { chat_id: owner, text: reply });
}

// 智能下單頁面最上面的方向參考：依 EMA 趨勢，只是參考，方向仍由使用者自己選，不會自動下單
function tradeAdviceRows_() {
  return Object.keys(TRADE_ITEMS).map(name => {
    try {
      return { name: name, dir: tradeSignal_(TRADE_ITEMS[name]).dir || '' };
    } catch (err) {
      return { name: name, dir: '' };
    }
  });
}

function tradeDirZh_(dir) {
  return dir === 'buy' ? '多單' : dir === 'sell' ? '空單' : '暫無資料';
}

function tradeAdviceText_(rows) {
  return '方向參考（僅供參考，不保證獲利）\n' + rows.map(r => r.name + '：' + tradeDirZh_(r.dir)).join('\n');
}

// 卡片最上面：每個商品一行，多單綠、空單紅，一眼就看得出來
function tradeAdviceFlex_(rows) {
  const UP = '#2E6B45', DOWN = '#9E3A2B', INK = '#2A2118', SOFT = '#9A8B74';
  const line = r => ({
    type: 'box', layout: 'horizontal', paddingAll: '10px', cornerRadius: '10px', backgroundColor: '#FFFFFF', contents: [
      { type: 'text', text: r.name, size: 'md', weight: 'bold', color: INK, flex: 3, gravity: 'center' },
      { type: 'text', text: tradeDirZh_(r.dir), size: 'xl', weight: 'bold', align: 'end', flex: 2, color: r.dir === 'buy' ? UP : r.dir === 'sell' ? DOWN : SOFT },
    ],
  });
  return [{ type: 'text', text: '方向參考（僅供參考，不保證獲利）', size: 'xs', color: SOFT, wrap: true }]
    .concat(rows.map(line))
    .concat([{ type: 'separator', color: '#E8DCC4' }]);
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
function tradeFlex_(title, body, rows, lead) {
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
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px', backgroundColor: '#FBF7EF', contents: (lead || []).concat([
        { type: 'text', text: body, wrap: true, size: 'sm', color: SOFT },
        { type: 'separator', color: LINE },
      ]).concat(labels.map((label, i) => Object.assign(btn(label, i), { margin: 'sm' }))),
    },
  };
}
