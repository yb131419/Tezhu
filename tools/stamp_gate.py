# 小乖主頁（Assistant.html）版本標示：把 STAMP 這一行換成「v 短碼 · 台北時間」。
# 短碼 = 去掉 STAMP 那一行後內容的 SHA-1 前 7 碼，所以只有內容改變時短碼才會變。
# 用法：python3 tools/stamp_gate.py [檔案，預設 Assistant.html]
import datetime, hashlib, re, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'Assistant.html'
src = open(path, encoding='utf-8').read()
line_re = re.compile(r'var STAMP = "[^"]*";')
if not line_re.search(src):
    sys.exit('找不到 var STAMP 這一行')
body = line_re.sub('var STAMP = "";', src)
short = hashlib.sha1(body.encode('utf-8')).hexdigest()[:7]
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y/%m/%d %H:%M')
stamp = 'v ' + short + ' · ' + now
out = line_re.sub('var STAMP = "' + stamp + '";', src)
if out != src:
    open(path, 'w', encoding='utf-8').write(out)
    print('已更新版本標示：', stamp)
else:
    print('版本標示沒有變動')
