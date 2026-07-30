// 各 Agent hook 事件 → 统一桌宠状态 的映射与字段提取。
// pet-bridge.mjs 与测试共用；保持零依赖，可被 Node 直接 import。

/** @param {Record<string, unknown>} p */
export const toolOf = (p) => p.tool_name ?? p.toolName ?? p.tool ?? p.name;

/** @param {Record<string, unknown>} p */
export const msgOf = (p) => p.message ?? p.msg ?? p.prompt;

/** @param {Record<string, unknown>} p */
export const sessionOf = (p) =>
  p.session_id ?? p.sessionId ?? p.conversation_id ?? p.conversationId ??
  p.thread_id ?? p.threadId ?? "default";

/** @param {Record<string, unknown>} p */
export const cwdOf = (p) => {
  const c = p.cwd ?? p.workspace_root ?? p.workspaceRoot ??
    (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : undefined) ??
    p.project_root ?? p.projectRoot;
  return typeof c === "string" ? c : undefined;
};

/** @param {string | undefined} cwd */
export const projectOf = (cwd) => {
  if (!cwd || typeof cwd !== "string") return undefined;
  const norm = cwd.replace(/[\\/]+$/, "");
  return norm.split(/[\\/]/).pop() || undefined;
};

/**
 * 事件名 → 状态映射。兼容 PascalCase（Claude Code / Codex）与 camelCase（Cursor）。
 * 每个值是 (payload) => { state, tool?, detail? }
 */
export const MAP = {
  // Claude Code / Codex（PascalCase）
  UserPromptSubmit: () => ({ state: "thinking", detail: "思考中" }),
  PreCompact: () => ({ state: "thinking", detail: "压缩上下文" }),
  PreToolUse: (p) => ({ state: "tool-use", tool: toolOf(p), detail: toolOf(p) ? `执行 ${toolOf(p)}` : "执行工具" }),
  PostToolUse: (p) => ({ state: "thinking", tool: toolOf(p), detail: toolOf(p) ? `处理 ${toolOf(p)} 结果` : "处理结果" }),
  PostToolBatch: () => ({ state: "tool-use", detail: "批量执行工具" }),
  PostToolUseFailure: (p) => ({ state: "error-interrupted", tool: toolOf(p), detail: toolOf(p) ? `${toolOf(p)} 失败` : "工具失败" }),
  PermissionRequest: (p) => ({ state: "permission-prompt", tool: toolOf(p), detail: toolOf(p) ? `等待审批 ${toolOf(p)}` : "等待审批" }),
  Elicitation: (p) => ({ state: "ask-user", detail: msgOf(p) || "需要你回答" }),
  Notification: (p) => ({ state: "permission-prompt", detail: msgOf(p) || "需要你的确认" }),
  Stop: () => ({ state: "completed", detail: "完成" }),
  StopFailure: () => ({ state: "error-interrupted", detail: "出错中断" }),
  SubagentStart: () => ({ state: "tool-use", detail: "子任务执行中" }),
  SubagentStop: () => ({ state: "completed", detail: "子任务完成" }),
  SessionStart: () => ({ state: "idle", detail: "会话开始" }),
  SessionEnd: () => ({ state: "idle", detail: "会话结束" }),
  // Codex 官方另有 PostCompact（Claude 无对等项时仍可安全映射）
  PostCompact: () => ({ state: "thinking", detail: "压缩完成" }),
  // Cursor（camelCase）
  beforeSubmitPrompt: () => ({ state: "thinking", detail: "思考中" }),
  preCompact: () => ({ state: "thinking", detail: "压缩上下文" }),
  preToolUse: (p) => {
    const tool = toolOf(p);
    const t = String(tool || "").toLowerCase();
    // Cursor：Shell/MCP 常在「点 Run」门闩前触发；先标等待审批（beforeShell/MCP 同理）
    if (t === "shell" || t === "bash" || t.startsWith("mcp")) {
      return {
        state: "permission-prompt",
        tool,
        detail: tool ? `等待确认 ${tool}` : "等待确认",
      };
    }
    return {
      state: "tool-use",
      tool,
      detail: tool ? `执行 ${tool}` : "执行工具",
    };
  },
  postToolUse: (p) => ({ state: "thinking", tool: toolOf(p), detail: toolOf(p) ? `处理 ${toolOf(p)} 结果` : "处理结果" }),
  postToolUseFailure: (p) => ({ state: "error-interrupted", tool: toolOf(p), detail: toolOf(p) ? `${toolOf(p)} 失败` : "工具失败" }),
  afterAgentThought: () => ({ state: "thinking", detail: "思考中" }),
  // 整条 assistant 消息完成——不是 token 流；当作完成（stop 有时不来，否则会卡在工作态）
  afterAgentResponse: () => ({ state: "completed", detail: "完成" }),
  afterFileEdit: (p) => ({ state: "tool-use", tool: toolOf(p) || "Edit", detail: "改完文件" }),
  // 点 Run / 审批门闩：桌宠只能观察，不能代点批准
  beforeShellExecution: (p) => {
    const cmd = typeof p.command === "string" ? p.command.trim() : "";
    const short = cmd.length > 24 ? cmd.slice(0, 23) + "…" : cmd;
    return {
      state: "permission-prompt",
      tool: toolOf(p) || "Shell",
      detail: short ? `等待确认：${short}` : "等待确认命令",
    };
  },
  afterShellExecution: (p) => ({
    state: "thinking",
    tool: toolOf(p) || "Shell",
    detail: "命令已执行",
  }),
  beforeMCPExecution: (p) => ({
    state: "permission-prompt",
    tool: toolOf(p) || "MCP",
    detail: "等待确认 MCP",
  }),
  afterMCPExecution: (p) => ({
    state: "thinking",
    tool: toolOf(p) || "MCP",
    detail: "MCP 已执行",
  }),
  subagentStart: () => ({ state: "tool-use", detail: "子任务执行中" }),
  subagentStop: () => ({ state: "completed", detail: "子任务完成" }),
  sessionStart: () => ({ state: "idle", detail: "会话开始" }),
  sessionEnd: () => ({ state: "idle", detail: "会话结束" }),
  stop: () => ({ state: "completed", detail: "完成" }),
};

/**
 * 由 hook 名 + payload 生成统一事件字段（不含 source/timestamp，由 bridge 注入）。
 * @param {string} hookName
 * @param {Record<string, unknown>} payload
 * @returns {{ state: string, tool?: string, detail?: string, sessionId: string, project?: string } | null}
 */
export function mapHook(hookName, payload = {}) {
  const mapFn = MAP[hookName];
  if (!mapFn) return null;
  const { state, tool, detail } = mapFn(payload);
  return {
    state,
    tool,
    detail,
    sessionId: String(sessionOf(payload)),
    project: projectOf(cwdOf(payload)),
  };
}
