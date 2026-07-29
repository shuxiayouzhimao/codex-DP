import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentState } from "./types";

/** Rust 端 emit 的 agent-event 负载（与 AgentEvent 对齐） */
export interface AgentEventPayload {
  source: string;
  sessionId?: string;
  event?: string;
  state: AgentState;
  tool?: string;
  detail?: string;
  /** 项目文件夹名（适配器从 cwd 提取），用于会话列表区分"哪个对话" */
  project?: string;
  timestamp?: number;
}

/**
 * 订阅后端 agent-event，把每个原始事件交给回调。
 * 会话跟踪 / 聚合 / 保持与衰减计时 / 过滤由 PetState 负责（见 petState.ts）。
 */
export async function startEventBridge(
  onEvent: (ev: AgentEventPayload) => void
): Promise<UnlistenFn> {
  return listen<AgentEventPayload>("agent-event", (e) => {
    if (e.payload?.state) onEvent(e.payload);
  });
}

/**
 * 订阅托盘"监听会话"选择。payload 为会话键（"source:sessionId"）或 null（监听全部）。
 */
export async function listenSessionFilter(
  onFilter: (key: string | null) => void
): Promise<UnlistenFn> {
  return listen<string | null>("session-filter", (e) => onFilter(e.payload ?? null));
}
