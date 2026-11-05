// 020：允许成员自然卸载/恢复、Lead接收通知，但不由Lead模型决定派发。
export const name = "scheduler-wake-probe";
export const inject = ["agents", "agentTeams", "tools"];
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`唤醒探针超时：${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function waitFor(fn, timeout = 10000, label = "等待条件") {
  return deadline((async () => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`唤醒探针超时：${label}`);
  })(), timeout, label);
}

export function apply(ctx) {
  globalThis.__schedulerWakeProbe = (async () => {
    const result = { steps: [], errors: [] }, activations = [];
    let handle;
    const off = [];
    try {
      handle = await waitFor(async () => {
        try { return await ctx.agents.create({ sessionId: `session-wake-lead-${randomUUID()}`,
          agentOptions: { provider: "mock", model: "mock-model" } }); }
        catch (error) { if (String(error).includes("no agent factory registered")) return; throw error; }
      });
      const lead = handle.agent, signal = new AbortController().signal;
      for (const [event, type] of [["agent/created", "created"], ["agent/disposed", "disposed"]]) {
        off.push(ctx.on(event, ({ agent }) => {
          if (agent.session.header.parentSession === lead.id) activations.push({ type, id: String(agent.id), at: new Date().toISOString() });
        }));
      }
      const status = await waitFor(() => ctx.tools.get("scheduler_status", lead));
      const call = async (tool, args) => JSON.parse((await ctx.tools.get(tool, lead).execute(args, { agent: lead, signal })).result);
      // 详情读取已提交的内存状态，避免在 Windows 上与状态文件原子替换争用。
      const completed = (taskId, timeout, label) => waitFor(async () => {
        const detail = await call("scheduler_status", { taskId });
        return detail.progress.status === "completed";
      }, timeout, label);
      const first = JSON.parse((await status.execute({}, { agent: lead, signal })).result);
      if (!first.autoDispatch || first.ready.join() !== "A1") throw new Error("autoDispatch未启用或初始状态错误");
      await deadline(call("scheduler_manage", { action: "spawn", target: "tester" }), 10000, "tester启动");
      const tester = ctx.agentTeams.listMembers(lead).find(member => member.name === "tester");
      if (!tester) throw new Error("tester持久成员未注册");
      await waitFor(async () => {
        const s = await call("scheduler_status", {});
        return [...(s.waitingAgents ?? []), ...(s.inactiveWaitingAgents ?? [])].includes("tester");
      }, 10000, "tester登记等待");
      await waitFor(() => !ctx.agents.list().some(agent => String(agent.id) === String(tester.id)), 10000, "tester自然卸载");
      const unloaded = await call("scheduler_status", {});
      if (unloaded.waitingAgents.includes("tester") || !unloaded.inactiveWaitingAgents.includes("tester")) {
        throw new Error("tester卸载后的live/非活跃等待展示不正确");
      }
      result.steps.push({ name: "tester-waited-and-unloaded", memberId: String(tester.id) });
      // 029：误向尚未就绪的等待成员派发，不应吃掉其后续自动唤醒登记。
      if (process.env.SCHEDULER_WAITING_TEST === "1") {
        const before = await readFile(process.env.SCHEDULER_PROBE_STATE, "utf8");
        await assert.rejects(call("scheduler_manage", { action: "dispatch", target: "tester" }), /暂无可启动任务/);
        const after = await call("scheduler_status", {});
        assert(after.inactiveWaitingAgents.includes("tester"), "拒绝派发后遗失原等待成员");
        assert.deepEqual(after.runs, []);
        assert.equal(await readFile(process.env.SCHEDULER_PROBE_STATE, "utf8"), before);
        result.steps.push({ name: "rejected-dispatch-preserves-waiting", memberId: String(tester.id),
          rejectedManualDispatchAttempts: 1, stateUnchanged: true });
      }
      await deadline(call("scheduler_manage", { action: "spawn", target: "developer" }), 10000, "developer启动");
      const stateFile = process.env.SCHEDULER_PROBE_STATE;
      await completed("A2", 60000, "A1→Q1→A2完成");
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      assert(["A1", "Q1", "A2"].every(id => state.progress[id].status === "completed"));
      if (state.runs.length !== 3 || state.runs.some(run => run.phase !== "finished")) throw new Error("运行重复或未结束");
      const sameSessionActivations = activations.filter(event => event.type === "created" && event.id === String(tester.id));
      if (sameSessionActivations.length < 2) throw new Error("未观察到tester在原session上恢复");
      const messages = (await readFile(fileURLToPath(new URL("../../.harness-isolated/mock-wake.log", import.meta.url)), "utf8"))
        .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const leadMessages = messages.filter(row => row.actor === "lead");
      if (leadMessages.some(row => row.action?.tool)) throw new Error("Lead模型参与了不应由其决定的调度操作");
      const intervals = state.runs.map(run => ({
        taskId: run.taskId, startedAt: run.startedAt,
        completedAt: state.history.find(e => e.taskId === run.taskId && e.action === "completed").at
      }));
      result.steps.push({ name: "auto-cross-member-chain-complete", intervals, activations,
        observedLeadModelCalls: leadMessages.length, leadSchedulingToolCalls: 0, manualDispatches: 0, realModelCalls: 0,
        actions: state.history.map(e => ({ at: e.at, action: e.action, taskId: e.taskId })) });

      if (process.env.SCHEDULER_ADD_TASKS_TEST === "1") {
        const idleTester = () => waitFor(async () => {
          const s = await call("scheduler_status", {});
          return s.inactiveWaitingAgents.includes("tester");
        }, 10000, "tester追加前等待并卸载");
        await idleTester();
        const file = resolve(dirname(stateFile), "extra-tasks.json");
        await writeFile(file, JSON.stringify([{ id: "Q2", owner: "tester", dependsOn: ["A2"] }]));
        const added = await call("scheduler_manage", { action: "add-tasks", tasksFile: file });
        assert.equal(added.added, 1);
        assert.deepEqual(added.wakeups.errors, []);
        assert.equal(added.wakeups.dispatched[0]?.taskId, "Q2");
        await completed("Q2", 10000, "Q2追加后自动完成");
        await idleTester();
        // JSON文本走一次真实模型工具管道（后端仍为本地mock），不只直调execute。
        lead.followup({ content: [{ type: "text", text: "SCHEDULER_ADD_Q3" }], source: { kind: "user" } });
        await deadline(lead.whenIdle(), 10000, "追加后的Lead回合结束");
        await completed("Q3", 10000, "Q3追加后自动完成");
        const final = JSON.parse(await readFile(stateFile, "utf8"));
        assert.equal(final.project.tasks.length, 5);
        assert.equal(final.runs.length, 5);
        assert(final.runs.every(r => r.phase === "finished"));
        assert(["Q2", "Q3"].every(id => final.progress[id].status === "completed"));
        for (const id of ["A1", "Q1", "A2"]) assert.deepEqual(final.progress[id], state.progress[id]);
        assert.deepEqual(final.runs.slice(0, 3), state.runs);
        assert.deepEqual(final.history.slice(0, state.history.length), state.history);
        assert.equal(final.history.filter(e => e.action === "add-tasks").length, 2);
        const log = (await readFile(fileURLToPath(new URL("../../.harness-isolated/mock-wake.log", import.meta.url)), "utf8"))
          .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        assert.equal(log.filter(row => row.actor === "lead" && row.action?.tool === "scheduler_manage"
          && row.action.args.action === "add-tasks").length, 1);
        const resumed = activations.filter(e => e.type === "created" && e.id === String(tester.id));
        assert(resumed.length >= 4, "两项新增任务未恢复原tester会话");
        result.steps.push({ name: "dynamic-add-tasks", fileTask: "Q2", modelToolTextTask: "Q3",
          added: 2, runs: final.runs.length, originalStatePreserved: true,
          testerSessionId: String(tester.id), sameSessionActivations: resumed.length, realModelCalls: 0 });

        if (process.env.SCHEDULER_UPDATE_TASK_TEST === "1") {
          await idleTester();
          const queued = await call("scheduler_manage", { action: "add-tasks", tasks: JSON.stringify([
            { id: "Gate", owner: "developer", approval: true },
            { id: "Q4", owner: "developer", dependsOn: ["Gate"] }
          ]) });
          assert.equal(queued.added, 2);
          assert.deepEqual(queued.wakeups.errors, []);
          const beforeEdit = await call("scheduler_status", { taskId: "Q4" });
          assert.equal(beforeEdit.progress.status, "pending");
          assert.deepEqual(beforeEdit.runs, []);
          const beforeStatus = await call("scheduler_status", {});
          assert(!beforeStatus.ready.includes("Q4"));
          lead.followup({ content: [{ type: "text", text: "SCHEDULER_UPDATE_Q4" }], source: { kind: "user" } });
          await deadline(lead.whenIdle(), 10000, "调整后的Lead回合结束");
          await completed("Q4", 10000, "Q4调整后自动完成");
          const edited = JSON.parse(await readFile(stateFile, "utf8"));
          assert.equal(edited.project.tasks.length, 7);
          const q4 = edited.project.tasks.find(task => task.id === "Q4");
          assert.equal(q4.owner, "tester");
          assert.deepEqual(q4.dependsOn, [{ taskId: "A2" }]);
          assert.equal(q4.title, "已调整的待执行测试任务");
          assert.equal(edited.progress.Gate.status, "pending");
          assert.equal(edited.progress.Gate.approved, false);
          assert.equal(edited.runs.length, 6);
          assert(edited.runs.every(run => run.phase === "finished"));
          assert.deepEqual(edited.runs.slice(0, 5), final.runs);
          assert.deepEqual(edited.history.slice(0, final.history.length), final.history);
          for (const id of ["A1", "Q1", "A2", "Q2", "Q3"]) assert.deepEqual(edited.progress[id], final.progress[id]);
          assert.equal(edited.history.filter(event => event.action === "update-task").length, 1);
          const q4Runs = edited.runs.filter(run => run.taskId === "Q4");
          assert.equal(q4Runs.length, 1);
          assert.equal(q4Runs[0].agentId, "tester");
          assert.equal(ctx.agentTeams.listMembers(lead).find(member => member.name === "tester")?.id, tester.id);
          const editLog = (await readFile(fileURLToPath(new URL("../../.harness-isolated/mock-wake.log", import.meta.url)), "utf8"))
            .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
          const edits = editLog.filter(row => row.actor === "lead" && row.action?.tool === "scheduler_manage"
            && row.action.args.action === "update-task");
          assert.equal(edits.length, 1);
          assert.equal(edits[0].action.args.target, "Q4");
          result.steps.push({ name: "update-pending-task", taskId: "Q4", updatedViaModelTool: true,
            previousOwner: "developer", owner: q4.owner, sameTesterSessionId: String(tester.id),
            preservedRuns: 5, totalFinishedRuns: 6, gatePendingUnapproved: true, realModelCalls: 0 });
        }
      }
    } catch (error) {
      result.errors.push(String(error?.stack ?? error));
    } finally {
      for (const dispose of off) dispose();
      if (handle) {
        try { await deadline(handle.dispose(), 5000, "释放Lead"); result.steps.push({ name: "disposed" }); }
        catch (error) { result.errors.push(`清理失败：${String(error)}`); }
      }
    }
    return result;
  })();
}
