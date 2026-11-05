import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { install } from "../harness/adapter.mjs";

async function setup(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-status-")), tools = new Map();
  const makeAgent = id => {
    const own = new Map(); tools.set(id, own);
    return { id, ctx: { tools: { register(tool) { own.set(tool.name, tool); return () => own.delete(tool.name); } } } };
  };
  const lead = makeAgent("lead"), dev = makeAgent("dev"), other = makeAgent("other");
  const ctx = {
    agents: { list: () => [lead, dev, other] },
    agentTeams: {
      tryMembership: agent => agent === dev ? { root: lead, role: "teammate", name: "dev" }
        : { root: agent, role: "lead", name: "lead" },
      sendMessage: async () => {}
    },
    on: () => () => {}
  };
  const project = normalize({ agents: [{ id: "dev" }], tasks: [
    { id: "A", owner: "dev", outputs: ["api"], specFile: "cards.md#A" }, { id: "B", title: "OTHER_TASK_DEFINITION" }
  ] });
  const projectFile = join(dir, "project.json"), stateFile = join(dir, "state.json");
  await writeFile(projectFile, JSON.stringify(project));
  const seed = initial(project);
  seed.progress.B.summary = "OTHER_TASK_FULL_REPORT".repeat(100);
  await writeFile(stateFile, JSON.stringify(seed));
  const dispose = install(ctx, { projectFile, stateFile, leadSessionId: lead.id, ...config }, { defineTool: tool => tool });
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });
  const call = async (agent, name, args = {}) => JSON.parse((await tools.get(agent.id).get(name).execute(args, { agent })).result);
  return { dir, stateFile, lead, dev, other, tools, call,
    status: args => call(lead, "scheduler_status", args),
    start: async () => {
      const delivery = await call(lead, "scheduler_manage", { action: "dispatch", target: "dev" });
      await call(dev, "scheduler_next", { dispatchId: delivery.dispatchId });
      return delivery;
    } };
}

test("概览摘要按Unicode字符限长，不在活动run重复；原始状态及引用完整保留", async t => {
  const h = await setup(t), run = await h.start();
  const reference = "evidence/" + "接口".repeat(240) + ".json";
  for (const count of [0, 299, 300, 301, 5000]) {
    const summary = "🐱".repeat(count);
    await h.call(h.dev, "scheduler_report", { dispatchId: run.dispatchId, status: "checkpoint", summary,
      outputs: JSON.stringify({ api: reference }) });
    const before = await readFile(h.stateFile, "utf8"), time = (await stat(h.stateFile)).mtimeMs;
    const status = await h.status(), progress = status.tasks.A;
    assert.equal(progress.summaryChars, count);
    assert.equal(progress.summaryTruncated, count > 300);
    assert.equal(progress.summary, count > 300 ? "🐱".repeat(299) + "…" : summary);
    assert.ok(Array.from(progress.summary).length <= 300);
    assert.equal(Object.hasOwn(status.runs[0], "summary"), false);
    assert.equal(progress.outputs.api.reference, reference);
    assert.equal(await readFile(h.stateFile, "utf8"), before);
    assert.equal((await stat(h.stateFile)).mtimeMs, time);
    const stored = JSON.parse(before);
    assert.equal(stored.progress.A.summary, summary);
    assert.equal(stored.runs[0].summary, summary);
    assert.equal(stored.history.at(-1).detail, summary);
    if (count > 300) {
      assert.deepEqual(progress.summaryRead, { taskId: "A" });
      const detail = await h.status(progress.summaryRead);
      assert.equal(detail.progress.summary, summary);
      assert.equal(detail.task.specFile, "cards.md#A");
      assert.equal(detail.progress.outputs.api.reference, reference);
      assert.equal(detail.runs[0].dispatchId, run.dispatchId);
      assert.equal(detail.runs[0].phase, "active");
      assert.equal(Object.hasOwn(detail.runs[0], "summary"), false);
      assert.equal(Object.hasOwn(detail, "tasks"), false);
      assert.equal(Object.hasOwn(detail, "history"), false);
      assert.ok(!JSON.stringify(detail).includes("OTHER_TASK_"));
      assert.equal(await readFile(h.stateFile, "utf8"), before);
    } else assert.equal(progress.summaryRead, undefined);
  }
  await h.call(h.dev, "scheduler_report", { dispatchId: run.dispatchId, summary: "完成" });
  const finished = await h.status({ taskId: "A" });
  assert.equal(finished.progress.status, "completed");
  assert.equal(finished.runs[0].phase, "finished");
});

test("详情不执行到期检查，空参概览保留原有expire行为", async t => {
  const h = await setup(t, { receiptTimeoutMs: 0 });
  const delivery = await h.call(h.lead, "scheduler_manage", { action: "dispatch", target: "dev" });
  const before = await readFile(h.stateFile, "utf8");
  const detail = await h.status({ taskId: "A" });
  assert.equal(detail.runs[0].phase, "awaiting");
  assert.equal(detail.runs[0].dispatchId, delivery.dispatchId);
  assert.equal(await readFile(h.stateFile, "utf8"), before);
  const overview = await h.status();
  assert.equal(overview.runs[0].phase, "unknown");
  assert.equal(overview.revision, detail.revision + 1);
});

test("status任务参数仍为可选字符串，未知/空ID和其他团队不读取详情", async t => {
  const h = await setup(t);
  const tool = h.tools.get(h.lead.id).get("scheduler_status");
  assert.equal(h.tools.get(h.lead.id).size, 4);
  assert.equal(tool.parameters.taskId.type, "string");
  assert.equal(Object.hasOwn(tool.parameters.taskId, "required"), false);
  const first = await h.status({ taskId: "A" });
  assert.equal(first.progress.summary, undefined);
  assert.deepEqual(first.runs, []);
  for (const taskId of ["", "  ", null, 42]) await assert.rejects(h.status({ taskId }), /有效 taskId/);
  await assert.rejects(h.status({ taskId: "missing" }), /未知任务/);
  await assert.rejects(tool.execute({ taskId: "A" }, { agent: h.other }), /另一个 Lead/);
  const overview = await h.status();
  assert.equal(overview.tasks.A.summary, undefined);
  assert.equal(overview.tasks.A.summaryChars, undefined);
  assert.equal(overview.diagnostics.length, 0);
  assert.ok(Array.isArray(overview.ready) && Array.isArray(overview.runs));
});
