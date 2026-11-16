import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { install } from "../harness/adapter.mjs";

const taskOwner = "worker";
const occupied = /占用|已绑定|正在使用|另一.*主会话/u;

async function setup(t, configure = () => ({})) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-workspaces-"));
  let dispose;
  t.after(async () => {
    try { await dispose?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const workspaceA = join(directory, "a"), workspaceB = join(directory, "b");
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);

  const live = [], listeners = new Map(), memberships = new Map(), rosters = new Map();
  const sent = [];
  function makeAgent(id, cwd, root) {
    const tools = new Map();
    const agent = {
      id, tools, session: { header: { cwd } },
      ctx: { tools: { register(definition) {
        tools.set(definition.name, definition);
        return () => {
          if (tools.get(definition.name) === definition) tools.delete(definition.name);
        };
      } } }
    };
    live.push(agent);
    if (root) memberships.set(agent, { root, name: taskOwner, role: "teammate" });
    else {
      memberships.set(agent, { root: agent, name: "lead", role: "lead" });
      rosters.set(agent, []);
    }
    listeners.get("agent/created")?.({ agent });
    return agent;
  }
  const leadA = makeAgent("lead-a", workspaceA);
  const leadB = makeAgent("lead-b", workspaceB);
  const sameWorkspaceLead = makeAgent("lead-a-alternate", workspaceA);
  const ctx = {
    agents: { list: () => live },
    get: name => name === "workingDirectory" ? { ensure: async agent => agent.session.header.cwd } : undefined,
    agentTeams: {
      tryMembership: agent => memberships.get(agent),
      listMembers: root => rosters.get(root),
      spawnTeammate: async (caller, { name }) => {
        assert.equal(name, taskOwner);
        const id = `${caller.id}-${name}`;
        rosters.get(caller).push({ id, name, role: "teammate", status: "running" });
        return makeAgent(id, caller.session.header.cwd, caller);
      },
      sendMessage: async (caller, message) => {
        const member = rosters.get(caller).find(row => row.name === message.target || row.id === message.target);
        assert.ok(member, "委托必须发送给该 Lead 团队的成员");
        const delivery = JSON.parse(message.content[0].text);
        sent.push({ lead: caller.id, recipient: member.id, ...delivery });
      }
    },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); }
  };
  dispose = install(ctx, { onDemand: true, ...configure(directory) }, { defineTool: value => value });
  async function call(agent, name, args = {}) {
    const tool = agent.tools.get(name);
    assert.ok(tool, `${agent.id} 应能调用 ${name}`);
    const reply = await tool.execute(args, { agent, signal: new AbortController().signal });
    return JSON.parse(reply.result);
  }
  const manage = (agent, action, args) => call(agent, "scheduler_manage", { action, ...args });
  return { directory, workspaceA, workspaceB, leadA, leadB, sameWorkspaceLead, live, sent, call, manage, dispose };
}

function project(taskId) {
  return {
    name: taskId,
    agents: [{ id: taskOwner }],
    tasks: [{ id: taskId, owner: taskOwner }]
  };
}

test("两个工作区独立派发，另一 Lead 无法抢占同一工作区，卸载后可接手", async t => {
  const { workspaceA, workspaceB, leadA, leadB, sameWorkspaceLead, live, sent, call, manage } = await setup(t);
  const [a, b] = await Promise.all([manage(leadA, "load"), manage(leadB, "load")]);
  assert.equal(a.startup.phase, "planning");
  assert.equal(b.startup.phase, "planning");
  assert.equal(a.paths.stateFile, join(workspaceA, ".scheduler/state.json"));
  assert.equal(b.paths.stateFile, join(workspaceB, ".scheduler/state.json"));
  assert.deepEqual([...sameWorkspaceLead.tools.keys()], ["scheduler_manage"]);
  await assert.rejects(manage(sameWorkspaceLead, "load"), occupied);
  assert.deepEqual(await readdir(workspaceA), []);
  assert.deepEqual(await readdir(workspaceB), []);

  await Promise.all([
    manage(leadA, "prepare", { project: JSON.stringify(project("A1")) }),
    manage(leadB, "prepare", { project: JSON.stringify(project("B1")) })
  ]);
  await Promise.all([
    manage(leadA, "spawn", { target: taskOwner }),
    manage(leadB, "spawn", { target: taskOwner })
  ]);
  const agentA = live.find(agent => agent.id === "lead-a-worker");
  const agentB = live.find(agent => agent.id === "lead-b-worker");
  await Promise.all([
    call(agentA, "scheduler_next", { readySummary: "A 已就绪" }),
    call(agentB, "scheduler_next", { readySummary: "B 已就绪" })
  ]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(run => [run.lead, run.recipient, run.taskId]).sort(), [
    [leadA.id, agentA.id, "A1"], [leadB.id, agentB.id, "B1"]
  ]);

  const runA = await call(agentA, "scheduler_next");
  const runB = await call(agentB, "scheduler_next");
  assert.equal(runA.task?.id ?? runA.taskId, "A1");
  assert.equal(runB.task?.id ?? runB.taskId, "B1");
  await assert.rejects(call(agentB, "scheduler_report", { dispatchId: runA.dispatchId, summary: "错报" }));
  await assert.rejects(manage(leadA, "unload"), /未结束/u);

  const aBefore = await readFile(a.paths.stateFile);
  await call(agentB, "scheduler_report", { dispatchId: runB.dispatchId, summary: "B 完成" });
  assert.equal((await manage(leadB, "unload")).startup.phase, "standby");
  assert.deepEqual(await readFile(a.paths.stateFile), aBefore);
  assert.match(await readFile(a.paths.graphFile, "utf8"), /A1/u);
  assert.match(await readFile(b.paths.graphFile, "utf8"), /B1/u);
  assert.equal((await call(leadA, "scheduler_status")).startup.phase, "running");
  const bState = JSON.parse(await readFile(b.paths.stateFile, "utf8"));
  assert.equal(bState.progress.B1.status, "completed");

  await call(agentA, "scheduler_report", { dispatchId: runA.dispatchId, summary: "A 完成" });
  assert.equal((await manage(leadA, "unload")).startup.phase, "standby");
  const reloaded = await manage(sameWorkspaceLead, "load");
  assert.equal(reloaded.startup.phase, "planning");
  assert.deepEqual(reloaded.paths, a.paths);
  await manage(sameWorkspaceLead, "prepare");
  const details = await call(sameWorkspaceLead, "scheduler_status", { taskId: "A1" });
  assert.equal(details.progress.status, "completed");
  assert.equal(details.runs[0].dispatchId, runA.dispatchId);
  assert.equal(details.runs[0].phase, "finished");
});

test("绝对状态文件路径跨工作区冲突时不能同时绑定", async t => {
  const { workspaceA, workspaceB, leadA, leadB, manage } = await setup(t, directory => ({
    stateFile: join(directory, "shared-state.json"),
    graphFile: ".scheduler/flow.html"
  }));
  const a = await manage(leadA, "load");
  await assert.rejects(manage(leadB, "load"), occupied);
  assert.deepEqual(await readdir(workspaceA), []);
  assert.deepEqual(await readdir(workspaceB), []);
  assert.equal((await manage(leadA, "unload")).startup.phase, "standby");
  const b = await manage(leadB, "load");
  assert.equal(b.startup.phase, "planning");
  assert.equal(b.paths.stateFile, a.paths.stateFile);
  assert.notEqual(b.paths.graphFile, a.paths.graphFile);
});

test("同一实际工作区的目录链接不能重复绑定", async t => {
  const { directory, workspaceA, leadA, leadB, manage } = await setup(t);
  const alias = join(directory, "alias-to-a");
  await symlink(workspaceA, alias, process.platform === "win32" ? "junction" : "dir");
  await manage(leadA, "load");
  await assert.rejects(manage(leadB, "load", { workspace: alias }), occupied);
  const broken = join(directory, "broken-alias");
  await symlink(join(directory, "missing-target"), broken, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(manage(leadB, "load", { workspace: broken }), /链接的目标不存在/u);
  assert.equal((await manage(leadB, "load")).startup.phase, "planning");
});

test("停用插件释放所有工作区的状态锁并保留项目记录", async t => {
  const { leadA, leadB, manage, dispose } = await setup(t);
  const [a, b] = await Promise.all([manage(leadA, "load"), manage(leadB, "load")]);
  await Promise.all([
    manage(leadA, "prepare", { project: JSON.stringify(project("A1")) }),
    manage(leadB, "prepare", { project: JSON.stringify(project("B1")) })
  ]);
  const snapshots = await Promise.all([a, b].map(binding => readFile(binding.paths.stateFile)));
  await Promise.all([a, b].map(binding => access(binding.paths.stateFile + ".lock")));
  await dispose();
  for (const [index, binding] of [a, b].entries()) {
    await assert.rejects(access(binding.paths.stateFile + ".lock"), { code: "ENOENT" });
    assert.deepEqual(await readFile(binding.paths.stateFile), snapshots[index]);
    await access(binding.paths.projectFile);
    await access(binding.paths.graphFile);
  }
  assert.equal(leadA.tools.size, 0);
  assert.equal(leadB.tools.size, 0);
});
