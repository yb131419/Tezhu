# GS 檔版本短碼：每個 line-bot/*.gs 檔最後都有一行 function gasStampXxx_() { return '短碼'; }。
# 短碼 = 把這一行的短碼清空後，整份內容的 SHA-1 前 7 碼，所以只有內容改變時短碼才會變。
# 小乖每日回報（ShenDaily.gs 的 gasUpdateNote_）會拿自己身上的短碼跟 GitHub 上最新的比對，
# 不一樣就提醒「需要更改 GAS」，並附上要貼的檔案、分頁與固定 commit 的連結。
# 用法：python3 tools/stamp_gas.py            （更新短碼）
#       python3 tools/stamp_gas.py --check    （只檢查，有檔案短碼過期就回傳 1）
import glob, hashlib, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FILES = ['Code.gs', 'ShenDaily.gs', 'Trade.gs', 'PriceSync.gs']   # 會貼進 Apps Script 專案的檔案（TradeSetup.gs 是一次性設定，不列入）
LINE = re.compile(r"function gasStamp(\w+)_\(\) \{ return '[0-9a-f]*'; \}")


def name_of(f):
    return re.sub(r'\W', '', os.path.splitext(f)[0])


def stamp(src, name):
    body = LINE.sub(lambda m: "function gasStamp%s_() { return ''; }" % m.group(1), src)
    return hashlib.sha1(body.encode('utf-8')).hexdigest()[:7], body


def main():
    check = '--check' in sys.argv
    stale = []
    for f in FILES:
        p = os.path.join(ROOT, 'line-bot', f)
        src = open(p, encoding='utf-8').read()
        name = name_of(f)
        if not LINE.search(src):
            src = src.rstrip('\n') + "\n\n// 版本短碼（tools/stamp_gas.py 自動產生，請勿手動修改）\nfunction gasStamp%s_() { return ''; }\n" % name
        short, body = stamp(src, name)
        out = LINE.sub(lambda m: "function gasStamp%s_() { return '%s'; }" % (m.group(1), short), body)
        if out != open(p, encoding='utf-8').read():
            stale.append(f)
            if not check:
                open(p, 'w', encoding='utf-8').write(out)
        print(f, short)
    if stale:
        print(('短碼過期：' if check else '已更新短碼：') + '、'.join(stale))
    sys.exit(1 if (check and stale) else 0)


if __name__ == '__main__':
    main()
