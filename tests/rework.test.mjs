import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";

async function setup(t, { approval = false, review = true, outputs = ["api"] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-rework-")), path = join(directory, "state.json");
  let store = await FileStore.open(path, initial(normalize({ agents: [{ id: "dev" }, { id: "qa" }], tasks: [
    { id: "a", owner: "dev", review, approval, outputs },
    { id: "q", owner: "qa", dependsOn: ["a", { taskId: "a", output: "api" }] }
  ] })));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, scheduler: new Scheduler(store), reopen: async () => {
    await store.close(); store = await FileStore.open(path); return new Scheduler(store);
  } };
}
async function start(s) {
  const run = await s.dispatch("dev", async () => {});
  await s.acknowledge("dev", run);
  return s.delivery(run);
}
const report = (s, run, summary = "初次交付", api = "api-v1.md") => s.report("dev", run, {
  status: "completed", summary, outputs: { api }
});
async function unchanged(env, operation, expected) {
  const before = env.scheduler.snapshot(), bytes = await readFile(env.path);
  await assert.rejects(operation(), expected);
  assert.deepEqual(env.scheduler.snapshot(), before);
  assert.deepEqual(await readFile(env.path), bytes);
}

test("退回返工保存旧报告和引用，新运行带反馈；原审批保留，下游重新验收后才解锁", async t => {
  const env = await setup(t, { approval: true }), s = env.scheduler;
  await s.control("approve", "a");
  const first = await start(s);
  assert.equal(first.rework, undefined);
  await report(s, first);
  const old = s.snapshot().runs[0];
  await s.rework("a", "请补上空输入处理和对应测试");
  const returned = s.snapshot(), expected = { feedback: "请补上空输入处理和对应测试", outputs: {
    api: { accepted: false, reference: "api-v1.md" }
  } };
  assert.deepEqual(returned.runs[0], { ...old, rework: expected });
  assert.deepEqual(returned.progress.a, { status: "pending", approved: true, outputs: {} });
  assert.equal(returned.history.at(-1).action, "rework");
  assert.equal(returned.history.at(-1).detail, expected.feedback);
  assert.ok(!s.plan().ready.includes("q"));
  const next = await start(s);
  for (const id of ["attemptId", "dispatchId", "permitId"]) assert.notEqual(next[id], first[id]);
  assert.deepEqual(next.rework, { previousAttemptId: first.attemptId, ...expected });
  assert.match(next.instructions, /rework.feedback/);
  await assert.rejects(s.acknowledge("dev", first), /已结束/);
  await assert.rejects(report(s, first), /结束或未知/);
  next.rework.outputs.api.reference = "external-change.md";
  assert.equal(s.snapshot().runs[0].rework.outputs.api.reference, "api-v1.md");
  await report(s, next, "已补充空输入处理", "api-v2.md");
  assert.equal(s.snapshot().progress.a.status, "review");
  assert.ok(!s.plan().ready.includes("q"));
  await s.accept("a");
  assert.ok(s.plan().ready.includes("q"));
  assert.deepEqual(s.snapshot().runs[0], { ...old, rework: expected });
});

test("返工记录跨重启保留；失败后显式重试仍带反馈，再次退回不覆盖早期报告", async t => {
  const env = await setup(t);
  let s = env.scheduler;
  const first = await start(s), references = ["tests/core.mjs", "tests/cli.mjs"];
  await report(s, first, "第一版", references);
  await s.rework("a", "第一轮反馈");
  s = await env.reopen();
  assert.equal(s.snapshot().version, 1);
  const failed = await start(s);
  assert.equal(failed.rework.previousAttemptId, first.attemptId);
  assert.deepEqual(failed.rework.outputs.api.reference, references);
  await s.report("dev", failed, { status: "failed", summary: "运行失败" });
  await s.control("retry", "a");
  const second = await start(s);
  assert.equal(second.rework.feedback, "第一轮反馈");
  await report(s, second, "第二版", "v2.md");
  await s.rework("a", "第二轮反馈");
  const third = await start(s);
  assert.equal(third.rework.previousAttemptId, second.attemptId);
  assert.equal(third.rework.feedback, "第二轮反馈");
  const records = s.snapshot().runs.filter(run => run.rework);
  assert.deepEqual(records.map(run => [run.summary, run.rework.feedback, run.rework.outputs.api.reference]), [
    ["第一版", "第一轮反馈", references], ["第二版", "第二轮反馈", "v2.md"]
  ]);
  assert.equal(s.snapshot().runs[1].summary, "运行失败");
});

test("退回需要有效任务、具体反馈及待验收状态，无效请求不改变状态或文件", async t => {
  const env = await setup(t), s = env.scheduler;
  await unchanged(env, () => s.rework("missing", "反馈"), /有效 taskId/);
  await unchanged(env, () => s.rework("a", "反馈"), /待验收/);
  const a = await start(s);
  await unchanged(env, () => s.rework("a", "反馈"), /待验收/);
  await report(s, a);
  for (const feedback of [undefined, null, "", " \n\t", 0, [], {}]) {
    await unchanged(env, () => s.rework("a", feedback), /具体 feedback/);
  }
  await s.accept("a");
  await unchanged(env, () => s.rework("a", "已通过后的修改"), /待验收/);
  const ordinary = await setup(t, { review: false }), regular = await start(ordinary.scheduler);
  await report(ordinary.scheduler, regular);
  await unchanged(ordinary, () => ordinary.scheduler.rework("a", "修改"), /待验收/);
});

test("存在已接受中间产物仍可退回未完成部分，既有交付及下游保持，快照保留接受状态", async t => {
  const env = await setup(t, { outputs: ["api", "implementation"] }), s = env.scheduler;
  await s.addTasks([{ id: "mid", owner: "qa", dependsOn: [{ taskId: "a", output: "api" }] }]);
  const a = await start(s);
  await s.report("dev", a, { status: "checkpoint", summary: "接口", outputs: { api: "api.md" } });
  await s.accept("a", "api");
  const downstream = await s.dispatch("qa", async () => {});
  await s.acknowledge("qa", downstream);
  await s.report("dev", a, { status: "completed", summary: "待验收实现", outputs: { implementation: "impl-v1.mjs" } });
  const before = s.snapshot(), oldOutputs = before.progress.a.outputs;
  await s.rework("a", "接口保留，补上实现的空输入分支");
  assert.deepEqual(s.snapshot().progress.a.outputs, { api: oldOutputs.api });
  assert.equal(s.snapshot().progress.a.status, "pending");
  assert.deepEqual(s.snapshot().runs.find(run => run.taskId === "mid"), before.runs.find(run => run.taskId === "mid"));
  assert.deepEqual(s.snapshot().runs[0], { ...before.runs[0], rework: {
    feedback: "接口保留，补上实现的空输入分支", outputs: oldOutputs
  } });
  assert.ok(!s.plan().ready.includes("q"));
  const next = await start(s);
  assert.deepEqual(next.acceptedOutputs, { api: "api.md" });
  assert.deepEqual(next.rework.outputs, oldOutputs);
  assert.match(next.instructions, /产物快照/);
  await unchanged(env, () => s.report("dev", next, { status: "completed", summary: "错误修改接口", outputs: {
    implementation: "impl-v2.mjs", api: "api-v2.md"
  } }), /已被接受.*修订任务/);
  await s.report("dev", next, { status: "completed", summary: "已补分支", outputs: { implementation: "impl-v2.mjs" } });
  assert.equal(s.snapshot().progress.a.status, "review");
  assert.ok(!s.plan().ready.includes("q"));
  await s.accept("a");
  assert.ok(s.plan().ready.includes("q"));
  assert.deepEqual(s.snapshot().progress.a.outputs.api, oldOutputs.api);
  await unchanged(env, () => s.rework("a", "完成后再次修改"), /待验收/);
});

test("重复退回只提交一次；验收和退回并发时沿用存储串行顺序", async t => {
  const env = await setup(t), s = env.scheduler, a = await start(s);
  await report(s, a);
  const duplicate = await Promise.allSettled([s.rework("a", "反馈1"), s.rework("a", "反馈2")]);
  assert.equal(duplicate.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(s.snapshot().history.filter(row => row.action === "rework").length, 1);
  assert.equal(s.snapshot().runs.length, 1);
  for (const acceptFirst of [true, false]) {
    const race = await setup(t), current = await start(race.scheduler);
    await report(race.scheduler, current);
    const accept = () => race.scheduler.accept("a"), rework = () => race.scheduler.rework("a", "反馈");
    const results = await Promise.allSettled(acceptFirst ? [accept(), rework()] : [rework(), accept()]);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
    assert.equal(race.scheduler.snapshot().progress.a.status, acceptFirst ? "completed" : "pending");
  }
});
