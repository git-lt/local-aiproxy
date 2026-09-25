import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler } from "../src/gateway.ts";
import {
  clineCredentialsPresent,
  defaultClineApiKeyFile,
  readClineApiKey,
} from "../src/cline/credentials.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;

const API_KEY = "cline-api-key-for-test";

function chatUpstream(text = "测试答案"): Response {
  const frames: Json[] = [
    { id: "chatcmpl-fx", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl-fx", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

test("cline 凭据文件缺失、为空、多行都报带指引的错误，正常单行可读", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cline-cred-"));
  try {
    const file = path.join(directory, "cline-api-key");
    assert.equal(clineCredentialsPresent(file), false);
    assert.throws(() => readClineApiKey(file), /文件不存在/);
    fs.writeFileSync(file, "\n");
    assert.throws(() => readClineApiKey(file), /为空/);
    fs.writeFileSync(file, "a\nb\n");
    assert.throws(() => readClineApiKey(file), /单行/);
    fs.writeFileSync(file, `${API_KEY}\n`);
    assert.equal(readClineApiKey(file), API_KEY);
    assert.equal(clineCredentialsPresent(file), true);
    assert.equal(defaultClineApiKeyFile("/home/x/.local-aiproxy/catalog.json"), "/home/x/.local-aiproxy/cline-api-key");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cline 路由：local-proxy 前缀剥离、上游收到裸模型 ID 与 Bearer key，日志不落 key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cline-gw-"));
  try {
    const apiKeyFile = path.join(directory, "cline-api-key");
    fs.writeFileSync(apiKeyFile, `${API_KEY}\n`, { mode: 0o600 });
    const config: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", zcode: false, codebuddy: false, cline: true, enabledModels: ["*"],
      catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
      requestLogging: true,
    };
    const originalFetch = globalThis.fetch;
    const chatCalls: { url: string; headers: Headers; body: Json }[] = [];
    let modelsCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/ai/cline/models")) {
        modelsCalls += 1;
        return Response.json({ data: [
          { id: "z-ai/glm-5.3-prime:free", name: "GLM 5.3 Prime (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" } },
          { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (free)", pricing: { prompt: "0", completion: "0" } },
          { id: "openai/gpt-paid", name: "GPT Paid", pricing: { prompt: "1", completion: "2" } },
          { id: "openai/gpt-nopricing", name: "GPT No Pricing" },
        ] });
      }
      if (url.endsWith("/chat/completions")) {
        chatCalls.push({ url, headers, body: JSON.parse(String(init?.body)) });
        return chatUpstream();
      }
      throw new Error(`测试未模拟的请求: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const handler = createGatewayHandler(config, undefined, undefined, undefined, {
        apiKeyFile,
        // 隔离真实 ~/.cline 登录态：本用例只测 API Key 模式。
        providersFile: path.join(directory, "no-providers.json"),
      });
      // 目录：只保留免费条目（:free 后缀或 pricing 全 0）并加 cline/ 前缀。
      const models = await (await handler(new Request("http://127.0.0.1:8320/v1/models"))).json() as Json;
      assert.deepEqual(models.data.map((m: Json) => m.id), ["cline/z-ai/glm-5.3-prime:free", "cline/deepseek/deepseek-v4-flash"]);
      // opencodex 原样转发 local-proxy/ 前缀的 slug 也能路由。
      const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-inbound" },
        body: JSON.stringify({ model: "local-proxy/cline/z-ai/glm-5.3-prime:free", input: "你好", stream: false }),
      }));
      assert.equal(response.status, 200);
      const result = await response.json() as Json;
      assert.equal(result.status, "completed");
      assert.equal(chatCalls.length, 1);
      assert.equal(chatCalls[0]!.url, "https://api.cline.bot/api/v1/chat/completions");
      assert.equal(chatCalls[0]!.headers.get("authorization"), `Bearer ${API_KEY}`);
      assert.equal(chatCalls[0]!.body.model, "z-ai/glm-5.3-prime:free", "上游收到剥离 cline/ 前缀后的裸 ID");
      // 请求日志必须脱敏 key。
      await new Promise((done) => setTimeout(done, 120));
      const logs = fs.readdirSync(config.logDir!).map((name) => fs.readFileSync(path.join(config.logDir!, name), "utf8")).join("\n");
      assert.ok(!logs.includes(API_KEY), "请求日志不得包含 API Key 明文");
      // 凭据文件缺失 → 503 configuration_error。
      fs.rmSync(apiKeyFile);
      const missing = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cline/z-ai/glm-5.3-prime:free", input: "hi", stream: false }),
      }));
      assert.equal(missing.status, 503);
      const payload = await missing.json() as Json;
      assert.equal(payload.error.type, "configuration_error");
      assert.match(payload.error.message, /app\.cline\.bot/);
      handler.close();
      assert.ok(modelsCalls >= 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cline-free 免费档：OAuth 过期自动刷新写回，转发携带客户端身份头", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cline-free-"));
  try {
    const providersFile = path.join(directory, "providers.json");
    const makeJwt = (expSeconds: number): string => {
      const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${b64({ alg: "none" })}.${b64({ exp: expSeconds })}.sig`;
    };
    const expired = Math.floor(Date.now() / 1000) - 100;
    fs.writeFileSync(providersFile, JSON.stringify({
      providers: { cline: { settings: { provider: "cline", auth: {
        accessToken: makeJwt(expired), refreshToken: "rt-old", expiresAt: expired * 1000,
      } } } },
    }));
    const config: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", zcode: false, codebuddy: false, cline: true, enabledModels: ["*"],
      catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
    };
    const originalFetch = globalThis.fetch;
    const chatCalls: { url: string; headers: Headers; body: Json }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        const now = Math.floor(Date.now() / 1000);
        return Response.json({ success: true, data: {
          accessToken: makeJwt(now + 3600), refreshToken: "rt-new", expiresAt: (now + 3600) * 1000,
        } });
      }
      if (url.endsWith("/ai/cline/models")) return Response.json({ data: [] });
      if (url.endsWith("/chat/completions")) {
        chatCalls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return chatUpstream();
      }
      throw new Error(`测试未模拟的请求: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const handler = createGatewayHandler(config, undefined, undefined, undefined, { providersFile, apiKeyFile: path.join(directory, "k") });
      // 目录包含 cline-free 三件套（本地 OAuth 登录态存在）。
      const models = await (await handler(new Request("http://127.0.0.1:8320/v1/models"))).json() as Json;
      const ids = models.data.map((m: Json) => m.id);
      assert.ok(ids.includes("cline-free/deepseek-v4.1-flash"), "cline-free 模型必须出现在目录");
      // 转发：过期令牌自动刷新 + 客户端身份头 + 上游裸 ID。
      const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cline-free/mimo-v2.6-flash", input: "你好", stream: false }),
      }));
      assert.equal(response.status, 200);
      assert.equal(chatCalls.length, 1);
      assert.equal(chatCalls[0]!.body.model, "cline-free/mimo-v2.6-flash");
      assert.match(chatCalls[0]!.headers.get("authorization") ?? "", /^Bearer ey/);
      assert.equal(chatCalls[0]!.headers.get("x-client-type"), "cline-cli");
      assert.equal(chatCalls[0]!.headers.get("x-platform"), "cli");
      // 新令牌对已写回 providers.json（轮换式 refreshToken，不写回会弄丢 CLI 登录态）。
      const updated = JSON.parse(fs.readFileSync(providersFile, "utf8")) as { providers: { cline: { settings: { auth: { refreshToken: string } } } } };
      assert.equal(updated.providers.cline.settings.auth.refreshToken, "rt-new");
      handler.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cline 404 文案与 cline 关闭时的行为", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cline-off-"));
  try {
    const config: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", zcode: false, codebuddy: false, cline: false,
      catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
    };
    const handler = createGatewayHandler(config, undefined, undefined, undefined, { apiKeyFile: path.join(directory, "k") });
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cline/z-ai/glm-5.3-prime", input: "hi" }),
    }));
    assert.equal(response.status, 404);
    const payload = await response.json() as Json;
    assert.match(payload.error.message, /cline integration to be enabled/);
    handler.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
