import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * QoderCN 远端域名的只读解析。
 *
 * 远端域不是固定的：企业租户/专属站会拿到不同域名，本机客户端把实际选中的
 * endpoint 缓存在自己的 `.cache/endpoint-cache.json` 系列文件里。网关只读这些缓存，
 * 读不到（未安装、未运行过、格式变化）时回退官方默认域名。
 */

export const DEFAULT_QODERCN_BASE_URL = "https://gateway.qoder.com.cn";

export interface QodercnBaseUrlHint {
  url: string;
  source: string;
}

interface EndpointCandidate {
  /** 相对 Home 的缓存文件路径。 */
  file: string;
  /** 从缓存里取 URL 的路径（点分），取到第一个非空 https 值即用。 */
  paths: string[];
}

const CANDIDATES: EndpointCandidate[] = [
  {
    file: ".qoder-cn/.cache/qoder-client-endpoint-cache.json",
    paths: [
      "entries.prod.endpointSets.inference.selected",
      "entries.prod.endpointSets.center.selected",
      "entries.prod.endpointSets.securityInference.selected",
    ],
  },
  {
    file: ".qoder-cn/.cache/endpoint-cache.json",
    paths: [
      "entries.prod.fastEndpoint",
      "entries.prod.endpoint",
      "entries.prod.centerEndpoint",
    ],
  },
];

function readPath(value: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s"'<>)+]+$/i.test(trimmed)) return undefined;
  return trimmed;
}

export function defaultQodercnHome(): string {
  return os.homedir();
}

/** 解析远端域名：本机端点缓存优先，回退官方默认域名。 */
export function resolveQodercnBaseUrlHint(home: string = defaultQodercnHome()): QodercnBaseUrlHint {
  for (const candidate of CANDIDATES) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(home, candidate.file), "utf8"));
    } catch {
      continue;
    }
    for (const dotted of candidate.paths) {
      const url = normalize(readPath(parsed, dotted));
      if (url) return { url, source: path.join(home, candidate.file) };
    }
  }
  return { url: DEFAULT_QODERCN_BASE_URL, source: "default" };
}

export function resolveQodercnBaseUrl(home?: string): string {
  return resolveQodercnBaseUrlHint(home).url;
}
