// 统一的 Agent 状态（适配器推送的 state 字段）
export type AgentState =
  | "idle"
  | "thinking"
  | "tool-use"
  | "permission-prompt"
  | "ask-user"
  | "streaming"
  | "completed"
  | "error-interrupted";

// 动画名（animations.json 的 key）。多个 Agent 状态可映射到同一动画。
export type AnimName =
  | "idle"
  | "thinking"
  | "tool-use"
  | "waiting"
  | "streaming"
  | "reading"
  | "success"
  | "error";

export interface Osc {
  amp: number; // 幅度（px，tilt 时为角度）
  period: number; // 周期（ms）
}

export interface AnimDef {
  bob?: Osc; // 垂直正弦浮动
  bounce?: Osc; // 垂直弹跳（绝对值，向上）
  tilt?: Osc; // 左右倾斜（amp=角度）
  breath?: { sy: number; period: number }; // 呼吸 scaleY
  shake?: Osc; // 水平高频抖动
  jump?: { h: number }; // 一次性跳跃（抛物线高度）
  once?: boolean; // 是否一次性播放
  duration?: number; // once 播放时长（ms）
  next?: AnimName; // once 播完切换到的动画
}
