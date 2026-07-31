/** 与 Rust Settings 一致（camelCase）；主窗与配置窗共用 */
export interface AppSettings {
  skin: string;
  clickToDismiss: boolean;
  terminalHoldMs: number;
  workDecayMs: number;
  autostart: boolean;
  copyEnabled: boolean;
  /** "off" | "rules" | "openai" */
  copyProvider: string;
  copyBaseUrl: string;
  copyApiKey: string;
  copyModel: string;
  /** 首次引导是否已点过「知道了」 */
  onboardingDone: boolean;
  /** 0.75 | 1 | 1.4 */
  petScale: number;
  /** 终态时任务栏闪烁提醒 */
  terminalNotify: boolean;
  /** openai 模式下仅终态走 API */
  copyAiTerminalOnly: boolean;
  /** 连接提示：久无事件 / hooks 需补装（默认开） */
  connectionHints: boolean;
  /** 无事件多久后提示「好像没接到 Agent」（ms） */
  silenceHintMs: number;
}

/** 缩放档 → 角色画布逻辑边长（不含气泡/会话条留白） */
export function petLogicalSize(scale: number): number {
  if (Math.abs(scale - 0.75) < 0.05) return 150;
  if (Math.abs(scale - 1.4) < 0.05) return 280;
  return 200;
}

/** 与 Rust PET_CHROME_* 对齐：气泡两行 + 会话条不压角色 */
export const PET_CHROME_TOP = 44;
export const PET_CHROME_BOTTOM = 24;

/** 主窗逻辑尺寸（宽×高） */
export function petWindowLogicalSize(scale: number): { w: number; h: number } {
  const side = petLogicalSize(scale);
  return { w: side, h: side + PET_CHROME_TOP + PET_CHROME_BOTTOM };
}
