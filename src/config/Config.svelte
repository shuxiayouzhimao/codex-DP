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
  import brandMark from "../assets/brand/mark-128.png";

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
  let unlistenOpened: UnlistenFn | undefined;
  let tryPreview = "";
  let tryError = "";
  let trying = false;
  let copyLastError = "";

  let hooks: HooksStatus | null = null;
  let hooksLoading = false;
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

  $: filterLost =
    sessionFilter !== null && !sessions.some((s) => s.key === sessionFilter);

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
    hooksLoading = true;
    try {
      hooks = await invoke<HooksStatus>("hooks_status");
    } catch (e) {
      hooksErr = errText(e);
    } finally {
      hooksLoading = false;
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

  onMount(() => {
    // 设置与 hooks 并行；hooks 慢也不挡其它分区渲染
    void invoke<AppSettings>("get_settings").then((s) => {
      settings = s;
    });
    void refreshHooks();
    void refreshSessions();
    sessionTimer = setInterval(() => void refreshSessions(), 3000);

    void listen<AppSettings>("settings-changed", (e) => {
      settings = e.payload;
    }).then((u) => {
      unlisten = u;
    });
    void listen<string | null>("copy-error", (e) => {
      copyLastError = e.payload ?? "";
    }).then((u) => {
      unlistenCopyErr = u;
    });
    // 窗口再次显示时后台刷新（不再整页 reload）
    void listen("config-opened", () => {
      void refreshHooks();
      void refreshSessions();
    }).then((u) => {
      unlistenOpened = u;
    });
  });
  onDestroy(() => {
    unlisten?.();
    unlistenCopyErr?.();
    unlistenOpened?.();
    if (sessionTimer !== undefined) clearInterval(sessionTimer);
  });
</script>

<main>
  <header class="top">
    <div class="brand">
      <img class="mark" src={brandMark} width="40" height="40" alt="" />
      <div>
        <h1>Codex Pet</h1>
        <p class="tagline">设置 · 外观、连接与行为</p>
      </div>
    </div>
  </header>

  {#if settings}
    <section>
      <div class="section-head">
        <h2>Agent 连接</h2>
        <p class="hint">
          一键安装 hooks，把 Claude / Codex / Cursor 状态推到桌宠。需本机 Node.js。Cursor「Run」依赖
          beforeShell；streaming 仅素材+规则。
        </p>
      </div>
      {#if hooks}
        <div class="status-bar">
          <span class="pill" class:ok={hooks.nodeOk} class:bad={!hooks.nodeOk}
            >Node {hooks.nodeOk ? hooks.nodeVersion : "未找到"}</span
          >
          <span class="pill" class:ok={hooks.adaptersOk} class:bad={!hooks.adaptersOk}
            >adapters {hooks.adaptersOk ? "就绪" : "缺失"}</span
          >
          {#if hooksLoading}
            <span class="pill">刷新中…</span>
          {/if}
        </div>
        {#if !hooks.nodeOk}
          <p class="warn-hint">未检测到 Node.js，无法安装 hooks。请先安装并确保 `node` 在 PATH 中。</p>
        {/if}
        {#if !hooks.adaptersOk}
          <p class="warn-hint">找不到 adapters（安装版应随包带入）。请重装桌宠，或在仓库根目录跑开发版。</p>
        {/if}
        <div class="agent-list">
          {#each hooks.sources as s}
            <div class="agent-card">
              <div class="agent-row">
                <span
                  class="dot"
                  class:on={s.installed && !s.needsUpdate}
                  class:warn={s.installed && s.needsUpdate}
                  title={s.configPath}
                ></span>
                <div class="agent-text">
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
                </div>
                <div class="agent-actions">
                  <button
                    class="chip"
                    class:accent={s.needsUpdate}
                    disabled={hooksBusy !== ""}
                    onclick={() => void doInstall(s.source, false)}
                    >{hooksBusy === s.source + ":on" ? "…" : s.needsUpdate ? "补装" : "安装"}</button
                  >
                  <button
                    class="chip ghost"
                    disabled={hooksBusy !== "" || !s.installed}
                    onclick={() => void doInstall(s.source, true)}
                    >{hooksBusy === s.source + ":off" ? "…" : "卸载"}</button
                  >
                </div>
              </div>
              {#if s.needsUpdate && s.missingHint}
                <p class="warn-hint nested">{s.missingHint}</p>
              {/if}
            </div>
          {/each}
        </div>
        <div class="sub">
          <button class="chip ghost" disabled={hooksBusy !== ""} onclick={() => void refreshHooks()}
            >刷新状态</button
          >
          <button class="chip" disabled={hooksBusy !== ""} onclick={() => void doProbe()}
            >{hooksBusy === "probe" ? "探测中…" : "推送测试事件"}</button
          >
        </div>
      {:else}
        <p class="hint">{hooksLoading ? "正在检测 Agent 连接…" : "暂未获取到连接状态，可点「刷新状态」"}</p>
        {#if !hooksLoading}
          <div class="sub">
            <button class="chip ghost" onclick={() => void refreshHooks()}>刷新状态</button>
          </div>
        {/if}
      {/if}
      {#if hooksMsg}
        <p class="preview">{hooksMsg}</p>
      {/if}
      {#if hooksErr}
        <p class="err">{hooksErr}</p>
      {/if}
    </section>

    <section>
      <div class="section-head">
        <h2>外观</h2>
        <p class="hint">皮肤与桌宠大小；重置位置回到主屏右下。</p>
      </div>
      <div class="skins">
        {#each SKINS as s}
          <button
            class="skin"
            class:active={settings.skin === s.key}
            onclick={() => update({ skin: s.key })}
          >
            <span class="skin-frame">
              <img src={s.url} alt="" />
            </span>
            <span class="skin-name">{s.name}</span>
          </button>
        {/each}
      </div>
      <div class="sub labeled">
        <span class="sub-label">大小</span>
        <div class="seg">
          {#each SCALE_PRESETS as p}
            <button
              class="seg-btn"
              class:active={scaleActive(p.scale)}
              onclick={() => update({ petScale: p.scale })}>{p.label}</button
            >
          {/each}
        </div>
        <button class="chip ghost" onclick={() => void resetPosition()}>重置位置</button>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>监听会话</h2>
        <p class="hint">点选只听某一个对话；与托盘同步。约 180 秒无事件会从列表消失。</p>
      </div>
      <div class="sub">
        <button
          class="chip"
          class:active={sessionFilter === null}
          onclick={() => void pickSession(null)}>全部会话</button
        >
        <button class="chip ghost" onclick={() => void refreshSessions()}>刷新</button>
      </div>
      {#if filterLost}
        <div class="sess-lost">
          <p>锁定的会话已失联（约 180 秒无事件）。桌宠不会跟其它对话。</p>
          <button class="chip" onclick={() => void pickSession(null)}>回全部会话</button>
        </div>
      {/if}
      {#if sessions.length === 0}
        <p class="empty">暂无活跃会话 — 在 Agent 里操作一下就会出现</p>
      {:else}
        <div class="sess-list">
          {#each sessions as s}
            <button
              class="sess-row"
              class:active={sessionFilter === s.key}
              onclick={() => void pickSession(s.key)}
              title={s.shortId ? `${s.key}` : s.label}
            >
              <span class="sess-dot" data-state={s.state}></span>
              <span class="sess-main">
                <span class="sess-label">{s.label}</span>
                {#if s.shortId}
                  <span class="sess-sid">{s.shortId}</span>
                {/if}
              </span>
              <span class="sess-state">{s.state}</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section>
      <div class="section-head">
        <h2>完成 / 出错</h2>
        <p class="hint">终态如何消失，以及是否闪任务栏、连接提示。</p>
      </div>
      <div class="choice-group">
        <label class="choice">
          <input
            type="radio"
            name="dismiss"
            checked={settings.clickToDismiss}
            onchange={() => update({ clickToDismiss: true })}
          />
          <span class="choice-body">
            <strong>保持显示</strong>
            <small>点击桌宠确认后消失</small>
          </span>
        </label>
        <label class="choice">
          <input
            type="radio"
            name="dismiss"
            checked={!settings.clickToDismiss}
            onchange={() => update({ clickToDismiss: false })}
          />
          <span class="choice-body">
            <strong>自动消失</strong>
            <small>约 5 秒后回闲置</small>
          </span>
        </label>
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.terminalNotify !== false}
          onchange={(e) => update({ terminalNotify: e.currentTarget.checked })}
        />
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">进入完成/出错时闪烁任务栏</span>
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.connectionHints !== false}
          onchange={(e) => update({ connectionHints: e.currentTarget.checked })}
        />
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">连接提示（久无事件 / hooks 需补装）</span>
      </label>
      {#if settings.connectionHints !== false}
        <div class="sub labeled">
          <span class="sub-label">静默多久提示</span>
          <div class="seg">
            {#each [
              { ms: 15 * 60_000, label: "15 分" },
              { ms: 30 * 60_000, label: "30 分" },
              { ms: 60 * 60_000, label: "1 小时" },
            ] as p}
              <button
                class="seg-btn"
                class:active={(settings.silenceHintMs || 30 * 60_000) === p.ms}
                onclick={() => update({ silenceHintMs: p.ms })}>{p.label}</button
              >
            {/each}
          </div>
        </div>
      {/if}
      {#if settings.clickToDismiss}
        <div class="sub labeled">
          <span class="sub-label">兜底时长</span>
          <div class="seg">
            {#each HOLD_PRESETS as p}
              <button
                class="seg-btn"
                class:active={settings.terminalHoldMs === p.ms}
                onclick={() => update({ terminalHoldMs: p.ms })}>{p.label}</button
              >
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <section>
      <div class="section-head">
        <h2>工作状态衰减</h2>
        <p class="hint">思考 / 执行中若长时间没有新事件，多久后回到闲置。</p>
      </div>
      <div class="seg full">
        {#each DECAY_PRESETS as p}
          <button
            class="seg-btn"
            class:active={settings.workDecayMs === p.ms}
            onclick={() => update({ workDecayMs: p.ms })}>{p.label}</button
          >
        {/each}
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>智能文案</h2>
        <p class="hint">
          气泡人格短句与终态摘要。默认关；失败回退原 tip。Key 仅存本机。
        </p>
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.copyEnabled}
          onchange={(e) => update({ copyEnabled: e.currentTarget.checked })}
        />
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">启用智能文案</span>
      </label>
      {#if settings.copyEnabled}
        <div class="sub labeled">
          <span class="sub-label">模式</span>
          <div class="seg">
            <button
              class="seg-btn"
              class:active={settings.copyProvider === "rules"}
              onclick={() => update({ copyProvider: "rules" })}>规则模板</button
            >
            <button
              class="seg-btn"
              class:active={settings.copyProvider === "openai"}
              onclick={() => update({ copyProvider: "openai" })}>OpenAI 兼容</button
            >
          </div>
        </div>
        {#if settings.copyProvider === "openai"}
          <label class="toggle">
            <input
              type="checkbox"
              checked={settings.copyAiTerminalOnly === true}
              onchange={(e) => update({ copyAiTerminalOnly: e.currentTarget.checked })}
            />
            <span class="switch" aria-hidden="true"></span>
            <span class="toggle-text">仅终态走 API（工作态用规则）</span>
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
      <div class="section-head">
        <h2>系统</h2>
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.autostart}
          onchange={(e) => update({ autostart: e.currentTarget.checked })}
        />
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">开机自启</span>
      </label>
    </section>
  {:else}
    <p class="empty">加载中…</p>
  {/if}
</main>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    min-height: 100%;
  }
  :global(html) {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  :global(html::-webkit-scrollbar) {
    width: 0;
    height: 0;
    display: none;
  }
  :global(body) {
    font-family: "Plus Jakarta Sans", "Segoe UI Variable Text", "Microsoft YaHei UI", sans-serif;
    font-weight: 450;
    color: var(--ink);
    overflow-y: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    background:
      radial-gradient(120% 80% at 100% -10%, rgba(13, 148, 136, 0.14), transparent 55%),
      radial-gradient(90% 60% at -10% 40%, rgba(56, 189, 248, 0.1), transparent 50%),
      linear-gradient(165deg, #eef3f7 0%, #e8eef4 48%, #e4ebe8 100%);
    background-attachment: fixed;
  }
  :global(body::-webkit-scrollbar) {
    width: 0;
    height: 0;
    display: none;
  }
  :global(#app) {
    --ink: #0f1c24;
    --muted: #5b6b76;
    --line: rgba(15, 28, 36, 0.08);
    --card: rgba(255, 255, 255, 0.78);
    --card-solid: #ffffff;
    --accent: #0f766e;
    --accent-strong: #0d9488;
    --accent-soft: rgba(13, 148, 136, 0.12);
    --warn: #b45309;
    --warn-bg: #fff8eb;
    --danger: #b91c1c;
    --danger-bg: #fef2f2;
    --ok: #16a34a;
    --radius: 16px;
    --shadow: 0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 10px 28px rgba(15, 28, 36, 0.06);
  }

  main {
    padding: 0 28px 36px;
    max-width: 640px;
    margin: 0 auto;
  }

  .top {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 18px 0 14px;
    margin: 0 -4px 4px;
    background: linear-gradient(180deg, rgba(238, 243, 247, 0.96) 40%, rgba(238, 243, 247, 0));
    backdrop-filter: blur(8px);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .mark {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    object-fit: cover;
    background: #0f766e;
    box-shadow: 0 6px 16px rgba(13, 148, 136, 0.28);
    flex-shrink: 0;
  }
  h1 {
    font-size: 22px;
    font-weight: 750;
    letter-spacing: -0.03em;
    margin: 0;
    line-height: 1.15;
  }
  .tagline {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
    font-weight: 450;
  }

  section {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 16px 16px 14px;
    margin-bottom: 12px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(12px);
  }
  .section-head {
    margin-bottom: 12px;
  }
  h2 {
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.02em;
    text-transform: none;
    margin: 0 0 4px;
    color: var(--ink);
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .status-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }
  .pill {
    font-size: 11px;
    font-weight: 550;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(15, 28, 36, 0.05);
    color: var(--muted);
  }
  .pill.ok {
    background: rgba(22, 163, 74, 0.12);
    color: #15803d;
  }
  .pill.bad {
    background: rgba(245, 158, 11, 0.15);
    color: var(--warn);
  }

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .agent-card {
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.65);
    border: 1px solid var(--line);
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .agent-name {
    font-weight: 650;
    font-size: 13px;
  }
  .agent-state {
    font-size: 11px;
    color: var(--muted);
  }
  .agent-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #cbd5e1;
    flex-shrink: 0;
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.15);
  }
  .dot.on {
    background: var(--ok);
    box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.18);
  }
  .dot.warn {
    background: #f59e0b;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.2);
  }
  .warn-hint {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: var(--warn-bg);
    border-radius: 10px;
    color: var(--warn);
    font-size: 12px;
    line-height: 1.45;
    border: 1px solid rgba(180, 83, 9, 0.12);
  }
  .warn-hint.nested {
    margin-left: 0;
  }

  .skins {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .skin {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 8px;
    border: 1.5px solid var(--line);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }
  .skin:hover {
    border-color: rgba(15, 118, 110, 0.35);
    transform: translateY(-1px);
  }
  .skin.active {
    border-color: var(--accent-strong);
    background: var(--accent-soft);
    box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.18);
  }
  .skin-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 88px;
    border-radius: 10px;
    background: linear-gradient(180deg, #f8fafc, #eef2f6);
    overflow: hidden;
  }
  .skin img {
    height: 80px;
    object-fit: contain;
  }
  .skin-name {
    font-size: 12px;
    font-weight: 550;
    text-align: center;
    color: var(--ink);
  }

  .sub {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 12px;
    color: var(--muted);
  }
  .sub.labeled {
    align-items: center;
  }
  .sub-label {
    font-size: 12px;
    font-weight: 550;
    color: var(--muted);
    min-width: 4.5em;
  }

  .seg {
    display: inline-flex;
    padding: 3px;
    border-radius: 10px;
    background: rgba(15, 28, 36, 0.06);
    gap: 2px;
  }
  .seg.full {
    display: flex;
    width: 100%;
    margin-top: 0;
  }
  .seg.full .seg-btn {
    flex: 1;
  }
  .seg-btn {
    border: 0;
    background: transparent;
    padding: 5px 12px;
    border-radius: 8px;
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    color: var(--muted);
    cursor: pointer;
  }
  .seg-btn.active {
    background: var(--card-solid);
    color: var(--accent);
    box-shadow: 0 1px 3px rgba(15, 28, 36, 0.08);
  }

  .chip {
    padding: 5px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--card-solid);
    color: var(--ink);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .chip:hover:not(:disabled) {
    border-color: rgba(15, 118, 110, 0.35);
  }
  .chip:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .chip.active {
    border-color: transparent;
    background: var(--accent-strong);
    color: #fff;
  }
  .chip.ghost {
    background: transparent;
  }
  .chip.accent {
    border-color: rgba(245, 158, 11, 0.45);
    color: var(--warn);
    background: var(--warn-bg);
  }

  .choice-group {
    display: grid;
    gap: 8px;
    margin-bottom: 10px;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1.5px solid var(--line);
    background: rgba(255, 255, 255, 0.65);
    cursor: pointer;
  }
  .choice:has(input:checked) {
    border-color: var(--accent-strong);
    background: var(--accent-soft);
  }
  .choice input {
    margin-top: 3px;
    accent-color: var(--accent-strong);
  }
  .choice-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .choice-body strong {
    font-size: 13px;
    font-weight: 650;
  }
  .choice-body small {
    font-size: 11px;
    color: var(--muted);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    cursor: pointer;
    user-select: none;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch {
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: #cbd5e1;
    position: relative;
    flex-shrink: 0;
    transition: background 0.15s ease;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
    transition: transform 0.15s ease;
  }
  .toggle input:checked + .switch {
    background: var(--accent-strong);
  }
  .toggle input:checked + .switch::after {
    transform: translateX(16px);
  }
  .toggle input:focus-visible + .switch {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }
  .toggle-text {
    font-size: 13px;
    font-weight: 500;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 10px;
    font-size: 12px;
    font-weight: 550;
    color: var(--muted);
  }
  .field input {
    padding: 9px 12px;
    border: 1.5px solid var(--line);
    border-radius: 10px;
    font: inherit;
    font-size: 13px;
    font-weight: 450;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.9);
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .field input:focus {
    outline: none;
    border-color: var(--accent-strong);
    box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.15);
  }
  .field input::placeholder {
    color: #94a3b8;
  }

  .preview {
    margin: 10px 0 0;
    padding: 8px 12px;
    background: var(--accent-soft);
    border-radius: 10px;
    color: var(--accent);
    font-size: 13px;
    border: 1px solid rgba(13, 148, 136, 0.15);
  }
  .err {
    margin: 10px 0 0;
    padding: 8px 12px;
    background: var(--danger-bg);
    border-radius: 10px;
    color: var(--danger);
    font-size: 12px;
    border: 1px solid rgba(185, 28, 28, 0.12);
  }
  .empty {
    margin: 10px 0 0;
    padding: 14px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    border-radius: 12px;
    background: rgba(15, 28, 36, 0.03);
    border: 1px dashed var(--line);
  }

  .sess-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }
  .sess-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    border: 1.5px solid var(--line);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .sess-row:hover {
    border-color: rgba(15, 118, 110, 0.3);
  }
  .sess-row.active {
    border-color: var(--accent-strong);
    background: var(--accent-soft);
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
    background: #0ea5e9;
  }
  .sess-dot[data-state="completed"] {
    background: var(--ok);
  }
  .sess-dot[data-state="error-interrupted"] {
    background: #ef4444;
  }
  .sess-dot[data-state="permission-prompt"],
  .sess-dot[data-state="ask-user"] {
    background: #f59e0b;
  }
  .sess-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sess-label {
    font-size: 13px;
    font-weight: 550;
  }
  .sess-sid {
    font-size: 11px;
    color: var(--muted);
    font-family: ui-monospace, monospace;
  }
  .sess-state {
    font-size: 11px;
    color: var(--muted);
  }
  .sess-lost {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1.5px solid rgba(180, 83, 9, 0.35);
    background: rgba(255, 247, 237, 0.95);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .sess-lost p {
    margin: 0;
    flex: 1;
    font-size: 12px;
    color: #9a3412;
    line-height: 1.45;
  }
</style>
