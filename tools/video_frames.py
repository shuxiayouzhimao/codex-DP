#!/usr/bin/env python3
# 一次性离线管线：白底角色视频 → 透明序列帧精灵表（sprite sheet）+ 清单 JSON。
# 运行时不做任何视频解码，前端 drawImage 源矩形取帧。
#
# 用法：
#   python tools/video_frames.py <视频.mp4> <输出目录> [--name idle] [--fps 12] [--height 256]
#                                [--tol 30] [--start 秒] [--end 秒]
#
# 流程：
#   1) OpenCV 按目标 fps 等间隔抽帧；
#   2) 逐帧去白底（复用 cutout.remove_white_bg：遮水印 + 边缘泛洪连通域）；
#   3) 全帧并集包围盒统一裁剪（逐帧各自裁剪会抖动）→ 降采样到目标高度；
#   4) 循环段检测：末帧与各候选起点帧做 MSE，找最长“首尾相似”段；
#      不达标则 ping-pong（正放 + 逆序拼接，无缝）；
#   5) 打包网格精灵表 <name>.png + 清单 <name>.json
#      {frameW, frameH, cols, count, fps, mode: "loop"|"pingpong"}；
#   6) 另产 _poster.png（首帧，配置面板缩略图）与 _preview.png（抽样拼版，肉眼验收）。
#
# 依赖：opencv-python、Pillow、numpy、scipy（均离线工具自有，不进项目依赖）。

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from cutout import remove_white_bg  # noqa: E402

# 连通域过滤：默认只保留最大连通域（角色本体），其余一律置透明。
# 豆包水印是半透明白字：白底上隐形，去背后成不透明白斑；整行文字可连
# 成超大分量（达主角色 10%），按比例阈值杀不掉，只能取最大。水印位置
# 随帧漂移，遮角也遮不住，连通域是唯一稳健手段。
# 例外：无水印素材里漂浮道具（成功视频的 ✓/星星）与角色不连通，
# 取最大会误杀——用 --keep N 保留面积前 N 的连通域。

# 循环段检测：首尾帧 MSE 阈值（去鬼影后、下采样 64px、0-255 尺度）。
# 实测本素材：相邻帧中位 ~258，候选循环段 66~120，故取 150。
LOOP_MSE_MAX = 150.0
# 循环段最少保留的帧数（太短会像抽搐）
LOOP_MIN_FRAMES = 8


def sample_frames(video: str, target_fps: float, start: float, end: float | None):
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"[video_frames] 打不开视频: {video}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = total / src_fps
    end = min(end, dur) if end else dur
    step = max(1, round(src_fps / target_fps))
    fps = src_fps / step

    frames = []
    idx = int(start * src_fps)
    last = int(end * src_fps)
    while idx < min(last, total):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, fr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
        idx += step
    cap.release()
    if len(frames) < 2:
        raise SystemExit(f"[video_frames] 抽帧不足（{len(frames)} 帧），检查 --start/--end")
    print(f"[video_frames] 源 {src_fps:.1f}fps/{total}帧 → 抽 {len(frames)} 帧 @ {fps:.1f}fps")
    return frames, fps


def keep_main_component(arr: np.ndarray, keep: int = 1) -> np.ndarray:
    """保留面积前 keep 的连通域，其余置透明。"""
    a = arr[..., 3] > 0
    lab, n = ndimage.label(a)
    if n <= keep:
        return arr
    sizes = np.asarray(ndimage.sum(a, lab, range(1, n + 1)))
    top = np.argsort(sizes)[-keep:] + 1  # 面积前 keep 的 label id
    out = arr.copy()
    out[..., 3] = np.where(np.isin(lab, top), out[..., 3], 0)
    return out


def cutout_frames(frames, tol: int, keep: int = 1):
    out = []
    for i, fr in enumerate(frames):
        rgba = np.dstack([fr, np.full(fr.shape[:2], 255, np.uint8)])
        # 不遮角（wm_frac=None）：新素材无水印，遮角会误删右下角的角色/特效；
        # 水印由 keep_main_component 兜底
        out.append(keep_main_component(remove_white_bg(rgba, tol=tol, wm_frac=None), keep))
        if (i + 1) % 20 == 0:
            print(f"[video_frames] 去背 {i + 1}/{len(frames)}")
    return out


def union_crop(frames, margin: int = 6):
    """全帧并集包围盒 → 统一裁剪（防抖动）。"""
    x0, y0, x1, y1 = None, None, None, None
    for fr in frames:
        ys, xs = np.where(fr[..., 3] > 0)
        if len(xs) == 0:
            continue
        fx0, fx1, fy0, fy1 = xs.min(), xs.max(), ys.min(), ys.max()
        x0 = fx0 if x0 is None else min(x0, fx0)
        x1 = fx1 if x1 is None else max(x1, fx1)
        y0 = fy0 if y0 is None else min(y0, fy0)
        y1 = fy1 if y1 is None else max(y1, fy1)
    if x0 is None:
        raise SystemExit("[video_frames] 去背后无内容（tol 可能过大）")
    h, w = frames[0].shape[:2]
    x0, y0 = max(x0 - margin, 0), max(y0 - margin, 0)
    x1, y1 = min(x1 + margin, w - 1), min(y1 + margin, h - 1)
    print(f"[video_frames] 并集包围盒 ({x0},{y0})-({x1},{y1}) = {x1 - x0 + 1}x{y1 - y0 + 1}")
    return [fr[y0:y1 + 1, x0:x1 + 1] for fr in frames]


def resize_frames(frames, height: int):
    out = []
    for fr in frames:
        img = Image.fromarray(fr, "RGBA")
        w = round(img.width * height / img.height)
        out.append(np.array(img.resize((w, height), Image.LANCZOS)))
    return out


def pick_loop(frames):
    """返回 (帧列表, mode)。全枚举 (i,j) 找首尾相似的最长段；失败则 ping-pong。

    ping-pong **不**把逆序烤进精灵表：只保留正放帧，mode=\"pingpong\" 由前端
    frameIndex 做三角波往返（与 frame-player 单测一致）。旧逻辑拼接逆序再标
    pingpong 会导致往返两次。
    """
    small = [
        np.asarray(Image.fromarray(fr, "RGBA").resize((64, 64), Image.BILINEAR), np.float32)
        for fr in frames
    ]

    def mse(i: int, j: int) -> float:
        d = small[i] - small[j]
        return float(np.mean(d * d))

    best = None  # (长度, -mse, i, j)
    for i in range(0, len(frames) - LOOP_MIN_FRAMES):
        for j in range(i + LOOP_MIN_FRAMES, len(frames)):
            m = mse(i, j)
            if m <= LOOP_MSE_MAX:
                cand = (j - i, -m, i, j)
                if best is None or cand > best:
                    best = cand
    if best is not None:
        length, neg_m, i, j = best
        seg = frames[i:j]
        print(f"[video_frames] 循环段：帧 {i}..{j - 1}（{length} 帧，首尾 MSE={-neg_m:.1f}）")
        return seg, "loop"
    print(f"[video_frames] 无相似循环段（首尾 MSE={mse(0, len(frames) - 1):.1f} "
          f"> {LOOP_MSE_MAX}）→ ping-pong {len(frames)} 帧（前端往返）")
    return frames, "pingpong"


def decide_full(frames):
    """--full：整段保留，不做短循环裁切。"""
    small = [
        np.asarray(Image.fromarray(fr, "RGBA").resize((64, 64), Image.BILINEAR), np.float32)
        for fr in frames
    ]
    d = small[0] - small[-1]
    m = float(np.mean(d * d))
    if m <= LOOP_MSE_MAX:
        print(f"[video_frames] --full：整段 loop {len(frames)} 帧（首尾 MSE={m:.1f}）")
        return frames, "loop"
    print(f"[video_frames] --full：整段 pingpong {len(frames)} 帧（首尾 MSE={m:.1f}，前端往返）")
    return frames, "pingpong"


def pack_sheet(frames):
    """网格打包 → (sheet Image, meta 骨架)。"""
    n = len(frames)
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    fw, fh = frames[0].shape[1], frames[0].shape[0]
    sheet = Image.new("RGBA", (cols * fw, rows * fh), (0, 0, 0, 0))
    for i, fr in enumerate(frames):
        sheet.paste(Image.fromarray(fr, "RGBA"), ((i % cols) * fw, (i // cols) * fh))
    return sheet, {"frameW": fw, "frameH": fh, "cols": cols, "count": n}


def contact_sheet(frames, path: Path, max_tiles: int = 12):
    """抽样拼版（棋盘底），肉眼验收去背/循环。"""
    idxs = np.linspace(0, len(frames) - 1, min(max_tiles, len(frames))).astype(int)
    tw = 160
    tiles = []
    for i in idxs:
        img = Image.fromarray(frames[i], "RGBA")
        th = round(img.height * tw / img.width)
        tiles.append(img.resize((tw, th), Image.LANCZOS))
    th = max(t.height for t in tiles)
    cols = math.ceil(math.sqrt(len(tiles)))
    rows = math.ceil(len(tiles) / cols)
    board = Image.new("RGB", (cols * tw, rows * th), (200, 200, 200))
    for n, t in enumerate(tiles):
        x, y = (n % cols) * tw, (n // cols) * th
        board.paste(t, (x, y), t)
    board.save(path)


def main() -> None:
    ap = argparse.ArgumentParser(description="白底角色视频 → 透明序列帧精灵表")
    ap.add_argument("video")
    ap.add_argument("outdir")
    ap.add_argument("--name", default="idle", help="状态名（输出文件名，如 idle/thinking）")
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--height", type=int, default=256, help="帧目标高度 px")
    ap.add_argument("--tol", type=int, default=30, help="去白容差")
    ap.add_argument("--start", type=float, default=0.0, help="起始秒")
    ap.add_argument("--end", type=float, default=None, help="结束秒（默认片尾）")
    ap.add_argument("--colors", type=int, default=256,
                    help="调色板量化色数（0=不量化；平涂卡通近乎无损，体积减 ~70%%）")
    ap.add_argument("--keep", type=int, default=1,
                    help="保留面积前 N 的连通域（默认 1=只留角色本体，杀水印最稳；"
                         "无水印且含漂浮道具的素材用 3-5 保住道具）")
    ap.add_argument("--intro", type=int, default=0,
                    help="入场帧数（三段式：前 N 帧播一次 → 中段循环 → 出场，跳过循环段检测）")
    ap.add_argument("--outro", type=int, default=0,
                    help="出场帧数（末尾 M 帧，状态结束时播一次）；-1 = 用入场帧倒放作出场")
    ap.add_argument("--loop-start", type=int, default=None,
                    help="循环段起始帧（默认=intro；intro 与 loopStart 之间的帧被丢弃）")
    ap.add_argument("--once", action="store_true",
                    help="一次性播放：整段播一遍停在最后一帧（终态动画用，跳过循环段检测）")
    ap.add_argument("--full", action="store_true",
                    help="保留全部抽帧，不做短循环段裁切（思考等完整动作）；"
                         "首尾不相似则 pingpong 由前端往返")
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    frames, fps = sample_frames(args.video, args.fps, args.start, args.end)
    frames = cutout_frames(frames, args.tol, args.keep)
    frames = union_crop(frames)
    frames = resize_frames(frames, args.height)

    meta_extra = {}
    if args.once:
        mode = "once"
        print(f"[video_frames] 一次性播放：{len(frames)} 帧，停在最后一帧")
    elif args.intro > 0 or args.outro != 0:
        # 三段式：入场 intro 帧 + 中段循环 + 出场 outro 帧，整段保留
        if args.intro + abs(args.outro) >= len(frames):
            raise SystemExit(
                f"[video_frames] intro({args.intro})+outro({abs(args.outro)}) ≥ 总帧数({len(frames)})")
        outro_n = args.outro
        if args.outro == -1:
            # 素材无自然消退段时：入场帧倒放 = 消退（齿轮出现倒放 = 齿轮消失）
            outro_n = args.intro
            frames = frames + frames[args.intro - 1::-1]
        loop_start = args.loop_start if args.loop_start is not None else args.intro
        if not (args.intro <= loop_start < len(frames) - outro_n):
            raise SystemExit(
                f"[video_frames] loop-start({loop_start}) 须在 [{args.intro}, {len(frames) - outro_n}) 内")
        mode = "loop"
        meta_extra = {"intro": args.intro, "outro": outro_n}
        if loop_start != args.intro:
            meta_extra["loopStart"] = loop_start
        print(f"[video_frames] 三段式：入场 {args.intro} 帧 → 循环 [{loop_start}, "
              f"{len(frames) - outro_n}) {len(frames) - outro_n - loop_start} 帧 → 出场 {outro_n} 帧"
              f"{'（入场倒放）' if args.outro == -1 else ''}")
    elif args.full:
        frames, mode = decide_full(frames)
    else:
        frames, mode = pick_loop(frames)

    sheet, meta = pack_sheet(frames)
    meta.update({"fps": round(fps, 3), "mode": mode, **meta_extra})
    if args.colors > 0:
        # RGBA → 调色板（FASTOCTREE 保留 alpha）；平涂卡通视觉近乎无损
        sheet = sheet.quantize(colors=args.colors, method=Image.FASTOCTREE)
    sheet.save(outdir / f"{args.name}.png")
    (outdir / f"{args.name}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    Image.fromarray(frames[0], "RGBA").save(outdir / "_poster.png") if args.name == "idle" else None
    # 按状态命名，避免多状态互相覆盖；并保留旧名兼容
    contact_sheet(frames, outdir / f"_preview-{args.name}.png")
    contact_sheet(frames, outdir / "_preview.png")

    size_kb = (outdir / f"{args.name}.png").stat().st_size // 1024
    print(f"[video_frames] -> {outdir / (args.name + '.png')}  {sheet.size[0]}x{sheet.size[1]}"
          f"  {meta['count']}帧({meta['frameW']}x{meta['frameH']})  mode={mode}  {size_kb}KB")


if __name__ == "__main__":
    main()
