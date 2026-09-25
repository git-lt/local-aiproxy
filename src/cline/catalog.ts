import { createHash } from "node:crypto";
import type { ModelCatalog } from "../types.ts";

/**
 * Cline 模型目录 → 网关对外目录。
 *
 * `GET https://api.cline.bot/api/v1/ai/cline/models`（无需鉴权）返回 OpenRouter
 * 风格的完整目录；免费模型以 `:free` 后缀或 `pricing.prompt/completion` 均为 0
 * 标识。只保留免费模型（付费模型由用户各自的 API Key 计费，网关默认屏蔽）。
 * TTL 缓存 + 失败回退：拉取失败时继续供应上次结果，再失败则空目录（Codex 必须
 * 能正常启动，不该因为目录拉不到就拿不到 /v1/models）。
 */

const CATALOG_TTL_MS = 5 * 60 * 1000;

export interface ClineUpstreamModel {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  context_length?: unknown;
  pricing?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function zeroPricing(entry: ClineUpstreamModel): boolean {
  const pricing = entry.pricing;
  if (!isRecord(pricing)) return false;
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

export function isFreeModel(entry: ClineUpstreamModel): boolean {
  if (typeof entry.id === "string" && entry.id.endsWith(":free")) return true;
  return zeroPricing(entry);
}

export function buildClineCatalog(entries: ClineUpstreamModel[]): ModelCatalog {
  const models: ModelCatalog["models"] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || !isFreeModel(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || id.includes(" ") || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name ? entry.name : id;
    const contextLength = Number(entry.context_length);
    models.push({
      slug: `cline/${id}`,
      display_name: `${name}（Cline）`,
      description: `Cline model "${id}" served by the local credential.`,
      ...(Number.isFinite(contextLength) && contextLength > 0 ? { context_window: contextLength } : {}),
    });
  }
  return { models };
}

/** 上游目录身份摘要：内容不变时跳过重发布。 */
export function catalogDigest(entries: ClineUpstreamModel[]): string {
  return createHash("sha256").update(JSON.stringify(entries.map((entry) => [isRecord(entry) ? entry.id : undefined, isRecord(entry) ? entry.pricing : undefined]))).digest("hex");
}

export interface ClineCatalogCache {
  catalog(): Promise<ModelCatalog>;
  close(): void;
}

export function createClineCatalogCache(options: {
  fetchModels: () => Promise<ClineUpstreamModel[]>;
  ttlMs?: number;
  now?: () => number;
}): ClineCatalogCache {
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: ModelCatalog = { models: [] };
  let digest = "";
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | undefined;
  let closed = false;
  const refresh = async (): Promise<void> => {
    const entries = await options.fetchModels();
    const nextDigest = catalogDigest(entries);
    if (nextDigest !== digest) {
      digest = nextDigest;
      cached = buildClineCatalog(entries);
    }
    fetchedAt = now();
  };
  return {
    async catalog(): Promise<ModelCatalog> {
      if (closed) return cached;
      if (now() - fetchedAt < ttlMs) return cached;
      inflight ??= refresh().catch(() => {
        // 拉取失败：保留上次结果（可能为空），等待下一个 TTL 窗口。
      }).finally(() => { inflight = undefined; });
      await inflight;
      return cached;
    },
    close(): void {
      closed = true;
    },
  };
}

/** 按 slug 去重合并：cline 条目追加在既有目录之后，重复 slug 保留先到者。 */
export function mergeClineCatalog(base: ModelCatalog, cline: ModelCatalog): ModelCatalog {
  const seen = new Set(base.models.map((model) => model.slug.toLowerCase()));
  return { models: [...base.models, ...cline.models.filter((model) => !seen.has(model.slug.toLowerCase()))] };
}
