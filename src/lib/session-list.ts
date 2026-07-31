export interface SessionListEntry {
  key: string;
  label: string;
  /** sessionId 前缀，便于同项目多对话辨认 */
  shortId?: string;
  state: string;
  project?: string | null;
}
