/* ============ YouTube 自動上傳（一律私人）：雲端硬碟「YT自動上傳」資料夾裡的影片 → 上傳到頻道 ============
   未通過審核的 API 專案，上傳的影片會被強制設為「私人」，所以這裡一律用私人上傳。
   檔名要含集數：例如 EP21.mp4、EP21_神對話.mov、一念之間.mp4（一念之間是長影片）。
   標題、說明、標記沿用 titlePlans_()（Code.gs）裡現有的神對話資料。
   上傳成功後影片會移到資料夾裡的「已上傳」，並把連結傳到 LINE／Telegram 提醒你改成公開或排程發布。
   設定順序：ytUploadSetup（建立資料夾）→ ytUploadNow（授權，並手動上傳一次）→ ytUploadOn（每小時自動檢查）。 */

const YT_UP_FOLDER_NAME_ = 'YT自動上傳';
const YT_UP_DONE_NAME_ = '已上傳';

// 一次性：在編輯器選「ytUploadSetup」按「執行」一次。會找（或建立）雲端硬碟根目錄的「YT自動上傳」資料夾，並把 ID 寫進指令碼屬性 YT_UPLOAD_FOLDER_ID。
function ytUploadSetup() {
  const f = ytFolder_();
  Logger.log('已設定 YT_UPLOAD_FOLDER_ID：' + f.getId() + '（資料夾：' + f.getName() + '）');
}

// 每小時自動檢查一次資料夾（先移除舊的排程，避免重複）
function ytUploadOn() {
  ytUploadOff();
  ScriptApp.newTrigger('ytUploadNow').timeBased().everyHours(1).create();
  Logger.log('已開啟：每小時自動檢查「' + YT_UP_FOLDER_NAME_ + '」資料夾');
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
function ytDoneFolder_(folder) {
  const it = folder.getFoldersByName(YT_UP_DONE_NAME_);
  return it.hasNext() ? it.next() : folder.createFolder(YT_UP_DONE_NAME_);
}

// 從檔名找出集數：EP21 → EP21；一念之間 → LONG；找不到就回傳空字串
function ytEpKey_(name) {
  if (/一念之間|LONG/i.test(name)) return 'LONG';
  const m = String(name).match(/EP\s*(\d{1,2})/i);
  return m ? 'EP' + ('0' + m[1]).slice(-2) : '';
}

// 主要流程：每次最多上傳一支（避免超過 Apps Script 的執行時間上限），沒有新影片就什麼都不做
function ytUploadNow() {
  const folder = ytFolder_();
  const it = folder.getFiles();
  let file = null;
  while (it.hasNext()) {
    const f = it.next();
    if (/\.(mp4|mov)$/i.test(f.getName())) { file = f; break; }
  }
  if (!file) return '沒有待上傳的影片。';
  const name = file.getName();
  const key = ytEpKey_(name);
  if (!key) {
    const msg = '⚠️ 檔名看不出集數，沒有上傳：' + name + '（請改成含 EP21 或「一念之間」的檔名）';
    ytNotify_(msg);
    return msg;
  }
  const plans = titlePlans_();
  let planTitle = plans.ep && plans.ep[key];
  let planDesc = plans.desc && plans.desc[key];
  let planTags = (plans.tags && plans.tags[key]) || [];
  // 清單裡沒有的集數（例如每日迭代新產生的集），直接讀 GitHub 上的劇本檔
  if (key !== 'LONG' && (!planTitle || !planDesc)) {
    const s = ytPlanFromScript_(key);
    if (s) { planTitle = s.title; planDesc = s.desc; planTags = s.tags; }
  }
  // 沒有這一集的標題或說明資料：不上傳，免得變成沒有標題、說明的影片
  if (!planTitle || !planDesc) {
    const msg = '⚠️ ' + key + ' 還沒有標題或說明資料，所以沒有上傳（影片還留在「YT自動上傳」資料夾）。\n請先把這一集的標題與說明加進神對話劇本資料，之後會自動上傳。';
    ytNotify_(msg);
    return msg;
  }
  const title = String(planTitle).slice(0, 100);
  const desc = String(planDesc).slice(0, 4800);
  const tags = planTags;
  const kept = [];
  let len = 0;
  tags.forEach(t => { if (len + t.length + 1 <= 450) { kept.push(t); len += t.length + 1; } });
  const id = ytUploadOne_(file, { title: title, desc: desc, tags: kept });
  ytDoneFolder_(folder).addFile(file);
  folder.removeFile(file);
  const url = 'https://youtu.be/' + id;
  const studio = 'https://studio.youtube.com/video/' + id + '/edit';
  const msg = '📤 已上傳到 YouTube（目前是私人）\n' + title + '\n' + url + '\n\n' +
    '要公開：到 YouTube Studio 把可見範圍改成「公開」，或設定排程發布（建議 12:00 或 21:00）。\n' + studio;
  ytNotify_(msg);
  return msg;
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

// 上傳一支影片（可續傳的上傳流程：先取得上傳網址，再把影片內容送過去）
function ytUploadOne_(file, meta) {
  const token = ScriptApp.getOAuthToken();
  const bytes = file.getBlob().getBytes();
  const ct = /\.mov$/i.test(file.getName()) ? 'video/quicktime' : 'video/mp4';
  const body = {
    snippet: { title: meta.title, description: meta.desc, tags: meta.tags, categoryId: '22' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  };
  const init = UrlFetchApp.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, 'X-Upload-Content-Type': ct, 'X-Upload-Content-Length': String(bytes.length) },
    payload: JSON.stringify(body),
  });
  if (init.getResponseCode() !== 200) throw new Error('建立上傳失敗：' + ytUpErr_(init));
  const h = init.getHeaders();
  const loc = h['Location'] || h['location'];
  if (!loc) throw new Error('沒有拿到上傳網址');
  const put = UrlFetchApp.fetch(loc, {
    method: 'put', contentType: ct, muteHttpExceptions: true, payload: bytes,
  });
  if (put.getResponseCode() !== 200) throw new Error('影片內容上傳失敗：' + ytUpErr_(put));
  const data = JSON.parse(put.getContentText() || '{}');
  if (!data.id) throw new Error('上傳完成但沒有回傳影片 ID');
  return data.id;
}
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

// 只為了讓使用者在編輯器執行一次，跳出上傳影片的授權（新權限第一次要按一次）
function 授權YT上傳() {
  UrlFetchApp.fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  DriveApp.getRootFolder().getName();
  Logger.log('授權完成');
}
