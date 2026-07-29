#!/usr/bin/env node
// 移除 Vibe Pet 的 hooks（保留 codex-DP 的 pet-bridge 与 codegraph 等其它配置）。
// 识别特征：command 含 "hook-runner.cmd" 或 "Vibe Pet"。先备份再改。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const BACKUP = SETTINGS + ".vibepet-removal.bak";

const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
fs.copyFileSync(SETTINGS, BACKUP);

const isVibePet = (e) =>
  Array.isArray(e?.hooks) &&
  e.hooks.some(
    (h) =>
      typeof h?.command === "string" &&
      (h.command.includes("hook-runner.cmd") || h.command.includes("Vibe Pet"))
  );

let removed = 0;
for (const ev of Object.keys(settings.hooks || {})) {
  const arr = settings.hooks[ev];
  if (Array.isArray(arr)) {
    const kept = arr.filter((e) => !isVibePet(e));
    removed += arr.length - kept.length;
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");
JSON.parse(fs.readFileSync(SETTINGS, "utf8")); // 校验
console.log(`✅ 已移除 Vibe Pet hook 条目 ${removed} 个`);
console.log(`   备份: ${BACKUP}`);
console.log(`   （pet-bridge 与其它配置未动）`);
