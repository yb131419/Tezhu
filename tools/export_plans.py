# 把 line-bot/Code.gs 裡的標題、說明、標記清單匯出成 shen-plans.json（純資料）。
# 小乖（Code.gs 的 titlePlans_）每天自動更新 YouTube 時，會先讀 GitHub 上這份 JSON，
# 所以清單更新後不用重貼 Code.gs 也會生效。
# 用法：python3 tools/export_plans.py            （產生 shen-plans.json）
#       python3 tools/export_plans.py --check    （只檢查，跟 Code.gs 不一致就回傳 1）
import json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CODE = os.path.join(ROOT, 'line-bot', 'Code.gs')
OUT = os.path.join(ROOT, 'shen-plans.json')
NAMES = ['TITLE_PLAN_', 'TITLE_EP_PLAN_', 'DESC_PLAN_', 'TAG_PLAN_']
JS = ("const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');"
      "const g=(n)=>{const i=t.indexOf('const '+n+' = ');if(i<0)throw new Error('找不到 '+n);const s=t.indexOf('=',i)+1;let d=0,j=s,q=null;"
      "for(;j<t.length;j++){const c=t[j];if(q){if(c==='\\\\'){j++;continue;}if(c===q)q=null;continue;}"
      "if(c==='\"'||c===\"'\"||c==='`'){q=c;continue;}if(c==='['||c==='{')d++;else if(c===']'||c==='}'){d--;if(d===0){j++;break;}}}"
      "return (0,eval)('('+t.slice(s,j).trim()+')');};const o={};" + ''.join("o['%s']=g('%s');" % (n, n) for n in NAMES) +
      "console.log(JSON.stringify(o));")


def build():
    out = subprocess.run(['node', '-e', JS, CODE], capture_output=True, text=True, timeout=60)
    if out.returncode:
        sys.exit('讀不到 Code.gs 的清單：' + out.stderr.strip())
    data = json.loads(out.stdout)
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=False) + '\n'


def main():
    text = build()
    old = open(OUT, encoding='utf-8').read() if os.path.exists(OUT) else ''
    if '--check' in sys.argv:
        print('shen-plans.json ' + ('是最新的' if old == text else '跟 Code.gs 不一致'))
        sys.exit(0 if old == text else 1)
    if old != text:
        open(OUT, 'w', encoding='utf-8').write(text)
        print('已更新 shen-plans.json')
    else:
        print('shen-plans.json 沒有變動')


if __name__ == '__main__':
    main()
