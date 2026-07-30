<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { PetRenderer } from "./lib/renderer";
  import { STATE_MAP, animFor } from "./lib/state-machine";
  import { startEventBridge, listenSessionFilter } from "./lib/events";
  import { checkForUpdates } from "./lib/updater";
  import { PetState, type SessionMeta } from "./lib/petState";
  import { CopyQueue } from "./lib/copy/queue";
  import { EventRing } from "./lib/copy/ring";
  import type { CopyProviderId } from "./lib/copy/types";
  import type { AppSettings } from "./lib/settings";
  import { petLogicalSize, petWindowLogicalSize, PET_CHROME_TOP, PET_CHROME_BOTTOM } from "./lib/settings";
  import type { AgentState } from "./lib/types";

  let canvas: HTMLCanvasElement;
  let renderer: PetRenderer | null = null;
  let current: AgentState = "idle";
  let detail = "";
  let aiCopy = "";
  let sessionInfo = "";
  let sessionFiltered = false;
  let clickToDismiss = true;
  let terminalNotify = true;
  let showOnboarding = false;
  let petSize = 200;
  let winW = 200;
  let winH = 200 + PET_CHROME_TOP + PET_CHROME_BOTTOM;
  let prevForNotify: AgentState = "idle";
  let unlisten: UnlistenFn | undefined;
  let unlistenFilter: UnlistenFn | undefined;
  let unlistenSettings: UnlistenFn | undefined;
  let petState: PetState | null = null;
  let copyQueue: CopyQueue | null = null;
  const eventRing = new EventRing();

  $: label = STATE_MAP[current].label;
  $: isTerminal = current === "completed" || current === "error-interrupted";
  $: isError = current === "error-interrupted";
  // AI 文案优先；失败/关闭回退 detail||label；终态由 UI 追加「点击消散」
  $: bubbleText =
    (aiCopy || detail || label) + (isTerminal && clickToDismiss ? " · 点击消散" : "");

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

  function applyCopySettings(s: AppSettings) {
    const provider = (s.copyProvider === "openai" || s.copyProvider === "rules"
      ? s.copyProvider
      : "off") as CopyProviderId;
    copyQueue?.setOptions({
      copyEnabled: s.copyEnabled,
      copyProvider: provider,
      copyBaseUrl: s.copyBaseUrl ?? "",
      copyApiKey: s.copyApiKey ?? "",
      copyModel: s.copyModel ?? "",
      copyAiTerminalOnly: s.copyAiTerminalOnly === true,
    });
  }

  // 应用共享设置：换肤 + 状态持久化 + 智能文案（配置面板/右键菜单修改后实时生效）
  function applySettings(s: AppSettings) {
    clickToDismiss = s.clickToDismiss;
    terminalNotify = s.terminalNotify !== false;
    renderer?.setSkin(s.skin);
    const size = petLogicalSize(s.petScale ?? 1);
    const win = petWindowLogicalSize(s.petScale ?? 1);
    petSize = size;
    winW = win.w;
    winH = win.h;
    renderer?.setSize(size);
    petState?.setOptions({
      clickToDismiss: s.clickToDismiss,
      terminalHoldMs: s.terminalHoldMs,
      workDecayMs: s.workDecayMs,
    });
    applyCopySettings(s);
    showOnboarding = s.onboardingDone === false;
  }

  function dismissOnboarding() {
    showOnboarding = false;
    void invoke<AppSettings>("get_settings").then((s) => {
      const next = { ...s, onboardingDone: true };
      void invoke("set_settings", { settings: next });
    });
  }

  function requestCopy(s: AgentState, d: string, meta: SessionMeta) {
    if (!copyQueue) return;
    const terminal = s === "completed" || s === "error-interrupted";
    const traj = eventRing.trajectory();
    const last = traj[traj.length - 1];
    copyQueue.onDisplay({
      state: s,
      tool: last?.tool,
      detail: d,
      project: meta.lastProject,
      trajectory: traj,
      kind: terminal ? "terminal" : "work",
    });
  }

  function sourceShort(source: string): string {
    if (source === "claude-code") return "Claude";
    if (source === "codex") return "Codex";
    if (source === "cursor") return "Cursor";
    return source || "Agent";
  }

  function formatMeta(m: SessionMeta): string {
    const parts = m.lastKey.split(":");
    const source = parts[0] ?? "";
    const sid = parts.slice(1).join(":").slice(0, 6);
    const head = m.lastProject || sourceShort(source);
    const who = sid ? `${head}·${sid}` : head;
    if (m.filtered) return `锁定 ${who}`;
    if (m.count > 1) return `全部·${m.count} · ${who}`;
    return who;
  }

  onMount(async () => {
    renderer = new PetRenderer(canvas, 200);
    renderer.start();
    void renderer.loadSkins(); // 皮肤加载完即自动出现在下一帧，无需重启循环

    copyQueue = new CopyQueue();
    copyQueue.setListener((r) => {
      aiCopy = r?.text ?? "";
    });
    copyQueue.setErrorListener((msg) => {
      void emit("copy-error", msg);
    });

    petState = new PetState((s, d, meta) => {
      const was = prevForNotify;
      prevForNotify = s;
      current = s;
      detail = d;
      if (s === "idle") {
        aiCopy = "";
        eventRing.clear();
      }
      // 过滤模式下即使目标会话暂时无事件（count=0）也显示锁定目标
      sessionInfo = meta.count > 0 || meta.filtered ? formatMeta(meta) : "";
      sessionFiltered = meta.filtered;
      renderer?.setAnim(animFor(s, meta.lastTool));
      requestCopy(s, d, meta);
      // 切入终态时提醒（任务栏闪烁）；设置可关
      if (
        terminalNotify &&
        (s === "completed" || s === "error-interrupted") &&
        was !== s
      ) {
        void invoke("notify_terminal", { kind: s });
      }
    });
    unlisten = await startEventBridge((ev) => {
      if (!petState.willHandle(ev)) return;
      // 先入环再 handleEvent：onChange→requestCopy 时轨迹已含本条
      eventRing.push({
        state: ev.state,
        tool: ev.tool,
        detail: ev.detail,
        project: ev.project,
      });
      petState.handleEvent(ev);
    });
    unlistenFilter = await listenSessionFilter((key) => petState.setFilter(key));
    unlistenSettings = await listen<AppSettings>("settings-changed", (e) =>
      applySettings(e.payload)
    );
    void invoke<AppSettings>("get_settings").then(applySettings);
    void checkForUpdates(); // 静默检查更新，不阻塞宠物启动
  });
  onDestroy(() => {
    copyQueue?.destroy();
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
  style:width={`${winW}px`}
  style:height={`${winH}px`}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  oncontextmenu={onContextMenu}
>
  <div
    class="chrome-top"
    style:height={`${PET_CHROME_TOP}px`}
    style:max-width={`${Math.round(petSize * 0.98)}px`}
  >
    {#if bubbleText}
      <div class="bubble" class:terminal={isTerminal} class:error={isError}>{bubbleText}</div>
    {/if}
  </div>
  <canvas bind:this={canvas}></canvas>
  <div class="chrome-bottom" style:height={`${PET_CHROME_BOTTOM}px`} style:max-width={`${Math.round(petSize * 0.98)}px`}>
    {#if sessionInfo}
      <div
        class="session"
        class:filtered={sessionFiltered}
        title="正在监听的会话。托盘右键 → 监听会话 可切换：全部 或 某个对话"
      >
        {sessionInfo}
      </div>
    {/if}
  </div>
  {#if showOnboarding}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="onboard"
      onpointerdown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="首次提示"
    >
      <p>右键可换肤 / 点完成消散 / 托盘选会话</p>
      <button type="button" onclick={dismissOnboarding}>知道了</button>
    </div>
  {/if}
</div>

<style>
  .pet {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .chrome-top,
  .chrome-bottom {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    pointer-events: none;
    box-sizing: border-box;
  }
  canvas {
    display: block;
    flex: 0 0 auto;
  }
  .bubble {
    padding: 3px 10px;
    font: 13px/1.35 system-ui, sans-serif;
    color: #f9fafb;
    background: rgba(17, 24, 39, 0.82);
    border-radius: 12px;
    pointer-events: none;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    white-space: normal;
    text-align: center;
    word-break: break-word;
    max-width: 100%;
  }
  /* 终态气泡高亮，提醒“点我消散” */
  .bubble.terminal {
    background: rgba(5, 150, 105, 0.88); /* 完成=绿 */
    cursor: pointer;
  }
  .bubble.terminal.error {
    background: rgba(220, 38, 38, 0.88); /* 出错=红 */
  }
  .session {
    padding: 2px 8px;
    font: 11px/1.4 ui-monospace, monospace;
    color: #e2e8f0;
    background: rgba(17, 24, 39, 0.65);
    border-radius: 8px;
    white-space: nowrap;
    pointer-events: none;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .session.filtered {
    background: rgba(37, 99, 235, 0.85);
    color: #eff6ff;
  }
  .onboard {
    position: absolute;
    inset: 8px 6px auto;
    z-index: 5;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(15, 23, 42, 0.92);
    color: #f8fafc;
    font: 11px/1.45 system-ui, sans-serif;
    text-align: center;
    cursor: default;
  }
  .onboard p {
    margin: 0 0 6px;
  }
  .onboard button {
    border: 0;
    border-radius: 999px;
    padding: 3px 12px;
    background: #4f7df9;
    color: #fff;
    font: 11px/1.4 system-ui, sans-serif;
    cursor: pointer;
  }
</style>
