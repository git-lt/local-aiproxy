import path from "node:path";
import { isIP } from "node:net";
import {
  ClineCredentialError,
  ClineOAuthExpiredError,
  clineAccessToken,
  defaultClineApiKeyFile,
  defaultClineProvidersFile,
  readClineApiKey,
  readClineOAuth,
} from "./credentials.ts";
import { createClineCatalogCache, type ClineCatalogCache, type ClineUpstreamModel } from "./catalog.ts";
import {
  translateCodebuddyRequest,
  CodebuddyRequestError,
} from "../codebuddy/request.ts";
import { createCodebuddyResponse } from "../codebuddy/response.ts";
import { isZcodeRecord } from "../zcode/wire.ts";
import { localTime, logExchange, logGroupFromPath } from "../request-log.ts";
import type { RequestLogSink } from "../request-log.ts";
import { logGatewayError, logRequestSummary } from "../process-log.ts";
import type { GatewayConfig, ModelCatalog, ProcessLogTarget } from "../types.ts";

/**
 * Cline 官方 API（api.cline.bot）adapter：双凭据模式——
 * - `cline-free/*`：本地 CLI 的 OAuth 登录态（免费档，需携带 CLI 客户端身份头）；
 * - `cline/<id>`：运行时目录的官方 API Key（OpenAI 兼容）。
 * 协议转换复用 CodeBuddy 的全量 Responses→chat 实现，绝不把凭据写进日志。
 */

const CLINE_API_BASE_URL = "https://api.cline.bot/api/v1";
const CLINE_MODELS_URL = `${CLINE_API_BASE_URL}/ai/cline/models`;
const CLINE_CHAT_URL = `${CLINE_API_BASE_URL}/chat/completions`;

/**
 * Cline CLI 客户端身份头：服务端要求请求携带 CLI 的身份标识
 * （缺了任何一个，cline-free 免费档一律 401，MITM 抓包实测确认）。
 */
function clineClientHeaders(taskId: string): Record<string, string> {
  return {
    "user-agent": "Cline/3.0.65 ai-sdk/openai-compatible/3.0.37 ai-sdk/provider-utils/5.0.30 runtime/bun/1.3.13",
    "http-referer": "https://cline.bot",
    "x-client-type": "cline-cli",
    "x-client-version": "3.0.65",
    "x-core-version": "0.0.86",
    "x-is-multiroot": "false",
    "x-platform": "cli",
    "x-platform-version": "3.0.65",
    "x-task-id": taskId,
    "x-title": "Cline",
  };
}

/** CLI 内嵌的 cline-free 免费档模型注册表（1M context，免费）。 */
const CLINE_FREE_MODELS = [
  { id: "cline-free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (free)", contextWindow: 1048576 },
  { id: "cline-free/mimo-v2.6-flash", name: "MiMo-V2.6-Flash (free)", contextWindow: 1048576 },
  { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor (free)", contextWindow: 1048576 },
] as const;

export interface ClineDependencies {
  apiKeyFile?: string;
  providersFile?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  catalogCache?: ClineCatalogCache;
  processLog?: ProcessLogTarget;
}

export function clineEnabled(config: GatewayConfig): boolean {
  return config.cline === true;
}

export function validateClineConfig(config: GatewayConfig): void {
  if (config.cline !== undefined && typeof config.cline !== "boolean") throw new Error("cline 必须为 boolean");
  if (!clineEnabled(config)) return;
  // API Key 从网关自己的运行时目录里读，网关只该服务本机客户端。
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 Cline 时网关只能监听环回地址");
  }
}

export function clineError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

/** 两种对外前缀：`cline/<openrouter-id>`（API Key）与 `cline-free/<model>`（本地 OAuth 免费档）。 */
export function isClineModel(model: unknown): boolean {
  return typeof model === "string" && /^cline(?:-free)?\/\S/i.test(model);
}

export function clineUpstreamModel(model: string): string | undefined {
  if (!isClineModel(model)) return undefined;
  const trimmed = model.trim();
  if (/^cline-free\//i.test(trimmed)) return trimmed;
  return trimmed.slice("cline/".length).trim() || undefined;
}

/** cline-free/ 前缀走本地 OAuth 免费档，其余走 API Key。 */
function isClineFreeModel(model: string): boolean {
  return /^cline-free\//i.test(model.trim());
}

export function createClineAdapter(config: GatewayConfig, dependencies: ClineDependencies = {}) {
  validateClineConfig(config);
  const enabled = clineEnabled(config);
  const apiKeyFile = dependencies.apiKeyFile ?? defaultClineApiKeyFile(config.catalogPath);
  const providersFile = dependencies.providersFile ?? defaultClineProvidersFile();
  const fetchUpstream = dependencies.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  let catalogCache: ClineCatalogCache | undefined;
  if (enabled) {
    catalogCache = dependencies.catalogCache ?? createClineCatalogCache({
      fetchModels: async (): Promise<ClineUpstreamModel[]> => {
        const response = await fetchUpstream(CLINE_MODELS_URL, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`cline_models_http_${response.status}`);
        const payload: unknown = await response.json();
        const list = isZcodeRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
        return list.filter(isZcodeRecord) as unknown as ClineUpstreamModel[];
      },
    });
  }
  const activeRequests = new Set<AbortController>();
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: config.logDir || path.join(path.dirname(config.catalogPath), "logs"),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  let closed = false;

  return {
    async catalog(): Promise<ModelCatalog> {
      if (!catalogCache || closed) return { models: [] };
      try {
        const base = await catalogCache.catalog();
        // 本地 OAuth 登录态存在时，追加 cline-free 免费档（CLI 内嵌注册表）。
        if (readClineOAuth(providersFile)) {
          return {
            models: [
              ...CLINE_FREE_MODELS.map((entry) => ({
                slug: entry.id,
                display_name: `${entry.name}（Cline）`,
                description: `Cline model "${entry.id}" served by the local OAuth login.`,
                context_window: entry.contextWindow,
              })),
              ...base.models,
            ],
          };
        }
        return base;
      } catch { return { models: [] }; }
    },
    async forward(request: Request, input: Record<string, unknown>, mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      const cline = isClineModel(input.model);
      let apiKey = "";
      let upstreamUrl: string | undefined;
      let upstreamRequestHeaders: Headers | undefined;
      let upstreamRequestBody: unknown;
      let logged = false;
      const redact = (text: string) => {
        if (!apiKey) return text;
        const pattern = [...apiKey].map((char) => {
          const escaped = char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
          const hex = char.codePointAt(0)!.toString(16).padStart(4, "0");
          return `(?:${escaped}|\\\\{1,4}${escaped}|\\\\{1,4}u${hex}|\\\\{1,4}u${hex.toUpperCase()})`;
        }).join("");
        let result = text.replace(new RegExp(pattern, "gu"), "***");
        let variant = apiKey;
        for (let depth = 0; depth < 4; depth++) {
          result = result.replaceAll(variant, "***");
          variant = JSON.stringify(variant).slice(1, -1);
        }
        return result;
      };
      const redactValue = (value: unknown): unknown => {
        if (typeof value === "string") return redact(value);
        if (Array.isArray(value)) return value.map(redactValue);
        if (isZcodeRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item)]));
        return value;
      };
      const log = (status: number, body: string, headers = new Headers(), logicalError?: string) => {
        if (logged || !cline) return;
        logged = true;
        const durationMs = Date.now() - start;
        const at = incoming.pathname + incoming.search;
        logExchange(sink, group, {
          requestTime, method: request.method, url: at,
          reqHeaders: request.headers, reqBody: redactValue(input),
          status, resHeaders: headers, resBody: redact(body), upstreamUrl, upstreamRequestHeaders, upstreamRequestBody, durationMs,
        }, "cline");
        if (status >= 400 || logicalError) {
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: at,
            status: logicalError && status < 400 ? 502 : status,
            message: redact(logicalError ?? body), upstreamUrl, durationMs,
          });
        } else {
          logRequestSummary(sink?.processLog, {
            requestTime, method: request.method, url: at, status, upstreamUrl, durationMs,
          });
        }
      };
      const fail = (status: number, message: string, type?: string) => {
        const response = clineError(status, redact(message), type);
        log(status, JSON.stringify({ error: { type, message: redact(message) } }), response.headers);
        return response;
      };
      if (!catalogCache || closed) return fail(503, "Cline 未启用或网关已关闭", "configuration_error");
      const abort = new AbortController();
      const onAbort = () => abort.abort(request.signal.reason);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        request.signal.removeEventListener("abort", onAbort);
        activeRequests.delete(abort);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      activeRequests.add(abort);
      try {
        if (request.signal.aborted) onAbort();
        abort.signal.throwIfAborted();
        const model = clineUpstreamModel(String(input.model));
        if (!model) { cleanup(); return fail(400, "Cline 模型名必须使用 cline/ 或 cline-free/ 前缀"); }
        // 双凭据模式：cline-free/* 走本地 OAuth 免费档（需 CLI 客户端身份头），
        // cline/* 走官方 API Key（纯 Bearer）。
        const freeMode = isClineFreeModel(String(input.model));
        apiKey = freeMode
          ? await clineAccessToken(providersFile, fetchUpstream as typeof fetch)
          : readClineApiKey(apiKeyFile);
        abort.signal.throwIfAborted();
        const translated = translateCodebuddyRequest(input, model);
        upstreamUrl = CLINE_CHAT_URL;
        const body = translated.body;
        // Cline 上游拒绝空 system 消息（"system message must have content"）：
        // 无 instructions 的 Codex 请求会翻译出空 system，转发前剔除。
        if (Array.isArray(body.messages)) {
          body.messages = (body.messages as unknown[]).filter((message) => {
            const record = isZcodeRecord(message) ? message : {};
            return !(record.role === "system" && (record.content === "" || record.content === null || record.content === undefined));
          });
        }
        upstreamRequestBody = sink ? redactValue(body) : undefined;
        const headers = new Headers({
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(freeMode ? clineClientHeaders(`gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) : {}),
        });
        upstreamRequestHeaders = headers;
        const serializedBody = JSON.stringify(body);
        const upstream = await fetchUpstream(upstreamUrl, {
          method: "POST", headers, body: serializedBody, redirect: "manual", signal: abort.signal,
        });
        if (!upstream.ok) {
          const text = redact(await upstream.text());
          cleanup();
          let message = text || `Cline 上游返回 HTTP ${upstream.status}`;
          try {
            const error: unknown = redactValue(JSON.parse(text));
            if (isZcodeRecord(error)) {
              if (isZcodeRecord(error.error) && typeof error.error.message === "string") message = error.error.message;
              else if (typeof error.message === "string") message = error.message;
              else if (typeof error.error === "string") message = error.error;
              else message = JSON.stringify(error);
            }
          } catch { /* 非 JSON 上游错误保留脱敏正文。 */ }
          const guidance = upstream.status === 401
            ? (freeMode
              ? `${message}（Cline 登录态可能已失效，请在终端运行一次 cline 重新登录）`
              : `${message}（Cline API Key 可能已失效，请在 app.cline.bot 重新生成并更新 cline-api-key 文件）`)
            : message;
          return fail(upstream.status, guidance, "upstream_error");
        }
        let chunks = "";
        const stream = !mapResult && input.stream === true;
        const response = await createCodebuddyResponse(upstream, {
          model: String(input.model), tools: translated.tools, stream, signal: abort.signal,
          sanitizeError: (error) => ({
            code: typeof error.code === "string" ? redact(error.code) : "upstream_error",
            message: typeof error.message === "string" ? redact(error.message) : "Cline 上游响应失败",
          }),
          abort: () => { abort.abort(); cleanup(); },
          onChunk: (chunk) => { if (sink) chunks += chunk; },
          onComplete: (payload) => {
            cleanup();
            const stripped = translated.dropped.length ? `\n--- stripped built-in tools: ${translated.dropped.join(", ")} ---` : "";
            if (!mapResult) log(stream ? 200 : payload.status === "failed" ? 502 : 200,
              stream ? `${chunks}${stripped}\n--- response.${payload.status} ---\n${JSON.stringify(redactValue(payload))}` : `${JSON.stringify(redactValue(payload))}${stripped}`,
              new Headers({ "content-type": stream ? "text/event-stream" : "application/json" }),
              payload.status === "failed" ? JSON.stringify(payload.error ?? "响应失败") : undefined);
          },
        });
        if (!mapResult) return response;
        const payload: unknown = await response.json();
        if (!response.ok || !isZcodeRecord(payload)) {
          cleanup();
          return fail(502, "Cline 上游未完成上下文压缩", "invalid_response_error");
        }
        const mapped = mapResult(payload);
        log(mapped.status, await mapped.clone().text(), mapped.headers);
        cleanup();
        return mapped;
      } catch (error) {
        abort.abort();
        cleanup();
        if (error instanceof CodebuddyRequestError) return fail(400, error.message);
        if (error instanceof ClineOAuthExpiredError) return fail(503, error.message, "configuration_error");
        if (error instanceof ClineCredentialError) return fail(503, error.message, "configuration_error");
        if (request.signal.aborted) return fail(499, "Cline 请求已取消", "request_cancelled");
        return fail(502, "Cline 上游请求失败", "upstream_error");
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      catalogCache?.close();
      for (const request of activeRequests) request.abort();
      activeRequests.clear();
    },
  };
}
