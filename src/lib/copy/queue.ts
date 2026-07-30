import { openaiCopy } from "./openai";
import { rulesCopy } from "./rules";
import type { CopyProviderId, CopyRequest, CopyResult, CopySettings } from "./types";
import { DEFAULT_COPY_SETTINGS } from "./types";

const STATE_DEBOUNCE_MS = 800;
const GLOBAL_MIN_INTERVAL_MS = 1500;

export type CopyListener = (result: CopyResult | null) => void;
export type CopyErrorListener = (message: string | null) => void;

/**
 * 文案队列：状态变化时异步生成气泡句；generation 作废过期结果；
 * 失败/关闭时回调 null，由 UI 回退 detail/label。
 */
export class CopyQueue {
  private opts: CopySettings = { ...DEFAULT_COPY_SETTINGS };
  private generation = 0;
  private lastFireAt = 0;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private pending: CopyRequest | null = null;
  private listener: CopyListener | null = null;
  private errorListener: CopyErrorListener | null = null;
  private lastError: string | null = null;
  private busy = false;

  setListener(fn: CopyListener | null) {
    this.listener = fn;
  }

  setErrorListener(fn: CopyErrorListener | null) {
    this.errorListener = fn;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  setOptions(p: Partial<CopySettings>) {
    this.opts = { ...this.opts, ...p };
    if (!this.effectiveProvider()) {
      this.bump();
      this.listener?.(null);
    }
  }

  getOptions(): CopySettings {
    return { ...this.opts };
  }

  /** 状态/详情变化时调用；idle 清空 AI 文案 */
  onDisplay(req: CopyRequest) {
    if (req.state === "idle" || !this.effectiveProvider()) {
      this.bump();
      this.clearDebounce();
      this.pending = null;
      this.listener?.(null);
      return;
    }
    this.pending = req;
    this.clearDebounce();
    this.debounce = globalThis.setTimeout(() => {
      this.debounce = undefined;
      void this.flush();
    }, STATE_DEBOUNCE_MS);
  }

  /** 配置面板「试写」：立即跑一次，不走防抖；返回文案或抛错 */
  async tryWrite(req: CopyRequest): Promise<string> {
    const p = this.effectiveProvider();
    if (!p || p === "off") throw new Error("智能文案未开启");
    try {
      const text = await this.generate(req, p);
      if (!text) throw new Error("未生成文案（可换个状态试试）");
      this.setLastError(null);
      return text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setLastError(msg);
      throw e instanceof Error ? e : new Error(msg);
    }
  }

  destroy() {
    this.bump();
    this.clearDebounce();
    this.listener = null;
    this.errorListener = null;
  }

  private effectiveProvider(): CopyProviderId | null {
    if (!this.opts.copyEnabled) return null;
    if (this.opts.copyProvider === "off") return null;
    return this.opts.copyProvider;
  }

  private bump() {
    this.generation += 1;
  }

  private clearDebounce() {
    if (this.debounce !== undefined) {
      globalThis.clearTimeout(this.debounce);
      this.debounce = undefined;
    }
  }

  private setLastError(msg: string | null) {
    this.lastError = msg;
    this.errorListener?.(msg);
  }

  /** openai + 仅终态：工作态走规则 */
  private async generate(req: CopyRequest, provider: CopyProviderId): Promise<string> {
    if (provider === "rules") return rulesCopy(req);
    if (this.opts.copyAiTerminalOnly && req.kind !== "terminal") {
      return rulesCopy(req);
    }
    return openaiCopy(req);
  }

  private async flush() {
    if (this.busy || !this.pending) return;
    const now = Date.now();
    const wait = GLOBAL_MIN_INTERVAL_MS - (now - this.lastFireAt);
    if (wait > 0) {
      this.clearDebounce();
      this.debounce = globalThis.setTimeout(() => {
        this.debounce = undefined;
        void this.flush();
      }, wait);
      return;
    }

    const req = this.pending;
    this.pending = null;
    const gen = ++this.generation;
    const provider = this.effectiveProvider();
    if (!provider) {
      this.listener?.(null);
      return;
    }

    this.busy = true;
    this.lastFireAt = Date.now();
    try {
      const text = await this.generate(req, provider);
      if (gen !== this.generation) return; // 过期
      if (!text) {
        this.listener?.(null);
        return;
      }
      this.setLastError(null);
      this.listener?.({ text, generation: gen });
    } catch (e) {
      if (gen === this.generation) {
        const msg = e instanceof Error ? e.message : String(e);
        this.setLastError(msg);
        this.listener?.(null);
      }
    } finally {
      this.busy = false;
      // 防抖期间又来了新请求
      if (this.pending) void this.flush();
    }
  }
}

/** 供单测：根据 provider 同步解析（rules）或标记需异步 */
export function resolveProvider(opts: CopySettings): CopyProviderId | null {
  if (!opts.copyEnabled || opts.copyProvider === "off") return null;
  return opts.copyProvider;
}
