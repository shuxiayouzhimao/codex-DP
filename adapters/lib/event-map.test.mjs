import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAP, mapHook, projectOf, sessionOf, toolOf } from "./event-map.mjs";

describe("event-map MAP snapshot", () => {
  it("covers Claude Code / Codex PascalCase events", () => {
    const expected = [
      "UserPromptSubmit", "PreCompact", "PostCompact", "PreToolUse", "PostToolUse", "PostToolBatch",
      "PostToolUseFailure", "PermissionRequest", "Elicitation", "Notification",
      "Stop", "StopFailure", "SubagentStart", "SubagentStop", "SessionStart", "SessionEnd",
    ];
    for (const name of expected) assert.equal(typeof MAP[name], "function", name);
  });

  it("covers Cursor camelCase events", () => {
    const expected = [
      "beforeSubmitPrompt", "preCompact", "preToolUse", "postToolUse", "postToolUseFailure",
      "afterAgentThought", "afterAgentResponse", "afterFileEdit",
      "beforeShellExecution", "afterShellExecution", "beforeMCPExecution", "afterMCPExecution",
      "subagentStart", "subagentStop", "sessionStart", "sessionEnd", "stop",
    ];
    for (const name of expected) assert.equal(typeof MAP[name], "function", name);
  });

  it("does not map any hook to streaming (no reliable token hook)", () => {
    for (const [name, fn] of Object.entries(MAP)) {
      const out = fn({});
      assert.notEqual(out.state, "streaming", `${name} must not fake streaming`);
    }
  });
});

describe("mapHook core mappings", () => {
  const cases = [
    ["UserPromptSubmit", {}, "thinking"],
    ["PreToolUse", { tool_name: "Read" }, "tool-use"],
    ["PostToolUseFailure", { toolName: "Bash" }, "error-interrupted"],
    ["PermissionRequest", {}, "permission-prompt"],
    ["Elicitation", { message: "选一个" }, "ask-user"],
    ["Stop", {}, "completed"],
    ["StopFailure", {}, "error-interrupted"],
    ["preToolUse", { tool: "edit" }, "tool-use"],
    ["preToolUse", { toolName: "Shell" }, "permission-prompt"],
    ["beforeSubmitPrompt", {}, "thinking"],
    ["afterAgentResponse", {}, "completed"],
    ["beforeShellExecution", {}, "permission-prompt"],
    ["afterShellExecution", {}, "thinking"],
    ["PostCompact", {}, "thinking"],
    ["stop", {}, "completed"],
  ];

  for (const [hook, payload, state] of cases) {
    it(`${hook} → ${state}`, () => {
      const out = mapHook(hook, payload);
      assert.ok(out);
      assert.equal(out.state, state);
    });
  }

  it("unknown hook → null", () => {
    assert.equal(mapHook("TotallyUnknown", {}), null);
  });

  it("extracts session / project / tool defensively", () => {
    const out = mapHook("PreToolUse", {
      tool_name: "Write",
      sessionId: "abc-123",
      cwd: "D:/projects/codex-DP",
    });
    assert.equal(out.tool, "Write");
    assert.equal(out.sessionId, "abc-123");
    assert.equal(out.project, "codex-DP");
    assert.match(out.detail, /Write/);
  });
});

describe("field helpers", () => {
  it("sessionOf falls back across naming styles", () => {
    assert.equal(sessionOf({ conversation_id: "c1" }), "c1");
    assert.equal(sessionOf({ threadId: "t1" }), "t1");
    assert.equal(sessionOf({}), "default");
  });

  it("toolOf / projectOf", () => {
    assert.equal(toolOf({ name: "X" }), "X");
    assert.equal(projectOf("C:\\foo\\bar\\"), "bar");
    assert.equal(projectOf(undefined), undefined);
  });
});
