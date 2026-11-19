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
  '黃金': { label: '黃金', epic: 'MT.D.GC.FBMU3.IP', size: 1, sl: 150, tp: 300, pip: 0.01, prec: 2 },   // 使用者提供，尚未用 IG 行情驗證；可能是特定到期月合約
  '原油': { label: '布倫特原油', epic: 'CC.D.LCO.UNC.IP', size: 1, drift: 50, sl: 50, tp: 100, pip: 1, prec: 2 },   // pip 1：停損停利以價格單位計（IG 的 stopDistance 也是價格單位，與持倉一致）   // 使用者提供，尚未用 IG 行情驗證
  '納指': { label: '納斯達克100指數', epic: 'IX.D.NASDAQ.IFMM.IP', size: 0.2, min: 0.2, sl: 200, tp: 400, pip: 1, prec: 1 },   // pip 1：IG 的 stopDistance 200 = 200 個指數點（持倉停損 ±200、停利 ∓400 已驗證），提案與紀錄也用同一單位   // 美國科技股100指數 現貨 ($1)，由查代碼結果取得，尚未用行情驗證
};
const TRADE_MAX_DAILY_DEFAULT = 5;    // 每日下單上限的預設值（全商品合計）；使用者可在「⚙️ 下單上限」改，存在 TRADE_DAILY_CAP
const TRADE_MAX_OPEN = 2;             // 同時最多持倉數
const TRADE_MAX_SIZE = 5;             // 單筆最多下單數量（防止誤打大數字）
let TRADE_AUTH_ = null;               // 同一次執行內共用一組登入，不用每個呼叫都登入一次
const TRADE_TTL_MS = 5 * 60 * 1000;   // 提案 5 分鐘內有效
const TRADE_DRIFT = 0.5;              // 確認時報價離提案超過「停損距離 × 0.5」就不下單
const TRADE_BARS = 210;               // 15 分鐘 K 線抓幾根：EMA200 需要約 200 根已收盤 K 線，多抓一點緩衝
function tradeIsQuota_(err) {
  const m = String(err && err.message || err);
  return m.indexOf('額度已用完') >= 0 || m.indexOf('exceeded-account-historical-data-allowance') >= 0;
}
// 額度用完的提示：算出還要等幾分鐘（額度鎖定 1 小時，從記錄時間起算）
function tradeQuotaMsg_() {
  const at = Number(prop_('QUOTA_AT') || 0);
  const mins = at ? Math.max(1, Math.ceil((3600000 - (Date.now() - at)) / 60000)) : 60;
  return 'IG 歷史資料額度已用完，暫時沒有可用的快取，約 ' + mins + ' 分鐘後會自動再試';
}
// 記下額度用完的時間，並鎖定 1 小時不再呼叫 IG
function tradeMarkQuota_() {
  CacheService.getScriptCache().put('K15_QUOTA', '1', 3600);
  setProp_('QUOTA_AT', String(Date.now()));
}
const TRADE_FIB_RATIOS = [0.191, 0.382, 0.5, 0.618, 0.809];   // 費波那契回檔比例（與網路貼文截圖相同，0.191 非標準的 0.236）

// 交易指令的關鍵字（群組裡用來直接不回應）：只有主人的私人對話才執行這些指令
function tradeAskWord_(t) {
  const s = String(t || '').replace(/\s+/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
  return /^看盤(黃金|原油|納指)$/.test(s) || /^(查代碼|尋找下單|智能下單|自動下單|下單卡片|交易|交易卡片|選擇下單|下單|查看持倉|確認下單|取消下單|下單紀錄|下單上限|設上限|交易提醒|開啟提醒|關閉提醒|下單自檢|買進|賣出|平倉|全部平倉|清除虛擬|取消清除)/.test(s) || s === '持倉' || s === '查詢';
}

// 小乖的文字指令入口（answer_ 裡呼叫）：不是下單指令就回 null，交給後面的 AI
// 注意：呼叫端（handleLine_、handleTelegram_）已先確認是主人本人才會進到這裡
function tradeAsk_(t) {
  try {
    const q = String(t || '').match(/^查代碼\s*(.+)$/);
    if (q) return tradeEpicSearch_(q[1].trim());
    // 卡片上顯示的完整名稱（納斯達克100指數、布倫特原油）也能打，先換回內部代號再比對
    const s = String(t || '').replace(/\s+/g, '').replace(/納斯達克100指數/g, '納指').replace(/布倫特原油/g, '原油');
    if (/^(尋找下單|智能下單|自動下單|下單卡片|交易|交易卡片)$/.test(s)) return tradeCard_();
    if (/^(選擇下單|下單|🛒選擇下單)$/.test(s)) return tradePickItem_();
    // 語音只能打開卡片、查詢；買進、賣出、平倉、確認一律要在卡片按鈕上按（VOICE_IN_ 由 Code.gs 語音入口設定）
    if (VOICE_IN_ && (/^(買進|買|賣出|賣)(黃金|原油|納指)(\d+(?:\.\d+)?)?$/.test(s) || /^(確認|確認下單|確認平倉|平倉)/.test(s))) return '語音不能直接下單或確認。\n請打開「📈 智能下單」卡片，在卡片上按按鈕。';
    const lk = s.match(/^看盤(黃金|原油|納指)$/);
    if (lk) return tradeLookText_(lk[1]);
    let m = s.match(/^下單(黃金|原油|納指)$/);
    if (m) return tradePickSide_(m[1]);
    m = s.match(/^(買進|買|賣出|賣)(黃金|原油|納指)(\d+(?:\.\d+)?)?$/);   // 可在後面加數量，例如「買進納指 2」，不加就用預設數量
    if (m) return tradePropose_(m[2], /買/.test(m[1]) ? 'buy' : 'sell', m[3]);
    if (/^(查看持倉|查持倉|看持倉|持倉|我的持倉)$/.test(s)) return tradePositions_();
    m = s.match(/^確認下單([A-Za-z0-9]{4,8})?$/);
    if (m) return tradeConfirm_(m[1] || '');
    if (s === '下單自檢') return tradeSelfTest_();
    m = s.match(/^取消下單([A-Za-z0-9]{4,8})?$/);
    if (m) return tradeCancel_(m[1] || '');
    // 提醒推送後回覆「確認」或「否」：只有在有待確認的提案時才算下單指令，否則照常交給小乖
    if ((s === '確認' || s === '否') && tradePending_()) return s === '確認' ? tradeConfirm_('') : tradeCancel_();
    if (s === '下單紀錄') return tradeRecords_();
    if (s === '原油診斷') return tradeOilDiag_();
    if (s === '停損停利紀錄') return tradeStopsAsk_();
    if (/^納指單位(（[\d.]+）)?$/.test(s)) return tradeNqUnitAsk_();
    m = s.match(/^設納指單位(0\.2|0\.4|0\.6|0\.8|1(\.0)?)$/);
    if (m) return tradeNqUnitSet_(m[1]);
    if (s === '下單上限') return tradeCapAsk_();
    m = s.match(/^設上限(\d+|不限)$/);
    if (m) return tradeCapSet_(m[1]);
    if (s === '平倉') return tradeCloseAsk_();
    if (s === '平倉一筆') return tradeCloseMenu_();
    if (/^全部平倉(（\d+筆）)?$/.test(s)) return tradeCloseAllPropose_();
    m = s.match(/^平倉(黃金|原油|納指)(多|空)$/);
    if (m) return tradeClosePropose_(m[1], m[2]);
    m = s.match(/^確認平倉([A-Za-z0-9]{4,8})?$/);
    if (m) return tradeCloseConfirm_(m[1] || '');
    m = s.match(/^取消平倉([A-Za-z0-9]{4,8})?$/);
    if (m) return tradeCloseCancel_(m[1] || '');
    m = s.match(/^清除虛擬([A-Za-z0-9]{4,8})$/);
    if (m) return tradeVirtClearAsk_(m[1].toUpperCase());
    m = s.match(/^確認清除虛擬([A-Za-z0-9]{4,8})$/);
    if (m) return tradeVirtClearConfirm_(m[1].toUpperCase());
    if (s === '取消清除') return tradeVirtClearCancel_();
    if (s === '交易提醒') return tradeRemindStatus_('');
    if (s === '開啟提醒' || s === '關閉提醒') {
      tradeRemindSwitch_(s === '開啟提醒');
      return tradeRemindStatus_(s === '開啟提醒' ? '已開啟，之後有交易訊號會推送提案到 LINE 與 Telegram。' : '已關閉，之後不會再推送提醒。');
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
  const on = prop_('TRADE_REMIND') === 'on';
  const body = '模式：' + tradeModeZh_() + '\n交易提醒：' + (on ? '開啟中' : '已關閉') + '\n選商品與方向 → 按確認 → 查看持倉或平倉' + (p ? '\n\n⏳ 有一張待確認的提案：\n' + tradeProposalText_(p) : '');
  const rows = [['📊 查看持倉', '🛒 下單'], ['📜 下單紀錄'], ['⚙️ 下單上限'], ['📏 納指單位（' + tradeNqUnit_().toFixed(1) + '）'], [on ? '🔕 關閉提醒' : '🔔 開啟提醒'], [p ? '✅ 確認下單' + p.id : '✅ 確認下單', p ? '❌ 取消下單' + p.id : '❌ 取消下單']];
  return { text: '📈 智能下單\n' + tradeAdviceText_(adv) + '\n\n' + body, buttons: rows, flex: tradeFlex_('📈 智能下單', body, rows, tradeAdviceFlex_(adv)), alt: '📈 智能下單卡片' };
}

// 趨勢參考：依 EMA 趨勢標示目前較有利的方向。只是參考，按鈕都能按，不會自動下單，也不寫勝率
function tradeFavorText_(dir) {
  return dir === 'buy' ? '多單有利 📈' : dir === 'sell' ? '空單有利 📉' : '暫無資料';
}

function tradePickItem_() {
  const adv = tradeAdviceRows_();
  const note = '趨勢參考（不保證獲利）：\n' + adv.map(r => '・' + tradeLabelOf_(r.name) + '：' + tradeFavorText_(r.dir)).join('\n');
  const rows = [Object.keys(TRADE_ITEMS).map(n => '下單' + tradeLabelOf_(n)), ['📊 查看持倉', '❌ 取消下單']];
  return { text: '要下單哪一個？\n' + note, buttons: rows, flex: tradeFlex_('🛒 選商品', note, rows), alt: '🛒 選商品' };
}

function tradePickSide_(name) {
  let dir = '';
  dir = tradeDirOf_(TRADE_ITEMS[name]).dir || '';
  const label = tradeLabelOf_(name);
  const buy = ['🟢 買進' + label], sell = ['🔴 賣出' + label];
  const rows = (dir === 'sell' ? [sell, buy] : [buy, sell]).concat([['❌ 取消下單']]);   // 有利的方向排在前面，兩個都能按
  const note = '趨勢參考：' + tradeFavorText_(dir) + '（不保證獲利）' + (TRADE_ITEMS[name].min ? '\n數量：在指令後面加數字，最小 ' + TRADE_ITEMS[name].min + '，例如「買進' + tradeLabelOf_(name) + ' ' + TRADE_ITEMS[name].min * 2 + '」' : '');
  return { text: '要買還是賣' + label + '？\n' + note, buttons: rows, flex: tradeFlex_('🛒 ' + label, note, rows), alt: '🛒 ' + label };
}

// IG 規定的最小下單數量（/markets 的 dealingRules.minDealSize）；取不到回傳 0，不擋提案
function tradeMinDeal_(it) {
  try { return Number(tradeFetch_('get', '/markets/' + it.epic, 3).dealingRules.minDealSize.value) || 0; } catch (e) { return 0; }
}

// 產生提案：只存在 TRADE_STATE 裡，不會下單
function tradePropose_(name, side, sizeText, notice) {
  const it = TRADE_ITEMS[name];
  // 數量以 min 為單位（納指 0.2，其他 1）：要在 min 到 TRADE_MAX_SIZE 之間，而且是 min 的整數倍
  if (it.off) return it.off + '，沒有產生提案。';
  const min = it.min || 1;
  const size = Number((sizeText ? Number(sizeText) : (name === '納指' ? tradeNqUnit_() : it.size)).toFixed(2));
  const steps = size / min;
  if (!(size >= min && size <= TRADE_MAX_SIZE) || Math.abs(steps - Math.round(steps)) > 1e-6) return '數量要是 ' + min + ' 的倍數，在 ' + min + ' 到 ' + TRADE_MAX_SIZE + ' 之間，沒有產生提案。';
  // IG 規定的最小下單數量（dealingRules.minDealSize）；取不到就不擋
  const minDeal = tradeMinDeal_(it);
  if (minDeal && size < minDeal) return '這個商品最小下單數量是 ' + minDeal + '，沒有產生提案。';
  const price = tradeQuote_(it);
  // 趨勢只是提案的參考資訊：K 線取不到（例如額度用完）不影響提案本身
  const sig = tradeDirOf_(it);   // 同一套 4 小時 EMA 方向（見 tradeDirOf_）
  const dir = side === 'buy' ? 1 : -1;
  const p = {
    id: tradeToken_(), name: name, side: side, size: size, price: price,
    sl: tradeRound_(price - dir * it.sl * it.pip, it.prec),
    tp: tradeRound_(price + dir * it.tp * it.pip, it.prec),
    expires: Date.now() + TRADE_TTL_MS, at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'), sig: sig.text,
    against: !!sig.dir && sig.dir !== side,
  };
  tradeSaveState_(Object.assign(tradeState_(), { pending: p }));
  const body = (notice ? notice + '\n\n' : '') + tradeProposalText_(p) + '\n\n5 分鐘內按確認才會送出。';
  const rows = [['✅ 確認下單' + p.id, '❌ 取消下單' + p.id]];   // 按鈕帶提案代碼：舊卡片只能確認／取消它自己的那張
  return { text: '🧾 下單提案（' + tradeModeZh_() + '）\n' + body, buttons: rows, flex: tradeFlex_('🧾 下單提案', body, rows), alt: '🧾 下單提案' };
}

function tradeProposalText_(p) {
  const it = TRADE_ITEMS[p.name];
  return (p.at ? '提案時間：' + p.at + '\n' : '') + '商品：' + tradeLabelOf_(p.name) + '（' + it.epic + '）\n' +
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
    if (it.off) return it.off + '，沒有下單。';
    const mode = tradeMode_();
    const env = tradeCfg_().env === 'live' ? 'live' : 'demo';
    if (mode === 'live' && env !== 'live') return '設定不一致：mode 是 live，但 env 不是 live，沒有下單。';
    if (mode === 'practice' && env === 'live') return '設定不一致：mode 是 practice，但 env 是 live，沒有下單。';

    const now = tradeQuote_(it);
    const info = tradeMarketInfo_(it.epic);
    const allow = it.drift || it.sl * it.pip * TRADE_DRIFT;   // 允許的報價變動（價格單位）：商品有設 drift 就用它，沒有就用停損距離 × TRADE_DRIFT
    if (Math.abs(now - p.price) > allow) {
      // 報價在提案後跳動超過允許範圍：不下單，改用最新報價重新出提案，仍要再按一次確認
      const moved = Math.abs(now - p.price).toFixed(it.prec);
      const notice = '報價在你按確認前變動了 ' + moved + '（提案 ' + p.price.toFixed(it.prec) + '，現在 ' + now.toFixed(it.prec) + '），超過允許的 ' + allow.toFixed(it.prec) + '，所以沒有下單。\n已依最新報價重新出提案，請確認後再按一次。';
      return tradePropose_(p.name, p.side, String(p.size), notice);
    }
    const day = tradeDay_();
    const cap = tradeMaxDaily_();
    if (day.n >= cap) return '今天已經下了 ' + day.n + ' 筆，已達每日上限 ' + cap + ' 筆，沒有下單。（可在「⚙️ 下單上限」調整）';
    // 紙上模式不查 IG 持倉；IG 模式才檢查同時持倉上限
    if (mode !== 'paper' && tradeOpenCount_() >= TRADE_MAX_OPEN) return '同時持倉已達上限 ' + TRADE_MAX_OPEN + ' 筆，沒有下單。';

    if (mode === 'paper') {
      tradeLog_(p, now, '模擬紀錄，沒有送到 IG', '', tradeMarginOf_(now, p.size, info, ''));
      tradeVirtAdd_(p, now, tradeMarginOf_(now, p.size, info, ''));
      tradeBump_(day);
      return '📝 模擬下單完成（沒有送到 IG）\n' + tradeProposalText_(p);
    }

    // IG：送單成功（拿到 dealReference）就先記錄與計數，之後再查成交結果；查詢失敗也不會漏記
    const label = mode === 'live' ? '真實帳戶' : 'IG 模擬帳戶';
    const placed = tradeFetch_('post', '/positions/otc', 2, {
      epic: it.epic, expiry: '-', direction: p.side === 'buy' ? 'BUY' : 'SELL', size: p.size, orderType: 'MARKET',
      currencyCode: 'USD', forceOpen: true, guaranteedStop: false,
      stopDistance: it.sl, limitDistance: it.tp,
    });
    const ref = placed.dealReference || '';
    tradeBump_(day);
    tradeLog_(p, p.price, label + '，成交狀態待確認', ref, tradeMarginOf_(p.price, p.size, info, ''));
    if (!ref) return '⏳ 已送出，但 IG 沒有回傳單號，紀錄已標示「成交狀態待確認」，請按「📊 查看持倉」核對。';
    let conf = null, checkErr = '';
    try { conf = tradeFetch_('get', '/confirms/' + ref, 1); } catch (e) { checkErr = e.message || String(e); }
    if (!conf) return '⏳ 已送出，但查詢成交結果失敗：' + checkErr + '\n紀錄已標示「成交狀態待確認」，請按「📊 查看持倉」核對。';
    if (conf.dealStatus !== 'ACCEPTED') {
      const reason = conf.reason || conf.dealStatus || '未知原因';
      tradeLogSet_(ref, { label: label + '，未成交：' + reason });
      return '❌ 下單沒有成交：' + reason + '\n（紀錄已更新）';
    }
    const fillPrice = Number(conf.level);
    tradeLogSet_(ref, { price: fillPrice.toFixed(it.prec), label: label + '，已成交', margin: tradeMarginRound_(tradeMarginOf_(fillPrice, p.size, info, '')) });
    const done = '✅ 已送出（' + label + '）\n方向：' + (p.side === 'buy' ? '買進' : '賣出') + ' ' + p.size + ' 單位\n成交價：' + fillPrice.toFixed(it.prec) +
      '\n停損：' + p.sl.toFixed(it.prec) + '\n停利：' + p.tp.toFixed(it.prec) +
      '\n成交投入成本：' + (tradeMarginOf_(fillPrice, p.size, info, '') > 0 ? '約 ' + tradeMarginOf_(fillPrice, p.size, info, '').toFixed(2) + ' USD' : '未知');
    tradeNotify_('📣 成交通知\n' + tradeLabelOf_(p.name) + ' ' + (p.side === 'buy' ? '買進' : '賣出') + ' ' + p.size + ' 單位\n' + done.split('\n').slice(2).join('\n'));
    return done;
  });
}

function tradeCancel_(token) {
  const had = tradePending_();
  if (token && had && token.toUpperCase() !== had.id) return '提案代碼對不上，可能是舊的提案，沒有取消。';
  tradeSaveState_(Object.assign(tradeState_(), { pending: null }));
  return had ? '❌ 已取消，這張提案沒有送出。' : '目前沒有待確認的下單。';
}

// IG 目前的持倉整理成一種格式：卡片顯示、平倉都用這個
function tradeOpenPositions_() {
  const positions = tradeFetch_('get', '/positions', 2).positions || [];
  return positions.map(x => {
    const buy = x.position.direction === 'BUY';
    const name = tradeNameOf_(x.market.epic);
    const info = tradeMarketInfo_(x.market.epic);
    const size = Number(x.position.size), open = Number(x.position.level);
    const cur = x.position.currency || info.cur;
    return {
      dealId: x.position.dealId, epic: x.market.epic, name: name, dir: buy ? 'buy' : 'sell', dirZh: buy ? '多' : '空',
      size: size, open: open, sl: x.position.stopLevel, tp: x.position.limitLevel,
      bid: Number(x.market.bid), offer: Number(x.market.offer), prec: (TRADE_ITEMS[name] || { prec: 2 }).prec,
      cur: cur, margin: tradeMarginOf_(open, size, info, cur),
    };
  });
}

// 開倉成本 = 開倉價 × 數量；損益的百分比都以投入成本（保證金）為分母
function tradeOpenCostText_(x) {
  return (x.open * x.size).toFixed(2) + (x.cur ? ' ' + x.cur : '');
}

// 百分比的分母：投入成本（保證金）；合計時可直接給 cost。取不到保證金就是 NaN，不顯示百分比
function tradeCostOf_(x) {
  if (x.cost > 0) return x.cost;
  return x.margin > 0 ? x.margin : NaN;
}

// 未實現損益（約）後面加上幣別，例如「約 20.80 USD」；幣別未知就標示
// 百分比 = 損益 ÷ 投入成本（保證金），已含方向
function tradePnlText_(x, upl) {
  const cost = tradeCostOf_(x);
  const pct = isFinite(cost) ? upl / cost * 100 : NaN;
  const cur = x.cur ? ' ' + x.cur : '（幣別未知）';
  return '約 ' + upl.toFixed(2) + cur + (isFinite(pct) ? '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）' : '');
}

// 實際投入金額（保證金）= 數量 × 價格 × 保證金比例（IG 的 marginFactor，單位 PERCENTAGE）
// 假設：每 1 單位、價格每變動 1 元，損益就是 1 元（和 tradePnlText_ 的損益算法一致，不乘 contractSize）；
// 保證金和持倉幣別要一樣，不一樣或單位不認得就回傳 NaN（顯示「保證金未知」）
function tradeMarginOf_(price, size, info, cur) {
  if (!(price > 0) || !(size > 0) || !(info.mf > 0) || info.unit !== 'PERCENTAGE') return NaN;
  if (cur && info.cur && cur !== info.cur) return NaN;
  return size * price * info.mf / 100;
}

// 寫進紀錄或虛擬倉位的保證金：取不到就存 null
function tradeMarginRound_(m) { return m > 0 ? Number(m.toFixed(2)) : null; }

// IG 市場資訊：幣別、保證金比例與單位。取不到就給空值（之後顯示「保證金未知」），不影響持倉顯示
function tradeMarketInfo_(epic) {
  try {
    const ins = tradeFetch_('get', '/markets/' + epic, 3).instrument || {};
    return { cur: ((ins.currencies || [])[0] || {}).code || '', mf: Number(ins.marginFactor), unit: ins.marginFactorUnit || '' };
  } catch (e) { return { cur: '', mf: NaN, unit: '' }; }
}

function tradeLevel_(v, prec) {
  return v === null || v === undefined || v === '' ? '未設定' : Number(v).toFixed(prec);
}

// 損益百分比（以投入成本為分母）：沒有投入成本就是 NaN
function tradePctOf_(pnl, x) {
  const base = tradeCostOf_(x);
  return isFinite(base) ? pnl / base * 100 : NaN;
}

// 停損、停利價位碰到時的損益（約）：NaN 代表沒設定
function tradeLevelUpl_(x, v) {
  return v === null || v === undefined || v === '' ? NaN : (x.dir === 'buy' ? Number(v) - x.open : x.open - Number(v)) * x.size;
}

// 停損、停利碰到時的損益文字；沒設定就回傳「未設定」
function tradeLevelPnlText_(x, v) {
  const upl = tradeLevelUpl_(x, v);
  return isFinite(upl) ? tradePnlText_(x, upl) : '未設定';
}

/* ---------- 平倉：先出提案，按「✅ 確認平倉」才送出；不自動平倉，只有主人能用 ---------- */

// 按「📉 平倉」：沒有持倉就說明；只有一筆就直接出提案；多筆就列出讓主人選
function tradeCloseAsk_() {
  if (tradeMode_() === 'paper') return { text: '📝 紙上模式沒有真實持倉可平。', buttons: [['📊 查看持倉']] };
  const list = tradeOpenPositions_();
  if (!list.length) return { text: '📊 目前沒有持倉可平。', buttons: [['📊 查看持倉']] };
  // 任何持倉數量都有「平倉一筆」「全部平倉」；選好會先給你看提案，確認後才平
  const rows = [['平倉一筆'], ['全部平倉（' + list.length + ' 筆）'], ['📊 查看持倉']];
  const note = '要平哪一筆？或全部平倉？\n選好會先給你看提案，確認後才會平倉。';
  return { text: note, buttons: rows, flex: tradeFlex_('📉 選擇平倉', note, rows), alt: '📉 選擇平倉' };
}

// 單筆平倉提案（依商品與方向找到那一筆）
function tradeClosePropose_(name, dirZh) {
  const hit = tradeOpenPositions_().filter(x => x.name === name && x.dirZh === dirZh)[0];
  if (!hit) return { text: '找不到這個持倉，可能已經平倉了。\n請先按「📊 查看持倉」。', buttons: [['📊 查看持倉']] };
  return tradeCloseMake_([hit]);
}

// 全部平倉：把目前所有在智能下單清單內的持倉列成一份提案，仍要按確認
function tradeCloseAllPropose_() {
  if (tradeMode_() === 'paper') return { text: '📝 紙上模式沒有真實持倉可平。', buttons: [['📊 查看持倉']] };
  const list = tradeOpenPositions_().filter(x => TRADE_ITEMS[x.name]);
  if (!list.length) return { text: '📊 目前沒有可平的持倉。', buttons: [['📊 查看持倉']] };
  return tradeCloseMake_(list);
}

// 「平倉一筆」的子選單：每筆一顆按鈕，選了才會出提案
function tradeCloseMenu_() {
  if (tradeMode_() === 'paper') return { text: '📝 紙上模式沒有真實持倉可平。', buttons: [['📊 查看持倉']] };
  const list = tradeOpenPositions_();
  if (!list.length) return { text: '📊 目前沒有持倉可平。', buttons: [['📊 查看持倉']] };
  const labels = [];
  list.forEach(x => { const l = '平倉' + tradeLabelOf_(x.name) + x.dirZh; if (labels.indexOf(l) < 0) labels.push(l); });
  const rows = labels.map(l => [l]).concat([['📊 查看持倉']]);
  const note = '要平哪一筆？\n選好會先給你看提案，確認後才會平倉。';
  return { text: note, buttons: rows, flex: tradeFlex_('📉 平倉一筆', note, rows), alt: '📉 平倉一筆' };
}

// 產生平倉提案（一筆或多筆）：只存在 TRADE_STATE.closePending，不會送單。價格用平倉方向（平多用買價，平空用賣價）
function tradeCloseMake_(list) {
  const items = list.map(x => {
    const price = x.dir === 'buy' ? x.bid : x.offer;
    const upl = (x.dir === 'buy' ? price - x.open : x.open - price) * x.size;
    return { dealId: x.dealId, name: x.name, epic: x.epic, dir: x.dir, dirZh: x.dirZh, size: x.size, open: x.open, price: price, prec: x.prec, margin: x.margin, cur: x.cur, upl: upl };
  });
  const p = { id: tradeToken_(), items: items, expires: Date.now() + TRADE_TTL_MS };
  tradeSaveState_(Object.assign(tradeState_(), { closePending: p }));
  const totU = items.reduce((a, i) => a + i.upl, 0);
  const totC = items.reduce((a, i) => a + tradeCostOf_(i), 0);
  let body;
  if (items.length === 1) {
    const it = items[0];
    body = '商品：' + tradeLabelOf_(it.name) + '（' + it.epic + '）\n' +
      '方向：平' + it.dirZh + '（' + (it.dir === 'buy' ? '賣出' : '買進') + '）' + it.size + ' 單位\n' +
      '開倉價：' + it.open.toFixed(it.prec) + '\n' +
      '目前價：' + it.price.toFixed(it.prec) + '\n' +
      '未實現損益 ' + tradePnlText_(it, it.upl) + '\n';
  } else {
    body = items.map(it => '・' + tradeLabelOf_(it.name) + ' 平' + it.dirZh + ' ' + it.size + ' 單位，未實現損益 ' + tradePnlText_(it, it.upl)).join('\n') +
      '\n合計 ' + tradePnlText_({ cur: items[0].cur, cost: totC }, totU, ' ') + '\n\n共 ' + items.length + ' 筆，會逐筆平倉。\n';
  }
  body += '5 分鐘內按確認才會送出。\n代碼：' + p.id;
  const rows = [['✅ 確認平倉' + p.id, '❌ 取消平倉' + p.id]];
  return { text: '📉 平倉提案（' + tradeModeZh_() + '）\n' + body, buttons: rows, flex: tradeFlex_('📉 平倉提案', body, rows), alt: '📉 平倉提案' };
}

// 確認平倉：一次性；代碼對不上、過期就不平倉。提案裡的每一筆各自檢查、各自送單，一筆失敗不影響其他筆。平倉不計入每日新單數
function tradeCloseConfirm_(token) {
  return withLock_(() => {
    const p = tradeState_().closePending;
    if (!p) return '目前沒有待確認的平倉。\n請先按「📉 平倉」。';
    if (token && token.toUpperCase() !== p.id) return '確認碼對不上，可能是舊的平倉提案，沒有平倉。';
    tradeSaveState_(Object.assign(tradeState_(), { closePending: null }));   // 一次性：不管成不成功都先清掉
    if (!p.items) return '平倉提案格式已更新，沒有平倉。\n請重新按「📉 平倉」。';
    if (Date.now() > p.expires) return '這張平倉提案已超過 5 分鐘，沒有平倉。\n請重新按「📉 平倉」。';
    if (tradeMode_() === 'paper') return '📝 紙上模式沒有真實持倉可平。';
    const mode = tradeMode_(), env = tradeCfg_().env === 'live' ? 'live' : 'demo';
    if (mode === 'live' && env !== 'live') return '設定不一致：mode 是 live，但 env 不是 live，沒有平倉。';
    if (mode === 'practice' && env === 'live') return '設定不一致：mode 是 practice，但 env 是 live，沒有平倉。';
    const label = mode === 'live' ? '真實帳戶' : 'IG 模擬帳戶';
    const nowList = tradeOpenPositions_();
    const lines = p.items.map(item => {
      try { return tradeCloseOne_(item, nowList, label); }
      catch (err) { return '❌ ' + tradeLabelOf_(item.name) + ' 平' + item.dirZh + '：' + (err.message || err) + '\n（這筆沒有確認結果，請到「📊 查看持倉」核對）'; }
    });
    const done = p.items.filter(i => i.done);
    let total = '';
    if (done.length > 1) {
      const u = done.reduce((a, i) => a + i.done.upl, 0);
      const c = done.reduce((a, i) => a + i.done.cost, 0);
      total = '\n合計盈虧 ' + tradePnlText_({ cur: done[0].done.cur, cost: c }, u, ' ');
    }
    return '（' + label + '）\n' + lines.join('\n') + total;
  });
}

// 平掉一筆：先確認持倉還在、數量沒變，再送平倉單，最後查成交結果（IG 的平倉用 POST 加 _method: DELETE）
function tradeCloseOne_(item, nowList, label) {
  const tag = tradeLabelOf_(item.name) + ' 平' + item.dirZh + ' ' + item.size + ' 單位';
  const hit = nowList.filter(x => x.dealId === item.dealId)[0];
  if (!hit) return '⏭ ' + tag + '：這筆持倉已經不在了，沒有平倉。';
  if (hit.size !== item.size) return '⏭ ' + tag + '：持倉數量已經改變，沒有平倉。\n請重新按「📉 平倉」。';
  if (TRADE_ITEMS[hit.name] && TRADE_ITEMS[hit.name].off) return '⏭ ' + tag + '：' + TRADE_ITEMS[hit.name].off + '，沒有平倉。請到 IG App 手動處理。';
  if (!TRADE_ITEMS[hit.name]) return '⏭ ' + tag + '：這個商品不在智能下單的清單裡，請直接到 IG 網站處理。';
  const closeDir = hit.dir === 'buy' ? 'SELL' : 'BUY';
  const placed = tradeFetch_('post', '/positions/otc', 1, { dealId: hit.dealId, direction: closeDir, size: hit.size, orderType: 'MARKET', expiry: '-' }, { _method: 'DELETE' });
  const ref = placed.dealReference || '';
  tradeLog_({ name: hit.name, side: hit.dir === 'buy' ? 'sell' : 'buy', size: hit.size, sl: '-', tp: '-' }, item.price, '平倉（' + label + '），成交狀態待確認', ref, hit.margin);
  if (!ref) return '⏳ ' + tag + '：已送出，但 IG 沒有回傳單號，紀錄已標示待確認。';
  let conf = null, checkErr = '';
  try { conf = tradeFetch_('get', '/confirms/' + ref, 1); } catch (e) { checkErr = e.message || String(e); }
  if (!conf) return '⏳ ' + tag + '：已送出，但查詢結果失敗：' + checkErr + '\n紀錄已標示待確認。';
  if (conf.dealStatus !== 'ACCEPTED') {
    const reason = conf.reason || conf.dealStatus || '未知原因';
    tradeLogSet_(ref, { label: '平倉（' + label + '），未成交：' + reason });
    return '❌ ' + tag + '：沒有成交：' + reason;
  }
  const fill = Number(conf.level).toFixed(hit.prec);
  tradeLogSet_(ref, { price: fill, label: '平倉（' + label + '），已成交' });
  tradeStopAdd_({ name: hit.name, dir: hit.dir, dirZh: hit.dirZh, size: hit.size, trigger: '平倉', price: Number(fill), prec: hit.prec, open: hit.open, margin: hit.margin, cur: hit.cur }, hit.dealId);   // 停損停利紀錄也記一筆，並從比對快照移除，避免重複記
  tradeNotify_('📣 平倉通知\n' + tradeLabelOf_(hit.name) + ' 平' + hit.dirZh + ' ' + hit.size + ' 單位，成交價 ' + fill);
  const upl = (item.dir === 'buy' ? Number(fill) - item.open : item.open - Number(fill)) * item.size;
  item.done = { upl: upl, cost: tradeCostOf_(item), cur: item.cur };   // 給多筆時算合計用
  return '✅ ' + tag + '，成交價 ' + fill + '\n  盈虧 ' + tradePnlText_(item, upl, ' ');
}

function tradeCloseCancel_(token) {
  const p = tradeState_().closePending;
  if (!p) return '目前沒有待確認的平倉。';
  if (token && token.toUpperCase() !== p.id) return '提案代碼對不上，可能是舊的平倉提案，沒有取消。';
  tradeSaveState_(Object.assign(tradeState_(), { closePending: null }));
  return '❌ 已取消，這張平倉提案沒有送出。';
}

// 下單紀錄：列出最近 10 筆（模擬與實際送單成交都會記在這裡），只讀
// 平倉紀錄若有損益，顯示獲利（🟢）或虧損（🔴）的金額與百分比，算法跟持倉一樣
function tradeRecords_() {
  const list = tradeLogList_().slice(-10).reverse();
  const rows = [['📈 智能下單', '📊 查看持倉']];
  if (!list.length) return { text: '📜 還沒有下單紀錄。', buttons: rows };
  const text = '📜 下單紀錄（含停損、停利，最近 ' + list.length + ' 筆）\n' + list.map(x => {
    const pr = (TRADE_ITEMS[x.name] || { prec: 2 }).prec;
    const lv = v => v === '-' ? '—' : tradeLevel_(v, pr);   // 平倉紀錄沒有停損、停利，顯示「—」
    const pl = x.pnl === undefined ? '' : '\n  ' + (x.pnl >= 0 ? '🟢 獲利 +' : '🔴 虧損 ') + Math.abs(x.pnl).toFixed(2) + ' ' + (x.cur || 'USD') +
      (typeof x.pct === 'number' ? '（' + (x.pct >= 0 ? '+' : '-') + Math.abs(x.pct).toFixed(2) + '%）' : '');
    return '・' + x.at + ' ' + x.name + ' ' + (x.side === 'buy' ? '買進' : '賣出') + ' ' + x.size + ' 單位 @ ' + x.price + '（' + x.label + '）\n' +
      '  停損 ' + lv(x.sl) + '　停利 ' + lv(x.tp) + pl;
  }).join('\n') +
    '\n\n「成交狀態待確認」表示送單後查不到成交結果，請到「📊 查看持倉」核對。';
  return { text: text, buttons: rows, flex: tradeFlex_('📜 下單紀錄', text, rows), alt: '📜 下單紀錄' };
}

// 查看持倉分兩區：真實倉位（IG 帳戶的持倉，紙上模式不查）、虛擬倉位（紙上模式記下的模擬單，損益用目前報價估算）
function tradePositions_() {
  const paper = tradeMode_() === 'paper';
  const real = paper ? [] : tradeOpenPositions_();
  if (!paper) tradeReconcile_(real);
  const virt = tradeVirtOpen_();
  // 最下面的「🔍 持倉」：重新抓持倉與報價，只讀，不下單、不平倉
  const rows = [['📈 交易', '🛒 下單'], ['📉 平倉']].concat(virt.map(v => ['🗑 清除虛擬' + v.id]), [['🔍 持倉'], ['📋 停損停利紀錄']]);
  const realNote = paper ? '紙上模式不查 IG，切到 IG 模擬帳戶模式才看得到真實倉位。' : '目前沒有。';
  // 真實倉位前面獨立一行標示「IG Group 模擬倉／真實倉」；虛擬倉位在商品名後面標示「虛擬」
  const realTag = tradeMode_() === 'live' ? 'IG Group 真實倉' : 'IG Group 模擬倉';
  const all = (real.length ? [realTag] : []).concat(real.map(x => tradePosLine_(x)), virt.map(v => tradePosLine_(v)));
  const text = (all.length ? '📊 持倉\n' + all.join('\n') : '📊 目前沒有持倉。' + (paper ? '\n' + realNote : '')) +
    '\n\n📉 平倉只對真實倉位有效。虛擬倉位可按「🗑 清除虛擬」移除紀錄，不會送出任何單。';
  // 真實與虛擬仍在同一個區塊；真實倉位上方獨立一行標示，沒有任何持倉就只顯示一句話
  const lead = [];
  if (real.length) lead.push({ type: 'text', text: realTag, size: 'sm', weight: 'bold', color: '#2A2118' }, ...tradePosFlex_(real));
  if (virt.length) lead.push(...tradePosFlex_(virt));
  if (!real.length && !virt.length) lead.push(tradeNoteFlex_(paper ? realNote : '目前沒有持倉。'));
  lead.push({ type: 'separator', color: '#E8DCC4' });
  return { text: text, buttons: rows, flex: tradeFlex_('📊 持倉', '平倉需先按確認，提案 5 分鐘內有效。', rows, lead), alt: '📊 持倉' };
}

// 一筆持倉的文字行（真實與虛擬共用）
function tradePosLine_(x) {
  const now = x.dir === 'buy' ? x.bid : x.offer;
  const ok = isFinite(now);
  const upl = (x.dir === 'buy' ? now - x.open : x.open - now) * x.size;
  return '・' + tradeLabelOf_(x.name) + ' ' + x.dirZh + (x.dir === 'buy' ? ' 📈 ' : ' 📉 ') + x.size + ' 單位，開倉 ' + x.open.toFixed(x.prec) +
    '，現價 ' + (ok ? now.toFixed(x.prec) : '未取得') +
    '\n  投入成本 ' + (x.margin > 0 ? '約 ' + x.margin.toFixed(2) + (x.cur ? ' ' + x.cur : '') : '未知') +
    '\n  未實現損益 ' + (ok ? tradePnlText_(x, upl) : '未取得') +
    '\n  停損 ' + tradeLevel_(x.sl, x.prec) + '，碰到損益 ' + tradeLevelPnlText_(x, x.sl) +
    '\n  停利 ' + tradeLevel_(x.tp, x.prec) + '，碰到損益 ' + tradeLevelPnlText_(x, x.tp);
}

function tradeNoteFlex_(t) {
  return { type: 'text', text: t, size: 'xs', color: '#5C4E3C', wrap: true };
}

/* ---------- 虛擬倉位：紙上模式確認的模擬單，只存在 TRADE_STATE.virt，不會送到 IG ---------- */

function tradeVirtList_() { return tradeState_().virt || []; }

// 紙上模式確認時呼叫：記下一筆虛擬倉位（最多保留 10 筆）
function tradeVirtAdd_(p, price, margin) {
  const list = tradeVirtList_().concat([{
    id: tradeToken_(), name: p.name, side: p.side, size: p.size, price: Number(price), sl: p.sl, tp: p.tp, margin: tradeMarginRound_(margin),
    at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'),
  }]).slice(-10);
  tradeSaveState_(Object.assign(tradeState_(), { virt: list }));
}

// 轉成和真實倉位一樣的格式顯示；報價取不到（例如沒有 IG 登入資料）就顯示「未取得」
function tradeVirtOpen_() {
  return tradeVirtList_().map(v => {
    const it = TRADE_ITEMS[v.name];
    let now = NaN;
    try { now = tradeQuote_(it); } catch (e) { now = NaN; }
    const buy = v.side === 'buy';
    return {
      id: v.id, name: tradeLabelOf_(v.name) + '・虛擬', epic: it.epic, dir: buy ? 'buy' : 'sell', dirZh: buy ? '多' : '空',
      size: v.size, open: v.price, sl: v.sl, tp: v.tp, bid: now, offer: now, prec: it.prec,
      margin: v.margin > 0 ? v.margin : NaN,
      cur: 'USD',   // 虛擬單和送出的訂單一樣用 USD 計價（見 tradeConfirm_ 的 currencyCode）
    };
  });
}

// 清除虛擬倉位要按兩次：先出確認卡，再按「✅ 確認清除」才刪紀錄；不送任何單
function tradeVirtClearAsk_(id) {
  const v = tradeVirtList_().filter(x => x.id === id)[0];
  if (!v) return { text: '找不到這筆虛擬倉位，可能已經清除了。', buttons: [['📊 查看持倉']] };
  tradeSaveState_(Object.assign(tradeState_(), { vclear: { id: id, expires: Date.now() + TRADE_TTL_MS } }));
  const body = '要清除這筆虛擬倉位的紀錄嗎？\n' + tradeLabelOf_(v.name) + ' ' + (v.side === 'buy' ? '買進' : '賣出') + ' ' + v.size + ' 單位 @ ' + v.price +
    '\n清除只會刪掉紀錄，不會送出任何單。5 分鐘內有效。';
  const rows = [['✅ 確認清除虛擬' + id, '❌ 取消清除']];
  return { text: '🗑 清除虛擬倉位\n' + body, buttons: rows, flex: tradeFlex_('🗑 清除虛擬倉位', body, rows), alt: '🗑 清除虛擬倉位' };
}

function tradeVirtClearConfirm_(id) {
  return withLock_(() => {
    const c = tradeState_().vclear;
    tradeSaveState_(Object.assign(tradeState_(), { vclear: null }));   // 一次性
    if (!c || c.id !== id) return '這個清除要求已經失效，沒有清除。\n請重新按「📊 查看持倉」。';
    if (Date.now() > c.expires) return '清除要求已超過 5 分鐘，沒有清除。';
    const list = tradeVirtList_();
    const next = list.filter(x => x.id !== id);
    if (next.length === list.length) return '找不到這筆虛擬倉位，可能已經清除了。';
    tradeSaveState_(Object.assign(tradeState_(), { virt: next }));
    return '🗑 已清除虛擬倉位紀錄（沒有送出任何單）。';
  });
}

function tradeVirtClearCancel_() {
  tradeSaveState_(Object.assign(tradeState_(), { vclear: null }));
  return '❌ 已取消，虛擬倉位沒有清除。';
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
function tradeFetch_(method, path, version, body, extra) {
  const cfg = tradeCfg_();
  const auth = tradeLogin_();
  const res = UrlFetchApp.fetch(tradeBase_() + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: Object.assign({ 'X-IG-API-KEY': cfg.apiKey, CST: auth.cst, 'X-SECURITY-TOKEN': auth.token, Version: String(version), Accept: 'application/json' }, extra || {}),
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

// 下單自檢（只讀，不下單）：把 sl／tp 點數換算成價格距離，並對照 IG 回報的點值與最小停損距離。
// 實測步驟（由使用者手動做，程式不會自動下單）：
// 1. 「下單自檢」看每個商品的換算與 IG 的 onePipMeans 是否一致、停損是否高於 IG 最小值。
// 2. 在 practice 模式下按「🛒 下單」→ 納指 → 買進納指 1，看提案的停損價是否約為參考價 ∓ 20.0。
// 3. 按「✅ 確認下單＋代碼」送出 1 單，到 IG 模擬帳戶看該單的停損價與停利價，是否與提案一致。
// 4. 用「📊 查看持倉」確認持倉數量與開倉價；確認後到 IG 網站手動平倉。
function tradeSelfTest_() {
  try {
    const lines = Object.keys(TRADE_ITEMS).map(name => {
      const it = TRADE_ITEMS[name];
      tradeEpicCheck_(it);
      const m = tradeFetch_('get', '/markets/' + it.epic, 3);
      const rules = (m.dealingRules || {}).minStopOrProfitDistance || {};
      const pipMeans = (m.instrument || {}).onePipMeans || '（IG 未回傳）';
      const priceSl = it.sl * it.pip, priceTp = it.tp * it.pip;
      const minOk = rules.value === undefined || rules.unit !== 'POINTS' || (it.sl >= rules.value && it.tp >= rules.value);
      return '・' + tradeLabelOf_(name) + '：停損 ' + it.sl + ' 點 ＝ 價格 ' + priceSl.toFixed(it.prec) + '，停利 ' + it.tp + ' 點 ＝ 價格 ' + priceTp.toFixed(it.prec) +
        '\n  IG 點值：' + pipMeans + '；最小停損／停利：' + (rules.value !== undefined ? rules.value + ' ' + rules.unit : '（IG 未回傳）') +
        '\n  結果：' + (minOk ? '✅ 通過' : '❌ 低於 IG 最小值，請調整');
    });
    return '🧪 下單自檢（只讀，沒有下單）\n' + lines.join('\n');
  } catch (err) {
    console.error(err);
    return '下單自檢失敗：' + (err && err.message || err);
  }
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
// 共用方向判斷（智能下單、提案的參考都用這個，和 ⚡ 下單面板同一套 4 小時 EMA）：
// 方向 = EMA6 在 EMA21 之上為多單、之下為空單；額度用完只剩過期資料時不給方向，只顯示等待提示
function tradeDirOf_(it) {
  try {
    const h = tradeH4Look_(it);
    if (h.stale) return { dir: '', text: 'EMA：IG 歷史資料額度用完，暫時沒有最新資料，請稍後再看', err: 'IG 歷史資料額度用完，請稍後再試' };
    if (!h.dir) return { dir: '', text: h.text, err: 'K 線不足' };
    return { dir: h.dir, text: h.text, err: '' };
  } catch (err) {
    const m = String((err && err.message) || err);
    return { dir: '', text: 'EMA：' + m, err: m.slice(0, 120) };
  }
}

// 看盤（唯讀）：現價、停損停利參考、EMA 與進出場燈號；不產生提案、不下單（對話頁快速下單用）
// 2026-11-18：EMA 與燈號改用 4 小時已收盤 K 線，和圖表同一組資料；現價是即時報價（買賣中間價）
function tradeLookText_(name) {
  const it = TRADE_ITEMS[name];
  if (it.off) return it.off;
  const price = tradeQuote_(it);
  const dec = (v) => v.toFixed(it.prec);
  let h4;
  try { h4 = tradeH4Look_(it); } catch (err) { return '【' + tradeLabelOf_(name) + '】看盤取不到（' + (err && err.message || err) + '）'; }
  return '【' + tradeLabelOf_(name) + '】\n' +
    '現價：' + dec(price) + '\n' +
    '買進停損：' + dec(price - it.sl * it.pip) + ' ／ 停利：' + dec(price + it.tp * it.pip) + '\n' +
    '賣出停損：' + dec(price + it.sl * it.pip) + ' ／ 停利：' + dec(price - it.tp * it.pip) + '\n' +
    h4.text + '\n（看盤只讀取，沒有產生提案，也不會下單）';
}

// 4 小時已收盤 K 線的收盤中間價（舊到新），快取到下一根 4 小時 K 線；只給看盤用
function tradeClosesH4_(it) {
  const cache = CacheService.getScriptCache();
  const key = 'K4H_' + it.epic + '_' + Math.floor(Date.now() / 14400000);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const saveKey = 'K4B_' + it.epic.replace(/[^A-Za-z0-9]/g, '_');
  const saved = () => {
    let v = null;
    try { v = JSON.parse(prop_(saveKey) || 'null'); } catch (e) { v = null; }
    if (v && v.closes && v.closes.length) return { closes: v.closes, stale: true, at: v.at, bar: v.bar || '' };
    throw new Error(tradeQuotaMsg_());   // 從來沒有成功抓到過，只能等額度恢復
  };
  if (cache.get('K15_QUOTA')) return saved();
  let data;
  try { data = tradeFetch_('get', '/prices/' + it.epic + '/HOUR_4/' + (TRADE_BARS + 1), 2); }
  catch (err) {
    if (tradeIsQuota_(err)) { tradeMarkQuota_(); return saved(); }
    throw err;
  }
  if (!data || !data.prices) throw new Error('IG 回傳沒有 4 小時 prices');
  const closes = data.prices.slice(0, -1).map(c => (Number(c.closePrice.bid) + Number(c.closePrice.ask)) / 2).slice(-TRADE_BARS);
  const at = Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm');
  const bar = (data.prices.slice(0, -1).slice(-1)[0] || {}).snapshotTimeUTC || '';
  const out = { closes: closes, stale: false, at: at, bar: bar };
  cache.put(key, JSON.stringify(out), 3600);
  setProp_(saveKey, JSON.stringify({ closes: closes, at: at, bar: bar }));
  return out;
}

// 看盤用的 EMA 與燈號（4 小時）：燈號是「這根剛成立」的條件，成立才亮
function tradeH4Look_(it) {
  tradeEpicCheck_(it);
  const r = tradeClosesH4_(it);
  const closes = r.closes;
  const n = closes.length;
  const note = r.stale ? '（IG 歷史資料額度用完，以下為 ' + r.at + ' 的快取，只供參考，不亮燈號）\n' : '';
  if (n < 200) return { text: 'EMA：4 小時 K 線不足（只拿到 ' + n + ' 根已收盤 K 線）\n燈號：{}', dir: '', stale: !!r.stale, sig: '', bar: '' };
  const e6 = tradeEma_(closes, 6), e12 = tradeEma_(closes, 12), e21 = tradeEma_(closes, 21), e32 = tradeEma_(closes, 32), e200 = tradeEma_(closes, 200);
  const last = closes[n - 1];
  const up = e6[n - 2] <= e21[n - 2] && e6[n - 1] > e21[n - 1];
  const down = e6[n - 2] >= e21[n - 2] && e6[n - 1] < e21[n - 1];
  const above = last > e200[n - 1], below = last < e200[n - 1];
  const exDn = e6[n - 2] >= e12[n - 2] && e6[n - 1] < e12[n - 1];
  const exUp = e6[n - 2] <= e12[n - 2] && e6[n - 1] > e12[n - 1];
  const lamps = { up: up, above: above, down: down, below: below, exDn: exDn, exUp: exUp };
  const sig = r.stale ? '' : up && above ? '做多進場點' : down && below ? '做空進場點' : '';
  const exitSig = r.stale ? '' : exDn ? '（出場參考：EMA6 下穿 EMA12）' : exUp ? '（出場參考：EMA6 上穿 EMA12）' : '';
  const p = it.prec;
  const fibText = r.stale ? '費波那契：IG 額度用完，等待最新資料，暫不顯示' : tradeFibText_(it, last);
  const sigDir = r.stale ? '' : up && above ? 'buy' : down && below ? 'sell' : '';
  return { text: note + 'EMA（4 小時已收盤 K 線）：\n' +
    'EMA6：' + e6[n - 1].toFixed(p) + '\nEMA12：' + e12[n - 1].toFixed(p) + '\nEMA21：' + e21[n - 1].toFixed(p) +
    '\nEMA32：' + e32[n - 1].toFixed(p) + '\nEMA200：' + e200[n - 1].toFixed(p) + '\n' +
    'EMA 6／12／21／32／200 模式：' + (sig || '無進場訊號') + exitSig + '\n' +
    '燈號：' + JSON.stringify(r.stale ? {} : lamps) + (fibText ? '\n' + fibText : ''), dir: r.stale ? '' : (e6[n - 1] > e21[n - 1] ? 'buy' : 'sell'), stale: !!r.stale, sig: sigDir, bar: r.bar || '' };
}

// 切換進出場模式（在編輯器執行）。預設 classic 不變；ema5 會改變提醒與下單建議的訊號，需先確認
function tradeEma5On() { console.log('進出場已固定使用 4 小時 EMA 規則，這個指令不再需要'); }
function tradeEma5Off() { console.log('進出場已固定使用 4 小時 EMA 規則，這個指令不再需要'); }

/* ---------- 費波那契回檔參考（預設關閉，只顯示參考，不影響交叉訊號、提醒或下單） ---------- */

// 開啟：在編輯器執行 tradeFibOn()。需先用 tradeFibSet(高點, 低點) 設定波段高低點
function tradeFibOn() { setProp_('TRADE_FIB', 'on'); console.log('費波那契參考已開啟（只顯示參考，不影響下單）'); }

// 關閉：在編輯器執行 tradeFibOff()。關閉後完全不顯示費波那契文字
function tradeFibOff() { setProp_('TRADE_FIB', 'off'); console.log('費波那契參考已關閉'); }

// 預設一律用 4 小時線自動算出的目前高低點（參考 IG 最近 30 根已收盤 4 小時 K 線的高低點，例如納斯達克100）。
// 手動值只在明確帶入兩個數字時才會用：tradeFibSet(高, 低)。在編輯器的「執行」按鈕不會帶參數，所以那裡執行 tradeFibSet 或 tradeFibAuto 都是清除手動值、改回自動。
function tradeFibSet(hi, lo) {
  if (hi === undefined && lo === undefined) { tradeFibAuto(); return; }   // 不帶參數 = 清除手動值，改回自動
  if (!(Number(hi) > Number(lo))) throw new Error('高點要大於低點（收到的高 ' + hi + '、低 ' + lo + '）');
  setProp_('TRADE_FIB_HL', JSON.stringify({ hi: Number(hi), lo: Number(lo) }));
  setProp_('TRADE_FIB_SRC', 'manual');
  console.log('費波那契高低點已手動設定：高 ' + Number(hi) + '，低 ' + Number(lo));
}

// 清除手動值，改回用 4 小時線自動計算（預設）。在編輯器執行即可
function tradeFibAuto() {
  PropertiesService.getScriptProperties().deleteProperty('TRADE_FIB_HL');
  setProp_('TRADE_FIB_SRC', 'auto');
  console.log('費波那契高低點改用 4 小時線自動計算（已清除手動值）');
}

// 取最近 TRADE_FIB_BARS_4H 根已收盤 4 小時 K 線的最高價與最低價（中間價），每小時最多向 IG 要一次
const TRADE_FIB_BARS_4H = 30;   // 約 5 天的 4 小時線
function tradeFib4h_(it) {
  const cache = CacheService.getScriptCache();
  const key = 'H4_' + it.epic + '_' + Math.floor(Date.now() / 3600000);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const h4Key = 'H4B_' + it.epic.replace(/[^A-Za-z0-9]/g, '_');
  const saved = () => { const v = JSON.parse(prop_(h4Key) || 'null'); if (v && v.hi > v.lo) return Object.assign({}, v, { stale: true }); throw new Error(tradeQuotaMsg_()); };
  if (cache.get('K15_QUOTA')) return saved();
  let data;
  try { data = tradeFetch_('get', '/prices/' + it.epic + '/HOUR_4/' + (TRADE_FIB_BARS_4H + 1), 2); }
  catch (err) {
    if (String(err.message || err).indexOf('exceeded-account-historical-data-allowance') >= 0) {
      tradeMarkQuota_();
      return saved();
    }
    throw err;
  }
  if (!data || !data.prices) throw new Error('IG 回傳沒有 4 小時 prices');
  const closed = data.prices.slice(0, -1).slice(-TRADE_FIB_BARS_4H);   // 丟掉還沒收盤的最後一根
  if (!closed.length) throw new Error('4 小時 K 線不足');
  const mid = o => (Number(o.bid) + Number(o.ask)) / 2;
  const out = { hi: Math.max(...closed.map(c => mid(c.highPrice))), lo: Math.min(...closed.map(c => mid(c.lowPrice))), bars: closed.length };
  cache.put(key, JSON.stringify(out), 3600);
  setProp_(h4Key, JSON.stringify({ hi: out.hi, lo: out.lo, bars: out.bars }));
  return out;
}

// 由高點往下算回檔價位：價 = 高 − (高 − 低) × 比例。開關關閉時回傳空字串
// 高低點預設用 4 小時線自動計算；若執行過 tradeFibSet(高, 低) 則改用手動數字
function tradeFibText_(it, last) {
  if (prop_('TRADE_FIB') === 'off') return '';   // 2026-11-18 起預設開啟
  let hl = null, src = '';
  if (prop_('TRADE_FIB_SRC') === 'manual') {
    try { hl = JSON.parse(prop_('TRADE_FIB_HL') || 'null'); } catch (e) { hl = null; }
    if (!hl || !(hl.hi > hl.lo)) return '費波那契參考：手動高低點不正確（請重新執行 tradeFibSet）';
    src = '手動設定';
  } else {
    try { hl = tradeFib4h_(it); } catch (err) { return '費波那契參考：4 小時線取不到（' + ((err && err.message) || err) + '）'; }
    if (!(hl.hi > hl.lo)) return '費波那契參考：4 小時線高低點不正確';
    if (hl.stale) return '費波那契：IG 額度用完，等待最新資料，暫不顯示';
    src = '4 小時線近 ' + hl.bars + ' 根已收盤 K 線的高低點' + (hl.stale ? '（IG 額度用完，用上次快取）' : '');
  }
  const range = hl.hi - hl.lo;
  const lines = TRADE_FIB_RATIOS.map(r => '・' + r.toFixed(3) + '：' + (hl.hi - range * r).toFixed(it.prec));
  return '費波那契回檔參考（只是參考，不保證獲利）：\n高 ' + hl.hi.toFixed(it.prec) + '、低 ' + hl.lo.toFixed(it.prec) + '（' + src + '）\n' +
    lines.join('\n') + '\n現價：' + Number(last).toFixed(it.prec);
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
  const text = '🔔 交易提醒：' + (on ? '開啟中（每 5 分鐘檢查一次，有交易訊號就推送提案到 LINE 與 Telegram，只推提案，不會自動送單）' : '已關閉，不會推送提醒') + (note ? '\n' + note : '');
  return { text: text, buttons: rows, flex: tradeFlex_('🔔 交易提醒', text, rows), alt: '🔔 交易提醒' };
}

// 觸發器每 5 分鐘呼叫一次：只推送提案，不送單
function tradeRemindTick_() {
  try {
    if (prop_('TRADE_REMIND') !== 'on') return;
    if (tradeMode_() !== 'paper') tradeReconcile_(tradeOpenPositions_());
    const cur = tradePending_();
    if (cur && cur.expires > Date.now()) return;   // 已有待確認的提案，不重複推送
    const day = tradeDay_();
    if (day.n >= tradeMaxDaily_() || (tradeMode_() !== 'paper' && tradeOpenCount_() >= TRADE_MAX_OPEN)) return;
    const seen = tradeState_().alerts || {};
    for (const name of Object.keys(TRADE_ITEMS)) {
      if (TRADE_ITEMS[name].off) continue;   // 暫停的商品不推提醒
      const sig = tradeAlertOf_(TRADE_ITEMS[name]);
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

// 自動提醒用的進場訊號：和 ⚡ 下單面板同一套（4 小時 EMA6 上穿 EMA21 且在 EMA200 之上做多，反向做空）；額度用完不推送
function tradeAlertOf_(it) {
  try {
    const h = tradeH4Look_(it);
    return { signal: h.stale ? '' : (h.sig || ''), bar: h.bar || '' };
  } catch (err) {
    return { signal: '', bar: '' };
  }
}

// 同一張提案同時推到 Telegram（按鈕＋文字）與 LINE（快速回覆按鈕＋文字）。
// LINE 推播會計入官方帳號每月 200 則額度；可在 TRADE_CFG 的 notify.remindLine 設為 false 關掉
function tradeRemindSend_(name, side) {
  const res = tradePropose_(name, side);
  const id = (tradePending_() || {}).id || '';   // 按鈕與快速回覆都帶提案代碼，只會作用在這一張
  const head = '🔔 智能下單提醒\n' + res.text;
  const chat = prop_('TG_OWNER_CHAT_ID');
  if (chat) {
    tgApi_('sendMessage', {
      chat_id: chat,
      text: head + '\n\n回覆「確認」送出，回覆「否」取消，或直接按下方按鈕。',
      reply_markup: { inline_keyboard: [[{ text: '✅ 確認下單', callback_data: 'trade_ok:' + id }, { text: '❌ 否', callback_data: 'trade_no:' + id }]] },
    });
  }
  const notify = tradeCfg_().notify || {};
  if (notify.remindLine !== false && prop_('OWNER_USER_ID')) {
    try {
      lineApi_('push', { to: prop_('OWNER_USER_ID'), messages: [{
        type: 'text', text: head + '\n\n回覆「確認」送出，回覆「否」取消，或直接按下方按鈕。',
        quickReply: { items: [
          { type: 'action', action: { type: 'message', label: '✅ 確認下單', text: '確認下單' + id } },
          { type: 'action', action: { type: 'message', label: '❌ 否', text: '取消下單' + id } },
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
  const m = String(cq.data || '').match(/^trade_(ok|no)(?::([A-Za-z0-9]+))?$/);
  if (!m) return;
  const reply = m[1] === 'ok' ? tradeConfirm_(m[2] || '') : tradeCancel_(m[2] || '');
  tgApi_('answerCallbackQuery', { callback_query_id: cq.id, text: '已處理' });
  tgApi_('sendMessage', { chat_id: owner, text: typeof reply === 'string' ? reply : reply.text });
}

// 智能下單頁面最上面的方向參考：依 EMA 趨勢，只是參考，方向仍由使用者自己選，不會自動下單
function tradeAdviceRows_() {
  return Object.keys(TRADE_ITEMS).map(name => {
    const d = tradeDirOf_(TRADE_ITEMS[name]);
    return { name: name, dir: d.dir, err: d.err };
  });
}

function tradeDirZh_(dir) {
  return dir === 'buy' ? '多單 📈' : dir === 'sell' ? '空單 📉' : '暫無資料';
}

function tradeAdviceText_(rows) {
  return '方向參考（不保證獲利）\n' + rows.map(r => tradeLabelOf_(r.name) + '：' + (r.dir ? tradeDirZh_(r.dir) : '讀取失敗') + (r.err ? '（' + r.err + '）' : '')).join('\n');
}

// 卡片最上面：每個商品一行，多單綠、空單紅，一眼就看得出來
function tradeAdviceFlex_(rows) {
  const UP = '#B3261E', DOWN = '#2E7D4F', INK = '#2A2118', SOFT = '#5C4E3C';
  const line = r => ({
    type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '14px', cornerRadius: '12px', backgroundColor: '#FFFFFF', borderWidth: '1px', borderColor: '#E8DCC4', contents: [
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: tradeLabelOf_(r.name), size: 'md', weight: 'bold', color: INK, flex: 3, gravity: 'center' },
        { type: 'text', text: r.dir ? tradeDirZh_(r.dir) : '讀取失敗', size: 'xl', weight: 'bold', align: 'end', flex: 2, color: r.dir === 'buy' ? UP : r.dir === 'sell' ? DOWN : SOFT },
      ] },
    ].concat(r.err ? [{ type: 'text', text: '原因：' + r.err, size: 'xxs', color: DOWN, wrap: true }] : []),
  });
  return [{ type: 'text', text: '方向參考（不保證獲利）', size: 'xs', color: SOFT, wrap: true }]
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

// 原油診斷（只讀，不下單、不平倉）：列出 IG 回傳的價格與單位欄位，用來找出價格放大的原因
function tradeOilDiag_() {
  const it = TRADE_ITEMS['原油'];
  const m = tradeFetch_('get', '/markets/' + it.epic, 3);
  const ins = m.instrument || {}, snap = m.snapshot || {}, rules = m.dealingRules || {};
  const pos = tradeOpenPositions_().filter(x => x.epic === it.epic);
  const pick = (o, keys) => keys.map(k => k + ' = ' + (o[k] === undefined ? '（無）' : JSON.stringify(o[k]))).join('\n');
  const text = '🔎 原油診斷（只讀）\n【報價】\n' + pick(snap, ['bid', 'offer', 'scalingFactor', 'updateTime']) +
    '\n【商品】\n' + pick(ins, ['scalingFactor', 'contractSize', 'lotSize', 'valueOfOnePip', 'onePipMeans', 'marginFactor', 'marginFactorUnit', 'currencies']) +
    '\n【規則】\n' + pick(rules, ['minDealSize', 'minStopOrProfitDistance']) +
    '\n【持倉】\n' + (pos.length ? pos.map(x => 'level = ' + x.open + '，size = ' + x.size + '，stopLevel = ' + x.sl + '，limitLevel = ' + x.tp).join('\n') : '沒有原油持倉');
  return { text: text, buttons: [['📊 查看持倉']] };
}

// 納斯達克的下單單位（沒寫數量時的預設）：存在 script property TRADE_NQ_UNIT，0.2 到 1、以 0.2 為單位；沒設或壞掉就是 0.2
function tradeNqUnit_() {
  const n = Number(prop_('TRADE_NQ_UNIT'));
  return n >= 0.2 && n <= 1 ? Math.round(n * 5) / 5 : 0.2;
}

// 「📏 納指單位」子卡片：0.2、0.4、0.6、0.8、1 五個選項，顯示目前單位
function tradeNqUnitAsk_(note) {
  const u = tradeNqUnit_();
  const text = (note ? note + '\n' : '') + '納斯達克下單單位：' + u.toFixed(1) + '\n沒寫數量時就用這個單位（0.2 到 1，以 0.2 為單位）。';
  const rows = [['設納指單位 0.2', '設納指單位 0.4'], ['設納指單位 0.6', '設納指單位 0.8'], ['設納指單位 1'], ['📈 智能下單']];
  return { text: text, buttons: rows, flex: tradeFlex_('📏 納指單位', text, rows), alt: '📏 納指單位' };
}

// 設定納指單位：0.2 到 1、以 0.2 為單位，其他數字不更改
function tradeNqUnitSet_(v) {
  const n = Math.round(Number(v) * 5) / 5;
  if (!(n >= 0.2 && n <= 1) || Math.abs(Number(v) - n) > 1e-6) return tradeNqUnitAsk_('單位要是 0.2 到 1 之間、以 0.2 為單位，沒有更改。');
  setProp_('TRADE_NQ_UNIT', String(n));
  return tradeNqUnitAsk_('✅ 納斯達克下單單位已設為 ' + n.toFixed(1) + '。');
}

// 停損停利紀錄：每次查持倉或提醒時，拿上一次看到的持倉比對。消失的持倉如果上次報價已經過了停損或停利，就記下來。
// 我們自己平倉的不會記（上次報價通常還沒過停損停利）。觸發價是上次看到的報價，不一定等於實際成交價
function tradeReconcile_(cur) {
  const st = tradeState_();
  const stops = st.stops || [];
  (st.snap || []).forEach(p => {
    if (cur.some(x => x.dealId === p.dealId)) return;
    // 持倉不見了：上次看到的報價可能還沒碰到停損或停利，所以再用目前報價比一次（碰到的時間可能在兩次查詢之間）
    let kind = tradeKindOf_(p, p.now), price = p.now;
    if (!kind) { price = tradeNowOf_(p); kind = tradeKindOf_(p, price); }
    if (kind) {
      stops.push({ at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'), name: p.name, dirZh: p.dirZh, dir: p.dir, size: p.size, trigger: kind, price: price, prec: p.prec, open: p.open || null, margin: p.margin || null, cur: p.cur || '', src: 'real' });
      // 停損或停利被平掉時也發通知，格式與平倉通知一致；價格是上次看到的報價，實際成交價以 IG 為準
      tradeNotify_('📣 ' + kind + '通知\n' + tradeLabelOf_(p.name) + ' 平' + p.dirZh + ' ' + p.size + ' 單位，觸發價約 ' + Number(price).toFixed(p.prec) + '\n（實際成交價以 IG 為準）');
    }
  });
  const snap = cur.map(x => {
    const now = x.dir === 'buy' ? x.bid : x.offer;
    return { dealId: x.dealId, name: x.name, dir: x.dir, dirZh: x.dirZh, size: x.size, sl: x.sl === null || x.sl === undefined || x.sl === '' ? null : Number(x.sl), tp: x.tp === null || x.tp === undefined || x.tp === '' ? null : Number(x.tp), open: x.open > 0 ? x.open : null, margin: x.margin > 0 ? x.margin : null, cur: x.cur || '', now: isFinite(now) ? now : 0, prec: x.prec };
  });
  tradeSaveState_(Object.assign(tradeState_(), { snap: snap, stops: stops.slice(-20) }));
}

// 價格碰到這筆持倉的停損回傳「停損」，碰到停利回傳「停利」，都沒有就回傳空字串
function tradeKindOf_(p, price) {
  if (!(price > 0)) return '';
  const buy = p.dir === 'buy';
  if (p.sl !== null && (buy ? price <= p.sl : price >= p.sl)) return '停損';
  if (p.tp !== null && (buy ? price >= p.tp : price <= p.tp)) return '停利';
  return '';
}

// 目前報價（給比對停損停利用）：取不到回傳 NaN，不影響其他流程
function tradeNowOf_(p) {
  try { return tradeQuote_(TRADE_ITEMS[p.name]); } catch (e) { return NaN; }
}

// 加一筆停損停利紀錄（平倉或比對到的停損停利），並把這筆持倉從比對快照拿掉
function tradeStopAdd_(e, dealId) {
  const st = tradeState_();
  const list = (st.stops || []).concat([Object.assign({ at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm') }, e)]);
  const snap = (st.snap || []).filter(x => x.dealId !== dealId);
  tradeSaveState_(Object.assign(st, { stops: list.slice(-20), snap: snap }));
}

// 一筆停損停利紀錄：投入成本、損益（損益 = (觸發價 − 開倉價) × 數量，空單反向）。舊紀錄沒有開倉價就顯示資料不足
function tradeStopLine_(x) {
  const head = '・' + x.at + ' ' + tradeLabelOf_(x.name) + ' ' + x.dirZh + ' ' + x.size + ' 單位，' + x.trigger + '，觸發價約 ' + Number(x.price).toFixed(x.prec);
  if (!(x.open > 0)) return head + '\n  資料不足（舊紀錄沒有開倉價）';
  const upl = (x.dir === 'buy' ? x.price - x.open : x.open - x.price) * x.size;
  const cost = x.margin > 0 ? '約 ' + x.margin.toFixed(2) + ' USD' : '未知';
  return head + '\n  開倉 ' + Number(x.open).toFixed(x.prec) + '，開倉成本 ' + tradeOpenCostText_(x) + '，投入成本 ' + cost + '\n  損益 ' + tradePnlText_(x, upl, ' ');
}

// 「📋 停損停利紀錄」：最近 10 筆，只讀
function tradeStopsAsk_() {
  const all = (tradeState_().stops || []).slice(-20).reverse();
  const real = all.filter(x => (x.src || 'real') !== 'virt');   // 沒有標記的都是以前從 IG 記下的，算真實倉位
  const virt = all.filter(x => x.src === 'virt');
  const sec = (title, arr) => '【' + title + '】\n' + (arr.length ? arr.map(tradeStopLine_).join('\n') : '・目前沒有紀錄');
  const rows = [['📊 查看持倉'], ['📈 智能下單']];
  const text = '📋 停損停利紀錄（最近 ' + all.length + ' 筆）\n' +
    sec('真實倉位（IG 帳戶）', real.slice(0, 10)) + '\n' +
    sec('模擬倉（紙上模式）', virt.slice(0, 10)) +
    '\n\n觸發價是上次查看持倉時的報價，不一定是實際成交價。';
  return { text: text, buttons: rows, flex: tradeFlex_('📋 停損停利紀錄', text, rows), alt: '📋 停損停利紀錄' };
}

// 每日下單上限：存在 script property TRADE_DAILY_CAP；沒設就用預設 5，設成 none 就不限（Infinity，完全不檢查）
function tradeMaxDaily_() {
  const v = prop_('TRADE_DAILY_CAP');
  if (v === 'none') return Infinity;
  const n = Number(v);
  return v && n > 0 ? n : TRADE_MAX_DAILY_DEFAULT;
}

// 「⚙️ 下單上限」卡片：顯示目前設定，可選 3、5、10、20、不限，或打「設上限 數字」自訂
function tradeCapAsk_(note) {
  const cap = tradeMaxDaily_();
  const text = (note ? note + '\n' : '') + '每日下單上限：' + (cap === Infinity ? '不限' : cap + ' 筆') +
    '\n以台北時間計，只算送出的單，平倉不計。\n選一個，或打「設上限 數字」自訂。';
  const rows = [['設上限 3', '設上限 5'], ['設上限 10', '設上限 20'], ['設上限 不限'], ['📈 智能下單']];
  return { text: text, buttons: rows, flex: tradeFlex_('⚙️ 下單上限', text, rows), alt: '⚙️ 下單上限' };
}

// 設定上限：不限就存 none；數字要是 1 到 1000 的整數，否則不更改
function tradeCapSet_(v) {
  if (v === '不限') { setProp_('TRADE_DAILY_CAP', 'none'); return tradeCapAsk_('✅ 已取消每日下單上限。'); }
  const n = Math.floor(Number(v));
  if (!(n >= 1 && n <= 1000)) return tradeCapAsk_('上限要是 1 到 1000 之間的數字，沒有更改。');
  setProp_('TRADE_DAILY_CAP', String(n));
  return tradeCapAsk_('✅ 每日下單上限已設為 ' + n + ' 筆。');
}

function tradeBump_(day) {
  tradeSaveState_(Object.assign(tradeState_(), { day: { date: day.date, n: day.n + 1 } }));
}

function tradeLogList_() { return tradeState_().log || []; }

function tradeLog_(p, price, label, ref, margin) {
  const list = tradeLogList_();
  list.push({ at: Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm'), name: p.name, side: p.side, size: p.size, price: Number(price).toFixed(TRADE_ITEMS[p.name].prec), sl: p.sl, tp: p.tp, margin: tradeMarginRound_(margin), label: label, ref: ref || '' });
  tradeSaveState_(Object.assign(tradeState_(), { log: list.slice(-20) }));
}

// 更新已記錄的那一筆（例如查到成交價或未成交原因），以 IG 的單號對應
function tradeLogSet_(ref, patch) {
  const list = tradeLogList_().map(x => x.ref === ref ? Object.assign(x, patch) : x);
  tradeSaveState_(Object.assign(tradeState_(), { log: list }));
}

// 顯示用名稱：卡片、按鈕、說明用 label；內部代號（納指、原油…）仍用來比對與儲存
function tradeLabelOf_(n) {
  return (TRADE_ITEMS[n] && TRADE_ITEMS[n].label) || n;
}

function tradeNameOf_(epic) {
  const hit = Object.keys(TRADE_ITEMS).filter(n => TRADE_ITEMS[n].epic === epic)[0];
  return hit || epic;
}

function tradeRound_(x, prec) { return Number(x.toFixed(prec)); }

function tradeToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); }

// LINE 卡片（Flex）：每一顆按鈕都是「送出一句文字」，所以會走同一套 answer_ 指令，不會直接下單
// 版面與小乖精品選單一致：象牙白底、金色漸層標題、每顆按鈕獨占一行
// 持倉卡片：每筆一個小卡，商品與方向在上，開倉、現價、損益、停損、停利排成格子
function tradePosFlex_(list) {
  const UP = '#B3261E', DOWN = '#2E7D4F', INK = '#2A2118', SOFT = '#5C4E3C', LINE = '#E8DCC4';
  const cell = (label, value, color) => ({
    type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
      { type: 'text', text: label, size: 'xs', color: SOFT },
      { type: 'text', text: value, size: 'md', weight: 'bold', color: color || INK, wrap: true },
    ],
  });
  const pnlColor = v => { const u = tradeLevelUpl_(v.x, v.p); return !isFinite(u) ? SOFT : u < 0 ? DOWN : UP; };
  return list.map(x => {
    const now = x.dir === 'buy' ? x.bid : x.offer;
    const upl = (x.dir === 'buy' ? now - x.open : x.open - now) * x.size;
    return {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px', cornerRadius: '12px', backgroundColor: '#FFFFFF', borderWidth: '1px', borderColor: LINE, contents: [
        { type: 'text', text: tradeLabelOf_(x.name), size: 'lg', weight: 'bold', color: INK, wrap: true },
        { type: 'text', text: x.dirZh + (x.dir === 'buy' ? ' 📈' : ' 📉') + '　' + x.size + ' 單位', size: 'sm', weight: 'bold', color: x.dir === 'buy' ? UP : DOWN, wrap: true },
        { type: 'box', layout: 'horizontal', contents: [
          cell('開倉', x.open.toFixed(x.prec)), cell('現價', isFinite(now) ? now.toFixed(x.prec) : '未取得'),
        ] },
        { type: 'box', layout: 'horizontal', contents: [
          cell('投入成本', x.margin > 0 ? '約 ' + x.margin.toFixed(2) + (x.cur ? ' ' + x.cur : '') : '未知'),
          cell('未實現損益', isFinite(upl) ? tradePnlText_(x, upl) : '未取得', upl >= 0 ? UP : DOWN),
        ] },
        { type: 'box', layout: 'horizontal', contents: [
          cell('停損', tradeLevel_(x.sl, x.prec)),
          cell('停損碰到損益', tradeLevelPnlText_(x, x.sl), pnlColor({ x: x, p: x.sl })),
        ] },
        { type: 'box', layout: 'horizontal', contents: [
          cell('停利', tradeLevel_(x.tp, x.prec)),
          cell('停利碰到損益', tradeLevelPnlText_(x, x.tp), pnlColor({ x: x, p: x.tp })),
        ] },
      ],
    };
  });
}

// 精品質感卡片（與小乖主選單一致）：象牙白漸層標題、金色細線、象牙白內容區，按鈕第一顆金色、其餘白底
function tradeFlex_(title, body, rows, lead, foot) {
  const INK = '#2A2118', SOFT = '#5C4E3C', LINE = '#E8DCC4', GOLD = '#B08D57';
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
      type: 'box', layout: 'vertical', paddingAll: '22px', paddingBottom: '18px',
      background: { type: 'linearGradient', angle: '180deg', startColor: '#F4EAD6', endColor: '#FBF8F2' },
      contents: [
        { type: 'text', text: '小乖 · PRIVATE', size: 'xxs', weight: 'bold', color: GOLD },
        { type: 'text', text: title, size: 'xxl', weight: 'bold', color: INK, wrap: true, margin: 'sm' },
        { type: 'box', layout: 'vertical', width: '28px', height: '2px', backgroundColor: '#C9A56A', margin: 'md', contents: [{ type: 'filler' }] },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '22px', backgroundColor: '#FBF8F2', contents: (lead || []).concat([
        { type: 'text', text: body, wrap: true, size: 'sm', color: SOFT },
        { type: 'separator', color: LINE, margin: 'lg' },
      ]).concat(labels.map((label, i) => Object.assign(btn(label, i), { margin: 'sm' })))
        .concat(foot ? [{ type: 'separator', color: LINE, margin: 'lg' }, { type: 'text', text: foot, size: 'xxs', color: '#5C4E3C', wrap: true, margin: 'md' }] : []),
    },
  };
}

/* ---------- 補錄停損停利紀錄（一次性）：從 IG 歷史活動抓最近幾天被系統平掉的真實倉位 ----------
   先在編輯器執行 tradeBackfillPreview()：只列出，不寫入。確認無誤後再執行 tradeBackfillWrite()。
   欄位是依 IG REST 歷史活動的格式撰寫；第一次執行請看 Execution log，確認 channel、level、direction 等欄位對得上。
   補進來的紀錄標記為真實倉位（src: 'real'），來源 ref 是 IG 的 dealId，重複執行不會重複寫入。 */
function tradeBackfillPreview() { return tradeBackfill_(7, false); }
function tradeBackfillWrite() { return tradeBackfill_(7, true); }

function tradeBackfill_(days, write) {
  const to = new Date(), from = new Date(to.getTime() - days * 86400000);
  const fmt = d => Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss");
  let acts = [];
  try {
    const res = tradeFetch_('get', '/history/activity?from=' + encodeURIComponent(fmt(from)) + '&to=' + encodeURIComponent(fmt(to)) + '&detailed=true&pageSize=500', 3);
    acts = (res && res.activities) || [];
  } catch (e) {
    console.log('補錄失敗（IG 查詢）：' + (e.message || e));
    return '補錄失敗：' + (e.message || e);
  }
  const byEpic = {};
  Object.keys(TRADE_ITEMS).forEach(n => { if (TRADE_ITEMS[n].epic) byEpic[TRADE_ITEMS[n].epic] = n; });
  const st = tradeState_();
  const stops = st.stops || [];
  const seen = {};
  stops.forEach(x => { if (x.ref) seen[x.ref] = true; });
  const lines = [];
  let found = [];
  acts.forEach(a => {
    const d = a.details || {};
    const actions = (d.actions || []).map(x => x.actionType);
    if (a.type !== 'POSITION' || actions.indexOf('POSITION_CLOSED') < 0) return;
    const name = byEpic[a.epic] || '';
    lines.push('・' + (a.date || '') + ' ' + (name || a.epic) + ' channel=' + a.channel + ' level=' + d.level + ' size=' + d.size + ' dir=' + d.direction + ' deal=' + a.dealId);
    if (a.channel !== 'SYSTEM' || !name) return;   // 只補系統平掉的（停損或停利）；手動、程式平倉不補
    if (seen[a.dealId]) return;
    const closeDir = String(d.direction || '').toUpperCase();
    const dir = closeDir === 'SELL' ? 'buy' : 'sell';   // 平多是賣出、平空是買進
    const ms = Date.parse(String(a.date || '').replace(/Z?$/, 'Z'));
    found.push({ at: isFinite(ms) ? Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'MM/dd HH:mm') : '', ms: ms || 0,
      name: name, dirZh: dir === 'buy' ? '多' : '空', dir: dir, size: Number(d.size || a.size || 0),
      trigger: '停損或停利', price: Number(d.level), prec: TRADE_ITEMS[name].prec, open: null, margin: null, cur: '', src: 'real', ref: a.dealId });
  });
  // 已經記下的（例如停損停利通知當時自動記的）同商品、同數量、相差一小時內視為重複
  const near = (ms, at) => { const m = String(at || '').match(/^(\d\d)\/(\d\d) (\d\d):(\d\d)$/); if (!m) return false; const t = new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime(); return Math.abs(t - ms) < 3600000; };
  const dup = x => stops.some(y => y.name === x.name && Number(y.size) === x.size && near(x.ms, y.at));
  found = found.filter(x => !dup(x));
  found.sort((x, y) => x.ms - y.ms);
  const head = (write ? '補錄完成' : '補錄預覽（未寫入）') + '：找到 ' + found.length + ' 筆可補的系統平倉，已存在 ' + Object.keys(seen).length + ' 筆紀錄';
  const detail = found.map(x => '・' + x.at + ' ' + x.name + ' ' + x.dirZh + ' ' + x.size + ' 單位，觸發價約 ' + x.price).join('\n');
  const raw = '所有平倉活動（請把這段貼回來確認欄位）：\n' + (lines.join('\n') || '（這段時間沒有平倉活動）');
  console.log(head + '\n' + detail + '\n' + raw);
  if (write && found.length) {
    const clean = found.map(x => { const r = Object.assign({}, x); delete r.ms; return r; });
    tradeSaveState_(Object.assign(st, { stops: stops.concat(clean).slice(-20) }));
  }
  return head;
}
