import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";

async function setup(t, tasks = [
  { id: "a", category: "dev", owner: "dev", outputs: ["api"] },
  { id: "b", category: "qa", owner: "qa", dependsOn: ["a"] }
]) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-update-task-")), path = join(directory, "state.json");
  let store = await FileStore.open(path, initial(normalize({ agents: [
    { id: "dev", categories: ["dev"] }, { id: "qa", categories: ["qa"] }, { id: "any" }
  ], tasks })));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, scheduler: new Scheduler(store), reopen: async () => {
    await store.close(); store = await FileStore.open(path); return new Scheduler(store);
  } };
}
async function start(s, agent = "dev") {
  const run = await s.dispatch(agent, async () => {});
  await s.acknowledge(agent, run);
  return run;
}
async function unchanged(env, operation, expected) {
  const before = env.scheduler.snapshot(), bytes = await readFile(env.path);
  await assert.rejects(operation(), expected);
  assert.deepEqual(env.scheduler.snapshot(), before);
  assert.deepEqual(await readFile(env.path), bytes);
}

test("修改未派发任务改变就绪边界，保留其他任务交付、运行与历史并跨重开保存", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  await s.report("dev", run, { status: "completed", summary: "接口已交付", outputs: { api: "contract.md" } });
  const before = s.snapshot();
  assert.ok(s.plan().ready.includes("b"));
  await s.updateTask("b", { title: "独立验收接口", specFile: "tasks/b.md", owner: "any", priority: 1,
    dependsOn: [{ taskId: "a", output: "api" }], resources: ["tests/"] });
  const updated = s.snapshot(), task = updated.project.tasks.find(task => task.id === "b");
  assert.equal(updated.revision, before.revision + 1);
  assert.equal(task.id, "b");
  assert.equal(task.title, "独立验收接口");
  assert.equal(task.specFile, "tasks/b.md");
  assert.equal(task.owner, "any");
  assert.equal(task.priority, 1);
  assert.deepEqual(task.dependsOn, [{ taskId: "a", output: "api" }]);
  assert.deepEqual(task.resources, [{ path: "tests/", mode: "write" }]);
  assert.deepEqual(updated.progress, before.progress);
  assert.deepEqual(updated.runs, before.runs);
  assert.deepEqual(updated.history.slice(0, -1), before.history);
  assert.deepEqual(updated.history.at(-1), { at: updated.history.at(-1).at, action: "update-task", taskId: "b",
    detail: "title,specFile,owner,priority,dependsOn,resources" });
  assert.ok(s.plan().ready.includes("b"));
  assert.deepEqual((await env.reopen()).snapshot(), JSON.parse(JSON.stringify(updated)));
});

test("调用者后续修改依赖和资源对象不会绕过存储写入改变任务", async t => {
  const env = await setup(t), s = env.scheduler;
  const changes = { dependsOn: [{ taskId: "a", output: "api" }], resources: [{ path: "tests/", mode: "write" }] };
  await s.updateTask("b", changes);
  const before = s.snapshot(), bytes = await readFile(env.path);
  changes.dependsOn[0].taskId = "missing";
  changes.dependsOn[0].output = "unknown";
  changes.resources[0].path = "src/";
  changes.resources[0].mode = "read";
  assert.deepEqual(s.snapshot(), before);
  assert.deepEqual(await readFile(env.path), bytes);
});

test("依赖整体替换立即阻塞或解锁，空数组移除原依赖，owner/specFile 可显式清除", async t => {
  const env = await setup(t), s = env.scheduler;
  assert.ok(!s.plan().ready.includes("b"));
  await s.updateTask("b", { dependsOn: [], owner: null, specFile: "tasks/b.md" });
  assert.ok(s.plan().ready.includes("b"));
  assert.equal(s.snapshot().project.tasks[1].owner, undefined);
  await s.updateTask("b", { dependsOn: ["a"], owner: "qa", specFile: null });
  assert.ok(!s.plan().ready.includes("b"));
  assert.equal(s.snapshot().project.tasks[1].specFile, undefined);
  await s.updateTask("b", { owner: "", specFile: "" });
  assert.equal(s.snapshot().project.tasks[1].owner, undefined);
  assert.equal(s.snapshot().project.tasks[1].specFile, undefined);
});

test("无效修改及图错误不写状态、文件或历史", async t => {
  const env = await setup(t), s = env.scheduler;
  await unchanged(env, () => s.updateTask("missing", { title: "不存在" }), /有效 taskId/);
  for (const patch of [null, undefined, [], "title", 1, new Date(), {}, { id: "other" }, { category: "dev" },
    { outputs: [] }, { approval: true }, { review: true }, { title: "" }, { title: "  " }, { title: 1 },
    { priority: null }, { priority: "1" }, { priority: Infinity }, { priority: NaN }, { owner: 0 }, { specFile: {} },
    { dependsOn: null }, { resources: null }, { dependsOn: "a" }, { resources: "src" }]) {
    await unchanged(env, () => s.updateTask("b", patch), /changes|仅可修改|title|priority|owner|specFile|dependsOn|resources/);
  }
  await unchanged(env, () => s.updateTask("a", { dependsOn: ["b"] }), /循环/);
  await unchanged(env, () => s.updateTask("b", { dependsOn: ["missing"] }), /缺少前置/);
  await unchanged(env, () => s.updateTask("b", { dependsOn: [{ taskId: "a", output: "unknown" }] }), /未知产物/);
  await unchanged(env, () => s.updateTask("b", { owner: "missing" }), /未知执行者/);
  await unchanged(env, () => s.updateTask("b", { owner: "dev" }), /不支持任务类别/);
  await unchanged(env, () => s.updateTask("b", { resources: ["../outside"] }), /超出项目根目录/);
  await unchanged(env, () => s.updateTask("b", { specFile: "../outside.md" }), /超出项目根目录/);
});

test("执行中、已结束及失败重试回 pending 的任务均不可改", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  await unchanged(env, () => s.updateTask("a", { title: "执行中改名" }), /未派发过/);
  await s.report("dev", run, { status: "failed", summary: "失败现场" });
  await unchanged(env, () => s.updateTask("a", { title: "失败后改名" }), /未派发过/);
  await s.control("retry", "a");
  assert.equal(s.snapshot().progress.a.status, "pending");
  await unchanged(env, () => s.updateTask("a", { title: "重试前改名" }), /未派发过/);
  const retry = await start(s);
  await s.report("dev", retry, { status: "completed", summary: "恢复", outputs: { api: "contract.md" } });
  await unchanged(env, () => s.updateTask("a", { title: "完成后改名" }), /未派发过/);
});

test("更新后的资源声明参与现有互斥，释放后才能派发", async t => {
  const env = await setup(t, [
    { id: "a", category: "dev", owner: "dev", resources: ["src/"] },
    { id: "b", category: "qa", owner: "qa", resources: ["tests/"] }
  ]), s = env.scheduler, run = await start(s);
  await s.updateTask("b", { resources: [{ path: "src/shared.mjs", mode: "read" }] });
  assert.ok(s.plan().blocked.b.some(reason => /资源被 a 占用/.test(reason)));
  await unchanged(env, () => s.dispatch("qa", async () => {}), /暂无可启动/);
  await s.report("dev", run, { status: "completed", summary: "开发完成" });
  const qa = await s.dispatch("qa", async () => {});
  assert.equal(qa.taskId, "b");
  assert.deepEqual(qa.task.resources, [{ path: "src/shared.mjs", mode: "read" }]);
});

test("修改已授权但未派发任务撤销旧授权，再次 approve 后可执行", async t => {
  const env = await setup(t, [{ id: "a", category: "dev", owner: "dev", approval: true }]), s = env.scheduler;
  await s.control("approve", "a");
  assert.ok(s.plan().ready.includes("a"));
  await s.updateTask("a", { title: "修改后的范围" });
  assert.equal(s.snapshot().progress.a.approved, false);
  assert.deepEqual(s.plan().blocked.a, ["等待授权"]);
  await unchanged(env, () => s.dispatch("dev", async () => {}), /暂无可启动/);
  await s.control("approve", "a");
  assert.equal((await s.dispatch("dev", async () => {})).title, "修改后的范围");
});

test("修改与派发沿同一存储串行：先修改使用新定义，先派发拒绝后续修改", async t => {
  const first = await setup(t, [{ id: "a", category: "dev", owner: "dev" }]), s = first.scheduler;
  const update = s.updateTask("a", { title: "新任务卡" }), dispatch = s.dispatch("dev", async () => {});
  await update;
  assert.equal((await dispatch).title, "新任务卡");
  const second = await setup(t, [{ id: "a", category: "dev", owner: "dev" }]), other = second.scheduler;
  const running = other.dispatch("dev", async () => {}), rejected = other.updateTask("a", { title: "迟到的修改" });
  const results = await Promise.allSettled([running, rejected]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /未派发过/);
  const state = other.snapshot();
  assert.equal(state.project.tasks[0].title, "a");
  assert.equal(state.runs.length, 1);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.history.map(entry => entry.action), ["dispatch"]);
});
