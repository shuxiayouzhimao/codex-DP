import { describe, expect, it } from "vitest";
import { WORKING_ANIMS, animTransitionFlags, isWorkingChurn } from "./working-churn";

describe("isWorkingChurn", () => {
  it("工作态两两之间为 true", () => {
    expect(isWorkingChurn("thinking", "tool-use")).toBe(true);
    expect(isWorkingChurn("tool-use", "streaming")).toBe(true);
    expect(isWorkingChurn("streaming", "thinking")).toBe(true);
  });

  it("涉及非工作态为 false", () => {
    expect(isWorkingChurn("tool-use", "idle")).toBe(false);
    expect(isWorkingChurn("tool-use", "success")).toBe(false);
    expect(isWorkingChurn("idle", "thinking")).toBe(false);
    expect(isWorkingChurn("waiting", "tool-use")).toBe(false);
  });

  it("WORKING_ANIMS 仅含三态", () => {
    expect([...WORKING_ANIMS].sort()).toEqual(["streaming", "thinking", "tool-use"]);
  });
});

describe("animTransitionFlags", () => {
  it("工作态 churn：有 outro 也不播，并 skipIntro", () => {
    expect(animTransitionFlags("thinking", "tool-use", true)).toEqual({
      workingChurn: true,
      playOutro: false,
      skipIntro: true,
    });
  });

  it("离开工作态：有 outro 则播", () => {
    expect(animTransitionFlags("tool-use", "idle", true)).toEqual({
      workingChurn: false,
      playOutro: true,
      skipIntro: false,
    });
  });

  it("无 outro 时 playOutro 恒 false", () => {
    expect(animTransitionFlags("tool-use", "success", false).playOutro).toBe(false);
  });
});
