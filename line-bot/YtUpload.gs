/* ============ YouTube 自動上傳（一律私人）：雲端硬碟「YT自動上傳」資料夾裡的影片 → 上傳到頻道 ============
   未通過審核的 API 專案，上傳的影片會被強制設為「私人」，所以這裡一律用私人上傳。
   檔名要含集數：例如 EP31.mov、EP32.mp4、一念之間.mp4。
   標題、說明、標記以劇本資料為準：先看 titlePlans_()（Code.gs），沒有的集數再讀 GitHub 上的劇本檔（shen/9x16/EpNN 劇本.md）。
   分段續傳：每次最多跑 4 分鐘，影片每段 8MB，進度存在指令碼屬性，下一次接著傳（不會因超時重複上傳）。
   成功後移到「已上傳」；同一支連續失敗 3 次移到「失敗」。
   設定順序：ytUploadSetup（建立資料夾）→ 授權YT上傳 → ytUploadOn（每 30 分鐘自動檢查）。 */

const YT_UP_FOLDER_NAME_ = 'YT自動上傳';
const YT_UP_DONE_NAME_ = '已上傳';
const YT_UP_FAIL_NAME_ = '失敗';
const YT_UP_CHUNK_ = 8 * 1024 * 1024;     // 每段 8MB（必須是 256KB 的倍數）
const YT_UP_BUDGET_MS_ = 4 * 60 * 1000;   // 每次執行最多用 4 分鐘（Apps Script 上限 6 分鐘）
const YT_UP_MAX_FAILS_ = 3;
const YT_UP_STATE_KEY_ = 'YT_UP_STATE';
const YT_UP_NOTED_KEY_ = 'YT_UP_NOTED';
// 子資料夾分類：資料夾名稱 → 要加入的播放清單、是否標註 AI 創作。沒列在這裡的子資料夾會略過並通知一次。
const YT_UP_CATS_ = {
  '神對話': { playlist: '神對話｜與佛祖的一分鐘對話 放下・覺察・因果', ai: true },
};

// 一次性：在編輯器選「ytUploadSetup」按「執行」一次。會找（或建立）雲端硬碟根目錄的「YT自動上傳」資料夾。
function ytUploadSetup() {
  const f = ytFolder_();
  Logger.log('已設定 YT_UPLOAD_FOLDER_ID：' + f.getId() + '（資料夾：' + f.getName() + '）');
}

// 每 30 分鐘自動檢查一次資料夾（先移除舊的排程，避免重複）
function ytUploadOn() {
  ytUploadOff();
  ScriptApp.newTrigger('ytUploadNow').timeBased().everyMinutes(30).create();
  Logger.log('已開啟：每 30 分鐘自動檢查「' + YT_UP_FOLDER_NAME_ + '」資料夾');
}
function ytUploadOff() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'ytUploadNow') ScriptApp.deleteTrigger(t); });
  Logger.log('已關閉自動上傳');
}

function ytFolder_() {
  const id = prop_('YT_UPLOAD_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { console.error('舊的資料夾 ID 讀不到，改用資料夾名稱找：' + e); } }
  const it = DriveApp.getFoldersByName(YT_UP_FOLDER_NAME_);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(YT_UP_FOLDER_NAME_);
  setProp_('YT_UPLOAD_FOLDER_ID', f.getId());
  return f;
}
function ytSubFolder_(folder, name) {
  const it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : folder.createFolder(name);
}

// 從檔名找出集數：EP31 → EP31；一念之間 → LONG；找不到就回傳空字串
function ytEpKey_(name) {
  if (/一念之間|LONG/i.test(name)) return 'LONG';
  const m = String(name).match(/EP\s*(\d{1,2})/i);
  return m ? 'EP' + ('0' + m[1]).slice(-2) : '';
}

// 入口：每小時的排程與手動執行都用這個。LockService 避免手動與排程同時跑。
function ytUploadNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return '上一次上傳還在進行中，這次先不跑。';
  try {
    const started = Date.now();
    const folder = ytFolder_();
    const out = [];
    for (let i = 0; i < 50; i++) {          // 50 只是保險上限，正常用不到
      const r = ytStep_(folder, started);
      if (r.msg) out.push(r.msg);
      if (!r.keepGoing) break;
    }
    return out.join('\n\n') || '沒有待上傳的影片。';
  } finally { lock.releaseLock(); }
}

// 處理一步：有進行中的影片就接著傳；沒有就挑下一支開始
function ytStep_(folder, started) {
  let st = ytLoadState_();
  try {
    if (!st) {
      st = ytStart_(folder);
      if (!st) return { keepGoing: false, msg: '' };
    }
    const r = ytTransfer_(st, started);
    if (!r.finished) {
      ytSaveState_(st);
      return { keepGoing: false, msg: '⏳ ' + st.name + ' 上傳中，' + Math.floor(100 * st.offset / st.size) + '%，下次自動接著傳。' };
    }
    st.videoId = r.videoId;
    ytSaveState_(st);
    if (!st.plDone) { ytAddToPlaylist_(st.plId, st.videoId); st.plDone = true; ytSaveState_(st); }
    ytFinish_(folder, st);
    return { keepGoing: Date.now() - started < YT_UP_BUDGET_MS_, msg: '📤 ' + st.name + ' 已上傳（私人）：https://youtu.be/' + st.videoId };
  } catch (e) {
    return ytOnError_(folder, st, e);
  }
}

// 挑下一支要上傳的影片：只看分類子資料夾（依名稱排序）；根目錄的影片與不認識的子資料夾會略過並通知一次
function ytCandidates_(folder) {
  const cands = [];
  const noted = ytNotedLoad_();
  const rootIt = folder.getFiles();
  while (rootIt.hasNext()) {
    const f = rootIt.next();
    if (!/\.(mp4|mov)$/i.test(f.getName())) continue;
    const k = 'root:' + f.getName();
    if (noted.indexOf(k) < 0) {
      ytNotify_('⚠️ ' + f.getName() + ' 放在根目錄，沒有上傳。請把它移到「YT自動上傳」裡的分類子資料夾（例如「神對話」）。');
      noted.push(k); ytNotedSave_(noted);
    }
  }
  const subs = [];
  const sit = folder.getFolders();
  while (sit.hasNext()) subs.push(sit.next());
  subs.sort((a, b) => (a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0));
  subs.forEach(sub => {
    const sname = sub.getName();
    if (sname === YT_UP_DONE_NAME_ || sname === YT_UP_FAIL_NAME_) return;
    const cat = YT_UP_CATS_[sname];
    if (!cat) {
      const k = 'folder:' + sname;
      if (noted.indexOf(k) < 0) {
        ytNotify_('⚠️ 子資料夾「' + sname + '」沒有分類設定，裡面的影片沒有上傳。');
        noted.push(k); ytNotedSave_(noted);
      }
      return;
    }
    const list = [];
    const fit = sub.getFiles();
    while (fit.hasNext()) {
      const f = fit.next();
      if (/\.(mp4|mov)$/i.test(f.getName())) list.push(f);
    }
    list.sort((a, b) => (a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0));
    list.forEach(f => cands.push({ file: f, parentId: sub.getId(), catName: sname, cat: cat }));
  });
  return cands;
}

function ytPickNext_(folder) {
  const noted = ytNotedLoad_();
  for (const c of ytCandidates_(folder)) {
    const name = c.file.getName();
    const key = ytEpKey_(name);
    const meta = key ? ytMetaFor_(key) : null;
    if (!meta) {
      if (noted.indexOf(name) < 0) {
        ytNotify_('⚠️ ' + name + '：' + (key ? key + ' 還沒有標題或說明資料' : '檔名看不出集數') + '，所以沒有上傳（資料補上後會自動上傳）。');
        noted.push(name); ytNotedSave_(noted);
      }
      continue;
    }
    let plId = '';
    if (c.cat.playlist) {
      plId = ytPlaylistId_(c.catName, c.cat.playlist);
      if (!plId) {
        const k = 'pl:' + c.catName;
        if (noted.indexOf(k) < 0) {
          ytNotify_('⚠️ 找不到播放清單「' + c.cat.playlist + '」，「' + c.catName + '」的影片暫時不上傳。請先在 YouTube 建立這個播放清單。');
          noted.push(k); ytNotedSave_(noted);
        }
        continue;
      }
    }
    return { file: c.file, parentId: c.parentId, meta: meta, cat: c.cat, catName: c.catName, plId: plId };
  }
  return null;
}

// 播放清單：用標題找（忽略空白與「|」「｜」「・」），找到的 ID 存起來
function ytNorm_(s) { return String(s).replace(/[\s|｜・･•·]/g, ''); }
function ytPlaylistId_(catName, title) {
  const cacheKey = 'YT_PL_' + catName;
  const cached = prop_(cacheKey);
  if (cached) return cached;
  const want = ytNorm_(title);
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const url = 'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50' + (pageToken ? '&pageToken=' + pageToken : '');
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    if (res.getResponseCode() !== 200) throw new Error('查詢播放清單失敗：' + ytUpErr_(res));
    const j = JSON.parse(res.getContentText() || '{}');
    const hit = (j.items || []).find(it => ytNorm_(it.snippet.title).indexOf(want) >= 0);
    if (hit) { setProp_(cacheKey, hit.id); return hit.id; }
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return '';
}
function ytAddToPlaylist_(plId, videoId) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ snippet: { playlistId: plId, resourceId: { kind: 'youtube#video', videoId: videoId } } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('加入播放清單失敗：' + ytUpErr_(res));
}

// 開始一支新影片：只記下進度，還沒有建立上傳連線
function ytStart_(folder) {
  const pick = ytPickNext_(folder);
  if (!pick) return null;
  const f = pick.file, m = pick.meta;
  const st = {
    fileId: f.getId(), name: f.getName(), parentId: pick.parentId, catName: pick.catName,
    title: m.title, desc: m.desc, tags: m.tags,
    mime: /\.mov$/i.test(f.getName()) ? 'video/quicktime' : 'video/mp4',
    size: f.getSize(), offset: 0, sessionUri: '', fails: 0, videoId: '',
    plId: pick.plId, plDone: !pick.plId, ai: !!pick.cat.ai,
  };
  ytSaveState_(st);
  return st;
}

// 分段傳送：超過時間預算就先停下，進度已存好，下次接著傳
function ytTransfer_(st, started) {
  if (st.videoId) return { finished: true, videoId: st.videoId };
  if (!st.sessionUri) { st.sessionUri = ytInit_(st); st.offset = 0; ytSaveState_(st); }
  while (st.offset < st.size) {
    if (Date.now() - started > YT_UP_BUDGET_MS_) return { finished: false };
    const end = Math.min(st.offset + YT_UP_CHUNK_, st.size) - 1;
    const bytes = ytDownloadRange_(st.fileId, st.offset, end);
    const res = UrlFetchApp.fetch(st.sessionUri, {
      method: 'put', muteHttpExceptions: true, contentType: st.mime,
      headers: { 'Content-Range': 'bytes ' + st.offset + '-' + end + '/' + st.size },
      payload: bytes,
    });
    const code = res.getResponseCode();
    if (code === 308) { st.offset = end + 1; ytSaveState_(st); continue; }
    if (code === 200 || code === 201) {
      const data = JSON.parse(res.getContentText() || '{}');
      if (!data.id) throw new Error('上傳完成但沒有回傳影片 ID');
      return { finished: true, videoId: data.id };
    }
    if (code === 404 || code === 410) { st.sessionUri = ''; st.offset = 0; ytSaveState_(st); return { finished: false }; }
    throw new Error('第 ' + (Math.floor(st.offset / YT_UP_CHUNK_) + 1) + ' 段上傳失敗（HTTP ' + code + '）：' + ytUpErr_(res));
  }
  // 段落都送完了卻沒有拿到影片 ID：從頭重傳這一支
  st.sessionUri = ''; st.offset = 0; ytSaveState_(st);
  return { finished: false };
}

// 建立上傳連線，回傳上傳網址（之後每段都送到這個網址）
function ytInit_(st) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': st.mime, 'X-Upload-Content-Length': String(st.size) },
    payload: JSON.stringify({
      snippet: { title: st.title, description: st.desc, tags: st.tags, categoryId: '22' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: !!st.ai },
    }),
  });
  if (res.getResponseCode() !== 200) throw new Error('建立上傳失敗：' + ytUpErr_(res));
  const h = res.getHeaders();
  const loc = h['Location'] || h['location'];
  if (!loc) throw new Error('沒有拿到上傳網址');
  return loc;
}

// 從雲端硬碟讀出一段影片內容（start 到 end，含頭尾）
function ytDownloadRange_(fileId, start, end) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + end },
  });
  const c = res.getResponseCode();
  if (c !== 200 && c !== 206) throw new Error('讀取影片失敗（HTTP ' + c + '）');
  const bytes = res.getContent();
  // 段落長度對不上就停下來，避免把整支檔案或錯的一段送上 YouTube
  if (bytes.length !== end - start + 1) throw new Error('讀取的段落長度不對（要 ' + (end - start + 1) + '，拿到 ' + bytes.length + '）');
  return bytes;
}

// 把影片移到它所在分類資料夾裡的指定子資料夾（已上傳／失敗）
function ytMoveTo_(st, folder, targetName) {
  const file = DriveApp.getFileById(st.fileId);
  const parent = st.parentId ? DriveApp.getFolderById(st.parentId) : folder;
  ytSubFolder_(parent, targetName).addFile(file);
  parent.removeFile(file);
}

// 上傳成功：先移到「已上傳」，再清掉進度，最後通知
function ytFinish_(folder, st) {
  ytMoveTo_(st, folder, YT_UP_DONE_NAME_);
  ytStateClear_();
  ytNotify_('📤 已上傳到 YouTube（目前是私人）\n' + st.title + '\nhttps://youtu.be/' + st.videoId +
    (st.plId ? '\n已加入播放清單：' + st.catName : '') +
    (st.ai ? '\n已標註為 AI 創作（變造或合成內容）' : '') +
    '\n\n要公開：到 YouTube Studio 把可見範圍改成「公開」，或設定排程發布（建議 12:00 或 21:00）。\nhttps://studio.youtube.com/video/' + st.videoId + '/edit');
}

// 出錯：影片已上傳但移檔失敗，只重試移檔；其他錯誤累計次數，滿 3 次移到「失敗」資料夾
function ytOnError_(folder, st, e) {
  const why = String((e && e.message) || e).slice(0, 300);
  if (!st) return { keepGoing: false, msg: '⚠️ 上傳出錯：' + why };
  if (st.videoId) {
    ytSaveState_(st);
    return { keepGoing: false, msg: '⚠️ ' + st.name + ' 已上傳，但移檔失敗，下次會再試移檔：' + why };
  }
  st.fails = (st.fails || 0) + 1;
  if (st.fails >= YT_UP_MAX_FAILS_) {
    ytMoveTo_(st, folder, YT_UP_FAIL_NAME_);
    ytStateClear_();
    ytNotify_('⚠️ ' + st.name + ' 連續失敗 ' + st.fails + ' 次，已移到「失敗」資料夾。\n原因：' + why);
    return { keepGoing: false, msg: '⚠️ ' + st.name + ' 已移到「失敗」資料夾：' + why };
  }
  ytSaveState_(st);
  return { keepGoing: false, msg: '⚠️ ' + st.name + ' 這次出錯（第 ' + st.fails + ' 次），下次會接著試：' + why };
}

// 這一集的標題、說明、標記：先看清單，沒有再讀劇本檔；都沒有回傳 null（不上傳）
function ytMetaFor_(key) {
  const plans = titlePlans_();
  let title = plans.ep && plans.ep[key];
  let desc = plans.desc && plans.desc[key];
  let tags = (plans.tags && plans.tags[key]) || [];
  if (key !== 'LONG' && (!title || !desc)) {
    const s = ytPlanFromScript_(key);
    if (s) { title = s.title; desc = s.desc; tags = s.tags; }
  }
  if (!title || !desc) return null;
  const kept = [];
  let len = 0;
  tags.forEach(t => { if (len + t.length + 1 <= 450) { kept.push(t); len += t.length + 1; } });
  return { title: String(title).slice(0, 100), desc: String(desc).slice(0, 4800), tags: kept };
}

// 從 GitHub 上的劇本檔（shen/9x16/EpNN 劇本.md）讀出標題、影片說明與標記；讀不到回傳 null
function ytPlanFromScript_(key) {
  try {
    const sha = gitMainSha_();
    const path = encodeURI('shen/9x16/' + key.replace('EP', 'Ep') + ' 劇本.md');
    const res = UrlFetchApp.fetch('https://raw.githubusercontent.com/yb131419/Tezhu/' + sha + '/' + path, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const md = res.getContentText('UTF-8').replace(/\r/g, '');
    const t = md.match(/\*\*影片標題\*\*[^\n]*\n```\n([^\n]+)\n```/);
    const d = md.match(/\*\*影片說明\*\*[^\n]*\n```\n([\s\S]*?)\n```/);
    if (!t || !d) return null;
    const desc = d[1].trim();
    const last = desc.split('\n').pop() || '';
    const tags = last.split(/\s+/).filter(x => /^#/.test(x)).map(x => x.slice(1));
    return { title: t[1].trim(), desc: desc, tags: tags };
  } catch (e) { console.error('讀取劇本檔失敗：' + e); return null; }
}

function ytLoadState_() {
  try { const s = prop_(YT_UP_STATE_KEY_); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function ytSaveState_(st) { setProp_(YT_UP_STATE_KEY_, JSON.stringify(st)); }
function ytStateClear_() { PropertiesService.getScriptProperties().deleteProperty(YT_UP_STATE_KEY_); }
function ytNotedLoad_() {
  try { return JSON.parse(prop_(YT_UP_NOTED_KEY_) || '[]'); } catch (e) { return []; }
}
function ytNotedSave_(arr) { setProp_(YT_UP_NOTED_KEY_, JSON.stringify(arr.slice(-50))); }

function ytUpErr_(res) {
  try {
    const j = JSON.parse(res.getContentText() || '{}');
    return (j.error && j.error.message) || ('HTTP ' + res.getResponseCode());
  } catch (e) { return 'HTTP ' + res.getResponseCode(); }
}

// 傳到使用者的 LINE 與 Telegram（沒設定的就略過）
function ytNotify_(text) {
  try { const uid = prop_('OWNER_USER_ID'); if (uid) push_(uid, text); } catch (e) { console.error('LINE 通知失敗：' + e); }
  try { const tg = prop_('TG_OWNER_CHAT_ID'); if (tg) tgSend_(tg, text); } catch (e) { console.error('Telegram 通知失敗：' + e); }
}

// 檢查用：列出排程數量、進行中的進度、資料夾內容，以及頻道最近 20 支影片的處理狀態；結果傳到 LINE／Telegram
function ytUploadCheck() {
  const lines = [];
  const trig = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'ytUploadNow');
  lines.push('排程數量：' + trig.length + '（應該是 1，多於 1 就執行「ytUploadOn」重設）');
  const st = ytLoadState_();
  lines.push('進行中：' + (st ? st.name + '，' + Math.floor(100 * st.offset / st.size) + '%，失敗 ' + (st.fails || 0) + ' 次' : '無'));
  const folder = ytFolder_();
  const names = [];
  const it = folder.getFiles();
  while (it.hasNext()) names.push(it.next().getName());
  lines.push('待上傳資料夾：' + (names.join('、') || '無'));
  const auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  const sr = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&order=date&maxResults=20', { muteHttpExceptions: true, headers: auth });
  if (sr.getResponseCode() !== 200) {
    lines.push('查詢頻道影片失敗：' + ytUpErr_(sr));
  } else {
    const ids = (JSON.parse(sr.getContentText() || '{}').items || []).map(i => i.id.videoId).filter(Boolean);
    if (ids.length) {
      const vr = UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=' + ids.join(','), { muteHttpExceptions: true, headers: auth });
      if (vr.getResponseCode() !== 200) {
        lines.push('查詢影片狀態失敗：' + ytUpErr_(vr));
      } else {
        (JSON.parse(vr.getContentText() || '{}').items || []).forEach(v => {
          const stt = v.status || {}, pd = v.processingDetails || {};
          let s = (v.snippet.title || '').slice(0, 12) + ' ｜ 上傳:' + (stt.uploadStatus || '-') + ' ｜ 處理:' + (pd.processingStatus || '-');
          if (pd.processingFailureReason) s += ' ｜ 處理失敗:' + pd.processingFailureReason;
          if (stt.failureReason) s += ' ｜ 上傳失敗:' + stt.failureReason;
          if (stt.rejectionReason) s += ' ｜ 拒絕:' + stt.rejectionReason;
          lines.push(s);
        });
      }
    } else {
      lines.push('頻道沒有查到影片');
    }
  }
  const text = '🔎 YouTube 上傳檢查\n' + lines.join('\n');
  ytNotify_(text);
  return text;
}

// 只為了讓使用者在編輯器執行一次，跳出上傳影片的授權（新權限第一次要按一次）
function 授權YT上傳() {
  UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  DriveApp.getRootFolder().getName();
  Logger.log('授權完成');
}
