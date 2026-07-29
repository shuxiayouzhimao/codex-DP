#!/usr/bin/env python3
# 一次性离线抠图：把白底桌宠设计图转成透明精灵 PNG（运行时不做任何处理）。
#
# 用法：
#   python tools/cutout.py <源图> <输出.png> [容差=30]
#
# 算法：
#   1) 先把右下角“豆包AI生成”水印矩形填白（避免进入内容）；
#   2) 近白色掩码 → scipy 连通域标记 → 只把“与图像边缘相连”的近白区域判为背景
#      （白衣/白裙虽白但被描边包围、不与边缘连通，故不会被打穿）；
#   3) 背景 alpha=0，按内容包围盒裁剪 + 边距，降采样到 ≤512px，存带 alpha 的 PNG。

import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def cutout(src: str, dst: str, tol: int = 30, max_size: int = 512,
           wm_frac=(0.32, 0.09), margin: int = 8) -> None:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    arr = np.array(im).astype(np.uint8).copy()

    # 1) 遮水印：右下角矩形填白
    fw, fh = wm_frac
    x0, y0 = int(w * (1 - fw)), int(h * (1 - fh))
    arr[y0:h, x0:w, 0:3] = 255

    # 2) 边缘泛洪去背（连通域版）
    rgb = arr[..., :3].astype(np.int16)
    near_white = np.all(rgb >= (255 - tol), axis=-1)
    labels, _ = ndimage.label(near_white)  # 默认 4-连通，防对角渗漏
    border_labels = set(np.unique(np.concatenate(
        [labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])).tolist())
    border_labels.discard(0)  # 0 表示非 near_white
    background = np.isin(labels, list(border_labels)) if border_labels else np.zeros((h, w), bool)

    # 3) 背景透明
    out = arr.copy()
    out[..., 3] = np.where(background, 0, 255).astype(np.uint8)

    # 4) 内容包围盒裁剪 + 边距
    ys, xs = np.where(out[..., 3] > 0)
    if len(xs) == 0:
        raise SystemExit(f"[cutout] {src}: 去背后无内容（容差 {tol} 可能过大）")
    x_min, x_max = max(int(xs.min()) - margin, 0), min(int(xs.max()) + margin, w - 1)
    y_min, y_max = max(int(ys.min()) - margin, 0), min(int(ys.max()) + margin, h - 1)
    out = out[y_min:y_max + 1, x_min:x_max + 1]

    # 5) 降采样 + 保存
    img = Image.fromarray(out, "RGBA")
    if max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.LANCZOS)
    img.save(dst)
    kept = int((out[..., 3] > 0).sum())
    print(f"[cutout] {src}\n       -> {dst}  size={img.size}  bbox=({x_min},{y_min})-({x_max},{y_max})  保留像素={kept}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("用法: python tools/cutout.py <源图> <输出.png> [容差=30]")
    _tol = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    cutout(sys.argv[1], sys.argv[2], tol=_tol)
