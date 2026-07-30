import type { AnimName } from "./types";

/** 工作态动画：真实会话中 thinking ↔ tool-use 高频交替 */
export const WORKING_ANIMS: ReadonlySet<AnimName> = new Set([
  "thinking",
  "tool-use",
  "streaming",
]);

export function isWorkingChurn(prev: AnimName, next: AnimName): boolean {
  return WORKING_ANIMS.has(prev) && WORKING_ANIMS.has(next);
}

/**
 * 动画切换策略（纯函数，供单测）：
 * - 工作态之间：跳过出场（不播齿轮消退），切入时跳过入场
 * - 离开工作态且有 outro：先播出场
 */
export function animTransitionFlags(
  prev: AnimName,
  next: AnimName,
  hasOutro: boolean,
): { workingChurn: boolean; playOutro: boolean; skipIntro: boolean } {
  const workingChurn = isWorkingChurn(prev, next);
  return {
    workingChurn,
    playOutro: hasOutro && !workingChurn,
    skipIntro: workingChurn,
  };
}
