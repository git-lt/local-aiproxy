# local-aiproxy

一个跑在本机的 Bun 网关：把本机各 AI 客户端已有的登录态，转换成本地可用的
**OpenAI 兼容接口**（`/v1/models`、`/v1/responses`），供使用 Responses API 的
本地 Agent 直接调用。

代理链路只有一跳：客户端 → 本机网关 → 对应客户端自己的服务端。网关不持有
任何上游 API Key，也不代理到任何第三方中转服务。

## 它做什么、不做什么

**做：**

- 只读消费本机客户端的登录态，代为发起请求，并把响应翻回标准 Responses 事件流；
- 只监听环回地址，只写自己的运行时目录；
- 提供内建 Web 界面（独立端口、令牌鉴权）管理开关与模型白名单。

**不做：**

- 不代为登录、不保存或导出任何凭据；凭据过期请回到对应客户端重新登录；
- 不写入本机其他客户端的配置目录（只做只读展示）；
- 不支持 WebSocket 传输（Realtime 之类一律返回 426，让客户端降级到 HTTPS/SSE）。

## 前置条件

- Bun 1.2+。
- 本机至少有一个受支持的客户端已登录（见[接入的服务](#接入的服务)）。
- 自动安装、后台服务与配置写入命令依赖 macOS 的 launchd；其他平台用
  [`serve`](#其他平台) 前台运行。

## 安装与启动

```bash
npm install -g local-aiproxy
local-aiproxy start
```

`start` 首次运行会：创建 `~/.local-aiproxy/config.json`（默认端口 `8320`）、
按需注册并启动 launchd 服务、等待 `/healthz` 通过。

`restart` 先执行同样的初始化再重启；`stop` 停止网关与后台 Web 界面。

## 命令

| 命令 | 用途 |
| --- | --- |
| `local-aiproxy start` | 按需创建配置、注册服务并启动网关。 |
| `local-aiproxy stop` | 停止网关与后台 Web 界面。 |
| `local-aiproxy restart` | 先执行与 `start` 相同的初始化，再重启。 |
| `local-aiproxy status` | 查看网关状态与当前配置。 |
| `local-aiproxy serve [--config PATH]` | 前台运行网关（非 macOS 用这个）。 |
| `local-aiproxy models [...]` | 列出本机各登录态可见的模型。 |
| `local-aiproxy config [...]` | 无参打印当前配置；带参则写盘并重启网关。 |
| `local-aiproxy web [...]` | 运行/管理 Web 界面。 |
| `local-aiproxy uninstall` | 卸载服务，保留 `config.json`。 |

`models` 的选项：`--zcode`、`--codebuddy`、`--cline`、`--qodercn`（四选一，
只看该分组）、`--json`、`--refresh`。它不要求对应开关已打开——先看清单再决定
开哪个才是常见顺序。

`config` 的选项：`--zcode/--codebuddy/--cline/--qodercn on|off`、
`--codebuddy-region auto|cn|intl`、`--log on|off`、`--max-request-logs N`、
`--max-log-size SIZE`。可组合；每次改动都会自动重启网关。

`web` 的选项：`--start`（前台，默认）、`--daemon`（后台）、`--status`、
`--stop`、`--restart`。后台命令只管界面服务，不碰网关。

## 接入的服务

| 开关 | 模型前缀 | 凭据来源（只读） |
| --- | --- | --- |
| `--zcode` | `zcode/…` | 本机 ZCode 的登录与套餐配置 |
| `--codebuddy` | `codebuddy-<region>/…` | 本机 CodeBuddy/WorkBuddy 登录态 |
| `--cline` | `cline/…`、`cline-free/…` | 官方 API Key 文件 / Cline CLI 登录态 |
| `--qodercn` | `qodercn/…` | 本机 QoderCN（通义灵码）登录缓存 |

```bash
local-aiproxy config --zcode on
local-aiproxy config --qodercn on
```

实际能用到哪些模型取决于你在本机客户端里的登录与权限。没有第三方上游，
也没有任何回落：未收录的模型一律本地 404。

## 模型白名单

对外可见的模型由 `enabledModels` 控制（匹配不区分大小写，`*` 表示全部放行）：

- 不在白名单里的模型：`/v1/models` 不返回，转发请求返回 `model_not_found`；
- **缺省或空数组 = 一个都不放行**，需要你在 Web 界面里点开，或写进
  `config.json` 后重启；
- 在界面里勾选模型会立即保存并触发网关重启。

## 配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址；启用本地接入时只能是环回地址。 |
| `port` | `8320` | 网关端口（Web 界面为端口 + 1）。 |
| `mountPath` | `/v1` | API 挂载路径，决定客户端的 base URL。 |
| `catalogPath` | 运行时目录下的 `catalog.json` | 运行时目录锚点，网关不读写该文件本身。 |
| `requestLogging` | `false` | 是否落盘完整的请求/响应交换。 |
| `maxRequestLogs` | `0` | 请求日志目录保留的文件数，`0` 表示不限。 |
| `maxGatewayLogBytes` | `0` | 主日志大小上限（如 `512KB`、`10MB`），`0` 表示不限。 |
| `zcode` / `codebuddy` / `cline` / `qodercn` | `false` | 各接入的开关。 |
| `codebuddyRegion` | `auto` | CodeBuddy/WorkBuddy 凭据地域。 |
| `enabledModels` | `[]` | 对外模型白名单。 |

字段全集与校验规则见 [配置格式](schemas/gateway-config.schema.json)。

## 客户端接入

把客户端的 base URL 指向网关，API Key 填任意值（网关不校验）：

```
http://127.0.0.1:8320/v1
```

模型填白名单里已放行的条目，例如 `qodercn/auto`。可用 `local-aiproxy models`
或 `GET /v1/models` 查看当前对外可见的模型。

## Web 界面

```bash
local-aiproxy web
```

默认地址 `http://127.0.0.1:8321/ui`（网关端口 + 1），只绑定环回并需要令牌；
令牌可从 `~/.local-aiproxy/ui-token` 获取，或用 `web` 直接打开带令牌的链接。
界面里可以改开关、勾选模型、查看日志、切换中英文。后台界面不会随登录或重启
自动开启，需要再次运行 `web --daemon`。

## 文件位置

- 配置：`~/.local-aiproxy/config.json`
- 主日志：`~/.local-aiproxy/gateway.log`（达到上限后轮换，保留最近 5 份备份）
- 请求日志：`~/.local-aiproxy/logs/`
- 界面令牌：`~/.local-aiproxy/ui-token`

## 其他平台

非 macOS 只能前台运行，需先准备好配置文件：

```bash
local-aiproxy serve --config /path/to/config.json
```

`serve` 不注册服务、不启动界面；配置改动请直接编辑文件后重启进程。需要界面时
在另一个终端执行（POSIX shell）：

```bash
LOCAL_AIPROXY_UI_SERVICE=1 local-aiproxy web
```

## 常见问题

- **看不到任何模型**：先确认对应开关已打开，且模型已在白名单里放行
  （缺省全部禁用），然后 `local-aiproxy models` 看看清单。
- **模型不可用 / 报凭据错误**：回到对应客户端重新登录，网关不会代为刷新凭据。
- **提示 WebSocket 不支持**：这是预期行为，客户端会自动降级到 HTTPS/SSE。
- **改了配置没生效**：通过命令或界面改的会自动重启；手动编辑文件后需自行重启。
- **界面打不开**：重新运行 `local-aiproxy web`；提示端口被占用时先 `web --stop`。
