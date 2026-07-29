import type { AnimDef, AnimName } from "./types";
import animationsJson from "../assets/config/animations.json";
import spriteGreenUrl from "../assets/sprites/sprite-green.png";
import spriteRedUrl from "../assets/sprites/sprite-red.png";

const ANIMATIONS = animationsJson as unknown as Record<AnimName, AnimDef>;

/** 可用皮肤（Vite 打包为静态资源） */
const SKIN_URLS: Record<string, string> = {
  green: spriteGreenUrl,
  red: spriteRedUrl,
};

/** 精灵绘制高度（逻辑像素，200px 画布内） */
const SPRITE_H = 150;

/**
 * Canvas 变换式动画引擎。
 * 角色为抠图精灵（drawImage）；皮肤缺失/未加载时回退程序化占位 blob。
 * 变换栈/rAF/setAnim 与皮肤、绘制内容解耦。
 */
export class PetRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private anim: AnimName = "idle";
  private animStart = 0;
  private raf = 0;
  private running = false;
  private skins = new Map<string, HTMLImageElement>();
  private skin = "green";

  /** once 动画播完回到 next 时回调（便于 UI 同步状态文案） */
  onAnimEnd: ((next: AnimName) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, size = 200) {
    this.canvas = canvas;
    this.size = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = "high";
  }

  /** 预加载全部皮肤；失败的皮膚缺失（绘制时回退 blob）。 */
  loadSkins(): Promise<void> {
    const jobs = Object.entries(SKIN_URLS).map(
      ([name, url]) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            this.skins.set(name, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        }),
    );
    return Promise.all(jobs).then(() => undefined);
  }

  setSkin(name: string) {
    this.skin = name;
  }
  getSkin(): string {
    return this.skin;
  }

  setAnim(anim: AnimName) {
    if (anim === this.anim) return;
    this.anim = anim;
    this.animStart = performance.now();
  }
  getAnim(): AnimName {
    return this.anim;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.animStart = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number) => {
    if (!this.running) return;
    const def = ANIMATIONS[this.anim] ?? {};
    if (def.once && now - this.animStart >= (def.duration ?? 800)) {
      const next = def.next ?? "idle";
      this.animStart = now;
      this.anim = next;
      this.onAnimEnd?.(next);
    }
    this.draw(ANIMATIONS[this.anim] ?? {}, now);
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(def: AnimDef, now: number) {
    const ctx = this.ctx;
    const S = this.size;
    const t = (now - this.animStart) / 1000;
    const dur = (def.duration ?? 800) / 1000;
    const u = Math.min(t / dur, 1);

    let dx = 0;
    let dy = 0;
    let rot = 0;
    let sy = 1;
    const osc = (period: number) => Math.sin((t * 1000 * 2 * Math.PI) / period);

    if (def.bob) dy += osc(def.bob.period) * def.bob.amp;
    if (def.bounce)
      dy -= Math.abs(Math.sin((t * 1000 * Math.PI) / def.bounce.period)) * def.bounce.amp;
    if (def.tilt) rot += osc(def.tilt.period) * ((def.tilt.amp * Math.PI) / 180);
    if (def.breath) sy += osc(def.breath.period) * def.breath.sy;
    if (def.shake) dx += osc(def.shake.period) * def.shake.amp;
    if (def.jump) dy += -4 * u * (1 - u) * def.jump.h; // 抛物线：中点最高

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S / 2 + dx, S / 2 + 6 + dy);
    ctx.rotate(rot);
    ctx.scale(1, sy);
    this.drawCharacter(ctx, this.anim, now);
    ctx.restore();
  }

  /** 角色绘制：优先当前皮肤精灵，缺失时回退程序化 blob。均以原点为中心。 */
  private drawCharacter(ctx: CanvasRenderingContext2D, anim: AnimName, now: number) {
    const img = this.skins.get(this.skin);
    if (img) {
      const h = SPRITE_H;
      const w = (h * img.naturalWidth) / img.naturalHeight;
      this.drawShadow(ctx, w * 0.36, h / 2 + 4, 8);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      return;
    }
    this.drawBlob(ctx, anim, now);
  }

  private drawShadow(ctx: CanvasRenderingContext2D, rx: number, y: number, ry: number) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 程序化占位角色（kawaii blob，透明底） */
  private drawBlob(ctx: CanvasRenderingContext2D, anim: AnimName, now: number) {
    const R = 46;
    // 地面阴影
    this.drawShadow(ctx, R * 0.82, R + 16, 9);

    // 身体
    const g = ctx.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.2, 0, 0, R * 1.25);
    g.addColorStop(0, "#93c5fd");
    g.addColorStop(1, "#4f7df9");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, R, R * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(30,58,138,0.5)";
    ctx.stroke();

    this.drawFace(ctx, anim, now, R);
  }

  private drawFace(ctx: CanvasRenderingContext2D, anim: AnimName, now: number, R: number) {
    const eyeY = -R * 0.16;
    const eyeX = R * 0.4;
    const blink = anim === "idle" && now % 3600 < 150;

    if (anim === "error") {
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      for (const s of [-1, 1]) {
        const cx = s * eyeX;
        ctx.beginPath();
        ctx.moveTo(cx - 7, eyeY - 7);
        ctx.lineTo(cx + 7, eyeY + 7);
        ctx.moveTo(cx + 7, eyeY - 7);
        ctx.lineTo(cx - 7, eyeY + 7);
        ctx.stroke();
      }
    } else if (blink) {
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * eyeX - 8, eyeY);
        ctx.lineTo(s * eyeX + 8, eyeY);
        ctx.stroke();
      }
    } else {
      const lookX = anim === "thinking" ? 2.5 : 0;
      for (const s of [-1, 1]) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(s * eyeX, eyeY, 11, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1f2937";
        ctx.beginPath();
        ctx.arc(s * eyeX + s * lookX, eyeY + 2, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(s * eyeX + s * lookX - 2, eyeY, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 腮红
    ctx.fillStyle = "rgba(244,114,182,0.45)";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * R * 0.62, eyeY + 18, 8, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 嘴
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const my = eyeY + 30;
    ctx.beginPath();
    if (anim === "success" || anim === "idle") {
      ctx.arc(0, my - 4, 8, 0.15 * Math.PI, 0.85 * Math.PI); // 微笑
    } else if (anim === "error") {
      ctx.arc(0, my + 8, 8, 1.15 * Math.PI, 1.85 * Math.PI); // 难过
    } else {
      ctx.moveTo(-5, my);
      ctx.lineTo(5, my); // 平
    }
    ctx.stroke();

    // thinking 省略号
    if (anim === "thinking") {
      ctx.fillStyle = "#1f2937";
      const dots = 1 + (Math.floor(now / 400) % 3);
      for (let i = 0; i < dots; i++) {
        ctx.beginPath();
        ctx.arc(R * 0.78 + i * 10, -R * 0.72, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
