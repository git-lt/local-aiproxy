import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

test("误改的 codex-restart 参数不再作为别名接受", async () => {
  await assert.rejects(runCli(["models", "--codex-restart"]), /--codex-restart requires a value/);
  for (const command of ["uninstall", "restart", "models"]) {
    await assert.rejects(runCli([command, "--codex-restart", "true"]), /Unknown option --codex-restart/);
  }
});

test("--restart-codex 已移除，任何命令都不再接受它", async () => {
  for (const command of ["uninstall", "restart", "models"]) {
    await assert.rejects(
      runCli([command, "--restart-codex", "true"]),
      /Unknown option --restart-codex/,
    );
  }
});

test("--upstream-only 已随第三方上游移除，不再被接受", async () => {
  await assert.rejects(runCli(["models", "--upstream-only"]), /--upstream-only requires a value/);
});

test("unknown options are rejected instead of silently ignored", async () => {
  await assert.rejects(runCli(["models", "--log", "on"]), /Unknown option --log for command "models"/);
  await assert.rejects(runCli(["models", "--websocket", "on"]), /Unknown option --websocket for command "models"/);
  await assert.rejects(runCli(["config", "--logg", "on"]), /Unknown option --logg for command "config"/);
  await assert.rejects(runCli(["config", "--upstream-only"]), /--upstream-only requires a value/);
  // 隔离 HOME 确认 config 命令止步于未安装错误，而非参数报错。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-command-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    await assert.rejects(runCli(["config", "--log", "on"]), /Gateway is not installed/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config writes every requested update while a query stays read-only", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-always-reload-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  console.log = () => {};
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
    requestLogging: true,
    maxRequestLogs: 0,
    upstreamOnly: false,
    logDir: paths.logDir,
  }));

  try {
    const beforeUpdate = fs.statSync(paths.gatewayConfig).ino;
    await runCli(["config", "--log", "on"]);
    const afterUpdate = fs.statSync(paths.gatewayConfig).ino;
    assert.notEqual(afterUpdate, beforeUpdate, "matching config updates must still rewrite the config");

    await runCli(["config"]);
    assert.equal(
      fs.statSync(paths.gatewayConfig).ino,
      afterUpdate,
      "a config query must not rewrite the config",
    );
  } finally {
    console.log = previousLog;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config invalidates the Codex models cache only for catalog-affecting options", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-invalidate-cache-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
    requestLogging: false,
    maxRequestLogs: 0,
    upstreamOnly: false,
    logDir: paths.logDir,
  }));
  const originalLog = console.log;
  console.log = () => {};

  try {
    // 网关不写 Codex 的任何文件：纯日志选项与目录相关选项都不得产生 models_cache.json。
    const modelsCacheFile = path.join(paths.codexHome, "models_cache.json");
    await runCli(["config", "--log", "on", "--max-log-size", "1MB"]);
    assert.equal(fs.existsSync(modelsCacheFile), false, "纯日志选项不得写 Codex 的 models_cache.json");

    await runCli(["config", "--codebuddy-region", "cn"]);
    assert.equal(fs.existsSync(modelsCacheFile), false, "目录相关选项也不得写 Codex 的 models_cache.json");
  } finally {
    console.log = originalLog;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("websocket、select 与 sync 选项已随第三方上游移除", async () => {
  await assert.rejects(runCli(["models", "--sync", "--websocket"]), /--sync requires a value/);
  await assert.rejects(runCli(["models", "--websocket", "on"]), /Unknown option --websocket for command "models"/);
  await assert.rejects(runCli(["models", "--select", "1"]), /Unknown option --select for command "models"/);
});
