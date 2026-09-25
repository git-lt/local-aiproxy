import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

function installedConfig(paths: ReturnType<typeof resolvePaths>) {
  return {
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    catalogPath: paths.catalogFile,
    requestLogging: false,
    maxRequestLogs: 0,
    maxGatewayLogBytes: 0,
    zcode: false,
    codebuddy: false,
    logDir: paths.logDir,
  };
}

test("config --zcode 写入状态和审计，且不需要 LaunchAgent", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  const config = installedConfig(paths);
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config)}\n`);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config })}\n`);
  const printed: string[] = [];
  console.log = (value?: unknown) => { printed.push(String(value)); };
  try {
    await runCli(["config", "--zcode", "on"]);
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).zcode, true);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).config.zcode, true);
    assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /zcode: false -> true/);
    assert.match(printed.join("\n"), /LaunchAgent is not installed/);

    await runCli(["config", "--zcode", "off", "--log", "on"]);
    const after = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(after.zcode, false);
    assert.equal(after.requestLogging, true);
    assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /zcode: true -> false/);

    printed.length = 0;
    const beforeQuery = fs.statSync(paths.gatewayConfig).ino;
    await runCli(["config"]);
    assert.equal(fs.statSync(paths.gatewayConfig).ino, beforeQuery, "config 查询不得重写配置");
    assert.match(printed.join("\n"), /"zcode": false/);
  } finally {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config --zcode 显式拒绝缺失、非法和位置参数", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-invalid-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    await assert.rejects(runCli(["config", "zcode"]), /Unexpected argument: zcode/);
    await assert.rejects(runCli(["config", "zcode", "on"]), /Unexpected argument: zcode/);
    await assert.rejects(runCli(["config", "--zcode", "maybe"]), /expects on or off/);
    await assert.rejects(runCli(["config", "--zcode"]), /--zcode requires on or off/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
