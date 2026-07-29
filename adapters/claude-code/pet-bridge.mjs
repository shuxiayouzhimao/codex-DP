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

import { mapHook } from "../lib/event-map.mjs";

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
  const mapped = mapHook(hookName, payload);
  if (!mapped) process.exit(0); // 不关心的事件，静默退出

  const ev = {
    source,
    sessionId: mapped.sessionId,
    event: "state-change",
    state: mapped.state,
    tool: mapped.tool,
    detail: mapped.detail,
    project: mapped.project,
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
    if (DEBUG) console.error(`[pet-bridge] ${source}:${hookName} → ${mapped.state} (${res.status})`);
  } catch (e) {
    if (DEBUG) console.error(`[pet-bridge] 推送失败（桌宠未运行？）: ${e.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
