# Codex Pet（codex-DP）

Windows 桌面宠物：实时反映编程 Agent（Claude Code / Codex CLI / Cursor）的工作状态——思考中、执行工具、等待审批、完成、出错，一眼可见。

**技术栈**：Tauri 2（Rust）+ Svelte 5 + Vite 6 + TypeScript。常驻内存 ~37MB。

![skins](docs/skins.png)

## 功能

- 🟢 **官方 Q 版精灵**：绿毛衣 / 红装两款皮肤，右键即换（`tools/cutout.py` 离线抠图管线，可扩展新皮肤）
- ⚡ **实时状态联动**：8 种 Agent 状态 → 7 种动画（呼吸/摇摆/倾斜/弹跳/抖动…）+ 气泡文案
- 🤖 **多 Agent 通用**：Claude Code（主）、Codex CLI、Cursor，一份统一事件协议
- 🎯 **会话选择**：托盘/右键 →「监听会话」锁定某个对话（`项目名·会话短id`），默认聚合全部
- 💾 **状态持久化**：工作态 5min 衰减防掉线；等待审批不衰减；完成/出错保持到点击确认（可配）
- 🖱️ **交互**：整窗拖拽（位置记忆）、点击消散终态、右键原生菜单（换肤/监听/自启/设置）
- ⚙️ **配置面板**：皮肤、终态提醒方式、衰减档位、开机自启，实时热更
- 🔄 **自动更新**：GitHub Releases + 签名校验，启动时静默更新
- 🚀 **开机自启**：默认开启，可关

## 架构（Push 模型）

```
Claude Code hooks (~/.claude/settings.json)
Codex CLI hooks  (~/.codex/hooks.json)     ┐
Cursor hooks     (~/.cursor/hooks.json)    ├─→ adapters/*/pet-bridge.mjs（零依赖 Node）
                                           │      统一事件 {source, sessionId, state, tool, project, …}
                                           ↓
                          HTTP POST 127.0.0.1:4271/event
                                           ↓
                    Rust: server.rs 接收 → state_machine.rs 路由/去重/会话跟踪
                                           ↓ app.emit("agent-event")
                    前端: petState 聚合/持久化 → renderer Canvas 动画 + 气泡
```

关键设计：hooks 每次事件新建进程，故用**无状态 HTTP POST**（非 WebSocket）；适配器永远 `exit(0)`、1s 超时、静默失败，**绝不阻塞 Agent**。

## 目录

```
src/                 前端（App.svelte 宠物窗 + config/ 配置窗）
  lib/renderer.ts    Canvas 变换式动画引擎（drawCharacter 接精灵，blob 兜底）
  lib/petState.ts    状态持久化模型（分类计时 + 会话聚合/过滤）
  lib/updater.ts     静默自动更新
  assets/sprites/    官方抠图精灵（绿/红）
src-tauri/src/
  lib.rs             窗口/托盘/菜单/设置/settings.json/自启/命令
  server.rs          HTTP POST 事件通道（4271）
  state_machine.rs   事件路由、去重、会话跟踪（90s TTL）
adapters/            各 Agent 的 hooks 安装器 + 共享 pet-bridge.mjs（--source 区分来源）
tools/cutout.py      白底设计图 → 透明精灵（Pillow+scipy 边缘泛洪，不打穿白衣）
data/                角色设计原图（白底，勿直接用作精灵）
开发计划文档-v2.md    原始设计文档
进度记录.md           完整开发/排障/决策记录（先读这个）
```

## 开发

```bash
npm install
node node_modules/esbuild/install.js   # 若 esbuild postinstall 被 allow-scripts 拦截
npm run tauri dev                       # Vite :1420 + 桌宠
```

检查：`npx tsc --noEmit`；`cd src-tauri && cargo check`

安装 Agent hooks（幂等、先备份、`--uninstall` 可卸）：

```bash
node adapters/claude-code/install-hooks.mjs   # Claude Code（主）
node adapters/codex/install-hooks.mjs         # Codex CLI
node adapters/cursor/install-hooks.mjs        # Cursor
```

手动推测试事件：`node adapters/mock/push.mjs --state thinking`

## 发版

```bash
# 1. 改版本号：src-tauri/tauri.conf.json + Cargo.toml
git commit -am "Bump to X.Y.Z" && git push
git tag vX.Y.Z && git push origin vX.Y.Z      # 2. CI 出 draft release（~7min）
gh release edit vX.Y.Z --draft=false          # 3. 发布，客户端启动时自动更新
```

本地出包：`TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/codex-pet.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build`（空密码必须显式给，否则假死）

## 已知坑（详见 进度记录.md）

- 4271 单端口：dev 与安装版勿同跑；Vibe Pet 会重写 `~/.claude/settings.json` 顶掉 hooks
- `data/` 图片是白底，不能直接当精灵；必须过 `tools/cutout.py`
- NSIS 配置在 `bundle.windows.nsis`；installMode 枚举是 `currentUser`
- CI release job 需 `permissions: contents: write`
- 透明窗要 `"shadow": false`，否则有一圈 DWM 阴影边框
