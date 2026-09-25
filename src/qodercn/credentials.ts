import { createDecipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * QoderCN / 通义灵码本机登录态的只读消费层。
 *
 * 凭据不是网关签发的：本机客户端登录后把它写进自己的运行时目录，用 machine id
 * 的前 16 字节做 AES-128-CBC 加密（`cache/user`，新版 QoderCN 布局为 `.auth/user`）。
 * 网关只把它解密到当前调用栈里用于给远端请求签名：不写回客户端文件、不做导出，
 * 令牌轮换与登出完全由客户端自己负责。
 *
 * 布局对照（实测 2026-09 的 QoderCN 落在第一组，上游 lingma-proxy 文档描述的是第二组）：
 * - ~/.qoder-cn/.auth/user + ~/.qoder-cn/.auth/machine_id
 * - ~/.qoder-cn/shared_client/cache/user + cache/id（含 ~/.lingma 的同类布局）
 */

export class QodercnCredentialError extends Error {}

export function qodercnCredentialError(message: string): QodercnCredentialError {
  return new QodercnCredentialError(`${message}；请确认已在本机安装并登录 QoderCN/通义灵码客户端，必要时重启 QoderCN 让登录缓存刷新`);
}

export interface QodercnCredential {
  /** 远端请求的签名密钥（`cosy_key`），只存在于当前调用栈。 */
  cosyKey: string;
  encryptUserInfo: string;
  userId: string;
  machineId: string;
  /** 凭据来源文件路径：只用于报错定位，不含任何密钥。 */
  source: string;
  tokenExpireMs?: number;
}

/** 运行时根目录：先 QoderCN，再回退旧版通义灵码。 */
const RUNTIME_ROOTS = [".qoder-cn", ".lingma"] as const;
const USER_FILES = [".auth/user", "cache/user", "shared_client/cache/user"] as const;
const MACHINE_ID_FILES = [".auth/machine_id", "cache/id", "cli/.auth/id"] as const;

export function defaultQodercnHome(): string {
  return os.homedir();
}

function readText(file: string): string | undefined {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 解密登录缓存：machine id 前 16 字节同时作为 key 与 IV，Node 自行剥离 PKCS#7 填充。 */
function decryptCacheUser(machineId: string, payload: string): Record<string, unknown> {
  if (machineId.length < 16) throw new Error("machine id 过短，无法派生解密密钥");
  const key = Buffer.from(machineId.slice(0, 16), "utf8");
  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.from(payload, "base64");
  } catch {
    throw new Error("登录缓存不是有效的 base64");
  }
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new Error("登录缓存密文长度非法");
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, key);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("登录缓存解密失败（machine id 可能不匹配）");
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("登录缓存明文不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("登录缓存明文不是 JSON 对象");
  return value as Record<string, unknown>;
}

/** expire_time 在实测缓存里是秒级时间戳；同时兼容毫秒写法与字符串。 */
function parseExpireMs(value: unknown): number | undefined {
  const raw = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  const ms = raw > 1e12 ? raw : raw * 1000;
  return Number.isFinite(ms) ? ms : undefined;
}

function credentialFromCache(userFile: string, machineIdFile: string, home: string):
  QodercnCredential | { error: string } {
  const user = readText(path.join(home, userFile));
  if (user === undefined) return { error: "无登录缓存" };
  const machineId = readText(path.join(home, machineIdFile));
  if (machineId === undefined) return { error: "无 machine id" };
  let payload: Record<string, unknown>;
  try {
    payload = decryptCacheUser(machineId, user);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "解密失败" };
  }
  const cosyKey = typeof payload.key === "string" ? payload.key.trim() : "";
  if (!cosyKey) return { error: "登录缓存缺少签名密钥字段 key" };
  return {
    cosyKey,
    encryptUserInfo: typeof payload.encrypt_user_info === "string" ? payload.encrypt_user_info : "",
    userId: typeof payload.uid === "string" ? payload.uid : "",
    machineId,
    source: path.join(home, userFile),
    ...(() => {
      const expireMs = parseExpireMs(payload.expire_time);
      return expireMs === undefined ? {} : { tokenExpireMs: expireMs };
    })(),
  };
}

/**
 * 读取本机登录态：按「运行时根目录 → 缓存文件 → machine id 文件」顺序找到第一个
 * 能正确解密且带 key 字段的组合。所有候选都失败时抛出带修复指引的错误。
 */
export function readQodercnCredential(home: string = defaultQodercnHome()): QodercnCredential {
  const attempts: string[] = [];
  for (const root of RUNTIME_ROOTS) {
    for (const userFile of USER_FILES) {
      for (const machineIdFile of MACHINE_ID_FILES) {
        const result = credentialFromCache(path.join(root, userFile), path.join(root, machineIdFile), home);
        if (!("error" in result)) return result;
        if (!attempts.includes(result.error)) attempts.push(result.error);
      }
    }
  }
  throw qodercnCredentialError(`未找到可用的 QoderCN/通义灵码登录缓存（${attempts.join("、") || "无候选位置"}）`);
}

/** Web UI 的存在性探测：只看能不能读出一份带 key 的登录缓存，不打印任何凭据。 */
export function qodercnCredentialsPresent(home: string = defaultQodercnHome()): boolean {
  try {
    readQodercnCredential(home);
    return true;
  } catch {
    return false;
  }
}
