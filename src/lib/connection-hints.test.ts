import { describe, expect, it } from "vitest";
import {
  evaluateConnectionHint,
  connectionHintText,
  type ConnectionHintInput,
} from "./connection-hints";

const base = (): ConnectionHintInput => ({
  enabled: true,
  silenceMs: 30 * 60_000,
  onboardingDone: true,
  anyInstalled: true,
  needsUpdate: false,
  displayIdle: true,
  startedAt: 0,
  lastEventAt: null,
  now: 30 * 60_000,
  silenceShown: false,
  bootHintShown: false,
});

describe("evaluateConnectionHint", () => {
  it("久无事件且 idle → silence", () => {
    expect(evaluateConnectionHint(base())).toBe("silence");
  });

  it("未满静默时长 → null", () => {
    expect(evaluateConnectionHint({ ...base(), now: 10 * 60_000 })).toBe(null);
  });

  it("非 idle → null", () => {
    expect(evaluateConnectionHint({ ...base(), displayIdle: false })).toBe(null);
  });

  it("开关关闭 → null", () => {
    expect(evaluateConnectionHint({ ...base(), enabled: false })).toBe(null);
  });

  it("未引导且未安装 → null", () => {
    expect(
      evaluateConnectionHint({
        ...base(),
        onboardingDone: false,
        anyInstalled: false,
      }),
    ).toBe(null);
  });

  it("已展示过静默 → null", () => {
    expect(evaluateConnectionHint({ ...base(), silenceShown: true })).toBe(null);
  });

  it("needsUpdate 优先于 silence", () => {
    expect(evaluateConnectionHint({ ...base(), needsUpdate: true })).toBe(
      "needs-update",
    );
  });

  it("boot 提示已展示后可走 silence", () => {
    expect(
      evaluateConnectionHint({
        ...base(),
        needsUpdate: true,
        bootHintShown: true,
      }),
    ).toBe("silence");
  });

  it("有事件后从 lastEventAt 计时", () => {
    expect(
      evaluateConnectionHint({
        ...base(),
        lastEventAt: 20 * 60_000,
        now: 40 * 60_000,
      }),
    ).toBe(null);
    expect(
      evaluateConnectionHint({
        ...base(),
        lastEventAt: 20 * 60_000,
        now: 50 * 60_000 + 1,
      }),
    ).toBe("silence");
  });
});

describe("connectionHintText", () => {
  it("文案非空", () => {
    expect(connectionHintText("silence").length).toBeGreaterThan(4);
    expect(connectionHintText("needs-update").length).toBeGreaterThan(4);
  });
});
