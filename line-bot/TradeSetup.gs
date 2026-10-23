// 一次性設定：把 IG 登入資料寫進指令碼屬性 TRADE_CFG。跑完一次就可以刪掉這個檔案。
// 把 apiKey、identifier、password 改成你自己的值，在編輯器選 tradeSetCfgOnce 按「執行」，跑完立刻改回 YOUR_ 預留字。
// notify：成交通知。telegram 預設開；line 是 LINE 推播，會計入每月 200 則額度，預設關。
function tradeSetCfgOnce() {
  try {
    console.log('步驟 1：準備設定內容');
    const cfg = { apiKey: 'YOUR_IG_API_KEY', identifier: 'YOUR_IG_USERNAME', password: 'YOUR_IG_PASSWORD', mode: 'paper', env: 'demo', notify: { telegram: true, line: false } };
    if (cfg.apiKey.indexOf('YOUR_') === 0) {
      console.log('停止：apiKey 還是 YOUR_ 預留字，請先改成你自己的值');
      return;
    }
    console.log('步驟 2：寫入指令碼屬性');
    const store = PropertiesService.getScriptProperties();
    store.setProperty('TRADE_CFG', JSON.stringify(cfg));
    console.log('步驟 3：完成，TRADE_CFG 已寫入（登入資料不顯示）');
  } catch (e) {
    console.log('錯誤內容：' + (e && e.message ? e.message : String(e)));
  }
}
