# Codex Pet（codex-DP）

Windows 桌面宠物：实时反映编程 Agent（Claude Code / Codex CLI / Cursor）的工作状态——思考中、执行工具、等待审批、完成、出错，一眼可见。

**技术栈**：Tauri 2（Rust）+ Svelte 5 + Vite 6 + TypeScript。常驻内存 ~37MB。  
**许可**：MIT（见 `LICENSE`）。贡献约定见 `AGENTS.md`。

![skins](docs/skins.png)

## 功能

- 🟢 **官方 Q 版精灵**：绿毛衣 / 红装两款皮肤，右键即换（`tools/cutout.py` 离线抠图管线，可扩展新皮肤）
- 🎞️ **序列帧动画皮肤「绿毛衣·动画」**：AI 生成视频 → 抽帧精灵表（`tools/video_frames.py`），**7 状态专属序列**——三段式（入场→循环→出场，如齿轮/道具随状态生灭）、once（成功欢呼定格）、pingpong（输出中）；动作连贯性由视频保证 | MIT 无授权风险
- ⚡ **实时状态联动**：8 种 Agent 状态 → 7 种动画（呼吸/摇摆/倾斜/弹跳/抖动…）+ 气泡文案
- 🤖 **多 Agent 通用**：Claude Code（主）、Codex CLI、Cursor，一份统一事件协议。Cursor **无统一审批粒度**（仅 shell/MCP 前置观察）；三源均无可靠逐字 streaming hook，该动画仅素材+规则，不装假状态
- 🎯 **会话选择**：托盘/右键 →「监听会话」锁定某个对话（`项目名·会话短id`），默认聚合全部
- 💾 **状态持久化**：工作态 5min 衰减防掉线；等待审批不衰减；完成/出错保持到点击确认（可配）
- 🖱️ **交互**：整窗拖拽（位置记忆）、点击消散终态、右键原生菜单（换肤/监听/重置位置/自启/设置）、三档缩放
- ⚙️ **配置面板**：皮肤与大小、Agent hooks 安装/诊断、会话轻列表、终态提醒（含任务栏闪烁）、连接提示、衰减、智能文案、开机自启
- 💬 **智能文案（可选）**：规则模板或 OpenAI 兼容 API，工作态人格短句 + 终态一句话摘要；默认关，失败回退原 tip
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
  lib/renderer.ts    Canvas 变换式动画引擎（帧序列 → 静态精灵 → blob 三级回退）
  lib/frame-player.ts 序列帧播放器（loop/pingpong/once + 三段式入场/出场）
  lib/petState.ts    状态持久化模型（分类计时 + 会话聚合/过滤）
  lib/copy/          智能文案（EventRing + 规则/OpenAI Provider + 限流队列）
  lib/updater.ts     静默自动更新
  assets/sprites/    官方抠图精灵（绿/红）
  assets/skins.json  皮肤注册表（key/name/kind；新皮肤只改清单+资源）
  assets/frames/     帧动画皮肤精灵表（tools/video_frames.py 产出，含清单 JSON）
src-tauri/src/
  lib.rs             窗口/托盘/菜单/设置/settings.json/自启/命令
  server.rs          HTTP POST 事件通道（4271）
  state_machine.rs   事件路由、去重、会话跟踪（90s TTL）
adapters/            各 Agent 的 hooks 安装器；共享 pet-bridge + `lib/event-map.mjs`（--source 区分来源）
tools/cutout.py      白底设计图 → 透明精灵（Pillow+scipy 边缘泛洪，不打穿白衣）
tools/video_frames.py 白底角色视频 → 透明序列帧精灵表（抽帧/去背/并集裁剪/循环段检测/网格打包）
data/                角色设计原图与状态视频（白底，勿直接用作精灵；视频规格见其内「视频需求.md」）
AGENTS.md            二次开发/贡献约定（扩展点、约束、发版）
开发计划文档-v2.md    原始设计文档（文首有已实现/废弃/待做标注）
进度记录.md           完整开发/排障/决策记录（先读这个）
```

## 开发

```bash
npm install
node node_modules/esbuild/install.js   # 若 esbuild postinstall 被 allow-scripts 拦截
npm run tauri dev                       # Vite :1420 + 桌宠
```

检查：`npx tsc --noEmit`；`cd src-tauri && cargo check`；`npm test`（前端 vitest + 适配器映射 + Rust lib）

安装 Agent hooks（幂等、先备份、`--uninstall` 可卸）：

```bash
node adapters/claude-code/install-hooks.mjs   # Claude Code（主）
node adapters/codex/install-hooks.mjs         # Codex CLI
node adapters/cursor/install-hooks.mjs        # Cursor
```

手动推测试事件：`node adapters/mock/push.mjs --state thinking`

## 发版

同步 bump 版本号：`node scripts/bump-version.mjs X.Y.Z`（三处 + package-lock）。

```bash
git commit -am "Release X.Y.Z" && git push
git tag vX.Y.Z && git push origin vX.Y.Z      # CI 出 draft（~7min）
node scripts/check-release-assets.mjs vX.Y.Z  # 确认 .exe / .sig / latest.json
gh release edit vX.Y.Z --draft=false          # 正式发布；客户端下次启动才检查更新
```

**注意：** draft 期间 `releases/latest` 仍指旧版，重启不会立刻更到新包。

### 安装版冒烟（发正式版前）

1. 关掉 dev 实例，只跑安装版（单端口 4271）
2. 设置 → Agent 连接：三源状态灯正常；缺项/路径失效显示黄灯并可「补装」
3. 「推送测试事件」→ 宠物进入思考
4. Cursor：需点 Run 的提示 → 等待动画 → 执行后工具/思考 → 完成
5. Codex / Claude：各跑一轮短对话，确认气泡有变化
6. （可选）久无事件后 idle 气泡提示「好像没接到 Agent」；设置里可关「连接提示」

本地出包：`TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/codex-pet.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build`（空密码必须显式给，否则假死）

## 已知坑（详见 进度记录.md）

- 4271 单端口：dev 与安装版勿同跑；Vibe Pet 会重写 `~/.claude/settings.json` 顶掉 hooks
- `data/` 图片是白底，不能直接当精灵；必须过 `tools/cutout.py`
- NSIS 配置在 `bundle.windows.nsis`；installMode 枚举是 `currentUser`
- CI release job 需 `permissions: contents: write`
- 透明窗要 `"shadow": false`，否则有一圈 DWM 阴影边框
