## [2026-09-23 17:22] | Task: 移除 install 命令与 config.toml 管理

### 🤖 Execution Context
* **Agent ID**: `codebuddy-code`
* **Base Model**: `Deepseek-V4.1-Flash`
* **Runtime**: `CodeBuddy Code CLI`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> 在 install 的时候不要去改 ~/.codex/config.toml 可以吗
> codex-cliproxy install 去掉这个命令 ，只用 start 启动服务

（交互中确认：所有命令都不写 config.toml、改成默认不写、不打印任何提示、
完全移除写入能力；`start` 只做最小初始化、上游 Key 走 `API_KEY` 环境变量、
模型目录交给 `models --sync`、保留 `uninstall` 与 `serve`、`start` 不接受任何参数、
`--restart-codex` 一并去掉、旧实例卸载仍恢复 config.toml。）

### 🛠 Changes Overview
**Scope:** `src/cli.ts`（主体删减与新增）、`src/toml.ts`、`src/launchd.ts`、`test/`、`docs/`

**Key Actions:**
- **新增 `ensureGatewayInstalled(paths, deps)`**：`config.json` 缺失时用默认值创建；`API_KEY`
  非空时写入钥匙串；plist 缺失时注册 launchd；合并写 `state.json`。`GatewayInstallDeps`
  暴露 `installLaunchAgent`/`startLaunchAgent`/`restartLaunchAgent`/`stopLaunchAgent`/
  `waitForHealth`/`saveApiKey` 注入点。
- **删除 `install` 命令**及其专属辅助：`getInstallApiKey`、`readSecretFromTerminal`、
  `confirmInstallOverwrite`、`backupConfig`、`timestamp`、`gatewayStartupDiagnostics`、
  `composeInstallFailureMessage`、`restoredHealthUrl`、`refreshCodexAppServer`、
  `applyModelCatalogToml`、`managedCodexServiceToml`、`managedCodexToml`、
  `parseUpstreamTypeOption`。
- **`start`/`restart` 自举**：都先 `ensureGatewayInstalled` 再启动/重启；`stop` 仍要求已安装。
- **移除 `--restart-codex`**：连带删除 `refreshCodexAppServer` 与全部 4 处调用、CLI 白名单
  与布尔列表项；`stopCodexAppServers` 保留（Web UI 的 `/ui/api/codex/restart` 仍用）。
- **`uninstall` 加 legacy 分支**：`configBackup` 与 `installedConfigHash` 同时存在才恢复
  config.toml，否则完全不碰；`InstallState` 两个字段改为可选，删除 write-only 的
  `gatewayBaseUrl`。
- **死代码清理**：`toml.ts` 删 `patchRootToml`/`hasRootTomlKey`/`encodeTomlString`/
  `splitComment`；`launchd.ts` 删 `reloadLaunchAgent`。
- **测试**：删 9 项、改写 `models --sync` 端到端用例、新增 `test/start-init.test.ts` 6 项。
- **文档**：README 重写「启动与首次使用 / 配置上游 / 上游 API Key / 何时需要重启 Codex /
  服务管理与卸载 / 常见问题」；AGENTS.md 红线收紧为「不得读写 `~/.codex/config.toml`」；
  `codex-app-server-restart-policy.md` 重写；两份 topic 文档加变更说明并修正受影响段落。

### 🧠 Design Intent (Why)
- 用户的诉求是「这个工具别碰我的 Codex 配置」。原先 `install`/`restart`/`models --sync`
  都会改写 `~/.codex/config.toml` 的 4 个受管键并做整文件备份/恢复，一旦用户自己也在维护
  该文件就存在互相覆盖的风险。
- 只让 `install` 不写而 `restart` 照旧写等于没防住（装完一 restart 就被写回去），
  所以三处一起改，并彻底删掉写入能力而不是加开关。
- `install` 消失后必须有另一条初始化路径，因此让 `start`/`restart` 都自举；
  `restart` 也自举是为了避免空机器上 `restart` 直接报「未安装」。
- 老实例在升级前 config.toml 已被写过，`uninstall` 若一律不恢复会把地址留成死的，
  所以保留一个由旧 state 字段触发的 legacy 恢复分支，并把这个触发条件写进 AGENTS.md
  防止日后扩大。
- 全部外部副作用（launchd、钥匙串）走依赖注入，避免单测真的 bootstrap 服务或删掉
  用户的钥匙串条目。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（未提交工作区）。

- **Tracked files changed:** 13
- **Insertions:** +305
- **Deletions:** -963
- **New files:** 2（`test/start-init.test.ts`、执行计划）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +141 | -541 |
| `src/toml.ts` | +0 | -69 |
| `src/launchd.ts` | +0 | -12 |
| `README.md` | +73 | -67 |
| `AGENTS.md` | +7 | -2 |
| `docs/codex-app-server-restart-policy.md` | +21 | -39 |
| `docs/model-catalog-dynamic-refresh-plan.md` | +22 | -15 |
| `docs/official-realtime-proxy-plan.md` | +15 | -11 |
| `test/realtime.test.ts` | +0 | -52 |
| `test/app-server.test.ts` | +11 | -45 |
| `test/gateway.test.ts` | +1 | -41 |
| `test/install-rollback.test.ts` | +1 | -38 |
| `test/model-catalog-dynamic.test.ts` | +13 | -31 |
| `test/start-init.test.ts` | +215（新） | - |

### 📁 Files Modified
- `src/cli.ts`
- `src/toml.ts`
- `src/launchd.ts`
- `README.md`
- `AGENTS.md`
- `docs/codex-app-server-restart-policy.md`
- `docs/model-catalog-dynamic-refresh-plan.md`
- `docs/official-realtime-proxy-plan.md`
- `docs/exec-plans/completed/remove-install-command.md`（新）
- `test/start-init.test.ts`（新）
- `test/gateway.test.ts`
- `test/realtime.test.ts`
- `test/install-rollback.test.ts`
- `test/model-catalog-dynamic.test.ts`
- `test/app-server.test.ts`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test`：**474 项 / 31 个文件 / 0 失败**（原 480 项；删除 11 项、改写 6 项、新增 5 项）。
- `bun run check`（typecheck + test + build）通过。
- 新用例 `test/start-init.test.ts` 全绿，全程依赖注入，不触碰真实 launchd 与钥匙串。
- 零写入审计：`grep -rn "configToml\|modelsCacheFile\|codexHome" src/` 逐条确认，只剩
  `status()` 与 `serve()` 的只读，以及 `launchd.ts` 把 `CODEX_HOME` 写进 plist 的环境变量。
- 手工冒烟（macOS 真实环境）尚未执行，步骤记在
  [执行计划](../../exec-plans/completed/remove-install-command.md) 的进度记录里。

---

## 第二轮（同日后续）：收敛到「对 `$CODEX_HOME` 绝对零写入」

### 📥 User Query
> 检查一下还有没有改 codex 配置的逻辑
> 不碰 codex 配置

（审计后发现两处残留：`uninstall` 的 legacy 恢复分支，以及 6 处对
`~/.codex/models_cache.json` 的失效写入。用户确认两处一并删除。）

### 🛠 Changes Overview（第二轮增补）

**Key Actions:**
- **删除 legacy 卸载恢复分支**：`uninstall` 不再读 `state.json` 内容、不再读/写
  `config.toml`、不再删 legacy `cliproxy-catalog.json`。连带删除 `hash`、`restoreBackup`、
  `BackupRecord`、`MANAGED_CONFIG_KEYS`、`InstallState.configBackup`/`installedConfigHash`，
  以及 `toml.ts` 的 `restoreRootTomlKeys`（`toml.ts` 只剩 `readRootTomlString` + `atomicWrite`）。
- **删除 Codex 目录缓存写入**：`invalidateModelsCache` / `clearModelsCacheEntries` 从
  `catalog.ts` 移除；6 处调用（`uninstall`、`models --sync`、`config`、Web UI、
  ZCode 目录变化、CodeBuddy 目录变化）全部去掉；`codexModelsCacheFile` 传参链路
  （`ZcodeDependencies`、`CodebuddyDependencies`、`CodebuddyCatalogStoreOptions`、
  `startGateway` 调用、`writeDisk` 的 `previous` 参数）一并清理。
- **类型注释明确边界**：`ResolvedPaths.configToml` 标注「只读」，`modelsCacheFile` 标注
  「网关从不读写，仅供测试断言未触碰」。
- **AGENTS.md 红线扩写**：从「不得读写 `~/.codex/config.toml`」改为「不得读写 `$CODEX_HOME`
  下的任何文件」，并列出允许的两个只读例外。
- **测试改为断言零写入**：`webui.test.ts`、`app-server.test.ts`、`zcode-gateway.test.ts`、
  `model-catalog-dynamic.test.ts` 中原本断言「缓存被过期 / 条目被撤下」的用例，
  统一改为「缓存逐字节未变」；`start-init.test.ts` 的 legacy 恢复用例改为
  「uninstall 对任何 state 都不碰 `~/.codex`」。

### 🧠 Design Intent (Why)
- 用户的目标是「这个工具不要碰我的东西」。`~/.codex/config.toml` 在本机其实由另一个工具
  （`opencodex`，`openai_base_url` 指向 `127.0.0.1:10100`）使用，互相覆盖的风险是真实的。
- legacy 恢复分支虽然只在旧 state 存在时可触发（本机不存在旧 state，实际不可达），
  但它仍是唯一会写 `config.toml` 的代码路径；保留一个不可达的写路径与「不碰」的意图矛盾，
  且日后容易被误扩大，故一并删除。
- `models_cache.json` 的失效写入是为了让 Codex 立刻重拉 `/models`。去掉后最坏情况是
  目录变更延迟约 5 分钟生效（Codex 自身 270 秒 worker + 300 秒 TTL 会自愈），
  这个代价换「绝对零写入」是划算的。
- `ResolvedPaths.modelsCacheFile` 保留而非删除：它把「Codex 侧的路径」显式登记下来，
  让测试能对具体路径断言未被触碰，比删除后各处自行拼路径更不容易写错。

### 📊 Change Stats（第二轮后的累计值）
> 数据来自 `git diff --shortstat` / `git diff --numstat`（未提交工作区，含第一轮）。

- **Tracked files changed:** 22
- **Insertions:** +349
- **Deletions:** -1255
- **New files:** 3（`test/start-init.test.ts` 208 行、执行计划、本历史记录）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +119 | -583 |
| `src/catalog.ts` | +0 | -45 |
| `src/toml.ts` | +0 | -69 |
| `src/zcode/index.ts` | +1 | -28 |
| `src/launchd.ts` | +0 | -12 |
| `src/webui.ts` | +0 | -8 |
| `src/codebuddy/catalog.ts` | +3 | -10 |
| `src/codebuddy/index.ts` | +0 | -3 |
| `src/paths.ts` | +1 | -0 |
| `src/types.ts` | +8 | -0 |
| `README.md` | +74 | -69 |
| `AGENTS.md` | +8 | -2 |
| `docs/codex-app-server-restart-policy.md` | +21 | -40 |
| `docs/model-catalog-dynamic-refresh-plan.md` | +25 | -17 |
| `docs/official-realtime-proxy-plan.md` | +15 | -11 |
| `test/model-catalog-dynamic.test.ts` | +23 | -92 |
| `test/zcode-gateway.test.ts` | +22 | -53 |
| `test/realtime.test.ts` | +0 | -52 |
| `test/gateway.test.ts` | +1 | -41 |
| `test/install-rollback.test.ts` | +1 | -38 |
| `test/app-server.test.ts` | +14 | -52 |
| `test/codebuddy-catalog.test.ts` | +0 | -20 |
| `test/webui.test.ts` | +13 | -10 |
| `test/start-init.test.ts` | +208（新） | - |

### ✅ Verification（第二轮）
- `bun run check`：typecheck + **474 项测试** + build 全部通过。
- 零写入审计逐条复核通过（见第一轮第二小节）。

