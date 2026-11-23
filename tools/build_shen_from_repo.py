# 神劇本頁自動產生：來源是 repo 內的劇本檔（shen/）與程式的標題、說明清單（line-bot/Code.gs）。
# 每次 Code.gs 或劇本檔更新，GitHub Actions（.github/workflows/shen-page.yml）會重新跑這支程式，
# 把最新的標題、影片說明（開頭含邀約句）與神對話播放清單連結（不帶 si）寫進 ShenScripts.html。
# 用法：python3 tools/build_shen_from_repo.py   （在 repo 根目錄執行）
import glob, html, json, os, re, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CODE = os.path.join(ROOT, 'line-bot', 'Code.gs')
SI_RE = re.compile(r'[&?]si=[A-Za-z0-9_-]+')   # 去掉播放清單的 si 參數


def load_plans(code_text):
    """從 Code.gs 讀出最新的標題與說明：TITLE_PLAN_ / TITLE_EP_PLAN_ / DESC_PLAN_。"""
    titles = {}
    for m in re.finditer(r"\['[^']+', '((EP\d\d)｜[^']*)'\]", code_text):
        titles[m.group(2)] = m.group(1)
    for m in re.finditer(r"'(EP\d\d)': '((EP\d\d)｜[^']*)'", code_text):
        titles[m.group(1)] = m.group(2)
    descs = {}
    block = code_text[code_text.index('const DESC_PLAN_ = {'):]
    block = block[:block.index('\n};')]
    for m in re.finditer(r'^  "(EP\d\d|LONG)": (".*?")(?:,)?$', block, re.M):
        descs[m.group(1)] = json.loads(m.group(2))
    return titles, descs


def fill_script(text, key, titles, descs):
    """把劇本檔裡的「影片標題」「影片說明」換成最新內容；去掉 si 參數。"""
    if key in titles:
        # 影片標題區塊，以及封面說明裡「影片標題（完整標題…）：EPxx｜…」那一行，都換成最新標題（含標記）
        text = re.sub(r'(\*\*影片標題\*\*[^\n]*\n```\n)(.*?)(\n```)',
                      lambda m: m.group(1) + titles[key] + m.group(3), text, count=1, flags=re.S)
        text = re.sub(re.escape(key) + r'｜[^\n]*', lambda m: titles[key], text)
    if key in descs:
        text = re.sub(r'(\*\*影片說明\*\*[^\n]*\n```\n)(.*?)(\n```)',
                      lambda m: m.group(1) + descs[key] + m.group(3), text, count=1, flags=re.S)
    return SI_RE.sub('', text)


def title_renames(titles):
    """舊標題（劇本檔裡原本的）→ 新標題，只取「EPxx」後面的主文字，用來更新劇情裡「EP23 ……」這類提到其他集的地方。"""
    ren = {}
    for p in glob.glob(os.path.join(ROOT, 'shen', '9x16', 'Ep*.md')):
        key = 'EP' + re.match(r'Ep(\d\d)', os.path.basename(p)).group(1)
        if key not in titles:
            continue
        with open(p, encoding='utf-8') as f:
            m = re.search(r'\*\*影片標題\*\*[^\n]*\n```\n(.*?)\n```', f.read(), re.S)
        if not m:
            continue
        old_main = m.group(1).split('｜', 1)[1].split(' #')[0].strip()
        new_main = titles[key].split('｜', 1)[1].split(' #')[0].strip()
        if old_main and old_main != new_main:
            for sep in (' ', '｜', '：'):
                ren[key + sep + old_main] = key + sep + new_main
                # 劇情裡常省略問號，例如「EP24 猜心猜到累、」
                ren[key + sep + old_main.rstrip('？?')] = key + sep + new_main.rstrip('？?')
    return ren


def build_input_html(titles, descs):
    parts = []
    renames = title_renames(titles)
    def items(paths, key_of):
        out = []
        for p in paths:
            name = os.path.basename(p)
            key = key_of(name)
            with open(p, encoding='utf-8') as f:
                text = fill_script(f.read(), key, titles, descs)
            for a, b in renames.items():
                text = text.replace(a, b)
            out.append('<details><summary>%s</summary><pre>%s</pre></details>' % (
                html.escape(name, quote=False), html.escape(text, quote=False)))
        return out
    ep_of = lambda n: (re.match(r'Ep(\d\d)', n).group(1) and 'EP' + re.match(r'Ep(\d\d)', n).group(1))
    long_paths = sorted(glob.glob(os.path.join(ROOT, 'shen', 'long', '*.md')))
    p916 = sorted(glob.glob(os.path.join(ROOT, 'shen', '9x16', 'Ep*.md')), reverse=True)
    p169 = sorted(glob.glob(os.path.join(ROOT, 'shen', '16x9', 'Ep*.md')), reverse=True)
    parts.append('<h2>一念之間長影片</h2>')
    parts += items(long_paths, lambda n: 'LONG')
    parts.append('<h2>直式 9:16（EP26 到 EP01）</h2>')
    parts += items(p916, ep_of)
    parts.append('<h2>橫式 16:9（EP26 到 EP01）</h2>')
    parts += items(p169, ep_of)
    return '<!doctype html><html><body>' + '\n'.join(parts) + '</body></html>'


def main():
    with open(CODE, encoding='utf-8') as f:
        titles, descs = load_plans(f.read())
    src = build_input_html(titles, descs)
    with tempfile.NamedTemporaryFile('w', suffix='.html', encoding='utf-8', delete=False) as tmp:
        tmp.write(src)
        tmp_path = tmp.name
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build_shen_scripts.py'), tmp_path,
                        os.path.join(ROOT, 'ShenScripts.html')], check=True, cwd=ROOT)
    finally:
        os.unlink(tmp_path)
    print('titles:', len(titles), 'descriptions:', len(descs))


if __name__ == '__main__':
    main()
