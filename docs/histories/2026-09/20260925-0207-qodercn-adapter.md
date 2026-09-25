## [2026-09-25 02:07] | Task: 新增 QoderCN 远端 API adapter

### 🤖 Execution Context
* **Agent ID**: `CodeBuddy`
* **Base Model**: `Hy4 preview`
* **Runtime**: `CodeBuddy IDE`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 请查看这个项目 https://github.com/Lutiancheng1/lingma-proxy/blob/main/README.zh-CN.md，实现代理 本地qodercn 的功能

确认范围后的落地形态：在本仓库新增第四个本地 adapter `src/qodercn/`，**仅远端 API 模式**，对外模型前缀 `qodercn/<model>`。

### 🛠 Changes Overview
**Scope:** `src/qodercn/`（新增）、`src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/webui.ts`、`src/request-log.ts`、`src/types.ts`、`schemas/gateway-config.schema.json`、`src/ui/{api.ts,i18n.tsx,ConfigPage.tsx}`、`test/qodercn.test.ts`

**Key Actions:**
- **[新增]** `src/qodercn/credentials.ts`：只读读取本机 QoderCN/通义灵码登录缓存，AES-128-CBC（key=IV=machine id 前 16 字节）解密出签名所需的 `key`/`encrypt_user_info`/`uid`；不写回、不导出。
- **[新增]** `src/qodercn/base-url.ts`：从本机端点缓存解析远端域名，读不到时回退 `https://gateway.qoder.com.cn`。
- **[新增]** `src/qodercn/{request,response}.ts`：OpenAI chat 请求 → 远端 SSE 负载 + COSY 签名；远端双层 SSE 剥壳 → 标准 OpenAI SSE。
- **[新增]** `src/qodercn/{catalog,index}.ts`：`/algo/api/v2/model/list` → `qodercn/<key>` 目录（TTL 缓存）；adapter 本体复用 CodeBuddy 的 Responses→chat 转换与响应层。
- **[接入]** 按 cline 既有骨架打通：配置开关、schema、`models`/`config` 命令、网关路由与 compaction、`/v1/models`、`/healthz`、Web UI 探测与表单、请求日志命名空间与 `cosy-*` 敏感头打码。

### 🧠 Design Intent (Why)
上游 `lingma-proxy` 的远端 API 模式能在不依赖 IDE/IPC 会话的前提下直调 Lingma/Qoder 后端，这是最稳的一条路；但它的 README 描述的缓存布局（`~/.qoder-cn/shared_client/cache/user`）与本机实装不一致——本机 QoderCN 落在 `~/.qoder-cn/.auth/user` + `.auth/machine_id`，且服务端域名是 `gateway.qoder.com.cn` 而非 `lingma.alibabacloud.com`。因此本仓库没有照搬目录清单，而是按实测布局实现候选枚举，并把域名解析交给本机端点缓存。

协议上远端 SSE 的外层只是信封、内层就是标准 OpenAI `chat.completion.chunk`，所以没有写第二套响应解析：剥壳后交回现成的响应层，工具调用增量与 usage 自动沿用既有路径。

### 📊 Change Stats
> 工作区存在其他在途未提交改动（如 models 白名单迁移），共享文件的行数为包含它们的混合结果，此处只精确统计本次新增文件。

- **Files changed:** 20（新增 7）
- **Insertions:** +1239（新增文件行数）

| File | +Added | Notes |
| --- | ---: | --- |
| `src/qodercn/credentials.ts` | +143 | 登录缓存只读解密 |
| `src/qodercn/index.ts` | +246 | adapter 本体 |
| `src/qodercn/request.ts` | +245 | 负载构建 + COSY 签名 |
| `src/qodercn/response.ts` | +126 | SSE 剥壳 |
| `src/qodercn/catalog.ts` | +100 | 目录构建与缓存 |
| `src/qodercn/base-url.ts` | +83 | 远端域名解析 |
| `test/qodercn.test.ts` | +296 | 8 项新增用例 |

其余为共享文件的按点接入（types/schema/cli/gateway/webui/config-update/request-log/ui）。

### 📁 Files Modified
- `src/qodercn/credentials.ts`（新增）
- `src/qodercn/base-url.ts`（新增）
- `src/qodercn/catalog.ts`（新增）
- `src/qodercn/request.ts`（新增）
- `src/qodercn/response.ts`（新增）
- `src/qodercn/index.ts`（新增）
- `test/qodercn.test.ts`（新增）
- `src/types.ts`、`schemas/gateway-config.schema.json`
- `src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/webui.ts`、`src/request-log.ts`
- `src/ui/api.ts`、`src/ui/i18n.tsx`、`src/ui/ConfigPage.tsx`
- `test/webui.test.ts`、`test/zcode-signing.test.ts`（同步白名单语义后的夹具）
- `AGENTS.md`

### ✅ Verification
- `bun run check`：316 pass / 0 fail（typecheck + test + build 全通过）。
- 真实链路冒烟（本机 QoderCN 登录态）：域名解析到 `gateway.qoder.com.cn`，目录 14 个模型，`qodercn/auto` 的 Responses 请求返回 200 SSE，`output_text` = `OK`，usage 正常回填。
- 运行实例验证：重启 UI 与网关进程后，`/healthz` 返回 `qodercn: true`，`/v1/models` 返回 14 个 `qodercn/*`，经网关真实转发 `qodercn/auto` 返回 200 SSE（`output` = `OK`，usage `20/1/21`）。配置侧只开了 `qodercn` 开关并把这 14 个 slug 加进 `enabledModels`（原有条目保留，其它 provider 未动）。
- 顺带修复：`test/zcode-signing.test.ts` 3 项此前失败源于工作区在途的「模型白名单」改动——新语义下缺省一个模型都不放行，而该夹具未配置 `enabledModels`，请求直接 404。已给夹具补 `enabledModels: ["*"]`（只动测试夹具，不改产品行为）。
