## [2026-09-24 12:10] | Task: 收敛到「无第三方上游」架构并修复损坏的 CLI 入口

### 🤖 Execution Context
* **Agent ID**: `codebuddy-code`
* **Base Model**: `GLM-5.3-Flash`
* **Runtime**: `CodeBuddy IDE`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 测试一下这个项目是否能获取到 zcode 的模型列表
> 修复
> 「停止 Codex app-server」功能不要了

（会话中发现工作区处于一次进行中的大重构：`types.ts` 已把 `GatewayConfig` 收敛为
「只转发本机 ZCode / CodeBuddy 登录态，无第三方上游、无官方 ChatGPT 回落」，但
`webui.ts`、`cli.ts` 与部分测试尚未跟上，`bun run dev` 因引用已删除模块整体不可用。
用户确认「停止 Codex app-server」功能一并移除。）

### 🛠 Changes Overview
**Scope:** `src/`（cli / webui / config-update / ui / types 已由前置轮改好）、`test/`、`docs/`

**Key Actions:**
- **删除废弃模块**：`app-server.ts`、`upstream-catalog.ts`、`keychain.ts`、`models.ts`、
  `realtime.ts`、`credentials-store.ts`、`codex-version.ts` 及其专属测试
  （`gateway.test.ts`、`realtime.test.ts`、`model-catalog-dynamic.test.ts`、
  `codex-version.test.ts`、`credentials-store.test.ts`、`upstream-visibility.test.ts`、
  `model-picker.test.ts`）。
- **webui.ts**：移除 `GET/POST /ui/api/upstream/models`、`POST /ui/api/codex/restart`
  三个端点与 `upstreamDeps` 注入点；`status`/`config` 响应去掉
  `prefix/upstreamType/upstreamOnly/officialBaseUrl/selectedModels` 等字段。
- **Web UI**：删除 `ModelPicker` 与「模型选择」编辑区、保存弹窗的三分支
  （保存并重启 Codex / 跳过重启）；只读区改为 `mountPath / host:port / catalogPath`；
  i18n 两语言包同步清理并新增 `labelMountPath/descMountPath`。
- **cli.ts**：`parseArgs` 修复 `--zcode/--codebuddy` 双形态解析（models 无值开关、
  config 要求 on|off）；`models` 帮助文本去掉 `--sync/--upstream-only/--select`；
  `config` 查询输出去掉 `upstreamOnly/selectedModels`；帮助文本重写为本地
  ZCode/CodeBuddy 转发语义。
- **config-update.ts**：删除 `parseSelectedModels` 与 `applySelectedModelsPatch`。
- **测试**：`zcode-gateway/codebuddy-gateway/zcode-signing/zcode-config/zcode-cli/
  webui/cli-flags` 适配新签名与新配置形状；`app-server.test.ts` 中与 app-server 无关的
  CLI 用例迁至新文件 `cli-flags.test.ts`；删除 upstream-only / 官方目录缓存 /
  prefix 冲突 / WebSocket 桥接 / 钥匙串相关用例。
- **AGENTS.md**：结构描述与安全红线去掉 keychain / upstream-catalog /
  CLIProxy OAuth 相关条目，明确「无第三方上游、无官方回落」。

### 🧠 Design Intent (Why)
- 工作区的前置轮次已经决定只保留 ZCode / CodeBuddy 两个本地 provider（`types.ts`
  注释与 schema 的 deprecated 键都已完成），本次把剩余的编译断裂点收尾，
  使 `bun run check` 恢复全绿；「停止 Codex app-server」由用户明确要求移除，
  Codex 侧刷新回归「用户自行重启 / 自身 TTL 自愈」。
- `parseArgs` 的双形态解析是必要折中：`models --zcode`（无值开关）与
  `config --zcode on|off`（带值）共存于同一白名单命令集。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（未提交工作区，
> **含前置轮次累计值**，本会话为其收尾轮）。

- **Tracked files changed:** 48
- **Insertions:** +647
- **Deletions:** -10861

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +196 | -792 |
| `src/gateway.ts` | +112 | -830 |
| `test/zcode-gateway.test.ts` | +62 | -207 |
| `test/webui.test.ts` | +12 | -373 |
| `src/catalog.ts` | +11 | -256 |
| `src/ui/ConfigPage.tsx` | +13 | -124 |
| `src/ui/i18n.tsx` | +10 | -92 |
| `src/webui.ts` | +3 | -151 |
| `schemas/gateway-config.schema.json` | +26 | -24 |

（另有整文件删除：`src/app-server.ts`、`src/upstream-catalog.ts`、`src/keychain.ts`、
`src/models.ts`、`src/realtime.ts`、`src/credentials-store.ts`、`src/codex-version.ts`
及 7 个对应测试文件。）

### 📁 Files Modified
- `src/cli.ts`、`src/webui.ts`、`src/config-update.ts`
- `src/ui/ConfigPage.tsx`、`src/ui/api.ts`、`src/ui/i18n.tsx`（`ModelPicker.tsx` 删除）
- `AGENTS.md`、`docs/codex-app-server-restart-policy.md`
- `test/`（删 7 个文件、改 7 个文件、新增 `cli-flags.test.ts`）

### ✅ Verification
- `bun run typecheck`：0 错误。
- `bun test`：**302 项 / 24 个文件 / 0 失败**。
- `bun run check`（typecheck + test + build，含 `build:ui`）通过。
- 手工验证：`bun run dev status` 正常；`models --zcode` 在真实 `~/.zcode` 下返回
  `zcode-individual-coding-plan/glm-5.3` 与 `glm-5.3-flash`（临时 config.json 验证后清理）。
- 已知边界：ZCode 凭据缓存与真实用户主目录绑定，`$HOME` 指向符号链接目录时
  凭据不可用（ZCode 自身行为，非网关缺陷）。
