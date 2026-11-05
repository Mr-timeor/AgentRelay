import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";

async function setup(t, review = false) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-retry-progress-")), path = join(directory, "state.json");
  let store = await FileStore.open(path, initial(normalize({
    agents: [{ id: "dev" }, { id: "qa" }], tasks: [
      { id: "a", owner: "dev", review, outputs: ["api", "implementation"] },
      { id: "q", owner: "qa", dependsOn: [{ taskId: "a", output: "api" }] },
      { id: "end", owner: "qa", dependsOn: ["a"] }
    ]
  })));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, scheduler: new Scheduler(store), reopen: async () => {
    await store.close(); store = await FileStore.open(path); return new Scheduler(store);
  } };
}
async function start(s, agent = "dev") {
  const run = await s.dispatch(agent, async () => {});
  await s.acknowledge(agent, run);
  return s.delivery(run);
}

test("中间交付后失败可显式重试：保留已启动下游和旧运行，只续做未完成部分", async t => {
  const { path, scheduler: s } = await setup(t), first = await start(s);
  assert.equal(first.acceptedOutputs, undefined);
  const references = ["docs/api.md", "docs/examples.json"];
  await s.report("dev", first, { status: "checkpoint", summary: "接口可用", outputs: { api: references } });
  const q = await start(s, "qa");
  await s.report("dev", first, { status: "failed", summary: "实现编译失败" });
  const before = s.snapshot(), oldRun = before.runs.find(run => run.taskId === "a"), downstream = before.runs.find(run => run.taskId === "q");
  await s.control("retry", "a");
  assert.equal(s.snapshot().progress.a.status, "pending");
  assert.deepEqual(s.snapshot().progress.a.outputs, { api: { accepted: true, reference: references } });
  assert.deepEqual(s.snapshot().runs.find(run => run.taskId === "a"), oldRun);
  assert.deepEqual(s.snapshot().runs.find(run => run.taskId === "q"), downstream);
  assert.deepEqual(s.snapshot().history.slice(0, before.history.length), before.history);
  assert.ok(!s.plan().ready.includes("end"));

  const retry = await start(s);
  for (const key of ["attemptId", "dispatchId", "permitId"]) assert.notEqual(retry[key], first[key]);
  assert.deepEqual(retry.acceptedOutputs, { api: references });
  assert.match(retry.instructions, /acceptedOutputs/);
  retry.acceptedOutputs.api[0] = "caller-mutated.md";
  assert.deepEqual(s.delivery(retry).acceptedOutputs.api, references);
  await assert.rejects(s.report("dev", first, { status: "completed", summary: "旧轮迟交" }), /结束或未知/);
  const snapshot = s.snapshot(), bytes = await readFile(path);
  await assert.rejects(s.report("dev", retry, { status: "completed", summary: "替换接口", outputs: {
    implementation: "src/impl.mjs", api: ["api-v2.md"]
  } }), /已被接受/);
  assert.deepEqual(s.snapshot(), snapshot);
  assert.deepEqual(await readFile(path), bytes);
  await s.report("dev", retry, { status: "completed", summary: "实现完成", outputs: { implementation: "src/impl.mjs" } });
  assert.equal(s.snapshot().progress.a.status, "completed");
  assert.ok(s.plan().ready.includes("end"));
  assert.deepEqual(s.delivery(q).dependencies[0].reference, references);
});

test("需验收任务重试只清草稿，保留已接受接口，完成后仍等待整任务验收", async t => {
  const { scheduler: s } = await setup(t, true), first = await start(s);
  await s.report("dev", first, { status: "checkpoint", summary: "接口和实现草稿", outputs: {
    api: "api.md", implementation: "draft-v1.mjs"
  } });
  await s.accept("a", "api");
  await s.report("dev", first, { status: "blocked", summary: "等待开发环境修好" });
  await s.control("retry", "a");
  assert.deepEqual(s.snapshot().progress.a.outputs, { api: { accepted: true, reference: "api.md" } });
  assert.ok(s.plan().ready.includes("q"));
  const retry = await start(s);
  assert.deepEqual(retry.acceptedOutputs, { api: "api.md" });
  await assert.rejects(s.report("dev", retry, { status: "completed", summary: "缺实现" }), /补齐/);
  await s.report("dev", retry, { status: "completed", summary: "实现已修复", outputs: { implementation: "impl-v2.mjs" } });
  assert.equal(s.snapshot().progress.a.status, "review");
  assert.equal(s.snapshot().progress.a.outputs.api.accepted, true);
  assert.equal(s.snapshot().progress.a.outputs.implementation.accepted, false);
  assert.ok(!s.plan().ready.includes("end"));
  await s.rework("a", "第一轮反馈：补上空输入处理");
  const third = await start(s);
  assert.deepEqual(third.acceptedOutputs, { api: "api.md" });
  assert.equal(third.rework.previousAttemptId, retry.attemptId);
  assert.equal(third.rework.outputs.implementation.reference, "impl-v2.mjs");
  await s.report("dev", third, { status: "completed", summary: "已补空输入", outputs: { implementation: "impl-v3.mjs" } });
  await s.rework("a", "第二轮反馈：补上对应测试");
  const fourth = await start(s);
  assert.equal(fourth.rework.previousAttemptId, third.attemptId);
  assert.equal(fourth.rework.feedback, "第二轮反馈：补上对应测试");
  assert.deepEqual(fourth.acceptedOutputs, { api: "api.md" });
  assert.deepEqual(s.snapshot().runs.filter(run => run.rework).map(run => run.rework.outputs.implementation.reference), ["impl-v2.mjs", "impl-v3.mjs"]);
  assert.ok(!s.plan().ready.includes("end"));
  await s.report("dev", fourth, { status: "completed", summary: "实现与测试完成", outputs: { implementation: "impl-v4.mjs" } });
  await s.accept("a");
  assert.ok(s.plan().ready.includes("end"));
});

test("重启后unknown仍不能重试；确认停止后保留中间交付并创建新轮", async t => {
  const env = await setup(t);
  let s = env.scheduler;
  const first = await start(s);
  await s.report("dev", first, { status: "checkpoint", summary: "接口已发布", outputs: { api: "api.md" } });
  s = await env.reopen();
  assert.equal(s.snapshot().runs[0].phase, "unknown");
  await assert.rejects(s.control("retry", "a"), /仍在执行/);
  await s.control("resolve-stopped", "a");
  await s.control("retry", "a");
  s = await env.reopen();
  assert.equal(s.snapshot().progress.a.status, "pending");
  const retry = await start(s);
  assert.deepEqual(retry.acceptedOutputs, { api: "api.md" });
  assert.notEqual(retry.attemptId, first.attemptId);
  assert.equal(s.snapshot().runs[0].phase, "finished");
  await assert.rejects(s.acknowledge("dev", first), /已结束/);
});
