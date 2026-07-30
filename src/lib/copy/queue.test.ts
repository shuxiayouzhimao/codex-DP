import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventRing } from "./ring";
import { CopyQueue, resolveProvider } from "./queue";
import type { CopyRequest } from "./types";

describe("EventRing.trajectory", () => {
  it("取上一次 idle/终态之后的本轮", () => {
    const r = new EventRing();
    r.push({ state: "thinking", ts: 1 });
    r.push({ state: "tool-use", tool: "Grep", ts: 2 });
    r.push({ state: "completed", ts: 3 });
    r.push({ state: "thinking", ts: 4 });
    r.push({ state: "tool-use", tool: "Bash", ts: 5 });
    r.push({ state: "completed", ts: 6 });
    const traj = r.trajectory();
    expect(traj.map((e) => e.tool || e.state)).toEqual(["thinking", "Bash", "completed"]);
  });

  it("无边界时返回全部（受 maxN 限制）", () => {
    const r = new EventRing();
    for (let i = 0; i < 5; i++) r.push({ state: "tool-use", tool: `T${i}`, ts: i });
    expect(r.trajectory(3).map((e) => e.tool)).toEqual(["T2", "T3", "T4"]);
  });
});

describe("resolveProvider", () => {
  it("总开关关或 off → null", () => {
    expect(
      resolveProvider({
        copyEnabled: false,
        copyProvider: "rules",
        copyBaseUrl: "",
        copyApiKey: "",
        copyModel: "",
        copyAiTerminalOnly: false,
      }),
    ).toBeNull();
    expect(
      resolveProvider({
        copyEnabled: true,
        copyProvider: "off",
        copyBaseUrl: "",
        copyApiKey: "",
        copyModel: "",
        copyAiTerminalOnly: false,
      }),
    ).toBeNull();
  });
});

describe("CopyQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const workReq = (state: CopyRequest["state"] = "tool-use"): CopyRequest => ({
    state,
    tool: "Grep",
    detail: "执行 Grep",
    trajectory: [{ state, tool: "Grep", ts: 1 }],
    kind: state === "completed" || state === "error-interrupted" ? "terminal" : "work",
  });

  it("关闭时立刻回调 null，不生成文案", async () => {
    const q = new CopyQueue();
    q.setOptions({ copyEnabled: false, copyProvider: "rules" });
    const seen: (string | null)[] = [];
    q.setListener((r) => seen.push(r?.text ?? null));
    q.onDisplay(workReq());
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual([null]);
  });

  it("rules 模式防抖后产出人格句", async () => {
    const q = new CopyQueue();
    const seen: string[] = [];
    q.setListener((r) => {
      if (r) seen.push(r.text);
    });
    q.setOptions({ copyEnabled: true, copyProvider: "rules" });
    q.onDisplay(workReq("tool-use"));
    await vi.advanceTimersByTimeAsync(900);
    expect(seen[0]).toBe("翻翻看「搜索」…");
  });

  it("generation 作废：快速切换后只保留最后一次", async () => {
    const q = new CopyQueue();
    const seen: string[] = [];
    q.setListener((r) => {
      if (r) seen.push(r.text);
    });
    q.setOptions({ copyEnabled: true, copyProvider: "rules" });
    q.onDisplay(workReq("thinking"));
    await vi.advanceTimersByTimeAsync(400);
    q.onDisplay(workReq("tool-use"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe("翻翻看「搜索」…");
  });

  it("idle 清空", async () => {
    const q = new CopyQueue();
    const seen: (string | null)[] = [];
    q.setListener((r) => seen.push(r?.text ?? null));
    q.setOptions({ copyEnabled: true, copyProvider: "rules" });
    q.onDisplay(workReq("tool-use"));
    await vi.advanceTimersByTimeAsync(900);
    q.onDisplay(workReq("idle"));
    expect(seen[seen.length - 1]).toBeNull();
  });
});
