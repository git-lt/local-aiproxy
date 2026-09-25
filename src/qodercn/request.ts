import { createHash } from "node:crypto";
import type { QodercnCredential } from "./credentials.ts";

/**
 * QoderCN 远端请求：OpenAI chat 形状 → 远端 SSE 聊天负载，外加 COSY 签名。
 *
 * 远端始终以 SSE 流式返回（内层是标准 OpenAI chat.completion.chunk，见
 * response.ts 的拆包），因此本模块不处理 stream=false 的分支。
 */

export const QODERCN_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
export const QODERCN_CHAT_QUERY = "?FetchKeys=llm_model_result&AgentId=agent_common";
export const QODERCN_MODEL_LIST_PATH = "/algo/api/v2/model/list";
/** 客户端协议版本：远端按它区分 IDE 形态，取 lingma2api 探索出的稳定值。 */
export const COSY_VERSION = "2.11.2";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** 归一化签名路径：远端对 /algo 前缀与裸路径用同一套 preimage。 */
export function normalizeQodercnPath(path: string): string {
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

/**
 * COSY 鉴权头：`Bearer COSY.<payload>.<md5>`，
 * preimage = payloadB64 \n cosyKey \n date(秒) \n body \n path。
 * body 必须与最终发送的正文逐字节一致，所以签名发生在序列化之后。
 */
export function signQodercnHeaders(
  credential: QodercnCredential,
  options: { path: string; body: string; cosyVersion?: string; nowMs?: number },
): Headers {
  const cosyVersion = options.cosyVersion ?? COSY_VERSION;
  const date = String(Math.floor((options.nowMs ?? Date.now()) / 1000));
  const payload = Buffer.from(JSON.stringify({
    cosyVersion,
    ideVersion: "",
    info: credential.encryptUserInfo,
    requestId: crypto.randomUUID(),
    version: "v1",
  })).toString("base64");
  const preimage = [
    payload,
    credential.cosyKey,
    date,
    options.body,
    normalizeQodercnPath(options.path),
  ].join("\n");
  const signature = createHash("md5").update(preimage).digest("hex");
  return new Headers({
    authorization: `Bearer COSY.${payload}.${signature}`,
    "content-type": "application/json",
    appcode: "cosy",
    "cosy-date": date,
    "cosy-key": credential.cosyKey,
    "cosy-machineid": credential.machineId,
    "cosy-user": credential.userId,
    // 远端只把它当客户端元信息上报；沿用实测通过的不可路由占位地址。
    "cosy-clientip": "198.18.0.1",
    "cosy-clienttype": "2",
    "cosy-machineos": process.platform,
    "cosy-machinetoken": "",
    "cosy-machinetype": "",
    "cosy-version": cosyVersion,
    "login-version": "v2",
    "user-agent": "local-aiproxy/qodercn",
    accept: "text/event-stream",
    "cache-control": "no-cache",
  });
}

/** 收集消息里的图片 URL：同时用于 `image_urls` 与 `is_vl` 判定。 */
function collectImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectImageUrls(item));
  if (!isRecord(value)) return [];
  if (isRecord(value.image_url) && typeof value.image_url.url === "string") return [value.image_url.url];
  if (typeof value.image_url === "string") return [value.image_url];
  if ((value.type === "image_url" || value.type === "input_image") && typeof value.url === "string") return [value.url];
  return [];
}

function projectContent(value: unknown): unknown {
  if (!Array.isArray(value)) return typeof value === "string" ? value : String(value ?? "");
  const parts: Json[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item) parts.push({ type: "text", text: item });
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === "text" || item.type === "input_text") {
      if (typeof item.text === "string" && item.text) parts.push({ type: "text", text: item.text });
      continue;
    }
    // 图片 part 兼容 OpenAI 的 image_url 与 Responses 的 input_image 两种写法。
    const url = isRecord(item.image_url) ? item.image_url.url : typeof item.image_url === "string" ? item.image_url : undefined;
    if (typeof url === "string" && url) parts.push({ type: "image_url", image_url: { url } });
  }
  return parts.length > 0 ? parts : "";
}

function projectToolCalls(value: unknown): Json[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: Json[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) return;
    const name = isRecord(item.function) && typeof item.function.name === "string" ? item.function.name : "";
    if (!name) return;
    const args = isRecord(item.function) && item.function.arguments !== undefined
      ? item.function.arguments
      : "";
    calls.push({
      index,
      id: typeof item.id === "string" ? item.id : "",
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    });
  });
  return calls.length > 0 ? calls : undefined;
}

function projectTools(value: unknown): Json[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: Json[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    tools.push({
      type: "function",
      function: {
        name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

/** tool_choice：远端用 none/required/指定函数三种形态，auto 交给远端默认。 */
function projectToolChoice(value: unknown): unknown {
  if (value === "none" || value === "required") return value;
  if (isRecord(value) && isRecord(value.function) && typeof value.function.name === "string") {
    return { type: "function", function: { name: value.function.name } };
  }
  return undefined;
}

export function buildQodercnChatPayload(
  requestId: string,
  options: { body: Json; upstreamModel: string; nowMs?: number },
): Json {
  const { body, upstreamModel } = options;
  const messages: Json[] = [];
  const imageUrls: string[] = [];
  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      if (!isRecord(raw)) continue;
      const role = typeof raw.role === "string" ? raw.role : "";
      if (!role) continue;
      const content = projectContent(raw.content);
      const images = collectImageUrls(raw.content);
      const message: Json = {
        role,
        content,
        response_meta: { id: "", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        reasoning_content_signature: "",
      };
      if (typeof raw.name === "string" && raw.name) message.name = raw.name;
      if (typeof raw.tool_call_id === "string" && raw.tool_call_id) message.tool_call_id = raw.tool_call_id;
      const calls = projectToolCalls(raw.tool_calls);
      if (calls) message.tool_calls = calls;
      messages.push(message);
      if (images.length > 0) imageUrls.push(...images);
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const tools = projectTools(body.tools);
  const toolChoice = projectToolChoice(body.tool_choice);
  // auto 由服务端路由：远端要求该 key 传空字符串。
  const model = upstreamModel.trim().toLowerCase() === "auto" ? "" : upstreamModel.trim();
  const reasoningEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : "";
  const isReasoning = (reasoningEffort !== "" && reasoningEffort !== "none")
    || /thinking/i.test(upstreamModel);
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature)
    ? body.temperature
    : 0.1;

  return {
    request_id: requestId,
    request_set_id: "",
    chat_record_id: requestId,
    stream: true,
    image_urls: imageUrls.length > 0 ? imageUrls : null,
    is_reply: false,
    is_retry: false,
    session_id: "",
    code_language: "",
    source: 0,
    version: "3",
    chat_prompt: "",
    parameters: { temperature },
    aliyun_user_type: "personal_standard",
    agent_id: "agent_common",
    task_id: "question_refine",
    model_config: {
      key: model,
      display_name: "",
      model,
      format: "",
      is_vl: imageUrls.length > 0,
      is_reasoning: isReasoning,
      api_key: "",
      url: "",
      source: "",
      enable: false,
    },
    messages,
    business: {
      product: "jb_plugin",
      version: COSY_VERSION,
      type: "memory",
      id: crypto.randomUUID(),
      begin_at: options.nowMs ?? Date.now(),
      stage: "start",
      name: `memory_intent_recognition_${requestId}`,
    },
    ...(tools ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}
