/* ============ 自動下單（OANDA）：卡片＋確認 ============ */
// 這個檔案要跟 Code.gs 放在同一個 Apps Script 專案（在編輯器「+」新增一個檔案，名字隨意，例如 Trade，整份貼進去）。
// 安全規則（使用者要求「要確認才下單」）：
// 1. 沒有排程，AI 也不會下單：要先按「🛒 下單」選商品與方向，看到提案後再按「✅ 確認下單」才會送出。
// 2. 預設 mode = paper（只記錄，不送 OANDA）。要到 OANDA 模擬帳戶送單改成 practice；
//    真錢要 mode = live 且 env = live，兩個都改才會動真錢。
// 3. 金鑰只放在指令碼屬性 TRADE_CFG（一個 JSON），不寫在程式碼裡。
// 4. 提案 5 分鐘內有效；確認時重抓報價，偏離太多就不下單；每日單數與同時持倉都有上限（同 Python 版 config.py）。
// 指令碼屬性只用兩個：TRADE_CFG（設定，你自己填）與 TRADE_STATE（提案、每日計數、模擬紀錄，小乖自己寫）。

const TRADE_ITEMS = {   // 同 Python 版 config.py：單位、停損停利（pips）、pip 大小、價格小數位（請用模擬帳戶確認 prec）
  '黃金': { id: 'XAU_USD', units: 10, sl: 150, tp: 300, pip: 0.01, prec: 3 },
  '原油': { id: 'BCO_USD', units: 100, sl: 50, tp: 100, pip: 0.01, prec: 3 },
  '納指': { id: 'NAS100_USD', units: 1, sl: 200, tp: 400, pip: 0.1, prec: 1 },
};
const TRADE_MAX_DAILY = 5;            // 每日最多單數（全商品合計）
const TRADE_MAX_OPEN = 2;             // 同時最多持倉數
const TRADE_TTL_MS = 5 * 60 * 1000;   // 提案 5 分鐘內有效
const TRADE_DRIFT = 0.5;              // 確認時報價離提案超過「停損距離 × 0.5」就不下單

// 小乖的文字指令入口（answer_ 裡呼叫）：不是下單指令就回 null，交給後面的 AI
function tradeAsk_(t) {
  try {
    const s = String(t || '').replace(/\s+/g, '');
    if (/^(自動下單|下單卡片|交易|交易卡片)$/.test(s)) return tradeCard_();
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
  return { text: '📈 自動下單\n' + body, buttons: rows, flex: tradeFlex_('📈 自動下單', body, rows), alt: '📈 自動下單卡片' };
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
  const price = tradeQuote_(it.id);
  const sig = tradeSignal_(it.id);
  const dir = side === 'buy' ? 1 : -1;
  const p = {
    id: tradeToken_(), name: name, side: side, units: it.units, price: price,
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
  return '商品：' + p.name + '（' + it.id + '）\n' +
    '方向：' + (p.side === 'buy' ? '買進' : '賣出') + ' ' + p.units + ' 單位\n' +
    '參考價：' + p.price.toFixed(it.prec) + '\n' +
    '停損：' + p.sl.toFixed(it.prec) + '（' + it.sl + ' pips）\n' +
    '停利：' + p.tp.toFixed(it.prec) + '（' + it.tp + ' pips）\n' +
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
    const cfg = tradeCfg_();
    const mode = tradeMode_();
    const env = cfg.env === 'live' ? 'live' : 'practice';
    if (mode === 'live' && env !== 'live') return '設定不一致：mode 是 live，但 env 不是 live，沒有下單。';
    if (mode === 'practice' && env === 'live') return '設定不一致：mode 是 practice，但 env 是 live，沒有下單。';

    const now = tradeQuote_(it.id);
    if (Math.abs(now - p.price) > it.sl * it.pip * TRADE_DRIFT) {
      return '報價變動太大（提案 ' + p.price.toFixed(it.prec) + '，現在 ' + now.toFixed(it.prec) + '），沒有下單。\n請重新按「🛒 下單」。';
    }
    const day = tradeDay_();
    if (day.n >= TRADE_MAX_DAILY) return '今天已經下了 ' + day.n + ' 筆，已達每日上限 ' + TRADE_MAX_DAILY + '，沒有下單。';
    if (tradeOpenCount_() >= TRADE_MAX_OPEN) return '同時持倉已達上限 ' + TRADE_MAX_OPEN + ' 筆，沒有下單。';

    if (mode === 'paper') {
      tradeLog_(p, now, '模擬紀錄，沒有送到 OANDA');
      tradeBump_(day);
      return '📝 模擬下單完成（沒有送到 OANDA）\n' + tradeProposalText_(p);
    }

    const res = tradeFetch_('post', tradeAcct_('/orders'), { order: {
      type: 'MARKET', instrument: it.id, units: String(p.side === 'buy' ? p.units : -p.units),
      stopLossOnFill: { price: p.sl.toFixed(it.prec), timeInForce: 'GTC' },
      takeProfitOnFill: { price: p.tp.toFixed(it.prec), timeInForce: 'GTC' },
    } });
    if (!res.orderFillTransaction) return '❌ 下單沒有成交：' + JSON.stringify(res).slice(0, 300);
    const fillPrice = Number(res.orderFillTransaction.price);
    tradeBump_(day);
    tradeLog_(p, fillPrice, mode === 'live' ? '真實帳戶' : 'OANDA 模擬帳戶');
    return '✅ 已送出（' + (mode === 'live' ? '真實帳戶' : 'OANDA 模擬帳戶') + '）\n成交價：' + fillPrice.toFixed(it.prec) +
      '\n停損：' + p.sl.toFixed(it.prec) + '\n停利：' + p.tp.toFixed(it.prec);
  });
}

function tradeCancel_() {
  const had = tradePending_();
  tradeSaveState_(Object.assign(tradeState_(), { pending: null }));
  return had ? '❌ 已取消，這張提案沒有送出。' : '目前沒有待確認的下單。';
}

function tradePositions_() {
  const trades = tradeFetch_('get', tradeAcct_('/openTrades')).trades || [];
  const rows = [['📈 交易', '🛒 下單']];
  let text = trades.length ? '📊 目前持倉（' + trades.length + ' 筆）\n' + trades.map(t =>
    '・' + tradeNameOf_(t.instrument) + ' ' + (Number(t.currentUnits) > 0 ? '多' : '空') + ' ' + Math.abs(Number(t.currentUnits)) +
    ' 單位，成交 ' + t.price + '，未實現損益 ' + t.unrealizedPL).join('\n') : '📊 目前沒有持倉。';
  const log = tradeLogList_().slice(-3);
  if (tradeMode_() === 'paper' && log.length) text += '\n\n📝 最近的模擬紀錄：\n' + log.map(x => '・' + x.at + ' ' + x.name + ' ' + (x.side === 'buy' ? '買進' : '賣出') + ' @ ' + x.price).join('\n');
  return { text: text, buttons: rows, flex: tradeFlex_('📊 持倉', text, rows), alt: '📊 持倉' };
}

/* ---------- 設定與 OANDA 連線（金鑰只從 TRADE_CFG 讀） ---------- */
// TRADE_CFG 範例（在「指令碼屬性」新增一個屬性，值是下面這段 JSON）：
// {"apiKey":"你的OANDA金鑰","account":"101-xxx-xxxxxxx-001","mode":"paper","env":"practice"}

// 指令碼屬性超過 50 個時，「專案設定」頁面會變成唯讀，只能用程式寫入。
// 步驟：把下面的 apiKey、account 改成你自己的值，在編輯器選「tradeSetCfgOnce_」按「執行」一次，
// 跑完後馬上把 apiKey、account 改回 YOUR_ 開頭的預留字（程式碼裡不要留下真的金鑰）。
// 已經有 TRADE_CFG 時不會覆寫，要改設定請先在指令碼屬性刪掉 TRADE_CFG。
function tradeSetCfgOnce_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('TRADE_CFG')) { console.log('TRADE_CFG 已存在，沒有覆寫'); return; }
  const cfg = { apiKey: 'YOUR_OANDA_API_KEY', account: 'YOUR_ACCOUNT_ID', mode: 'paper', env: 'practice' };
  if (cfg.apiKey.indexOf('YOUR_') === 0) throw new Error('請先把 apiKey、account 改成你自己的值再執行');
  props.setProperty('TRADE_CFG', JSON.stringify(cfg));
  console.log('TRADE_CFG 已寫入（金鑰不顯示）');
}

function tradeCfg_() {
  try { return JSON.parse(prop_('TRADE_CFG') || '{}'); } catch (e) { return {}; }
}

function tradeMode_() {
  const m = tradeCfg_().mode || 'paper';
  return ['paper', 'practice', 'live'].indexOf(m) >= 0 ? m : 'paper';
}

function tradeModeZh_() {
  return { paper: '模擬（不送單）', practice: 'OANDA 模擬帳戶', live: '真實帳戶⚠️' }[tradeMode_()];
}

function tradeBase_() {
  return tradeCfg_().env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
}

function tradeAcct_(sub) { return '/v3/accounts/' + tradeCfg_().account + sub; }

function tradeFetch_(method, path, body) {
  const cfg = tradeCfg_();
  if (!cfg.apiKey || !cfg.account) {
    throw new Error('還沒設定 OANDA 金鑰，請到 Apps Script「專案設定→指令碼屬性」新增 TRADE_CFG（內容請看 Trade.gs 最上面的範例）');
  }
  const res = UrlFetchApp.fetch(tradeBase_() + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
    payload: body ? JSON.stringify(body) : null,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { /* 不是 JSON 就用原文 */ }
  if (code >= 400) throw new Error('OANDA ' + code + '：' + (json.errorMessage || text.slice(0, 200)));
  return json;
}

function tradeQuote_(instrument) {
  const p = tradeFetch_('get', tradeAcct_('/pricing?instruments=' + instrument)).prices[0];
  return (Number(p.bids[0].price) + Number(p.asks[0].price)) / 2;   // 中間價，同 Python 版 get_price
}

// 同 Python 版 analysis.py：M15 收盤價算 EMA9／EMA21，這根剛好交叉才算訊號
function tradeSignal_(instrument) {
  const data = tradeFetch_('get', '/v3/instruments/' + instrument + '/candles?granularity=M15&count=100&price=M');
  const closes = (data.candles || []).filter(c => c.complete).map(c => Number(c.mid.c));
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

function tradeOpenCount_() { return (tradeFetch_('get', tradeAcct_('/openTrades')).trades || []).length; }

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
  list.push({ at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'), name: p.name, side: p.side, units: p.units, price: Number(price).toFixed(TRADE_ITEMS[p.name].prec), sl: p.sl, tp: p.tp, label: label });
  tradeSaveState_(Object.assign(tradeState_(), { log: list.slice(-20) }));
}

function tradeNameOf_(instrument) {
  const hit = Object.keys(TRADE_ITEMS).filter(n => TRADE_ITEMS[n].id === instrument)[0];
  return hit || instrument;
}

function tradeRound_(x, prec) { return Number(x.toFixed(prec)); }

function tradeToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); }

// LINE 卡片（Flex）：每一顆按鈕都是「送出一句文字」，所以會走同一套 answer_ 指令，不會直接下單
function tradeFlex_(title, body, rows) {
  return {
    type: 'bubble', size: 'kilo',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: body, wrap: true, size: 'sm', color: '#6B5A45' },
      ].concat(rows.map(r => ({
        type: 'box', layout: 'horizontal', spacing: 'sm', contents: r.map((label, i) => ({
          type: 'button', style: i ? 'secondary' : 'primary', height: 'sm', flex: 1,
          action: { type: 'message', label: label, text: label },
        })),
      }))),
    },
  };
}
