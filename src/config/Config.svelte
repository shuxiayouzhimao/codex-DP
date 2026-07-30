<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { CopyQueue } from "../lib/copy/queue";
  import type { AppSettings } from "../lib/settings";
  import type { CopyProviderId } from "../lib/copy/types";
  import type { HooksStatus } from "../lib/hooks-status";
  import type { SessionListEntry } from "../lib/session-list";
  import { listSkinOptions } from "../lib/skins";

  const SKINS = listSkinOptions();
  const HOLD_PRESETS = [
    { ms: 10 * 60_000, label: "10 分钟" },
    { ms: 30 * 60_000, label: "30 分钟" },
    { ms: 60 * 60_000, label: "1 小时" },
  ];
  const DECAY_PRESETS = [
    { ms: 60_000, label: "1 分钟" },
    { ms: 5 * 60_000, label: "5 分钟" },
    { ms: 15 * 60_000, label: "15 分钟" },
  ];
  const SCALE_PRESETS = [
    { scale: 0.75, label: "小" },
    { scale: 1, label: "中" },
    { scale: 1.4, label: "大" },
  ];

  let settings: AppSettings | null = null;
  let unlisten: UnlistenFn | undefined;
  let unlistenCopyErr: UnlistenFn | undefined;
  let tryPreview = "";
  let tryError = "";
  let trying = false;
  let copyLastError = "";

  let hooks: HooksStatus | null = null;
  let hooksBusy = "";
  let hooksMsg = "";
  let hooksErr = "";

  let sessions: SessionListEntry[] = [];
  let sessionFilter: string | null = null;
  let sessionTimer: ReturnType<typeof setInterval> | undefined;

  /** 本地改动 → 写后端（后端落盘并广播 settings-changed，主宠物即时生效） */
  function update(patch: Partial<AppSettings>) {
    if (!settings) return;
    settings = { ...settings, ...patch };
    void invoke("set_settings", { settings });
  }

  function scaleActive(scale: number): boolean {
    return Math.abs((settings?.petScale ?? 1) - scale) < 0.05;
  }

  async function refreshSessions() {
    try {
      sessions = await invoke<SessionListEntry[]>("list_sessions");
      sessionFilter = await invoke<string | null>("get_session_filter");
    } catch {
      /* ignore */
    }
  }

  async function pickSession(key: string | null) {
    sessionFilter = key;
    await invoke("set_session_filter", { key });
    await refreshSessions();
  }

  function errText(e: unknown): string {
    if (typeof e === "string") return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === "object" && "message" in e) {
      return String((e as { message: unknown }).message);
    }
    return String(e);
  }

  async function resetPosition() {
    try {
      await invoke("reset_pet_position");
    } catch (e) {
      hooksErr = errText(e);
    }
  }

  async function refreshHooks() {
    try {
      hooks = await invoke<HooksStatus>("hooks_status");
    } catch (e) {
      hooksErr = errText(e);
    }
  }

  async function doInstall(source: string, uninstall: boolean) {
    hooksBusy = source + (uninstall ? ":off" : ":on");
    hooksMsg = "";
    hooksErr = "";
    try {
      const msg = await invoke<string>(uninstall ? "uninstall_hooks" : "install_hooks", {
        source,
      });
      hooksMsg = msg;
      await refreshHooks();
    } catch (e) {
      hooksErr = errText(e);
    } finally {
      hooksBusy = "";
    }
  }

  async function doProbe() {
    hooksBusy = "probe";
    hooksMsg = "";
    hooksErr = "";
    try {
      hooksMsg = await invoke<string>("probe_event_channel");
    } catch (e) {
      hooksErr = errText(e);
    } finally {
      hooksBusy = "";
    }
  }

  async function tryWrite() {
    if (!settings || trying) return;
    trying = true;
    tryPreview = "";
    tryError = "";
    const q = new CopyQueue();
    q.setOptions({
      copyEnabled: true,
      copyProvider: (settings.copyProvider === "openai" ? "openai" : "rules") as CopyProviderId,
      copyBaseUrl: settings.copyBaseUrl,
      copyApiKey: settings.copyApiKey,
      copyModel: settings.copyModel,
    });
    try {
      // 先把当前设置写入，确保 openai 模式 Rust 读到最新 Key
      await invoke("set_settings", { settings });
      const text = await q.tryWrite({
        state: "tool-use",
        tool: "Grep",
        detail: "执行 Grep",
        project: "codex-DP",
        trajectory: [
          { state: "thinking", detail: "思考中", ts: 1 },
          { state: "tool-use", tool: "Grep", detail: "执行 Grep", ts: 2 },
          { state: "completed", detail: "完成", ts: 3 },
        ],
        kind: "terminal",
      });
      tryPreview = text;
    } catch (e) {
      tryError = e instanceof Error ? e.message : String(e);
      copyLastError = tryError;
    } finally {
      trying = false;
    }
  }

  onMount(async () => {
    settings = await invoke<AppSettings>("get_settings");
    // 右键菜单换肤等外部改动也反映到面板
    unlisten = await listen<AppSettings>("settings-changed", (e) => {
      settings = e.payload;
    });
    unlistenCopyErr = await listen<string | null>("copy-error", (e) => {
      copyLastError = e.payload ?? "";
    });
    void refreshHooks();
    void refreshSessions();
    sessionTimer = setInterval(() => void refreshSessions(), 3000);
  });
  onDestroy(() => {
    unlisten?.();
    unlistenCopyErr?.();
    if (sessionTimer !== undefined) clearInterval(sessionTimer);
  });
</script>

<main>
  <h1>Codex Pet 设置</h1>

  {#if settings}
    <section>
      <h2>Agent 连接</h2>
      <p class="hint">
        一键安装 hooks，让 Claude Code / Codex / Cursor 把状态推到桌宠。需要本机已装 Node.js。
        Cursor 点「Run」依赖 beforeShellExecution / beforeMCPExecution（安装后才有）；无统一审批 hook，不能代点批准。streaming 仅素材+规则。校准用 PET_DEBUG=1。
      </p>
      {#if hooks}
        <p class="meta">
          Node：{hooks.nodeOk ? hooks.nodeVersion : "未找到"}
          · adapters：{hooks.adaptersOk ? "就绪" : "缺失"}
        </p>
        {#if !hooks.nodeOk}
          <p class="warn-hint">未检测到 Node.js，无法安装 hooks。请先安装 Node 并确保 `node` 在 PATH 中。</p>
        {/if}
        {#if !hooks.adaptersOk}
          <p class="warn-hint">找不到 adapters（安装版应随包带入）。请重装桌宠，或在仓库根目录跑开发版。</p>
        {/if}
        {#each hooks.sources as s}
          <div class="agent-block">
            <div class="agent-row">
              <span
                class="dot"
                class:on={s.installed && !s.needsUpdate}
                class:warn={s.installed && s.needsUpdate}
                title={s.configPath}
              ></span>
              <span class="agent-name">{s.label}</span>
              <span class="agent-state">
                {#if !s.installed}
                  未安装
                {:else if s.needsUpdate}
                  需更新
                {:else}
                  已安装
                {/if}
              </span>
              <button
                class="chip"
                class:accent={s.needsUpdate}
                disabled={hooksBusy !== ""}
                onclick={() => void doInstall(s.source, false)}
                >{hooksBusy === s.source + ":on" ? "…" : s.needsUpdate ? "补装" : "安装"}</button
              >
              <button
                class="chip"
                disabled={hooksBusy !== "" || !s.installed}
                onclick={() => void doInstall(s.source, true)}
                >{hooksBusy === s.source + ":off" ? "…" : "卸载"}</button
              >
            </div>
            {#if s.needsUpdate && s.missingHint}
              <p class="warn-hint">{s.missingHint}</p>
            {/if}
          </div>
        {/each}
        <div class="sub">
          <button class="chip" disabled={hooksBusy !== ""} onclick={() => void refreshHooks()}
            >刷新状态</button
          >
          <button class="chip" disabled={hooksBusy !== ""} onclick={() => void doProbe()}
            >{hooksBusy === "probe" ? "探测中…" : "推送测试事件"}</button
          >
        </div>
      {:else}
        <p class="hint">加载 hooks 状态…</p>
      {/if}
      {#if hooksMsg}
        <p class="preview">{hooksMsg}</p>
      {/if}
      {#if hooksErr}
        <p class="err">{hooksErr}</p>
      {/if}
    </section>

    <section>
      <h2>皮肤</h2>
      <div class="skins">
        {#each SKINS as s}
          <button
            class="skin"
            class:active={settings.skin === s.key}
            onclick={() => update({ skin: s.key })}
          >
            <img src={s.url} alt={s.name} />
            <span>{s.name}</span>
          </button>
        {/each}
      </div>
      <div class="sub">
        大小：
        {#each SCALE_PRESETS as p}
          <button
            class="chip"
            class:active={scaleActive(p.scale)}
            onclick={() => update({ petScale: p.scale })}>{p.label}</button
          >
        {/each}
        <button class="chip" onclick={() => void resetPosition()}>重置位置</button>
      </div>
    </section>

    <section>
      <h2>监听会话</h2>
      <p class="hint">点选只听某一个对话；与托盘「监听会话」同步。列表约 90 秒无事件会消失。</p>
      <div class="sub">
        <button
          class="chip"
          class:active={sessionFilter === null}
          onclick={() => void pickSession(null)}>全部会话</button
        >
        <button class="chip" onclick={() => void refreshSessions()}>刷新</button>
      </div>
      {#if sessions.length === 0}
        <p class="hint">暂无活跃会话（在 Agent 里操作一下就会出现）</p>
      {:else}
        {#each sessions as s}
          <button
            class="sess-row"
            class:active={sessionFilter === s.key}
            onclick={() => void pickSession(s.key)}
          >
            <span class="sess-dot" data-state={s.state}></span>
            <span class="sess-label">{s.label}</span>
            <span class="sess-state">{s.state}</span>
          </button>
        {/each}
      {/if}
    </section>

    <section>
      <h2>完成 / 出错提醒</h2>
      <label class="row">
        <input
          type="radio"
          name="dismiss"
          checked={settings.clickToDismiss}
          onchange={() => update({ clickToDismiss: true })}
        />
        保持显示，点击桌宠确认后消失
      </label>
      <label class="row">
        <input
          type="radio"
          name="dismiss"
          checked={!settings.clickToDismiss}
          onchange={() => update({ clickToDismiss: false })}
        />
        显示 5 秒后自动消失
      </label>
      <label class="row">
        <input
          type="checkbox"
          checked={settings.terminalNotify !== false}
          onchange={(e) => update({ terminalNotify: e.currentTarget.checked })}
        />
        进入完成/出错时闪烁任务栏提醒
      </label>
      {#if settings.clickToDismiss}
        <div class="sub">
          兜底时长（超时自动消失）：
          {#each HOLD_PRESETS as p}
            <button
              class="chip"
              class:active={settings.terminalHoldMs === p.ms}
              onclick={() => update({ terminalHoldMs: p.ms })}>{p.label}</button
            >
          {/each}
        </div>
      {/if}
    </section>

    <section>
      <h2>工作状态衰减</h2>
      <p class="hint">思考 / 执行中若长时间没有新事件，多久后回到闲置（防卡死）。</p>
      <div class="sub">
        {#each DECAY_PRESETS as p}
          <button
            class="chip"
            class:active={settings.workDecayMs === p.ms}
            onclick={() => update({ workDecayMs: p.ms })}>{p.label}</button
          >
        {/each}
      </div>
    </section>

    <section>
      <h2>智能文案</h2>
      <p class="hint">
        给气泡加人格短句，终态生成一句话摘要。默认关闭；失败时回退原来的工具/状态文案。API Key
        仅存本机，不会打进日志。
      </p>
      <label class="row">
        <input
          type="checkbox"
          checked={settings.copyEnabled}
          onchange={(e) => update({ copyEnabled: e.currentTarget.checked })}
        />
        启用智能文案
      </label>
      {#if settings.copyEnabled}
        <div class="sub">
          模式：
          <button
            class="chip"
            class:active={settings.copyProvider === "rules"}
            onclick={() => update({ copyProvider: "rules" })}>规则模板</button
          >
          <button
            class="chip"
            class:active={settings.copyProvider === "openai"}
            onclick={() => update({ copyProvider: "openai" })}>OpenAI 兼容</button
          >
        </div>
        {#if settings.copyProvider === "openai"}
          <label class="row">
            <input
              type="checkbox"
              checked={settings.copyAiTerminalOnly === true}
              onchange={(e) => update({ copyAiTerminalOnly: e.currentTarget.checked })}
            />
            仅终态走 API（工作态用规则模板，省调用）
          </label>
          <label class="field">
            <span>Base URL</span>
            <input
              type="url"
              placeholder="https://api.deepseek.com/v1"
              value={settings.copyBaseUrl}
              onchange={(e) => update({ copyBaseUrl: e.currentTarget.value.trim() })}
            />
          </label>
          <label class="field">
            <span>API Key</span>
            <input
              type="password"
              placeholder="sk-…"
              value={settings.copyApiKey}
              onchange={(e) => update({ copyApiKey: e.currentTarget.value.trim() })}
            />
          </label>
          <label class="field">
            <span>Model</span>
            <input
              type="text"
              placeholder="deepseek-chat（可空）"
              value={settings.copyModel}
              onchange={(e) => update({ copyModel: e.currentTarget.value.trim() })}
            />
          </label>
          {#if copyLastError}
            <p class="err">上次 API 错误：{copyLastError}</p>
          {/if}
        {/if}
        <div class="sub">
          <button class="chip" disabled={trying} onclick={() => void tryWrite()}>
            {trying ? "试写中…" : "试写一句（终态摘要）"}
          </button>
        </div>
        {#if tryPreview}
          <p class="preview">预览：{tryPreview}</p>
        {/if}
        {#if tryError}
          <p class="err">{tryError}</p>
        {/if}
      {/if}
    </section>

    <section>
      <h2>系统</h2>
      <label class="row">
        <input
          type="checkbox"
          checked={settings.autostart}
          onchange={(e) => update({ autostart: e.currentTarget.checked })}
        />
        开机自启（登录 Windows 后自动运行）
      </label>
    </section>
  {:else}
    <p>加载中…</p>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font: 14px/1.6 system-ui, sans-serif;
    color: #1f2937;
    background: #f8fafc;
  }
  main {
    padding: 20px 24px 28px;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 16px;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 10px;
    color: #334155;
  }
  section {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .skins {
    display: flex;
    gap: 12px;
  }
  .skin {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border: 2px solid #e2e8f0;
    border-radius: 10px;
    background: #fff;
    cursor: pointer;
  }
  .skin.active {
    border-color: #4f7df9;
    background: #eff4ff;
  }
  .skin img {
    height: 96px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    cursor: pointer;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
    color: #475569;
  }
  .chip {
    padding: 3px 12px;
    border: 1px solid #cbd5e1;
    border-radius: 999px;
    background: #fff;
    cursor: pointer;
  }
  .chip:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .chip.active {
    border-color: #4f7df9;
    background: #4f7df9;
    color: #fff;
  }
  .hint {
    margin: 0 0 6px;
    color: #64748b;
    font-size: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 10px;
    font-size: 12px;
    color: #475569;
  }
  .field input {
    padding: 6px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    font: 13px/1.4 system-ui, sans-serif;
  }
  .preview {
    margin: 8px 0 0;
    padding: 6px 10px;
    background: #eff6ff;
    border-radius: 8px;
    color: #1e40af;
    font-size: 13px;
  }
  .err {
    margin: 8px 0 0;
    padding: 6px 10px;
    background: #fef2f2;
    border-radius: 8px;
    color: #b91c1c;
    font-size: 12px;
  }
  .meta {
    margin: 0 0 8px;
    font-size: 12px;
    color: #64748b;
  }
  .agent-block {
    padding: 4px 0 8px;
    border-bottom: 1px solid #f1f5f9;
  }
  .agent-block:last-of-type {
    border-bottom: none;
    padding-bottom: 0;
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #cbd5e1;
    flex-shrink: 0;
  }
  .dot.on {
    background: #22c55e;
  }
  .dot.warn {
    background: #f59e0b;
  }
  .warn-hint {
    margin: 4px 0 0 16px;
    padding: 6px 10px;
    background: #fffbeb;
    border-radius: 8px;
    color: #b45309;
    font-size: 12px;
    line-height: 1.4;
  }
  .chip.accent {
    border-color: #f59e0b;
    color: #b45309;
    background: #fffbeb;
  }
  .agent-name {
    font-weight: 600;
    min-width: 96px;
  }
  .agent-state {
    flex: 1;
    font-size: 12px;
    color: #64748b;
  }
  .sess-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin-top: 6px;
    padding: 8px 10px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #fff;
    cursor: pointer;
    text-align: left;
  }
  .sess-row.active {
    border-color: #4f7df9;
    background: #eff4ff;
  }
  .sess-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #94a3b8;
    flex-shrink: 0;
  }
  .sess-dot[data-state="thinking"],
  .sess-dot[data-state="tool-use"],
  .sess-dot[data-state="streaming"] {
    background: #3b82f6;
  }
  .sess-dot[data-state="completed"] {
    background: #22c55e;
  }
  .sess-dot[data-state="error-interrupted"] {
    background: #ef4444;
  }
  .sess-dot[data-state="permission-prompt"],
  .sess-dot[data-state="ask-user"] {
    background: #f59e0b;
  }
  .sess-label {
    flex: 1;
    font-size: 13px;
  }
  .sess-state {
    font-size: 11px;
    color: #64748b;
  }
</style>
