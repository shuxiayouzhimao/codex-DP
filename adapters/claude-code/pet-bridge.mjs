#!/usr/bin/env node
// 多 Agent → 桌宠 统一桥接器（pet-bridge）。
// 支持 Claude Code / Codex CLI / Cursor：把各 agent 的 hook 事件映射为统一事件，POST 到桌宠 /event。
//
// 调用方式（各 agent 触发 hook 时新建进程调用本脚本）：
//   node pet-bridge.mjs [--source <claude-code|codex|cursor>] [<eventName>]
//   - 事件名：优先 stdin JSON 的 hook_event_name/hookEventName；否则用 argv 位置参数
//     （各安装器会把事件名作为最后一个参数传入，保证一定拿得到）。
//   - 来源：--source 或 PET_SOURCE 环境变量，默认 claude-code。
//   - stdin：agent 经 stdin 传事件 JSON（Claude Code / Codex / Cursor 均如此）。
//
// 设计约束：
//  - 永远 exit(0)，绝不输出阻塞信号（exit 2 会拦截工具，绝不能发生）。
//  - fire-and-forget：1s 超时；桌宠未运行则静默失败，不拖累 agent。
//  - PET_DEBUG=1 时把 argv+原始 stdin 追加到 ~/.codex-dp-hook-debug.jsonl（校准各 agent 真实载荷用）。

const PORT = process.env.PET_PORT ?? 4271;
const URL = `http://127.0.0.1:${PORT}/event`;
const DEBUG = !!process.env.PET_DEBUG;

// ---- 参数解析：--source <name> + 位置事件名 ----
const args = process.argv.slice(2);
let source = process.env.PET_SOURCE || "claude-code";
let eventArg = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--source" && args[i + 1]) source = args[++i];
  else if (!args[i].startsWith("--") && !eventArg) eventArg = args[i];
}

// ---- 防御式字段提取（各 agent 载荷字段名不同，且未经官方文档证实，宜宽松）----
const toolOf = (p) => p.tool_name ?? p.toolName ?? p.tool ?? p.name;
const msgOf = (p) => p.message ?? p.msg ?? p.prompt;
const sessionOf = (p) =>
  p.session_id ?? p.sessionId ?? p.conversation_id ?? p.conversationId ??
  p.thread_id ?? p.threadId ?? "default";
const cwdOf = (p) => {
  const c = p.cwd ?? p.workspace_root ?? p.workspaceRoot ??
    (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : undefined) ??
    p.project_root ?? p.projectRoot;
  return typeof c === "string" ? c : undefined;
};
const projectOf = (cwd) => {
  if (!cwd || typeof cwd !== "string") return undefined;
  const norm = cwd.replace(/[\\/]+$/, "");
  return norm.split(/[\\/]/).pop() || undefined;
};

// ---- 事件 → 状态 映射。兼容 PascalCase（Claude Code / Codex）与 camelCase（Cursor）两套命名 ----
const MAP = {
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
  // Cursor（camelCase）
  beforeSubmitPrompt: () => ({ state: "thinking", detail: "思考中" }),
  preCompact: () => ({ state: "thinking", detail: "压缩上下文" }),
  preToolUse: (p) => ({ state: "tool-use", tool: toolOf(p), detail: toolOf(p) ? `执行 ${toolOf(p)}` : "执行工具" }),
  postToolUse: (p) => ({ state: "thinking", tool: toolOf(p), detail: toolOf(p) ? `处理 ${toolOf(p)} 结果` : "处理结果" }),
  postToolUseFailure: (p) => ({ state: "error-interrupted", tool: toolOf(p), detail: toolOf(p) ? `${toolOf(p)} 失败` : "工具失败" }),
  afterAgentThought: () => ({ state: "thinking", detail: "思考中" }),
  subagentStart: () => ({ state: "tool-use", detail: "子任务执行中" }),
  subagentStop: () => ({ state: "completed", detail: "子任务完成" }),
  sessionStart: () => ({ state: "idle", detail: "会话开始" }),
  sessionEnd: () => ({ state: "idle", detail: "会话结束" }),
  stop: () => ({ state: "completed", detail: "完成" }),
};

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let payload = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    payload = {};
  }

  if (DEBUG) {
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      fs.appendFileSync(
        path.join(os.homedir(), ".codex-dp-hook-debug.jsonl"),
        JSON.stringify({ ts: Date.now(), source, argv: args, stdin: payload }) + "\n"
      );
    } catch { /* 调试日志失败不影响主流程 */ }
  }

  const hookName = payload.hook_event_name || payload.hookEventName || eventArg || "";
  const mapFn = MAP[hookName];
  if (!mapFn) process.exit(0); // 不关心的事件，静默退出

  const { state, tool, detail } = mapFn(payload);
  const ev = {
    source,
    sessionId: String(sessionOf(payload)),
    event: "state-change",
    state,
    tool,
    detail,
    project: projectOf(cwdOf(payload)),
    timestamp: Date.now(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: controller.signal,
    });
    if (DEBUG) console.error(`[pet-bridge] ${source}:${hookName} → ${state} (${res.status})`);
  } catch (e) {
    if (DEBUG) console.error(`[pet-bridge] 推送失败（桌宠未运行？）: ${e.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
