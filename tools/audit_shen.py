# -*- coding: utf-8 -*-
"""神對話劇本自動檢查：python3 tools/audit_shen.py
檢查 shen/9x16、shen/16x9、shen/long 的格式、字數、角色與場景是否一致。
有問題時列出並以結束碼 1 結束；全部通過結束碼 0。
規則來源：每段至少 4 秒、台詞字數不超過秒數 3 倍、標題主文字連同標點最多 9 字、封面大字 4 到 8 字、
標籤最多 5 個且含 #與神對話、9:16 為準（16:9 與一念之間的提示詞與台詞要一致）。
已上架集數的 Code.gs 說明與標記要跟劇本一致，GS 檔版本短碼要是最新（tools/stamp_gas.py）。
"""
import re, glob, os, sys, json, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(ROOT, "shen")
PUN = set("，。？！、；：「」『』（）…—～·．,.?!;: 　")
STD_Y = "彥彬，約35歲，短髮，圓框銀色眼鏡，白色長袍，淡金色披肩，左手腕戴紅棕木雕佛珠手串"
ONE = "畫面中只有一位彥彬與一位佛祖，各只出現一次。"
TAIL = "聲音乾淨，沒有背景雜音，沒有背景音樂，只有人聲。"
BAN_PROMPT = ["寶殿", "木桌", "燭光", "禪房", "木窗", "風鈴", "木造小殿", "手中一張", "卡片二字", "茶杯",
              "雙手輕合", "合掌", "合十", "淨瓶", "細框眼鏡", "高級長袍"]
BAN_LINE = ["鏡像神經元"]
SEG = re.compile(r"^### (?:EP(\d+)-)?(\d+)｜(\d+)–(\d+) 秒｜(\S+)\n+```\n(.*?)\n```\n+台詞：(彥彬|佛祖)：「(.*?)」", re.S | re.M)

def clen(s): return sum(1 for c in s if c not in PUN)

def segs(text):
    return [dict(ep=m[1], k=int(m[2]), a=int(m[3]), b=int(m[4]), prompt=m[6], who=m[7], line=m[8]) for m in SEG.finditer(text)]

def yt_titles():
    """Code.gs 裡已上架集數的標題（YouTube 用的標題）。"""
    gs = os.path.join(ROOT, "line-bot", "Code.gs")
    js = ("const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');"
          "const g=(n)=>{const i=t.indexOf('const '+n+' = ');if(i<0)return null;const s=t.indexOf('=',i)+1;let d=0,j=s;"
          "for(;j<t.length;j++){const c=t[j];if(c==='['||c==='{')d++;else if(c===']'||c==='}'){d--;if(d===0){j++;break;}}}"
          "return eval('('+t.slice(s,j).trim()+')');};const o={};(g('TITLE_PLAN_')||[]).forEach(([i,x])=>{const m=x.match(/^EP(\\d+)｜/);if(m)o[+m[1]]=x;});"
          "Object.values(g('TITLE_EP_PLAN_')||{}).forEach(x=>{const m=x.match(/^EP(\\d+)｜/);if(m)o[+m[1]]=x;});console.log(JSON.stringify(o));")
    try:
        out = subprocess.run(["node", "-e", js, gs], capture_output=True, text=True, timeout=30).stdout
        return {int(k): v for k, v in json.loads(out).items()}
    except Exception:
        return {}

def main():
    problems = []
    def bad(where, msg): problems.append(f"{where}：{msg}")
    yt = yt_titles()
    canon = {}
    files9 = sorted(glob.glob(os.path.join(R, "9x16", "Ep*.md")))
    for p in files9:
        ep = int(re.search(r"Ep(\d+)", p)[1]); w = f"EP{ep:02d} 9:16"
        t = open(p, encoding="utf-8").read(); s = segs(t); canon[ep] = s
        if len(s) != 10: bad(w, f"段數 {len(s)}，應為 10")
        for i, x in enumerate(s):
            d = x["b"] - x["a"]
            if i and x["a"] != s[i - 1]["b"]: bad(w, f"第 {x['k']} 段時間沒有接續")
            if d < 4: bad(w, f"第 {x['k']} 段只有 {d} 秒（最少 4 秒）")
            if clen(x["line"]) > 3 * d: bad(w, f"第 {x['k']} 段台詞 {clen(x['line'])} 字，超過 {3*d} 字：{x['line']}")
            if (x["k"] % 2 == 1) != (x["who"] == "彥彬"): bad(w, f"第 {x['k']} 段說話者順序不對")
            pr = x["prompt"]
            if not pr.startswith("9:16 直式，"): bad(w, f"第 {x['k']} 段提示詞開頭不是 9:16 直式")
            if not pr.rstrip().endswith(TAIL): bad(w, f"第 {x['k']} 段提示詞結尾缺聲音指示")
            if STD_Y not in pr: bad(w, f"第 {x['k']} 段彥彬外型不是標準版")
            if ONE not in pr: bad(w, f"第 {x['k']} 段缺「{ONE}」")
            for b in BAN_PROMPT:
                if b in pr: bad(w, f"第 {x['k']} 段提示詞含「{b}」")
            for b in BAN_LINE:
                if b in x["line"]: bad(w, f"第 {x['k']} 段台詞含術語「{b}」")
        m = re.search(r"## 全部台詞\n+(.*?)\n---", t, re.S)
        if not m: bad(w, "缺「全部台詞」列表")
        elif [y[1] for y in re.findall(r"^\d+\. (彥彬|佛祖)：「(.*?)」", m[1], re.M)] != [x["line"] for x in s]:
            bad(w, "「全部台詞」列表與各段台詞不一致")
        tm = re.search(rf"(EP{ep:02d}｜([^ \n#`]+) (#[^\n`]*))", t)
        if not tm: bad(w, "缺影片標題")
        else:
            full, main_, tags = tm[1].strip(), tm[2].strip(), tm[3].split()
            if len(main_) > 9: bad(w, f"標題主文字 {len(main_)} 字，超過 9 字：{main_}")
            if len(tags) > 5: bad(w, f"標籤 {len(tags)} 個，超過 5 個")
            if "#與神對話" not in tags: bad(w, "標題缺 #與神對話")
            if ep in yt and yt[ep] != full: bad(w, f"標題與 YouTube 不一致：劇本「{full}」／YouTube「{yt[ep]}」")
        if re.search(r"(?<!與)#神對話", t): bad(w, "仍有舊標籤 #神對話")
        cm = re.search(r"\*\*封面大字\*\*：(.*)", t)
        if not cm or not 4 <= clen(cm[1]) <= 8: bad(w, f"封面大字要 4 到 8 字：{cm[1] if cm else '缺'}")
        if "關注頻道，每天一則神對話。" not in t: bad(w, "影片說明缺邀約句")
        # 16:9
        p16 = os.path.join(R, "16x9", f"Ep{ep:02d} 劇本 16x9.md")
        if not os.path.exists(p16): bad(f"EP{ep:02d} 16:9", "缺檔案"); continue
        t16 = open(p16, encoding="utf-8").read(); s16 = segs(t16)
        if [(x["a"], x["b"], x["line"]) for x in s16] != [(x["a"], x["b"], x["line"]) for x in s]:
            bad(f"EP{ep:02d} 16:9", "秒數或台詞與 9:16 不一致")
        if [x["prompt"] for x in s16] != [x["prompt"].replace("9:16 直式", "16:9 橫式", 1) for x in s]:
            bad(f"EP{ep:02d} 16:9", "提示詞（場景、角色、動作）與 9:16 不一致")
        if re.search(r"(?<!與)#神對話", t16): bad(f"EP{ep:02d} 16:9", "仍有舊標籤 #神對話")
    # 一念之間長影片
    L = open(os.path.join(R, "long", "神對話 一念之間 長影片.md"), encoding="utf-8").read()
    chs = list(re.finditer(r"^## 第 (\d+) 章｜EP(\d+)：(.*)$", L, re.M))
    if len(chs) != len(files9): bad("一念之間", f"章數 {len(chs)}，短劇有 {len(files9)} 集")
    for i, c in enumerate(chs):
        ep = int(c[2]); end = chs[i + 1].start() if i + 1 < len(chs) else L.find("## 三、片尾字幕卡")
        sl = segs(L[c.start():end]); s = canon.get(ep, [])
        if [x["line"] for x in sl] != [x["line"] for x in s]: bad("一念之間", f"第 {c[1]} 章台詞與 EP{ep:02d} 9:16 不一致")
        if [x["prompt"] for x in sl] != [x["prompt"].replace("9:16 直式", "16:9 橫式", 1) for x in s]:
            bad("一念之間", f"第 {c[1]} 章提示詞與 EP{ep:02d} 9:16 不一致")
        t9 = re.search(rf"EP{ep:02d}｜([^ \n#`]+) #", open(files9[ep - 1], encoding="utf-8").read()) if ep <= len(files9) else None
        if t9 and c[3].strip() != t9[1]: bad("一念之間", f"第 {c[1]} 章標題「{c[3].strip()}」與 9:16「{t9[1]}」不一致")
    if re.search(r"(?<!與)#神對話", L): bad("一念之間", "仍有舊標籤 #神對話")
    n = len(chs); zh = "零一二三四五六七八九十"
    def num(k): return (zh[k // 10] if k >= 20 else "") + ("十" if k >= 10 else "") + (zh[k % 10] if k % 10 else "") if k >= 10 else zh[k]
    if f"{num(n)}個章節" not in L: bad("一念之間", f"說明的章數沒有寫成「{num(n)}個章節」")
    # 跨集：最近三集的結尾不要太像
    lasts = [canon[e][-1]["line"] for e in sorted(canon)[-3:] if canon[e]]
    for k in ["自在", "放下", "放手"]:
        if len(lasts) == 3 and all(k in x for x in lasts): bad("最近三集", f"結尾都用「{k}」，建議換不同收尾")
    # 開場提醒（不算錯誤，列為建議）
    # GAS 同步（2026-11-27）：已上架的集數（Code.gs 有標題），Code.gs 的說明與標記要跟劇本一致；GS 檔短碼要是最新
    code = open(os.path.join(ROOT, "line-bot", "Code.gs"), encoding="utf-8").read()
    try:
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        from build_shen_from_repo import load_plans
        _, descs = load_plans(code)
        tm = re.search(r"const TAG_PLAN_ = (\{.*?\});", code)
        tagp = json.loads(tm[1]) if tm else {}
    except Exception as e:
        descs, tagp = {}, {}; bad("Code.gs", f"讀不到說明或標記清單：{e}")
    SI = re.compile(r"[&?]si=[A-Za-z0-9_-]+")
    for ep in sorted(yt):
        k = f"EP{ep:02d}"; p9 = os.path.join(R, "9x16", f"Ep{ep:02d} 劇本.md")
        if not os.path.exists(p9): continue
        m = re.search(r"\*\*影片說明\*\*[^\n]*\n```\n(.*?)\n```", open(p9, encoding="utf-8").read(), re.S)
        if k not in descs: bad("Code.gs", f"{k} 已上架，DESC_PLAN_ 缺這集的說明（從劇本補上）")
        elif m and SI.sub("", m[1]).strip() != descs[k].strip(): bad("Code.gs", f"{k} 的 DESC_PLAN_ 說明與劇本不一致")
        tg = tagp.get(k)
        if not tg: bad("Code.gs", f"{k} 已上架，TAG_PLAN_ 缺這集的標記")
        elif "與神對話" not in tg or "神對話" in tg: bad("Code.gs", f"{k} 的 TAG_PLAN_ 要用「與神對話」，不要「神對話」")
    st = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "stamp_gas.py"), "--check"], capture_output=True, text=True)
    if st.returncode: bad("GS 檔", "版本短碼過期，請執行 python3 tools/stamp_gas.py")
    tips = [f"EP{e:02d} 開場是定義式問句：{canon[e][0]['line']}" for e in sorted(canon)
            if canon[e] and re.search(r"^[^，]{1,4}，(是|是不是|就是).*嗎？$", canon[e][0]["line"])]
    for x in problems: print("✗", x)
    for x in tips: print("・建議", x)
    print(f"檢查完成：{len(files9)} 集，{len(problems)} 個問題，{len(tips)} 個建議。")
    return 1 if problems else 0

if __name__ == "__main__":
    sys.exit(main())
