import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler } from "../src/gateway.ts";
import {
  QodercnCredentialError,
  qodercnCredentialsPresent,
  readQodercnCredential,
} from "../src/qodercn/credentials.ts";
import { buildQodercnCatalog } from "../src/qodercn/catalog.ts";
import { buildQodercnChatPayload, normalizeQodercnPath, signQodercnHeaders } from "../src/qodercn/request.ts";
import { unwrapQodercnFrame } from "../src/qodercn/response.ts";
import { validateQodercnConfig } from "../src/qodercn/index.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;

const MACHINE_ID = "9f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8";
const COSY_KEY = "cosy-key-for-test";

/** 造一份与本机客户端同构的加密登录缓存：AES-128-CBC，key=IV=machine id 前 16 字节。 */
function encryptCache(payload: Json, machineId = MACHINE_ID): string {
  const key = Buffer.from(machineId.slice(0, 16), "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64");
}

function writeLoginHome(payload: Json = {
  key: COSY_KEY,
  encrypt_user_info: "user-info-for-test",
  uid: "123456",
  expire_time: 1792304981,
}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-home-"));
  fs.mkdirSync(path.join(home, ".qoder-cn", ".auth"), { recursive: true });
  fs.writeFileSync(path.join(home, ".qoder-cn", ".auth", "machine_id"), MACHINE_ID);
  fs.writeFileSync(path.join(home, ".qoder-cn", ".auth", "user"), encryptCache(payload));
  return home;
}

test("QoderCN 登录缓存：正常读取；缓存缺失或不含密钥时报带指引的错误", () => {
  const home = writeLoginHome();
  try {
    assert.equal(qodercnCredentialsPresent(home), true);
    const credential = readQodercnCredential(home);
    assert.equal(credential.cosyKey, COSY_KEY);
    assert.equal(credential.userId, "123456");
    assert.equal(credential.machineId, MACHINE_ID);
    assert.equal(credential.tokenExpireMs, 1792304981 * 1000);
    assert.match(credential.source, /\.qoder-cn\/\.auth\/user$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-empty-"));
  try {
    assert.equal(qodercnCredentialsPresent(empty), false);
    assert.throws(() => readQodercnCredential(empty), QodercnCredentialError);
    assert.throws(() => readQodercnCredential(empty), /未找到可用的 QoderCN\/通义灵码登录缓存/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // 缓存存在但少了 key 字段：必须报错，而不是把空密钥拿去签名。
  const partial = writeLoginHome({ uid: "123456" });
  try {
    assert.throws(() => readQodercnCredential(partial), /签名密钥/);
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
});

test("QoderCN 目录：合并全部分组、去重并加上 qodercn/ 前缀", () => {
  const catalog = buildQodercnCatalog({
    chat: [{ key: "auto", display_name: "Auto", max_input_tokens: 262144 }],
    inline: [{ key: "qmodel", display_name: "Qwen3-Max" }, { key: "auto" }],
    extras: "ignored",
  });
  assert.deepEqual(catalog.models.map((model) => model.slug), ["qodercn/auto", "qodercn/qmodel"]);
  assert.equal(catalog.models[0]!.display_name, "Auto");
  assert.equal(catalog.models[0]!.context_window, 262144);
  assert.equal(catalog.models[1]!.context_window, undefined);
  assert.deepEqual(buildQodercnCatalog(null).models, []);
});

test("QoderCN 签名：preimage 用 /algo 归一后的路径，且不含密钥以外的变量", () => {
  const credential = {
    cosyKey: COSY_KEY, encryptUserInfo: "info", userId: "u1", machineId: MACHINE_ID, source: "auth",
  };
  const body = JSON.stringify({ hello: "world" });
  const headers = signQodercnHeaders(credential, {
    path: "/algo/api/v2/service/pro/sse/agent_chat_generation",
    body,
    nowMs: 1_700_000_000_000,
  });
  const authorization = headers.get("authorization") ?? "";
  const matched = /^Bearer COSY\.([^.]+)\.([0-9a-f]{32})$/.exec(authorization);
  assert.ok(matched, `unexpected authorization header: ${authorization}`);
  const [, payload, signature] = matched!;
  const expected = createHash("md5").update([
    payload,
    COSY_KEY,
    "1700000000",
    body,
    normalizeQodercnPath("/algo/api/v2/service/pro/sse/agent_chat_generation"),
  ].join("\n")).digest("hex");
  assert.equal(signature, expected);
  assert.equal(headers.get("cosy-key"), COSY_KEY);
  assert.equal(headers.get("cosy-user"), "u1");
});

test("QoderCN 请求体：auto 转空 key、图片提升 is_vl、reasoning 意图落到 is_reasoning", () => {
  const auto: Json = buildQodercnChatPayload("req1", {
    upstreamModel: "auto",
    body: { messages: [{ role: "user", content: "你好" }] },
  });
  assert.equal(auto.model_config.key, "");
  assert.equal(auto.request_id, "req1");
  assert.equal(auto.image_urls, null);
  assert.equal(auto.model_config.is_vl, false);

  const vision: Json = buildQodercnChatPayload("req2", {
    upstreamModel: "qmodel",
    body: {
      messages: [{
        role: "user",
        content: [
          { type: "input_text", text: "描述这张图" },
          { type: "input_image", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      }],
      reasoning_effort: "high",
      temperature: 0.4,
    },
  });
  assert.equal(vision.model_config.key, "qmodel");
  assert.equal(vision.model_config.is_vl, true);
  assert.equal(vision.model_config.is_reasoning, true);
  assert.deepEqual(vision.image_urls, ["data:image/png;base64,AAA"]);
  assert.equal(vision.parameters.temperature, 0.4);
  const message = (vision.messages as Json[])[0]!;
  assert.equal(message.role, "user");
  assert.deepEqual(message.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
});

test("QoderCN SSE 拆包：外壳剥掉后是标准 OpenAI 帧，错误帧转 error", () => {
  const chunk = JSON.stringify({ choices: [{ delta: { content: "OK" } }], id: "chatcmpl-x" });
  assert.equal(unwrapQodercnFrame(`data:{"body":${JSON.stringify(chunk)},"statusCodeValue":200}`), chunk);
  assert.equal(unwrapQodercnFrame('data:{"body":"[DONE]","statusCodeValue":200}'), "[DONE]");
  assert.equal(unwrapQodercnFrame("data: [DONE]"), "[DONE]");
  // usage 帧没有 choices 增量，但必须保留给响应层计费。
  const usage = JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  assert.equal(unwrapQodercnFrame(`data:{"body":${JSON.stringify(usage)}}`), usage);
  const error = unwrapQodercnFrame('data:{"body":"quota exceeded","statusCodeValue":429}');
  assert.equal(JSON.parse(error!).error.code, "upstream_error");
  assert.match(error!, /quota exceeded/);
  // 非 data 行、坏 JSON、无 choices 的事件都丢弃，避免污染响应层。
  assert.equal(unwrapQodercnFrame("event:finish"), undefined);
  assert.equal(unwrapQodercnFrame("data:not-json"), undefined);
  assert.equal(unwrapQodercnFrame('data:{"body":"{\\"ping\\":true}"}'), undefined);
});

test("validateQodercnConfig：启用时只允许环回监听，字段类型错误要报错", () => {
  const base: GatewayConfig = { host: "127.0.0.1", port: 8320, mountPath: "/v1", catalogPath: "/tmp/catalog.json" };
  validateQodercnConfig({ ...base, qodercn: true });
  validateQodercnConfig({ ...base, qodercn: false, host: "0.0.0.0" });
  assert.throws(() => validateQodercnConfig({ ...base, qodercn: true, host: "0.0.0.0" }), /监听环回地址/);
  assert.throws(() => validateQodercnConfig({ ...base, qodercn: "yes" as unknown as boolean }), /必须为 boolean/);
});

/** 远端 SSE：外层壳 + 内层标准 chunk。 */
function qodercnUpstream(text = "OK"): Response {
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text } }], model: "auto" }),
    JSON.stringify({ choices: [{ index: 0, delta: {} }], finish_reason: "stop" }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
  ];
  const body = frames
    .map((frame) => `data:{"headers":{},"body":${JSON.stringify(frame)},"statusCodeValue":200}\n\n`)
    .join("") + 'data:{"body":"[DONE]","statusCodeValue":200}\n\nevent:finish\ndata:{"totalDuration":1}\n\n';
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("QoderCN 路由：Responses 请求签名后走远端 SSE，译回 Codex 事件流且日志不落凭据", async () => {
  const home = writeLoginHome();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-gw-"));
  const originalFetch = globalThis.fetch;
  const calls: { url: string; headers: Headers; body: Json }[] = [];
  let modelListCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/algo/api/v2/model/list")) {
      modelListCalls += 1;
      return Response.json({ chat: [{ key: "auto", display_name: "Auto" }], inline: [{ key: "qmodel" }] });
    }
    calls.push({ url, headers, body: JSON.parse(String(init?.body)) as Json });
    return qodercnUpstream();
  }) as typeof fetch;
  try {
    const config: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", zcode: false, codebuddy: false, cline: false, qodercn: true,
      catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
      requestLogging: true, enabledModels: ["*"],
    };
    const handler = createGatewayHandler(config, {}, undefined, {}, {}, { home, baseUrl: "https://qoder.test" });
    try {
      const models = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1"));
      assert.equal(models.status, 200);
      const listed = await models.json() as Json;
      assert.deepEqual(listed.models.map((model: Json) => model.slug), ["qodercn/auto", "qodercn/qmodel"]);
      assert.equal(modelListCalls, 1);

      const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qodercn/qmodel", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "只回复 OK" }] }] }),
      }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = await response.text();
      assert.match(text, /event: response\.output_text\.delta/);
      const completed = JSON.parse(/event: response\.completed\ndata: (.*)/.exec(text)?.[1] ?? "{}") as Json;
      assert.equal(completed.response.output[0].content[0].text, "OK");
      assert.deepEqual(completed.response.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });

      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.url, "https://qoder.test/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common");
      assert.equal(call.body.model_config.key, "qmodel");
      assert.match(call.headers.get("authorization") ?? "", /^Bearer COSY\./);
      assert.equal(call.headers.get("cosy-key"), COSY_KEY);

      // 请求日志可以留 Trace，但绝不能留下 cosy key / user info / machine id。
      const logs = fs.readdirSync(config.logDir!).map((name) => fs.readFileSync(path.join(config.logDir!, name), "utf8")).join("\n");
      assert.ok(logs.length > 0, "应写出请求日志");
      assert.ok(!logs.includes(COSY_KEY), "日志不得包含 cosy key");
      assert.ok(!logs.includes("user-info-for-test"), "日志不得包含 encrypt_user_info");
      assert.ok(!logs.includes(MACHINE_ID), "日志不得包含 machine id");
      assert.match(logs, /cosy-key: \*\*\*/);
    } finally {
      handler.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("QoderCN 路由：无凭据报 503 带指引，上游 401 提示重新登录", async () => {
  const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-nocred-"));
  const originalFetch = globalThis.fetch;
  let lastStatus = 200;
  globalThis.fetch = (async () => new Response("登录态失效", { status: lastStatus })) as unknown as typeof fetch;
  try {
    const config: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", qodercn: true,
      catalogPath: path.join(missingHome, "catalog.json"), enabledModels: ["*"],
    };
    const handler = createGatewayHandler(config, {}, undefined, {}, {}, { home: missingHome, baseUrl: "https://qoder.test" });
    try {
      const request = () => new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qodercn/qmodel", input: "你好" }),
      });
      const missing = await handler(request());
      assert.equal(missing.status, 503);
      assert.equal((await missing.json() as Json).error.type, "configuration_error");

      lastStatus = 401;
      const home = writeLoginHome();
      try {
        const handler2 = createGatewayHandler({ ...config, catalogPath: path.join(home, "catalog.json") }, {}, undefined, {}, {}, { home, baseUrl: "https://qoder.test" });
        try {
          const unauthorized = await handler2(request());
          assert.equal(unauthorized.status, 401);
          assert.match((await unauthorized.json() as Json).error.message, /重新登录/);
        } finally {
          handler2.close();
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    } finally {
      handler.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(missingHome, { recursive: true, force: true });
  }
});
