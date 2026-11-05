import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decide, reworkFeedback } from "./host/mock-llm.mjs";

const call = (name, args = {}) => ({ role: "assistant", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
const result = value => ({ role: "tool", content: JSON.stringify(value) });
const priorLead = [call("scheduler_manage", { action: "spawn", target: "developer" })];
const marker = text => [...priorLead, { role: "user", content: text }, { role: "user", content: "<system-reminder>提醒</system-reminder>" }];

test("返工探针由显式标记触发一次rework，传反馈后派发，普通通知不重放", () => {
  const messages = marker("SCHEDULER_REWORK_A2");
  assert.equal(decide(messages).tool, undefined);
  assert.deepEqual(decide(messages, { rework: true }), { tool: "scheduler_manage", args: {
    action: "rework", target: "A2", feedback: reworkFeedback
  } });
  const returned = [...messages, call("scheduler_manage", { action: "rework", target: "A2", feedback: reworkFeedback }), result({ revision: 7 })];
  assert.deepEqual(decide(returned, { rework: true }), { tool: "scheduler_manage", args: { action: "dispatch", target: "developer" } });
  const dispatched = [...returned, call("scheduler_manage", { action: "dispatch", target: "developer" }), result({ taskId: "A2" })];
  assert.equal(decide(dispatched, { rework: true }).tool, undefined);
  assert.equal(decide([...dispatched, { role: "user", content: "普通成员通知" }], { rework: true }).tool, undefined);
  assert.deepEqual(decide(marker("SCHEDULER_ACCEPT_A2"), { rework: true }), { tool: "scheduler_manage", args: { action: "accept", target: "A2" } });
  assert.deepEqual(decide(marker("SCHEDULER_REWORK_READ_A2"), { rework: true }), { tool: "scheduler_status", args: { taskId: "A2" } });
  assert.equal(decide([call("scheduler_status", { taskId: "A2" }), result({ taskId: "A2", reworks: [] })], { rework: true }).tool, undefined);
});

test("返工成员从新Delivery领取并区分两轮引用，A2交付后停止等验收", () => {
  const teammate = [{ role: "user", content: "你是专项执行者" }];
  const first = [...teammate, call("scheduler_next"), result({ taskId: "A2", dispatchId: "first" })];
  assert.equal(JSON.parse(decide(first, { rework: true }).args.outputs).implementation, "src/implementation-v1.mjs");
  const returned = [...teammate, call("scheduler_next"), result({ taskId: "A2", dispatchId: "second", rework: {
    previousAttemptId: "old-attempt", feedback: reworkFeedback, outputs: {}
  } })];
  assert.equal(JSON.parse(decide(returned, { rework: true }).args.outputs).implementation, "src/implementation-v2.mjs");
  assert.equal(decide(returned, { rework: true }).args.dispatchId, "second");
  const report = [...returned, call("scheduler_report", { dispatchId: "second" }), result({ taskId: "A2", state: { status: "review" } })];
  assert.equal(decide(report, { rework: true }).tool, undefined);
  const notification = [...report, { role: "user", content: "新委托" }, { role: "user", content: "<system-reminder>提醒</system-reminder>" }];
  assert.deepEqual(decide(notification, { rework: true }), { tool: "scheduler_next", args: {} });
  assert.equal(Array.from(decide(returned, { rework: true, status: true }).args.summary).length, 1205);
  const a1 = [...teammate, call("scheduler_next"), result({ taskId: "A1", dispatchId: "a1" })];
  assert.deepEqual(JSON.parse(decide(a1, { rework: true }).args.outputs), { api: "docs/api.md" });
});

test("返工开关仅改变隔离Loop的A2，普通fixture与默认配置保持", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-rework-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"), bundle = join(directory, "bundle");
  await mkdir(join(repo, "tests/host"), { recursive: true });
  await mkdir(join(repo, "fixtures"));
  await mkdir(bundle);
  await writeFile(join(bundle, "index.mjs"), "export const fixture = true;\n");
  await cp(resolve("tests/host/setup-isolated.mjs"), join(repo, "tests/host/setup-isolated.mjs"));
  await cp(resolve("fixtures/development.json"), join(repo, "fixtures/development.json"));
  const run = promisify(execFile), script = join(repo, "tests/host/setup-isolated.mjs");
  const environment = { ...process.env, SCHEDULER_BUNDLE_DIR: bundle, SCHEDULER_WAKE_TEST: "", SCHEDULER_CONTEXT_TEST: "1", SCHEDULER_REWORK_TEST: "1" };
  await run(process.execPath, [script], { cwd: repo, env: environment });
  const loop = JSON.parse(await readFile(join(repo, ".harness-isolated/project-loop.json"), "utf8"));
  assert.equal(loop.tasks.find(task => task.id === "A1").review, undefined);
  assert.equal(loop.tasks.find(task => task.id === "A2").review, true);
  assert.deepEqual(loop.tasks.find(task => task.id === "A2").outputs, ["implementation"]);
  assert.equal(loop.tasks.find(task => task.id === "A1").specFile, "docs/tasks.md#A1");
  const original = JSON.parse(await readFile(join(repo, "fixtures/development.json"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(join(repo, ".harness-isolated/project.json"), "utf8")), original);
  await run(process.execPath, [script], { cwd: repo, env: { ...environment, SCHEDULER_CONTEXT_TEST: "", SCHEDULER_REWORK_TEST: "" } });
  assert.deepEqual(JSON.parse(await readFile(join(repo, ".harness-isolated/project-loop.json"), "utf8")), original);
});
