import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateRuntimeHome, resolvePaths } from "../src/paths.ts";

test("runtimeHome override scopes instance state and the LaunchAgent to the config directory", () => {
  const env = { HOME: "/home/tester" };
  const production = resolvePaths(env);
  assert.equal(production.runtimeHome, "/home/tester/.local-aiproxy");
  assert.equal(production.launchAgent, "/home/tester/Library/LaunchAgents/local-aiproxy.plist");

  // `serve --config <dir>/config.json` 的临时实例：管理面文件全部落在配置同目录；
  // LaunchAgent 使用 -temp 占位名——即使配置就放在 $HOME 下，也绝不与默认服务路径相同。
  const root = path.resolve("/tmp/ccp-instance");
  const instance = resolvePaths(env, root);
  assert.equal(instance.runtimeHome, root);
  assert.equal(instance.gatewayConfig, path.join(root, "config.json"));
  assert.equal(instance.stateFile, path.join(root, "state.json"));
  assert.equal(instance.uiTokenFile, path.join(root, "ui-token"));
  assert.equal(instance.stdoutLog, path.join(root, "gateway.log"));
  assert.equal(instance.logDir, path.join(root, "logs"));
  assert.equal(
    instance.launchAgent,
    path.join(root, "Library", "LaunchAgents", "local-aiproxy-temp.plist"),
  );
  // 复现 review 场景：--config $HOME/config.json 时 home 几何派生曾恰好命中默认服务。
  const homeInstance = resolvePaths(env, "/home/tester");
  assert.notEqual(homeInstance.launchAgent, production.launchAgent);
  // codexHome 仍按环境解析：实例隔离只针对网关自管的管理面文件。
  assert.equal(instance.codexHome, "/home/tester/.codex");
});

test("旧运行时目录迁移到新目录，旧目录改名保留；已迁移或新目录已存在时不覆盖", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-migrate-"));
  try {
    const paths = resolvePaths({ HOME: home });
    const legacy = path.join(home, ".codex-cliproxy-gateway");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), "{}");
    fs.mkdirSync(path.join(legacy, "logs"), { recursive: true });

    const migration = migrateRuntimeHome(paths);
    assert.ok(migration, "首次迁移应返回迁移结果");
    assert.equal(migration!.from, legacy);
    assert.equal(migration!.to, paths.runtimeHome);
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).toString(), "[object Object]");
    assert.ok(fs.existsSync(path.join(paths.runtimeHome, "logs")), "子目录也要搬过去");
    assert.ok(!fs.existsSync(legacy), "旧目录不再占用原名");
    assert.ok(fs.existsSync(migration!.backup), "旧目录必须以备份形式保留");

    // 已迁移过：新目录存在时绝不覆盖，也不重复备份。
    assert.equal(migrateRuntimeHome(paths), undefined);

    // 备份名冲突时用时间戳后缀，绝不覆盖既有备份。
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-migrate-"));
    try {
      fs.mkdirSync(path.join(second, ".codex-cliproxy-gateway"), { recursive: true });
      fs.mkdirSync(`${path.join(second, ".codex-cliproxy-gateway")}.bak`, { recursive: true });
      const result = migrateRuntimeHome(resolvePaths({ HOME: second }), () => 1700000000000);
      assert.equal(result!.backup, path.join(second, ".codex-cliproxy-gateway.bak-1700000000000"));
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }

    // 没有旧目录（全新安装）时不产生任何动作。
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-migrate-"));
    try {
      assert.equal(migrateRuntimeHome(resolvePaths({ HOME: fresh })), undefined);
      assert.ok(!fs.existsSync(resolvePaths({ HOME: fresh }).runtimeHome));
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
