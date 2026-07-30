import type { AnimName } from "./types";

/** 工作态动画：真实会话中 thinking ↔ tool-use 高频交替 */
export const WORKING_ANIMS: ReadonlySet<AnimName> = new Set([
  "thinking",
  "tool-use",
  "streaming",
  "reading",
]);

export function isWorkingChurn(prev: AnimName, next: AnimName): boolean {
  return WORKING_ANIMS.has(prev) && WORKING_ANIMS.has(next);
}

/**
 * 动画切换策略（纯函数，供单测）：
 * - 工作态之间：推迟到循环边界再切（只保留最新目标），跳过出场/入场
 * - 离开工作态且有 outro：先播出场
 * - 终态/等待等非工作态：立即切
 */
export function animTransitionFlags(
  prev: AnimName,
  next: AnimName,
  hasOutro: boolean,
): {
  workingChurn: boolean;
  deferToBoundary: boolean;
  playOutro: boolean;
  skipIntro: boolean;
} {
  const workingChurn = isWorkingChurn(prev, next);
  return {
    workingChurn,
    deferToBoundary: workingChurn && prev !== next,
    playOutro: hasOutro && !workingChurn,
    skipIntro: workingChurn,
  };
}

/** 无序列帧时的最短展示（ms），避免工作态瞬间连切 */
export const FALLBACK_DWELL_MS = 800;
