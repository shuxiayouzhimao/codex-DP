/** Agent hooks 状态（Rust hooks_status） */
export interface SourceHookStatus {
  source: string;
  label: string;
  installed: boolean;
  configPath: string;
}

export interface HooksStatus {
  nodeOk: boolean;
  nodeVersion: string | null;
  adaptersOk: boolean;
  adaptersPath: string | null;
  sources: SourceHookStatus[];
}
