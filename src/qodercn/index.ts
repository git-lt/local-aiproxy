import { isIP } from "node:net";
import path from "node:path";
import {
  QodercnCredentialError,
  readQodercnCredential,
} from "./credentials.ts";
import { resolveQodercnBaseUrl } from "./base-url.ts";
import { createQodercnCatalogCache, type QodercnCatalogCache } from "./catalog.ts";
import {
  QODERCN_CHAT_PATH,
  QODERCN_CHAT_QUERY,
  QODERCN_MODEL_LIST_PATH,
  buildQodercnChatPayload,
  signQodercnHeaders,
} from "./request.ts";
import { rewriteQodercnSse } from "./response.ts";
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
 * QoderCN（远端 API 模式）adapter：
 *
 * 只读消费本机 QoderCN/通义灵码客户端的登录缓存，直接调用它的远端接口，
 * 不连本机 IPC（因此不要求 QoderCN 处于运行中）。协议转换复用 CodeBuddy 的
 * 全量 Responses→chat 实现；远端 SSE 由 response.ts 剥壳后交给同一套响应层。
 * 凭据只在请求调用栈里存在：绝不写凭据文件、绝不进日志、绝不进 Web UI。
 */

export interface QodercnDependencies {
  home?: string;
  baseUrl?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  catalogCache?: QodercnCatalogCache;
  processLog?: ProcessLogTarget;
}

export function qodercnEnabled(config: GatewayConfig): boolean {
  return config.qodercn === true;
}

export function validateQodercnConfig(config: GatewayConfig): void {
  if (config.qodercn !== undefined && typeof config.qodercn !== "boolean") throw new Error("qodercn 必须为 boolean");
  if (!qodercnEnabled(config)) return;
  // 凭据来自本机的客户端登录态，网关只该服务本机。
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 QoderCN 时网关只能监听环回地址");
  }
}

export function qodercnError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

/** 对外统一 `qodercn/<远端模型 key>` 前缀。 */
export function isQodercnModel(model: unknown): boolean {
  return typeof model === "string" && /^qodercn\/\S/i.test(model);
}

export function qodercnUpstreamModel(model: string): string | undefined {
  if (!isQodercnModel(model)) return undefined;
  return model.trim().slice("qodercn/".length).trim() || undefined;
}

export function createQodercnAdapter(config: GatewayConfig, dependencies: QodercnDependencies = {}) {
  validateQodercnConfig(config);
  const enabled = qodercnEnabled(config);
  const home = dependencies.home;
  const fetchUpstream = dependencies.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  // 远端域名每次解析：本机端点缓存被客户端更新后无需重启网关。
  const baseUrl = (): string => dependencies.baseUrl ?? resolveQodercnBaseUrl(home);
  let catalogCache: QodercnCatalogCache | undefined;
  if (enabled) {
    catalogCache = dependencies.catalogCache ?? createQodercnCatalogCache({
      fetchModels: async (): Promise<unknown> => {
        const credential = readQodercnCredential(home);
        const response = await fetchUpstream(`${baseUrl()}${QODERCN_MODEL_LIST_PATH}`, {
          method: "GET",
          headers: signQodercnHeaders(credential, { path: QODERCN_MODEL_LIST_PATH, body: "" }),
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`qodercn_models_http_${response.status}`);
        return response.json();
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
      return catalogCache.catalog().catch(() => ({ models: [] }));
    },
    async forward(request: Request, input: Record<string, unknown>, mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      const qodercn = isQodercnModel(input.model);
      let secrets: string[] = [];
      let upstreamUrl: string | undefined;
      let upstreamRequestHeaders: Headers | undefined;
      let upstreamRequestBody: unknown;
      let logged = false;
      const redact = (text: string): string => {
        let result = text;
        for (const secret of secrets) result = result.replaceAll(secret, "***");
        return result;
      };
      const redactValue = (value: unknown): unknown => {
        if (typeof value === "string") return redact(value);
        if (Array.isArray(value)) return value.map(redactValue);
        if (isZcodeRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item)]));
        return value;
      };
      const log = (status: number, body: string, headers = new Headers(), logicalError?: string) => {
        if (logged || !qodercn) return;
        logged = true;
        const durationMs = Date.now() - start;
        const at = incoming.pathname + incoming.search;
        logExchange(sink, group, {
          requestTime, method: request.method, url: at,
          reqHeaders: request.headers, reqBody: redactValue(input),
          status, resHeaders: headers, resBody: redact(body), upstreamUrl, upstreamRequestHeaders, upstreamRequestBody, durationMs,
        }, "qodercn");
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
        const response = qodercnError(status, redact(message), type);
        log(status, JSON.stringify({ error: { type, message: redact(message) } }), response.headers);
        return response;
      };
      if (closed) return fail(503, "QoderCN 未启用或网关已关闭", "configuration_error");
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
        const model = qodercnUpstreamModel(String(input.model));
        if (!model) { cleanup(); return fail(400, "QoderCN 模型名必须使用 qodercn/ 前缀"); }
        const credential = readQodercnCredential(home);
        // 凭据可能出现在 URL 之外的任何回显里（上游错误正文、SSE 文本），统一抹除。
        secrets = [credential.cosyKey, credential.encryptUserInfo, credential.machineId]
          .filter((secret) => secret.length > 0);
        abort.signal.throwIfAborted();
        const translated = translateCodebuddyRequest(input, model);
        const requestId = crypto.randomUUID().replaceAll("-", "");
        const body = buildQodercnChatPayload(requestId, { body: translated.body, upstreamModel: model });
        const serialized = JSON.stringify(body);
        upstreamUrl = `${baseUrl()}${QODERCN_CHAT_PATH}${QODERCN_CHAT_QUERY}`;
        upstreamRequestBody = sink ? redactValue(body) : undefined;
        const headers = signQodercnHeaders(credential, { path: QODERCN_CHAT_PATH, body: serialized });
        // cosy-* 头由 request-log 的敏感头集合统一打码，无需在此复制一份脱敏逻辑。
        upstreamRequestHeaders = headers;
        const upstream = await fetchUpstream(upstreamUrl, {
          method: "POST", headers, body: serialized, redirect: "manual", signal: abort.signal,
        });
        if (!upstream.ok) {
          const text = redact(await upstream.text());
          cleanup();
          const message = text.trim() || `QoderCN 上游返回 HTTP ${upstream.status}`;
          return fail(upstream.status, upstream.status === 401 || upstream.status === 403
            ? `${message}（QoderCN 登录态可能已失效，请在 QoderCN 里重新登录后重试）`
            : message, "upstream_error");
        }
        let chunks = "";
        const stream = !mapResult && input.stream === true;
        const response = await createCodebuddyResponse(rewriteQodercnSse(upstream), {
          model: String(input.model), tools: translated.tools, stream, signal: abort.signal,
          sanitizeError: (error) => ({
            code: typeof error.code === "string" ? redact(error.code) : "upstream_error",
            message: typeof error.message === "string" ? redact(error.message) : "QoderCN 上游响应失败",
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
          return fail(502, "QoderCN 上游未完成上下文压缩", "invalid_response_error");
        }
        const mapped = mapResult(payload);
        log(mapped.status, await mapped.clone().text(), mapped.headers);
        cleanup();
        return mapped;
      } catch (error) {
        abort.abort();
        cleanup();
        if (error instanceof CodebuddyRequestError) return fail(400, error.message);
        if (error instanceof QodercnCredentialError) return fail(503, error.message, "configuration_error");
        if (request.signal.aborted) return fail(499, "QoderCN 请求已取消", "request_cancelled");
        return fail(502, "QoderCN 上游请求失败", "upstream_error");
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
