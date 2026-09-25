import fs from "node:fs";
import bytes from "bytes";
import { atomicWrite } from "./toml.ts";
import { gatewayConfigWarnings, isJsonObject, migrateLegacyConfig } from "./config.ts";
import { logConfigChange, type ConfigChange } from "./process-log.ts";
import { validateZcodeConfig } from "./zcode/index.ts";
import { validateCodebuddyConfig } from "./codebuddy/index.ts";
import { validateClineConfig } from "./cline/index.ts";
import { validateQodercnConfig } from "./qodercn/index.ts";
import type { GatewayConfig, ResolvedPaths } from "./types.ts";

/**
 * 配置写入的共享路径：CLI `config` 命令与 Web UI `POST /ui/api/config` 共用的
 * 解析、读写与审计逻辑。gateway.ts 的依赖树不得反向引用 cli.ts，因此独立成模块。
 */

/** --max-request-logs 解析：整个日志目录保留的最大请求日志文件数，0 表示不限制。 */
export function parseMaxRequestLogs(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--max-request-logs expects a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

/** --max-log-size 解析：网关日志大小上限，bytes 包负责 512KB/10MB 到字节的换算，0 表示不限制。 */
export function parseMaxLogSize(value: string): number {
  // bytes.parse 不认无 B 后缀的单位，且会把 "1M"/"1MiB" 静默解析成 1 字节而非报错；
  // 先归一化（去空格、补 b 后缀），再用严格语法把关，超出语法的输入直接拒绝。
  // 语法与 bytes README 对齐：b/kb/mb/gb/tb/pb，1024 进制，大小写不敏感。
  const normalized = value.trim()
    .replace(/^([+-]?\d+(?:\.\d+)?)\s*/, "$1")
    .replace(/([kmgtp])$/i, "$1b");
  const parsed = /^[+-]?\d+(?:\.\d+)?(?:b|kb|mb|gb|tb|pb)?$/i.test(normalized)
    ? bytes.parse(normalized)
    : null;
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--max-log-size expects a non-negative byte size such as 512KB, 10MB, or 1M, got "${value}"`);
  }
  return parsed;
}

/** 读取 config.json 并做与 CLI 读取一致的旧字段迁移；文件形状不对时抛错。 */
export function readGatewayConfigFile(file: string): GatewayConfig {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isJsonObject(value)) throw new Error(`Gateway config must be a JSON object: ${file}`);
  migrateLegacyConfig(value);
  return value as unknown as GatewayConfig;
}

/**
 * URL 的 query 可能携带 token：凡对外展示（审计落盘、Web UI 响应）一律只保留
 * origin 与路径，query 折叠为 `?…`；diff 与比较仍按原始值进行。
 */
export function sanitizeUrlValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (!url.search) return value;
    return `${url.origin}${url.pathname}?…`;
  } catch {
    return value;
  }
}

function writeGatewayConfigFile(file: string, value: GatewayConfig): void {
  for (const warning of gatewayConfigWarnings(value)) {
    console.warn(`Warning: ${file}: ${warning}`);
  }
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Web UI 表单可提交的字段；数值/大小字段按字符串提交，与服务端 CLI 解析规则一致。 */
export interface WebUiConfigPatch {
  zcode?: unknown;
  codebuddy?: unknown;
  cline?: unknown;
  qodercn?: unknown;
  enabledModels?: unknown;
  requestLogging?: unknown;
  maxRequestLogs?: unknown;
  maxGatewayLogBytes?: unknown;
}

const SUPPORTED_PATCH_FIELDS = new Set(["zcode", "codebuddy", "cline", "qodercn", "enabledModels", "requestLogging", "maxRequestLogs", "maxGatewayLogBytes"]);

/**
 * 校验并应用 Web UI 的配置子集：写 config.json（含 schema 软告警）、按需同步
 * state.json 里的 config（仅生产实例；临时实例的派生 state 可能与默认安装同文件，
 * 绝不写入）、向 gateway.log 追加 `webui config` 审计。校验失败抛带修复方式的错误，
 * 不做任何写盘；白名单外的字段一律拒绝，避免拼写错误被静默忽略。返回应用后的配置
 * 与实际变化的字段（供响应展示）。
 */
export function applyWebUiConfigPatch(
  paths: ResolvedPaths,
  patch: WebUiConfigPatch,
  syncState = true,
): { config: GatewayConfig; applied: ConfigChange[] } {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new Error("Request body contains no supported fields");
  for (const key of keys) {
    if (!SUPPORTED_PATCH_FIELDS.has(key)) throw new Error(`Unsupported field: ${key}`);
  }
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = readGatewayConfigFile(paths.gatewayConfig);
  const before = config as unknown as Record<string, unknown>;
  const applied: ConfigChange[] = [];
  const change = (field: string, next: unknown): void => {
    applied.push({ field, before: before[field] ?? null, after: next });
  };

  if (patch.zcode !== undefined) {
    if (typeof patch.zcode !== "boolean") throw new Error("zcode expects a boolean");
    if (config.zcode !== patch.zcode) change("zcode", patch.zcode);
    config.zcode = patch.zcode;
  }
  if (patch.codebuddy !== undefined) {
    if (typeof patch.codebuddy !== "boolean") throw new Error("codebuddy expects a boolean");
    if (config.codebuddy !== patch.codebuddy) change("codebuddy", patch.codebuddy);
    config.codebuddy = patch.codebuddy;
  }
  if (patch.cline !== undefined) {
    if (typeof patch.cline !== "boolean") throw new Error("cline expects a boolean");
    if (config.cline !== patch.cline) change("cline", patch.cline);
    config.cline = patch.cline;
  }
  if (patch.qodercn !== undefined) {
    if (typeof patch.qodercn !== "boolean") throw new Error("qodercn expects a boolean");
    if (config.qodercn !== patch.qodercn) change("qodercn", patch.qodercn);
    config.qodercn = patch.qodercn;
  }
  if (patch.enabledModels !== undefined) {
    if (!Array.isArray(patch.enabledModels) || !patch.enabledModels.every((item) => typeof item === "string")) {
      throw new Error("enabledModels expects an array of model ID strings");
    }
    const next = [...new Set((patch.enabledModels as string[]).map((item) => item.trim()).filter(Boolean))];
    if (JSON.stringify(config.enabledModels ?? []) !== JSON.stringify(next)) change("enabledModels", next);
    config.enabledModels = next;
  }
  if (patch.requestLogging !== undefined) {
    if (typeof patch.requestLogging !== "boolean") throw new Error("requestLogging expects a boolean");
    if (config.requestLogging !== patch.requestLogging) change("requestLogging", patch.requestLogging);
    config.requestLogging = patch.requestLogging;
    if (config.requestLogging) config.logDir ||= paths.logDir;
  }
  if (patch.maxRequestLogs !== undefined) {
    const value = typeof patch.maxRequestLogs === "number"
      ? String(patch.maxRequestLogs)
      : patch.maxRequestLogs;
    if (typeof value !== "string") throw new Error("maxRequestLogs expects a non-negative integer");
    const parsed = parseMaxRequestLogs(value.trim());
    if ((config.maxRequestLogs ?? 0) !== parsed) change("maxRequestLogs", parsed);
    config.maxRequestLogs = parsed;
  }
  if (patch.maxGatewayLogBytes !== undefined) {
    const value = patch.maxGatewayLogBytes === 0 ? "0" : patch.maxGatewayLogBytes;
    if (typeof value !== "string") {
      throw new Error("maxGatewayLogBytes expects 0 or a non-negative byte size such as 512KB or 10MB");
    }
    const parsed = parseMaxLogSize(value.trim());
    if ((config.maxGatewayLogBytes ?? 0) !== parsed) change("maxGatewayLogBytes", parsed);
    config.maxGatewayLogBytes = parsed;
  }

  if (applied.length === 0) {
    // 所有字段的值都未变化：不写盘也不落审计，直接返回当前配置。
    return { config, applied };
  }
  // 组合校验先于写盘：保留前缀冲突、非回环监听等组合会被新进程的 validate*Config
  // 拒绝启动——在这里挡下并保留原配置，避免"保存成功但重启后网关与管理页一起死亡"。
  validateZcodeConfig(config);
  validateCodebuddyConfig(config);
  validateClineConfig(config);
  validateQodercnConfig(config);
  writeGatewayConfigFile(paths.gatewayConfig, config);
  if (syncState && fs.existsSync(paths.stateFile)) {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as { config?: unknown };
    state.config = config;
    atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  logConfigChange(paths.stdoutLog, { command: "webui config", changes: applied }, config.maxGatewayLogBytes ?? 0);
  return { config, applied };
}

/** 置位 pendingRestart：重启失败后下一次 CLI 命令会自动补一次重启。 */
export function markPendingRestart(stateFile: string): void {
  if (!fs.existsSync(stateFile)) return;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { pendingRestart?: boolean };
    state.pendingRestart = true;
    atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // state 写失败不阻断配置写入；重启标记只是兜底。
  }
}

/** 网关进程带着当前配置启动成功后清除 pendingRestart，避免下一次命令被误补重启。 */
export function clearPendingRestart(stateFile: string): void {
  if (!fs.existsSync(stateFile)) return;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { pendingRestart?: boolean };
    if (state.pendingRestart !== true) return;
    state.pendingRestart = false;
    atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // 同上，标记清理失败不影响服务。
  }
}
