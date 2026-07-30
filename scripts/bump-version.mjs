#!/usr/bin/env node
/**
 * 同步 bump 三处版本号 + package-lock 顶层：
 *   package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
 * 用法：node scripts/bump-version.mjs 0.3.0
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(ver)) {
  console.error("用法: node scripts/bump-version.mjs <semver>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeJson(rel, mut) {
  const p = path.join(root, rel);
  const obj = JSON.parse(fs.readFileSync(p, "utf8"));
  mut(obj);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

writeJson("package.json", (o) => {
  o.version = ver;
});
writeJson("src-tauri/tauri.conf.json", (o) => {
  o.version = ver;
});

const cargoPath = path.join(root, "src-tauri/Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf8");
cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${ver}"`);
fs.writeFileSync(cargoPath, cargo, "utf8");

// 刷新 package-lock 顶层版本（不改依赖树意图）
const lockPath = path.join(root, "package-lock.json");
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = ver;
  if (lock.packages?.[""]) lock.packages[""].version = ver;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

const chk = spawnSync(process.execPath, [path.join(root, "scripts/check-versions.mjs")], {
  stdio: "inherit",
});
if (chk.status !== 0) process.exit(chk.status ?? 1);
console.log(`已 bump 到 ${ver}`);
