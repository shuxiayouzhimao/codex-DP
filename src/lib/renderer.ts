import type { AnimDef, AnimName } from "./types";
import { FramePlayer, type SheetMeta } from "./frame-player";
import { isWorkingChurn } from "./working-churn";
import { buildFrameSkins, buildSpriteUrls } from "./skins";
import animationsJson from "../assets/config/animations.json";

const ANIMATIONS = animationsJson as unknown as Record<AnimName, AnimDef>;

/** 可用皮肤（来自 skins.json + import.meta.glob） */
const SKIN_URLS: Record<string, string> = buildSpriteUrls();

/** 帧动画皮肤：皮肤 → 动画名 → 精灵表（tools/video_frames.py 产出）。
 *  当前动画有专属序列时直接播放（序列自带动作，跳过整体变换）；
 *  没有则回退 idle 序列 + animations.json 整体变换区分状态。 */
const FRAME_SKINS: Record<string, Partial<Record<AnimName, { sheet: string; meta: SheetMeta }>>> =
  buildFrameSkins();

/** 基准画布边长；精灵高 = size * 0.75 */
const BASE_SIZE = 200;
const SPRITE_RATIO = 0.75;

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
  private framePlayers = new Map<string, Partial<Record<AnimName, FramePlayer>>>();
  private skin = "green";
  /** 出场段播放中：先播完出场再切到 pendingAnim（如齿轮消退） */
  private outro: { player: FramePlayer; start: number } | null = null;
  private pendingAnim: AnimName | null = null;

  /** once 动画播完回到 next 时回调（便于 UI 同步状态文案） */
  onAnimEnd: ((next: AnimName) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, size = BASE_SIZE) {
    this.canvas = canvas;
    this.size = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.applyCanvasSize(size);
    ctx.imageSmoothingQuality = "high";
  }

  private spriteH(): number {
    return this.size * SPRITE_RATIO;
  }

  private applyCanvasSize(size: number) {
    const dpr = window.devicePixelRatio || 1;
    this.size = size;
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingQuality = "high";
    const h = this.spriteH();
    for (const players of this.framePlayers.values()) {
      for (const p of Object.values(players)) p?.setDisplayHeight(h);
    }
  }

  /** 逻辑边长变化（缩放档位）；同步 canvas 与帧高 */
  setSize(size: number) {
    if (size === this.size) return;
    this.applyCanvasSize(size);
  }

  getSize(): number {
    return this.size;
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
    const frameJobs = Object.entries(FRAME_SKINS).map(([name, anims]) => {
      const players: Partial<Record<AnimName, FramePlayer>> = {};
      const loads = Object.entries(anims).map(([anim, def]) => {
        if (!def) return Promise.resolve();
        const player = new FramePlayer(def.meta, def.sheet);
        return player.load().then((ok) => {
          if (ok) {
            player.setDisplayHeight(this.spriteH());
            players[anim as AnimName] = player;
          }
        });
      });
      // 至少有 idle 序列才认为该帧皮肤可用（回退路径依赖它）
      return Promise.all(loads).then(() => {
        if (players.idle) this.framePlayers.set(name, players);
      });
    });
    return Promise.all([...jobs, ...frameJobs]).then(() => undefined);
  }

  setSkin(name: string) {
    this.skin = name;
  }
  getSkin(): string {
    return this.skin;
  }

  setAnim(anim: AnimName) {
    // 出场播放中：同动画则取消出场（回到循环段），否则记下新目标等出场播完
    if (this.outro) {
      if (anim === this.anim) {
        this.outro = null;
        this.pendingAnim = null;
      } else {
        this.pendingAnim = anim;
      }
      return;
    }
    if (anim === this.anim) return;
    const prev = this.anim;
    const players = this.framePlayers.get(this.skin);
    // 出场段（如 tool-use 齿轮）仅在工作真正结束时播（切到非工作态）；
    // 工作态之间的高频交替跳过，避免特效反复消退
    const cur = players?.[prev];
    const workingChurn = isWorkingChurn(prev, anim);
    if (cur?.hasOutro() && !workingChurn) {
      this.outro = { player: cur, start: performance.now() };
      this.pendingAnim = anim;
      return;
    }
    this.anim = anim;
    this.animStart = performance.now();
    // 工作态内切入三段式序列：跳过入场直接进循环段
    if (workingChurn) {
      const next = players?.[anim];
      if (next) this.animStart -= next.introDurationMs();
    }
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
    // 当前动画有专属帧序列时，动作由序列自身承担，跳过整体参数变换
    const hasSeq = this.framePlayers.get(this.skin)?.[this.anim] != null;
    const effDef = hasSeq ? {} : def;
    const dur = (effDef.duration ?? 800) / 1000;
    const u = Math.min(t / dur, 1);

    let dx = 0;
    let dy = 0;
    let rot = 0;
    let sy = 1;
    const osc = (period: number) => Math.sin((t * 1000 * 2 * Math.PI) / period);

    if (effDef.bob) dy += osc(effDef.bob.period) * effDef.bob.amp;
    if (effDef.bounce)
      dy -= Math.abs(Math.sin((t * 1000 * Math.PI) / effDef.bounce.period)) * effDef.bounce.amp;
    if (effDef.tilt) rot += osc(effDef.tilt.period) * ((effDef.tilt.amp * Math.PI) / 180);
    if (effDef.breath) sy += osc(effDef.breath.period) * effDef.breath.sy;
    if (effDef.shake) dx += osc(effDef.shake.period) * effDef.shake.amp;
    if (effDef.jump) dy += -4 * u * (1 - u) * effDef.jump.h; // 抛物线：中点最高

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S / 2 + dx, S / 2 + 6 + dy);
    ctx.rotate(rot);
    ctx.scale(1, sy);
    this.drawCharacter(ctx, this.anim, now);
    ctx.restore();
  }

  /** 角色绘制：优先帧动画皮肤 → 静态精灵 → 程序化 blob。均以原点为中心。 */
  private drawCharacter(ctx: CanvasRenderingContext2D, anim: AnimName, now: number) {
    // 出场段：播完才切到 pendingAnim（期间 this.anim 仍是旧动画，整体变换保持关闭）
    if (this.outro) {
      const { player, start } = this.outro;
      const elapsed = now - start;
      if (elapsed >= player.outroDurationMs()) {
        this.outro = null;
        this.anim = this.pendingAnim ?? "idle";
        this.pendingAnim = null;
        this.animStart = now;
      } else {
        player.drawOutro(ctx, elapsed, this.shadowFn);
        return;
      }
    }
    // 帧皮肤：当前动画的专属序列，缺失时回退 idle 序列
    const players = this.framePlayers.get(this.skin);
    if (players) {
      const player = players[anim] ?? players.idle;
      if (player) {
        player.draw(ctx, now - this.animStart, this.shadowFn);
        return;
      }
    }
    const img = this.skins.get(this.skin);
    if (img) {
      const h = this.spriteH();
      const w = (h * img.naturalWidth) / img.naturalHeight;
      this.drawShadow(ctx, w * 0.36, h / 2 + 4, 8);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      return;
    }
    this.drawBlob(ctx, anim, now);
  }

  private shadowFn = (ctx: CanvasRenderingContext2D, rx: number, y: number, ry: number) =>
    this.drawShadow(ctx, rx, y, ry);

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
