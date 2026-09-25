# 移除 install 命令与 Codex 配置管理

## 目标

把 CLI 收敛成「起一个本地网关服务，Codex 侧由用户自己接线」：

1. 删除 `install` 命令；`start` 吸收首次初始化（可执行、非交互）。
2. 彻底移除对 `$CODEX_HOME` 下任何文件的读写：`config.toml` 的 4 个受管键与备份、
   Codex 的 `models_cache.json`、legacy `cliproxy-catalog.json`。
3. 移除 `--restart-codex`。

最终命令集：`start` / `stop` / `restart` / `status` / `serve` / `uninstall` / `models` / `config` / `web`。

## 范围

- 包含：`src/cli.ts` 主体删减 + 新增 `ensureGatewayInstalled`；`src/toml.ts`、`src/launchd.ts`
  死代码；测试增删改；5 份文档更新。
- 不包含：`src/gateway.ts`、`src/codebuddy/`、`src/zcode/`、`src/webui.ts`、
  `src/realtime.ts`（只读 config.toml，保留）、`schemas/gateway-config.schema.json`
  （不涉 `config.json` 字段变更）。

## 背景

- 相关文档：[Codex App Server 重启与目录刷新策略](../codex-app-server-restart-policy.md)、
  [动态目录方案](../model-catalog-dynamic-refresh-plan.md)、
  [官方 Realtime 方案](../official-realtime-proxy-plan.md)
- 相关代码路径：`src/cli.ts`、`src/toml.ts`、`src/launchd.ts`
- 已知约束：
  - Codex 侧接线（`openai_base_url`、`model_catalog_json`、两个 realtime base url）改由用户
    自行配置；网关只写 `~/.codex-cliproxy-gateway/*`。
  - 上游 API Key 只能来自 `API_KEY` 环境变量或已存的钥匙串/`credentials.json`。
  - 上游地址、端口、前缀、`upstreamType` 没有 CLI/UI 入口，只能手改 `config.json`。

## 风险

| 风险 | 缓解方式 |
| --- | --- |
| `start` 调真实 `launchctl` 与 `deleteApiKey`，测试会改坏本机 | `GatewayInstallDeps` / `GatewayUninstallDeps` 依赖注入，测试全程不碰真实 launchd 与钥匙串 |
| 删除面大（cli.ts 约 540 行），漏改导致编译不过 | 按符号名逐个删，每步保持 `tsc --noEmit` 绿，最后 `bun run check` |
| 去掉 Codex 缓存失效后，目录变更不再立即生效 | 已确认代价可接受：Codex 自身 270 秒 worker + 300 秒 TTL，最晚约 5 分钟自愈；README / 文档已写明 |

## 里程碑

1. 调研与方案收敛（确认删除清单、legacy 恢复语义、注入点设计）。
2. 实现：`ensureGatewayInstalled` → 删除 install 与死代码 → 移除 config.toml 残留 → 收 CLI 面。
3. 验证、交付与收尾。

## 验证方式

- 命令：`bun run typecheck`、`bun test`、`bun run check`（全部通过；测试数 480 → 474）。
- 零写入审计：`grep -rn "configToml\|modelsCacheFile\|codexHome" src/` 逐条确认——
  现在只剩 `status()` 与 `serve()` 的**只读**，以及 `launchd.ts` 把 `CODEX_HOME` 写进 plist 的
  环境变量（不是写 Codex 配置）。
- 自动化：
  - 删除 9 项与 config.toml 管理强耦合的用例（`gateway.test.ts` 3、`realtime.test.ts` 2、
    `install-rollback.test.ts` 2、`app-server.test.ts` 2）。
  - 改写 `model-catalog-dynamic.test.ts` 的 `models --sync` 端到端用例：去掉 config.toml
    断言与非受管守卫用例，新增「`config.toml` 与 `models_cache.json` 逐字节未变」。
  - 改写 `webui.test.ts` / `app-server.test.ts` / `zcode-gateway.test.ts` 中原本断言
    「缓存被过期/撤下」的用例，改为断言缓存逐字节未变。
  - 新增 `test/start-init.test.ts`：首次 start 建 config.json + 注册 + 写 state、
    restart 自举、已初始化时不重复注册且保留未知 state 字段、`API_KEY` 的写入/不写入、
    start/restart 不改动 config.toml、uninstall 对任何 state 都不碰 `~/.codex`。
- 手工检查（macOS）：见「进度记录」最后一项。
- 观测检查：`status` 仍只读显示 Codex 侧 4 个键，便于确认 Codex 是否已指向网关；
  配置审计继续落在 `logs/cliproxy-config-*.log`。

## 进度记录

- [x] 确认删除清单与零写入目标。
- [x] 新增 `ensureGatewayInstalled`，`start`/`restart` 自举、`stop` 保持要求已安装。
- [x] 删除 `install` 及其 12 个专属辅助函数。
- [x] 移除 `models --sync`、`restart`、`uninstall` 里的 config.toml 读写。
- [x] 删除 `toml.ts` 的 `patchRootToml`/`hasRootTomlKey` 与 `launchd.ts` 的 `reloadLaunchAgent`。
- [x] 删除 legacy 卸载恢复分支与 `hash`/`restoreBackup`/`restoreRootTomlKeys`/
      `MANAGED_CONFIG_KEYS`/`BackupRecord`/两个 `InstallState` 旧字段。
- [x] 删除 6 处 `models_cache.json` 失效写入与 `codexModelsCacheFile` 传参链路，
      `invalidateModelsCache`/`clearModelsCacheEntries` 从 `catalog.ts` 移除。
- [x] 测试删改增，`bun test` 474 项全绿。
- [x] 更新 README / AGENTS.md / 3 份 topic 文档。
- [ ] 手工冒烟（需要在本机真实环境执行）：
  移开 `~/.codex-cliproxy-gateway` 后 `codex-cliproxy start` 应生成 config.json、
  注册并启动、`status` 显示 `health: ok`；`API_KEY=xxx codex-cliproxy start` 后确认钥匙串已写入；
  整套命令前后 `~/.codex/config.toml` 与 `models_cache.json` 的 `md5` 一致；`models --sync` 可用。

## 决策记录

- 2026-09-23：删除 `install` 而非保留并加开关。用户明确要求「只用 start 启动服务」，
  且默认不碰 `config.toml`、不打印任何提示。
- 2026-09-23：`start` 与 `restart` **都**执行首轮初始化。install 消失后若只有 `start` 能自举，
  用户在空机器上跑 `restart` 会得到「未安装」错误；两者自举更一致。
- 2026-09-23：`start`/`stop`/`restart` 不接受任何选项。非默认配置只能用 `serve --config`，
  避免把 `--config` 语义扩散到 launchd 注册路径（需要把配置路径写进 plist 与 state）。
- 2026-09-23：上游 API Key 只在 `API_KEY` 非空时写入钥匙串，未提供时**完全不动**已存值——
  避免误清空用户已配置的 Key。代价：无法通过 CLI 显式清除 Key（需要手动删钥匙串条目）。
- 2026-09-23：保留 `models --sync --upstream-only`。它切换的是路由模式（用哪份目录、
  是否纯转发），与「把 Codex 指向网关」不是一类；删掉会整体废掉 `models` 的模式切换能力。
- 2026-09-23：`status` 保留对 Codex 侧 4 个键的**只读**展示。它是「Codex 到底指没指到网关」
  的唯一排查信号，且 `uninstall` 本来就要读这个文件；只有 `authJsonModified` 这个恒为 false
  的字段被删。
- 2026-09-23：**legacy 恢复分支也删掉了**（第二轮，用户要求「不碰 codex 配置」）。
  第一轮曾保留一个由旧 state 字段触发的恢复分支，但审计后确认：本机根本没有旧 state，
  该分支不可达；而它仍是唯一会写 `config.toml` 的代码。因此连它一起删除，
  连带清掉 `hash` / `restoreBackup` / `restoreRootTomlKeys` / `MANAGED_CONFIG_KEYS` /
  `BackupRecord` / `InstallState.configBackup` / `installedConfigHash`。
  `toml.ts` 只剩 `readRootTomlString`（`status` 只读用）与 `atomicWrite`。
  代价：用旧版本装过的实例卸载后 `config.toml` 会留着指向已停用网关，需用户手动清理。
- 2026-09-23：**`~/.codex/models_cache.json` 的失效逻辑也删掉了**（同一轮）。
  原先 `invalidateModelsCache` / `clearModelsCacheEntries` 被 6 处调用（`uninstall`、
  `models --sync`、`config`、Web UI、ZCode 目录变化、CodeBuddy 目录变化），
  重写 Codex 的缓存以让 Codex 立刻重拉 `/models`。现在改为零写入：
  两个函数从 `catalog.ts` 删除，`codexModelsCacheFile` 传参链路（`ZcodeDependencies` /
  `CodebuddyDependencies` / `CodebuddyCatalogStoreOptions` / `startGateway` 调用）一并清掉。
  代价：目录变更后 Codex 最晚约 5 分钟（自身 270 秒 worker + 300 秒 TTL）才看到新列表。
  `ResolvedPaths.modelsCacheFile` 保留，但注释明确「网关从不读写，仅供测试断言未触碰」。
