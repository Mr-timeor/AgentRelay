import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { install } from "../harness/adapter.mjs";

async function setup(t, tasks, autoDispatch = true) {
  const folder = await mkdtemp(join(tmpdir(), "scheduler-update-host-"));
  const tools = new Map(), listeners = new Map(), members = new Map(), sent = [];
  const makeAgent = id => {
    const table = new Map(); tools.set(id, table);
    return { id, ctx: { tools: { register(definition) {
      table.set(definition.name, definition); return () => table.delete(definition.name);
    } } } };
  };
  const lead = makeAgent("lead");
  for (const name of ["dev", "qa"]) members.set(name, makeAgent(name));
  const live = [lead, ...members.values()];
  const ctx = {
    agents: { list: () => live },
    agentTeams: {
      tryMembership: agent => !live.includes(agent) ? undefined : agent === lead
        ? { root: lead, role: "lead", name: "lead" }
        : { root: lead, role: "teammate", name: agent.id },
      listMembers: caller => {
        assert.equal(caller, lead);
        return [...members].map(([name, agent]) => ({ id: agent.id, name, role: "teammate", status: "inactive" }));
      },
      sendMessage: async (caller, message) => {
        assert.equal(caller, lead);
        sent.push({ ...JSON.parse(message.content[0].text), target: message.target });
      }
    },
    on: (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); }
  };
  const projectFile = join(folder, "project.json"), stateFile = join(folder, "state.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }, { id: "qa" }], tasks }));
  const dispose = install(ctx, { projectFile, stateFile, leadSessionId: "lead", autoDispatch }, { defineTool: value => value });
  t.after(async () => { await dispose(); await rm(folder, { recursive: true, force: true }); });
  const call = async (name, tool, args = {}) => JSON.parse((await tools.get(name).get(tool).execute(args, {
    agent: name === "lead" ? lead : members.get(name), signal: new AbortController().signal
  })).result);
  const manage = args => call("lead", "scheduler_manage", args);
  return {
    call, manage, sent,
    next: name => call(name, "scheduler_next"),
    report: (name, run) => call(name, "scheduler_report", { dispatchId: run.dispatchId, summary: `${run.taskId}完成` }),
    update: (target, changes) => manage({ action: "update-task", target, changes: JSON.stringify(changes) }),
    snapshot: async () => JSON.parse(await readFile(stateFile, "utf8")),
    bytes: () => readFile(stateFile),
    unload: name => {
      const agent = members.get(name); live.splice(live.indexOf(agent), 1);
      listeners.get("agent/disposed")?.({ agent });
      return agent.id;
    },
    resume: name => {
      const agent = makeAgent(name); members.set(name, agent); live.push(agent);
      listeners.get("agent/created")?.({ agent });
      return agent.id;
    }
  };
}

const task = (id, owner, dependsOn = []) => ({ id, owner, dependsOn });

test("Lead通过现有管理工具修改未开始任务并保存，详情返回新定义", async t => {
  const h = await setup(t, [task("A", "dev"), task("B", "qa", ["A"])]);
  const result = await h.update("B", {
    title: "独立验证接口", specFile: "tasks/verify.md", dependsOn: ["A"], owner: "dev",
    resources: [{ path: "src/api.mjs", mode: "read" }], priority: 1
  });
  assert.equal(result.revision, 1);
  assert.deepEqual(result.wakeups, { dispatched: [], errors: [] });
  const detail = await h.call("lead", "scheduler_status", { taskId: "B" });
  assert.equal(detail.task.title, "独立验证接口");
  assert.equal(detail.task.specFile, "tasks/verify.md");
  assert.equal(detail.task.owner, "dev");
  assert.equal(detail.task.priority, 1);
  assert.deepEqual(detail.task.dependsOn, [{ taskId: "A" }]);
  assert.deepEqual(detail.task.resources, [{ path: "src/api.mjs", mode: "read" }]);
  const state = await h.snapshot();
  assert.equal(state.project.tasks.length, 2);
  assert.equal(state.progress.B.status, "pending");
  assert.deepEqual(state.runs, []);
});

test("非Lead、缺失或错误JSON修改被拒绝且状态字节不变", async t => {
  const h = await setup(t, [task("A", "dev")]);
  await h.call("lead", "scheduler_status");
  const before = await h.bytes();
  await assert.rejects(h.call("dev", "scheduler_manage", {
    action: "update-task", target: "A", changes: '{"title":"越权修改"}'
  }), /仅限 Lead/);
  await assert.rejects(h.manage({ action: "update-task", target: "A" }), /需要 changes JSON/);
  await assert.rejects(h.manage({ action: "update-task", target: "A", changes: "{broken" }), /JSON 格式错误/);
  await assert.rejects(h.manage({ action: "update-task", target: "A", changes: "[]" }));
  assert.deepEqual(await h.bytes(), before);
  assert.deepEqual(h.sent, []);
});

test("改为已完成前置后立即唤醒已等待并卸载的原专项会话", async t => {
  const h = await setup(t, [task("A", "dev"), task("G", "dev", ["A"]), task("B", "qa", ["G"])]);
  assert.equal((await h.next("qa")).waiting, true);
  const sessionId = h.unload("qa");
  const first = await h.next("dev");
  assert.equal(first.taskId, "A");
  await h.report("dev", first);
  assert.deepEqual(h.sent, []);
  const result = await h.update("B", { dependsOn: ["A"] });
  assert.equal(result.wakeups.errors.length, 0);
  assert.equal(result.wakeups.dispatched.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].taskId, "B");
  assert.equal(h.sent[0].target, sessionId);
  assert.equal(h.resume("qa"), sessionId);
  const resumed = await h.next("qa");
  assert.equal(resumed.dispatchId, h.sent[0].dispatchId);
  assert.equal(resumed.attemptId, h.sent[0].attemptId);
  assert.deepEqual((await h.snapshot()).project.tasks.find(task => task.id === "B").dependsOn, [{ taskId: "A" }]);
});

test("暂停中修改只更新任务，resume后才派发", async t => {
  const h = await setup(t, [task("A", "dev"), task("B", "qa", ["A"])]);
  await h.next("qa"); h.unload("qa");
  await h.manage({ action: "pause" });
  const result = await h.update("B", { dependsOn: [] });
  assert.deepEqual(result.wakeups.dispatched, []);
  assert.deepEqual(h.sent, []);
  const state = await h.snapshot();
  assert.equal(state.paused, true);
  assert.deepEqual(state.project.tasks.find(task => task.id === "B").dependsOn, []);
  assert.deepEqual(state.runs, []);
  await h.manage({ action: "resume" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].taskId, "B");
});

test("已领取任务拒绝修改，原委托和状态保持", async t => {
  const h = await setup(t, [task("A", "dev")]);
  const run = await h.next("dev");
  const before = await h.bytes();
  await assert.rejects(h.update("A", { title: "不能改动" }));
  assert.deepEqual(await h.bytes(), before);
  assert.equal((await h.snapshot()).runs[0].dispatchId, run.dispatchId);
  assert.deepEqual(h.sent, []);
});

test("手动派发模式下修改不自动派发，仍可由Lead派发", async t => {
  const h = await setup(t, [task("A", "dev"), task("B", "qa", ["A"])], false);
  await h.next("qa");
  const result = await h.update("B", { dependsOn: [] });
  assert.equal(result.wakeups, undefined);
  assert.deepEqual(h.sent, []);
  assert.deepEqual((await h.snapshot()).runs, []);
  await h.manage({ action: "dispatch", target: "qa" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].taskId, "B");
});
