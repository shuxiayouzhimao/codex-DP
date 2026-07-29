import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PetState } from "./petState";
import type { AgentState } from "./types";
import type { AgentEventPayload } from "./events";
import type { SessionMeta } from "./petState";

function ev(partial: Partial<AgentEventPayload> & { state: AgentState }): AgentEventPayload {
  return {
    source: partial.source ?? "mock",
    sessionId: partial.sessionId ?? "s1",
    state: partial.state,
    detail: partial.detail,
    project: partial.project,
  };
}

describe("PetState", () => {
  let last: { state: AgentState; detail: string; meta: SessionMeta };
  let pet: PetState;

  beforeEach(() => {
    vi.useFakeTimers();
    last = { state: "idle", detail: "", meta: { count: 0, sources: [], lastKey: "", filtered: false } };
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

  it("filters to a single session", () => {
    pet.handleEvent(ev({ sessionId: "a", state: "thinking" }));
    pet.setFilter("mock:a");
    expect(last.state).toBe("idle"); // setFilter clears view
    expect(last.meta.filtered).toBe(true);

    pet.handleEvent(ev({ sessionId: "a", state: "tool-use" }));
    expect(last.state).toBe("tool-use");

    pet.handleEvent(ev({ sessionId: "b", state: "error-interrupted" }));
    expect(last.state).toBe("tool-use"); // non-filter session ignored for display
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
