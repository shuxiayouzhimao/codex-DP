#!/usr/bin/env node
// 安装 / 卸载 Cursor hooks，把 Cursor 事件桥接到桌宠。
//
// 用法：
//   node install-hooks.mjs              # 安装（幂等；先备份；顺带清掉 Vibe Pet 死 hooks）
//   node install-hooks.mjs --uninstall  # 卸载（只移除本桥接器）
//
// 机制（本机实证）：Cursor(1.7+)hooks 配置在 ~/.cursor/hooks.json，结构扁平：
//   { "hooks": { "<event>": [ { "command": "..." } ] }, "version": 1 }，
//   事件名 camelCase（sessionStart/beforeSubmitPrompt/preToolUse/postToolUse/.../stop）。
//   触发时新建进程执行 command，事件名作为最后参数传给 pet-bridge（载荷经 stdin）。

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(os.homedir(), ".cursor");
const HOOKS = path.join(DIR, "hooks.json");
const BACKUP = HOOKS + ".codex-pet.bak";
const BRIDGE = path.join(__dirname, "..", "claude-code", "pet-bridge.mjs").replace(/\\/g, "/");

// Cursor 官方 hooks（cursor.com/docs/agent/hooks）。无统一 PermissionRequest；
// streaming 无逐 token hook——afterAgentResponse 是整条回复完成，勿当输出中。
const EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "afterAgentThought",
  "afterAgentResponse",
  "afterFileEdit",
  "beforeShellExecution",
  "beforeMCPExecution",
  "stop",
];

const isOurs = (entry) =>
  typeof entry?.command === "string" && entry.command.includes("pet-bridge.mjs");
const isVibePet = (entry) =>
  typeof entry?.command === "string" &&
  (entry.command.includes("hook-runner.cmd") ||
    entry.command.includes("Vibe Pet") ||
    entry.command.includes("cursor-hook.js") ||
    entry.command.includes("codex-hook.js"));

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(HOOKS, "utf8"));
  } catch {
    return {};
  }
};

const uninstall = process.argv.includes("--uninstall");
const settings = load();
settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

// 先全量清掉 Vibe Pet 死 hooks（app 已卸载，这些指向不存在的 cursor-hook.js）
let purged = 0;
for (const ev of Object.keys(settings.hooks)) {
  const arr = settings.hooks[ev];
  if (Array.isArray(arr)) {
    const kept = arr.filter((e) => !isVibePet(e));
    purged += arr.length - kept.length;
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
}

if (!uninstall) {
  if (fs.existsSync(HOOKS)) fs.copyFileSync(HOOKS, BACKUP);
  for (const ev of EVENTS) {
    const arr = (settings.hooks[ev] = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : []);
    if (!arr.some(isOurs)) {
      arr.push({ command: `node "${BRIDGE}" --source cursor "${ev}"` });
    }
  }
  settings.version = settings.version ?? 1; // Cursor 要求 version 字段
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(HOOKS, JSON.stringify(settings, null, 2) + "\n", "utf8");
  JSON.parse(fs.readFileSync(HOOKS, "utf8")); // 校验

  console.log("✅ 已安装 Cursor hooks 到", HOOKS);
  console.log("   事件:", EVENTS.join(", "));
  console.log("   桥接:", BRIDGE, "(source=cursor)");
  if (purged) console.log(`   清理 Vibe Pet 死 hooks: ${purged} 条`);
  if (fs.existsSync(BACKUP)) console.log("   备份:", BACKUP);
  console.log("   卸载: node install-hooks.mjs --uninstall");
} else {
  for (const ev of EVENTS) {
    const arr = settings.hooks[ev];
    if (Array.isArray(arr)) {
      const kept = arr.filter((e) => !isOurs(e));
      if (kept.length) settings.hooks[ev] = kept;
      else delete settings.hooks[ev];
    }
  }
  fs.writeFileSync(HOOKS, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log("✅ 已卸载 Cursor pet-bridge hooks（其它配置未动）");
  if (purged) console.log(`   顺带清理 Vibe Pet 死 hooks: ${purged} 条`);
}
