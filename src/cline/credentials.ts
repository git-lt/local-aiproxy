import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cline 官方 API Key 的只读消费层。
 *
 * Cline 的 OAuth 免费档凭据（~/.cline/data/settings/providers.json）对
 * api.cline.bot 的 chat completions 端点无效（服务端要求官方 API Key，见
 * docs/exec-plans/active/cline-adapter.md 的调研），因此这里消费的是用户在
 * app.cline.bot 控制台签发、保存到网关运行时目录的 API Key 文件（0600，单行）。
 * 网关只读不写：令牌轮换、吊销都由用户在控制台自行管理。
 */

export class ClineCredentialError extends Error {}

export function clineCredentialError(message: string): ClineCredentialError {
  return new ClineCredentialError(`${message}；请在 https://app.cline.bot/dashboard/account?tab=api-keys 创建 API Key，并将它单行写入 ~/.local-aiproxy/cline-api-key（chmod 600）后重试`);
}

/** 默认的 API Key 文件路径：runtimeHome 由 config.catalogPath 的目录部分锚定。 */
export function defaultClineApiKeyFile(catalogPath: string): string {
  return path.join(path.dirname(catalogPath), "cline-api-key");
}

export function clineCredentialsPresent(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 读取 API Key：文件缺失、为空、含多行内容都报带指引的错误，不静默当作缺失。
 * 每次调用都重新读取（几 KB 的小文件，正确性不依赖缓存或 watch 事件）。
 */
export function readClineApiKey(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw clineCredentialError("Cline API Key 文件不存在");
  }
  const key = raw.trim();
  if (!key) throw clineCredentialError("Cline API Key 文件为空");
  if (/\r|\n/.test(key)) throw clineCredentialError("Cline API Key 文件必须是单行");
  return key;
}

/**
 * Cline CLI 的 OAuth 登录态（cline-free 免费档）只读消费 + 过期刷新。
 *
 * 凭据来自 `~/.cline/data/settings/providers.json`（CLI 登录后写入）。
 * accessToken 是短时效 WorkOS JWT；过期时用 refreshToken 调官方
 * `/api/v1/auth/refresh` 换新，并把新令牌对**写回** providers.json——
 * 该接口的 refreshToken 是轮换式的，不写回会让 CLI 里存的旧令牌失效
 * （相当于替用户把 CLI 登录态弄丢）。写窗口极小，原子写。
 */

export const CLINE_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";

export function defaultClineProvidersFile(): string {
  return path.join(os.homedir(), ".cline", "data", "settings", "providers.json");
}

export interface ClineOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** 读取 OAuth 登录态：未登录 / auth 字段被 CLI 清除时返回 undefined。 */
export function readClineOAuth(file: string = defaultClineProvidersFile()): ClineOAuthCredential | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const auth = (raw as { providers?: { cline?: { settings?: { auth?: unknown } } } })?.providers?.cline?.settings?.auth;
  if (typeof auth !== "object" || auth === null) return undefined;
  const record = auth as Record<string, unknown>;
  if (typeof record.accessToken !== "string" || !record.accessToken.trim()) return undefined;
  return {
    accessToken: record.accessToken,
    refreshToken: typeof record.refreshToken === "string" && record.refreshToken ? record.refreshToken : undefined,
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : undefined,
  };
}

function writeBack(file: string, credential: ClineOAuthCredential): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      providers?: { cline?: { settings?: { auth?: Record<string, unknown> } } };
    };
    const settings = parsed.providers?.cline?.settings;
    if (!settings || typeof settings.auth !== "object" || settings.auth === null) return;
    const existing = settings.auth as Record<string, unknown>;
    existing.accessToken = credential.accessToken;
    if (credential.refreshToken) existing.refreshToken = credential.refreshToken;
    if (credential.expiresAt) existing.expiresAt = credential.expiresAt;
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch { /* 写回失败只影响 CLI 下一次刷新，不影响本次请求。 */ }
}

export class ClineOAuthExpiredError extends Error {}

/**
 * 取可用的 OAuth 令牌：未过期直接用；临期/过期用 refreshToken 刷新一次并写回。
 * 刷新失败（网络/令牌被 CLI 轮换掉）抛 ClineOAuthExpiredError，由调用方报 503。
 */
export async function clineAccessToken(
  file: string = defaultClineProvidersFile(),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const credential = readClineOAuth(file);
  if (!credential) throw clineCredentialError("未检测到 Cline 登录态（providers.json 无 auth）");
  const expiry = jwtExpiryMs(credential.accessToken) ?? credential.expiresAt;
  const margin = 5 * 60 * 1000;
  if (expiry === undefined || expiry - margin > Date.now()) return credential.accessToken;
  if (!credential.refreshToken) throw clineCredentialError("Cline 登录态已过期且无 refreshToken");
  const response = await fetchImpl(CLINE_REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: credential.refreshToken, grantType: "refresh_token" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw clineCredentialError("Cline 登录态已过期且刷新失败（请在终端运行一次 cline 重新登录）");
  }
  const payload = (await response.json()) as { data?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } };
  const data = payload.data ?? {};
  if (typeof data.accessToken !== "string" || !data.accessToken) {
    throw clineCredentialError("Cline 刷新响应缺少 accessToken");
  }
  const next: ClineOAuthCredential = {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : credential.refreshToken,
    expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : jwtExpiryMs(data.accessToken),
  };
  writeBack(file, next);
  return next.accessToken;
}
