import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWake } from "./host/mock-llm.mjs";
import { probePassed, saveProbeReport } from "./host/probe-result.mjs";

test("Lead完成通知可产生文字回合，但mock不让Lead调用调度工具", () => {
  const decision = decideWake([{ role: "user", content: "Background subagent tester finished" }]);
  assert.equal(decision.tool, undefined);
  assert.equal(typeof decision.text, "string");
  const member = decideWake([{ role: "user", content: "你是专项执行者。" }]);
  assert.equal(member.tool, "scheduler_next");
});

test("动态追加mock仅在显式探针消息及开关同时满足时调用add-tasks", () => {
  const messages = [{ role: "user", content: "SCHEDULER_ADD_Q3" }];
  assert.equal(decideWake(messages).tool, undefined);
  const action = decideWake(messages, { addTasks: true });
  assert.equal(action.tool, "scheduler_manage");
  assert.equal(action.args.action, "add-tasks");
  assert.equal(typeof action.args.tasks, "string");
  assert.deepEqual(JSON.parse(action.args.tasks), { id: "Q3", owner: "tester", dependsOn: ["Q2"] });
  assert.equal(decideWake([...messages, { role: "user", content: "<system-reminder>宿主提醒</system-reminder>" }], { addTasks: true }).tool, "scheduler_manage");
  assert.equal(decideWake([...messages, { role: "assistant", content: "已追加" }, { role: "user", content: "成员通知" }], { addTasks: true }).tool, undefined);
  assert.equal(decideWake([...messages, { role: "tool", content: '{}' }], { addTasks: true }).tool, undefined);
  assert.equal(decideWake([{ role: "user", content: "普通成员通知" }], { addTasks: true }).tool, undefined);
});

test("探针以本次JSON与清理结果判定；errors非空不能被退出码0掩盖", async t => {
  const folder = await mkdtemp(join(tmpdir(), "wake-report-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const ok = { runId: "one", reopened: true, cleanupErrors: [], result: { steps: [{ name: "complete" }], errors: [] } };
  assert.equal(probePassed(ok), true);
  assert.equal(probePassed({ ...ok, result: { steps: [], errors: [] } }), false);
  assert.equal(probePassed({ ...ok, cleanupErrors: ["释放失败"] }), false);
  const failure = await saveProbeReport(join(folder, "report.json"), { ...ok, result: { steps: [], errors: ["唤醒失败"] } });
  assert.equal(failure.passed, false);
  assert.equal(JSON.parse(await readFile(join(folder, "report.json"), "utf8")).passed, false);
  await assert.rejects(saveProbeReport(join(folder, "report.json"), ok), /EEXIST/);
});

test("待执行调整mock只响应本轮显式标记，通知不会重放历史调整", () => {
  const messages = [{ role: "user", content: "SCHEDULER_UPDATE_Q4" }];
  assert.equal(decideWake(messages).tool, undefined);
  const edit = decideWake([...messages, { role: "user", content: "<system-reminder>提醒</system-reminder>" }], { updateTask: true });
  assert.equal(edit.tool, "scheduler_manage");
  assert.equal(edit.args.action, "update-task");
  assert.equal(edit.args.target, "Q4");
  assert.deepEqual(JSON.parse(edit.args.changes), { title: "已调整的待执行测试任务", owner: "tester", dependsOn: ["A2"] });
  assert.equal(decideWake([...messages, { role: "tool", content: '{"revision":20}' }], { updateTask: true }).tool, undefined);
  assert.equal(decideWake([...messages, { role: "assistant", content: "调整结束" }, { role: "user", content: "成员通知" }], { updateTask: true }).tool, undefined);
});
