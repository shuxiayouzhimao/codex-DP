#!/usr/bin/env node
// 安装 / 卸载 Codex CLI hooks，把 Codex 事件桥接到桌宠。
//
// 用法：
//   node install-hooks.mjs              # 安装（幂等；先备份；顺带清掉 Vibe Pet 死 hooks）
//   node install-hooks.mjs --uninstall  # 卸载（只移除本桥接器）
//
// 机制（本机实证）：Codex 支持 Claude Code 风格 hooks——
//   ~/.codex/config.toml 需 [features] hooks = true；
//   ~/.codex/hooks.json 结构 { "hooks": { "<Event>": [ { "hooks": [ {type,command,timeout} ] } ] } }，
//   事件名为 PascalCase（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/Stop）。
//   触发时新建进程执行 command，事件名我们作为最后参数传给 pet-bridge（载荷经 stdin）。

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(os.homedir(), ".codex");
const HOOKS = path.join(DIR, "hooks.json");
const CONFIG = path.join(DIR, "config.toml");
const BACKUP = HOOKS + ".codex-pet.bak";
const BRIDGE = path.join(__dirname, "..", "claude-code", "pet-bridge.mjs").replace(/\\/g, "/");

// Codex 官方 hooks（developers.openai.com/codex/hooks）；与 Claude 同构 PascalCase。
// PostToolUseFailure / StopFailure / Elicitation 等官方未列，MAP 仍保留以防真机出现，但不默认安装。
const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];

const isOurs = (group) =>
  Array.isArray(group?.hooks) &&
  group.hooks.some((h) => typeof h?.command === "string" && h.command.includes("pet-bridge.mjs"));
const isVibePet = (group) =>
  Array.isArray(group?.hooks) &&
  group.hooks.some(
    (h) =>
      typeof h?.command === "string" &&
      (h.command.includes("hook-runner.cmd") ||
        h.command.includes("Vibe Pet") ||
        h.command.includes("codex-hook.js") ||
        h.command.includes("cursor-hook.js"))
  );

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(HOOKS, "utf8"));
  } catch {
    return {};
  }
};

/** 确保 config.toml 开启 [features] hooks = true */
function ensureFeatureEnabled() {
  let toml = "";
  try {
    toml = fs.readFileSync(CONFIG, "utf8");
  } catch {
    toml = "";
  }
  if (/\[features\][^[]]*\bhooks\s*=\s*true/s.test(toml)) return false;
  const add = `\n[features]\nhooks = true\n`;
  fs.writeFileSync(CONFIG, toml.replace(/\s*$/, "") + add, "utf8");
  return true;
}

const uninstall = process.argv.includes("--uninstall");
const settings = load();
settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

// 先全量清掉 Vibe Pet 死 hooks（app 已卸载，这些指向不存在的 codex-hook.js）
let purged = 0;
for (const ev of Object.keys(settings.hooks)) {
  const arr = settings.hooks[ev];
  if (Array.isArray(arr)) {
    const kept = arr.filter((g) => !isVibePet(g));
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
      arr.push({
        hooks: [
          {
            type: "command",
            command: `node "${BRIDGE}" --source codex "${ev}"`,
            timeout: 30,
          },
        ],
      });
    }
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(HOOKS, JSON.stringify(settings, null, 2) + "\n", "utf8");
  JSON.parse(fs.readFileSync(HOOKS, "utf8")); // 校验

  const featAdded = ensureFeatureEnabled();
  console.log("✅ 已安装 Codex hooks 到", HOOKS);
  console.log("   事件:", EVENTS.join(", "));
  console.log("   桥接:", BRIDGE, "(source=codex)");
  if (purged) console.log(`   清理 Vibe Pet 死 hooks: ${purged} 条`);
  console.log("   [features] hooks=true:", featAdded ? "已写入 config.toml" : "已存在（无需改）");
  if (fs.existsSync(BACKUP)) console.log("   备份:", BACKUP);
  console.log("   卸载: node install-hooks.mjs --uninstall");
} else {
  for (const ev of EVENTS) {
    const arr = settings.hooks[ev];
    if (Array.isArray(arr)) {
      const kept = arr.filter((g) => !isOurs(g));
      if (kept.length) settings.hooks[ev] = kept;
      else delete settings.hooks[ev];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    try { fs.unlinkSync(HOOKS); } catch { /* 已无文件 */ }
    console.log("✅ 已卸载 Codex pet-bridge hooks（hooks.json 已清空并删除）");
  } else {
    fs.writeFileSync(HOOKS, JSON.stringify(settings, null, 2) + "\n", "utf8");
    console.log("✅ 已卸载 Codex pet-bridge hooks（其它配置未动）");
  }
  if (purged) console.log(`   顺带清理 Vibe Pet 死 hooks: ${purged} 条`);
}
