/* ============ YouTube 自動上傳範本（一律私人上傳）============
   用途：雲端硬碟裡有「YT自動上傳」資料夾，裡面的分類子資料夾放影片，
   程式會把影片上傳到「你自己的」YouTube 頻道，加入對應的播放清單，標題／說明／標記來自這份試算表的「影片資料」分頁。
   未通過審核的 API 專案，上傳的影片會被強制設為「私人」，所以這裡一律用私人上傳，公開要到 YouTube Studio 手動改。
   檔名開頭要和「影片資料」A 欄的集數一致，例如 EP01_開場.mp4 對應 A 欄的 EP01。
   設定順序（每一步都有教學，見 教學.md）：一次設定 → 授權 → 開啟每小時自動上傳 → 開啟每日同步。 */

// ===== 設定區：只需要改這裡 =====
const CONFIG = {
  UPLOAD_FOLDER_NAME: 'YT自動上傳',      // 雲端硬碟根目錄的資料夾名稱
  DONE_FOLDER: '已上傳',                  // 上傳成功後，影片會移到分類資料夾裡的這個子資料夾
  FAIL_FOLDER: '失敗',                    // 連續失敗後，影片會移到分類資料夾裡的這個子資料夾
  // 分類：左邊是「分類子資料夾」的名稱，playlist 是要加入的 YouTube 播放清單名稱（要先在 YouTube 建立），ai 是否標註為 AI 創作
  CATEGORIES: {
    '我的系列': { playlist: '我的系列播放清單', ai: false },
  },
  DATA_SHEET: '影片資料',                 // 試算表分頁：A 集數、B 標題、C 說明、D 標記（空白分隔）
  LOG_SHEET: '上傳紀錄',                  // 試算表分頁：每次上傳與同步的結果
  CATEGORY_ID: '22',                      // YouTube 影片分類代碼，22 = People & Blogs
  MADE_FOR_KIDS: false,                   // 是否為兒童向內容
  SEND_EMAIL: true,                       // 上傳成功或失敗時寄信到你的 Google 帳號
  CHUNK_BYTES: 8 * 1024 * 1024,           // 每段 8MB（必須是 256KB 的倍數）
  BUDGET_MS: 4 * 60 * 1000,               // 每次執行最多用 4 分鐘（Apps Script 上限 6 分鐘）
  MAX_FAILS: 3,                           // 同一支影片連續失敗幾次就移到失敗資料夾
};
const STATE_KEY = 'YT_TPL_STATE';         // 目前進行中的上傳進度（存在指令碼屬性）

// ===== 一次性設定：在編輯器選「一次設定」按「執行」一次 =====
function 一次設定() {
  const f = 取得上傳資料夾_();
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(CONFIG.DATA_SHEET)) {
    const sh = ss.insertSheet(CONFIG.DATA_SHEET);
    sh.appendRow(['集數', '標題', '說明', '標記']);
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName(CONFIG.LOG_SHEET)) {
    const sh = ss.insertSheet(CONFIG.LOG_SHEET);
    sh.appendRow(['時間', '檔名', '結果', '影片連結']);
    sh.setFrozenRows(1);
  }
  Logger.log('設定完成。上傳資料夾：' + f.getName());
  return '設定完成。上傳資料夾：' + f.getName();
}

// ===== 授權：第一次執行會跳出授權視窗，按「允許」即可 =====
function 授權() {
  UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { muteHttpExceptions: true, headers: 授權標頭_() });
  DriveApp.getRootFolder().getName();
  SpreadsheetApp.getActive().getName();
  MailApp.getRemainingDailyQuota();
  Logger.log('授權完成');
  return '授權完成';
}

// ===== 排程 =====
function 開啟每小時自動上傳() {
  關閉自動上傳();
  ScriptApp.newTrigger('立即檢查一次').timeBased().everyHours(1).create();
  Logger.log('已開啟：每小時檢查一次上傳資料夾');
  return '已開啟：每小時檢查一次上傳資料夾';
}
function 關閉自動上傳() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === '立即檢查一次') ScriptApp.deleteTrigger(t); });
  return '已關閉自動上傳';
}
function 開啟每日同步() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === '每日同步') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('每日同步').timeBased().everyDays(1).atHour(9).create();
  return '已開啟：每天 9 點左右同步「影片資料」的標題、說明、標記';
}

// ===== 檢查設定：列出資料夾、分類、播放清單、影片資料是否都對得上 =====
function 檢查設定() {
  const lines = [];
  const folder = 取得上傳資料夾_();
  lines.push('上傳資料夾：' + folder.getName());
  Object.keys(CONFIG.CATEGORIES).forEach(name => {
    const hasSub = folder.getFoldersByName(name).hasNext();
    const cat = CONFIG.CATEGORIES[name];
    const plId = cat.playlist ? 取得播放清單ID_(cat.playlist) : '';
    lines.push('分類「' + name + '」：子資料夾' + (hasSub ? '有' : '沒有') + '，播放清單' + (cat.playlist ? (plId ? '找到了' : '找不到') : '不加入'));
  });
  lines.push('影片資料：' + Object.keys(讀影片資料_()).length + ' 集');
  lines.push('排程：' + ScriptApp.getProjectTriggers().length + ' 個');
  const st = 讀進度_();
  lines.push('進行中：' + (st ? st.name + '，' + Math.floor(100 * st.offset / st.size) + '%' : '無'));
  const text = lines.join('\n');
  Logger.log(text);
  return text;
}

// ===== 入口：每小時的排程與手動執行都用這個。LockService 避免手動與排程同時跑 =====
function 立即檢查一次() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return '上一次上傳還在進行中，這次先不跑。';
  try {
    const started = Date.now();
    const folder = 取得上傳資料夾_();
    const out = [];
    for (let i = 0; i < 50; i++) {        // 50 只是保險上限
      const r = 上傳一步_(folder, started);
      if (r.msg) out.push(r.msg);
      if (!r.keepGoing) break;
    }
    return out.join('\n') || '沒有待上傳的影片。';
  } finally { lock.releaseLock(); }
}

// 處理一步：有進行中的影片就接著傳；沒有就挑下一支開始
function 上傳一步_(folder, started) {
  let st = 讀進度_();
  try {
    if (!st) {
      st = 開始下一支_(folder);
      if (!st) return { keepGoing: false, msg: '' };
    }
    const r = 傳送_(st, started);
    if (!r.finished) {
      存進度_(st);
      return { keepGoing: false, msg: '⏳ ' + st.name + ' 上傳中，' + Math.floor(100 * st.offset / st.size) + '%，下次自動接著傳。' };
    }
    st.videoId = r.videoId;
    存進度_(st);
    if (st.plId && !st.plDone) { 加入播放清單_(st.plId, st.videoId); st.plDone = true; 存進度_(st); }
    移檔_(st, folder, CONFIG.DONE_FOLDER);
    清除進度_();
    const link = 'https://youtu.be/' + st.videoId;
    記錄_(st.name, '已上傳（私人）', link);
    寄通知_('📤 已上傳到 YouTube（目前是私人）\n' + st.title + '\n' + link +
      '\n\n要公開：到 YouTube Studio 把可見範圍改成「公開」。\nhttps://studio.youtube.com/video/' + st.videoId + '/edit');
    return { keepGoing: Date.now() - started < CONFIG.BUDGET_MS, msg: '📤 ' + st.name + ' 已上傳（私人）：' + link };
  } catch (e) {
    return 出錯_(folder, st, e);
  }
}

// 挑下一支要上傳的影片：只看分類子資料夾（依名稱排序），檔名集數要在「影片資料」找得到，播放清單要存在
function 挑下一支_(folder) {
  const data = 讀影片資料_();
  const subs = [];
  const it = folder.getFolders();
  while (it.hasNext()) subs.push(it.next());
  subs.sort((a, b) => (a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0));
  for (const sub of subs) {
    const cat = CONFIG.CATEGORIES[sub.getName()];
    if (!cat) continue;                    // 沒有設定分類的子資料夾略過（用「檢查設定」可以看到）
    const files = [];
    const fi = sub.getFiles();
    while (fi.hasNext()) { const f = fi.next(); if (/\.(mp4|mov)$/i.test(f.getName())) files.push(f); }
    files.sort((a, b) => (a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0));
    for (const f of files) {
      const meta = data[集數代號_(f.getName()).toUpperCase()];
      if (!meta) continue;                 // 影片資料還沒有這一集，下次再試
      const plId = cat.playlist ? 取得播放清單ID_(cat.playlist) : '';
      if (cat.playlist && !plId) continue; // 播放清單還沒在 YouTube 建立，下次再試
      return { file: f, parentId: sub.getId(), meta: meta, cat: cat, plId: plId };
    }
  }
  return null;
}

// 開始一支新影片：只記下進度，還沒有建立上傳連線
function 開始下一支_(folder) {
  const pick = 挑下一支_(folder);
  if (!pick) return null;
  const f = pick.file;
  const st = {
    fileId: f.getId(), name: f.getName(), parentId: pick.parentId,
    title: pick.meta.title, desc: pick.meta.desc, tags: 標記截斷_(pick.meta.tags),
    mime: /\.mov$/i.test(f.getName()) ? 'video/quicktime' : 'video/mp4',
    size: f.getSize(), offset: 0, sessionUri: '', fails: 0, videoId: '',
    plId: pick.plId, plDone: !pick.plId, ai: !!pick.cat.ai,
  };
  存進度_(st);
  return st;
}

// 分段傳送：超過時間預算就先停下，進度已存好，下次接著傳
function 傳送_(st, started) {
  if (st.videoId) return { finished: true, videoId: st.videoId };
  if (!st.size) throw new Error('影片檔案是空的');
  if (!st.sessionUri) { st.sessionUri = 建立上傳連線_(st); st.offset = 0; 存進度_(st); }
  while (st.offset < st.size) {
    if (Date.now() - started > CONFIG.BUDGET_MS) return { finished: false };
    const end = Math.min(st.offset + CONFIG.CHUNK_BYTES, st.size) - 1;
    const bytes = 讀取片段_(st.fileId, st.offset, end);
    const res = UrlFetchApp.fetch(st.sessionUri, {
      method: 'put', muteHttpExceptions: true, contentType: st.mime,
      headers: { 'Content-Range': 'bytes ' + st.offset + '-' + end + '/' + st.size },
      payload: bytes,
    });
    const code = res.getResponseCode();
    if (code === 308) { st.offset = end + 1; 存進度_(st); continue; }
    if (code === 200 || code === 201) {
      const data = JSON.parse(res.getContentText() || '{}');
      if (!data.id) throw new Error('上傳完成但沒有回傳影片 ID');
      return { finished: true, videoId: data.id };
    }
    if (code === 404 || code === 410) { st.sessionUri = ''; st.offset = 0; 存進度_(st); return { finished: false }; }
    throw new Error('上傳失敗（HTTP ' + code + '）：' + 錯誤訊息_(res));
  }
  // 段落都送完了卻沒有拿到影片 ID：從頭重傳這一支
  st.sessionUri = ''; st.offset = 0; 存進度_(st);
  return { finished: false };
}

// 建立上傳連線，回傳上傳網址（之後每段都送到這個網址）
function 建立上傳連線_(st) {
  const status = { privacyStatus: 'private', selfDeclaredMadeForKids: CONFIG.MADE_FOR_KIDS };
  if (st.ai) status.containsSyntheticMedia = true;
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: Object.assign({ 'X-Upload-Content-Type': st.mime, 'X-Upload-Content-Length': String(st.size) }, 授權標頭_()),
    payload: JSON.stringify({
      snippet: { title: st.title, description: st.desc, tags: st.tags, categoryId: CONFIG.CATEGORY_ID },
      status: status,
    }),
  });
  if (res.getResponseCode() !== 200) throw new Error('建立上傳失敗：' + 錯誤訊息_(res));
  const h = res.getHeaders();
  const loc = h['Location'] || h['location'];
  if (!loc) throw new Error('沒有拿到上傳網址');
  return loc;
}

// 從雲端硬碟讀出一段影片內容（start 到 end，含頭尾）
function 讀取片段_(fileId, start, end) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    muteHttpExceptions: true,
    headers: Object.assign({ Range: 'bytes=' + start + '-' + end }, 授權標頭_()),
  });
  const c = res.getResponseCode();
  if (c !== 200 && c !== 206) throw new Error('讀取影片失敗（HTTP ' + c + '）');
  const bytes = res.getContent();
  if (bytes.length !== end - start + 1) throw new Error('讀取的段落長度不對，已停止，避免傳錯內容');
  return bytes;
}

// 加入播放清單
function 加入播放清單_(plId, videoId) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: 授權標頭_(),
    payload: JSON.stringify({ snippet: { playlistId: plId, resourceId: { kind: 'youtube#video', videoId: videoId } } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('加入播放清單失敗：' + 錯誤訊息_(res));
}

// 播放清單：用標題找（忽略空白與「|」「｜」「・」），找到的 ID 存起來
function 取得播放清單ID_(title) {
  const cacheKey = 'PL_' + title;
  const cached = prop_(cacheKey);
  if (cached) return cached;
  const want = 正規化_(title);
  let token = '';
  for (let i = 0; i < 10; i++) {
    const url = 'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50' + (token ? '&pageToken=' + token : '');
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: 授權標頭_() });
    if (res.getResponseCode() !== 200) throw new Error('查詢播放清單失敗：' + 錯誤訊息_(res));
    const j = JSON.parse(res.getContentText() || '{}');
    const hit = (j.items || []).find(it => 正規化_(it.snippet.title) === want);
    if (hit) { setProp_(cacheKey, hit.id); return hit.id; }
    token = j.nextPageToken || '';
    if (!token) break;
  }
  return '';
}
function 正規化_(s) { return String(s).replace(/[\s|｜・･•·]/g, ''); }

// 把影片移到它所在分類資料夾裡的指定子資料夾（已上傳／失敗）
function 移檔_(st, folder, targetName) {
  const file = DriveApp.getFileById(st.fileId);
  const parent = st.parentId ? DriveApp.getFolderById(st.parentId) : folder;
  取得子資料夾_(parent, targetName).addFile(file);
  parent.removeFile(file);
}

// 出錯：影片已上傳但後面的步驟失敗，只重試後面的步驟；其他錯誤累計次數，滿了就移到「失敗」資料夾
function 出錯_(folder, st, e) {
  const why = String((e && e.message) || e).slice(0, 300);
  if (!st) return { keepGoing: false, msg: '⚠️ 出錯：' + why };
  if (st.videoId) {
    存進度_(st);
    return { keepGoing: false, msg: '⚠️ ' + st.name + ' 已上傳，但後續步驟失敗，下次會再試：' + why };
  }
  st.fails = (st.fails || 0) + 1;
  if (st.fails >= CONFIG.MAX_FAILS) {
    移檔_(st, folder, CONFIG.FAIL_FOLDER);
    清除進度_();
    記錄_(st.name, '連續失敗，已移到失敗資料夾', why);
    寄通知_('⚠️ ' + st.name + ' 連續失敗 ' + st.fails + ' 次，已移到「失敗」資料夾。\n原因：' + why);
    return { keepGoing: false, msg: '⚠️ ' + st.name + ' 已移到「失敗」資料夾：' + why };
  }
  存進度_(st);
  return { keepGoing: false, msg: '⚠️ ' + st.name + ' 這次出錯（第 ' + st.fails + ' 次），下次會接著試：' + why };
}

// ===== 每日同步：把「影片資料」的標題、說明、標記更新到已上傳的影片（只改有變動的） =====
function 每日同步() {
  const data = 讀影片資料_();
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return '沒有已上傳的影片可同步。';
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const list = rows
    .filter(r => String(r[2]).indexOf('已上傳') === 0 && String(r[3]).indexOf('youtu.be/') >= 0)
    .map(r => ({ name: String(r[1]), id: String(r[3]).split('youtu.be/')[1].trim() }));
  if (!list.length) return '沒有已上傳的影片可同步。';
  const byId = {};
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const res = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + batch.map(x => x.id).join(','), { muteHttpExceptions: true, headers: 授權標頭_() });
    if (res.getResponseCode() !== 200) throw new Error('讀取影片資訊失敗：' + 錯誤訊息_(res));
    (JSON.parse(res.getContentText() || '{}').items || []).forEach(v => { byId[v.id] = v; });
  }
  let changed = 0;
  const errors = [];
  list.forEach(x => {
    const v = byId[x.id];
    const meta = data[集數代號_(x.name).toUpperCase()];
    if (!v || !meta) return;
    const sn = v.snippet;
    const tags = 標記截斷_(meta.tags);
    const same = sn.title === meta.title && (sn.description || '') === meta.desc && JSON.stringify(sn.tags || []) === JSON.stringify(tags);
    if (same) return;
    const res = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
      method: 'put', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true, headers: 授權標頭_(),
      payload: JSON.stringify({ id: x.id, snippet: { title: meta.title, description: meta.desc, tags: tags, categoryId: sn.categoryId || CONFIG.CATEGORY_ID } }),
    });
    if (res.getResponseCode() === 200) changed++; else errors.push(x.name + '：' + 錯誤訊息_(res));
  });
  const msg = '每日同步完成：更新 ' + changed + ' 支' + (errors.length ? '；失敗 ' + errors.length + ' 支：' + errors.join('；') : '');
  記錄_('每日同步', msg, '');
  寄通知_(msg);
  return msg;
}

// ===== 共用小工具 =====
function 取得上傳資料夾_() {
  const id = prop_('UPLOAD_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { console.error('舊的資料夾 ID 讀不到，改用名稱找：' + e); } }
  const it = DriveApp.getFoldersByName(CONFIG.UPLOAD_FOLDER_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.UPLOAD_FOLDER_NAME);
  setProp_('UPLOAD_FOLDER_ID', f.getId());
  return f;
}
function 取得子資料夾_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
// 檔名的集數代號：「EP01_開場.mp4」→ EP01（開頭到第一個空白或底線）
function 集數代號_(name) {
  return String(name).replace(/\.(mp4|mov)$/i, '').split(/[\s_＿]/)[0].trim();
}
// 「影片資料」分頁：A 集數、B 標題、C 說明、D 標記；少一格就略過該集
function 讀影片資料_() {
  const map = {};
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.DATA_SHEET);
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(r => {
    const key = String(r[0]).trim().toUpperCase();
    const title = String(r[1]).trim();
    const desc = String(r[2]).trim();
    if (!key || !title || !desc) return;
    const tags = String(r[3] || '').split(/\s+/).map(t => t.replace(/^#/, '')).filter(Boolean);
    map[key] = { title: title.slice(0, 100), desc: desc.slice(0, 4800), tags: tags };
  });
  return map;
}
// 標記總長不能超過 450 字元
function 標記截斷_(tags) {
  const kept = [];
  let len = 0;
  tags.forEach(t => { if (len + t.length + 1 <= 450) { kept.push(t); len += t.length + 1; } });
  return kept;
}
function 授權標頭_() { return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }; }
function 錯誤訊息_(res) {
  try {
    const j = JSON.parse(res.getContentText() || '{}');
    return (j.error && j.error.message) || ('HTTP ' + res.getResponseCode());
  } catch (e) { return 'HTTP ' + res.getResponseCode(); }
}
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, String(v)); }
function 讀進度_() { try { const s = prop_(STATE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function 存進度_(st) { setProp_(STATE_KEY, JSON.stringify(st)); }
function 清除進度_() { PropertiesService.getScriptProperties().deleteProperty(STATE_KEY); }
function 記錄_(檔名, 結果, 連結) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.LOG_SHEET);
    if (sh) sh.appendRow([Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'), 檔名, 結果, 連結]);
  } catch (e) { console.error('寫入紀錄失敗：' + e); }
}
function 寄通知_(text) {
  if (!CONFIG.SEND_EMAIL) return;
  try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'YouTube 自動上傳通知', text); }
  catch (e) { console.error('寄信失敗：' + e); }
}
