# Cline Provider 适配器

## 背景

用户希望像 CodeBuddy 一样，把本机 Cline 登录态的模型也接入网关（`cline/` 前缀路由）。

调研结论（2026-09-24）：
- Cline CLI（3.0.x）的 OAuth 免费档（`cline-free/*`）推理端点藏在动态 `inferenceProfile`
  配置里，静态逆向未定位；对 `api.cline.bot/api/v1/chat/completions` 与
  `/api/v2/cortex/v1/*` 携带有效 WorkOS JWT 均被 401（服务端要求官方 API Key）。
- **官方支持路径**：app.cline.bot 控制台可签发 API Key（OpenAI 兼容，
  `https://api.cline.bot/api/v1/chat/completions`，`Authorization: Bearer <key>`），
  公开目录 `GET /api/v1/models`（458 模型，含免费档，社区 dsh-cline-free-provider 同款）。
- 结论：Cline adapter 走官方 API Key，不做 OAuth 逆向（脆弱且随版本失效）。

## 设计

- **凭据**：`~/.codex-cliproxy-gateway/cline-api-key`（0600，单行）只读消费；
  缺失/为空报带重建指引的 503 configuration_error。不放 config.json（红线：配置文件不存密钥）。
- **目录**：`GET /api/v1/ai/cline/models`（公开），映射为 `cline/<upstream-id>` slug；
  **只保留免费模型**（`:free` 后缀或 `pricing.prompt/completion` 均为 0，实测 24 个，
  付费模型屏蔽）；5 分钟 TTL 缓存，拉取失败回退上次结果（否则空目录）。
- **转发**：复用 CodeBuddy 的 Responses→OpenAI-chat 全量转换（`translateCodebuddyRequest`
  / `createCodebuddyResponse` 为协议通用实现），上游恒定 `stream: true`，非流式由
  response 层聚合。
- **路由**：`isClineModel = /^cline\//i`；`normalizeGatewayModel` 已有的
  `local-proxy/` 剥离直接生效。
- **配置**：`cline: boolean`（schema/DEFAULTS/config 命令/models 命令同步）；Web UI
  开关延后（技术债）。

## 阶段

1. [x] 凭据与目录调研（本文件）
2. [x] credentials/catalog/adapter + gateway 接线 + 配置管线
3. [x] 测试（凭据、目录映射、路由、404 文案）
4. [ ] 用户在 app.cline.bot 创建 API Key 并写入 `cline-api-key` 文件后实测

## 已知债务

- ~~OAuth 免费档（`cline-free/*`）未接入~~ **已接入（2026-09-25）**：MITM 抓包确认
  免费档推理仍走 `/api/v1/chat/completions`，但必须携带 CLI 客户端身份头
  （`x-client-type: cline-cli`、`x-platform: cli`、`x-client-version` 等全套，
  缺任一即 401）。凭据读 `~/.cline/data/settings/providers.json`，过期自动
  refresh 并写回（refreshToken 轮换式，必须写回否则 CLI 掉登录）。免费模型
  共 3 个（CLI 内嵌注册表）：deepseek-v4.1-flash / mimo-v2.6-flash /
  muse-spark-1.3-contributor（均 1M context）。空 system 消息需剔除
  （上游报 "system message must have content"）。
- Web UI 的模型级开关保存后依赖网关重启生效（生产 LaunchAgent 自动重启；
  临时实例需手动重启）。
