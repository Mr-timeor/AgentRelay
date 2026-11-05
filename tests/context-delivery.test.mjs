import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";
import { renderGraph } from "../dist/ui/graph.js";

async function setup(t, tasks) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-context-"));
  const store = await FileStore.open(join(dir, "state.json"), initial(normalize({
    agents: [{ id: "dev" }, { id: "qa" }], tasks
  })));
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return new Scheduler(store);
}
async function complete(s, taskId, outputs = {}, summary = "完成") {
  const d = await s.dispatch("dev", async () => {});
  assert.equal(d.taskId, taskId);
  await s.acknowledge("dev", d);
  await s.report("dev", d, { status: "completed", summary, outputs });
}

test("任务卡可省略；保留相对路径，拒绝错误类型、绝对路径与越界", () => {
  const input = specFile => ({ agents: [{ id: "dev" }], tasks: [{ id: "a", specFile }] });
  for (const value of [undefined, null, ""]) assert.equal(normalize(input(value)).tasks[0].specFile, undefined);
  assert.equal(normalize(input("docs/cards.md#a")).tasks[0].specFile, "docs/cards.md#a");
  for (const value of [false, 0, {}, "   ", "../outside.md", "D:/cards.md", "/cards.md", "https://example.org/card"]) {
    assert.throws(() => normalize(input(value)), /任务卡/);
  }
});

test("普通任务依赖自动带入所有已接受的产物，指定产物依赖只带所需项", async t => {
  const s = await setup(t, [
    { id: "a", outputs: ["api", "example"] },
    { id: "b", dependsOn: ["a"], owner: "dev" },
    { id: "c", dependsOn: [{ taskId: "a", output: "api" }], owner: "qa" }
  ]);
  await complete(s, "a", { api: "docs/api.md", example: "samples/api.json" }, "接口交付");
  const ordinary = await s.dispatch("dev", async () => {});
  assert.deepEqual(ordinary.dependencies, [{ taskId: "a", outputs: { api: "docs/api.md", example: "samples/api.json" }, summary: "接口交付" }]);
  const specific = await s.dispatch("qa", async () => {});
  assert.deepEqual(specific.dependencies, [{ taskId: "a", output: "api", reference: "docs/api.md", summary: "接口交付" }]);
});

test("只带直接前置，截短并去重交付摘要，原始历史与摘要不截断", async t => {
  const long = "接口说明🙂".repeat(150);
  const s = await setup(t, [
    { id: "a", outputs: ["api", "example"] },
    { id: "b", owner: "dev", dependsOn: ["a"] },
    { id: "c", owner: "dev", dependsOn: ["b"] },
    { id: "q", owner: "qa", dependsOn: [{ taskId: "a", output: "api" }, { taskId: "a", output: "example" }] }
  ]);
  await complete(s, "a", { api: "api.md", example: "sample.json" }, long);
  const q = await s.dispatch("qa", async () => {});
  assert.equal(q.taskId, "q");
  assert.equal(Array.from(q.dependencies[0].summary).length, 301);
  assert(q.dependencies[0].summary.endsWith("…"));
  assert.equal(q.dependencies[1].summary, undefined);
  assert.equal(s.snapshot().progress.a.summary, long);
  assert.equal(s.snapshot().history.find(e => e.action === "completed").detail, long);
  await complete(s, "b");
  const c = await s.dispatch("dev", async () => {});
  assert.deepEqual(c.dependencies, [{ taskId: "b", summary: "完成" }]);
});

test("已有运行确认后仍有完整建议段、交付点、开始时间和任务卡，读取不改状态", async t => {
  const s = await setup(t, [
    { id: "a", outputs: ["api"], specFile: "cards.md#a", resources: ["src"] },
    { id: "b", dependsOn: ["a"], resources: ["src"], owner: "dev" },
    { id: "q", dependsOn: [{ taskId: "a", output: "api" }], owner: "qa" }
  ]);
  const sent = await s.dispatch("dev", async () => {});
  await s.acknowledge("dev", sent);
  const before = s.snapshot(), confirmed = s.delivery(sent);
  assert.equal(confirmed.phase, "active");
  assert.equal(confirmed.startedAt, sent.startedAt);
  assert.deepEqual(confirmed.segment, ["a", "b"]);
  assert.deepEqual(confirmed.checkpoints, sent.checkpoints);
  assert.equal(confirmed.stop, sent.stop);
  assert.equal(confirmed.task.specFile, "cards.md#a");
  assert.match(confirmed.instructions, /已确认/);
  assert.deepEqual(s.snapshot(), before);
  sent.task.title = "不能改写内部状态";
  confirmed.task.resources.length = 0;
  assert.deepEqual(s.snapshot(), before);
});

test("当前段重建不绕过其他运行的资源占用或暂停", async t => {
  const s = await setup(t, [
    { id: "a", owner: "dev" },
    { id: "b", owner: "dev", dependsOn: ["a"], resources: ["shared"] },
    { id: "q", owner: "qa", resources: ["shared"] }
  ]);
  const q = await s.dispatch("qa", async () => {});
  const a = await s.dispatch("dev", async () => {});
  await s.acknowledge("dev", a);
  assert.deepEqual(s.delivery(a).segment, ["a"]);
  await s.acknowledge("qa", q);
  await s.report("qa", q, { status: "completed", summary: "释放" });
  assert.deepEqual(s.delivery(a).segment, ["a", "b"]);
  await s.control("pause");
  assert.deepEqual(s.delivery(a).segment, ["a"]);
  assert.equal(s.snapshot().progress.b.status, "pending");
});

test("产物验收只传已接受项；任务卡仅为引用并在图详情中安全展示", async t => {
  const s = await setup(t, [
    { id: "a", owner: "dev", review: true, outputs: ["api", "draft"] },
    { id: "q", owner: "qa", specFile: 'cards/<draft>.md#q', dependsOn: [{ taskId: "a", output: "api" }] }
  ]);
  const a = await s.dispatch("dev", async () => {});
  await s.acknowledge("dev", a);
  await s.report("dev", a, { status: "checkpoint", summary: "接口可读", outputs: { api: "api.md", draft: "draft.md" } });
  await assert.rejects(s.dispatch("qa", async () => {}), /暂无/);
  await s.accept("a", "api");
  const q = await s.dispatch("qa", async () => {});
  assert.deepEqual(q.dependencies, [{ taskId: "a", output: "api", reference: "api.md", summary: "接口可读" }]);
  assert.equal(q.specFile, 'cards/<draft>.md#q');
  const html = renderGraph(s.snapshot());
  assert(html.includes("任务卡"));
  assert(!html.includes("<draft>"));
});
