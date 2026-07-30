import type { AgentState } from "../types";

/** 文案 Provider：off=关闭；rules=本地模板；openai=OpenAI 兼容 API */
export type CopyProviderId = "off" | "rules" | "openai";

export interface CopySettings {
  copyEnabled: boolean;
  copyProvider: CopyProviderId;
  copyBaseUrl: string;
  copyApiKey: string;
  /** Chat Completions 的 model 字段；空则用默认 */
  copyModel: string;
  /** openai 模式下仅终态走 API，工作态仍用规则模板 */
  copyAiTerminalOnly: boolean;
}

export const DEFAULT_COPY_SETTINGS: CopySettings = {
  copyEnabled: false,
  copyProvider: "rules",
  copyBaseUrl: "",
  copyApiKey: "",
  copyModel: "",
  copyAiTerminalOnly: false,
};

/** 事件环里的一条快照（供终态摘要） */
export interface EventSnap {
  state: AgentState;
  tool?: string;
  detail?: string;
  project?: string;
  ts: number;
}

export interface CopyRequest {
  state: AgentState;
  tool?: string;
  detail?: string;
  project?: string;
  /** 本轮轨迹（终态摘要用） */
  trajectory: EventSnap[];
  kind: "work" | "terminal";
}

export interface CopyResult {
  text: string;
  /** 产生此结果时的 generation；回调方比对后决定是否采用 */
  generation: number;
}
