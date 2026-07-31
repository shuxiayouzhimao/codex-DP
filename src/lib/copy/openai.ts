import { invoke } from "@tauri-apps/api/core";
import {
  TERMINAL_SYSTEM,
  WORK_SYSTEM,
  terminalUserPrompt,
  workUserPrompt,
} from "./rules";
import type { CopyRequest } from "./types";

/** 调用 Rust chat_complete；Key/BaseURL 由后端从 Settings 读取。 */
export async function openaiCopy(req: CopyRequest): Promise<string> {
  const system = req.kind === "terminal" ? TERMINAL_SYSTEM : WORK_SYSTEM;
  const user = req.kind === "terminal" ? terminalUserPrompt(req) : workUserPrompt(req);
  const text = await invoke<string>("chat_complete", {
    system,
    user,
    maxTokens: req.kind === "terminal" ? 128 : 96,
  });
  return sanitize(text, req.kind === "terminal" ? 28 : 20);
}

function sanitize(raw: string, max: number): string {
  let t = raw.trim().replace(/^["「『]|["」』]$/g, "").trim();
  // 只取第一行，避免模型多嘴
  const nl = t.indexOf("\n");
  if (nl >= 0) t = t.slice(0, nl).trim();
  if (t.length > max) t = t.slice(0, max - 1) + "…";
  return t;
}
