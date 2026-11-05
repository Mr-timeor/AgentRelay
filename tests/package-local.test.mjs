import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLocalPackage } from "../scripts/package-local.mjs";

const exec = promisify(execFile);

test("分发目录：独立编译、不更新安装副本，迁移后CLI、核心与图无外部依赖", async t => {
  const work = await mkdtemp(join(tmpdir(), "scheduler-package-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const installedFiles = ["harness/bundle/index.mjs", "harness/bundle/adapter.mjs", "harness/bundle/dist/cli.js", "harness/view-bundle/dist/ui/graph.js"];
  const snapshot = async file => {
    try { return { data: await readFile(file), mtime: (await stat(file)).mtimeMs }; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const before = await Promise.all(installedFiles.map(snapshot));
  const result = await buildLocalPackage(join(work, "build"));
  assert.deepEqual(await Promise.all(installedFiles.map(snapshot)), before);
  const moved = join(work, "复制后的独立目录");
  await cp(result.directory, moved, { recursive: true });
  await rm(result.directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(moved, "manifest.json"), "utf8"));
  assert.equal(manifest.kind, "local-validation");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.licenseStatus, "declared");
  assert.match(await readFile(join(moved, "harness/bundle/LICENSE"), "utf8"), /MIT License/);
  assert.match(await readFile(join(moved, "harness/view-bundle/LICENSE"), "utf8"), /MIT License/);
  assert.ok(manifest.files.includes("harness/bundle/dist/dispatcher/scheduler.js"));
  assert.ok(manifest.files.includes("harness/bundle/dist/dispatcher/wake-queue.js"));
  assert.ok(!manifest.files.some(file => file.includes("node_modules") || file.startsWith(".scheduler/") || file.includes("trials/")));
  assert.ok(!manifest.files.some(file => file.endsWith(".map")));
  assert.deepEqual(manifest.files.filter(file => file.startsWith("docs/")).sort(), [
    "docs/快速开始.md", "docs/下载安装.md", "docs/设计方案.md", "docs/调度算法.md", "docs/接口与数据契约.md", "docs/离线评测.md"
  ].sort());
  const cli = (...args) => exec(process.execPath, [join(moved, "core/dist/cli.js"), ...args], { cwd: moved });
  const plan = JSON.parse((await cli("plan", "fixtures/development.json")).stdout);
  assert.deepEqual(plan.ready, ["A1"]);
  assert.match((await cli("check", "fixtures/development.json", "not-created/state.json")).stdout, /本次未创建/);
  await assert.rejects(stat(join(moved, "not-created")), { code: "ENOENT" });
  await cli("graph", "fixtures/development.json", "flow.html");
  assert.match(await readFile(join(moved, "flow.html"), "utf8"), /A1/);
  await cli("init", "fixtures/development.json", "state.json");
  const stateFile = join(moved, "state.json"), original = await readFile(stateFile, "utf8");
  assert.deepEqual(JSON.parse((await cli("status", "state.json")).stdout).ready, ["A1"]);
  await assert.rejects(cli("init", "fixtures/development.json", "state.json"), /EEXIST/);
  const { startViewExport } = await import(pathToFileURL(join(moved, "harness/view-bundle/dist/ui/export-view.js")));
  const view = await startViewExport({ stateFile, graphFile: join(moved, "view.html") });
  try { assert.match(await readFile(join(moved, "view.html"), "utf8"), /revision 0/); }
  finally { await view.close(); }
  assert.equal(await readFile(stateFile, "utf8"), original);
  const { install } = await import(pathToFileURL(join(moved, "harness/bundle/adapter.mjs")));
  assert.equal(typeof install, "function");
  assert.match(await readFile(join(moved, "harness/bundle/index.mjs"), "utf8"), /autoDispatch: z\.boolean\(\)\.default\(false\)/);
  const { stdout } = await exec(process.execPath, [join(moved, "core/dist/benchmark/run.js"), "fixtures/benchmarks", "--json"], { cwd: moved });
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, 7);
  assert.ok(rows.every(row => row.results.length === 4 && row.results.every(result => result.completed && !result.violations.length)));
});

test("隔离宿主准备：可选择分发副本，不回退使用仓库插件", async t => {
  const work = await mkdtemp(join(tmpdir(), "scheduler-package-host-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  // 在独立工作树形状中运行准备脚本，避免覆盖正在接入验证的隔离home。
  const scriptRoot = join(work, "repo");
  await mkdir(join(scriptRoot, "tests/host"), { recursive: true });
  await mkdir(join(scriptRoot, "fixtures"));
  await cp("tests/host/setup-isolated.mjs", join(scriptRoot, "tests/host/setup-isolated.mjs"));
  await cp("fixtures/development.json", join(scriptRoot, "fixtures/development.json"));
  await cp("fixtures/wakeup.json", join(scriptRoot, "fixtures/wakeup.json"));
  const custom = join(work, "staged-bundle");
  await mkdir(custom);
  await mkdir(join(custom, "dist"));
  await cp("harness/bundle/package.json", join(custom, "package.json"));
  await cp("harness/bundle/index.mjs", join(custom, "index.mjs"));
  await exec(process.execPath, [resolve(scriptRoot, "tests/host/setup-isolated.mjs")], {
    cwd: scriptRoot, env: { ...process.env, SCHEDULER_BUNDLE_DIR: custom, SCHEDULER_WAKE_TEST: "1", SCHEDULER_CONTEXT_TEST: "1" }
  });
  for (const profile of ["scheduler-test", "scheduler-loop", "scheduler-wake"]) {
    const installed = join(scriptRoot, ".harness-isolated/home/profiles", profile, "node_modules/dynamic-task-scheduler/index.mjs");
    assert.equal(await readFile(installed, "utf8"), await readFile(join(custom, "index.mjs"), "utf8"));
  }
  assert.match(await readFile(join(scriptRoot, ".harness-isolated/home/profiles/scheduler-wake/cordis.patch.yml"), "utf8"), /autoDispatch: true/);
  const contextProject = JSON.parse(await readFile(join(scriptRoot, ".harness-isolated/project-loop.json"), "utf8"));
  assert.equal(contextProject.tasks.find(t => t.id === "A1").specFile, "docs/tasks.md#A1");
  assert.deepEqual(contextProject.tasks.find(t => t.id === "A2").dependsOn, ["A1", { taskId: "A1", output: "api" }]);
});
