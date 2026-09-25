import path from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { createZcodeAdapter, validateZcodeConfig, zcodeEnabled, zcodeError } from "./zcode/index.ts";
import type { ZcodeDependencies, GatewayHandler } from "./zcode/index.ts";
import { isZcodeModel, mergeZcodeCatalog } from "./zcode/catalog.ts";
import {
  codebuddyEnabled,
  codebuddyError,
  createCodebuddyAdapter,
  validateCodebuddyConfig,
} from "./codebuddy/index.ts";
import type { CodebuddyDependencies } from "./codebuddy/index.ts";
import { isCodebuddyModel, mergeCodebuddyCatalog } from "./codebuddy/catalog.ts";
import {
  createClineAdapter,
  clineEnabled,
  clineError,
  isClineModel,
  validateClineConfig,
} from "./cline/index.ts";
import type { ClineDependencies } from "./cline/index.ts";
import { mergeClineCatalog } from "./cline/catalog.ts";
import {
  createQodercnAdapter,
  isQodercnModel,
  qodercnEnabled,
  qodercnError,
  validateQodercnConfig,
} from "./qodercn/index.ts";
import type { QodercnDependencies } from "./qodercn/index.ts";
import { mergeQodercnCatalog } from "./qodercn/catalog.ts";
import { pruneLogDir } from "./request-log.ts";
import { webUiPort } from "./webui.ts";
import type { GatewayConfig, ModelCatalog, ProcessLogTarget } from "./types.ts";

const COMPACTION_PREFIX = "ocx1:";
const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work.\nHere is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";
const COMPACT_V1_RETAINED_CHAR_BUDGET = 80_000;

type Route =
  | { kind: "cliproxy"; upstreamModel: string }
  | { kind: "official"; upstreamModel: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uuid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function encodeCompactionSummary(summary: string): string {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

function decodeCompactionSummary(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return null;
  const encoded = value.slice(COMPACTION_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, "base64").toString("utf8");
}

function compactionMessage(item: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodeCompactionSummary(item.encrypted_content);
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: decoded?.trim()
        ? `${SUMMARY_PREFIX}\n\n${decoded}`
        : OPAQUE_COMPACTION_NOTE,
    }],
  };
}

function rewriteCompactionHistory(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => isRecord(item) && item.type === "compaction" ? compactionMessage(item) : item);
}

function stripInputImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInputImages);
  if (!isRecord(value)) return value;
  if (value.type === "input_image") {
    return { type: "input_text", text: "[image omitted for compaction]" };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stripInputImages(entry)]));
}

function hasCompactionTrigger(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) => isRecord(item) && item.type === "compaction_trigger");
}

function buildCompactionRequest(
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const {
    tools: _tools,
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallelToolCalls,
    additional_tools: _additionalTools,
    stream_options: _streamOptions,
    text: _text,
    ...rest
  } = body;
  const input = Array.isArray(body.input)
    ? body.input.filter((item) => !isRecord(item)
      || (item.type !== "compaction_trigger" && item.type !== "additional_tools"))
    : [];
  return {
    ...rest,
    model: upstreamModel,
    stream: false,
    input: [
      ...stripInputImages(rewriteCompactionHistory(input)) as unknown[],
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: COMPACTION_PROMPT }],
      },
    ],
  };
}

function responseText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.output)) return "";
  return payload.output
    .filter((item) => isRecord(item) && item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content as unknown[])
    .flatMap((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string"
      ? [part.text]
      : [])
    .join("")
    .trim();
}

function compactUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!isRecord(item) || (item.type !== undefined && item.type !== "message") || item.role !== "user") return [];
    if (typeof item.content === "string") {
      return item.content.trim() && !item.content.startsWith(SUMMARY_PREFIX) ? [item.content] : [];
    }
    if (!Array.isArray(item.content)) return [];
    const text = item.content
      .filter((part) => isRecord(part)
        && (part.type === "input_text" || part.type === "text")
        && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text.trim() && !text.startsWith(SUMMARY_PREFIX) ? [text] : [];
  });
}

function compactV1Output(input: unknown, summary: string): Record<string, unknown>[] {
  const selected: string[] = [];
  let remaining = COMPACT_V1_RETAINED_CHAR_BUDGET;
  const messages = compactUserMessages(input);
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index];
    selected.push(message.length <= remaining ? message : message.slice(-remaining));
    remaining -= Math.min(message.length, remaining);
  }
  selected.reverse();
  return [...selected, `${SUMMARY_PREFIX}\n${summary}`].map((text) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }));
}

function syntheticCompactionResponse(
  payload: Record<string, unknown>,
  upstreamModel: string,
  summary: string,
  stream: boolean,
): Response {
  const item = {
    type: "compaction",
    id: `cmp_${uuid()}`,
    encrypted_content: encodeCompactionSummary(summary),
  };
  const response = {
    id: typeof payload.id === "string" ? payload.id : `resp_${uuid()}`,
    object: "response",
    created_at: typeof payload.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000),
    status: "completed",
    model: upstreamModel,
    output: [item],
    usage: payload.usage ?? null,
  };
  if (!stream) return Response.json(response);

  const created = { ...response, status: "in_progress", output: [], usage: null };
  const frames = [
    ["response.created", { type: "response.created", sequence_number: 0, response: created }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 0,
      item,
    }],
    ["response.completed", { type: "response.completed", sequence_number: 2, response }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(`${frames}data: [DONE]\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

function compactionError(message: string): Response {
  return Response.json({ error: { type: "invalid_response_error", message } }, { status: 502 });
}

/** 426 语义是"协商失败，请改用 HTTPS/SSE"——客户端会自动降级重试，不计入错误摘要。 */
function websocketNotSupportedResponse(marker = "websocket-not-supported"): Response {
  return new Response("WebSocket transport is not supported; retry with HTTPS/SSE.", {
    status: 426,
    headers: {
      connection: "close",
      "x-local-aiproxy": marker,
    },
  });
}

/** Codex 在 x-codex-routing-hint 里给出完整模型名（zcode/… 或 codebuddy-<region>/…），GET 请求也带。 */
/**
 * 中转链路的模型名归一化。opencodex 等上游中转会把目录 slug 原样发给网关
 * （如 `local-proxy/codebuddy-cn-deepseek-v4-pro`），这里只做两层等价还原：
 * 1. 剥掉已知的外层中转前缀（`local-proxy/`）；
 * 2. 已知路由段的 `-` 连写还原为 `/`（`codebuddy-cn-<model>` -> `codebuddy-cn/<model>`，
 *    同理 workbuddy 与 zcode 的三个固定套餐段）。
 * 未识别的形状原样返回，由后续模型族判定给出精确 404。动态 `zcode-<providerId>/`
 * 段的连写与模型 ID 中的 `-` 无法无歧义区分，不做还原。
 */
export function normalizeGatewayModel(model: string): string {
  let name = model.trim();
  if (!name) return name;
  if (name.toLowerCase().startsWith("local-proxy/")) name = name.slice("local-proxy/".length);
  const codebuddyDash = /^(codebuddy|workbuddy)-(cn|intl)-([^/-].*)$/i.exec(name);
  if (codebuddyDash) return `${codebuddyDash[1]!.toLowerCase()}-${codebuddyDash[2]!.toLowerCase()}/${codebuddyDash[3]}`;
  const zcodeDash = /^zcode-(individual-coding-plan|team-coding-plan|start-plan)-([^/-].*)$/i.exec(name);
  if (zcodeDash) return `zcode-${zcodeDash[1]!.toLowerCase()}/${zcodeDash[2]}`;
  return name;
}

function modelFromRoutingHint(request: Request): string | undefined {
  const hint = request.headers.get("x-codex-routing-hint")
    ?.match(/(?:^|[;,\s])model=([^;,\s]+)/)?.[1] || undefined;
  return hint === undefined ? undefined : normalizeGatewayModel(hint);
}

/** 仅拦截已识别的 ZCode Responses WebSocket 升级请求，转为本地 426。 */
export function isZcodeResponsesWebSocket(request: Request, config: GatewayConfig): boolean {
  return zcodeEnabled(config)
    && new URL(request.url).pathname === `${config.mountPath || "/v1"}/responses`
    && request.headers.get("upgrade")?.toLowerCase() === "websocket"
    && isZcodeModel(modelFromRoutingHint(request));
}

/** CodeBuddy/WorkBuddy Responses 同样只走 HTTP/SSE，WebSocket 升级一律本地拒绝。 */
export function isCodebuddyResponsesWebSocket(request: Request, config: GatewayConfig): boolean {
  return codebuddyEnabled(config)
    && new URL(request.url).pathname === `${config.mountPath || "/v1"}/responses`
    && request.headers.get("upgrade")?.toLowerCase() === "websocket"
    && isCodebuddyModel(modelFromRoutingHint(request));
}

async function readBodyBytes(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  return request.arrayBuffer();
}

/**
 * 解压并解析请求体。仅在确实需要 payload 时调用；解压失败时按调用方决定如何处理。
 */
function decodeJsonBody(
  bytes: ArrayBuffer | undefined,
  headers: Headers,
): Record<string, unknown> | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  const encoding = headers.get("content-encoding")?.toLowerCase().trim();
  const compressed = Buffer.from(bytes);
  const decoded = !encoding || encoding === "identity"
    ? compressed
    : encoding === "zstd"
      ? zstdDecompressSync(compressed)
      : encoding === "gzip"
      ? gunzipSync(compressed)
      : encoding === "deflate"
        ? inflateSync(compressed)
        : encoding === "br"
          ? brotliDecompressSync(compressed)
          : (() => { throw new Error(`Unsupported content encoding: ${encoding}`); })();
  const text = new TextDecoder().decode(decoded);
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    if (headers.get("content-type")?.includes("application/json")) {
      throw new Error("Invalid JSON request body");
    }
    return undefined;
  }
}


/** mountPath 子树判定：只有这里的请求可能被两个 adapter 处理，其余一律本地 404。 */
export function isUnderMountPath(pathname: string, mountPath: string): boolean {
  if (!mountPath || mountPath === "/") return true;
  return pathname === mountPath || pathname.startsWith(mountPath.endsWith("/") ? mountPath : `${mountPath}/`);
}

/**
 * 模型目录响应：Codex 带 client_version 时给 Codex 目录形状（`{"models":[...]}`），
 * 否则给 OpenAI list 形状。目录来自两个本地 adapter；都未启用时返回空列表——
 * Codex 必须能正常启动，不该因为本机没登录就拿不到 /v1/models。
 */
function modelCatalogResponse(catalog: ModelCatalog, clientVersion: string | null): Response {
  if (clientVersion) return Response.json(catalog);
  return Response.json({
    object: "list",
    data: catalog.models.map((model) => ({
      id: model.slug,
      object: "model",
      owned_by: isZcodeModel(model.slug) ? "zcode"
        : isCodebuddyModel(model.slug) ? "codebuddy"
        : isQodercnModel(model.slug) ? "qodercn"
        : "local",
    })),
  });
}

/** 合并两个本地 adapter 的对外目录；未启用的 adapter 不贡献条目。白名单外的模型被过滤。 */
async function catalogModelsResponse(
  request: Request,
  handleZcode: { catalog(): Promise<ModelCatalog> },
  handleCodebuddy: { catalog(): Promise<ModelCatalog> },
  handleCline: { catalog(): Promise<ModelCatalog> },
  handleQodercn: { catalog(): Promise<ModelCatalog> },
  zcodeOn: boolean,
  codebuddyOn: boolean,
  clineOn: boolean,
  qodercnOn: boolean,
  enabledModels: Set<string>,
  allModelsEnabled: boolean,
): Promise<Response> {
  let catalog: ModelCatalog = { models: [] };
  if (zcodeOn) catalog = mergeZcodeCatalog(catalog, await handleZcode.catalog());
  if (codebuddyOn) catalog = mergeCodebuddyCatalog(catalog, await handleCodebuddy.catalog());
  if (clineOn) catalog = mergeClineCatalog(catalog, await handleCline.catalog());
  if (qodercnOn) catalog = mergeQodercnCatalog(catalog, await handleQodercn.catalog());
  if (!allModelsEnabled) {
    catalog = { models: catalog.models.filter((model) => enabledModels.has(model.slug.toLowerCase())) };
  }
  return modelCatalogResponse(catalog, new URL(request.url).searchParams.get("client_version"));
}

/** 从请求体里读 model；仅在需要给出精确 404 文案时调用，读失败按「没有模型」处理。 */
async function bodyModel(request: Request): Promise<string | undefined> {
  try {
    const json = decodeJsonBody(await readBodyBytes(request), request.headers);
    return typeof json?.model === "string" ? json.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 未命中任何本地模型族时的本地 404。网关没有第三方上游、也没有官方 ChatGPT 回落，
 * 所以这里必须拒绝而不是转发——否则请求会被发给一个不存在的上游。
 */
function modelNotFoundResponse(model: unknown): Response {
  const name = typeof model === "string" && model ? normalizeGatewayModel(model) : undefined;
  const family = name === undefined
    ? undefined
    : isZcodeModel(name) ? "zcode"
      : isCodebuddyModel(name) ? "codebuddy"
        : isClineModel(name) ? "cline"
          : isQodercnModel(name) ? "qodercn"
            : undefined;
  const message = name === undefined
    ? "No model given. This gateway serves only local ZCode, CodeBuddy/WorkBuddy, Cline and QoderCN models."
    : family !== undefined
      ? `Model ${name} requires the ${family} integration to be enabled in gateway config.json.`
      : `Model ${name} is not served by this gateway; use a zcode/, codebuddy-<region>/, cline/ or qodercn/ id.`;
  return Response.json(
    { error: { type: "invalid_request_error", code: "model_not_found", message } },
    { status: 404 },
  );
}

/**
 * 网关请求处理：只服务本机 ZCode 与 CodeBuddy/WorkBuddy 两个 adapter。
 * 没有第三方上游，也没有官方 ChatGPT 回落；模型族不匹配一律本地 404。
 */
export function createGatewayHandler(
  config: GatewayConfig,
  zcodeDependencies?: ZcodeDependencies,
  processLog?: ProcessLogTarget,
  codebuddyDependencies?: CodebuddyDependencies,
  clineDependencies?: ClineDependencies,
  qodercnDependencies?: QodercnDependencies,
): GatewayHandler {
  const handleZcode = createZcodeAdapter(config, { ...zcodeDependencies, processLog });
  const handleCodebuddy = createCodebuddyAdapter(config, { ...codebuddyDependencies, processLog });
  const handleCline = createClineAdapter(config, { ...clineDependencies, processLog });
  const handleQodercn = createQodercnAdapter(config, { ...qodercnDependencies, processLog });
  const mountPath = config.mountPath || "/v1";
  const zcodeOn = zcodeEnabled(config);
  const codebuddyOn = codebuddyEnabled(config);
  const clineOn = clineEnabled(config);
  const qodercnOn = qodercnEnabled(config);
  // 对外模型白名单：`*` 全部放行；缺省/空 = 全部模型开关关闭（一个都不放行）。
  const enabledModels = new Set((config.enabledModels ?? []).map((slug) => slug.toLowerCase()));
  const allModelsEnabled = enabledModels.has("*");
  // 两个 adapter 各自在写入请求日志时按上限裁剪；这里在启动时补扫一次，
  // 清掉上一次运行留下的超额日志文件。
  if (config.requestLogging === true) {
    pruneLogDir(
      config.logDir || path.join(path.dirname(config.catalogPath), "logs"),
      Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    );
  }

  const handleCore = async (request: Request): Promise<Response> => {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/zai" || incomingUrl.pathname.startsWith("/zai/")) {
      return zcodeError(404, "旧 /zai 入口已移除，请使用 Codex /v1/responses");
    }

    if (incomingUrl.pathname === "/healthz") {
      return Response.json({ ok: true, port: config.port, zcode: zcodeOn, codebuddy: codebuddyOn, cline: clineOn, qodercn: qodercnOn });
    }

    // Web UI 在独立端口（本端口 + 1）上运行：模型端口不服务 /ui，也绝不把 /ui 转发上游。
    if (incomingUrl.pathname === "/ui" || incomingUrl.pathname.startsWith("/ui/")) {
      return Response.json({
        error: {
          message: "Web UI runs on its own port, separate from the model gateway",
          hint: `Open http://127.0.0.1:${webUiPort(config)}/ui (or run: local-aiproxy web)`,
        },
      }, { status: 404 });
    }

    // 白名单边界：mountPath 子树外的任何路径——浏览器对端口的探测、爬虫、误配置客户端——
    // 一律本地 404，绝不拼进上游 URL。
    if (!isUnderMountPath(incomingUrl.pathname, mountPath)) {
      return Response.json({
        error: {
          message: `Not found: ${incomingUrl.pathname} is outside the API mount ${mountPath}`,
          hint: `Point the client base URL at http://<host>:${config.port}${mountPath}`,
        },
      }, { status: 404 });
    }

    if (incomingUrl.pathname === `${mountPath}/models` && request.method === "GET") {
      return catalogModelsResponse(request, handleZcode, handleCodebuddy, handleCline, handleQodercn, zcodeOn, codebuddyOn, clineOn, qodercnOn, enabledModels, allModelsEnabled);
    }

    const responsePath = incomingUrl.pathname === `${mountPath}/responses`;
    const compactPath = incomingUrl.pathname === `${mountPath}/responses/compact`;
    const hintedModel = modelFromRoutingHint(request);
    // 两个本地 adapter 都只走 HTTP/SSE，Responses WebSocket 升级一律本地 426。
    if (isZcodeResponsesWebSocket(request, config)) return websocketNotSupportedResponse("zcode-http-only");
    if (isCodebuddyResponsesWebSocket(request, config)) return websocketNotSupportedResponse("codebuddy-http-only");

    if ((zcodeOn || codebuddyOn || clineOn || qodercnOn) && (responsePath || compactPath) && request.method === "POST") {
      let json: Record<string, unknown> | undefined;
      try {
        json = decodeJsonBody(await readBodyBytes(request), request.headers);
      } catch (error) {
        const message = error instanceof Error ? error.message : "无效请求正文";
        if (isZcodeModel(hintedModel)) return zcodeError(400, message);
        if (isCodebuddyModel(hintedModel)) return codebuddyError(400, message);
      }
      const model = typeof json?.model === "string" ? normalizeGatewayModel(json.model) : hintedModel;
      // 白名单外的模型：目录不展示，转发一律本地 404。
      if (typeof model === "string" && !allModelsEnabled && !enabledModels.has(model.toLowerCase())) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "model_not_found", message: `Model ${model} is not enabled in gateway config.json.` } },
          { status: 404 },
        );
      }
      if (zcodeOn && isZcodeModel(model)) {
        if (!json) return zcodeError(400, "ZCode Responses 请求必须是 JSON 对象");
        const input: Record<string, unknown> = { ...json, model };
        if (compactPath || hasCompactionTrigger(input.input)) {
          return handleZcode.forward(request, buildCompactionRequest(input, String(model)), (payload) => {
            if (payload.status !== "completed") return compactionError("ZCode 上游未完成上下文压缩");
            const summary = responseText(payload);
            if (!summary) return compactionError("ZCode 上游没有返回压缩摘要");
            return compactPath ? Response.json({ output: compactV1Output(input.input, summary) })
              : syntheticCompactionResponse(payload, String(model), summary, input.stream === true);
          });
        }
        input.input = rewriteCompactionHistory(input.input);
        return handleZcode.forward(request, input);
      }
      if (codebuddyOn && isCodebuddyModel(model)) {
        if (!json) return codebuddyError(400, "CodeBuddy Responses 请求必须是 JSON 对象");
        const input: Record<string, unknown> = { ...json, model };
        if (compactPath || hasCompactionTrigger(input.input)) {
          return handleCodebuddy.forward(request, buildCompactionRequest(input, String(model)), (payload) => {
            if (payload.status !== "completed") return compactionError("CodeBuddy 上游未完成上下文压缩");
            const summary = responseText(payload);
            if (!summary) return compactionError("CodeBuddy 上游没有返回压缩摘要");
            return compactPath ? Response.json({ output: compactV1Output(input.input, summary) })
              : syntheticCompactionResponse(payload, String(model), summary, input.stream === true);
          });
        }
        input.input = rewriteCompactionHistory(input.input);
        return handleCodebuddy.forward(request, input);
      }
      if (clineOn && isClineModel(model)) {
        if (!json) return clineError(400, "Cline Responses 请求必须是 JSON 对象");
        const input: Record<string, unknown> = { ...json, model };
        if (compactPath || hasCompactionTrigger(input.input)) {
          return handleCline.forward(request, buildCompactionRequest(input, String(model)), (payload) => {
            if (payload.status !== "completed") return compactionError("Cline 上游未完成上下文压缩");
            const summary = responseText(payload);
            if (!summary) return compactionError("Cline 上游没有返回压缩摘要");
            return compactPath ? Response.json({ output: compactV1Output(input.input, summary) })
              : syntheticCompactionResponse(payload, String(model), summary, input.stream === true);
          });
        }
        input.input = rewriteCompactionHistory(input.input);
        return handleCline.forward(request, input);
      }
      if (qodercnOn && isQodercnModel(model)) {
        if (!json) return qodercnError(400, "QoderCN Responses 请求必须是 JSON 对象");
        const input: Record<string, unknown> = { ...json, model };
        if (compactPath || hasCompactionTrigger(input.input)) {
          return handleQodercn.forward(request, buildCompactionRequest(input, String(model)), (payload) => {
            if (payload.status !== "completed") return compactionError("QoderCN 上游未完成上下文压缩");
            const summary = responseText(payload);
            if (!summary) return compactionError("QoderCN 上游没有返回压缩摘要");
            return compactPath ? Response.json({ output: compactV1Output(input.input, summary) })
              : syntheticCompactionResponse(payload, String(model), summary, input.stream === true);
          });
        }
        input.input = rewriteCompactionHistory(input.input);
        return handleQodercn.forward(request, input);
      }
      return modelNotFoundResponse(model);
    }

    // 其余 Upgrade 请求（Realtime 等）没有本地实现，一律 426 让客户端改用 HTTP/SSE。
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return websocketNotSupportedResponse();
    }

    return modelNotFoundResponse(hintedModel ?? await bodyModel(request));
  };

  return Object.assign(handleCore, { close: () => { handleZcode.close(); handleCodebuddy.close(); handleCline.close(); handleQodercn.close(); } });
}

/**
 * 启动模型网关：只绑定 config.host/port，只服务本机 ZCode 与 CodeBuddy/WorkBuddy 两个 adapter。
 */
export function startGateway(
  config: GatewayConfig,
  zcodeDependencies?: ZcodeDependencies,
  processLog?: ProcessLogTarget,
  codebuddyDependencies?: CodebuddyDependencies,
  clineDependencies?: ClineDependencies,
  qodercnDependencies?: QodercnDependencies,
): Bun.Server<undefined> {
  if (typeof Bun === "undefined") {
    throw new Error("The gateway server must run with Bun");
  }
  validateZcodeConfig(config);
  validateCodebuddyConfig(config);
  validateClineConfig(config);
  validateQodercnConfig(config);
  const handler = createGatewayHandler(config, zcodeDependencies, processLog, codebuddyDependencies, clineDependencies, qodercnDependencies);
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 255,
      fetch: (request) => handler(request),
    });
  } catch (error) {
    handler.close();
    throw error;
  }
  const stop = server.stop.bind(server);
  server.stop = (closeActiveConnections) => {
    handler.close();
    return stop(closeActiveConnections);
  };
  console.log([
    `--${new Date().toISOString()}--`,
    `local-aiproxy gateway listening on ${server.url}`,
    `zcode -> ${zcodeEnabled(config) ? "enabled" : "disabled"}`,
    `codebuddy -> ${codebuddyEnabled(config) ? "enabled" : "disabled"}`,
    `cline -> ${clineEnabled(config) ? "enabled" : "disabled"}`,
    `qodercn -> ${qodercnEnabled(config) ? "enabled" : "disabled"}`,
  ].join("\n"));
  return server;
}

