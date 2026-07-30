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

/**
 * 等待/终态期间可忽略的「空转思考」噪声（Cursor afterAgentThought 等）。
 * 有 tool，或 detail 像「命令执行中 / 处理结果」时放行，避免审批动画卡死。
 */
function isIdleThinkingNoise(ev: AgentEventPayload): boolean {
  if (ev.state !== "thinking" && ev.state !== "streaming") return false;
  if (ev.tool) return false;
  const d = (ev.detail ?? "").trim();
  return (
    d === "" ||
    d === "思考中" ||
    d === "压缩上下文" ||
    d === "压缩完成" ||
    d === "整理回复"
  );
}

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
 * - 等待/终态期间忽略空转 thinking，但放行 tool-use / 带工具的后续态。
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
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opts: PetOptions = { ...DEFAULT_OPTIONS };
  /** 等待/终态时保留 detail，避免被 thinking 冲掉后气泡变空 */
  private lastWaitDetail = "";

  constructor(
    private onChange: (s: AgentState, detail: string, meta: SessionMeta) => void
  ) {}

  /** 应用配置面板/设置后端的选项；当前显示中的状态按新配置重排计时。 */
  setOptions(p: Partial<PetOptions>) {
    this.opts = { ...this.opts, ...p };
    this.clearTimer();
    const ms = this.timeoutFor(this.current);
    if (ms > 0) this.timer = globalThis.setTimeout(() => this.toIdle(), ms);
  }

  /**
   * 是否会采纳该事件参与显示（过滤检查）。
   * 顺带记录 project，便于标签；与 handleEvent 的过滤条件一致。
   */
  willHandle(ev: AgentEventPayload): boolean {
    const key = `${ev.source}:${ev.sessionId ?? ""}`;
    if (ev.project) this.projects.set(key, ev.project);
    return this.filter === null || key === this.filter;
  }

  handleEvent(ev: AgentEventPayload): boolean {
    if (!this.willHandle(ev)) return false;
    const key = `${ev.source}:${ev.sessionId ?? ""}`;
    this.lastKey = key;

    const prev = this.sessions.get(key);
    // 等待审批：只挡住空转 thinking（如 afterAgentThought），
    // 放行「命令已执行 / 处理结果」等真正离开门闩的事件
    if (prev && WAIT_USER.has(prev.state) && isIdleThinkingNoise(ev)) {
      this.sessions.set(key, { state: prev.state, ts: Date.now() });
      this.recompute(this.lastWaitDetail || "");
      return true;
    }
    // 终态：同样只挡空转思考，避免盖住完成气泡
    if (prev && TERMINAL.has(prev.state) && isIdleThinkingNoise(ev)) {
      this.sessions.set(key, { state: prev.state, ts: Date.now() });
      this.recompute(this.lastWaitDetail || "");
      return true;
    }

    if (WAIT_USER.has(ev.state) || TERMINAL.has(ev.state)) {
      this.lastWaitDetail = ev.detail ?? "";
    } else if (ev.state !== "thinking" && ev.state !== "streaming") {
      this.lastWaitDetail = "";
    }
    this.sessions.set(key, { state: ev.state, ts: Date.now() });
    this.recompute(ev.detail ?? "");
    return true;
  }

  /** 锁定监听某个会话（key），或传 null 恢复监听全部。来自托盘"监听会话"菜单。 */
  setFilter(key: string | null) {
    this.filter = key;
    this.lastKey = key ?? "";
    if (key === null) {
      // 恢复全部：保留已有会话视图，只重算聚合
      this.recompute("");
      return;
    }
    // 锁定单会话：尽量保留该会话最近状态，避免闪 idle
    const kept = this.sessions.get(key);
    this.sessions.clear();
    if (kept) this.sessions.set(key, { ...kept, ts: Date.now() });
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
    if (ms > 0) this.timer = globalThis.setTimeout(() => this.toIdle(), ms);
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
    // 过滤模式：只清当前锁定会话，避免「全家回闲置」
    if (this.filter !== null) {
      this.sessions.delete(this.filter);
    } else {
      this.sessions.clear();
    }
    this.lastWaitDetail = "";
    this.current = "idle";
    this.onChange("idle", "", this.meta());
  }

  private clearTimer() {
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
