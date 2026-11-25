# 用法：python3 tools/build_shen_scripts.py <來源 HTML 檔> [輸出檔，預設 ShenScripts.html]
# 來源需含 <h2> 分段，以及 <details><summary>檔名</summary><pre>內文</pre></details> 的劇本區塊。
# 產出的頁面有快速導覽：上方是集數按鈕（點了展開該集並跳過去）、搜尋（檔名與劇本內文）、全部收合。
# 各集預設收合，只顯示標題；每次產生都會同時更新 shen-latest.json。
import datetime
import json
import os
import re
import sys

src = open(sys.argv[1], encoding='utf-8').read()
body = src[src.index('<h2>'):]
tokens = re.finditer(r'<h2>(.*?)</h2>|<details><summary>(.*?)</summary>.*?<pre>(.*?)</pre></details>', body, re.S)

sections = []  # 每段：{'title': 段名, 'items': [{'id', 'label', 'summary', 'pre'}]}
ids_seen = set()
for m in tokens:
    if m.group(1) is not None:
        sections.append({'title': m.group(1), 'items': []})
        continue
    if not sections:
        sections.append({'title': '', 'items': []})
    summary, pre = m.group(2), m.group(3)
    ep = re.match(r'Ep(\d+)', summary)
    if ep:
        label = 'EP' + ep.group(1)
        base = 'ep' + ep.group(1) + ('-169' if '16x9' in summary else '-916')
    else:
        label = '一念之間' if '一念之間' in summary else summary.replace('.md', '')
        base = 'long'
    item_id = base
    if item_id in ids_seen:
        item_id = base + '-' + str(len(ids_seen))
    ids_seen.add(item_id)
    sections[-1]['items'].append({'id': item_id, 'label': label, 'summary': summary, 'pre': pre})

count = sum(len(s['items']) for s in sections)


def row_label(title):
    if '直式' in title:
        return '9:16'
    if '橫式' in title:
        return '16:9'
    if '一念之間' in title:
        return '一念之間'
    return title


def nav_row(sec):
    chips = ''.join('<a class="chip" href="#%s" data-target="%s">%s</a>' % (it['id'], it['id'], it['label'])
                    for it in sec['items'])
    return '<div class="jrow"><span class="jlab">%s</span>%s</div>' % (row_label(sec['title']), chips)


def group_html(sec):
    parts = ['<section class="grp">']
    if sec['title']:
        parts.append('<h2 class="sec">%s</h2>' % sec['title'])
    for it in sec['items']:
        # 顯示名稱不帶 .md（只改顯示，檔名與來源不變）
        parts.append('<details class="item" id="%s"><summary>%s</summary>'
                     '<div class="bar"><button type="button" class="cp">複製全文</button></div>'
                     '<pre>%s</pre></details>' % (it['id'], it['summary'].replace('.md', ''), it['pre']))
    parts.append('</section>')
    return ''.join(parts)


nav = ('<nav class="jump" aria-label="快速導覽">'
       '<div class="jtools"><input id="q" type="search" placeholder="搜尋集數或內文，例如 EP10" autocomplete="off">'
       '<button type="button" id="collapse">全部收合</button></div>'
       '<p class="jstat" id="jstat"></p>'
       + ''.join(nav_row(s) for s in sections if s['items']) +
       '</nav>')

TEMPLATE = r'''<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>神對話劇本全集</title>
<style>
  :root{--paper:#F5F0E3;--paper-2:#FFFCF6;--ink:#1E1A14;--ink-soft:#5C5343;--ink-faint:#A0937A;--line:rgba(30,25,18,.11);--gold:#A8782E;--gold-deep:#7E5A22;--gold-soft:#D9B873;--gold-wash:rgba(168,120,46,.12);--shadow:0 1px 2px rgba(30,25,18,.04),0 16px 36px rgba(30,25,18,.08);--serif:"Noto Serif TC","Songti TC","PMingLiU",serif;--sans:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#17140F;--paper-2:#1F1B15;--ink:#F1EADB;--ink-soft:#BDB39C;--ink-faint:#867D68;--line:rgba(255,245,225,.10);--gold:#D9B873;--gold-deep:#E8CB92;--gold-wash:rgba(217,184,115,.12);--shadow:0 16px 36px rgba(0,0,0,.35);}}
  *{box-sizing:border-box;}
  [hidden]{display:none!important;}
  html,body{margin:0;padding:0;background:var(--paper);color:var(--ink);}
  body{font-family:var(--sans);font-size:15px;line-height:1.7;-webkit-text-size-adjust:100%;padding:env(safe-area-inset-top,0) max(16px,env(safe-area-inset-right,0px)) 56px max(16px,env(safe-area-inset-left,0px));}
  .wrap{max-width:760px;margin:0 auto;}
  .top{display:flex;align-items:center;gap:12px;padding:18px 0 6px;}
  .back{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--gold-deep);font-size:14px;border:1px solid var(--line);background:var(--paper-2);border-radius:999px;padding:6px 14px;}
  header{padding:14px 0 14px;}
  .kicker{font-family:var(--serif);font-size:12px;letter-spacing:5px;color:var(--gold);font-weight:600;margin:0 0 6px;}
  h1{font-family:var(--serif);font-size:26px;letter-spacing:3px;margin:0 0 8px;font-weight:700;}
  .note{color:var(--ink-soft);font-size:13px;margin:0;}
  .ver{margin-left:auto;color:var(--ink-faint);font-size:12px;letter-spacing:.5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
  /* 快速導覽：固定在上方，集數按鈕橫向捲動，省空間 */
  .jump{position:sticky;top:0;z-index:5;background:var(--paper);padding:8px 0 8px;border-bottom:1px solid var(--line);margin-bottom:6px;}
  .jtools{display:flex;gap:8px;align-items:center;}
  #q{flex:1;min-width:0;font:inherit;font-size:15px;padding:9px 14px;border-radius:999px;border:1px solid var(--line);background:var(--paper-2);color:var(--ink);outline:none;}
  #q:focus{border-color:var(--gold);}
  #collapse{font:inherit;font-size:13px;color:var(--gold-deep);background:var(--gold-wash);border:1px solid rgba(168,120,46,.3);border-radius:999px;padding:8px 14px;white-space:nowrap;cursor:pointer;}
  .jstat{font-size:12px;color:var(--ink-faint);margin:6px 2px 2px;min-height:18px;}
  .jrow{display:flex;align-items:center;gap:6px;overflow-x:auto;white-space:nowrap;padding:4px 0;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
  .jrow::-webkit-scrollbar{display:none;}
  .jlab{flex:0 0 auto;font-size:12px;color:var(--ink-faint);letter-spacing:1px;margin-right:4px;}
  .chip{flex:0 0 auto;font-size:13px;color:var(--gold-deep);text-decoration:none;border:1px solid var(--line);background:var(--paper-2);border-radius:999px;padding:4px 11px;}
  .chip:active{background:var(--gold-wash);}
  .sec{font-family:var(--serif);font-size:15px;letter-spacing:4px;color:var(--gold-deep);font-weight:600;margin:26px 2px 12px;}
  details.item{scroll-margin-top:200px;background:var(--paper-2);border:1px solid var(--line);border-radius:18px;margin:0 0 10px;overflow:hidden;box-shadow:var(--shadow);}
  details.item[open]{border-color:var(--gold-soft);}
  summary{cursor:pointer;padding:15px 18px;font-family:var(--serif);font-weight:700;letter-spacing:1px;word-break:break-all;list-style:none;}
  summary::-webkit-details-marker{display:none;}
  summary::after{content:"›";float:right;color:var(--gold);font-size:22px;line-height:1;transition:transform .2s;}
  details[open] summary::after{transform:rotate(90deg);}
  .bar{padding:0 18px 12px;}
  .cp{font:inherit;font-size:13px;color:var(--gold-deep);background:var(--gold-wash);border:1px solid rgba(168,120,46,.3);border-radius:999px;padding:6px 16px;cursor:pointer;}
  .cp.done{color:#1F8A72;}
  pre{white-space:pre-wrap;word-break:break-word;font-family:var(--sans);font-size:14px;line-height:1.75;margin:0;padding:14px 18px 20px;border-top:1px solid var(--line);}
  .cp:focus-visible,summary:focus-visible,.back:focus-visible,.chip:focus-visible,#collapse:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a class="back" href="Assistant.html">‹ 回小乖主頁</a><span class="ver">__STAMP__</span></div>
  <header>
    <p class="kicker">神對話</p>
    <h1>神對話劇本全集</h1>
    <p class="note">點上方的集數可直接跳到該集，也可以搜尋；點標題展開，按「複製全文」即可複製。最新版排在最上面。</p>
  </header>
  __NAV__
  __GROUPS__
</div>
<script>
(function(){
  var q = document.getElementById('q');
  var stat = document.getElementById('jstat');
  var items = [].slice.call(document.querySelectorAll('details.item'));
  var chips = [].slice.call(document.querySelectorAll('.chip'));
  var groups = [].slice.call(document.querySelectorAll('.grp'));
  var total = items.length;
  var texts = items.map(function(d){ return (d.querySelector('summary').textContent + ' ' + d.querySelector('pre').textContent).toLowerCase(); });

  function apply(){
    var k = q.value.trim().toLowerCase();
    var shown = 0, vis = {};
    items.forEach(function(d, i){
      var on = !k || texts[i].indexOf(k) >= 0;
      d.hidden = !on; vis[d.id] = on; if (on) shown++;
    });
    groups.forEach(function(g){ g.hidden = !g.querySelector('details.item:not([hidden])'); });
    chips.forEach(function(c){ c.hidden = !vis[c.getAttribute('data-target')]; });
    stat.textContent = k ? ('找到 ' + shown + ' 集（共 ' + total + ' 集）') : ('共 ' + total + ' 集');
  }
  q.addEventListener('input', apply);

  // 點集數：展開該集並捲到標題
  document.addEventListener('click', function(e){
    var c = e.target.closest('a.chip');
    if (!c) return;
    e.preventDefault();
    var d = document.getElementById(c.getAttribute('data-target'));
    if (!d) return;
    d.open = true;
    history.replaceState(null, '', '#' + d.id);
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.getElementById('collapse').addEventListener('click', function(){
    items.forEach(function(d){ d.open = false; });
  });

  // 複製全文
  document.addEventListener('click', function(e){
    var b = e.target.closest('.cp'); if (!b) return;
    e.preventDefault();
    var pre = b.closest('details').querySelector('pre');
    var txt = pre.textContent;
    var done = function(){ b.textContent = '已複製 ✓'; b.classList.add('done'); setTimeout(function(){ b.textContent = '複製全文'; b.classList.remove('done'); }, 1600); };
    var fallback = function(){
      var r = document.createRange(); r.selectNodeContents(pre);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      try { document.execCommand('copy'); done(); } catch (err) { b.textContent = '請手動長按複製'; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else { fallback(); }
  });

  // 網址帶 #EP10 之類的錨點時，直接展開那一集
  var h = decodeURIComponent(location.hash.slice(1));
  var t = h && document.getElementById(h);
  if (t && t.tagName === 'DETAILS') {
    t.open = true;
    setTimeout(function(){ t.scrollIntoView({ block: 'start' }); }, 60);
  }
  apply();
})();
</script>
</body>
</html>
'''

import hashlib
_content_hash = hashlib.sha1((nav + ''.join(group_html(s) for s in sections if s['items'])).encode('utf-8')).hexdigest()[:7]
STAMP = 'v ' + _content_hash + ' · ' + datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y/%m/%d %H:%M')
html = TEMPLATE.replace('__STAMP__', STAMP).replace('__NAV__', nav).replace('__GROUPS__', '\n'.join(group_html(s) for s in sections if s['items']))
out_path = sys.argv[2] if len(sys.argv) > 2 else 'ShenScripts.html'
open(out_path, 'w', encoding='utf-8').write(html)
print('sections items:', count, 'bytes:', len(html.encode()))

# 同一次執行同時產生 shen-latest.json（目前沒有頁面讀取它，保留是因為排程 shen-page.yml 會一併提交它；確認不再需要後可一起移除）
vert = next((s for s in sections if '直式' in s['title'] and s['items']), None)
latest = vert['items'][0]['summary'].replace('.md', '') if vert else ''
updated = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y/%m/%d')
json_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), 'shen-latest.json')
open(json_path, 'w', encoding='utf-8').write(json.dumps({'latest': latest, 'updated': updated, 'count': count}, ensure_ascii=False) + '\n')
print('latest:', latest, 'updated:', updated)
