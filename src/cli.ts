import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import bytes from "bytes";
import {
  GATEWAY_CONFIG_SCHEMA_URL,
  GATEWAY_CONFIG_VERSION,
  gatewayConfigWarnings,
  isJsonObject,
  mergeMissingConfig,
  LEGACY_FIELD_MIGRATIONS,
  migrateLegacyConfig,
} from "./config.ts";
import { realPathOrResolve, resolvePaths, managedCatalogFiles, migrateRuntimeHome, LEGACY_STDERR_LOG } from "./paths.ts";
import { restoreRootTomlKeys, atomicWrite, readRootTomlString } from "./toml.ts";
import { startGateway } from "./gateway.ts";
import { ensureUiToken, isLoopbackHost, startWebUiServer, webUiContextForInstance, webUiPort } from "./webui.ts";
import { clearPendingRestart, parseMaxLogSize, parseMaxRequestLogs, sanitizeUrlValue } from "./config-update.ts";
export { parseMaxLogSize, parseMaxRequestLogs } from "./config-update.ts";
import { createZcodeAdapter, validateZcodeConfig, zcodeEnabled } from "./zcode/index.ts";
import type { ZcodeDependencies } from "./zcode/index.ts";
import { codebuddyEnabled, createCodebuddyAdapter, validateCodebuddyConfig } from "./codebuddy/index.ts";
import type { CodebuddyDependencies } from "./codebuddy/index.ts";
import { clineEnabled, createClineAdapter, validateClineConfig } from "./cline/index.ts";
import { createQodercnAdapter, qodercnEnabled, validateQodercnConfig } from "./qodercn/index.ts";
import { capGatewayLog, logConfigChange } from "./process-log.ts";
import type { ConfigChange } from "./process-log.ts";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  startLaunchAgent,
  startWebUiLaunchAgent,
  stopLaunchAgent,
  restartLaunchAgent,
  launchAgentStatus,
  bootoutLegacyLaunchAgents,
} from "./launchd.ts";
import type {
  CliOptions,
  GatewayConfig,
  ModelCatalog,
  ResolvedPaths,
} from "./types.ts";

/** CLI 名称：usage、错误提示与内部文档统一引用它，改名只改这一处。 */
const COMMAND_NAME = "local-aiproxy";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8320,
  mountPath: "/v1",
  requestLogging: false,
  maxRequestLogs: 0,
  maxGatewayLogBytes: 0,
  zcode: false,
  codebuddy: false,
  cline: false,
  qodercn: false,
} satisfies Omit<GatewayConfig, "catalogPath">;

interface InstallState {
  version: number;
  installedAt: string;
  config: GatewayConfig;
  /** 配置已写入但网关重启未成功；下一次写配置会再次重启。 */
  pendingRestart?: boolean;
}

function usage() {
  console.log(`local-aiproxy - Bun gateway for Codex Desktop and CLI

Usage:
  ${COMMAND_NAME} start         create config.json if missing, register the
                               launchd service if needed, and start the gateway
  ${COMMAND_NAME} stop
  ${COMMAND_NAME} restart       same bootstrap as start, then restart
  ${COMMAND_NAME} status
  ${COMMAND_NAME} serve [--config PATH]
  ${COMMAND_NAME} models [--zcode] [--codebuddy] [--cline] [--qodercn] [--json] [--refresh]
  ${COMMAND_NAME} config [--zcode on|off] [--codebuddy on|off] [--cline on|off] [--qodercn on|off] [--codebuddy-region auto|cn|intl] [--log on|off] [--max-request-logs N] [--max-log-size SIZE]
  ${COMMAND_NAME} web
  ${COMMAND_NAME} uninstall

Setup:
  start creates ~/.local-aiproxy/config.json with default settings on
  first run; edit that file to set the port (default ${DEFAULTS.port}) and
  enable the local integrations (zcode / codebuddy).
  This tool never reads or writes ~/.codex/config.toml: point Codex at the
  gateway yourself (openai_base_url = http://127.0.0.1:${DEFAULTS.port}${DEFAULTS.mountPath}).

Models:
  models                list models from the local ZCode and CodeBuddy logins
  models --zcode        only the ZCode group
  models --codebuddy    only the CodeBuddy/WorkBuddy group
  models --json         machine-readable output
  models --refresh      also refresh the CodeBuddy catalog

  The model list follows the local client logins; the gateway never edits
  ~/.codex/config.toml.

Config:
  config                print the current gateway settings
  config --zcode on|off toggle ZCode Responses-to-Anthropic compatibility
  config --codebuddy on|off
                        toggle CodeBuddy/WorkBuddy Responses compatibility
  config --codebuddy-region auto|cn|intl
                        prefer CodeBuddy credentials from a region; auto uses
                        the most recently refreshed login
  config --log on|off   toggle request logging
  config --max-request-logs N
                        max request log files kept across the directory; 0 (default) means unlimited
  config --max-log-size SIZE
                        size cap for the gateway.log process log (stdout, stderr,
                        config audit, and per-request summaries; e.g. 512KB,
                        10MB, or 1M); overflow copies to gateway-<timestamp>.log
                        (5 newest backups kept) and truncates the live file in
                        place; 0 (default) means unlimited
  options may be combined; every change restarts the gateway automatically

Routing:
  Codex Responses requests are translated and forwarded to the local
  ZCode or CodeBuddy/WorkBuddy login; there is no third-party upstream
  and no official ChatGPT fallback.

Web UI:
  web [--start]       run the web ui in the foreground (default): check the
                      gateway (start it if needed), serve the ui on its own
                      port (gateway port + 1), and open the browser;
                      Ctrl-C stops the ui
  web --daemon        start the web ui in the background via launchd, then
                      open the browser and return to the shell
  web [--status | --stop | --restart]
                      inspect, stop, or restart the background ui service
                      only (the gateway is never touched)
  access is loopback-only and token-gated; stopping/uninstalling the gateway also
  stops the web ui
`);
}

function parseArgs(args: string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = [];
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["help", "json", "refresh", "start", "daemon", "status", "stop", "restart"].includes(key)) {
      options[key] = true;
      continue;
    }
    // --zcode / --codebuddy 双形态：models 用作无值开关，config 要求 on|off 取值；
    // 后面跟着非 -- 参数时按值消费，否则按布尔开关。
    if (key === "zcode" || key === "codebuddy" || key === "cline" || key === "qodercn") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
        continue;
      }
      options[key] = next;
      i += 1;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = next;
    i += 1;
  }
  return { positional, options };
}

function requireMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("Service management currently supports macOS only; use `serve` on other platforms");
  }
}

function requireBun() {
  if (typeof Bun === "undefined") {
    throw new Error("Run this command with Bun");
  }
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function formatErrorLog(
  error: unknown,
  at = new Date(),
  options: { label?: string; stack?: boolean } = {},
): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const label = options.label ? `${options.label}: ` : "";
  let stack = "";
  if (options.stack && error instanceof Error && error.stack) {
    // stack 首行通常是 "Name: message"，与消息行重复，只保留调用位置。
    const frames = error.stack.split(/\r?\n/);
    if (frames[0]?.trim() === `${name}: ${message}`) frames.shift();
    stack = `\n${frames.join("\n")}`;
  }
  const lines = `${label}${name}: ${message}${stack}`
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .join("\n");
  return `--${at.toISOString()}--\n${lines}`;
}

function warnGatewayConfig(file: string, value: unknown): void {
  for (const warning of gatewayConfigWarnings(value)) {
    console.warn(`Warning: ${file}: ${warning}`);
  }
}

function loadGatewayConfig(file: string): GatewayConfig {
  const value = loadJson<unknown>(file);
  if (!isJsonObject(value)) throw new Error(`Gateway config must be a JSON object: ${file}`);
  // 历史字段更名（见 LEGACY_FIELD_MIGRATIONS）在此补齐为新键；文件级迁移见 syncGatewayConfigFile。
  migrateLegacyConfig(value);
  return value as unknown as GatewayConfig;
}

function writeGatewayConfig(file: string, value: GatewayConfig): void {
  warnGatewayConfig(file, value);
  writeJson(file, value);
}

export function removeManagedRuntimeFiles(
  paths: ResolvedPaths,
  options: { preserveGatewayConfig?: boolean } = {},
): void {
  for (const file of [
    ...(options.preserveGatewayConfig ? [] : [paths.gatewayConfig]),
    paths.stateFile,
    ...managedCatalogFiles(paths),
    path.join(paths.runtimeHome, "catalog-metadata.json"),
    paths.modelMergeFile,
    paths.stdoutLog,
    path.join(paths.runtimeHome, "webui.log"),
    // 旧安装的独立 stderr 日志：现已合并进 gateway.log，卸载时一并清掉残留。
    path.join(paths.runtimeHome, LEGACY_STDERR_LOG),
  ]) {
    fs.rmSync(file, { force: true });
  }
}

async function waitForHealth(url: string, attempts = 100): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(300);
  }
  throw new Error(
    `Gateway health check failed: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
  );
}

function gatewayDefaults(paths: ResolvedPaths): GatewayConfig {
  return {
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    ...DEFAULTS,
    catalogPath: paths.catalogFile,
    logDir: paths.logDir,
  };
}

/**
 * 已经从配置模型里移除的键：老 config.json 里可能还留着，命令前置同步时一并删除并写审计。
 * 只删键、不解释值——它们的语义已不存在（第三方上游与官方回落已移除）。
 */
const REMOVED_CONFIG_FIELDS = [
  "prefix",
  "officialBaseUrl",
  "upstreamBaseUrl",
  "cliproxyBaseUrl",
  "upstreamType",
  "upstream_type",
  "upstreamOnly",
  "cpaOnly",
  "model_merge_json",
  "selectedModels",
  "websocket",
] as const;

/** 审计只跟踪这些字段；其余键（如 $schema、configVersion）不属于用户可见配置。 */
const AUDITED_FIELDS = [
  "zcode",
  "codebuddy",
  "codebuddyRegion",
  "cline",
  "qodercn",
  "requestLogging",
  "logDir",
  "maxRequestLogs",
  "maxGatewayLogBytes",
  "port",
  "catalogPath",
] as const;

function diffConfig(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ConfigChange[] {
  return AUDITED_FIELDS.flatMap((field) =>
    JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null)
      ? []
      : [{ field, before: before[field] ?? null, after: after[field] ?? null }]);
}

/** 审计写入网关进程日志 gateway.log，单文件追加，不依赖 requestLogging 与 maxRequestLogs。 */
function recordConfigAudit(
  command: string,
  config: GatewayConfig,
  before: Record<string, unknown>,
  paths: ResolvedPaths,
  extraChanges: ConfigChange[] = [],
): void {
  const changes = [...diffConfig(before, config as unknown as Record<string, unknown>), ...extraChanges]
    .map((change) => ({
      field: change.field,
      before: sanitizeUrlValue(change.before),
      after: sanitizeUrlValue(change.after),
    }));
  logConfigChange(paths.stdoutLog, { command, changes }, config.maxGatewayLogBytes ?? 0);
}

/** 重启网关并在 state.json 留 pendingRestart 标记：失败后重跑同一命令会自动重试。 */
async function restartGatewayOnce(
  paths: ResolvedPaths,
  config: GatewayConfig,
  deps: GatewayInstallDeps = {},
): Promise<void> {
  const markPending = (pending: boolean): void => {
    if (!fs.existsSync(paths.stateFile)) return;
    const state = loadJson<InstallState>(paths.stateFile);
    state.pendingRestart = pending;
    writeJson(paths.stateFile, state);
  };
  markPending(true);
  try {
    (deps.restartLaunchAgent ?? restartLaunchAgent)(paths.launchAgent);
    await (deps.waitForHealth ?? waitForHealth)(`http://${config.host}:${config.port}/healthz`);
  } catch (error) {
    // 标记保留：重跑同一命令或 ${COMMAND_NAME} restart 都会补上这次重启。
    throw error;
  }
  markPending(false);
}

/** 上次配置写入后重启未成功时，先补一次重启再继续当前操作。 */
async function retryPendingRestart(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  if (!fs.existsSync(paths.stateFile) || !fs.existsSync(paths.launchAgent)) return;
  const state = loadJson<InstallState>(paths.stateFile);
  if (state.pendingRestart !== true) return;
  await restartGatewayOnce(paths, config);
  console.log("Gateway restarted to apply previously saved configuration.");
}

function mergedGatewayConfig(
  paths: ResolvedPaths,
  current: Record<string, unknown>,
  overrides: Partial<GatewayConfig> = {},
): { config: GatewayConfig; added: string[] } {
  const merged = mergeMissingConfig(
    current,
    gatewayDefaults(paths) as unknown as Record<string, unknown>,
  );
  return {
    config: Object.assign(merged.config, overrides) as unknown as GatewayConfig,
    added: merged.added,
  };
}

/** start/restart 的依赖注入口：测试注入假实现，绝不触碰真实 launchctl。 */
export interface GatewayInstallDeps {
  installLaunchAgent?: typeof installLaunchAgent;
  startLaunchAgent?: typeof startLaunchAgent;
  restartLaunchAgent?: typeof restartLaunchAgent;
  stopLaunchAgent?: typeof stopLaunchAgent;
  waitForHealth?: (url: string) => Promise<void>;
}

/**
 * start/restart 的首轮初始化：config.json 缺失时按默认值创建，LaunchAgent 未注册时注册它，
 * 并始终把当前配置快照写回 state.json。非交互：只写网关自己的文件。
 */
export async function ensureGatewayInstalled(
  paths: ResolvedPaths,
  deps: GatewayInstallDeps = {},
): Promise<GatewayConfig> {
  requireMacOS();
  requireBun();
  let config: GatewayConfig;
  if (fs.existsSync(paths.gatewayConfig)) {
    config = loadGatewayConfig(paths.gatewayConfig);
  } else {
    config = gatewayDefaults(paths);
    fs.mkdirSync(path.dirname(paths.gatewayConfig), { recursive: true });
    writeGatewayConfig(paths.gatewayConfig, config);
    console.log(`Created ${paths.gatewayConfig} with default settings; set zcode/codebuddy to enable the local integrations.`);
  }

  // 既有 state.json 必须合并写回，保留首次安装时间与未知字段。
  const previous = fs.existsSync(paths.stateFile) ? loadJson<InstallState>(paths.stateFile) : undefined;
  // 改名前的服务如果还注册着会继续跑旧二进制：注册新 agent 前先回收。
  bootoutLegacyLaunchAgents(paths.home);
  if (!fs.existsSync(paths.launchAgent)) {
    (deps.installLaunchAgent ?? installLaunchAgent)({
      bunPath: process.execPath,
      cliPath: fs.realpathSync(process.argv[1] ?? process.execPath),
      configPath: paths.gatewayConfig,
      codexHome: paths.codexHome,
      logPath: paths.stdoutLog,
      plistPath: paths.launchAgent,
    });
  }
  writeJson(paths.stateFile, {
    ...previous,
    version: 4,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
    config,
  });
  return config;
}

/** uninstall 的依赖注入口：测试注入假实现，避免触碰真实 launchctl。 */
export interface GatewayUninstallDeps {
  uninstallLaunchAgent?: typeof uninstallLaunchAgent;
}

export async function uninstall(deps: GatewayUninstallDeps = {}): Promise<void> {
  requireMacOS();
  const paths = resolvePaths();
  // 旧名称的服务同样属于本网关：卸载时一并回收，避免留下无人管理的常驻进程。
  bootoutLegacyLaunchAgents(paths.home);
  if (!fs.existsSync(paths.stateFile)) throw new Error("No managed installation found");

  const removeAgent = deps.uninstallLaunchAgent ?? uninstallLaunchAgent;
  removeAgent(paths.launchAgent);
  // Web UI 是独立 LaunchAgent：卸载时一并回收其任务与 plist（未安装时静默忽略）。
  removeAgent(paths.webUiLaunchAgent);
  removeManagedRuntimeFiles(paths, { preserveGatewayConfig: true });

  console.log("Uninstalled. config.json was preserved; ~/.codex was not touched at all.");
}

/**
 * models 命令：列出本机 ZCode 与 CodeBuddy/WorkBuddy 的可用模型。
 *
 * 默认只读网关已落盘的目录缓存，不联网、也不需要网关正在运行；`--refresh` 额外触发一次
 * CodeBuddy 目录刷新（ZCode 的目录本来就按需读本机配置）。
 * 两个入口在 config.json 里关着也照列——先看清单再决定开哪个才是常见顺序。
 */
async function models(options: CliOptions): Promise<void> {
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not configured; run `${COMMAND_NAME} start` first");
  const config = loadGatewayConfig(paths.gatewayConfig);
  const onlyZcode = options.zcode === true;
  const onlyCodebuddy = options.codebuddy === true;
  const onlyCline = options.cline === true;
  const onlyQodercn = options.qodercn === true;
  if (Number(onlyZcode) + Number(onlyCodebuddy) + Number(onlyCline) + Number(onlyQodercn) > 1) {
    throw new Error("--zcode, --codebuddy, --cline and --qodercn cannot be combined; pick one");
  }
  const refresh = options.refresh === true;

  // 临时把各入口置为启用：本命令只看目录，不要求对应开关已打开，也不写回配置。
  const only = onlyZcode || onlyCodebuddy || onlyCline || onlyQodercn;
  const probe: GatewayConfig = { ...config, zcode: true, codebuddy: true, cline: true, qodercn: true };
  const handleZcode = only && !onlyZcode ? undefined : createZcodeAdapter(probe, {});
  const handleCodebuddy = only && !onlyCodebuddy
    ? undefined
    : createCodebuddyAdapter(probe, { refreshCatalogOnStart: refresh });
  const handleCline = only && !onlyCline ? undefined : createClineAdapter(probe, {});
  const handleQodercn = only && !onlyQodercn ? undefined : createQodercnAdapter(probe, {});
  const groups: Array<{ name: string; models: string[] }> = [];
  try {
    if (handleZcode) {
      groups.push({ name: "zcode", models: (await handleZcode.catalog()).models.map((model) => model.slug) });
    }
    if (handleCodebuddy) {
      groups.push({ name: "codebuddy", models: (await handleCodebuddy.catalog()).models.map((model) => model.slug) });
    }
    if (handleCline) {
      groups.push({ name: "cline", models: (await handleCline.catalog()).models.map((model) => model.slug) });
    }
    if (handleQodercn) {
      groups.push({ name: "qodercn", models: (await handleQodercn.catalog()).models.map((model) => model.slug) });
    }
  } finally {
    // 各 adapter 都会起 watcher/定时器，必须回收，否则命令不退出。
    handleZcode?.close();
    handleCodebuddy?.close();
    handleCline?.close();
    handleQodercn?.close();
  }

  if (options.json === true) {
    console.log(JSON.stringify(Object.fromEntries(groups.map((group) => [group.name, group.models])), null, 2));
    return;
  }
  for (const group of groups) {
    console.log(`${group.name} (${group.models.length}):`);
    if (group.models.length === 0) {
      console.log("  (none — 确认对应客户端已在本机登录，或运行 `${COMMAND_NAME} restart` 让网关刷新目录)");
      continue;
    }
    for (const slug of group.models) console.log(`  ${slug}`);
  }
}

async function status(): Promise<void> {
  const paths = resolvePaths();
  const installed = fs.existsSync(paths.stateFile);
  const config = fs.existsSync(paths.gatewayConfig) ? loadGatewayConfig(paths.gatewayConfig) : undefined;
  const service = process.platform === "darwin" ? launchAgentStatus() : null;
  // 只读回显 Codex 侧的接线：用来回答「Codex 到底指没指到网关」。网关从不写这个文件。
  const source = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  let health = "unreachable";
  if (installed) {
    const state = loadJson<InstallState>(paths.stateFile);
    const healthConfig = config ?? state.config;
    try {
      const response = await fetch(`http://${healthConfig.host}:${healthConfig.port}/healthz`);
      if (response.ok) health = "ok";
    } catch {}
  }
  console.log(JSON.stringify({
    installed,
    serviceLoaded: Boolean(service),
    health,
    openaiBaseUrl: readRootTomlString(source, "openai_base_url"),
    modelCatalogJson: readRootTomlString(source, "model_catalog_json"),
    zcode: config?.zcode === true,
    codebuddy: config?.codebuddy === true,
    codebuddyRegion: config?.codebuddyRegion ?? "auto",
    requestLogging: config?.requestLogging === true,
    logDir: config?.logDir ?? paths.logDir,
  }, null, 2));
}

function serve(options: CliOptions): void {
  requireBun();
  const paths = resolvePaths();
  // 真实路径比较：软链到默认 config.json 时仍按生产实例写日志、清 pendingRestart。
  const configPath = realPathOrResolve(stringOption(options, "config") || paths.gatewayConfig);
  if (!fs.existsSync(configPath)) throw new Error(`Gateway config not found: ${configPath}`);
  const config = loadGatewayConfig(configPath);
  const isProductionInstance = configPath === realPathOrResolve(paths.gatewayConfig);
  // 只有默认配置对应的生产实例才写 gateway.log：--config 的临时实例输出留在终端，
  // 不碰生产进程日志（也不会把临时实例的请求摘要混进去）。
  const processLog = isProductionInstance
    ? { file: paths.stdoutLog, maxBytes: config.maxGatewayLogBytes ?? 0 }
    : undefined;
  startGateway(config, undefined, processLog, undefined);
  // 本进程已带着当前配置启动：此前置位的 pendingRestart 已完成使命，清掉它，
  // 避免下一次命令被误补一次重启；临时实例不动生产 state。
  if (isProductionInstance) clearPendingRestart(paths.stateFile);
  // 启动横幅、stderr、配置审计与请求摘要都追加进同一个 gateway.log，启动时检查一次大小，
  // 超限备份并原地清空（copy-truncate，launchd 持有的 fd 不受影响）；运行期每次写入
  // 请求摘要时还会再按同一上限判断一次。
  if (processLog) capGatewayLog(processLog.file, processLog.maxBytes);
}

/** 探测 UI 端口是否已有 Web UI 在服务（端口不通视为未运行；有响应且 ok 才算我们的 UI）。 */
async function fetchWebUi(port: number): Promise<Response | undefined> {
  try {
    return await fetch(`http://127.0.0.1:${port}/ui`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return undefined;
  }
}

async function isWebUiRunning(port: number): Promise<boolean> {
  const response = await fetchWebUi(port);
  return response !== undefined && response.ok;
}

async function waitForWebUi(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isWebUiRunning(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Web UI did not come up on port ${port} within ${timeoutMs / 1000}s`);
}

/** Web UI 进程日志：LaunchAgent 的 stdout/stderr 都指向它，体量极小。 */
function webUiLogPath(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "webui.log");
}

/**
 * 前台运行 Web UI 服务：`web` 的后台服务模式与用户面前台启动共用。
 * launchd 停止（bootout）与手动 Ctrl-C 都以 SIGTERM/SIGINT
 * 到达：关停监听后干净退出。openBrowser 为真时打印带令牌的地址并用系统浏览器打开
 * （LaunchAgent 场景为假，避免后台进程拉起浏览器）。
 */
function runWebUiForeground(paths: ResolvedPaths, config: GatewayConfig, openBrowser: boolean): void {
  const ctx = webUiContextForInstance(paths.gatewayConfig, paths);
  const server = startWebUiServer(config, ctx);
  if (!server) throw new Error("Web UI requires a loopback gateway host");
  const shutdown = (): void => {
    server.stop(true);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log(`web ui listening on ${server.url}ui`);
  if (openBrowser) {
    const url = `http://127.0.0.1:${webUiPort(config)}/ui?token=${encodeURIComponent(ensureUiToken(paths.uiTokenFile))}`;
    console.log(url);
    execFileSync("/usr/bin/open", [url], { stdio: "ignore" });
  }
}

/** 检查网关（未运行则启动）并等待 healthz 就绪；web 命令默认路径的第一步。 */
async function ensureGatewayRunning(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  const base = `http://${config.host}:${config.port}`;
  try {
    const response = await fetch(`${base}/healthz`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    startLaunchAgent(paths.launchAgent);
    await waitForHealth(`${base}/healthz`);
    console.log("Gateway started.");
  }
}

/** 经 LaunchAgent 拉起（或重启后拉起）Web UI，并等待端口就绪。 */
async function startWebUiService(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  startWebUiLaunchAgent(paths.webUiLaunchAgent, {
    bunPath: process.execPath,
    cliPath: fs.realpathSync(process.argv[1]),
    codexHome: paths.codexHome,
    logPath: webUiLogPath(paths),
  });
  await waitForWebUi(webUiPort(config));
}

/**
 * web 命令：默认（及 `--start`）前台启动——检查网关（未运行则启动）后在前台运行
 * UI 服务并打开浏览器，Ctrl-C 停止；`--daemon` 后台启动——经 LaunchAgent 拉起后打开
 * 浏览器，终端立即释放。dev:ui（LOCAL_AIPROXY_UI_DEV=1）复用本命令启动 UI API，
 * 但 Vite 还要接着占用终端，因此始终走后台路径。
 * 子选项只作用于 UI 服务本身，不动网关：`--status` 查看运行状态，`--stop` 停止，
 * `--restart` 先停再起。
 */
async function webCommand(options: CliOptions): Promise<void> {
  // 模式互斥校验先于平台/安装检查：参数拼错的反馈与运行环境无关。
  const modes = ["start", "daemon", "status", "stop", "restart"].filter((flag) => options[flag] === true);
  if (modes.length > 1) {
    throw new Error(`--${modes[0]} and --${modes[1]} cannot be combined; pick one`);
  }
  // LaunchAgent 复用 web 入口：只运行服务，避免递归后台启动、触碰网关或打开浏览器。
  if (process.env.LOCAL_AIPROXY_UI_SERVICE === "1") {
    requireBun();
    const paths = resolvePaths();
    if (!fs.existsSync(paths.gatewayConfig)) {
      throw new Error(`Gateway config not found: ${paths.gatewayConfig}`);
    }
    const config = loadGatewayConfig(paths.gatewayConfig);
    if (!isLoopbackHost(config.host)) {
      throw new Error(`Web UI requires a loopback gateway host, got ${config.host}`);
    }
    runWebUiForeground(paths, config, false);
    return;
  }
  requireMacOS();
  const paths = resolvePaths();
  // 只要求配置存在：state.json 由 start/restart 维护，`serve`（含前台手动运行与
  // 非 macOS）不会写它——那种实例同样是可用的安装，不该被这条检查挡住。
  if (!fs.existsSync(paths.gatewayConfig)) {
    throw new Error(`Gateway is not installed; run: ${COMMAND_NAME} start`);
  }
  const config = loadGatewayConfig(paths.gatewayConfig);
  if (!isLoopbackHost(config.host)) {
    throw new Error(`Web UI requires a loopback gateway host, got ${config.host}`);
  }
  const uiPort = webUiPort(config);

  if (options.status === true) {
    if (await isWebUiRunning(uiPort)) {
      console.log(`Web UI is running at http://127.0.0.1:${uiPort}/ui`);
    } else {
      console.log("Web UI is not running");
      console.log("Start and open it with: ${COMMAND_NAME} web --daemon");
    }
    return;
  }
  if (options.stop === true) {
    stopLaunchAgent(paths.webUiLaunchAgent);
    console.log("Web UI stopped.");
    return;
  }
  if (options.restart === true) {
    stopLaunchAgent(paths.webUiLaunchAgent);
    await startWebUiService(paths, config);
    console.log(`Web UI restarted at http://127.0.0.1:${uiPort}/ui`);
    return;
  }

  await ensureGatewayRunning(paths, config);
  const devMode = process.env.LOCAL_AIPROXY_UI_DEV === "1";
  // dev:ui 需要命令返回让 Vite 接管终端，一律走 LaunchAgent 后台路径。
  if (options.daemon === true || devMode) {
    if (!(await isWebUiRunning(uiPort))) {
      await startWebUiService(paths, config);
      console.log("Web UI started.");
    }
    if (devMode) {
      console.log(`Web UI API is ready at http://127.0.0.1:${uiPort}/ui/api`);
      return;
    }
  } else {
    // 前台启动：端口已被后台服务占用时 Bun.serve 会抛晦涩的端口冲突，先给出可执行的修复方式。
    if (await isWebUiRunning(uiPort)) {
      throw new Error(
        `Web UI is already running on port ${uiPort}; stop it first with: ${COMMAND_NAME} web --stop`,
      );
    }
    runWebUiForeground(paths, config, true);
    return;
  }
  const url = `http://127.0.0.1:${uiPort}/ui?token=${encodeURIComponent(ensureUiToken(paths.uiTokenFile))}`;
  console.log(url);
  execFileSync("/usr/bin/open", [url], { stdio: "ignore" });
}

/** on/off 参数统一解析；大小写不敏感，缺值或非法值都在这里报错。 */
function onOffValue(options: CliOptions, key: string): boolean | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${key} requires on or off`);
  const normalized = String(value).toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    throw new Error(`--${key} expects on or off, got "${value}"`);
  }
  return normalized === "on";
}

/**
 * config 命令：无参数只打印当前设置；传入任何配置项时都写盘并重启网关，
 * 让运行中的进程重新加载完整配置，不对比目标值是否已匹配。
 */
async function configCommand(options: CliOptions): Promise<void> {
  const zcodeTarget = onOffValue(options, "zcode");
  const codebuddyTarget = onOffValue(options, "codebuddy");
  const clineTarget = onOffValue(options, "cline");
  const qodercnTarget = onOffValue(options, "qodercn");
  const codebuddyRegionOption = stringOption(options, "codebuddy-region");
  const logTarget = onOffValue(options, "log");
  const maxLogsOption = stringOption(options, "max-request-logs");
  const maxLogSizeOption = stringOption(options, "max-log-size");
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = loadGatewayConfig(paths.gatewayConfig);
  const auditBefore: Record<string, unknown> = { ...config } as unknown as Record<string, unknown>;

  if (zcodeTarget === undefined && codebuddyTarget === undefined && clineTarget === undefined && qodercnTarget === undefined && codebuddyRegionOption === undefined && logTarget === undefined && maxLogsOption === undefined && maxLogSizeOption === undefined) {
    const zcodeActive = zcodeEnabled(config);
    const codebuddyActive = codebuddyEnabled(config);
    console.log(JSON.stringify({
      zcode: zcodeActive,
      codebuddy: codebuddyActive,
      cline: clineEnabled(config),
      qodercn: qodercnEnabled(config),
      codebuddyRegion: config.codebuddyRegion ?? "auto",
      requestLogging: config.requestLogging === true,
      logDir: config.logDir || paths.logDir,
      maxRequestLogs: config.maxRequestLogs ?? 0,
      maxGatewayLogBytes: config.maxGatewayLogBytes ?? 0,
      catalogPath: config.catalogPath,
    }, null, 2));
    return;
  }

  requireMacOS();
  const applied: string[] = [];
  if (zcodeTarget !== undefined) {
    config.zcode = zcodeTarget;
    applied.push(`ZCode compatibility ${zcodeTarget ? "enabled" : "disabled"}.`);
  }
  if (codebuddyTarget !== undefined) {
    config.codebuddy = codebuddyTarget;
    applied.push(`CodeBuddy compatibility ${codebuddyTarget ? "enabled" : "disabled"}.`);
  }
  if (clineTarget !== undefined) {
    config.cline = clineTarget;
    applied.push(`Cline compatibility ${clineTarget ? "enabled" : "disabled"}.`);
  }
  if (qodercnTarget !== undefined) {
    config.qodercn = qodercnTarget;
    applied.push(`QoderCN compatibility ${qodercnTarget ? "enabled" : "disabled"}.`);
  }
  if (codebuddyRegionOption !== undefined) {
    const normalized = codebuddyRegionOption.trim().toLowerCase();
    if (normalized !== "auto" && normalized !== "cn" && normalized !== "intl") {
      throw new Error(`--codebuddy-region expects auto, cn, or intl, got "${codebuddyRegionOption}"`);
    }
    config.codebuddyRegion = normalized;
    applied.push(`CodeBuddy region preference set to ${normalized}.`);
  }
  if (maxLogsOption !== undefined) {
    config.maxRequestLogs = parseMaxRequestLogs(maxLogsOption);
    applied.push(`Max log files per group set to ${
      config.maxRequestLogs === 0 ? "unlimited" : config.maxRequestLogs
    }.`);
  }
  if (maxLogSizeOption !== undefined) {
    config.maxGatewayLogBytes = parseMaxLogSize(maxLogSizeOption);
    applied.push(`Gateway log size cap set to ${
      config.maxGatewayLogBytes === 0 ? "unlimited" : bytes.format(config.maxGatewayLogBytes)
    }.`);
  }
  if (logTarget !== undefined) {
    config.requestLogging = logTarget;
    if (logTarget) config.logDir ||= paths.logDir;
    applied.push(`Request logging ${logTarget ? "enabled" : "disabled"}.`);
  }
  // 与 Web UI 同一规则：组合校验先于写盘与重启，失败时保留原配置和运行中的服务
  // （否则保存成功、新进程却被 validate*Config 拒绝启动，网关直接不可用）。
  validateZcodeConfig(config);
  validateCodebuddyConfig(config);
  validateClineConfig(config);
  validateQodercnConfig(config);
  writeGatewayConfig(paths.gatewayConfig, config);
  if (fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.config = config;
    writeJson(paths.stateFile, state);
  }
  recordConfigAudit("config", config, auditBefore, paths);

  // 先报「改了什么」再执行重启：配置在上方已写盘，重启只是让新值生效；
  // 摘要落在重启输出之后会被误读成「重启后才应用配置」。
  for (const line of applied) console.log(line);
  if (logTarget) console.log(`Request logs will be written to: ${config.logDir}`);

  if (fs.existsSync(paths.launchAgent)) {
    await restartGatewayOnce(paths, config);
    console.log("Gateway restarted to apply the new configuration.");
  } else {
    console.log("Gateway LaunchAgent is not installed; configuration saved without restart.");
  }
}

export async function controlGateway(
  action: "start" | "stop" | "restart",
  deps: GatewayInstallDeps = {},
): Promise<void> {
  requireMacOS();
  const paths = resolvePaths();

  if (action === "stop") {
    if (!fs.existsSync(paths.stateFile)) throw new Error("Gateway is not installed");
    const stop = deps.stopLaunchAgent ?? stopLaunchAgent;
    stop(paths.launchAgent);
    // Web UI 是独立服务：网关停止时一并回收（未安装时 bootout 静默忽略）。
    stop(paths.webUiLaunchAgent);
    console.log("Gateway stopped.");
    return;
  }

  // start 与 restart 都会先确保已初始化：install 命令已移除，这里是唯一的首次初始化入口。
  const config = await ensureGatewayInstalled(paths, deps);
  const base = `http://${config.host}:${config.port}/healthz`;
  const wait = deps.waitForHealth ?? waitForHealth;
  if (action === "start") {
    (deps.startLaunchAgent ?? startLaunchAgent)(paths.launchAgent);
    await wait(base);
    console.log("Gateway started.");
  } else {
    await restartGatewayOnce(paths, config, deps);
    console.log("Gateway restarted.");
  }
}

export function syncGatewayConfigFile(paths: ResolvedPaths, configFile = paths.gatewayConfig): void {
  if (!fs.existsSync(configFile)) return;

  const raw = loadJson<unknown>(configFile);
  if (!isJsonObject(raw)) throw new Error(`Gateway config must be a JSON object: ${configFile}`);
  const before = structuredClone(raw);
  const current = migrateLegacyConfig(raw) as unknown as GatewayConfig;
  const explicitChanges: ConfigChange[] = [];
  let dirty = false;
  // 已移除的配置键（第三方上游、官方回落、Realtime 开关等）：老配置里的残留一并清理并写审计。
  for (const field of REMOVED_CONFIG_FIELDS) {
    if (field in current) {
      explicitChanges.push({
        field: `${field} (removed)`,
        before: (current as unknown as Record<string, unknown>)[field] ?? null,
        after: null,
      });
      delete (current as unknown as Record<string, unknown>)[field];
      dirty = true;
    }
  }
  // 历史字段更名（见 LEGACY_FIELD_MIGRATIONS）：读取时已补齐新键（loadGatewayConfig），
  // 这里移除旧键并记录审计，让配置文件只保留受管的新字段。
  for (const { old: oldKey, next: newKey } of LEGACY_FIELD_MIGRATIONS) {
    if (oldKey in current) {
      const record = current as unknown as Record<string, unknown>;
      explicitChanges.push({
        field: `${oldKey} -> ${newKey}`,
        before: record[oldKey] ?? null,
        after: record[newKey] ?? null,
      });
      delete record[oldKey];
      dirty = true;
    }
  }
  const legacyCatalogPath = current.catalogPath === path.join(paths.codexHome, "cliproxy-catalog.json");
  if (legacyCatalogPath) {
    current.catalogPath = paths.catalogFile;
    dirty = true;
  }

  // 同版本只补本次新增开关，不改变其他可选字段原有的缺省和审计语义。
  if (current.configVersion === GATEWAY_CONFIG_VERSION) {
    if (!Object.hasOwn(current, "zcode")) {
      current.zcode = false;
      dirty = true;
    }
    if (!Object.hasOwn(current, "codebuddy")) {
      current.codebuddy = false;
      dirty = true;
    }
    if (!Object.hasOwn(current, "qodercn")) {
      current.qodercn = false;
      dirty = true;
    }
    if (dirty) {
      writeGatewayConfig(configFile, current);
      if (configFile === paths.gatewayConfig && fs.existsSync(paths.stateFile)) {
        const state = loadJson<InstallState>(paths.stateFile);
        state.config = current;
        writeJson(paths.stateFile, state);
      }
      recordConfigAudit("config sync", current, before, paths, explicitChanges);
    }
    warnGatewayConfig(configFile, current);
    return;
  }

  const merged = mergedGatewayConfig(
    paths,
    current as unknown as Record<string, unknown>,
  );
  merged.config.configVersion = GATEWAY_CONFIG_VERSION;
  if (before.configVersion !== merged.config.configVersion) {
    explicitChanges.push({
      field: "configVersion",
      before: before.configVersion ?? null,
      after: merged.config.configVersion,
    });
  }
  writeGatewayConfig(configFile, merged.config);

  if (configFile === paths.gatewayConfig && fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.version = 4;
    state.config = merged.config;
    writeJson(paths.stateFile, state);
  }
  recordConfigAudit("config sync", merged.config as unknown as GatewayConfig, before, paths, explicitChanges);
  const additions = merged.added.filter((key) => key !== "configVersion");
  console.log(`Config synced to ${GATEWAY_CONFIG_VERSION}.${additions.length > 0
    ? ` Added: ${additions.join(", ")}.`
    : ""}`);
}

function syncGatewayConfig(command: string, options: CliOptions): void {
  const paths = resolvePaths();
  syncGatewayConfigFile(
    paths,
    command === "serve" ? stringOption(options, "config") || paths.gatewayConfig : paths.gatewayConfig,
  );
}

/** 各命令接受的选项；白名单外的 --key 一律报错，避免拼写错误被静默忽略后部分生效。 */
const COMMAND_OPTIONS: Record<string, string[]> = {
  uninstall: [],
  restart: [],
  serve: ["config"],
  models: ["zcode", "codebuddy", "cline", "qodercn", "json", "refresh"],
  config: ["zcode", "codebuddy", "cline", "qodercn", "codebuddy-region", "log", "max-request-logs", "max-log-size"],
  web: ["start", "daemon", "status", "stop", "restart"],
};

export async function runCli(args: string[]): Promise<void> {
  // 改名后的首次运行：把旧运行时目录搬到 ~/.local-aiproxy（旧目录改名为 .bak 保留）。
  // 早于任何读写，保证后续命令看到的是迁移后的目录。
  const migration = migrateRuntimeHome(resolvePaths());
  if (migration) {
    console.log(`Migrated runtime home ${migration.from} -> ${migration.to} (old copy kept at ${migration.backup}).`);
  }
  const { positional, options } = parseArgs(args);
  const command = positional[0];
  if (!command || command === "help" || options.help) {
    usage();
    return;
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);
  // web 专属模式 flag 先于通用白名单报错： misplaced 时给出「只属于 web」的明确提示。
  for (const webFlag of ["start", "daemon", "status", "stop", "restart"]) {
    if (options[webFlag] === true && command !== "web") {
      throw new Error(`--${webFlag} is only supported by the web command`);
    }
  }
  const allowedOptions = COMMAND_OPTIONS[command] ?? [];
  for (const key of Object.keys(options)) {
    if (!allowedOptions.includes(key)) {
      throw new Error(`Unknown option --${key} for command "${command}"`);
    }
  }
  if (options.log !== undefined && command !== "config") {
    throw new Error("--log is only supported by the config command");
  }
  if (["start", "stop", "restart", "serve", "models", "config", "status", "web"].includes(command)) {
    syncGatewayConfig(command, options);
  }

  switch (command) {
    case "uninstall":
      await uninstall();
      break;
    case "start":
    case "stop":
    case "restart":
      await controlGateway(command);
      break;
    case "serve":
      serve(options);
      break;
    case "models":
      await models(options);
      break;
    case "config":
      await configCommand(options);
      break;
    case "web":
      await webCommand(options);
      break;
    case "status":
      await status();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
