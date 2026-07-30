import { describe, expect, it } from "vitest";
import { rulesCopy } from "./rules";
import type { CopyRequest } from "./types";

function req(partial: Partial<CopyRequest> & Pick<CopyRequest, "state" | "kind">): CopyRequest {
  return {
    trajectory: [],
    ...partial,
  };
}

describe("rulesCopy 工作态", () => {
  it("thinking / tool-use / 等待 / streaming", () => {
    expect(rulesCopy(req({ state: "thinking", kind: "work" }))).toBe("脑子转起来了…");
    expect(rulesCopy(req({ state: "thinking", kind: "work", project: "codex-DP" }))).toBe(
      "想想「codex-DP」怎么搞…",
    );
    expect(rulesCopy(req({ state: "tool-use", kind: "work", tool: "Grep" }))).toBe(
      "翻翻看「搜索」…",
    );
    expect(rulesCopy(req({ state: "tool-use", kind: "work", tool: "Bash" }))).toBe(
      "翻翻看「终端」…",
    );
    expect(rulesCopy(req({ state: "tool-use", kind: "work", tool: "Write" }))).toBe(
      "翻翻看「写入」…",
    );
    expect(rulesCopy(req({ state: "permission-prompt", kind: "work" }))).toBe(
      "等你点 Run / 批准",
    );
    expect(
      rulesCopy(
        req({
          state: "permission-prompt",
          kind: "work",
          detail: "等待确认：npm test",
        }),
      ),
    ).toBe("等待确认：npm test");
    expect(rulesCopy(req({ state: "ask-user", kind: "work" }))).toBe("需要你拍个板");
    expect(rulesCopy(req({ state: "streaming", kind: "work" }))).toBe("正在往外吐字…");
  });

  it("idle 返回空（上层用 label）", () => {
    expect(rulesCopy(req({ state: "idle", kind: "work" }))).toBe("");
  });
});

describe("rulesCopy 终态摘要", () => {
  it("完成：多工具 / 单工具 / 仅项目", () => {
    expect(
      rulesCopy(
        req({
          state: "completed",
          kind: "terminal",
          trajectory: [
            { state: "tool-use", tool: "Grep", ts: 1 },
            { state: "tool-use", tool: "Bash", ts: 2 },
            { state: "completed", ts: 3 },
          ],
        }),
      ),
    ).toBe("搞定：终端 等 2 步");
    expect(
      rulesCopy(
        req({
          state: "completed",
          kind: "terminal",
          trajectory: [{ state: "tool-use", tool: "Grep", ts: 1 }],
        }),
      ),
    ).toBe("搞定：「搜索」");
    expect(
      rulesCopy(req({ state: "completed", kind: "terminal", project: "codex-DP" })),
    ).toBe("「codex-DP」弄完啦");
  });

  it("出错：卡在工具 / detail 截断", () => {
    expect(
      rulesCopy(
        req({
          state: "error-interrupted",
          kind: "terminal",
          trajectory: [{ state: "tool-use", tool: "Bash", ts: 1 }],
        }),
      ),
    ).toBe("卡在「终端」了");
    expect(
      rulesCopy(
        req({
          state: "error-interrupted",
          kind: "terminal",
          detail: "非常非常非常非常长的错误信息内容",
        }),
      ),
    ).toMatch(/^出错：/);
  });
});
