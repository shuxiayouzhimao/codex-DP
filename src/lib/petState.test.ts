import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PetState, shouldStealDisplay } from "./petState";
import type { AgentState } from "./types";
import type { AgentEventPayload } from "./events";
import type { SessionMeta } from "./petState";

function ev(partial: Partial<AgentEventPayload> & { state: AgentState }): AgentEventPayload {
  return {
    source: partial.source ?? "mock",
    sessionId: partial.sessionId ?? "s1",
    state: partial.state,
    detail: partial.detail,
    tool: partial.tool,
    project: partial.project,
  };
}

describe("shouldStealDisplay", () => {
  it("同级 thinking 不抢工作态", () => {
    expect(shouldStealDisplay("thinking", "thinking")).toBe(false);
    expect(shouldStealDisplay("thinking", "streaming")).toBe(false);
  });
  it("更高优先级可抢工作态", () => {
    expect(shouldStealDisplay("thinking", "tool-use")).toBe(true);
    expect(shouldStealDisplay("thinking", "permission-prompt")).toBe(true);
  });
  it("终态/等待可抢；当前终态不被工作态盖", () => {
    expect(shouldStealDisplay("thinking", "completed")).toBe(true);
    expect(shouldStealDisplay("completed", "thinking")).toBe(false);
    expect(shouldStealDisplay("completed", "streaming")).toBe(false);
  });
});

describe("PetState", () => {
  let last: { state: AgentState; detail: string; meta: SessionMeta };
  let pet: PetState;

  beforeEach(() => {
    vi.useFakeTimers();
    last = {
      state: "idle",
      detail: "",
      meta: {
        count: 0,
        sources: [],
        lastKey: "",
        displayKey: "",
        filtered: false,
        lost: false,
        quiet: false,
      },
    };
    pet = new PetState((state, detail, meta) => {
      last = { state, detail, meta };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies single event and aggregates priority across sessions", () => {
    pet.handleEvent(ev({ state: "thinking", detail: "想" }));
    expect(last.state).toBe("thinking");
    expect(last.detail).toBe("想");

    pet.handleEvent(ev({ sessionId: "s2", state: "tool-use", detail: "跑" }));
    expect(last.state).toBe("tool-use");
    expect(last.meta.count).toBe(2);
  });

  it("最近会话的 completed 不被其它会话 streaming 盖住", () => {
    pet.handleEvent(ev({ sessionId: "old", state: "streaming", detail: "吐字" }));
    pet.handleEvent(ev({ sessionId: "new", state: "completed", detail: "完成" }));
    expect(last.state).toBe("completed");
    expect(last.detail).toBe("完成");
    expect(last.meta.count).toBe(2);

    // 其它会话再刷 streaming 也不盖终态
    pet.handleEvent(ev({ sessionId: "old", state: "streaming", detail: "还在吐" }));
    expect(last.state).toBe("completed");
  });

  it("全部模式：同级 thinking 不抢当前展示会话", () => {
    pet.handleEvent(ev({ source: "claude-code", sessionId: "a", state: "thinking" }));
    expect(last.state).toBe("thinking");
    pet.handleEvent(ev({ source: "cursor", sessionId: "default", state: "thinking" }));
    expect(last.state).toBe("thinking");
    expect(last.meta.displayKey).toBe("claude-code:a");
    expect(last.meta.lastKey).toBe("cursor:default");
  });

  it("filters to a single session", () => {
    pet.handleEvent(ev({ sessionId: "a", state: "thinking" }));
    pet.setFilter("mock:a");
    expect(last.state).toBe("thinking"); // 保留目标会话状态
    expect(last.meta.filtered).toBe(true);
    expect(last.meta.lost).toBe(false);

    pet.handleEvent(ev({ sessionId: "a", state: "tool-use" }));
    expect(last.state).toBe("tool-use");

    pet.handleEvent(ev({ sessionId: "b", state: "error-interrupted" }));
    expect(last.state).toBe("tool-use"); // non-filter session ignored for display
    expect(last.meta.ignoredHint).toBe("mock");
  });

  it("锁定失联：会话过期后 lost=true", () => {
    pet.handleEvent(ev({ sessionId: "a", state: "thinking", project: "codex-DP" }));
    pet.setFilter("mock:a");
    pet.setOptions({ workDecayMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(last.state).toBe("idle");
    expect(last.meta.filtered).toBe(true);
    expect(last.meta.lost).toBe(true);
  });

  it("touchAlive 刷新 TTL 不改状态", () => {
    pet.setOptions({ workDecayMs: 60_000 });
    pet.handleEvent(ev({ sessionId: "a", state: "thinking" }));
    expect(last.state).toBe("thinking");
    vi.advanceTimersByTime(50_000);
    pet.touchAlive("mock:a");
    expect(last.state).toBe("thinking");
    // 再过 50s：若未 touch 会在 60s 衰减；touch 后应仍保持（衰减计时未重置，但 session 未 prune）
    // touchAlive 故意不重置 workDecay 计时——只防 SESSION_TTL prune
    vi.advanceTimersByTime(10_000);
    expect(last.state).toBe("idle");
  });

  it("toIdle in filter mode only clears the locked session", () => {
    pet.handleEvent(ev({ sessionId: "a", state: "thinking" }));
    pet.handleEvent(ev({ sessionId: "b", state: "tool-use" }));
    pet.setFilter("mock:a");
    expect(last.state).toBe("thinking");
    pet.setOptions({ workDecayMs: 1000 });
    // setOptions 重排计时
    vi.advanceTimersByTime(1000);
    expect(last.state).toBe("idle");
    expect(last.meta.filtered).toBe(true);
    // 解除过滤后 b 仍在（若未过期）—— setFilter null 保留 sessions；a 已删
    pet.setFilter(null);
    expect(last.meta.filtered).toBe(false);
  });

  it("work state decays after workDecayMs", () => {
    pet.setOptions({ workDecayMs: 1000 });
    pet.handleEvent(ev({ state: "thinking" }));
    expect(last.state).toBe("thinking");

    vi.advanceTimersByTime(999);
    expect(last.state).toBe("thinking");
    vi.advanceTimersByTime(1);
    expect(last.state).toBe("idle");
  });

  it("wait-user does not decay within workDecayMs", () => {
    pet.setOptions({ workDecayMs: 1000 });
    pet.handleEvent(ev({ state: "permission-prompt" }));
    vi.advanceTimersByTime(60_000);
    expect(last.state).toBe("permission-prompt");
  });

  it("waiting is not overwritten by idle thinking noise", () => {
    pet.handleEvent(ev({ state: "permission-prompt", detail: "等待确认：ls" }));
    expect(last.state).toBe("permission-prompt");
    expect(last.detail).toBe("等待确认：ls");

    pet.handleEvent(ev({ state: "thinking", detail: "思考中" }));
    expect(last.state).toBe("permission-prompt");
    expect(last.detail).toBe("等待确认：ls");

    // 点 Run 之后：有意义的离开门闩事件应放行
    pet.handleEvent(ev({ state: "thinking", detail: "处理 Shell 结果", tool: "Shell" }));
    expect(last.state).toBe("thinking");
  });

  it("waiting yields to after-run tool-use", () => {
    pet.handleEvent(ev({ state: "permission-prompt", detail: "等待确认：ls" }));
    pet.handleEvent(ev({ state: "tool-use", detail: "命令执行中" }));
    expect(last.state).toBe("tool-use");
  });

  it("terminal keeps success against wrap-up noise, but yields to new-turn thinking", () => {
    pet.setOptions({ clickToDismiss: true, terminalHoldMs: 60_000 });
    pet.handleEvent(ev({ state: "completed", detail: "完成" }));
    pet.handleEvent(ev({ state: "thinking", detail: "整理回复" }));
    expect(last.state).toBe("completed");
    expect(last.detail).toBe("完成");

    // 新一轮对话：UserPromptSubmit → 思考中，无需先点消散
    pet.handleEvent(ev({ state: "thinking", detail: "思考中" }));
    expect(last.state).toBe("thinking");
  });

  it("terminal holds until dismiss when clickToDismiss", () => {
    pet.setOptions({ clickToDismiss: true, terminalHoldMs: 60_000 });
    pet.handleEvent(ev({ state: "completed" }));
    vi.advanceTimersByTime(5000);
    expect(last.state).toBe("completed");

    pet.dismissTerminal();
    expect(last.state).toBe("idle");
  });

  it("terminal auto-clears when clickToDismiss=false", () => {
    pet.setOptions({ clickToDismiss: false });
    pet.handleEvent(ev({ state: "completed" }));
    vi.advanceTimersByTime(4999);
    expect(last.state).toBe("completed");
    vi.advanceTimersByTime(1);
    expect(last.state).toBe("idle");
  });

  it("records project for lastKey", () => {
    pet.handleEvent(ev({ state: "thinking", project: "codex-DP" }));
    expect(last.meta.lastProject).toBe("codex-DP");
    expect(last.meta.lastKey).toBe("mock:s1");
  });
});
