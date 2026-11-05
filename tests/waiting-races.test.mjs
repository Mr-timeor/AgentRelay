import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { install } from "../harness/adapter.mjs";

async function setup(t, tasks, autoDispatch = true) {
  const folder = await mkdtemp(join(tmpdir(), "scheduler-waiting-races-"));
  const registrations = new Map(), members = new Map(), sent = [];
  const makeAgent = id => {
    const tools = new Map(); registrations.set(id, tools);
    return { id, ctx: { tools: { register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    } } } };
  };
  const lead = makeAgent("lead");
  for (const name of ["dev", "qa"]) members.set(name, makeAgent(name));
  const live = [lead, ...members.values()];
  let sendHook;
  const ctx = {
    agents: { list: () => live },
    agentTeams: {
      tryMembership: agent => agent === lead ? { root: lead, name: "lead", role: "lead" }
        : live.includes(agent) ? { root: lead, name: agent.id, role: "teammate" } : undefined,
      listMembers: () => [...members].map(([name, agent]) => ({ id: agent.id, name, status: "inactive" })),
      sendMessage: async (_caller, message) => {
        sent.push({ target: message.target, ...JSON.parse(message.content[0].text) });
        await sendHook?.(message);
      }
    },
    on: () => () => {}
  };
  const projectFile = join(folder, "project.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }, { id: "qa" }], tasks }));
  const dispose = install(ctx, { projectFile, stateFile: join(folder, "state.json"), leadSessionId: "lead", autoDispatch },
    { defineTool: value => value });
  t.after(async () => { await dispose(); await rm(folder, { recursive: true, force: true }); });
  const call = async (name, tool, args = {}) => JSON.parse((await registrations.get(name).get(tool).execute(args, {
    agent: name === "lead" ? lead : members.get(name), signal: new AbortController().signal
  })).result);
  return { sent, call,
    next: name => call(name, "scheduler_next"),
    status: () => call("lead", "scheduler_status"),
    manage: args => call("lead", "scheduler_manage", args),
    report: (name, run) => call(name, "scheduler_report", { dispatchId: run.dispatchId, summary: "完成" }),
    sendHook: value => { sendHook = value; }
  };
}

test("提前手动派发失败仍保留等待，前置完成后照常自动唤醒", async t => {
  const h = await setup(t, [{ id: "A", owner: "dev" }, { id: "B", owner: "qa", dependsOn: ["A"] }]);
  const a = await h.next("dev");
  assert.equal((await h.next("qa")).waiting, true);
  await assert.rejects(h.manage({ action: "dispatch", target: "qa" }), /暂无可启动任务/);
  assert.deepEqual((await h.status()).waitingAgents, ["qa"]);
  await h.report("dev", a);
  assert.deepEqual(h.sent.map(run => run.taskId), ["B"]);
  assert.equal((await h.next("qa")).taskId, "B");
});

test("暂停时手动派发失败不取消等待，恢复后只唤醒一次", async t => {
  const h = await setup(t, [{ id: "A", owner: "qa" }]);
  await h.manage({ action: "pause" });
  assert.equal((await h.next("qa")).waiting, true);
  await assert.rejects(h.manage({ action: "dispatch", target: "qa" }), /暂无可启动任务/);
  assert.deepEqual((await h.status()).waitingAgents, ["qa"]);
  await h.manage({ action: "resume" });
  assert.deepEqual(h.sent.map(run => run.taskId), ["A"]);
  assert.deepEqual((await h.status()).waitingAgents, []);
});

test("并发领取共享任务的落后成员返回waiting，后续任务就绪可自动唤醒", async t => {
  const h = await setup(t, [{ id: "A" }]);
  await h.status();
  // 同一轮发起两个next：两者在首个异步状态写入提交前都看到A就绪。
  const names = ["dev", "qa"], results = await Promise.all(names.map(name => h.next(name)));
  const winner = results.findIndex(result => result.taskId === "A"), loser = results.findIndex(result => result.waiting);
  assert.notEqual(winner, -1); assert.notEqual(loser, -1);
  assert.deepEqual((await h.status()).waitingAgents, [names[loser]]);
  await h.manage({ action: "add-tasks", tasks: JSON.stringify({ id: "B", owner: names[loser], dependsOn: ["A"] }) });
  await h.report(names[winner], results[winner]);
  assert.deepEqual(h.sent.map(run => ({ taskId: run.taskId, agentId: run.agentId })), [{ taskId: "B", agentId: names[loser] }]);
  assert.equal((await h.next(names[loser])).taskId, "B");
});

test("手动派发已形成unknown运行时不恢复等待或重复投递", async t => {
  const h = await setup(t, [{ id: "A", owner: "qa" }], false);
  assert.equal((await h.next("qa")).waiting, true);
  h.sendHook(async () => { throw new Error("投递结果未知"); });
  await h.manage({ action: "dispatch", target: "qa" });
  await assert.rejects(h.manage({ action: "dispatch", target: "qa" }), /暂无可启动任务/);
  const status = await h.status();
  assert.deepEqual(status.waitingAgents, []);
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].phase, "unknown");
  assert.equal(h.sent.length, 1);
});
