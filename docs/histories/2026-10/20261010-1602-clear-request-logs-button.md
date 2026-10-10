## [2026-10-10 16:02] | Task: 日志页新增一键清空请求日志（跳过正在写入的文件）

### 🤖 Execution Context
* **Agent ID**: `codebuddy (Space-Bunny)`
* **Base Model**: `space-bunny`
* **Runtime**: `CodeBuddy IDE (macOS)`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 在web页面/logs，请求日志tab 页面，添加一个清空日志的功能，一键清空所有日志（直接删除日志文件）
> 正在写日志的文件不要删除了

### 🛠 Changes Overview
**Scope:** `src/webui.ts`、`src/ui/{api,LogsPage,i18n}.tsx`、`src/ui/styles.css`、`test/webui.test.ts`

**Key Actions:**
- 新增 `POST /ui/api/logs/requests/clear`，返回 `{removed, kept}`。**只删请求日志文件**；`gateway.log` / `webui.log` 等进程日志、目录缓存、配置与审计文件一律保留。
- **在写保护窗口 60s**：mtime 落在窗口内的文件跳过不删，`kept` 回报跳过数量，UI 如实提示跳过几个。
- 路由排在 `logs/requests/` 之前，且只认 POST——GET 因名字不匹配返回 404，刷新列表不会误删。
- 日志页工具栏新增「清空日志」按钮（`btn-danger`，悬停转红），`window.confirm` 二次确认并显示待删数量。
- 成功后清掉选中态、回第 1 页、重载列表；`requestLogging` 关闭时也允许清理残留。

### 🧠 Design Intent (Why)
* **不删 `gateway.log`**：由 launchd 持有句柄，删除后进程仍写入已 unlink 的 inode，空间不释放且丢失排查线索。沿用 `pruneLogDir` 的既有口径（`isRequestLogName`）。
* **保护窗口用 mtime 而非文件名**：各 adapter 在请求**结束时一次性**落盘（`appendFileSync`，无长期句柄），文件名时间戳是首次写入时刻——流式跑了两分钟的请求文件名早已是旧的。只有 mime 每次写都刷新，`mtime ≈ now` 才能代表刚写入。
* **60s 是保守余量**：真实写入窗口远小于此，此值只用于避免清空把刚产生的日志从用户眼前抹掉。
* **必须二次确认**：唯一会不可逆销毁用户数据的操作。

### 📊 Change Stats
`git diff --numstat`（工作区 vs HEAD）：6 files changed

| File | 变更 |
| --- | ---: |
| `test/webui.test.ts` | +75 / -15 |
| `src/ui/LogsPage.tsx` | +57 / -0 |
| `src/webui.ts` | +45 / -2 |
| `src/ui/styles.css` | +10 / -0 |
| `src/ui/i18n.tsx` | +10 / -0 |
| `src/ui/api.ts` | +6 / -1 |

### 📁 Files Modified
- `src/webui.ts`
- `src/ui/api.ts`
- `src/ui/LogsPage.tsx`
- `src/ui/i18n.tsx`
- `src/ui/styles.css`
- `test/webui.test.ts`

### ✅ Verification
- `bun run check` 全绿；`bun test` 329 pass / 0 fail。
- 新增 4 项：只删请求日志且 `gateway.log`/`notes.txt`/`webui.log` 存活 + 幂等；**保护窗口内文件保留（`{removed:1, kept:1}`）**；关闭日志时可清理残留；GET 不删除且未鉴权 401。
- 测试辅助 `ageLogs()` 把 mtime 推旧 10 分钟，避免新保护窗口让旧用例误判。
- 构建产物核对：`dist/ui/index.html` 含「清空日志」「logs/requests/clear」「logsKept」；`dist/index.js` 含 clear 路由与保护窗口常量。
- **未在浏览器实测**：8321 上的 UI 是用户 2:39PM 终端前台手起的旧进程（launchd `local-aiproxy-webui` 未加载），`local-aiproxy restart` 只重启模型网关；`web` 命令不支持自定义端口，无法另起实例。需用户自行重启该进程。

### ⚠️ 后续
- 可考虑把 UI 纳入 launchd 托管（plist 已存在但 `RunAtLoad=0`），统一用 `launchctl kickstart -k` 重启，避免「新代码不生效」的困惑。