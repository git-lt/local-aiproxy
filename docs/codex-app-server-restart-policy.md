# Codex App Server 重启与目录刷新策略

## 结论

Codex `app-server` 在启动时读取 `model_catalog_json`，并在内存中构建静态模型目录；
后续静态 catalog 更新后，它不会自动重读。动态模式不配置该字段，会周期请求
`/models`。启用静态目录或删除已加载的静态配置时，需要停止旧 `app-server` 才能切换
模型管理器；动态 `/models` 即使返回了新目录，已打开的模型选择器也可能继续持有旧快照。

**网关不再提供 `--restart-codex`，也不再读写 `~/.codex/config.toml`；
Web UI 的 `/ui/api/codex/restart` 端点也已移除。**
模型列表或 Codex 侧接线变化后，需要用户自行完全退出并重新打开 Codex。
本文件保留的是「为什么必须重启」的链路分析。

## 网关侧动作与 Codex 侧刷新的边界

1. **网关重启**：模式在 split 与 upstream-only 之间变化、每次带参数的 `config`
   配置写入，或显式执行 `codex-cliproxy restart` 时发生。`start`/`restart` 会先做
   首次初始化（按需创建 `config.json`、注册 launchd）。这些都与 Codex 进程无关。
2. **Codex 侧刷新**：只能由用户重启 Codex 或等待它自身的周期性刷新触发。
   CLI 与 Web UI 都不检查、不枚举、也不停止 Codex app-server。
3. 手工修改 `config.json` 或 `~/.codex/config.toml` 不会触发任何网关重启。
4. `config` 设置 zcode、codebuddy 开关或地域偏好只会改变网关 `/models` 的返回内容，
   网关**不会**去失效 Codex 的 `models_cache.json`；Codex 靠自身的 TTL／worker 自愈。

## Codex 侧目录刷新链路（2026-09-21 源码与实测，Codex 0.155.0 / ChatGPT.app）

依据 openai/codex 的 `models-manager` 与 app-server 源码（cache.rs /
manager.rs / models_refresh_worker.rs / catalog_processor.rs），结合本机
`codex` 二进制与 `app.asar` 的字符串分析：目录从网关到 picker 经过三层缓存，
任何一层都不向下游推送。

| 层 | 机制 | 数值 | 刷新/失效条件 |
| --- | --- | --- | --- |
| UI（react-query） | `model/list` 查询 | staleTime 5 分钟 | 缓存过期后需再发生一次挂载或窗口聚焦（refetchOnWindowFocus）才会重新拉取；queryKey 含 `modelCatalogPath`/`modelProvider` |
| app-server 后台 worker | `models_refresh_worker` 定时以 `RefreshStrategy::Online` 强制回源 | 270 秒 | 无条件定时刷新，刻意短于缓存 TTL，使磁盘缓存永远新鲜 |
| app-server 磁盘缓存 | `models_cache.json`（`ModelsCacheEntry`：fetched_at / etag / client_version / identity / models） | TTL 300 秒 | `client_version` 与期望不符即判 miss；保存时整体重序列化、丢弃未知字段。**本网关不读写该文件**，因此只能等 TTL／worker 自愈 |

补充事实：

- 静态/动态目录是 `ModelsManager` 的两个实现，进程构造时二选一：
  `StaticModelsManager` 的刷新方法是空操作，永不重读磁盘；只有动态实现
  才有缓存与回源。这就是静态目录更新与模式切换必须重启 app-server 的根因。
- 协议中没有模型列表推送（skills 有 `SkillsChanged` 通知，models 没有）；
  UI 侧 picker 也没有刷新入口。`session_configured` 事件会携带
  `available_models`/`default_model` 快照，但 picker 渲染主要来自上表的
  5 分钟查询。
- 走本网关时官方 ETag 不透传（响应混入本地 rows），codex 缓存的 `etag`
  字段恒为空，动态模式实际靠 TTL 与 270 秒 worker 判新鲜度。
- 推论：动态模式下变更目录，picker 最坏延迟 ≈ UI 的 5 分钟 staleTime
  （app-server 侧最多 270 秒自愈）。要立即看到变化：重载 App 窗口（如
  可用）、等 5 分钟后点击一次窗口，或重启 Codex App；外部进程无法更快。

## 生效边界

2026-09-21 实测（Codex 0.155.0 / ChatGPT.app）：app-server 重启后会在约 4 秒内
重新拉取 `/models`，`models_cache.json` 同步更新；但已打开的模型选择器仍渲染
旧快照。UI 层的刷新时机在 App 进程内部，外部进程（网关、CLI）均无法触发；
立即刷新手段见上节「Codex 侧目录刷新链路」。
