import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { install } from "../harness/adapter.mjs";
import { FileStore } from "../dist/store/file-store.js";

function host() {
  const tools = new Map(), listeners = new Map(), sent = [];
  function agent(id) {
    const registrations = new Map(); tools.set(id, registrations);
    return { id, ctx: { tools: { register(tool) {
      registrations.set(tool.name, tool); return () => registrations.delete(tool.name);
    } } } };
  }
  const lead = agent("lead-session"), dev = agent("dev-session"), outsider = agent("other-session");
  const ctx = {
    agents: { list: () => [lead, dev, outsider] },
    agentTeams: {
      tryMembership: a => a === lead ? { root: lead, role: "lead", name: "lead" }
        : a === dev ? { root: lead, role: "teammate", name: "dev" } : { root: outsider, role: "lead", name: "lead" },
      sendMessage: async (caller, message) => { assert.equal(caller, lead); sent.push(message); },
      spawnTeammate: async () => { throw new Error("本场景没有启动模型"); }
    },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); }
  };
  return { tools, listeners, sent, ctx, lead, dev, outsider, agent };
}

const mockHost = () => ({ defineTool: t => t, z: { object: t => t, string: () => "string" } });

test("模拟宿主：单Lead派发、专项回执与结果提交；其他团队和越权管理拒绝", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-adapter-"));
  const h = host();
  const projectFile = join(dir, "project.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [{ id: "a" }, { id: "b", dependsOn: ["a"] }] }));
  const dispose = install(h.ctx, { leadSessionId: h.lead.id, projectFile, stateFile: join(dir, "state.json") }, mockHost());
  const call = async (a, name, args = {}) => JSON.parse((await h.tools.get(a.id).get(name).execute(args, { agent: a, signal: new AbortController().signal })).result);
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });

  assert.equal(h.tools.get(h.outsider.id).size, 0);
  await assert.rejects(call(h.dev, "scheduler_manage", { action: "pause" }), /仅限 Lead/);
  const d = await call(h.lead, "scheduler_manage", { action: "dispatch", target: "dev" });
  assert.equal(h.sent.length, 1);
  assert.ok(d.attemptId && d.permitId && d.dispatchId);
  await assert.rejects(call(h.dev, "scheduler_next", { dispatchId: "wrong" }), /不匹配/);
  const a = await call(h.dev, "scheduler_next");
  assert.equal(a.taskId, "a");
  assert.equal(a.phase, "active");
  assert.deepEqual(a.segment, d.segment);
  assert.deepEqual(a.checkpoints, d.checkpoints);
  assert.equal(a.stop, d.stop);
  assert.equal(a.startedAt, d.startedAt);
  assert.ok(Array.isArray(a.dependencies));
  assert.ok(a.segment && a.instructions);
  await call(h.dev, "scheduler_report", { dispatchId: d.dispatchId, summary: "a完成" });
  const b = await call(h.dev, "scheduler_next");
  assert.equal(b.taskId, "b");
  assert.equal(b.phase, "active");
  assert.ok(b.segment && b.instructions);
  assert.deepEqual(b.dependencies, [{ taskId: "a", summary: "a完成" }]);
  await call(h.dev, "scheduler_report", { dispatchId: b.dispatchId, summary: "b完成" });
  const status = await call(h.lead, "scheduler_status");
  assert.equal(status.tasks.b.status, "completed");
  await assert.rejects(call(h.dev, "scheduler_next", { dispatchId: d.dispatchId }), /旧委托/);
  await assert.rejects(h.tools.get(h.lead.id).get("scheduler_manage").execute({ action: "pause" }, { agent: h.outsider }), /另一个 Lead/);

  await dispose();
  assert.equal(h.tools.get(h.lead.id).size, 0);
  assert.equal(h.tools.get(h.dev.id).size, 0);
  const reopened = await FileStore.open(join(dir, "state.json"));
  await reopened.close();
});

test("自动绑定：首个Lead绑定后其他root不可见，成员首轮只等待派发", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-auto-"));
  const h = host();
  const projectFile = join(dir, "project.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [{ id: "a" }] }));
  const dispose = install(h.ctx, { leadSessionId: "auto", projectFile, stateFile: join(dir, "state.json") }, mockHost());
  const call = async (a, name, args = {}) => JSON.parse((await h.tools.get(a.id).get(name).execute(args, { agent: a, signal: new AbortController().signal })).result);
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });

  // auto 未绑定时四个工具只注册在 lead 角色上（含 outsider），成员不注册。
  assert.equal(h.tools.get(h.dev.id).size, 0);
  assert.equal(h.tools.get(h.outsider.id).size, 4);
  const first = await call(h.lead, "scheduler_status");
  assert.equal(first.revision, 0);
  assert.equal(h.tools.get(h.dev.id).size, 4);
  assert.equal(h.tools.get(h.outsider.id).size, 0);
  const waiting = await call(h.dev, "scheduler_next");
  assert.equal(waiting.waiting, true);
  assert.equal(h.tools.get(h.outsider.id).size, 0);
});

test("首次自动领取、重复确认与连续领取均返回活跃任务及直接前置上下文", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-context-host-"));
  const h = host(), projectFile = join(dir, "project.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [
    { id: "a", specFile: "cards.md#a", outputs: ["api"] },
    { id: "b", specFile: "cards.md#b", dependsOn: ["a"] }
  ] }));
  const dispose = install(h.ctx, { leadSessionId: h.lead.id, autoDispatch: true, projectFile, stateFile: join(dir, "state.json") }, mockHost());
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });
  const next = () => h.tools.get(h.dev.id).get("scheduler_next").execute({}, { agent: h.dev });
  const first = JSON.parse((await next()).result), again = JSON.parse((await next()).result);
  assert.deepEqual(again, first);
  assert.equal(first.phase, "active");
  assert.equal(first.specFile, first.task.specFile);
  assert.deepEqual(first.segment, ["a", "b"]);
  await h.tools.get(h.dev.id).get("scheduler_report").execute({ dispatchId: first.dispatchId, summary: "接口完成", outputs: '{"api":"api.md"}' }, { agent: h.dev });
  const second = JSON.parse((await next()).result);
  assert.equal(second.taskId, "b");
  assert.equal(second.phase, "active");
  assert.equal(second.specFile, "cards.md#b");
  assert.deepEqual(second.dependencies, [{ taskId: "a", outputs: { api: "api.md" }, summary: "接口完成" }]);
  assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
});

test("追加任务支持JSON文本和独立文件，单对象归一化；非法追加不写回", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-add-"));
  const h = host(), projectFile = join(dir, "project.json"), stateFile = join(dir, "state.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [{ id: "a" }] }));
  const dispose = install(h.ctx, { leadSessionId: h.lead.id, projectFile, stateFile }, mockHost());
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });
  const call = async (a, args) => JSON.parse((await h.tools.get(a.id).get("scheduler_manage").execute(args, { agent: a })).result);
  const add = args => call(h.lead, { action: "add-tasks", ...args });
  await assert.rejects(call(h.dev, { action: "add-tasks", tasks: '[{"id":"unauthorized"}]' }), /仅限 Lead/);
  assert.equal((await add({ tasks: '{"id":"b","dependsOn":["a"]}' })).added, 1);
  assert.equal((await add({ tasks: '[{"id":"c","dependsOn":["b"]},{"id":"d"}]' })).added, 2);
  await writeFile(join(dir, "extra.json"), '\uFEFF[{"id":"toString","dependsOn":["c"],"approval":true},{"id":"__proto__"}]');
  const result = await add({ tasksFile: "extra.json" });
  assert.equal(result.added, 2);
  const before = await readFile(stateFile, "utf8"), state = JSON.parse(before);
  assert.equal(state.revision, 3);
  assert.equal(state.progress.toString.status, "pending");
  assert.equal(state.progress.toString.approved, false);
  assert.equal(state.progress.__proto__.status, "pending");
  assert.equal(state.project.tasks.length, 6);
  assert.equal(state.history.filter(e => e.action === "add-tasks").length, 3);
  for (const [args, expected] of [
    [{}, /二选一/], [{ tasks: "[]" }, /非空/], [{ tasks: "null" }, /任务数组/],
    [{ tasks: "[broken" }, /JSON 格式错误/], [{ tasks: { id: "x" } }, /JSON 文本/],
    [{ tasks: '{"id":"x"}', tasksFile: "extra.json" }, /二选一/],
    [{ tasksFile: "missing.json" }, /追加任务文件未找到/],
    [{ tasks: '{"id":"a"}' }, /重复/],
    [{ tasks: '{"id":"x","dependsOn":["missing"]}' }, /缺少前置/],
    [{ tasks: '[{"id":"x","dependsOn":["y"]},{"id":"y","dependsOn":["x"]}]' }, /循环/]
  ]) {
    await assert.rejects(add(args), expected);
    assert.equal(await readFile(stateFile, "utf8"), before);
  }
});

test("初始化保持惰性，任务文件缺失或JSON损坏时可修正后再次调用", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-init-"));
  const h = host(), projectFile = join(dir, "project.json"), stateFile = join(dir, "state.json");
  const dispose = install(h.ctx, { leadSessionId: h.lead.id, projectFile, stateFile }, mockHost());
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });
  const status = () => h.tools.get(h.lead.id).get("scheduler_status").execute({}, { agent: h.lead });
  assert.equal(h.tools.get(h.lead.id).size, 4);
  await assert.rejects(readFile(stateFile), { code: "ENOENT" });
  await assert.rejects(status(), /任务文件未找到/);
  await writeFile(projectFile, "{broken");
  await assert.rejects(status(), /任务文件 JSON 格式错误/);
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [{ id: "a" }] }));
  assert.equal(JSON.parse((await status()).result).revision, 0);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).revision, 0);
});

test("状态损坏或路径冲突有可定位错误，原文件保留，初始化失败可正常释放", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-state-error-"));
  const h = host(), projectFile = join(dir, "project.json"), stateFile = join(dir, "state.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [{ id: "a" }] }));
  await writeFile(stateFile, "original-invalid-state");
  const dispose = install(h.ctx, { leadSessionId: h.lead.id, projectFile, stateFile }, mockHost());
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });
  const status = () => h.tools.get(h.lead.id).get("scheduler_status").execute({}, { agent: h.lead });
  await assert.rejects(status(), /状态存储无法打开.*state\.json/s);
  assert.equal(await readFile(stateFile, "utf8"), "original-invalid-state");
  await rm(stateFile);
  await mkdir(stateFile);
  await assert.rejects(status(), /状态存储路径不是可用文件/);
  await dispose();
  assert.equal(h.tools.get(h.lead.id).size, 0);
});

test("report工具拒绝无效引用，合法数组经JSON管道交付，已接受引用不可改写", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-artifact-host-"));
  const h = host(), projectFile = join(dir, "project.json"), stateFile = join(dir, "state.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [
    { id: "a", outputs: ["api"], review: true }, { id: "b", dependsOn: [{ taskId: "a", output: "api" }] }
  ] }));
  const dispose = install(h.ctx, { leadSessionId: h.lead.id, autoDispatch: true, projectFile, stateFile }, mockHost());
  t.after(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });
  const call = async (agent, name, args = {}) => JSON.parse((await h.tools.get(agent.id).get(name).execute(args, { agent })).result);
  const a = await call(h.dev, "scheduler_next"), before = await readFile(stateFile, "utf8");
  for (const outputs of ['{"api":null}', 'null', '[]', '{"api":" "}']) {
    await assert.rejects(call(h.dev, "scheduler_report", { dispatchId: a.dispatchId, summary: "无效", outputs }), /outputs|引用/);
    assert.equal(await readFile(stateFile, "utf8"), before);
  }
  const outputs = '{"api":["tests/core.test.mjs","tests/cli.test.mjs"]}';
  await call(h.dev, "scheduler_report", { dispatchId: a.dispatchId, status: "checkpoint", summary: "测试列表", outputs });
  await call(h.lead, "scheduler_manage", { action: "accept", target: "a", output: "api" });
  await call(h.dev, "scheduler_report", { dispatchId: a.dispatchId, status: "checkpoint", summary: "同一列表", outputs });
  const accepted = await readFile(stateFile, "utf8");
  assert.equal(JSON.parse(accepted).progress.a.outputs.api.accepted, true);
  await assert.rejects(call(h.dev, "scheduler_report", { dispatchId: a.dispatchId, status: "completed", summary: "改写",
    outputs: '{"api":"different.mjs"}' }), /已被接受/);
  assert.equal(await readFile(stateFile, "utf8"), accepted);
  await call(h.dev, "scheduler_report", { dispatchId: a.dispatchId, summary: "完成" });
  await call(h.lead, "scheduler_manage", { action: "accept", target: "a" });
  const b = await call(h.dev, "scheduler_next");
  assert.deepEqual(b.dependencies[0].reference, JSON.parse(outputs).api);
});
