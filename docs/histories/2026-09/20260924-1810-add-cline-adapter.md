## [2026-09-24 18:10] | Task: 新增 Cline 官方 API 适配器（cline/ 前缀）

### 🤖 Execution Context
* **Agent ID**: `codebuddy-code`
* **Base Model**: `GLM-5.3-Flash`
* **Runtime**: `CodeBuddy IDE`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 能不能像 codebuddy 一样，把我本地的 qodercn、cline 也代理一下

（经确认先做 Cline；Qoder CN 另行评估——其凭据为 Electron safeStorage 加密
（auth.v1.dat `v10=`），且推理端点/协议未知，需要专项逆向。）

### 🛠 调研结论（写入 docs/exec-plans/active/cline-adapter.md）
- Cline CLI OAuth 免费档（`cline-free/*`）推理端点在动态 inferenceProfile 里，
  静态逆向未定位；有效 WorkOS JWT 对 `api.cline.bot/api/v1/chat/completions`
  与 `/api/v2/cortex/v1/*` 均 401（服务端要求官方 API Key）。
- 采用官方路径：app.cline.bot 控制台签发 API Key，OpenAI 兼容
  `https://api.cline.bot/api/v1/chat/completions`；公开目录 `GET /api/v1/models`
  （实测 458 模型，无需鉴权）。

### 🛠 Changes Overview
**Scope:** 新增 `src/cline/`、`src/gateway.ts`、`src/types.ts`、`src/config-update.ts`、
`src/cli.ts`、`src/request-log.ts`、`schemas/gateway-config.schema.json`、`AGENTS.md`

**Key Actions:**
- **credentials.ts**：`cline-api-key` 文件（0600 单行）只读消费；缺失/为空/多行
  报带 app.cline.bot 指引的 `configuration_error`。
- **catalog.ts**：`/ai/cline/models` 目录 → `cline/<upstream-id>` slug；**只保留免费
  模型**（`:free` 后缀或 `pricing.prompt/completion` 均为 0，实测 24 个，付费 434 个
  屏蔽）；5 分钟 TTL + 失败回退上次结果；`mergeClineCatalog` 去重合并。
- **index.ts**：`cline/` 前缀路由（`cline/z-ai/glm-5.3-prime` → 上游 `z-ai/glm-5.3-prime`），
  转发到官方 chat completions（Bearer key），协议转换复用 CodeBuddy 的
  Responses→chat 全量实现；key 的日志脱敏与 CodeBuddy 同款（转义变体全覆盖）。
- **gateway.ts**：第三条模型族分支（含压缩路径）、目录合并、healthz、启动日志、
  404 文案族判定；`local-proxy/` 归一化自动生效。
- **配置管线**：`cline: boolean`（types/schema/DEFAULTS/config 命令/白名单），
  `models` 命令新增 `--cline`；`LogNamespace` 增加 `"cline"`。
- **测试**：`test/cline-gateway.test.ts`（凭据文件边界、local-proxy 前缀路由、
  上游裸 ID 与 Bearer key 断言、日志脱敏、缺 key 503、关闭时 404 文案）。
- **Web UI（追加轮）**：Header 一键复制 baseUrl；「安装配置」只读卡移除；
  三个 provider 开关与各自模型列表合并为「服务与模型」卡片，紧凑布局；
  模型级开关（`disabledModels` 配置字段 + schema + 网关目录过滤与转发 404，
  匹配不区分大小写）；官方 API Key 实测通过（`z-ai/glm-5.3-flash` → 200，
  `cline-free/*` 为 CLI 专属命名空间返回 403）。

### 🧠 Design Intent (Why)
Cline 官方 API Key 是稳定且被支持的路（社区 dsh-cline-free-provider 同款）；
OAuth 免费档逆向脆弱。凭据放网关运行时目录而非 config.json，遵守
「配置文件不存密钥」红线；凭据文件只读消费，轮换由用户在控制台管理。

### 📁 Files Modified
- 新增：`src/cline/{credentials,catalog,index}.ts`、`test/cline-gateway.test.ts`
- 修改：`src/gateway.ts`、`src/types.ts`、`src/config-update.ts`、`src/cli.ts`、
  `src/request-log.ts`、`schemas/gateway-config.schema.json`、`AGENTS.md`

### ✅ Verification
- `bun run check`：typecheck 0 错误，306 项测试 0 失败，构建成功。
- 实测（网关 8320）：healthz `cline: true`；`/v1/models` 476 条
  （zcode 2 + codebuddy 16 + cline 458）；未配 key 请求返回 503 +
  app.cline.bot 指引。
- 待办：用户创建 API Key 写入 `~/.codex-cliproxy-gateway/cline-api-key`
  （chmod 600）后实测 chat 链路。

### 📁 债务
- ~~Web UI 配置页暂无 cline 开关~~ 已补（开关 + 探测 + 缺失指引）。
- Qoder CN 接入未启动（safeStorage 解密 + 推理协议逆向，需专项）。

### 追加轮（2026-09-25）：cline-free OAuth 免费档接入
- MITM 抓包确认：免费档推理仍走 `/api/v1/chat/completions`，但必须携带 CLI
  客户端身份头全套（`x-client-type/x-platform/x-client-version/...`，缺任一 401）。
- `credentials.ts` 增加 OAuth 凭据读取（`~/.cline/data/settings/providers.json`）
  与过期刷新（`/api/v1/auth/refresh`，refreshToken 轮换式，新令牌对写回文件，
  否则 CLI 掉登录）；exp 从 JWT claim 解析。
- 适配器双模式：`cline-free/*`（OAuth + 客户端头，上游 ID 原样）与
  `cline/<id>`（API Key，剥前缀）；目录追加 3 个 cline-free 模型（1M context）；
  空 system 消息剔除（上游 400）。
- 实测：`cline-free/deepseek-v4.1-flash` 与 `mimo-v2.6-flash` 过网关
  非流式/流式均 completed。
