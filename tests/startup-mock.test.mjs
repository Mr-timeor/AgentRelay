import test from "node:test";
import assert from "node:assert/strict";
import { decideStartup } from "./host/mock-startup.mjs";

const prompt = { role: "user", content: "你是专项执行者tester。先回复分工与准备情况。" };
function response(name, args, result) {
  return [
    { role: "assistant", tool_calls: [{ id: "current", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: "current", content: JSON.stringify({ result: JSON.stringify(result) }) }
  ];
}

test("启动mock先回复就绪，waiting和尾部宿主通知不触发重复就绪", () => {
  const ready = decideStartup([prompt]);
  assert.equal(ready.tool, "scheduler_next");
  assert.ok(ready.args.readySummary);
  const waiting = [prompt, ...response(ready.tool, ready.args, { waiting: true })];
  assert.equal(decideStartup(waiting).tool, undefined);
  assert.equal(decideStartup([...waiting, { role: "user", content: "<system-reminder>宿主通知</system-reminder>" }]).tool, undefined);
  assert.equal(decideStartup([...waiting, { role: "assistant", content: "已就绪" }, { role: "user", content: "普通通知" }]).tool, undefined);
});

test("启动mock只响应当前正式委托，成功领取和交付后继续原闭环", () => {
  const messages = [prompt, ...response("scheduler_next", { readySummary: "已就绪" }, { waiting: true }),
    { role: "assistant", content: "等待" },
    { role: "user", content: 'Team message from lead: {"taskId":"Q1","dispatchId":"dispatch-q1"}' }];
  assert.deepEqual(decideStartup(messages), { tool: "scheduler_next", args: { dispatchId: "dispatch-q1" } });
  const claimed = [...messages, ...response("scheduler_next", { dispatchId: "dispatch-q1" }, { taskId: "Q1", dispatchId: "dispatch-q1" })];
  const report = decideStartup(claimed);
  assert.equal(report.tool, "scheduler_report");
  assert.equal(report.args.dispatchId, "dispatch-q1");
  assert.deepEqual(decideStartup([...claimed, ...response(report.tool, report.args, { taskId: "Q1", state: { status: "completed" } })]),
    { tool: "scheduler_next", args: {} });
  assert.equal(decideStartup([...claimed, ...response(report.tool, report.args, { error: "失败" })]).tool, undefined);
});

test("启动mock的Lead通知只返回文字", () => {
  assert.equal(decideStartup([{ role: "user", content: "成员已完成" }]).tool, undefined);
});

test("启动mock让Lead经真实工具管道逐次load和prepare，不对同一命令循环调用", () => {
  const command = args => ({ role: "user", content: "AGENTRELAY_PROBE_COMMAND:" + JSON.stringify({
    id: args.action, tool: "scheduler_manage", args
  }) });
  const load = { action: "load" }, prepare = { action: "prepare", project: '{"tasks":[],"agents":[]}' };
  const initial = [command(load)];
  assert.deepEqual(decideStartup(initial), { tool: "scheduler_manage", args: load });
  const loaded = [...initial, ...response("scheduler_manage", load, { startup: { phase: "planning" } })];
  assert.equal(decideStartup(loaded).tool, undefined);
  assert.deepEqual(decideStartup([...loaded, { role: "assistant", content: "已加载" }, command(prepare)]),
    { tool: "scheduler_manage", args: prepare });
  assert.equal(decideStartup([...loaded, { role: "assistant", content: "已加载" }, { role: "user", content: "普通通知" }]).tool, undefined);
});

test("维护版启动mock显式提交文件证据，待验收后进入等待且不循环提交", () => {
  const developer = { role: "user", content: "你是专项执行者developer。先回复分工与准备情况。" };
  const claimed = [developer, ...response("scheduler_next", {}, { taskId: "A1", dispatchId: "a1" })];
  const report = decideStartup(claimed, { fileEvidence: true });
  assert.equal(report.tool, "scheduler_report");
  assert.deepEqual(JSON.parse(report.args.files), { api: ["mock-api.md"] });
  const reviewed = [...claimed, ...response("scheduler_report", report.args, { taskId: "A1", state: { status: "review" } })];
  assert.deepEqual(decideStartup(reviewed, { fileEvidence: true }), { tool: "scheduler_next", args: {} });
  assert.equal(decideStartup([...reviewed, ...response("scheduler_next", {}, { waiting: true })], { fileEvidence: true }).tool, undefined);
});

test("宿主在probe命令后追加上下文时仍识别原命令，执行后通知不触发重放", () => {
  const args = { action: "load" };
  const messages = [{ role: "user", content: "AGENTRELAY_PROBE_COMMAND:" + JSON.stringify({ tool: "scheduler_manage", args }) },
    { role: "user", content: "当前工作区已准备好，这是宿主追加的上下文。" }];
  assert.deepEqual(decideStartup(messages), { tool: "scheduler_manage", args });
  const completed = [...messages, ...response("scheduler_manage", args, { startup: { phase: "planning" } }),
    { role: "user", content: "成员状态通知" }];
  assert.equal(decideStartup(completed).tool, undefined);
});
