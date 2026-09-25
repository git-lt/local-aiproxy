# Repository Guidelines

## 项目结构与模块组织

本项目是跨平台的 Bun/TypeScript CLI 网关；基于 launchd/LaunchAgent 的服务管理（`start`/`stop`/`restart`/`uninstall`）仅适用于 macOS，其余平台用 `serve` 前台运行。业务源码位于 `src/`：

- `cli.ts`：CLI 命令编排。
- `gateway.ts`：模型端口的路由与转发；只服务本机 ZCode 与 CodeBuddy/WorkBuddy，
  没有第三方上游，也没有官方 ChatGPT 回落。
- `zcode/`：ZCode 配置缓存、目录、协议转换与网关适配。
- `codebuddy/`：CodeBuddy/WorkBuddy 凭据只读消费、目录拉取与双向协议转换。
- `cline/`：Cline 官方 API 适配（凭据为运行时目录的 `cline-api-key` 文件，目录来自公开 `/models`）。
- `qodercn/`：QoderCN 远端 API 适配（凭据为本机 QoderCN/通义灵码客户端登录缓存，只读解密，不连 IPC）。
- `catalog.ts`：模型目录。
- `webui.ts`：内建 Web 配置界面 `/ui`（React 源码在 `src/ui/`，改动 UI 后须重跑 `bun run build:ui`）。
- `config-update.ts`：CLI `config` 命令与 Web UI 共享的配置解析/写入/审计路径。
- `launchd.ts`、`toml.ts`：其余系统集成。

测试集中在 `test/`，辅助脚本在 `scripts/`；`models/` 与根目录 `models.json` 提供模型目录数据与元数据覆盖；`dist/` 是构建产物，不应手工编辑。各模块的实现规则与边界细节见 `docs/` 对应文档（执行计划、专题文档与历史记录），不在此重复。

## 构建、测试与开发命令

- `bun install`：按 `bun.lock` 安装开发依赖。
- `bun run dev <command>`：直接从 `src/index.ts` 运行 CLI，例如 `bun run dev status`。
- `bun run dev:ui`：复用 `web` 启动网关与 UI API 后，另起绑定 `127.0.0.1:8322` 的 Vite HMR 开发页面；正式 `web` 行为不变。
- `bun test`：执行全部 `node:test` 测试。
- `bun run typecheck`：以严格模式运行 TypeScript 类型检查。
- `bun run build`：先构建 UI（`src/ui/` → `dist/ui/index.html`），再生成 CLI 入口 `dist/index.js`。
- `bun run check`：依次执行类型检查、测试和构建；提交前必须通过。

## 编码风格与命名约定

沿用现有 TypeScript 风格：两个空格缩进、双引号、分号、ES 模块及显式 `.ts` 导入后缀。函数和变量使用 `camelCase`，类型与接口使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。优先使用 Bun、Node 标准库及现有模块；避免引入仅服务单一调用点的抽象或依赖。公共边界应保持严格类型，错误信息应说明可执行的修复方式。

## 测试指南

使用 `node:test` 与 `node:assert/strict`，由 `bun test` 运行。新增行为应在 `test/` 中添加以结果为导向的测试，名称采用描述性句子，例如 `test("remote URLs require authentication", ...)`。涉及文件系统时使用临时目录并在 `finally` 中清理。重点覆盖路由、认证、配置恢复及数据安全边界。

## Execution Plans & Histories

长周期任务和已完成的代码改动必须记录在仓库中，不能只保留在聊天记录里。

- **执行计划**（`docs/exec-plans/`）：跨会话、存在架构风险或需要分阶段验证的任务必须创建计划。进行中的计划放在 `active/`，完成后移至 `completed/`，从 `templates/execution-plan.md` 开始填写，并将明确推迟的债务记录到 `tech-debt-tracker.md`。完整规范见 `docs/PLANS_GUIDE.md`。
- **历史记录**（`docs/histories/`）：实际修改仓库的任务应按 `YYYY-MM/YYYYMMDD-HHmm-task-slug.md` 命名。使用 `template.md`，如实填写 Git 用户，并通过 `git diff --shortstat` 与 `git diff --numstat` 记录本次任务的变更统计。完整规范见 `docs/HISTORY_GUIDE.md`。
- 纯问答或调研无需历史记录；仅新增或更新调研、评估、报告、执行计划及其模板，也不要求额外生成历史记录。

## 安全与配置红线

- 不得提交 API 密钥、OAuth 令牌、Keychain 内容、`credentials.json` 或本机 `~/.codex` 配置。
- 网关不持有任何上游 API key：ZCode/CodeBuddy 的凭据只从本机客户端登录态**只读**消费，禁止引入 Keychain 或凭据文件后端。
- 禁止在日志、Web UI 或任何 API 响应中读取、展示或外发凭据；URL 的 query 可能携带 token，对外展示（审计与 `/ui/api/*` 响应）一律按 `sanitizeUrlValue` 只保留 origin 与路径；修改日志时继续遮蔽敏感请求头。
- 不得读写 `$CODEX_HOME` 下的任何文件（`config.toml`、`models_cache.json`、`cliproxy-catalog.json` 等）：
  Codex 侧接线（`openai_base_url`、`model_catalog_json`、Realtime base url）与目录缓存都由
  Codex 自己维护，网关只写自己的 `~/.codex-cliproxy-gateway/*`。
  允许的例外只有**只读**：`status` 展示 Codex 侧 4 个键。
  修改代码时不要把任何写操作落到 `paths.codexHome` 之下。
- 写 `~/.codex-cliproxy-gateway/config.json`、`state.json` 与目录文件必须保留备份（如需）与
  原子写入，并且只修改受管字段。
- 修改 `~/.codex-cliproxy-gateway/config.json` 的字段、默认值、类型或校验规则时，必须同步更新 `schemas/gateway-config.schema.json`，并补充或调整对应测试。
- Web UI 与模型流量结构性隔离（独立端口、独立进程）；`/ui/api/*` 必须校验 ui-token 与 Host/Origin 白名单；改动路由时不得破坏模型端口对 `/ui` 前缀及 mountPath 子树外的本地 404 边界。
