import { describe, expect, it } from "vitest";
import { frameIndex, outroDurationMs, outroIndex, phasedIndex } from "./frame-player";

describe("frameIndex", () => {
  it("退化输入恒为 0", () => {
    expect(frameIndex(5000, 1, 12, "loop")).toBe(0);
    expect(frameIndex(5000, 10, 0, "loop")).toBe(0);
  });

  it("loop：按 fps 推进并取模", () => {
    // 12fps：每帧 83.33ms
    expect(frameIndex(0, 10, 12, "loop")).toBe(0);
    expect(frameIndex(83.4, 10, 12, "loop")).toBe(1);
    expect(frameIndex(999, 10, 12, "loop")).toBe(1); // floor(11.9) = 11 → 11 % 10
    expect(frameIndex(1000, 10, 12, "loop")).toBe(2); // 12 % 10
  });

  it("loop：到达 count 后回 0", () => {
    const count = 24;
    const fps = 12;
    expect(frameIndex((count * 1000) / fps, count, fps, "loop")).toBe(0);
  });

  it("pingpong：三角波 0..N-1..1，端点不重复", () => {
    const count = 4;
    const fps = 10; // 每帧 100ms，周期 2*4-2 = 6 帧
    const seq = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => frameIndex(s * 100, count, fps, "pingpong"));
    expect(seq).toEqual([0, 1, 2, 3, 2, 1, 0, 1]);
  });

  it("pingpong：count=2 时退化为 0,1,0,1…", () => {
    const seq = [0, 1, 2, 3].map((s) => frameIndex(s * 100, 2, 10, "pingpong"));
    expect(seq).toEqual([0, 1, 0, 1]);
  });
});

describe("phasedIndex（三段式：入场 → 中段循环）", () => {
  // count=59, intro=12, outro=12, fps=12 → 循环段 [12, 47)
  const P = { count: 59, fps: 12, intro: 12, outro: 12 };
  const at = (step: number) => phasedIndex((step * 1000) / P.fps, P.count, P.fps, P.intro, P.outro);

  it("入场段顺序播放一次", () => {
    expect(at(0)).toBe(0);
    expect(at(5)).toBe(5);
    expect(at(11)).toBe(11);
  });

  it("进入中段循环，不触碰出场帧", () => {
    expect(at(12)).toBe(12); // 循环段第 0 帧
    expect(at(12 + 35)).toBe(12); // 循环一整圈回来
    expect(at(12 + 34)).toBe(46); // 循环段最后一帧
    expect(at(12 + 36)).toBe(13);
    expect(at(1000)).toBeLessThan(47);
    expect(at(1000)).toBeGreaterThanOrEqual(12);
  });

  it("退化参数安全", () => {
    expect(phasedIndex(100, 10, 12, 5, 5)).toBe(0); // loopLen=0
    expect(phasedIndex(100, 10, 0, 2, 2)).toBe(0); // fps=0
  });

  it("loopStart > intro：中间帧被跳过，循环从 loopStart 开始", () => {
    // count=59, intro=12, outro=12, loopStart=20 → 循环段 [20, 47)
    const at = (step: number) => phasedIndex((step * 1000) / 12, 59, 12, 12, 12, 20);
    expect(at(0)).toBe(0); // 入场照常
    expect(at(11)).toBe(11);
    expect(at(12)).toBe(20); // 入场一结束直接跳到 loopStart
    expect(at(12 + 27)).toBe(20); // 循环一整圈（27 帧）
    expect(at(12 + 26)).toBe(46);
    expect(at(500)).toBeGreaterThanOrEqual(20);
    expect(at(500)).toBeLessThan(47);
  });
});

describe("frameIndex once（一次性播放）", () => {
  it("播一遍后停在最后一帧", () => {
    const at = (step: number) => frameIndex((step * 1000) / 10, 5, 10, "once");
    expect(at(0)).toBe(0);
    expect(at(3)).toBe(3);
    expect(at(4)).toBe(4);
    expect(at(5)).toBe(4); // 超出后停住
    expect(at(999)).toBe(4);
  });
});

describe("outroIndex / outroDurationMs（出场段）", () => {
  const P = { count: 59, fps: 12, outro: 12 };
  const at = (step: number) => outroIndex((step * 1000) / P.fps, P.count, P.fps, P.outro);

  it("从 count-outro 顺序播到最后一帧并停住", () => {
    expect(at(0)).toBe(47);
    expect(at(1)).toBe(48);
    expect(at(11)).toBe(58);
    expect(at(12)).toBe(58); // 超出后停在末帧
    expect(at(999)).toBe(58);
  });

  it("时长 = outro / fps", () => {
    expect(outroDurationMs(12, 12)).toBe(1000);
    expect(outroDurationMs(0, 12)).toBe(0);
  });
});
