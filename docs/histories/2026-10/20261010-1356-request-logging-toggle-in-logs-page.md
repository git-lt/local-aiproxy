## [2026-10-10 13:56] | Task: 在 /logs 页面加入请求日志开关

### 🤖 Execution Context
* **Agent ID**: `codebuddy-cn`
* **Base Model**: `deepseek-v4.1-flash`
* **Runtime**: `CodeBuddy IDE (macOS)`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 把请求日志的开关加到 /logs 页面中

### 🛠 Changes Overview
**Scope:** `src/ui/`（Web UI 前端；未触碰 `/ui/api/*` 契约、`webui.ts` 与网关转发行为）

**Key Actions:**
- **请求日志 tab 新增开关**: 工具栏加入 `toolbar-switch`（文案 + 复用配置页同款 `.switch`/`.slider` 滑块），挂载时用 `GET /ui/api/config` 的 `editable.requestLogging` 取真值，避免只看文件列表的 `logging` 而拿不到「未开启」时的状态。
- **提交复用既有契约**: 开关走 `POST /ui/api/config { requestLogging }`，点击即乐观翻转、提交期与重启窗口内禁用开关；返回 `restarting: true` 时进入重启窗口，按 1s 轮询 `GET /ui/api/status` 收尾（与 `ConfigPage` 同一套节奏），恢复后重读开关与目录。失败按原值回滚并落页内错误横幅，不停在假状态。
- **状态合并成一处**: `logging` 同时由「配置真值」与「`/ui/api/logs/requests` 返回的 `logging`」写入（后者是服务端每次请求重读配置后的值），开关、空态提示、预览分栏共用同一状态，不引入第二套真值。
- **文案**: `loggingOffHint` 改为指向本页开关（中英双份）；提交/重启期复用既有 `saving`、`savedRestarting`、`saveFailed`。
- **样式**: `styles.css` 增加 `.toolbar-switch`（文本 + 滑块横排、11px、次要前景色）。

### 🧠 Design Intent (Why)
* 关掉请求日志时请求日志接口只回 `logging: false` 与空目录，页面此前只能提示「去配置页打开」——用户要在两个页面之间来回跳。开关放进它影响的那个 tab，提示语也随之改成可当场执行的指引。
* 复用 `POST /ui/api/config` 而不是新开 `/ui/api/logs` 写接口：配置面的校验、审计、备份、原子写入与重启调度都已在 `config-update.ts` 收敛，UI 侧再开一条写路径只会扩大配置面。
* `requestLogging` 会触发网关重启，因此必须保留「乐观 → 轮询 → 服务端真值收敛」三段式：乐观值保证点击即响应，轮询覆盖重启窗口，收敛逻辑避免开关停在假状态（这条教训来自此前模型白名单开关的两次闪回问题）。
* 状态只留一份：请求日志的「开/关」在页面里同时决定开关、空态与分栏渲染，多一份 state 就会多一处不一致。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD）。注意：`i18n.tsx`、`styles.css` 在本次任务前已有其它未提交改动，下表行数因此含那些改动的量；`LogsPage.tsx` 的 107/12 全部来自本次任务（本次人工改动量为 i18n +2/-2、styles +10/-0）。

- **Files changed:** 3
- **Insertions:** +173
- **Deletions:** -79

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/ui/LogsPage.tsx` | +107 | -12 |
| `src/ui/styles.css` | +56 | -53 |
| `src/ui/i18n.tsx` | +10 | -14 |

### 📁 Files Modified
- `src/ui/LogsPage.tsx`
- `src/ui/i18n.tsx`
- `src/ui/styles.css`

### ✅ Verification
- `bun run check`（typecheck + 318 项测试 + build）全绿；`dist/ui/` 已由 `build:ui` 重新构建。
- 本地网关（UI 端口 8321）实测：关闭 → 开关与 `config.json` 同步为 `false`、空态提示出现、POST 后 1s 轮询完成后目录刷新为空；再打开 → 3s 内开关与配置文件回到 `true`、文件表恢复。提交期与重启窗口内开关禁用、横幅显示「保存中…／已保存，网关重启中」。
- 本次是 UI 层改动，复用既有 `POST/GET /ui/api/config` 契约（`test/webui.test.ts` 已覆盖该路径），未新增服务端行为，因此没有新增测试；该仓库的 UI 纯逻辑测试惯例（如 `test/log-size-field.test.ts`）不适用于本次的组件内状态机。
