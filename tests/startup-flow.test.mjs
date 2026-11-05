import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { install } from "../harness/adapter.mjs";

const project = () => ({
  name: "显式启动示例",
  agents: [{ id: "dev", categories: ["开发"] }, { id: "qa", categories: ["测试"] }],
  tasks: [
    { id: "A1", category: "开发", owner: "dev", outputs: ["api"] },
    { id: "B1", category: "测试", owner: "qa", dependsOn: ["A1"] }
  ]
});

const names = rows => rows.map(row => typeof row === "string" ? row : row.id ?? row.name).sort();

async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), "scheduler-startup-"));
  const tools = new Map(), listeners = new Map(), memberships = new WeakMap();
  const members = new Map(), agents = new Map(), live = [], sent = [], spawns = [];
  function makeAgent(id) {
    const table = new Map(); tools.set(id, table);
    return { id, session: { header: { cwd: workspace } }, ctx: { tools: { register(definition) {
      table.set(definition.name, definition); return () => table.delete(definition.name);
    } } } };
  }
  const lead = makeAgent("lead-session"), other = makeAgent("other-lead");
  live.push(lead, other);
  memberships.set(lead, { root: lead, name: "lead", role: "lead" });
  memberships.set(other, { root: other, name: "lead", role: "lead" });
  function addMember(name, root = lead) {
    const agent = makeAgent(`${name}-session`);
    agents.set(name, agent);
    members.set(name, { id: agent.id, name, role: "teammate", status: "running" });
    memberships.set(agent, { root, name, role: "teammate" });
    live.push(agent);
    listeners.get("agent/created")?.({ agent });
    return agent;
  }
  function resume(name) {
    const member = members.get(name), agent = makeAgent(member.id);
    agents.set(name, agent);
    memberships.set(agent, { root: lead, name, role: "teammate" });
    member.status = "running";
    live.push(agent);
    listeners.get("agent/created")?.({ agent });
    return agent;
  }
  const ctx = {
    agents: { list: () => live },
    agentTeams: {
      tryMembership: agent => live.includes(agent) ? memberships.get(agent) : undefined,
      listMembers: root => {
        assert.equal(root, lead);
        return [...members.values()];
      },
      spawnTeammate: async (caller, options) => {
        assert.equal(caller, lead);
        assert.ok(!members.has(options.name));
        spawns.push(options);
        return addMember(options.name);
      },
      sendMessage: async (caller, message) => {
        let delivery;
        try { delivery = JSON.parse(message.content[0].text); } catch { return; }
        if (!delivery.dispatchId) return;
        assert.equal(caller, lead);
        const member = [...members.values()].find(row => row.name === message.target || row.id === message.target);
        assert.ok(member, "委托必须投给已创建的持久成员");
        sent.push({ ...delivery, target: message.target, sessionId: member.id });
        if (member.status === "inactive") resume(member.name);
      }
    },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); }
  };
  const dispose = install(ctx, { onDemand: true }, { defineTool: value => value });
  t.after(async () => { await dispose(); await rm(workspace, { recursive: true, force: true }); });
  const agent = name => name === "lead" ? lead : name === "other" ? other : agents.get(name);
  const call = async (name, tool, args = {}) => JSON.parse((await tools.get(agent(name).id).get(tool).execute(args, {
    agent: agent(name), signal: new AbortController().signal
  })).result);
  const paths = { projectFile: join(workspace, ".scheduler/tasks.json"), stateFile: join(workspace, ".scheduler/state.json"),
    graphFile: join(workspace, ".scheduler/flow.html") };
  return {
    workspace, paths, lead, other, tools, sent, spawns, call, dispose, addMember, ctx,
    manage: args => call("lead", "scheduler_manage", args),
    next: (name, readySummary) => call(name, "scheduler_next", readySummary === undefined ? {} : { readySummary }),
    load: args => call("lead", "scheduler_manage", { action: "load", ...args }),
    prepare: value => call("lead", "scheduler_manage", { action: "prepare", project: JSON.stringify(value ?? project()) }),
    state: async () => JSON.parse(await readFile(paths.stateFile, "utf8")),
    spawn: async name => call("lead", "scheduler_manage", { action: "spawn", target: name }),
    unloadMember: name => {
      const current = agents.get(name);
      live.splice(live.indexOf(current), 1);
      members.get(name).status = "inactive";
      listeners.get("agent/disposed")?.({ agent: current });
      return current.id;
    }
  };
}

test("待机仅提供启动管理入口，普通调用不创建任务文件或占住其他Lead", async t => {
  const h = await setup(t);
  assert.deepEqual([...h.tools.get(h.lead.id).keys()], ["scheduler_manage"]);
  assert.deepEqual([...h.tools.get(h.other.id).keys()], ["scheduler_manage"]);
  assert.deepEqual(await readdir(h.workspace), []);
  await assert.rejects(h.manage({ action: "dispatch", target: "dev" }));
  assert.deepEqual(await readdir(h.workspace), []);
  const loaded = await h.call("other", "scheduler_manage", { action: "load", workspace: h.workspace });
  assert.equal(loaded.startup.phase, "planning");
  assert.equal(h.tools.get(h.lead.id).size, 0);
  assert.deepEqual(await readdir(h.workspace), []);
});

test("加载时使用当前会话工作区并绑定Lead，先给路径和规划指引", async t => {
  const h = await setup(t);
  const staleTool = h.tools.get(h.other.id).get("scheduler_manage");
  const loaded = await h.load();
  assert.equal(loaded.startup.phase, "planning");
  assert.deepEqual(loaded.paths, h.paths);
  assert.deepEqual(await readdir(h.workspace), []);
  await assert.rejects(staleTool.execute({ action: "load" }, {
    agent: h.other, signal: new AbortController().signal
  }));
  assert.equal(h.tools.get(h.other.id).size, 0);
});

test("准备计划生成任务JSON和HTML，返回实际成员数量，运行保持暂停", async t => {
  const h = await setup(t);
  await h.load();
  const prepared = await h.prepare();
  assert.equal(prepared.startup.phase, "waiting");
  assert.equal(prepared.agentCount, 2);
  assert.deepEqual(names(prepared.agents), ["dev", "qa"]);
  assert.deepEqual(names(prepared.waitingForAgents), ["dev", "qa"]);
  const saved = JSON.parse(await readFile(h.paths.projectFile, "utf8"));
  assert.equal(saved.name, "显式启动示例");
  assert.deepEqual(saved.agents.map(row => row.id), ["dev", "qa"]);
  assert.match(await readFile(h.paths.graphFile, "utf8"), /A1/);
  const state = await h.state();
  assert.equal(state.paused, true);
  assert.deepEqual(state.runs, []);
  assert.ok(Object.values(state.progress).every(row => row.status === "pending"));
  const bytes = await readFile(h.paths.stateFile);
  await assert.rejects(h.manage({ action: "dispatch", target: "dev" }));
  await assert.rejects(h.manage({ action: "resume" }));
  assert.deepEqual(await readFile(h.paths.stateFile), bytes);
});

test("spawn成功和无摘要next都不算就绪，部分成员回复后仍不启动", async t => {
  const h = await setup(t);
  await h.load(); await h.prepare();
  await h.spawn("dev"); await h.spawn("qa");
  assert.equal(h.spawns.length, 2);
  assert.deepEqual(h.sent, []);
  assert.deepEqual((await h.state()).runs, []);
  const pending = await h.next("dev");
  assert.equal(pending.waiting, true);
  const partlyReady = await h.next("qa", "我负责独立测试，已就绪");
  assert.equal(partlyReady.waiting, true);
  assert.deepEqual(h.sent, []);
  assert.equal((await h.state()).paused, true);
  assert.deepEqual((await h.state()).runs, []);
});

test("已有计划不会被prepare覆盖，卸载后可不传project恢复原文件", async t => {
  const h = await setup(t);
  await h.load(); await h.prepare();
  const tasks = await readFile(h.paths.projectFile), state = await readFile(h.paths.stateFile);
  await assert.rejects(h.prepare({ ...project(), name: "不能覆盖的另一项目" }));
  assert.deepEqual(await readFile(h.paths.projectFile), tasks);
  assert.deepEqual(await readFile(h.paths.stateFile), state);
  await h.manage({ action: "unload" });
  await h.load();
  const restored = await h.manage({ action: "prepare" });
  assert.equal(restored.startup.phase, "waiting");
  assert.equal(restored.agentCount, 2);
  assert.deepEqual(await readFile(h.paths.projectFile), tasks);
  assert.deepEqual((await h.state()).runs, []);
});

test("全体真实成员回复后自动派发一次，重复就绪不重复创建运行", async t => {
  const h = await setup(t);
  await h.load(); await h.prepare();
  await h.spawn("dev"); await h.spawn("qa");
  await h.next("dev", "我负责开发接口，已就绪");
  const last = await h.next("qa", "我负责独立测试，已就绪");
  assert.equal(last.startup.phase, "running");
  const first = await h.state();
  assert.equal(first.paused, false);
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].taskId, "A1");
  assert.equal(first.runs[0].agentId, "dev");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].sessionId, "dev-session");
  await h.next("qa", "我负责独立测试，已就绪");
  const run = await h.next("dev", "我负责开发接口，已就绪");
  assert.equal(run.dispatchId, first.runs[0].dispatchId);
  assert.equal((await h.state()).runs.length, 1);
  assert.equal(h.sent.length, 1);
});

test("其他团队和未声明成员不能凑齐准备人数", async t => {
  const h = await setup(t);
  const staleOther = h.tools.get(h.other.id).get("scheduler_manage");
  await h.load(); await h.prepare();
  await h.spawn("dev"); await h.spawn("qa");
  h.addMember("unplanned");
  await assert.rejects(h.next("unplanned", "我也准备好了"));
  await assert.rejects(staleOther.execute({ action: "resume" }, {
    agent: h.other, signal: new AbortController().signal
  }));
  await h.next("dev", "我负责开发接口，已就绪");
  assert.deepEqual((await h.state()).runs, []);
  assert.equal((await h.state()).paused, true);
  assert.deepEqual(h.sent, []);
});

test("先就绪的成员自然卸载后仍以原Session被自动唤醒", async t => {
  const h = await setup(t);
  await h.load(); await h.prepare();
  await h.spawn("dev"); await h.spawn("qa");
  await h.next("dev", "我负责开发接口，已就绪");
  const sessionId = h.unloadMember("dev");
  await h.next("qa", "我负责独立测试，已就绪");
  assert.equal(h.spawns.length, 2);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].sessionId, sessionId);
  const run = await h.next("dev");
  assert.equal(run.taskId, "A1");
  assert.equal(run.dispatchId, h.sent[0].dispatchId);
  assert.equal((await h.state()).runs.length, 1);
});

test("卸载需先结束运行，保留交付文件与运行历史并恢复待机入口", async t => {
  const h = await setup(t);
  await h.load(); await h.prepare();
  await h.spawn("dev"); await h.spawn("qa");
  await h.next("dev", "我负责开发接口，已就绪");
  await h.next("qa", "我负责独立测试，已就绪");
  await assert.rejects(h.manage({ action: "unload" }));
  const contract = join(h.workspace, "contract.md");
  await writeFile(contract, "已接受接口\n", "utf8");
  const dev = await h.next("dev");
  await h.call("dev", "scheduler_report", { dispatchId: dev.dispatchId,
    summary: "接口完成", outputs: '{"api":"contract.md"}' });
  const qa = await h.next("qa");
  await h.call("qa", "scheduler_report", { dispatchId: qa.dispatchId, summary: "独立测试完成" });
  const before = await readFile(h.paths.stateFile);
  const output = await h.manage({ action: "unload" });
  assert.equal(output.startup.phase, "standby");
  assert.deepEqual(await readFile(h.paths.stateFile), before);
  await access(h.paths.projectFile);
  await access(h.paths.graphFile);
  assert.equal(await readFile(contract, "utf8"), "已接受接口\n");
  assert.deepEqual([...h.tools.get(h.lead.id).keys()], ["scheduler_manage"]);
  assert.deepEqual([...h.tools.get(h.other.id).keys()], ["scheduler_manage"]);
  assert.equal(h.tools.get("dev-session").size, 0);
  const state = JSON.parse(before);
  assert.equal(state.runs.length, 2);
  assert.ok(state.runs.every(run => run.phase === "finished"));
  assert.equal(state.progress.A1.outputs.api.reference, "contract.md");
});

test("插件释放后保存的旧工具引用不能重新加载或准备计划", async t => {
  const h = await setup(t);
  const stale = h.tools.get(h.lead.id).get("scheduler_manage");
  await h.dispose();
  const context = { agent: h.lead, signal: new AbortController().signal };
  await assert.rejects(stale.execute({ action: "load", workspace: h.workspace }, context));
  await assert.rejects(stale.execute({ action: "prepare", project: JSON.stringify(project()) }, context));
  assert.deepEqual(await readdir(h.workspace), []);
  assert.equal(h.tools.get(h.lead.id).size, 0);
});

test("异步解析工作目录时两个Lead竞争，只有一个能完成绑定", async t => {
  const h = await setup(t);
  let releaseDirectory, entered = 0;
  const directory = new Promise(resolve => { releaseDirectory = resolve; });
  h.ctx.get = name => name === "workingDirectory" ? { ensure: async () => {
    entered++;
    await directory;
    return h.workspace;
  } } : undefined;
  const first = h.load();
  const second = h.call("other", "scheduler_manage", { action: "load" });
  const pendingCount = entered;
  releaseDirectory();
  const results = await Promise.allSettled([first, second]);
  assert.equal(pendingCount, 2);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(results.find(result => result.status === "fulfilled").value.startup.phase, "planning");
  assert.equal([h.lead, h.other].filter(agent => h.tools.get(agent.id).size > 0).length, 1);
  assert.deepEqual(await readdir(h.workspace), []);
});

test("另一个工具仍在等待宿主返回时拒绝卸载，保留可继续使用的状态存储", async t => {
  const h = await setup(t);
  await h.load(); await h.prepare();
  let releaseSpawn, enteredSpawn;
  const pendingSpawn = new Promise(resolve => { releaseSpawn = resolve; });
  const entered = new Promise(resolve => { enteredSpawn = resolve; });
  const spawn = h.ctx.agentTeams.spawnTeammate;
  h.ctx.agentTeams.spawnTeammate = async (...args) => {
    enteredSpawn();
    await pendingSpawn;
    return spawn(...args);
  };
  const spawning = h.spawn("dev");
  await entered;
  const before = await readFile(h.paths.stateFile);
  try {
    await assert.rejects(h.manage({ action: "unload" }));
    assert.deepEqual(await readFile(h.paths.stateFile), before);
  } finally {
    releaseSpawn();
    await spawning;
  }
  const ready = await h.next("dev", "我负责开发接口，已就绪");
  assert.equal(ready.startup.phase, "waiting");
  h.ctx.agentTeams.spawnTeammate = spawn;
  await h.spawn("qa");
  await h.next("qa", "我负责独立测试，已就绪");
  assert.equal((await h.state()).runs.length, 1);
  const run = await h.next("dev");
  assert.equal(run.taskId, "A1");
});
