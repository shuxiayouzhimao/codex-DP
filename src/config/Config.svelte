<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import spriteGreenUrl from "../assets/sprites/sprite-green.png";
  import spriteRedUrl from "../assets/sprites/sprite-red.png";

  /** 与 Rust Settings 一致（camelCase） */
  interface Settings {
    skin: string;
    clickToDismiss: boolean;
    terminalHoldMs: number;
    workDecayMs: number;
    autostart: boolean;
  }

  const SKINS = [
    { key: "green", name: "绿毛衣", url: spriteGreenUrl },
    { key: "red", name: "红装", url: spriteRedUrl },
  ];
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

  let settings: Settings | null = null;
  let unlisten: UnlistenFn | undefined;

  /** 本地改动 → 写后端（后端落盘并广播 settings-changed，主宠物即时生效） */
  function update(patch: Partial<Settings>) {
    if (!settings) return;
    settings = { ...settings, ...patch };
    void invoke("set_settings", { settings });
  }

  onMount(async () => {
    settings = await invoke<Settings>("get_settings");
    // 右键菜单换肤等外部改动也反映到面板
    unlisten = await listen<Settings>("settings-changed", (e) => {
      settings = e.payload;
    });
  });
  onDestroy(() => unlisten?.());
</script>

<main>
  <h1>Codex Pet 设置</h1>

  {#if settings}
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
</style>
