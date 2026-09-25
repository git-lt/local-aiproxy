import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedPaths } from "./types.ts";

/** 改名前的运行时目录名：`local-aiproxy` 之前的安装落在它下面。 */
export const LEGACY_RUNTIME_HOME_DIR = ".codex-cliproxy-gateway";

/**
 * 解析到真实路径（穿透符号链接）；目标不存在时解析父目录再拼 basename，
 * 父目录也不可解析则退回 path.resolve。用于生产实例判定，避免软链绕过。
 */
export function realPathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const dir = path.dirname(p);
    const base = path.basename(p);
    try {
      return path.join(fs.realpathSync(dir), base);
    } catch {
      return path.resolve(p);
    }
  }
}

/**
 * 历史独立 stderr 日志的文件名。stderr 已并入 gateway.log（同一路径同时作为
 * StandardOutPath 与 StandardErrorPath），这个名字只用于卸载时清理旧安装的残留。
 */
export const LEGACY_STDERR_LOG = "gateway.error.log";

/**
 * 解析网关的全部路径。`runtimeHomeOverride` 用于 `serve --config <file>` 的临时实例：
 * 以配置文件所在目录为运行时根，Web UI 的读写（config/state/ui-token/日志）就全部落在
 * 该目录内。LaunchAgent 在覆盖模式下使用 `-temp` 占位名——配置放在 $HOME 下时
 * `home` 几何派生会恰好命中默认服务的真实路径，占位名保证结构上永不相同；临时实例
 * 的服务管理另由 WebUiContext.instanceOnly 显式禁止，不依赖路径不存在这一隐式前提。
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, runtimeHomeOverride?: string): ResolvedPaths {
  const home = env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const runtimeHome = runtimeHomeOverride ?? path.join(home, ".local-aiproxy");
  return {
    home,
    codexHome,
    runtimeHome,
    configToml: path.join(codexHome, "config.toml"),
    gatewayConfig: path.join(runtimeHome, "config.json"),
    stateFile: path.join(runtimeHome, "state.json"),
    // config.catalogPath 的默认值：只是运行时目录锚点，网关不读写这个文件本身。
    catalogFile: path.join(runtimeHome, "catalog.json"),
    modelMergeFile: path.join(runtimeHome, "models.json"),
    /** 进程日志：stdout、stderr、配置审计与请求摘要都写这一个文件。 */
    stdoutLog: path.join(runtimeHome, "gateway.log"),
    logDir: path.join(runtimeHome, "logs"),
    /** Web UI 访问令牌：网关启动时惰性生成，CLI web 命令读取它拼出带 token 的 URL。 */
    uiTokenFile: path.join(runtimeHome, "ui-token"),
    launchAgent: runtimeHomeOverride
      ? path.join(runtimeHomeOverride, "Library", "LaunchAgents", "local-aiproxy-temp.plist")
      : path.join(home, "Library", "LaunchAgents", "local-aiproxy.plist"),
    webUiLaunchAgent: runtimeHomeOverride
      ? path.join(runtimeHomeOverride, "Library", "LaunchAgents", "local-aiproxy-webui-temp.plist")
      : path.join(home, "Library", "LaunchAgents", "local-aiproxy-webui.plist"),
  };
}

export interface RuntimeHomeMigration {
  from: string;
  to: string;
  /** 旧目录改名后的备份位置；迁移绝不删除用户数据。 */
  backup: string;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 一次性搬迁旧运行时目录：把 `~/.codex-cliproxy-gateway` 的内容复制到新的
 * `~/.local-aiproxy`，再把旧目录改名为 `.bak`（已存在则加时间戳后缀）。
 *
 * 只在「旧目录存在 且 新目录不存在」时执行：已迁移过的安装不会因为某次
 * 清理旧目录就重建，新目录已存在时绝不覆盖。
 */
export function migrateRuntimeHome(
  paths: ResolvedPaths,
  now: () => number = Date.now,
): RuntimeHomeMigration | undefined {
  const legacy = path.join(paths.home, LEGACY_RUNTIME_HOME_DIR);
  if (legacy === paths.runtimeHome) return undefined;
  if (!isDirectory(legacy) || fs.existsSync(paths.runtimeHome)) return undefined;
  fs.cpSync(legacy, paths.runtimeHome, { recursive: true });
  let backup = `${legacy}.bak`;
  if (fs.existsSync(backup)) backup = `${legacy}.bak-${now()}`;
  fs.renameSync(legacy, backup);
  return { from: legacy, to: paths.runtimeHome, backup };
}

/**
 * 网关自管的目录文件，卸载时清理。两个本地 adapter 各按自己的命名规则落盘：
 * ZCode 用一个共用的 `zcode-catalog.json`，CodeBuddy/WorkBuddy 按「产品 × 地域」各一个
 * （`codebuddyCatalogFileName()` 决定）。`codebuddy-catalog.json` 是加地域前缀之前的旧命名，
 * 保留在列表里以便清掉老安装的残留。
 */
export function managedCatalogFiles(paths: ResolvedPaths): string[] {
  const profiles = ["codebuddy-cn", "codebuddy-intl", "workbuddy-cn", "workbuddy-intl"];
  return [
    path.join(paths.runtimeHome, "zcode-catalog.json"),
    path.join(paths.runtimeHome, "codebuddy-catalog.json"),
    ...profiles.map((name) => path.join(paths.runtimeHome, `${name}-catalog.json`)),
  ];
}
