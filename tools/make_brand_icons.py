# -*- coding: utf-8 -*-
"""从 data/Icon 母稿生成图标（中间产物写到 brand/，可不入库）。

用法：
  1. 将母稿 PNG 放入 data/Icon/
  2. python tools/make_brand_icons.py
  3. npx tauri icon brand/app-icon-1024.png --output src-tauri/icons
  4. 再跑一遍本脚本写回 tray.png / mark-128.png（tauri icon 会覆盖 tray）

母稿若已是透明底，直接取内容包围盒；否则边缘泛洪去白。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from cutout import remove_white_bg  # noqa: E402

ICON_DIR = ROOT / "data" / "Icon"
OUT = ROOT / "brand"


def find_source() -> Path:
    pngs = sorted(ICON_DIR.glob("*.png"))
    if not pngs:
        raise SystemExit(f"no png in {ICON_DIR}")
    # 取修改时间最新的一张
    return max(pngs, key=lambda p: p.stat().st_mtime)


def load_cutout(src: Path) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    transparent = float((arr[:, :, 3] == 0).mean())
    if transparent > 0.05:
        print(f"  already transparent ({transparent:.0%}), skip flood cutout")
        return im
    print("  opaque plate → flood cutout")
    return Image.fromarray(remove_white_bg(arr, tol=24, wm_frac=None), "RGBA")


def content_bbox(im: Image.Image, thr: int = 8):
    a = np.array(im.split()[-1])
    ys, xs = np.where(a > thr)
    if len(xs) == 0:
        raise SystemExit("empty after cutout")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def square_pad(im: Image.Image, margin_frac: float = 0.06) -> Image.Image:
    x0, y0, x1, y1 = content_bbox(im)
    crop = im.crop((x0, y0, x1, y1))
    side = max(crop.width, crop.height)
    pad = int(side * margin_frac)
    canvas_side = side + pad * 2
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    ox = (canvas_side - crop.width) // 2
    oy = (canvas_side - crop.height) // 2
    canvas.paste(crop, (ox, oy), crop)
    return canvas


def circularize(im: Image.Image, margin: float = 0.02, feather: int = 6) -> Image.Image:
    w, h = im.size
    m = Image.new("L", (w, h), 0)
    inset = int(w * margin)
    ImageDraw.Draw(m).ellipse((inset, inset, w - inset - 1, h - inset - 1), fill=255)
    if feather:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    r, g, b, a = im.split()
    a = ImageChops.multiply(a, m)
    return Image.merge("RGBA", (r, g, b, a))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    src_path = find_source()
    print("source:", src_path.name)
    cut = load_cutout(src_path)
    squared = square_pad(cut, margin_frac=0.05)
    face = squared.resize((1024, 1024), Image.Resampling.LANCZOS)
    # 最新稿自带外描边贴纸感：主标保留完整方形透明底，不再强行圆裁（小尺寸更清晰）
    face.save(OUT / "app-icon-1024.png")
    face_circle = circularize(face, margin=0.03, feather=4)

    bg = Image.new("RGBA", (1024, 1024), (15, 118, 110, 255))
    rm = Image.new("L", (1024, 1024), 0)
    ImageDraw.Draw(rm).rounded_rectangle((0, 0, 1023, 1023), radius=180, fill=255)
    bg.putalpha(rm)
    face_in = face.resize((900, 900), Image.Resampling.LANCZOS)
    solid = bg.copy()
    solid.paste(face_in, (62, 62), face_in)
    solid.save(OUT / "app-icon-1024-solid.png")

    tray = face.resize((256, 256), Image.Resampling.LANCZOS)
    rgb = ImageEnhance.Contrast(tray.convert("RGB")).enhance(1.12)
    rgb = ImageEnhance.Sharpness(rgb).enhance(1.3)
    r, g, b = rgb.split()
    tray2 = Image.merge("RGBA", (r, g, b, tray.split()[-1]))
    tray2.save(OUT / "tray-master-256.png")

    assets = ROOT / "src" / "assets" / "brand"
    assets.mkdir(parents=True, exist_ok=True)
    face_circle.resize((128, 128), Image.Resampling.LANCZOS).save(assets / "mark-128.png")

    icons = ROOT / "src-tauri" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    tray2.save(icons / "tray.png")
    tray2.resize((32, 32), Image.Resampling.LANCZOS).save(icons / "tray-32.png")

    print("OK ->", OUT)
    for p in sorted(OUT.glob("*.png")):
        print(f"  {p.name} {Image.open(p).size}")


if __name__ == "__main__":
    main()
