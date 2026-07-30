import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "pet-bridge.mjs");

/**
 * @param {object} opts
 * @param {string} [opts.stdin]
 * @param {string[]} [opts.args]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function runBridge({ stdin = "{}", args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      resolve({ code, ms: Date.now() - t0, stderr });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("pet-bridge 零阻塞契约", () => {
  it("桌宠不可达时仍 exit(0) 且约 1s 内返回", async () => {
    // 端口 1 通常拒绝连接或很快失败；abort 上限 1s
    const r = await runBridge({
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        session_id: "test-sess",
        cwd: "/tmp/proj",
      }),
      args: ["--source", "claude-code", "PreToolUse"],
      env: { PET_PORT: "1", PET_DEBUG: "" },
    });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 1500, `耗时过长: ${r.ms}ms`);
  });

  it("未知 hook 静默 exit(0)", async () => {
    const r = await runBridge({
      stdin: JSON.stringify({ hook_event_name: "TotallyUnknown" }),
      args: ["TotallyUnknown"],
      env: { PET_PORT: "1" },
    });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 500);
  });

  it("坏 JSON stdin 仍 exit(0)", async () => {
    const r = await runBridge({
      stdin: "not-json{{{",
      args: ["PreToolUse"],
      env: { PET_PORT: "1" },
    });
    assert.equal(r.code, 0);
  });
});
