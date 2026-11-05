import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, stat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initial, normalize } from "../dist/core/model.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const project = { agents: [{ id: "dev" }], tasks: [{ id: "A1" }] };
const check = (...args) => spawnSync(process.execPath, [cli, "check", ...args], { encoding: "utf8" });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const taskFile = join(dir, "tasks.json");
  await writeFile(taskFile, JSON.stringify(project));
  return { dir, taskFile };
}

test("CLI check 校验项目与待创建状态路径，不创建目录或状态", async t => {
  const { dir, taskFile } = await fixture(t);
  assert.equal(check(taskFile).status, 0);
  const result = check(taskFile, join(dir, "not-created", "nested", "state.json"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /任务定义有效/);
  assert.match(result.stdout, /首次运行时创建，本次未创建/);
  assert.equal(result.stderr, "");
  assert.deepEqual(await readdir(dir), ["tasks.json"]);
});

test("CLI check 读取已有活跃状态但不触发重启对账或改写文件", async t => {
  const { dir, taskFile } = await fixture(t), stateFile = join(dir, "state.json");
  const state = initial(normalize(project));
  state.revision = 7;
  state.progress.A1.status = "running";
  state.runs.push({ taskId: "A1", agentId: "dev", dispatchId: "d", attemptId: "a", permitId: "p", phase: "active", startedAt: 123 });
  const original = JSON.stringify(state, null, 2);
  await writeFile(stateFile, original);
  const before = await stat(stateFile);
  const result = check(taskFile, stateFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /状态文件可读取，路径可写/);
  assert.equal(await readFile(stateFile, "utf8"), original);
  assert.equal((await stat(stateFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual((await readdir(dir)).sort(), ["state.json", "tasks.json"]);
});

test("CLI check 对文件缺失、坏JSON、依赖环、缺前置和越界资源返回失败", async t => {
  const { dir, taskFile } = await fixture(t);
  const missing = check(join(dir, "missing.json"));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /任务文件未找到/);
  await writeFile(taskFile, "{bad");
  const badJson = check(taskFile);
  assert.equal(badJson.status, 1);
  assert.match(badJson.stderr, /任务文件 JSON 格式错误/);
  for (const [tasks, pattern] of [
    [[{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }], /循环/],
    [[{ id: "a", dependsOn: ["missing"] }], /缺少前置/],
    [[{ id: "a", resources: ["../outside"] }], /资源超出项目根目录/]
  ]) {
    await writeFile(taskFile, JSON.stringify({ ...project, tasks }));
    const result = check(taskFile);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "");
  }
});

test("CLI check 拒绝状态目录、父路径文件及无法读取的状态结构，不改变现场", async t => {
  const { dir, taskFile } = await fixture(t);
  const stateDir = join(dir, "state-dir"), stateFile = join(dir, "state.json");
  await mkdir(stateDir);
  const directory = check(taskFile, stateDir);
  assert.equal(directory.status, 1);
  assert.match(directory.stderr, /状态路径应为文件/);
  const parentFile = check(taskFile, join(taskFile, "state.json"));
  assert.equal(parentFile.status, 1);
  assert.match(parentFile.stderr, /父路径不是目录/);
  for (const [body, pattern] of [["{bad", /状态文件 JSON 格式错误/], ["{}", /状态文件结构无法识别/]]) {
    await writeFile(stateFile, body);
    const result = check(taskFile, stateFile);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.equal(await readFile(stateFile, "utf8"), body);
  }
});
