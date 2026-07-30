#!/usr/bin/env node
/** 断言 package.json / tauri.conf.json / Cargo.toml / package-lock 顶层版本一致 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function cargoVersion() {
  const toml = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Cargo.toml 未找到 version");
  return m[1];
}

const pkg = readJson("package.json").version;
const tauri = readJson("src-tauri/tauri.conf.json").version;
const cargo = cargoVersion();
const lock = readJson("package-lock.json").version;
const lockPkg = readJson("package-lock.json").packages?.[""]?.version;

const bad = [];
if (pkg !== tauri) bad.push(`package.json(${pkg}) ≠ tauri.conf(${tauri})`);
if (pkg !== cargo) bad.push(`package.json(${pkg}) ≠ Cargo.toml(${cargo})`);
if (pkg !== lock) bad.push(`package.json(${pkg}) ≠ package-lock.json(${lock})`);
if (lockPkg && pkg !== lockPkg) bad.push(`package.json(${pkg}) ≠ package-lock packages[""](${lockPkg})`);

if (bad.length) {
  console.error("版本不一致：\n- " + bad.join("\n- "));
  process.exit(1);
}
console.log(`版本一致：${pkg}`);
