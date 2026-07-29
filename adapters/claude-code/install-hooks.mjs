#!/usr/bin/env node
// 安装 / 卸载 Claude Code hooks，把 Claude Code 事件桥接到桌宠。
//
// 用法：
//   node install-hooks.mjs              # 安装（幂等；先备份 settings.json）
//   node install-hooks.mjs --uninstall  # 卸载（只移除本项目的 hook，不动其它配置）
//
// 只改 ~/.claude/settings.json 的 hooks 字段中与本桥接器相关的条目，其它配置原样保留。

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const BACKUP = SETTINGS + ".codex-pet.bak";
const BRIDGE = path.join(__dirname, "pet-bridge.mjs").replace(/\\/g, "/");
const CMD = `node "${BRIDGE}"`;

const EVENTS = [
  "UserPromptSubmit",
  "PreCompact",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "PermissionRequest",
  "Elicitation",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
];

const isOurs = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes("pet-bridge.mjs"));

function load() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
}
function save(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

const uninstall = process.argv.includes("--uninstall");
const settings = load();
settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

if (!uninstall) {
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, BACKUP);
  for (const ev of EVENTS) {
    const arr = (settings.hooks[ev] = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : []);
    if (!arr.some(isOurs)) arr.push({ hooks: [{ type: "command", command: CMD }] });
  }
  save(settings);
  // 校验写出的 JSON 可被解析
  JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  console.log("✅ 已安装 hooks 到", SETTINGS);
  console.log("   事件:", EVENTS.join(", "));
  console.log("   命令:", CMD);
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
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  save(settings);
  console.log("✅ 已卸载 pet-bridge hooks（其它配置未动）");
}
