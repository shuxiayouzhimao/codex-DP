import { describe, expect, it } from "vitest";
import { aggregate, metaOf, STATE_MAP } from "./state-machine";
import type { AgentState } from "./types";

describe("aggregate", () => {
  it("empty → idle", () => {
    expect(aggregate([])).toBe("idle");
  });

  it("picks highest priority", () => {
    expect(aggregate(["idle", "thinking", "tool-use"])).toBe("tool-use");
    expect(aggregate(["completed", "thinking"])).toBe("thinking");
    expect(aggregate(["completed", "error-interrupted"])).toBe("error-interrupted");
  });

  it("ties keep first highest among equals", () => {
    // tool-use=3；permission/ask/error=4 → 等待审批压过执行中
    expect(aggregate(["tool-use", "permission-prompt"])).toBe("permission-prompt");
  });
});

describe("STATE_MAP coverage", () => {
  const states: AgentState[] = [
    "idle", "thinking", "tool-use", "permission-prompt",
    "ask-user", "streaming", "completed", "error-interrupted",
  ];

  it("every AgentState has meta", () => {
    for (const s of states) {
      expect(STATE_MAP[s]).toBeDefined();
      expect(metaOf(s).anim).toBeTruthy();
      expect(metaOf(s).priority).toBeGreaterThanOrEqual(0);
    }
  });
});
