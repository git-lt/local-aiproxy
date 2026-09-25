/**
 * QoderCN 远端 SSE → 标准 OpenAI chat SSE。
 *
 * 远端每一帧都是一层外壳：`data:{"body":"<内层 JSON 字符串>","statusCodeValue":200}`，
 * 内层才是标准 `chat.completion.chunk`（末帧是字符串 `[DONE]`，之后还有一条与本 portfolio
 * 无关的 `event:finish`）。这里把外壳剥掉并把内层原样重发，让响应层只面对一种格式：
 * 工具调用增量、usage、finish_reason 因此全部沿用现有的 OpenAI 解析路径。
 */

type Json = Record<string, unknown>;

const MAX_ERROR_TEXT = 500;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(value: unknown, status: number): Json {
  if (typeof value === "string" && value.trim()) return { code: "upstream_error", message: value.trim() };
  if (isRecord(value)) {
    const message = typeof value.message === "string" ? value.message
      : typeof value.msg === "string" ? value.msg
      : undefined;
    if (message) {
      return { code: typeof value.code === "string" ? value.code : "upstream_error", message };
    }
    return { code: "upstream_error", message: JSON.stringify(value).slice(0, MAX_ERROR_TEXT) };
  }
  return { code: "upstream_error", message: `QoderCN 上游返回 HTTP ${status}` };
}

/**
 * 剥一层外壳：返回要向上游响应层转发的 `data:` 载荷，返回 undefined 表示这一帧丢弃。
 * `[DONE]` 按约定继续外传，由响应层收尾。
 */
export function unwrapQodercnFrame(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload) return undefined;
  if (payload === "[DONE]") return "[DONE]";
  let outer: unknown;
  try {
    outer = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(outer)) return undefined;
  const status = Number(outer.statusCodeValue);
  if (outer.error !== undefined) {
    return JSON.stringify({ error: normalizeError(outer.error, Number.isFinite(status) ? status : 200) });
  }
  const body = typeof outer.body === "string" ? outer.body : "";
  if (!body) return undefined;
  if (body === "[DONE]") return "[DONE]";
  if (Number.isFinite(status) && status >= 400) {
    return JSON.stringify({ error: { code: "upstream_error", message: body.slice(0, MAX_ERROR_TEXT) } });
  }
  let inner: unknown;
  try {
    inner = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(inner)) return undefined;
  // 内层是 chat.completion.chunk：有增量、usage 或错误才值得继续外传；
  // 其余（心跳、非聊天事件）丢弃，避免污染解析。
  if (Array.isArray(inner.choices) || inner.usage !== undefined || inner.error !== undefined) {
    return JSON.stringify(inner);
  }
  return undefined;
}

/** 把远端 SSE 流改写为标准 OpenAI SSE 流；遇到 `[DONE]` 立即收尾并断开读取。 */
function rewriteStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const close = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    finished = true;
    controller.close();
    reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const { done, value } = await reader.read();
      if (done) {
        const tail = unwrapQodercnFrame(buffer);
        if (tail) controller.enqueue(encoder.encode(`data: ${tail}\n\n`));
        close(controller);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = unwrapQodercnFrame(line);
        if (payload === undefined) continue;
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        if (payload === "[DONE]") {
          close(controller);
          return;
        }
      }
    },
    cancel(reason) {
      finished = true;
      void reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/**
 * 把远端响应换成标准 OpenAI SSE 响应，供 `createCodebuddyResponse` 消费。
 * 非 SSE 响应（例如上游直接返回 JSON 错误）原样返回，由响应层按 JSON 分支处理。
 */
export function rewriteQodercnSse(upstream: Response): Response {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.body || !contentType.includes("text/event-stream")) return upstream;
  return new Response(rewriteStream(upstream.body), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}
