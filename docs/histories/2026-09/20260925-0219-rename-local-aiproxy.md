## [2026-09-25 02:19] | Task: 项目与命令改名为 local-aiproxy

### 🤖 Execution Context
* **Agent ID**: `CodeBuddy`
* **Base Model**: `Hy4 preview`
* **Runtime**: `CodeBuddy IDE`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 把当前项目名称改成 local-aiproxy，命令名称也用这个，然后列一下，当前设计的有哪些命令

确认范围：命令名 + 展示文案、运行时目录、launchd 服务；运行时目录自动迁移并保留备份；改完重启本机两个进程并顺手修 `web` 命令。仓库 URL 与 schema `$id` 不改。

### 🛠 Changes Overview
**Scope:** `package.json`、`src/{cli,paths,launchd,gateway,webui,types}.ts`、`src/ui/*`、`src/qodercn/request.ts`、`src/cline/credentials.ts`、`scripts/log-check.ts`、`vite.config.ts`、`README.md`、`test/*`

**Key Actions:**
- **[改名]** 包名与 bin `codex-cliproxy-gateway` / `codex-cliproxy` → `local-aiproxy`；命令名收敛为 `COMMAND_NAME` 常量（usage 与错误提示统一引用）；环境变量前缀 `CODEX_CLIPROXY_*` → `LOCAL_AIPROXY_*`；UI 标题、品牌、文案与上游 UA 同步。
- **[改名]** 运行时目录 `~/.codex-cliproxy-gateway` → `~/.local-aiproxy`；plist 名 `local-aiproxy.plist` / `local-aiproxy-webui.plist`（含 `-temp` 变体）。
- **[新增]** `migrateRuntimeHome()`：旧目录存在且新目录不存在时复制过去，旧目录改名为 `.codex-cliproxy-gateway.bak`（冲突时加时间戳），在 `runCli` 最前面执行一次。
- **[新增]** `bootoutLegacyLaunchAgents()`：注册新 agent 前 bootout 旧 label 并删除旧 plist，避免旧服务继续跑旧二进制；`uninstall` 同样调用。
- **[修复]** `web` 命令不再要求 `state.json`（`state.json` 由 `start`/`restart` 维护，`serve` 不写它），改为校验 `config.json`。

### 🧠 Design Intent (Why)
改名真正的风险不在字符串，而在两处有状态的实体：运行时目录（装着 config/token/日志/catalog 缓存）和 launchd 服务（常驻进程）。前者必须「先搬后改名、留备份」，否则用户一改名就像丢了配置；后者必须显式 bootout，否则新旧两套服务并存。命令名收敛成常量是为了让下一次改名只改一处。`web` 命令那条检查则是因为 `serve` 起的实例天然没有 `state.json`，用「有没有 state.json」判断「装没装」本身就是错的。

### 📊 Change Stats
> 工作区存在其他在途未提交改动，共享文件行数为混合结果；本次为跨文件机械改名 + 3 处结构性新增。

- **Files changed:** 24（批量改名 21 + 新增逻辑 3）
- **New:** `migrateRuntimeHome()`、`bootoutLegacyLaunchAgents()`、`COMMAND_NAME`

### 📁 Files Modified
- `package.json`（name / bin / scripts 环境变量；`repository` 与 `homepage` 按约定保持旧仓库）
- `src/cli.ts`、`src/paths.ts`、`src/launchd.ts`、`src/gateway.ts`、`src/webui.ts`、`src/types.ts`
- `src/ui/{index.html,styles.css,api.ts,i18n.tsx,Header.tsx}`
- `src/qodercn/request.ts`、`src/cline/credentials.ts`、`scripts/log-check.ts`、`vite.config.ts`
- `README.md`、`test/{paths,webui,install-rollback,cline-gateway,codebuddy-gateway,cli-flags,zcode-cli}.test.ts`

### ✅ Verification
- `bun run check`：317 pass / 0 fail（新增迁移用例 1 项）。
- 本机实例：旧目录 → `~/.local-aiproxy`（旧目录留 `.bak`），网关与 Web UI 均按新名重启；`/healthz` 返回 `qodercn:true`，`/ui/api/config` 返回 `qodercn:true` 与 14 个白名单模型；`web` 命令不再报 `Gateway is not installed`。

### ⚠️ 已知遗留
- `runCli()` 前部的迁移用的是 `resolvePaths()`（真实 HOME），因此 `bun test` 里调用 `runCli` 的用例会真实触发一次家目录迁移。迁移幂等且有备份，但测试不该改动用户环境；后续应给 `runCli` 注入 paths（或在测试里隔离 HOME）后再让迁移只在生产路径生效。
- `README.md` 只做了名字替换，正文仍描述已移除的能力（`--sync`、`--upstream-only`、第三方上游等），需单独重写。
