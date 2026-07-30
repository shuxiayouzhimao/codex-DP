# AGENTS.md — Codex Pet 贡献与二次开发约定

面向在本仓库改代码的人或 Agent。产品说明见 `README.md`；决策与排障见 `进度记录.md`。

## 项目是什么

Windows 桌宠（Tauri 2 + Svelte 5）：各编程 Agent 经 hooks 推送状态，桌宠用动画/气泡反映思考、工具、审批、完成、出错。

## 不可破坏的约束

1. **Push 模型**：`hooks → pet-bridge → POST 127.0.0.1:4271/event → Rust → emit → 前端`。不要改成轮询或 WebSocket（除非有充分理由并更新文档）。
2. **适配器零阻塞**：`pet-bridge` / hooks 命令必须永远 `exit(0)`、短超时（约 1s）、桌宠未运行时静默失败。**禁止**用 exit 2 等信号拦截 Agent 工具。
3. **统一事件协议**：`{ source, sessionId, event, state, tool?, detail?, project?, timestamp }`。新状态先扩 `src/lib/types.ts` 与映射，再动动画。
4. **单端口 4271**：dev 与安装版不要同时跑。

## 扩展点（优先改这里）

| 目标 | 入口 |
|------|------|
| 新 Agent / 事件映射 | `adapters/lib/event-map.mjs` + `adapters/<agent>/install-hooks.mjs`；桥接入口仍是 `adapters/claude-code/pet-bridge.mjs` |
| 新皮肤 | `tools/cutout.py` → `src/assets/sprites/` → `renderer.ts` / `Config.svelte` / `lib.rs` 菜单 |
| 新帧动画皮肤 | `tools/video_frames.py`（视频抽帧）→ `src/assets/frames/<key>/` → 同上加一条；视频规格见 `data/Character Vedio/视频需求.md` |
| 动画参数 | `src/assets/config/animations.json` |
| 状态→文案/优先级 | `src/lib/state-machine.ts` |
| 衰减/终态策略 | `src/lib/petState.ts` |
| 设置项 | `Settings`（`src-tauri/src/lib.rs`）+ `src/config/Config.svelte`；走现有 `set_settings` + `settings-changed` |
| 外部任意工具 | `POST /event`（参考 `adapters/mock/push.mjs`） |

Agent 差异只进 `adapters/`，不要渗入 `petState` / 渲染核心。

## 文档真相源

| 文档 | 用途 |
|------|------|
| `进度记录.md` | 已实现事实、坑、验证记录（**优先读**） |
| `README.md` | 功能、架构、开发/发版命令 |
| `开发计划文档-v2.md` | 早期设计；文首有「已实现/废弃/待做」标注，细节以代码为准 |
| 本文 | 贡献约束与扩展点 |

## 本地命令

```bash
npm install
npm run tauri dev          # 开发
npx tsc --noEmit           # 前端类型
cd src-tauri && cargo check
npm test                   # 单元 + 适配器映射 + Rust lib 测试
```

手动推事件：`node adapters/mock/push.mjs --state thinking`

## 发版

同步 bump **三处**版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
# CI 出 draft release 后：
gh release edit vX.Y.Z --draft=false
```

本地签名打包须显式 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`（空密码），否则会假死。

## 测试期望

改动触及以下区域时，请保持对应测试通过/补充用例：

- 状态聚合 / 优先级 → `src/lib/state-machine.test.ts`
- 衰减 / 过滤 / 终态 → `src/lib/petState.test.ts`
- hook 映射 → `adapters/lib/event-map.test.mjs`
- 去重 / 会话列表 → `src-tauri/src/state_machine.rs`（`#[cfg(test)]`）

## 已知坑（摘要）

- 其它桌宠可能重写 `~/.claude/settings.json` 顶掉 hooks
- `data/` 白底图不能直接当精灵，须过 `cutout.py`
- 透明窗 `"shadow": false`，否则有 DWM 边框
- Codex / Cursor hooks 字段以真机为准；校准用 `PET_DEBUG=1`

## 大功能注意

多宠、Live2D、跨平台会碰当前「单窗单宠」模型，需单独设计，不要在未评审时塞进小修复 PR。
