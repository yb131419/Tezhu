"""去除浮水印：把影片裡固定位置的浮水印（logo、帳號名稱）抹掉，其他畫面和聲音都不動。

獨立功能，不經過 Reels 剪片流程。用 ffmpeg 的 delogo 濾鏡，把指定方框內的像素用四周的顏色補起來。

位置（--region）可以寫：
  預設位置：左上、右上、左下、右下、上方、下方、中間上、中間下（上方、下方是整排的橫條）
  自訂：x,y,w,h，單位是畫面的百分比（0～100），例如 70,84,29,12 是畫面右下角。
  浮水印大概在哪，先在 Telegram 說「去浮水印 右下」，不準就改成自訂百分比再試。

用法：
  python3 watermark/remove_watermark.py --input 影片.mp4 --out 去好的.mp4 --region 右下
  python3 watermark/remove_watermark.py --input 影片.mp4 --out 去好的.mp4 --region 70,84,29,12

GitHub Actions 版（.github/workflows/watermark.yml）用環境變數：TELEGRAM_BOT_TOKEN、CHAT_ID、FILE_ID、URL（雲端硬碟連結，有 URL 就不用 FILE_ID）、REGION，
去好的影片直接傳回 Telegram。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

# 預設位置：(x, y, w, h)，都是畫面的百分比
PRESETS = {
    '左上': (1, 2, 30, 12), '右上': (69, 2, 30, 12),
    '左下': (1, 84, 30, 12), '右下': (69, 84, 30, 12),
    '上方': (15, 1, 70, 9), '下方': (15, 90, 70, 9),
    '中間上': (30, 10, 40, 10), '中間下': (30, 80, 40, 10),
}
DEFAULT_REGION = '右下'
PAD = 4   # 方框四周多蓋幾個像素，邊緣的半透明陰影也一起抹掉
TG_LIMIT = 48 * 1024 * 1024   # Telegram 機器人傳影片上限 50MB，留一點空間


class Oops(Exception):
    """要讓使用者看到的錯誤（繁體中文）。"""


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise Oops('處理影片時出錯了：' + (r.stderr or '')[-300:])
    return r.stdout


def probe_size(path):
    out = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', path]))
    s = out['streams'][0]
    w, h = int(s['width']), int(s['height'])
    rot = int(float((s.get('tags') or {}).get('rotate') or 0))
    for sd in s.get('side_data_list') or []:
        if 'rotation' in sd:
            rot = int(float(sd['rotation']))
    if abs(rot) % 180 == 90:   # 手機直拍：畫面是橫的，但要轉 90 度才是實際大小
        w, h = h, w
    return w, h


def parse_region(text):
    """回傳百分比 (x, y, w, h)。認得預設位置名稱，或 x,y,w,h 數字。"""
    t = (text or DEFAULT_REGION).strip().replace('，', ',').replace(' ', '')
    if t in PRESETS:
        return PRESETS[t]
    m = re.fullmatch(r'(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)', t)
    if not m:
        raise Oops('看不懂浮水印位置「%s」。可以說：左上、右上、左下、右下、上方、下方，或 x,y,寬,高（百分比，例如 70,84,29,12）。' % text)
    x, y, w, h = (float(v) for v in m.groups())
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > 100 or y + h > 100:
        raise Oops('浮水印位置超出畫面了（x、y、寬、高都是 0～100 的百分比，x+寬、y+高不能超過 100）。')
    return x, y, w, h


def box_px(region, size):
    """百分比方框 → 像素方框，四周多留 PAD；不超出畫面，寬高取偶數。"""
    W, H = size
    x, y, w, h = region
    bx = max(0, int(W * x / 100) - PAD)
    by = max(0, int(H * y / 100) - PAD)
    bw = min(W - bx, int(W * w / 100) + 2 * PAD) // 2 * 2
    bh = min(H - by, int(H * h / 100) + 2 * PAD) // 2 * 2
    if bw < 4 or bh < 4:
        raise Oops('浮水印方框太小，請換個位置說法再試。')
    return bx, by, bw, bh


def remove(src, out, region_text=DEFAULT_REGION, max_bytes=TG_LIMIT):
    """去浮水印並輸出。成品超過 max_bytes（Telegram 傳影片上限）就一路提高壓縮率重做，直到傳得回去。"""
    size = probe_size(src)
    bx, by, bw, bh = box_px(parse_region(region_text), size)
    for crf in (18, 23, 26, 28, 30):
        run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src,
             '-vf', 'delogo=x=%d:y=%d:w=%d:h=%d:show=0' % (bx, by, bw, bh),
             '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(crf),
             '-c:a', 'copy', '-movflags', '+faststart', out])
        if os.path.getsize(out) <= max_bytes:
            return (bx, by, bw, bh), size, crf
    raise Oops('去好的影片還是太大，傳不回 Telegram。請把影片剪短一點再試一次。')


# ---- GitHub Actions 版：從 Telegram 拿影片、傳回去 ----

def tg(method, **data):
    token = os.environ['TELEGRAM_BOT_TOKEN']
    req = urllib.request.Request('https://api.telegram.org/bot%s/%s' % (token, method),
                                 data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b'{}')


def drive_download(url, dest):
    """Google 雲端硬碟的影片（要設成「知道連結的人都能看」）→ 下載到 dest。網址不是雲端硬碟就回報錯誤。"""
    import gdown   # GitHub Actions 上用 pip 安裝
    if 'drive.google.com' not in url and 'docs.google.com' not in url:
        raise Oops('這不是 Google 雲端硬碟的連結。請把影片上傳到雲端硬碟，設成「知道連結的人都能看」，再把連結貼給小乖。')
    try:
        ok = gdown.download(url, dest, quiet=True, fuzzy=True)
    except Exception:   # noqa: BLE001 gdown 各種失敗都當成連結打不開
        ok = None
    if not ok or not os.path.exists(dest) or os.path.getsize(dest) == 0:
        raise Oops('雲端硬碟的影片抓不到。請確認連結是「知道連結的人都能看」，而且是影片檔（不是資料夾）。')


def tg_download(file_id, dest):
    info = tg('getFile', file_id=file_id)
    if not info.get('ok'):
        if 'too big' in str(info.get('description', '')):
            raise Oops('影片超過 20MB，Telegram 不讓機器人下載。請把影片上傳到 Google 雲端硬碟，設成「知道連結的人都能看」，再把連結貼給小乖。')
        raise Oops('拿不到影片（%s），請再傳一次。' % info.get('description', ''))
    url = 'https://api.telegram.org/file/bot%s/%s' % (os.environ['TELEGRAM_BOT_TOKEN'], info['result']['file_path'])
    urllib.request.urlretrieve(url, dest)


def tg_send_video(chat_id, path, caption):
    cmd = ['curl', '-sS', '-F', 'chat_id=%s' % chat_id, '-F', 'video=@%s' % path, '-F', 'supports_streaming=true',
           '-F', 'caption=%s' % caption[:1000],
           'https://api.telegram.org/bot%s/sendVideo' % os.environ['TELEGRAM_BOT_TOKEN']]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        ok = json.loads(out).get('ok')
    except ValueError:
        ok = False
    if not ok:
        raise Oops('去好了，但傳回 Telegram 失敗，請再試一次。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', help='本機測試用的影片檔')
    ap.add_argument('--out', default='去浮水印.mp4')
    ap.add_argument('--region', default=os.environ.get('REGION', '') or DEFAULT_REGION,
                    help='浮水印位置：左上／右上／左下／右下／上方／下方／中間上／中間下，或 x,y,寬,高（百分比）')
    a = ap.parse_args()
    chat = os.environ.get('CHAT_ID')
    try:
        if a.input:
            src = a.input
        elif os.environ.get('URL'):
            src = os.path.join(tempfile.mkdtemp(), 'input.mp4')
            drive_download(os.environ['URL'], src)
        else:
            src = os.path.join(tempfile.mkdtemp(), 'input.mp4')
            tg_download(os.environ['FILE_ID'], src)
        box, size, crf = remove(src, a.out, a.region)
        print('去除浮水印完成：畫面 %dx%d，方框 x=%d y=%d w=%d h=%d，壓縮 crf %d' % (size + box + (crf,)), file=sys.stderr)
        if chat:
            # 下載：Telegram 這支影片可以長按儲存；另外 GitHub 執行頁面的 Artifacts 也有 watermark.mp4 可以下載（需要登入 GitHub）
            run_url = '%s/%s/actions/runs/%s' % (os.environ.get('GITHUB_SERVER_URL', 'https://github.com'),
                                                 os.environ.get('GITHUB_REPOSITORY', 'yb131419/Tezhu'), os.environ.get('GITHUB_RUN_ID', ''))
            tg_send_video(chat, a.out, '🧽 浮水印去好了（位置：%s）\n下載：%s' % (a.region or DEFAULT_REGION, run_url))
    except Oops as e:
        print('Oops:', e, file=sys.stderr)
        if chat:
            tg('sendMessage', chat_id=chat, text='🧽 ' + str(e))
        sys.exit(1)


if __name__ == '__main__':
    main()
