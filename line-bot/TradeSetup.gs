// 一次性設定：把 IG 登入資料寫進指令碼屬性 TRADE_CFG。跑完一次就可以刪掉這個檔案。
// 把 apiKey、identifier、password 改成你自己的值，在編輯器選 tradeSetCfgOnce 按「執行」，跑完立刻改回 YOUR_ 預留字。
function tradeSetCfgOnce() {
  const cfg = { apiKey: 'YOUR_IG_API_KEY', identifier: 'YOUR_IG_USERNAME', password: 'YOUR_IG_PASSWORD', mode: 'paper', env: 'demo' };
  if (cfg.apiKey.indexOf('YOUR_') === 0) throw new Error('請先把 apiKey、identifier、password 改成你自己的值');
  PropertiesService.getScriptProperties().setProperty('TRADE_CFG', JSON.stringify(cfg));
  console.log('TRADE_CFG 已寫入（登入資料不顯示）');
}
