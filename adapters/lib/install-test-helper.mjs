/**
 * 共享：在临时 HOME/USERPROFILE 下跑 install-hooks，避免污染真实用户配置。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** @param {(home: string, env: NodeJS.ProcessEnv) => void} fn */
export function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pet-hooks-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  try {
    fn(home, env);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * @param {string} scriptPath
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function runInstall(scriptPath, args, env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    env,
    encoding: "utf8",
  });
}

/** @param {unknown} obj */
export function countPetBridge(obj) {
  const s = JSON.stringify(obj);
  return (s.match(/pet-bridge\.mjs/g) || []).length;
}
