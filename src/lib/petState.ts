import { aggregate } from "./state-machine";
import type { AgentState } from "./types";
import type { AgentEventPayload } from "./events";

/** 终态：完成/出错。保持到用户点击桌宠确认（或新事件打断），有长兜底 */
const TERMINAL = new Set<AgentState>(["completed", "error-interrupted"]);
/** 等待用户：审批/确认。用户操作会引发新事件，期间不衰减（否则会错过“它在等你”） */
const WAIT_USER = new Set<AgentState>(["permission-prompt", "ask-user"]);

/** 等待用户态的兜底（正常会被用户操作引发的事件打断） */
const WAIT_FALLBACK_MS = 30 * 60_000;
/** clickToDismiss=false 时，终态自动回闲置的时长 */
const TERMINAL_AUTO_MS = 5000;
/** 会话过期（旧会话不再参与聚合，避免污染） */
const SESSION_TTL = 90000;

/** 可由配置面板调整的选项（对应后端 Settings 的 camelCase 字段） */
export interface PetOptions {
  /** true=终态保持到点击确认；false=终态 ~5s 自动回闲置 */
  clickToDismiss: boolean;
  /** 终态兜底时长（clickToDismiss=true 时生效） */
  terminalHoldMs: number;
  /** 工作态无事件的安全网衰减 */
  workDecayMs: number;
}

const DEFAULT_OPTIONS: PetOptions = {
  clickToDismiss: true,
  terminalHoldMs: 30 * 60_000,
  workDecayMs: 5 * 60_000,
};

export interface SessionMeta {
  /** 当前活跃会话数（TTL 内、且通过过滤） */
  count: number;
  /** 活跃会话的来源列表（如 ["claude-code"]） */
  sources: string[];
  /** 最近事件的会话 key（"source:sessionId"），用于显示"在听谁" */
  lastKey: string;
  /** lastKey 对应会话的项目名（若有），让"哪个对话"更可读 */
  lastProject?: string;
  /** 是否处于"单会话过滤"模式（true=只看某一个对话） */
  filtered: boolean;
}

/**
 * 前端状态管理：把事件流转换为"当前该显示什么状态"。
 * 持久化策略（核心，决定用户能否看清状态）：
 * - 工作态 thinking/tool-use/streaming：靠事件推进，5min 无事件才兜底回闲置（防卡死）。
 * - 等待态 permission-prompt/ask-user：不衰减，直到用户操作引发新事件（30min 兜底）。
 * - 终态 completed/error-interrupted：保持到用户点击桌宠确认（dismissTerminal）或新事件（30min 兜底）。
 * - 任何新事件都会打断上述计时并立即切换。
 * 另：多会话按优先级聚合、会话 90s 过期、setFilter 可锁定单会话。
 */
export class PetState {
  private sessions = new Map<string, { state: AgentState; ts: number }>();
  /** 会话 key → 项目名（用于标签展示，不随 toIdle 清除，便于过滤时空闲也能认出目标） */
  private projects = new Map<string, string>();
  private lastKey = "";
  /** null=监听全部；否则只显示该会话 */
  private filter: string | null = null;
  /** 当前显示状态（供点击判断是否处于可消散的终态） */
  private current: AgentState = "idle";
  private timer: number | undefined;
  private opts: PetOptions = { ...DEFAULT_OPTIONS };

  constructor(
    private onChange: (s: AgentState, detail: string, meta: SessionMeta) => void
  ) {}

  /** 应用配置面板/设置后端的选项；当前显示中的状态按新配置重排计时。 */
  setOptions(p: Partial<PetOptions>) {
    this.opts = { ...this.opts, ...p };
    this.clearTimer();
    const ms = this.timeoutFor(this.current);
    if (ms > 0) this.timer = window.setTimeout(() => this.toIdle(), ms);
  }

  handleEvent(ev: AgentEventPayload) {
    const key = `${ev.source}:${ev.sessionId ?? ""}`;
    if (ev.project) this.projects.set(key, ev.project);
    // 单会话过滤：非目标会话的事件不参与显示（但项目名已记录，供列表/标签）
    if (this.filter !== null && key !== this.filter) return;
    this.lastKey = key;
    this.sessions.set(key, { state: ev.state, ts: Date.now() });
    this.recompute(ev.detail ?? "");
  }

  /** 锁定监听某个会话（key），或传 null 恢复监听全部。来自托盘"监听会话"菜单。 */
  setFilter(key: string | null) {
    this.filter = key;
    this.lastKey = key ?? "";
    // 切换过滤时清空当前会话视图，避免残留显示之前会话的状态
    this.sessions.clear();
    this.recompute("");
  }

  /** 用户点击桌宠：确认/消散“完成/出错”终态 → 回闲置（其它状态点击不影响）。 */
  dismissTerminal() {
    if (TERMINAL.has(this.current)) this.toIdle();
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now - v.ts > SESSION_TTL) this.sessions.delete(k);
    }
  }

  private meta(): SessionMeta {
    const sources = new Set<string>();
    for (const k of this.sessions.keys()) sources.add(k.split(":")[0]);
    return {
      count: this.sessions.size,
      sources: [...sources],
      lastKey: this.lastKey,
      lastProject: this.projects.get(this.lastKey),
      filtered: this.filter !== null,
    };
  }

  private recompute(detail: string) {
    this.prune();
    const states = [...this.sessions.values()].map((v) => v.state);
    this.setDisplay(aggregate(states), detail);
  }

  private setDisplay(s: AgentState, detail: string) {
    this.clearTimer();
    this.current = s;
    this.onChange(s, detail, this.meta());

    const ms = this.timeoutFor(s);
    if (ms > 0) this.timer = window.setTimeout(() => this.toIdle(), ms);
  }

  /** 各状态分类的计时（毫秒）：0 = 不计时（idle）。 */
  private timeoutFor(s: AgentState): number {
    if (TERMINAL.has(s)) {
      return this.opts.clickToDismiss ? this.opts.terminalHoldMs : TERMINAL_AUTO_MS;
    }
    if (WAIT_USER.has(s)) return WAIT_FALLBACK_MS;
    if (s !== "idle") return this.opts.workDecayMs;
    return 0;
  }

  private toIdle() {
    this.clearTimer();
    this.sessions.clear();
    this.current = "idle";
    this.onChange("idle", "", this.meta());
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
