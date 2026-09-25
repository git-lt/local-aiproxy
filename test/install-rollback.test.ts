import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realPathOrResolve } from "../src/paths.ts";
import { runCli } from "../src/cli.ts";

test("realPathOrResolve follows file and directory symlinks and falls back for missing parents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-realpath-"));
  try {
    const target = path.join(root, "config.json");
    fs.writeFileSync(target, "{}\n");
    const fileLink = path.join(root, "link.json");
    fs.symlinkSync(target, fileLink);
    assert.equal(realPathOrResolve(fileLink), fs.realpathSync(target));

    const dir = path.join(root, "runtime");
    fs.mkdirSync(dir);
    const dirLink = path.join(root, "link-dir");
    fs.symlinkSync(dir, dirLink);
    assert.equal(realPathOrResolve(path.join(dirLink, "config.json")), path.join(fs.realpathSync(dir), "config.json"));

    const missing = path.join(root, "no-such", "config.json");
    assert.equal(realPathOrResolve(missing), path.resolve(missing));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("webui is removed and web service mode binds the default install config", async () => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-webui-cli-"));
  const previousHome = process.env.HOME;
  const previousService = process.env.LOCAL_AIPROXY_UI_SERVICE;
  try {
    process.env.HOME = home;
    process.env.LOCAL_AIPROXY_UI_SERVICE = "1";
    const defaultConfig = path.join(home, ".local-aiproxy", "config.json");
    await assert.rejects(runCli(["webui"]), /Unknown command: webui/);
    await assert.rejects(
      runCli(["webui", "--config", path.join(home, "other.json")]),
      /Unknown option --config/,
    );
    // 后台服务模式仍绑定默认配置，但不再保留旧命令及其参数兼容入口。
    await assert.rejects(
      runCli(["web"]),
      new RegExp(`Gateway config not found: ${defaultConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousService === undefined) delete process.env.LOCAL_AIPROXY_UI_SERVICE;
    else process.env.LOCAL_AIPROXY_UI_SERVICE = previousService;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

test("web rejects combined or misplaced mode flags before touching the installation", async () => {
  // 模式互斥与门禁校验先于平台/安装检查，参数错误不依赖运行环境。
  await assert.rejects(
    runCli(["web", "--start", "--daemon"]),
    /--start and --daemon cannot be combined; pick one/,
  );
  await assert.rejects(
    runCli(["web", "--daemon", "--status"]),
    /--daemon and --status cannot be combined; pick one/,
  );
  await assert.rejects(
    runCli(["web", "--restart", "--stop"]),
    /--stop and --restart cannot be combined; pick one/,
  );
  // web 专属模式 flag 用在其他命令上一律拒绝。
  await assert.rejects(runCli(["status", "--daemon"]), /--daemon is only supported by the web command/);
  await assert.rejects(runCli(["models", "--start"]), /--start is only supported by the web command/);
});
