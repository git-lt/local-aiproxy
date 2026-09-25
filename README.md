# local-aiproxy

A small cross-platform, Bun-powered local gateway for Codex Desktop and Codex CLI.

It keeps Codex signed in with ChatGPT for native models, while models whose IDs begin with `cliproxy/` are sent to CLIProxyAPI with a separate API key.

## 使用前准备

- 安装 Bun 1.2+ 和 Codex Desktop 或 Codex CLI。
- 准备可访问的 CLIProxyAPI 或 new-api 服务。
- 同时使用官方模型时，先在 Codex 中登录 ChatGPT；只使用第三方上游可选
  `--upstream-only`。
- 自动安装、卸载及后台服务管理目前仅支持 macOS。其他 Bun 支持的平台可手动配置后
  前台运行，见[手动运行](#手动运行)。

## 启动与首次使用

以下服务管理步骤适用于 macOS：

```bash
npm install -g local-aiproxy
local-aiproxy start
```

`start` 在首次运行时做三件事：

1. 用默认值创建 `~/.local-aiproxy/config.json`（默认上游 `http://127.0.0.1:8317/v1`，网关端口 `8320`）；
2. 若 `API_KEY` 环境变量非空，把它写入登录钥匙串；
3. 注册并启动 launchd 服务，等待 `/healthz` 通过。

`local-aiproxy restart` 会先执行同样的初始化再重启服务；`local-aiproxy stop` 停止网关与后台 Web 界面。

**本工具不会读写 `~/.codex/config.toml`。** Codex 侧需要你自己指向网关：

```toml
openai_base_url = "http://127.0.0.1:8320/v1"
experimental_realtime_ws_base_url = "http://127.0.0.1:8320/v1"
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:8320/v1"
```

改完后 **完全退出并重新打开 Codex Desktop**；使用 CLI 时重新启动 Codex。
默认模式下，官方模型保持原名，第三方上游模型带 `cliproxy/` 前缀。

### 配置上游

上游地址、类型、端口与模型前缀都在 `~/.local-aiproxy/config.json` 里改，
改完执行 `local-aiproxy restart`：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `upstreamBaseUrl` | `http://127.0.0.1:8317/v1` | 第三方上游地址，通常以 `/v1` 结尾。 |
| `upstreamType` | `cliproxy` | `cliproxy` 直接消费其 Codex 目录；`newapi` 从它的 OpenAI `/models` 列表本地合成目录。 |
| `officialBaseUrl` | `https://chatgpt.com/backend-api/codex` | 官方 Codex 后端。 |
| `port` | `8320` | 网关端口（Web 界面为端口 + 1）。 |
| `prefix` | `cliproxy/` | 第三方上游模型的模型名前缀。 |
| `upstreamOnly` | `false` | 只使用第三方上游，模型名不加前缀；此模式下不提供官方、ZCode 与 CodeBuddy/WorkBuddy 模型。 |

字段全集与校验规则见 [配置格式](schemas/gateway-config.schema.json)。

### 上游 API Key

`start` 在 `API_KEY` 非空时把它写入登录钥匙串：

```bash
API_KEY='your-key' local-aiproxy start
```

未提供时保留钥匙串里已有的值，不会清空。本机上游（`127.0.0.1`、`localhost` 或 `::1`）
允许空 Key；远程上游需要提供。非 macOS 平台见[手动运行](#手动运行)。

### 使用 new-api

在 `config.json` 把 `upstreamType` 设为 `newapi`，`upstreamBaseUrl` 指向该服务。
new-api 渠道需要支持 Codex 使用的 `/v1/responses`。
未登录 ChatGPT、只使用该上游时，同时把 `upstreamOnly` 设为 `true`。

### 只使用第三方上游

在 `config.json` 设 `upstreamOnly: true` 后执行
`local-aiproxy models --sync --upstream-only --select all`。

此模式使用上游原始模型名，不添加 `cliproxy/` 前缀，
也不提供官方、ZCode 或 CodeBuddy/WorkBuddy 模型。

## 选择与刷新模型

```bash
# 查看当前选中的第三方上游模型
local-aiproxy models

# 拉取最新列表并重新选择，使用默认混合模式
local-aiproxy models --sync

# 选择全部模型，保持或切换到仅上游模式
local-aiproxy models --sync --upstream-only --select all
```

**不带 `--upstream-only` 的同步命令会切回混合模式。**
刷新时会复用已保存的上游 Key。

也可以直接指定选择：

```bash
local-aiproxy models --sync --select "1,3,5-8"
local-aiproxy models --sync --select "claude-opus-4-6,gemini-3.1-pro"
local-aiproxy models --sync --select "gpt-*"
```

模型 ID 以当前上游列表为准；`*` 匹配任意字符，`?` 匹配单个字符，
通配符没有命中时按空选择处理。`--select none` 会直接清空第三方上游选择，
并在拉取目录前短路，不访问 CPA 或 new-api 的 `/models`。

如需使用维护者提供的模型元数据文件，可在同步时添加：

```bash
local-aiproxy models --sync --model-merge-json https://github.com/owner/repo
```

也支持直接提供 HTTP(S) 的 `models.json` 文件地址；仓库地址使用最新 Release 的文件。

### 何时需要重启 Codex

- 首次把 Codex 指向网关后：重启 Codex。
- 切换混合/仅上游模式后：重启 Codex。
- 修改模型选择后：重启 Codex 才能刷新模型选择器；`/models` 也会被周期性重拉，
  但已经打开的模型选择器可能仍显示旧快照。
- `local-aiproxy restart` 默认只重启网关，不影响 Codex。

网关不再改动 `~/.codex/config.toml`，因此模型列表变化后 Codex 侧不会自动重载；
也没有停止 Codex app-server 的开关——需要时请自行完全退出并重新打开 Codex。

## Web 配置界面

```bash
local-aiproxy web
```

命令会检查并按需启动网关，然后打开浏览器。默认地址为
`http://127.0.0.1:8321/ui`；自定义网关端口时，界面端口为网关端口加 1。
按 `Ctrl-C` 停止前台界面服务，网关继续运行。

界面支持修改配置、选择上游模型、查看日志及中英文切换。
保存后按页面提示应用设置或重启 Codex。

| 命令 | 用途 |
| --- | --- |
| `local-aiproxy web --daemon` | 后台运行界面并打开浏览器。 |
| `local-aiproxy web --status` | 查看界面服务状态和地址。 |
| `local-aiproxy web --stop` | 停止后台界面服务。 |
| `local-aiproxy web --restart` | 重启后台界面服务。 |

界面默认关闭，仅允许本机访问。请通过 `web` 打开带访问令牌的链接；
页面要求输入令牌时，可从 `~/.local-aiproxy/ui-token` 获取。
后台界面不会在重新登录或重启电脑后自动开启，需再次运行 `web --daemon`。

## 配置与日志

```bash
# 查看当前配置
local-aiproxy config

# 开启请求日志，并限制保留量
local-aiproxy config --log on --max-request-logs 100 --max-log-size 10MB

# 关闭请求日志
local-aiproxy config --log off
```

| 参数 | 用途 |
| --- | --- |
| `--log on\|off` | 开关请求日志，默认关闭。 |
| `--max-request-logs N` | 请求日志目录最多保留的文件数，`0` 表示不限。 |
| `--max-log-size SIZE` | 主日志大小上限，支持 `512KB`、`10MB`、`1M`；`0` 表示不限。 |
| `--zcode on\|off` | 开关 ZCode 模型，默认关闭。 |
| `--codebuddy on\|off` | 开关 CodeBuddy/WorkBuddy 模型，默认关闭。 |
| `--codebuddy-region auto\|cn\|intl` | 选择 CodeBuddy/WorkBuddy 模型目录的刷新地域，默认 `auto`。 |

参数可以组合使用。CLI 配置写入仅支持 macOS：已安装后台服务时自动重启网关，
没有后台服务时仅保存配置，需自行重启前台进程。
如提示配置已保存但重启失败，执行 `local-aiproxy restart`。
修改 `--zcode`、`--codebuddy` 或 `--codebuddy-region` 会改变 `/models` 对外返回的目录，
但网关不会去动 Codex 自己的目录缓存：需要重启 Codex 才能立即看到新列表，
否则等 Codex 自己刷新（约 5 分钟内）。纯日志参数不影响目录。

常用文件位置：

- 配置：`~/.local-aiproxy/config.json`
- 主日志：`~/.local-aiproxy/gateway.log`
- 请求日志：`~/.local-aiproxy/logs/`

请求日志数量限制作用于整个目录，正在写入的文件可能使数量暂时超出上限。
主日志达到大小上限后轮换，保留最近 5 份备份。

### 使用 ZCode 模型

先在本机 ZCode 中登录并选择可用的渠道与套餐，然后开启：

```bash
local-aiproxy config --zcode on
```

可用型号取决于当前 ZCode 配置与网关支持范围；登录失效时请回到 ZCode 处理。

关闭：

```bash
local-aiproxy config --zcode off
```

### 使用 CodeBuddy/WorkBuddy 模型

先在本机 CodeBuddy/WorkBuddy 中登录，然后开启：

```bash
local-aiproxy config --codebuddy on
local-aiproxy config --codebuddy-region cn
```

模型列表的显示名会带 CN/INTL 地域标识和 C/W 产品标识；C 表示 CodeBuddy CLI，
W 表示 WorkBuddy。选择对应条目后，网关会按该条目路由到对应地域登录；
缺少该地域凭据时直接报错，不会回退到另一个地域。

`--codebuddy-region` 只控制模型目录刷新使用哪个地域的登录：`cn` 和 `intl`
固定对应地域，指定地域暂无凭据时回退 `auto`；`auto` 使用最近刷新的登录。
切换该配置并重启网关后，Codex 中的模型列表会随目录刷新更新。

切换地域后，Codex 的模型选择器可能短暂保留已下架的旧地域条目。此时即使请求
落在官方或第三方的 WebSocket 连接上，网关也会在本地断开该连接，让 Codex 重新
协商并降级 HTTPS/SSE，不会把这类已确认不支持的模型帧发给任何上游；ZCode 模型
同样受该逐帧保护。

实际列表取决于当前登录的产品和账号权限。网关不会代为登录或刷新登录凭据；
提示凭据过期或即将过期时，请回到对应客户端重新登录。

关闭：

```bash
local-aiproxy config --codebuddy off
```

这两类接入均需网关监听本机环回地址，并且在 `--upstream-only` 模式下不生效。
Web 界面检测到本机配置后会显示对应开关；已经开启的开关会保留显示，方便关闭。

## 服务管理与卸载

以下服务管理命令适用于 macOS：

| 命令 | 用途 |
| --- | --- |
| `local-aiproxy start` | 按需创建 `config.json`、注册服务并启动网关。 |
| `local-aiproxy stop` | 停止网关及后台 Web 界面。 |
| `local-aiproxy restart` | 先执行与 `start` 相同的初始化，再重启网关。 |
| `local-aiproxy status` | 查看网关状态、当前模式及安装信息。 |
| `local-aiproxy uninstall` | 卸载服务，保留 `config.json`。 |

`uninstall` 会停止 launchd 服务、删除目录文件与 `state.json`，但保留
`~/.local-aiproxy/config.json` 方便再次 `start`。
它**完全不碰 `~/.codex`**：不会改动 `config.toml`，也不会动 Codex 的模型缓存。
如果卸载后想彻底恢复默认，请自行确认 Codex 的 `openai_base_url`；如需移除 npm 包，再执行：

```bash
npm uninstall -g local-aiproxy
```

## 手动运行

网关可在 Bun 支持的平台前台运行，需要先准备好配置文件：

```bash
local-aiproxy serve --config /path/to/config.json
```

不传 `--config` 时使用 `~/.local-aiproxy/config.json`。
手动部署还需自行配置 Codex 的连接地址与模型目录；配置字段见
[配置格式](schemas/gateway-config.schema.json)。`serve` 不注册服务、不启动 Web 界面，
也不执行 `start` 的初始化。
非 macOS 平台只能用这种前台方式运行（`start`/`stop`/`restart`/`uninstall` 依赖 launchd，
且 `config --...` 写入命令不可用），需自行编辑配置文件与管理进程。

macOS 的上游 Key 保存在登录钥匙串中。其他平台需手动准备
`~/.local-aiproxy/credentials.json`，内容如下，并将权限设为仅本人可读写
（Linux 为 `0600`）：

```json
{
  "version": 1,
  "upstream_api_key": "your-key"
}
```

该文件包含明文密钥，请妥善保管；仅本机上游允许使用空 Key。

其他平台需要 Web 界面时，使用默认位置的配置文件，在另一个终端执行
（以下为 POSIX shell 写法）：

```bash
CODEX_CLIPROXY_UI_SERVICE=1 local-aiproxy web
```

此方式只运行界面服务，需自行启动网关并在浏览器打开界面地址。

## 常见问题

- **Codex 看不到模型**：先确认 Codex 的 `openai_base_url` 已指向本网关（见
  [启动与首次使用](#启动与首次使用)）并重启过 Codex，再运行 `local-aiproxy status`
  检查网关，然后用 `models --sync` 重新选择模型。
  使用仅上游模式时，同步命令需加 `--upstream-only`。
- **CLIProxy 模型缺少 `max` / `ultra` 思考等级**：
  检查 `status` 的 `codexClientVersion` 是否正确，更新本机 Codex CLI 后重新同步。
  必要时用 `CODEX_CLIPROXY_CLIENT_VERSION` 指定实际使用的客户端版本。
- **ZCode 或 CodeBuddy/WorkBuddy 模型不可用**：
  确认对应客户端已登录、开关已开启，且网关未处于仅上游模式。
- **无法打开 Web 界面**：重新运行 `local-aiproxy web`；
  若提示后台界面占用端口，先运行 `web --stop`。
- **想改上游地址/端口/前缀**：直接编辑
  `~/.local-aiproxy/config.json`，然后 `local-aiproxy restart`。
  这些字段没有 CLI 参数，Web 界面也不提供。
- **手动改了配置但未生效**：修改网关配置后重启网关，
  修改 Codex 配置后重启 Codex。日常调整优先使用命令或 Web 界面。
