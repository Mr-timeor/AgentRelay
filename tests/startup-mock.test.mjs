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
