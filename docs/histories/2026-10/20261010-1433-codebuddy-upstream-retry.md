## [2026-10-10 14:33] | Task: 为 CodeBuddy 上游请求加重试与失败原因诊断

### 🤖 Execution Context
* **Agent ID**: `codebuddy (Space-Bunny)`
* **Base Model**: `space-bunny`
* **Runtime**: `CodeBuddy IDE (macOS)`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 可以，重试2次

（承接上一轮排查：诊断 `codebuddy-cn/space-bunny` 报`Illegal API invocation from an unapproved channel` 时发现上游偶发故障，我提议「上游瞬时错误自动重试 1–2 次 + 把异常原因写进请求日志」，用户批准并指定重试 2 次。）

### 🛠 Changes Overview
**Scope:** `src/codebuddy/index.ts`、`test/codebuddy-gateway.test.ts`（只改CodeBuddy 适配器；zcode / cline / qodercn 三个适配器存在同样形态，本次未动）

**Key Actions:**
- **新增 `fetchUpstreamWithRetry`**: 带退避重试的上游请求，缺省退避 `[300, 900]`ms，即最多重试 2 次、共 3 次尝试。
- **可重试状态码白名单**: 只含 `408/425/429/500/502/503/504`；`400/401/403/404` 等确定性失败一律不重试。
- **客户端取消不重试**: 建连异常时若 `request.signal` 已 aborted，立即上抛走既有 499 分支，而不是把用户的取消当成瞬时故障重试两次。
- **重试前丢弃失败响应体** (`response.body?.cancel()`)，避免失败响应占满连接池反而拖垮后续请求。
- **退避可被abort 打断**: `waitForRetry` 用 `AbortSignal` 打断等待，用户取消不必白等一个退避周期。
- **重试保持同一身份**: 复用同一套身份头与会话 id（`x-conversation-id` 等），换 id 会把一次逻辑请求拆成多条上游会话。
- **502 不再是黑盒**: 原`fail(502, "CodeBuddy 上游请求失败")` 不含任何原因，改为带上重试次数与底层异常（`已重试 2 次：Error: read ECONNRESET`），由 `fail()` 现有的 `redact()` 兜住凭据。
- **可注入**: `CodebuddyDependencies.upstreamRetryDelaysMs` 供测试把退避设为 `[0,0]` 或 `[]`。

### 🧠 Design Intent (Why)
* **重试边界划在「尚未向客户端写出任何字节」的阶段**。上游一旦返回 200 就进入流式转发，此时响应头已发出，中途失败无法重放——那种情况只能按 502 收尾。这是本次刻意不把响应体读取纳入重试的原因。
* **不重试 4xx**。实测到的 400 `unapproved channel` 是上游一次性拒绝，重放只会把同一个错误再付一遍代价；真正需要重试的是建连异常与 5xx/429。
* **诊断信息与重试同等重要**。上一轮排查时那个 502 耗时 11.85s 却无任何线索，只能靠反复重试排除；把原因写进响应后同类问题可一眼定位。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD）。

- **Files changed:** 2
- **Insertions:** +155
- **Deletions:** -5

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/index.ts` | +74 | -5 |
| `test/codebuddy-gateway.test.ts` | +81 | -0 |

### 📁 Files Modified
- `src/codebuddy/index.ts`
- `test/codebuddy-gateway.test.ts`

### ✅ Verification
- `bun run check` 全绿；`bun test`322 pass / 0 fail（新增 4 项）。
- 新增用例：5xx 重试成功且身份头/会话/请求体一致、重试耗尽回 502 且带原因、4xx 不重试、客户端取消不重试。

### ⚠️已知边界与后续
- **流式中途失败不重试**（见 Design Intent）。若要覆盖，需要把 `createCodebuddyResponse` 一并纳入重试，但它的 `onComplete` / `abort` / `cleanup` 副作用需要先解耦。
- **`zcode` / `cline` / `qodercn` 三个适配器是同一形态**（各自 `catch` 里都有不透明 5xx），本次按用户确认的范围只改CodeBuddy。