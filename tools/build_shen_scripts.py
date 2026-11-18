# 用法：python3 tools/build_shen_scripts.py <Artifact 讀出的 HTML 檔> [輸出檔，預設 ShenScripts.html]
# 每日排程會把神對話劇本 Claude 網址讀出的內容餵進來，重新產生劇本頁。
import re
import sys
src = open(sys.argv[1], encoding='utf-8').read()
body = src[src.index('<h2>'):]
tokens = re.finditer(r'<h2>(.*?)</h2>|<details><summary>(.*?)</summary>.*?<pre>(.*?)</pre></details>', body, re.S)
out = []
count = 0
for m in tokens:
    if m.group(1) is not None:
        out.append(f'<h2 class="sec">{m.group(1)}</h2>')
    else:
        count += 1
        out.append(f'<details class="item"><summary>{m.group(2)}</summary><div class="bar"><button type="button" class="cp">複製全文</button></div><pre>{m.group(3)}</pre></details>')
html = f'''<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>神對話劇本全集</title>
<style>
  :root{{--paper:#F5F0E3;--paper-2:#FFFCF6;--ink:#1E1A14;--ink-soft:#5C5343;--ink-faint:#A0937A;--line:rgba(30,25,18,.11);--gold:#A8782E;--gold-deep:#7E5A22;--gold-soft:#D9B873;--gold-wash:rgba(168,120,46,.12);--shadow:0 1px 2px rgba(30,25,18,.04),0 16px 36px rgba(30,25,18,.08);--serif:"Noto Serif TC","Songti TC","PMingLiU",serif;--sans:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;}}
  @media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--paper:#17140F;--paper-2:#1F1B15;--ink:#F1EADB;--ink-soft:#BDB39C;--ink-faint:#867D68;--line:rgba(255,245,225,.10);--gold:#D9B873;--gold-deep:#E8CB92;--gold-wash:rgba(217,184,115,.12);--shadow:0 16px 36px rgba(0,0,0,.35);}}}}
  *{{box-sizing:border-box;}}
  html,body{{margin:0;padding:0;background:var(--paper);color:var(--ink);}}
  body{{font-family:var(--sans);font-size:15px;line-height:1.7;-webkit-text-size-adjust:100%;padding:env(safe-area-inset-top,0) max(16px,env(safe-area-inset-right,0px)) 56px max(16px,env(safe-area-inset-left,0px));}}
  .wrap{{max-width:760px;margin:0 auto;}}
  .top{{display:flex;align-items:center;gap:12px;padding:18px 0 6px;}}
  .back{{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--gold-deep);font-size:14px;border:1px solid var(--line);background:var(--paper-2);border-radius:999px;padding:6px 14px;}}
  header{{padding:14px 0 18px;border-bottom:1px solid var(--line);margin-bottom:8px;}}
  .kicker{{font-family:var(--serif);font-size:12px;letter-spacing:5px;color:var(--gold);font-weight:600;margin:0 0 6px;}}
  h1{{font-family:var(--serif);font-size:26px;letter-spacing:3px;margin:0 0 8px;font-weight:700;}}
  .note{{color:var(--ink-soft);font-size:13px;margin:0;}}
  .sec{{font-family:var(--serif);font-size:15px;letter-spacing:4px;color:var(--gold-deep);font-weight:600;margin:30px 2px 12px;}}
  details.item{{background:var(--paper-2);border:1px solid var(--line);border-radius:18px;margin:0 0 10px;overflow:hidden;box-shadow:var(--shadow);}}
  details.item[open]{{border-color:var(--gold-soft);}}
  summary{{cursor:pointer;padding:15px 18px;font-family:var(--serif);font-weight:700;letter-spacing:1px;word-break:break-all;list-style:none;}}
  summary::-webkit-details-marker{{display:none;}}
  summary::after{{content:"›";float:right;color:var(--gold);font-size:22px;line-height:1;transition:transform .2s;}}
  details[open] summary::after{{transform:rotate(90deg);}}
  .bar{{padding:0 18px 12px;}}
  .cp{{font:inherit;font-size:13px;color:var(--gold-deep);background:var(--gold-wash);border:1px solid rgba(168,120,46,.3);border-radius:999px;padding:6px 16px;cursor:pointer;}}
  .cp.done{{color:#1F8A72;}}
  pre{{white-space:pre-wrap;word-break:break-word;font-family:var(--sans);font-size:14px;line-height:1.75;margin:0;padding:14px 18px 20px;border-top:1px solid var(--line);}}
  .cp:focus-visible,summary:focus-visible,.back:focus-visible{{outline:2px solid var(--gold);outline-offset:2px;}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a class="back" href="Assistant.html">‹ 回小乖主頁</a></div>
  <header>
    <p class="kicker">神對話</p>
    <h1>神對話劇本全集</h1>
    <p class="note">點檔名展開，按「複製全文」即可複製。最新版排在最上面，共 {count} 個檔案。</p>
  </header>
  {chr(10).join(out)}
</div>
<script>
document.addEventListener('click', function(e){{
  var b = e.target.closest('.cp'); if(!b) return;
  e.preventDefault();
  var pre = b.closest('details').querySelector('pre');
  var txt = pre.textContent;
  var done = function(){{ b.textContent='已複製 ✓'; b.classList.add('done'); setTimeout(function(){{ b.textContent='複製全文'; b.classList.remove('done'); }}, 1600); }};
  if (navigator.clipboard && navigator.clipboard.writeText) {{
    navigator.clipboard.writeText(txt).then(done, function(){{ fallback(); }});
  }} else {{ fallback(); }}
  function fallback(){{
    var r = document.createRange(); r.selectNodeContents(pre);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    try {{ document.execCommand('copy'); done(); }} catch(err) {{ b.textContent='請手動長按複製'; }}
  }}
}});
</script>
</body>
</html>
'''
out_path = sys.argv[2] if len(sys.argv)>2 else 'ShenScripts.html'
open(out_path, 'w', encoding='utf-8').write(html)
print('sections items:', count, 'bytes:', len(html.encode()))

# 同一次執行同時產生 shen-latest.json，給小乖對話頁（Talk.html）顯示最新集數與更新日期
import json, datetime, os
vert = out[[i for i, s in enumerate(out) if s.startswith('<h2 class="sec">直式')][0]:]
latest = next((re.search(r'<summary>(.*?)</summary>', s).group(1).replace('.md', '') for s in vert if s.startswith('<details')), '')
updated = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y/%m/%d')
json_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), 'shen-latest.json')
open(json_path, 'w', encoding='utf-8').write(json.dumps({'latest': latest, 'updated': updated, 'count': count}, ensure_ascii=False) + '\n')
print('latest:', latest, 'updated:', updated)
