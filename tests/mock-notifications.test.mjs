import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, reworkFeedback, startMockLlm } from "./host/mock-llm.mjs";

const call = (name, args = {}) => ({ role: "assistant", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
const result = value => ({ role: "tool", content: JSON.stringify(value) });
const notice = { role: "user", content: "Background subagent developer finished and will do no further work unless you send it more.Its closing message:A2交付结束，等待Lead验收。" };
const reminder = { role: "user", content: "<system-reminder>宿主提醒</system-reminder>" };
const returned = [call("scheduler_manage", { action: "spawn", target: "developer" }),
  { role: "user", content: "SCHEDULER_REWORK_A2" },
  call("scheduler_manage", { action: "rework", target: "A2", feedback: reworkFeedback }), result({ revision: 7 })];

test("现场顺序：退回结果后插入成员通知，mock仍继续一次重新派发", () => {
  const messages = [...returned, notice, reminder], original = structuredClone(messages);
  assert.deepEqual(decide(messages, { rework: true }), { tool: "scheduler_manage", args: { action: "dispatch", target: "developer" } });
  assert.deepEqual(messages, original);
  assert.equal(decide(messages).tool, undefined);
});

test("重新派发后通知不再次派发，已经结束的回合不复活旧退回结果", () => {
  const dispatched = [...returned, call("scheduler_manage", { action: "dispatch", target: "developer" }), result({ taskId: "A2" })];
  for (const messages of [
    [...dispatched, notice, reminder],
    [...returned, { role: "assistant", content: "本回合结束。" }, notice, reminder],
    [...dispatched, { role: "assistant", content: "已派发。" }, notice]
  ]) assert.equal(decide(messages, { rework: true }).tool, undefined);
});

test("真正的新用户指令和其他工具结果阻断旧退回续步", () => {
  for (const messages of [
    [...returned, { role: "user", content: "先别派发，我要检查现场。" }, reminder],
    [...returned, call("scheduler_status", { taskId: "A2" }), result({ taskId: "A2" }), notice]
  ]) assert.equal(decide(messages, { rework: true }).tool, undefined);
});

test("退回结果缺失、报错或不完整时不擅自派发", () => {
  for (const messages of [returned.slice(0, -1),
    [...returned.slice(0, -1), result({ error: "退回被拒绝" })],
    [...returned.slice(0, -1), { role: "tool", content: "Error: 退回失败" }],
    [...returned.slice(0, -1), result({})]
  ]) assert.equal(decide([...messages, notice], { rework: true }).tool, undefined);
});

test("概览后插入通知仍沿summaryRead读取详情，详情后不循环读取", () => {
  const overview = [call("scheduler_status"), result({ tasks: { A2: { summaryRead: { taskId: "A2" } } } }), notice, reminder];
  assert.deepEqual(decide(overview, { status: true }), { tool: "scheduler_status", args: { taskId: "A2" } });
  assert.equal(decide([...overview, call("scheduler_status", { taskId: "A2" }), result({ taskId: "A2" }), notice], { status: true }).tool, undefined);
});

test("mock日志保留原始通知，同时记录被通知遮住的当前状态工具结果", async t => {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-mock-notice-")), log = join(dir, "mock.jsonl");
  const before = process.env.SCHEDULER_STATUS_TEST;
  process.env.SCHEDULER_STATUS_TEST = "1";
  let server;
  t.after(async () => {
    await server?.close();
    if (before === undefined) delete process.env.SCHEDULER_STATUS_TEST;
    else process.env.SCHEDULER_STATUS_TEST = before;
    await rm(dir, { recursive: true, force: true });
  });
  server = await startMockLlm(log);
  const overview = { tasks: { A2: { summaryRead: { taskId: "A2" } } } };
  const response = await fetch(`${server.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [call("scheduler_status"), result(overview), notice, reminder] }) });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /scheduler_status/);
  const row = JSON.parse((await readFile(log, "utf8")).trim());
  assert.deepEqual(row.statusResult, overview);
  assert.equal(row.lastRole, "user");
  assert.equal(row.last, reminder.content);
  assert.equal(row.ignoredHostNotices, 2);
});
