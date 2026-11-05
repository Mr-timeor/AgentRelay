import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "./host/mock-llm.mjs";

const call = (name, args = {}) => ({ role: "assistant", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
const result = value => ({ role: "tool", content: JSON.stringify(value) });

test("状态探针mock由本轮标记发起概览，再沿返回的taskId读取详情", () => {
  const start = [call("scheduler_manage", { action: "spawn", target: "developer" }),
    { role: "user", content: "SCHEDULER_STATUS_READ_A2" }, { role: "user", content: "<system-reminder>提醒</system-reminder>" }];
  assert.equal(decide(start).tool, undefined);
  assert.deepEqual(decide(start, { status: true }), { tool: "scheduler_status", args: {} });
  const overview = [...start, call("scheduler_status"), result({ tasks: { A2: { summaryRead: { taskId: "A2" } } } })];
  assert.deepEqual(decide(overview, { status: true }), { tool: "scheduler_status", args: { taskId: "A2" } });
  const detail = [...overview, call("scheduler_status", { taskId: "A2" }), result({ taskId: "A2", progress: { summary: "完整结果" } })];
  assert.equal(decide(detail, { status: true }).tool, undefined);
  assert.equal(decide([...detail, { role: "user", content: "普通通知" }], { status: true }).tool, undefined);
  assert.equal(decide([call("scheduler_status"), result({ tasks: {} })], { status: true }).tool, undefined);
});

test("长报告只在显式状态探针模式的A2中生成", () => {
  const messages = [{ role: "user", content: "你是专项执行者" }, call("scheduler_next"), result({ taskId: "A2", dispatchId: "d" })];
  assert.equal(decide(messages).args.summary, "A2 完成");
  const report = decide(messages, { status: true });
  assert.equal(report.tool, "scheduler_report");
  assert.ok(Array.from(report.args.summary).length > 300);
  const a1 = [...messages.slice(0, -1), result({ taskId: "A1", dispatchId: "d" })];
  assert.equal(decide(a1, { status: true }).args.summary, "A1 完成");
});
