import type { AgentState, AnimName } from "./types";

export interface StateMeta {
  anim: AnimName;
  label: string;
  priority: number; // 多会话聚合时取最高优先级
}

export const STATE_MAP: Record<AgentState, StateMeta> = {
  idle: { anim: "idle", label: "😴 闲置中", priority: 0 },
  thinking: { anim: "thinking", label: "🤔 思考中", priority: 2 },
  "tool-use": { anim: "tool-use", label: "🔧 执行工具", priority: 3 },
  "permission-prompt": { anim: "waiting", label: "✋ 等待审批", priority: 3 },
  "ask-user": { anim: "waiting", label: "💬 需要确认", priority: 3 },
  streaming: { anim: "streaming", label: "📝 输出中", priority: 2 },
  completed: { anim: "success", label: "✅ 完成", priority: 1 },
  "error-interrupted": { anim: "error", label: "❌ 出错了", priority: 3 },
};

export function metaOf(s: AgentState): StateMeta {
  return STATE_MAP[s] ?? STATE_MAP.idle;
}

/** 多会话聚合：取最高优先级状态（Phase 3+ 用） */
export function aggregate(states: AgentState[]): AgentState {
  if (states.length === 0) return "idle";
  let best: AgentState = "idle";
  let bp = -1;
  for (const s of states) {
    const m = metaOf(s);
    if (m.priority > bp) {
      bp = m.priority;
      best = s;
    }
  }
  return best;
}
