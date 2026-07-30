import type { AgentState } from "../types";
import type { EventSnap } from "./types";

const TERMINAL = new Set<AgentState>(["completed", "error-interrupted"]);
const CAP = 24;

/**
 * 最近事件环：供终态摘要取「本轮」轨迹。
 * 本轮 = 自上一次 idle/终态之后的事件；若无边界则取最近 maxN 条。
 */
export class EventRing {
  private items: EventSnap[] = [];

  push(snap: Omit<EventSnap, "ts"> & { ts?: number }) {
    this.items.push({
      state: snap.state,
      tool: snap.tool,
      detail: snap.detail,
      project: snap.project,
      ts: snap.ts ?? Date.now(),
    });
    if (this.items.length > CAP) this.items.splice(0, this.items.length - CAP);
  }

  clear() {
    this.items = [];
  }

  /** 当前本轮轨迹（不含触发本次查询的终态事件本身之前的边界） */
  trajectory(maxN = 12): EventSnap[] {
    if (this.items.length === 0) return [];
    let start = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i].state;
      if (s === "idle" || (TERMINAL.has(s) && i < this.items.length - 1)) {
        start = i + 1;
        break;
      }
    }
    const slice = this.items.slice(start);
    return slice.length > maxN ? slice.slice(-maxN) : slice;
  }

  /** 本轮里出现过的工具名（去重保序） */
  toolsInRound(maxN = 12): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of this.trajectory(maxN)) {
      if (e.tool && !seen.has(e.tool)) {
        seen.add(e.tool);
        out.push(e.tool);
      }
    }
    return out;
  }
}
