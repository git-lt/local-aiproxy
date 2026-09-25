import type { ModelCatalog } from "../types.ts";

/**
 * QoderCN 远端模型列表 → 网关对外目录。
 *
 * `GET <base>/algo/api/v2/model/list` 返回按场景分组的模型集合（`chat`、`inline`、
 * `experts`…）；网关取全部分组、`qodercn/<key>` 前缀对外暴露，具体用哪个模型由
 * 请求里的 model 字段决定。TTL 缓存 + 失败回退：拉取失败时继续供应上次结果，
 * 再失败则空目录（Codex 必须能正常启动，不该因为目录拉不到就拿不到 /v1/models）。
 */

const CATALOG_TTL_MS = 5 * 60 * 1000;

export interface QodercnUpstreamGroups {
  [group: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contextWindow(entry: Record<string, unknown>): number | undefined {
  const value = Number(entry.max_input_tokens);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** 展平上游分组：所有分组的数组条目前后相接，保持上游顺序。 */
export function flattenQodercnModels(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const value of Object.values(payload)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) if (isRecord(item)) entries.push(item);
  }
  return entries;
}

export function buildQodercnCatalog(payload: unknown): ModelCatalog {
  const models: ModelCatalog["models"] = [];
  const seen = new Set<string>();
  for (const entry of flattenQodercnModels(payload)) {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key || key.includes("/") || key.includes(" ") || seen.has(key)) continue;
    seen.add(key);
    const name = typeof entry.display_name === "string" && entry.display_name.trim()
      ? entry.display_name.trim()
      : key;
    models.push({
      slug: `qodercn/${key}`,
      display_name: name,
      description: `QoderCN model "${key}" served by the local QoderCN login.`,
      ...(() => {
        const window = contextWindow(entry);
        return window === undefined ? {} : { context_window: window };
      })(),
    });
  }
  return { models };
}

export interface QodercnCatalogCache {
  catalog(): Promise<ModelCatalog>;
  close(): void;
}

export function createQodercnCatalogCache(options: {
  fetchModels: () => Promise<unknown>;
  ttlMs?: number;
  now?: () => number;
}): QodercnCatalogCache {
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: ModelCatalog = { models: [] };
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | undefined;
  let closed = false;
  return {
    async catalog(): Promise<ModelCatalog> {
      if (closed) return cached;
      if (now() - fetchedAt < ttlMs) return cached;
      inflight ??= options.fetchModels()
        .then((payload) => { cached = buildQodercnCatalog(payload); })
        .catch(() => {
          // 拉取失败：保留上次结果（可能为空），等待下一个 TTL 窗口。
        })
        .finally(() => { inflight = undefined; fetchedAt = now(); });
      await inflight;
      return cached;
    },
    close(): void {
      closed = true;
    },
  };
}

/** 按 slug 去重合并：qodercn 条目追加在既有目录之后，重复 slug 保留先到者。 */
export function mergeQodercnCatalog(base: ModelCatalog, qodercn: ModelCatalog): ModelCatalog {
  const seen = new Set(base.models.map((model) => model.slug.toLowerCase()));
  return { models: [...base.models, ...qodercn.models.filter((model) => !seen.has(model.slug.toLowerCase()))] };
}
