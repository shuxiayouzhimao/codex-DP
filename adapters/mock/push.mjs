#!/usr/bin/env node
// mock-adapter：向桌宠推送统一事件（零依赖，Node 18+ 内置 fetch）。
//
// 用法：
//   node push.mjs --state thinking [--session demo] [--tool read_file] [--detail "执行 read_file"]
//   node push.mjs --demo [--interval 2000]        # 循环播放一串状态
//   node push.mjs --state completed --session s2  # 另一个会话
//
// 端口可用环境变量 PET_PORT 覆盖（默认 4271）。

const PORT = process.env.PET_PORT ?? 4271;
const URL = `http://127.0.0.1:${PORT}/event`;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function push(state, extra = {}) {
  const ev = {
    source: "mock",
    sessionId: arg("session", "demo"),
    event: "state-change",
    state,
    tool: extra.tool,
    detail: extra.detail,
    timestamp: Date.now(),
  };
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
    });
    const text = await res.text();
    console.log(`→ [${ev.sessionId}] ${state}  (${res.status} ${text})`);
  } catch (e) {
    console.error(`✗ 推送失败（桌宠在运行吗？）: ${e.message ?? e}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--demo")) {
  const seq = [
    ["thinking", { detail: "分析需求" }],
    ["tool-use", { tool: "read_file", detail: "执行 read_file" }],
    ["tool-use", { tool: "edit_file", detail: "执行 edit_file" }],
    ["streaming", { detail: "输出中" }],
    ["permission-prompt", { detail: "等待审批" }],
    ["completed", { detail: "任务完成" }],
    ["error-interrupted", { detail: "出错了" }],
    ["idle", {}],
  ];
  const interval = Number(arg("interval", 2000));
  console.log(`demo 循环，每 ${interval}ms 推一个状态 → ${URL}（Ctrl+C 停止）`);
  let i = 0;
  for (;;) {
    const [state, extra] = seq[i % seq.length];
    await push(state, extra);
    i++;
    await sleep(interval);
  }
} else {
  await push(arg("state", "thinking"), {
    tool: arg("tool"),
    detail: arg("detail"),
  });
}
