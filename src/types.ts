export interface ModelEntry {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  availability_nux?: unknown;
  upgrade?: unknown;
  [key: string]: unknown;
}

export interface ModelCatalog {
  models: ModelEntry[];
}

/** CodeBuddy 凭据地域：auto 按最近登录选择，cn/intl 固定地域并在无凭据时回退 auto。 */
export type CodebuddyRegion = "auto" | "cn" | "intl";

/**
 * 网关配置。只管几件事：把 Codex 的 Responses 请求转给本机 ZCode、CodeBuddy/WorkBuddy
 * 登录态或 Cline 官方 API Key。没有第三方上游，也没有官方 ChatGPT 回落。
 */
export interface GatewayConfig {
  $schema?: string;
  configVersion?: string;
  host: string;
  port: number;
  mountPath: string;
  /**
   * 运行时目录锚点：两个 adapter 用 `path.dirname(catalogPath)` 定位自己的目录缓存
   * （`zcode-catalog.json`、`{codebuddy|workbuddy}-{cn|intl}-catalog.json`）与
   * `models.json` 覆盖文件、请求日志目录。网关**不读写这个路径本身**；
   * 改它等于把运行时目录搬到别处。
   */
  catalogPath: string;
  requestLogging?: boolean;
  logDir?: string;
  /** 每类日志保留的最大文件数；0 表示不限制。 */
  maxRequestLogs?: number;
  /**
   * 网关进程日志 gateway.log 的最大字节数，超出时把当前内容复制为时间戳备份并原地清空
   * （copy-truncate，进程持有的句柄不受影响）；设置上限同时约束该文件中请求摘要与配置
   * 审计的可追溯深度；0 表示不限制。
   */
  maxGatewayLogBytes?: number;
  /** 是否启用 ZCode Responses 入口；默认关闭。 */
  zcode?: boolean;
  /** 是否启用 CodeBuddy/WorkBuddy Responses 入口；默认关闭。 */
  codebuddy?: boolean;
  /** CodeBuddy/WorkBuddy 凭据地域选择；缺省 auto。 */
  codebuddyRegion?: CodebuddyRegion;
  /** 是否启用 Cline 官方 API（cline/ 前缀）入口；默认关闭。凭据为运行时目录的 cline-api-key 文件。 */
  cline?: boolean;
  /** 是否启用 QoderCN（qodercn/ 前缀）入口；默认关闭。凭据为本机 QoderCN/通义灵码客户端的登录缓存（只读）。 */
  qodercn?: boolean;
  /**
   * 对外模型白名单（slug，匹配不区分大小写；`*` 表示全部放行）。
   * 只影响 /v1/models 的展示与转发准入：不在名单内的模型不展示、转发报 model_not_found。
   * 缺省或空数组 = 全部模型开关默认关闭（一个都不放行）。
   */
  enabledModels?: string[];
}

/**
 * 网关进程日志（gateway.log）的目标与大小上限。
 * 请求摘要、错误摘要、配置审计与 launchd 抓到的 stdout/stderr 都落在同一个文件里，
 * 由 maxGatewayLogBytes 统一约束。
 */
export interface ProcessLogTarget {
  file: string;
  maxBytes: number;
}

export interface ResolvedPaths {
  home: string;
  codexHome: string;
  runtimeHome: string;
  /**
   * Codex 的 `$CODEX_HOME/config.toml`。网关**只读**：`status` 与 Realtime provider 探测
   * 会读它，绝不写入（Codex 侧接线由用户自行配置）。
   */
  configToml: string;
  gatewayConfig: string;
  stateFile: string;
  /**
   * `config.catalogPath` 的默认值。它只是一个运行时目录锚点，网关**不读写该文件本身**；
   * 真正被读写的是同目录下的 zcode/codebuddy 目录缓存与 models.json。
   */
  catalogFile: string;
  /** ZCode 的 models.json 覆盖文件（`models.json`），也是 adapter 读取覆盖规则的入口。 */
  modelMergeFile: string;
  /** 网关进程日志：stdout、stderr、配置审计与请求摘要共用这一个文件。 */
  stdoutLog: string;
  logDir: string;
  /** Web UI 访问令牌文件（0600）；Web UI 是网关内建能力，随网关启动即存在。 */
  uiTokenFile: string;
  launchAgent: string;
  /** Web UI 的 LaunchAgent（默认不加载运行，`local-aiproxy web` 按需启动）。 */
  webUiLaunchAgent: string;
}

export type CliOptions = Record<string, string | true>;
