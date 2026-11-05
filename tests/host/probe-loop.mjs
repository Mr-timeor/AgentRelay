// 闭环探针：真实 DSH + 真实 agent-team + 本地 OpenAI 兼容 mock（无真实模型费用）。
export const name = "scheduler-loop-probe";
export const inject = ["agents", "agentTeams", "tools"];

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { reworkFeedback } from "./mock-llm.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitFor = async (fn, timeoutMs, label) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
};

const createAgent = async (ctx, options) => {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try { return await ctx.agents.create(options); }
    catch (error) {
      if (!String(error?.message ?? error).includes("no agent factory registered")) throw error;
      await sleep(100);
    }
  }
  throw new Error("agent-loop 未在 10 秒内注册 factory");
};

export function apply(ctx) {
  const stateFile = process.env.SCHEDULER_PROBE_STATE;
  const reworkTest = process.env.SCHEDULER_REWORK_TEST === "1";
  const mockRows = async () => (await readFile(fileURLToPath(new URL("../../.harness-isolated/mock-llm.log", import.meta.url)), "utf8"))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  globalThis.__schedulerLoopProbe = (async () => {
    const result = { steps: [], errors: [] };
    const step = (name, detail) => result.steps.push({ name, ...detail });
    let leadHandle, teammate;
    try {
      leadHandle = await createAgent(ctx, {
        sessionId: `session-loop-lead-${randomUUID()}`,
        agentOptions: { provider: "mock", model: "mock-model" }
      });
      const lead = leadHandle.agent;
      step("lead-created", { id: lead.id });
      const tools = await waitFor(() => ctx.tools.get("scheduler_manage", lead) ? ctx.tools.schemas(lead).filter(t => t.name.startsWith("scheduler_")).map(t => t.name) : undefined, 5000, "Lead 工具注册");
      step("lead-tools", { names: tools });

      lead.followup({ content: [{ type: "text", text: "开始调度闭环测试" }], source: { kind: "user" } });
      await lead.whenIdle();
      step("lead-idle", { at: Date.now() });

      teammate = await waitFor(() => {
        const agent = ctx.agents.list().find(a => a.session.header.parentSession === lead.id);
        return agent;
      }, 10000, "专项成员创建");
      step("teammate-created", { id: teammate.id });

      await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(stateFile, "utf8"));
          return state.progress?.A1?.status === "completed" && state.progress?.A2?.status === (reworkTest ? "review" : "completed");
        } catch { return false; }
      }, 60000, reworkTest ? "A1完成/A2首次待验收" : "A1/A2 完成");
      await teammate.whenIdle();

      if (reworkTest) {
        const first = JSON.parse(await readFile(stateFile, "utf8"));
        const oldRun = first.runs.find(run => run.taskId === "A2");
        assert(oldRun && oldRun.phase === "finished", "A2首次提交尚未结束");
        assert.deepEqual(first.progress.A2.outputs, { implementation: { accepted: false, reference: "src/implementation-v1.mjs" } });
        const memberId = ctx.agentTeams.listMembers(lead).find(member => member.name === "developer")?.id;
        assert(memberId, "原developer持久成员缺失");
        lead.followup({ content: [{ type: "text", text: "SCHEDULER_REWORK_A2" }], source: { kind: "user" } });
        await lead.whenIdle();
        const returned = await waitFor(async () => {
          try {
            const state = JSON.parse(await readFile(stateFile, "utf8"));
            return state.progress?.A2?.status === "review" && state.runs.filter(run => run.taskId === "A2").length === 2 ? state : undefined;
          } catch { return undefined; }
        }, 60000, "A2返工后再次待验收");
        const newRun = returned.runs.filter(run => run.taskId === "A2").at(-1);
        assert(newRun.phase === "finished" && newRun.attemptId !== oldRun.attemptId && newRun.dispatchId !== oldRun.dispatchId, "返工复用了旧运行");
        assert.deepEqual(returned.runs.find(run => run.attemptId === oldRun.attemptId), {
          ...oldRun, rework: { feedback: reworkFeedback, outputs: first.progress.A2.outputs }
        });
        assert.deepEqual(returned.progress.A2.outputs, { implementation: { accepted: false, reference: "src/implementation-v2.mjs" } });
        assert(returned.runs.every(run => run.taskId === "A1" || run.taskId === "A2"), "待验收时提前启动下游");
        assert(["B1", "B2", "A3"].every(id => returned.progress[id].status === "pending"));
        assert.equal(ctx.agentTeams.listMembers(lead).find(member => member.name === "developer")?.id, memberId, "developer会话被替换");
        const beforeAcceptRows = await mockRows();
        const newDelivery = beforeAcceptRows.map(row => row.schedulerResult).find(delivery => delivery?.attemptId === newRun.attemptId);
        assert(newDelivery, "返工委托未经真实工具结果到达mock执行者");
        assert.deepEqual(newDelivery.rework, { previousAttemptId: oldRun.attemptId, feedback: reworkFeedback, outputs: first.progress.A2.outputs });
        const reworkCalls = beforeAcceptRows.filter(row => row.action?.tool === "scheduler_manage" && row.action.args?.action === "rework");
        assert.equal(reworkCalls.length, 1);
        assert.equal(reworkCalls[0].action.args.feedback, reworkFeedback);
        lead.followup({ content: [{ type: "text", text: "SCHEDULER_ACCEPT_A2" }], source: { kind: "user" } });
        await lead.whenIdle();
        const accepted = JSON.parse(await readFile(stateFile, "utf8"));
        assert.equal(accepted.progress.A2.status, "completed");
        assert.equal(accepted.progress.A2.outputs.implementation.accepted, true);
        assert.equal(accepted.runs.length, 3);
        assert(accepted.runs.every(run => run.phase === "finished"));
        assert.equal(new Set(accepted.runs.map(run => run.attemptId)).size, 3);
        lead.followup({ content: [{ type: "text", text: "SCHEDULER_REWORK_READ_A2" }], source: { kind: "user" } });
        await lead.whenIdle();
        const detail = (await mockRows()).map(row => row.statusResult).find(detail => detail?.taskId === "A2" && detail.reworks);
        assert(detail, "返工详情未经过真实工具管道读取");
        const history = detail.reworks.find(item => item.attemptId === oldRun.attemptId);
        assert(history, "详情缺失已退回轮次");
        assert.equal(history.feedback, reworkFeedback);
        assert.equal(history.summary, oldRun.summary);
        assert.deepEqual(history.outputs, first.progress.A2.outputs);
        step("rework-context", { taskId: "A2", oldAttemptId: oldRun.attemptId, newAttemptId: newRun.attemptId,
          sameMemberId: memberId, feedbackDelivered: true, originalReportKept: true, detailHistoryMatched: true,
          acceptedAfterRework: true, manualRedispatches: 1, realModelCalls: 0 });
      }

      const state = JSON.parse(await readFile(stateFile, "utf8"));
      const actions = state.history.map(e => e.action);
      const members = ctx.agentTeams.listMembers(lead).map(m => ({ name: m.name, role: m.role }));
      step("state", {
        A1: state.progress.A1.status, A2: state.progress.A2.status,
        actions, runs: state.runs.map(r => ({ taskId: r.taskId, agentId: r.agentId, phase: r.phase })),
        members
      });
      if (!actions.includes("dispatch") || !actions.includes("acknowledge") || !actions.includes("completed")) {
        throw new Error(`闭环事件不完整：${actions.join(",")}`);
      }
      if (!members.some(m => m.name === "developer" && m.role === "teammate")) throw new Error("developer 未成为团队成员");
      if (process.env.SCHEDULER_CONTEXT_TEST === "1") {
        const rows = (await readFile(fileURLToPath(new URL("../../.harness-isolated/mock-llm.log", import.meta.url)), "utf8"))
          .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        const received = rows.map(row => row.schedulerResult).filter(Boolean);
        const first = received.find(d => d.taskId === "A1"), second = received.find(d => d.taskId === "A2");
        assert(first && second, "真实宿主工具结果未到达mock执行者");
        assert.equal(first.phase, "active");
        assert.equal(second.phase, "active");
        assert.equal(first.specFile, "docs/tasks.md#A1");
        assert.equal(second.specFile, "docs/tasks.md#A2");
        assert.equal(first.task.specFile, first.specFile);
        assert.equal(second.task.specFile, second.specFile);
        assert.deepEqual(first.segment, ["A1", "A2"]);
        assert.equal(first.startedAt, state.runs.find(r => r.taskId === "A1").startedAt);
        assert.deepEqual(second.dependencies, [
          { taskId: "A1", outputs: { api: "docs/api.md" }, summary: "A1 完成" },
          { taskId: "A1", output: "api", reference: "docs/api.md" }
        ]);
        assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort());
        step("delivery-context", { specFiles: [first.specFile, second.specFile],
          firstSegment: first.segment, dependencies: second.dependencies,
          shapeMatched: true, realModelCalls: 0 });
      }

      if (process.env.SCHEDULER_STATUS_TEST === "1") {
        const before = await readFile(stateFile, "utf8");
        assert(Array.from(state.progress.A2.summary).length > 300, "mock未生成长报告");
        lead.followup({ content: [{ type: "text", text: "SCHEDULER_STATUS_READ_A2" }], source: { kind: "user" } });
        await lead.whenIdle();
        const rows = (await readFile(fileURLToPath(new URL("../../.harness-isolated/mock-llm.log", import.meta.url)), "utf8"))
          .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        const received = rows.map(row => row.statusResult).filter(Boolean);
        const overview = received.find(result => result.tasks?.A2), detail = received.find(result => result.taskId === "A2");
        assert(overview && detail, "概览或详情工具结果未到达mock Lead");
        assert.equal(Array.from(overview.tasks.A2.summary).length, 300);
        assert.equal(overview.tasks.A2.summaryChars, Array.from(state.progress.A2.summary).length);
        assert.equal(overview.tasks.A2.summaryTruncated, true);
        assert.deepEqual(overview.tasks.A2.summaryRead, { taskId: "A2" });
        assert.equal(detail.progress.summary, state.progress.A2.summary);
        assert.equal(detail.task.id, "A2");
        assert.equal(detail.tasks, undefined);
        assert(detail.runs.every(run => !Object.hasOwn(run, "summary")));
        assert.equal(await readFile(stateFile, "utf8"), before);
        step("compact-status", { taskId: "A2", previewChars: 300, summaryChars: overview.tasks.A2.summaryChars,
          fullSummaryMatched: true, originalBytesUnchanged: true, realModelCalls: 0 });
      }

      await leadHandle.dispose();
      leadHandle = undefined;
      step("agents-disposed", {});
    } catch (error) {
      result.errors.push(String(error?.stack ?? error));
      try { await leadHandle?.dispose(); } catch {}
    }
    return result;
  })();
}
