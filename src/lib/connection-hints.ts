/** 连接可发现性：久无事件 / hooks 需补装（纯函数，便于单测） */

export const SILENCE_HINT_TEXT = "好像没接到 Agent · 点我打开连接设置";
export const NEEDS_UPDATE_HINT_TEXT = "连接需补装 · 点我打开设置";

export type ConnectionHintKind = "silence" | "needs-update";

export interface ConnectionHintInput {
  /** 总开关（默认开） */
  enabled: boolean;
  /** 无事件多久后提示（ms） */
  silenceMs: number;
  onboardingDone: boolean;
  /** 任一 Agent hooks 已安装 */
  anyInstalled: boolean;
  /** 启动自检：存在 needsUpdate */
  needsUpdate: boolean;
  displayIdle: boolean;
  /** 进程启动时刻 */
  startedAt: number;
  /** 最近一次收到事件；null=从未收到 */
  lastEventAt: number | null;
  now: number;
  /** 本轮静默提示是否已展示过（收到事件后清零） */
  silenceShown: boolean;
  /** 启动补装提示是否已展示过（或已点过） */
  bootHintShown: boolean;
}

export function evaluateConnectionHint(
  input: ConnectionHintInput,
): ConnectionHintKind | null {
  if (!input.enabled || !input.displayIdle) return null;

  if (input.needsUpdate && !input.bootHintShown) {
    return "needs-update";
  }

  if (input.silenceShown) return null;
  if (!input.onboardingDone && !input.anyInstalled) return null;

  const anchor = input.lastEventAt ?? input.startedAt;
  if (input.now - anchor < input.silenceMs) return null;
  return "silence";
}

export function connectionHintText(kind: ConnectionHintKind): string {
  return kind === "needs-update" ? NEEDS_UPDATE_HINT_TEXT : SILENCE_HINT_TEXT;
}
