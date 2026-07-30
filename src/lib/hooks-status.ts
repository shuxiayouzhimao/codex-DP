/** Agent hooks 状态（Rust hooks_status） */
export interface SourceHookStatus {
  source: string;
  label: string;
  installed: boolean;
  /** 已装但缺关键事件，需再点安装 */
  needsUpdate: boolean;
  missingHint?: string | null;
  configPath: string;
}

export interface HooksStatus {
  nodeOk: boolean;
  nodeVersion: string | null;
  adaptersOk: boolean;
  adaptersPath: string | null;
  sources: SourceHookStatus[];
}
