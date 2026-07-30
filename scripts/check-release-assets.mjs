#!/usr/bin/env node
/**
 * 校验 GitHub Release 是否含自动更新所需资产。
 * 用法：
 *   node scripts/check-release-assets.mjs [tag]
 *   无 tag 时用 GITHUB_REF_NAME / 当前 package.json version → vX.Y.Z
 *
 * 需要：gh CLI 已登录，或 CI 里 GITHUB_TOKEN。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveTag() {
  const raw = process.argv[2] || process.env.GITHUB_REF_NAME;
  if (raw && /^\d+\.\d+\.\d+/.test(raw.replace(/^v/, ""))) {
    return raw.startsWith("v") ? raw : `v${raw}`;
  }
  const ver = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  return `v${ver}`;
}

const tag = resolveTag();
const gh = spawnSync(
  "gh",
  ["release", "view", tag, "--json", "isDraft,isPrerelease,assets"],
  { encoding: "utf8", cwd: root },
);

if (gh.status !== 0) {
  console.error(`无法读取 release ${tag}:\n${gh.stderr || gh.stdout}`);
  process.exit(1);
}

const data = JSON.parse(gh.stdout);
const names = (data.assets || []).map((a) => a.name);
const lower = names.map((n) => n.toLowerCase());

const need = [
  {
    label: "NSIS 安装包 (.exe)",
    ok: lower.some((n) => n.endsWith(".exe") && !n.includes(".sig")),
  },
  {
    label: "签名 (.sig)",
    ok: lower.some((n) => n.endsWith(".sig")),
  },
  {
    label: "latest.json（updater）",
    ok: lower.some((n) => n === "latest.json"),
  },
];

const failed = need.filter((n) => !n.ok);
console.log(`Release ${tag}  assets=${names.length}  draft=${data.isDraft}`);
for (const n of names) console.log(`  - ${n}`);
for (const n of need) {
  console.log(`${n.ok ? "OK" : "MISSING"}  ${n.label}`);
}

if (failed.length) {
  console.error(
    `\n缺资产: ${failed.map((f) => f.label).join(", ")}。勿 --draft=false，先查 CI tauri-action。`,
  );
  process.exit(1);
}

if (data.isDraft) {
  console.log("\n仍为 draft：资产齐全后执行  gh release edit " + tag + " --draft=false");
} else {
  console.log("\n已正式发布。");
}
