import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { controlGateway, ensureGatewayInstalled, uninstall } from "../src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import type { GatewayInstallDeps, GatewayUninstallDeps } from "../src/cli.ts";

/**
 * start/restart/uninstall 是 launchd 的入口，这里全部走依赖注入：
 * 真实 `installLaunchAgent` / `restartLaunchAgent` 一次都不调用，
 * 否则单测会真的去 bootstrap 服务。
 * 服务管理本身仍限 macOS，所以这些用例只在 darwin 上跑。
 */

interface Calls {
  install: number;
  start: number;
  restart: number;
  stop: number;
  wait: number;
  removedAgents: string[];
}

interface Fixture {
  home: string;
  paths: ReturnType<typeof resolvePaths>;
  calls: Calls;
  installDeps: GatewayInstallDeps;
  uninstallDeps: GatewayUninstallDeps;
}

const darwin = { skip: process.platform !== "darwin" };

async function fixture(run: (context: Fixture) => Promise<void> | void): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-start-init-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousApiKey = process.env.API_KEY;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  const calls: Calls = { install: 0, start: 0, restart: 0, stop: 0, wait: 0, removedAgents: [] };
  try {
    await run({
      home, paths, calls,
      installDeps: {
        installLaunchAgent: (options) => {
          calls.install += 1;
          fs.mkdirSync(path.dirname(options.plistPath), { recursive: true });
          fs.writeFileSync(options.plistPath, "plist\n");
        },
        startLaunchAgent: () => { calls.start += 1; },
        restartLaunchAgent: () => { calls.restart += 1; },
        stopLaunchAgent: () => { calls.stop += 1; },
        waitForHealth: async () => { calls.wait += 1; },
      },
      uninstallDeps: {
        uninstallLaunchAgent: (plistPath) => { calls.removedAgents.push(plistPath); },
      },
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function state(paths: ReturnType<typeof resolvePaths>): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as Record<string, unknown>;
}

test("首次 start 用默认值创建 config.json、注册 launchd 并写入 state.json", darwin, async () => {
  await fixture(async ({ paths, installDeps }) => {
    assert.equal(fs.existsSync(paths.gatewayConfig), false);

    const config = await ensureGatewayInstalled(paths, installDeps);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8320);
    assert.equal(config.mountPath, "/v1");

    // config.json 已落盘且带 schema 与目录路径。
    const written = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(written.$schema, GATEWAY_CONFIG_SCHEMA_URL);
    assert.equal(written.catalogPath, paths.catalogFile);

    // launchd 已注册、state.json 已写，且不再包含旧版本的备份字段。
    assert.equal(fs.existsSync(paths.launchAgent), true);
    const saved = state(paths);
    assert.equal(saved.version, 4);
    assert.equal(typeof saved.installedAt, "string");
    assert.equal(saved.configBackup, undefined);
    assert.equal(saved.installedConfigHash, undefined);
    assert.equal(saved.gatewayBaseUrl, undefined);
    assert.equal((saved.config as { port: number }).port, 8320);
  });
});

test("restart 在未初始化时也能自举：建配置、注册服务并重启", darwin, async () => {
  await fixture(async ({ paths, calls, installDeps }) => {
    await controlGateway("restart", installDeps);
    assert.equal(calls.install, 1, "首次 restart 必须注册 launchd");
    assert.equal(calls.restart, 1, "随后重启已注册的服务");
    assert.equal(calls.wait, 1);
    assert.equal(fs.existsSync(paths.gatewayConfig), true);
    assert.equal(fs.existsSync(paths.stateFile), true);
  });
});

test("已初始化时 start 不重复注册，并保留 state 里的既有字段", darwin, async () => {
  await fixture(async ({ paths, calls, installDeps }) => {
    fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
    fs.writeFileSync(paths.launchAgent, "existing plist\n");
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.stateFile, JSON.stringify({
      version: 4,
      installedAt: "2026-01-01T00:00:00.000Z",
      // 旧版本遗留的未知字段：合并写必须原样带过，不做清理也不做解释。
      legacyUnknownField: "keep-me",
      config: { host: "127.0.0.1", port: 8320, mountPath: "/v1" },
    }));

    await controlGateway("start", installDeps);
    assert.equal(calls.install, 0, "plist 已存在时不得重复注册");
    assert.equal(calls.start, 1);
    assert.equal(calls.wait, 1);

    const saved = state(paths);
    assert.equal(saved.installedAt, "2026-01-01T00:00:00.000Z", "首次安装时间必须保留");
    assert.equal(saved.legacyUnknownField, "keep-me", "未知字段不得被清理");
  });
});

test("start/restart 不改动 ~/.codex/config.toml", darwin, async () => {
  await fixture(async ({ paths, calls, installDeps }) => {
    fs.mkdirSync(paths.codexHome, { recursive: true });
    const userToml = 'model = "gpt-native"\nmodel_provider = "openai"\n';
    fs.writeFileSync(paths.configToml, userToml);

    await controlGateway("start", installDeps);
    await controlGateway("restart", installDeps);
    await controlGateway("stop", installDeps);

    assert.equal(fs.readFileSync(paths.configToml, "utf8"), userToml, "config.toml 必须逐字节未变");
    assert.ok(calls.install + calls.restart > 0, "确实执行了服务操作，不是提前返回");
  });
});

test("uninstall 对任何 state 都不碰 ~/.codex", darwin, async () => {
  // 即使 state.json 里带着旧版本留下的备份字段，uninstall 也不再恢复 config.toml：
  // 网关对 ~/.codex 是绝对零写入。
  await fixture(async ({ paths, calls, uninstallDeps }) => {
    fs.mkdirSync(paths.codexHome, { recursive: true });
    const userToml = 'openai_base_url = "https://user.example/v1"\nmodel = "gpt-native"\n';
    fs.writeFileSync(paths.configToml, userToml);
    const backupFile = `${paths.configToml}.bak-legacy`;
    fs.writeFileSync(backupFile, 'openai_base_url = "https://old.example/v1"\n');

    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.stateFile, JSON.stringify({
      version: 4,
      installedAt: "2026-01-01T00:00:00.000Z",
      configBackup: { existed: true, backup: backupFile },
      installedConfigHash: createHashOf(userToml),
      config: { host: "127.0.0.1", port: 8320, mountPath: "/v1" },
    }));

    await uninstall(uninstallDeps);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), userToml, "uninstall 不得改写 config.toml");
    assert.equal(fs.existsSync(backupFile), true, "第三方备份文件也不是本工具的东西，不得删除");
    assert.equal(fs.existsSync(paths.stateFile), false, "卸载后 state.json 应被清理");
    assert.deepEqual(calls.removedAgents.length, 2, "网关与 Web UI 两个 LaunchAgent 都要回收");
  });
});

/** 与 src/cli.ts 的 hash() 一致的 sha256 十六进制摘要。 */
function createHashOf(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
