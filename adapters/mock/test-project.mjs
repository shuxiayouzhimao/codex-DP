// 临时验证脚本：推送带 project 的事件，验证会话跟踪 + 菜单刷新不崩溃
const URL = "http://127.0.0.1:4271/event";
const post = (o) =>
  fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(o),
  }).then((r) => r.text());

const evs = [
  { source: "claude-code", sessionId: "aaaa1111-2222-3333-4444-555555555555", state: "thinking", detail: "思考中", project: "codex-DP", timestamp: 1 },
  { source: "claude-code", sessionId: "bbbb2222-3333-4444-5555-666666666666", state: "tool-use", detail: "执行 Bash", project: "some-other-proj", timestamp: 2 },
  { source: "claude-code", sessionId: "aaaa1111-2222-3333-4444-555555555555", state: "completed", detail: "完成", project: "codex-DP", timestamp: 3 },
];

for (const e of evs) {
  // eslint-disable-next-line no-await-in-loop
  console.log(await post(e), "<-", e.project, e.state);
}
