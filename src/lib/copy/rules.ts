import type { AgentState } from "../types";
import type { CopyRequest } from "./types";

/** 常见工具 → 气泡里的短别名（未知则用原名截断） */
const TOOL_LABEL: Record<string, string> = {
  Bash: "终端",
  Shell: "终端",
  Edit: "编辑",
  Write: "写入",
  Read: "阅读",
  Grep: "搜索",
  Glob: "找文件",
  Task: "子任务",
  WebSearch: "搜网",
  WebFetch: "拉网页",
  StrReplace: "改代码",
  Delete: "删文件",
  TodoWrite: "待办",
  AwaitShell: "等终端",
  CallMcpTool: "MCP",
  GenerateImage: "出图",
};

/** 截断工具名，避免气泡爆长 */
function shortTool(tool?: string, max = 12): string {
  if (!tool) return "";
  return tool.length > max ? tool.slice(0, max - 1) + "…" : tool;
}

/** 展示用工具名：优先别名 */
export function toolLabel(tool?: string): string {
  if (!tool) return "";
  return shortTool(TOOL_LABEL[tool] ?? tool);
}

function projectHint(project?: string): string {
  return project ? `「${project}」` : "";
}

/**
 * 本地规则模板：零网络、可单测。
 * 未知组合回退 detail，再回退空串（由上层用 label 兜底）。
 */
export function rulesCopy(req: CopyRequest): string {
  if (req.kind === "terminal") return terminalRules(req);
  return workRules(req);
}

function workRules(req: CopyRequest): string {
  const tool = toolLabel(req.tool);
  const proj = projectHint(req.project);
  switch (req.state as AgentState) {
    case "thinking":
      return proj ? `想想${proj}怎么搞…` : "脑子转起来了…";
    case "tool-use":
      return tool ? `翻翻看「${tool}」…` : "动手干活中…";
    case "permission-prompt":
      // 有命令/工具详情时优先展示（Cursor 点 Run）
      if (req.detail?.trim()) {
        const d = req.detail.trim();
        return d.length > 20 ? `${d.slice(0, 18)}…` : d;
      }
      return tool ? `等你点头：「${tool}」` : "等你点 Run / 批准";
    case "ask-user":
      if (req.detail?.trim()) {
        const d = req.detail.trim();
        return d.length > 20 ? `${d.slice(0, 18)}…` : d;
      }
      return "需要你拍个板";
    case "streaming":
      return "正在往外吐字…";
    case "idle":
      return "";
    default:
      return req.detail?.trim() || "";
  }
}

function terminalRules(req: CopyRequest): string {
  const tools = [
    ...new Set(
      req.trajectory
        .map((e) => e.tool)
        .filter((t): t is string => !!t && t.length > 0),
    ),
  ];
  const lastTool = tools.length ? toolLabel(tools[tools.length - 1]) : "";
  const n = tools.length;
  const proj = projectHint(req.project);

  if (req.state === "completed") {
    if (n > 1 && lastTool) return `搞定：${lastTool} 等 ${n} 步`;
    if (lastTool) return `搞定：「${lastTool}」`;
    if (proj) return `${proj}弄完啦`;
    return "搞定啦";
  }
  if (req.state === "error-interrupted") {
    if (lastTool) return `卡在「${lastTool}」了`;
    if (req.detail?.trim()) {
      const d = req.detail.trim();
      return d.length > 16 ? `出错：${d.slice(0, 14)}…` : `出错：${d}`;
    }
    return "出错了，瞅瞅？";
  }
  return req.detail?.trim() || "";
}

/** OpenAI / 规则共用的系统提示（工作态） */
export const WORK_SYSTEM = `你是桌面宠物的气泡文案助手。根据 Agent 状态写一句中文口语短句。
硬性要求：一句、不超过20字、不要引号、不要提模型或API、最多一个贴合的符号。只输出文案本身。`;

/** 终态摘要系统提示 */
export const TERMINAL_SYSTEM = `你是桌面宠物的气泡文案助手。根据本轮工具轨迹写一句中文摘要。
完成态偏「做完了什么」；出错态偏「卡在哪」。硬性要求：一句、不超过28字、不要引号、不要提模型。只输出文案本身。`;

export function workUserPrompt(req: CopyRequest): string {
  return [
    `状态: ${req.state}`,
    req.tool ? `工具: ${req.tool}` : "",
    req.detail ? `详情: ${req.detail}` : "",
    req.project ? `项目: ${req.project}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function terminalUserPrompt(req: CopyRequest): string {
  const lines = req.trajectory.map((e) => {
    const parts: string[] = [e.state];
    if (e.tool) parts.push(`tool=${e.tool}`);
    if (e.detail) parts.push(e.detail);
    return `- ${parts.join(" ")}`;
  });
  return [`终态: ${req.state}`, req.project ? `项目: ${req.project}` : "", "轨迹:", ...lines]
    .filter(Boolean)
    .join("\n");
}
