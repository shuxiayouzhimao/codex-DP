/** 精灵表清单（tools/video_frames.py 产出，与 JSON 对应） */
export interface SheetMeta {
  frameW: number;
  frameH: number;
  cols: number;
  count: number;
  fps: number;
  mode: "loop" | "pingpong" | "once";
  /** 三段式：入场帧数（播一次后进入中段循环）。缺省 = 整段循环 */
  intro?: number;
  /** 三段式：出场帧数（表末尾，状态结束时播一次；管线可用入场倒放生成） */
  outro?: number;
  /** 三段式：循环段起始帧（默认=intro；intro 与 loopStart 之间的帧被丢弃） */
  loopStart?: number;
  /** 三段式中段是否往返播放（首尾不接时比硬切回环更顺） */
  loopPingpong?: boolean;
}

/**
 * elapsedMs → 帧序号（无三段式时用）。纯函数。
 * - loop：0..count-1 取模循环
 * - pingpong：三角波 0..count-1..1（往返无缝；端点不重复，与管线的
 *   `frames + frames[-2:0:-1]` 拼接对应）
 * - once：播一遍后停在最后一帧（终态动画用）
 */
export function frameIndex(
  elapsedMs: number,
  count: number,
  fps: number,
  mode: "loop" | "pingpong" | "once",
): number {
  if (count <= 1 || fps <= 0) return 0;
  const step = Math.floor((elapsedMs * fps) / 1000);
  if (mode === "once") return Math.min(step, count - 1);
  if (mode === "loop") return step % count;
  const period = 2 * count - 2; // 往返周期
  const p = step % period;
  return p < count ? p : period - p;
}

/**
 * 三段式播放（入场 → 中段循环）：elapsedMs → 帧序号。纯函数。
 * loopStart > intro 时，两者之间的帧被跳过（不进入场也不进循环）。
 * loopPingpong：中段三角波往返，避免首尾姿态差大时硬切跳变。
 * 出场不走这里（状态结束时由 drawOutro 播末尾 outro 帧）。
 */
export function phasedIndex(
  elapsedMs: number,
  count: number,
  fps: number,
  intro: number,
  outro: number,
  loopStart: number = intro,
  loopPingpong = false,
): number {
  const loopLen = count - outro - loopStart;
  if (loopLen <= 0 || fps <= 0) return 0;
  const step = Math.floor((elapsedMs * fps) / 1000);
  if (step < intro) return step;
  const into = step - intro;
  if (!loopPingpong || loopLen <= 1) {
    return loopStart + (into % loopLen);
  }
  const period = 2 * loopLen - 2;
  const p = into % period;
  const off = p < loopLen ? p : period - p;
  return loopStart + off;
}

/** 出场段帧序号：表末尾 outro 帧顺序播一次，停在最后一帧。纯函数。 */
export function outroIndex(elapsedMs: number, count: number, fps: number, outro: number): number {
  if (outro <= 0 || fps <= 0) return Math.max(0, count - 1);
  const step = Math.floor((elapsedMs * fps) / 1000);
  return count - outro + Math.min(step, outro - 1);
}

/** 出场段时长（ms） */
export function outroDurationMs(fps: number, outro: number): number {
  return fps > 0 ? (outro * 1000) / fps : 0;
}

/**
 * 是否到达可切换的循环边界（已至少播过一帧循环）。
 * - 三段式：入场结束后，每走完一圈 loop 回到起点
 * - loop / pingpong：每走完一个播放周期
 * - once：播到末帧
 * 无有效 fps/帧数时视为随时可切。
 */
export function isAtLoopBoundary(elapsedMs: number, meta: SheetMeta): boolean {
  const { count, fps, mode, intro = 0, outro = 0, loopStart, loopPingpong } = meta;
  if (count <= 1 || fps <= 0) return true;
  const step = Math.floor((elapsedMs * fps) / 1000);

  if (intro > 0 || outro > 0) {
    const ls = loopStart ?? intro;
    const loopLen = count - outro - ls;
    if (loopLen <= 0) return step >= Math.max(intro, 1);
    if (step < intro) return false;
    const into = step - intro;
    const period = loopPingpong && loopLen > 1 ? 2 * loopLen - 2 : loopLen;
    return into > 0 && into % period === 0;
  }

  if (mode === "once") return step >= count - 1;

  if (mode === "loop") {
    return step > 0 && step % count === 0;
  }

  // pingpong：周期 2*count-2
  const period = Math.max(2, 2 * count - 2);
  return step > 0 && step % period === 0;
}

/** 帧绘制高度默认（逻辑像素）；可由 setDisplayHeight 覆盖以配合缩放 */
const DEFAULT_FRAME_H = 150;

type ShadowFn = (ctx: CanvasRenderingContext2D, rx: number, y: number, ry: number) => void;

/**
 * 序列帧皮肤播放器：精灵表（网格大图）按 fps 取帧绘制。
 * 状态区分：有专属序列播专属（三段式带入场/出场），缺省由 PetRenderer 回退 idle。
 */
export class FramePlayer {
  private sheet: HTMLImageElement | null = null;
  private displayH = DEFAULT_FRAME_H;

  constructor(
    private meta: SheetMeta,
    private sheetUrl: string,
  ) {}

  setDisplayHeight(h: number) {
    this.displayH = Math.max(1, h);
  }

  load(): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.sheet = img;
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = this.sheetUrl;
    });
  }

  /** 是否有出场段（状态结束时应先播完再切换） */
  hasOutro(): boolean {
    return (this.meta.outro ?? 0) > 0;
  }

  /** 素材目标帧率（供渲染跳帧） */
  fps(): number {
    return this.meta.fps > 0 ? this.meta.fps : 10;
  }

  outroDurationMs(): number {
    return outroDurationMs(this.meta.fps, this.meta.outro ?? 0);
  }

  /** 入场段时长（ms）；工作态内切换时用于跳过入场直接进循环 */
  introDurationMs(): number {
    const { fps, intro = 0 } = this.meta;
    return fps > 0 ? (intro * 1000) / fps : 0;
  }

  /** 当前播放进度是否落在可切换的循环边界 */
  atLoopBoundary(elapsedMs: number): boolean {
    return isAtLoopBoundary(elapsedMs, this.meta);
  }

  /** 以原点为中心绘制当前帧（高 FRAME_H 等比 + 地面阴影，与静态精灵一致） */
  draw(ctx: CanvasRenderingContext2D, elapsedMs: number, drawShadow: ShadowFn) {
    const { count, fps, mode, intro = 0, outro = 0, loopStart, loopPingpong } = this.meta;
    const i =
      intro > 0 || outro > 0
        ? phasedIndex(
            elapsedMs,
            count,
            fps,
            intro,
            outro,
            loopStart ?? intro,
            !!loopPingpong,
          )
        : frameIndex(elapsedMs, count, fps, mode);
    this.drawFrame(ctx, i, drawShadow);
  }

  /** 播出场段（状态结束切换前调用，播满 outroDurationMs 后调用方切换动画） */
  drawOutro(ctx: CanvasRenderingContext2D, elapsedMs: number, drawShadow: ShadowFn) {
    const { count, fps, outro = 0 } = this.meta;
    this.drawFrame(ctx, outroIndex(elapsedMs, count, fps, outro), drawShadow);
  }

  private drawFrame(ctx: CanvasRenderingContext2D, i: number, drawShadow: ShadowFn) {
    if (!this.sheet) return;
    const { frameW, frameH, cols } = this.meta;
    const sx = (i % cols) * frameW;
    const sy = Math.floor(i / cols) * frameH;

    const h = this.displayH;
    const w = (h * frameW) / frameH;
    drawShadow(ctx, w * 0.36, h / 2 + 4, 8);
    ctx.drawImage(this.sheet, sx, sy, frameW, frameH, -w / 2, -h / 2, w, h);
  }
}
