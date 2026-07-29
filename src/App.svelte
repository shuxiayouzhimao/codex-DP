<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { PetRenderer } from "./lib/renderer";
  import { STATE_MAP } from "./lib/state-machine";
  import { startEventBridge, listenSessionFilter } from "./lib/events";
  import { checkForUpdates } from "./lib/updater";
  import { PetState, type SessionMeta } from "./lib/petState";
  import type { AgentState } from "./lib/types";

  /** 后端共享设置（Rust Settings，camelCase） */
  interface Settings {
    skin: string;
    clickToDismiss: boolean;
    terminalHoldMs: number;
    workDecayMs: number;
    autostart: boolean;
  }

  let canvas: HTMLCanvasElement;
  let renderer: PetRenderer | null = null;
  let current: AgentState = "idle";
  let detail = "";
  let sessionInfo = "";
  let clickToDismiss = true;
  let unlisten: UnlistenFn | undefined;
  let unlistenFilter: UnlistenFn | undefined;
  let unlistenSettings: UnlistenFn | undefined;
  let petState: PetState | null = null;

  $: label = STATE_MAP[current].label;
  $: isTerminal = current === "completed" || current === "error-interrupted";
  $: isError = current === "error-interrupted";
  // 终态附加“点击消散”提示（仅当设置要求点击确认时）
  $: bubbleText = (detail || label) + (isTerminal && clickToDismiss ? " · 点击消散" : "");

  // 拖拽 vs 点击：按下不立即拖拽；移动超阈值才 startDragging（OS 原生拖拽，自动处理 DPI）；
  // 无移动则为点击 → 确认“完成/出错”终态。
  const appWindow = getCurrentWindow();
  const DRAG_THRESHOLD = 6; // px
  let press: { x: number; y: number; dragging: boolean } | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY, dragging: false };
  }
  function onPointerMove(e: PointerEvent) {
    if (!press || press.dragging) return;
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      press.dragging = true;
      void appWindow.startDragging();
    }
  }
  function onPointerUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (press && !press.dragging) petState?.dismissTerminal();
    press = null;
  }

  // 右键：弹原生菜单（与托盘菜单同一套，含 换肤/监听会话/设置…）
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    void invoke("show_pet_menu");
  }

  // 应用共享设置：换肤 + 状态持久化选项（配置面板/右键菜单修改后实时生效）
  function applySettings(s: Settings) {
    clickToDismiss = s.clickToDismiss;
    renderer?.setSkin(s.skin);
    petState?.setOptions({
      clickToDismiss: s.clickToDismiss,
      terminalHoldMs: s.terminalHoldMs,
      workDecayMs: s.workDecayMs,
    });
  }

  function formatMeta(m: SessionMeta): string {
    const parts = m.lastKey.split(":");
    const source = parts[0] ?? "";
    const sid = parts.slice(1).join(":").slice(0, 6);
    const head = m.lastProject || source;
    const base = sid ? `${head}·${sid}` : head;
    const extra = m.count > 1 ? ` +${m.count - 1}` : "";
    return (m.filtered ? "🎯 " : "") + base + extra;
  }

  onMount(async () => {
    renderer = new PetRenderer(canvas, 200);
    renderer.start();
    void renderer.loadSkins(); // 皮肤加载完即自动出现在下一帧，无需重启循环

    petState = new PetState((s, d, meta) => {
      current = s;
      detail = d;
      // 过滤模式下即使目标会话暂时无事件（count=0）也显示锁定目标
      sessionInfo = meta.count > 0 || meta.filtered ? formatMeta(meta) : "";
      renderer?.setAnim(STATE_MAP[s].anim);
    });
    unlisten = await startEventBridge((ev) => petState.handleEvent(ev));
    unlistenFilter = await listenSessionFilter((key) => petState.setFilter(key));
    unlistenSettings = await listen<Settings>("settings-changed", (e) =>
      applySettings(e.payload)
    );
    void invoke<Settings>("get_settings").then(applySettings);
    void checkForUpdates(); // 静默检查更新，不阻塞宠物启动
  });
  onDestroy(() => {
    renderer?.stop();
    unlisten?.();
    unlistenFilter?.();
    unlistenSettings?.();
  });
</script>

<!-- 桌宠交互面：静态 div 承载 pointer 事件（拖拽移动 + 点击确认终态），非 Web 表单，无需键盘交互 -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pet"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  oncontextmenu={onContextMenu}
>
  <canvas bind:this={canvas}></canvas>
  <div class="bubble" class:terminal={isTerminal} class:error={isError}>{bubbleText}</div>
  {#if sessionInfo}
    <div
      class="session"
      title="正在监听的会话。托盘右键 → 监听会话 可切换：全部 或 某个对话"
    >
      {sessionInfo}
    </div>
  {/if}
</div>

<style>
  .pet {
    position: relative;
    width: 200px;
    height: 200px;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  canvas {
    display: block;
  }
  .bubble {
    position: absolute;
    top: 2px;
    left: 50%;
    transform: translateX(-50%);
    padding: 2px 10px;
    font: 12px/1.6 system-ui, sans-serif;
    color: #f9fafb;
    background: rgba(17, 24, 39, 0.78);
    border-radius: 999px;
    white-space: nowrap;
    pointer-events: none;
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 终态气泡高亮，提醒“点我消散” */
  .bubble.terminal {
    background: rgba(5, 150, 105, 0.85); /* 完成=绿 */
    cursor: pointer;
  }
  .bubble.terminal.error {
    background: rgba(220, 38, 38, 0.85); /* 出错=红 */
  }
  .session {
    position: absolute;
    bottom: 2px;
    left: 50%;
    transform: translateX(-50%);
    padding: 1px 8px;
    font: 10px/1.5 ui-monospace, monospace;
    color: #cbd5e1;
    background: rgba(17, 24, 39, 0.6);
    border-radius: 999px;
    white-space: nowrap;
    pointer-events: none;
  }
</style>
