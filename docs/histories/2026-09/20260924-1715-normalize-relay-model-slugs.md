## [2026-09-24 17:15] | Task: 兼容 opencodex 中转的模型名归一化路由

### 🤖 Execution Context
* **Agent ID**: `codebuddy-code`
* **Base Model**: `GLM-5.3-Flash`
* **Runtime**: `CodeBuddy IDE`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 我是用 opencodex 配置的本项目的网关获取的模型，在 codex 调用 local-proxy/codebuddy-cn-* 就是走的本项目的代理，两个代理中转了一下，本项目网关靠模型 ID 的前缀段路由的时候，把 local-proxy/ replace 掉吧，或者分隔/，取最后的模型ID

### 🛠 Changes Overview
**Scope:** `src/gateway.ts`、`test/codebuddy-gateway.test.ts`

**Key Actions:**
- **新增 `normalizeGatewayModel`**（`src/gateway.ts`）：请求体 `model` 与
  `x-codex-routing-hint` 在模型族判定前归一化——
  1. 剥掉已知外层中转前缀 `local-proxy/`（opencodex 指向本网关的 provider 标记）；
  2. 已知路由段的 `-` 连写还原为 `/`：`codebuddy-cn-<model>`、`workbuddy-<region>-<model>`
     与 `zcode-<固定套餐段>-<model>` 三个套餐段（individual/team/start）。
- 404 文案的模型族判定同步走归一化，中转 slug 能得到精确的「integration 未启用」提示。
- 动态 `zcode-<providerId>/` 段不做连写还原（与模型 ID 中的 `-` 无法无歧义区分）。
- 新增测试：`local-proxy/` 前缀 + 连写段路由到与斜杠写法相同的模型，上游收到剥离后的
  裸模型 ID；未识别的外层前缀不剥离、原样 404。

### 🧠 Design Intent (Why)
Codex → opencodex → 本网关的两级中转里，opencodex 会把其目录 slug
（`local-proxy/codebuddy-cn-deepseek-v4-pro`）原样作为 `model` 发下来，而网关按
`codebuddy-cn/` 等斜杠前缀路由，导致中转请求全部 404。归一化让两条链路等价，
网关对直连与中转客户端无感。

### 📁 Files Modified
- `src/gateway.ts`
- `test/codebuddy-gateway.test.ts`

### ✅ Verification
- `bun run check`：typecheck 0 错误，**303 项测试全过**，UI/CLI 构建成功。
- 实测（网关 8320）：`POST /v1/responses` 带
  `{"model":"local-proxy/codebuddy-cn-deepseek-v4-pro"}` → 200 completed，
  响应 `model` 归一化为 `codebuddy-cn/deepseek-v4-pro`。
