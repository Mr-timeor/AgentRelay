// 真实宿主的按需启动闭环，成员模型请求仅发给本地确定性mock。
export const name = "scheduler-startup-probe";
export const inject = ["agents", "agentTeams", "tools"];

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const sleep = ms => new Promise(done => setTimeout(done, ms));
function deadline(promise, timeout, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`启动探针超时：${label}`)), timeout);
  })]).finally(() => clearTimeout(timer));
}
async function waitFor(fn, timeout, label) {
  return deadline((async () => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`启动探针超时：${label}`);
  })(), timeout, label);
}

export function apply(ctx) {
  globalThis.__schedulerStartupProbe = (async () => {
    const result = { steps: [], errors: [] }, activations = [], managementCalls = [];
    const off = [];
    const step = (name, detail = {}) => result.steps.push({ name, ...detail });
    let handle;
    try {
      const prepared = JSON.parse(await readFile(process.env.SCHEDULER_STARTUP_PREPARED, "utf8"));
      const output = process.env.SCHEDULER_STARTUP_REPORT_DIR;
      const captureFiles = process.env.SCHEDULER_STARTUP_FILE_EVIDENCE === "1";
      handle = await waitFor(async () => {
        try {
          return await ctx.agents.create({ sessionId: `session-startup-lead-${randomUUID()}`,
            meta: { cwd: prepared.workspace }, agentOptions: { provider: "mock", model: "mock-model" } });
        } catch (error) {
          if (String(error?.message ?? error).includes("no agent factory registered")) return;
          throw error;
        }
      }, 10000, "Lead创建");
      const lead = handle.agent, signal = new AbortController().signal;
      const names = () => ctx.tools.schemas(lead).map(tool => tool.name).filter(name => name.startsWith("scheduler_")).sort();
      await waitFor(() => ctx.tools.get("scheduler_manage", lead), 5000, "待机入口注册");
      assert.deepEqual(names(), ["scheduler_manage"]);
      assert.deepEqual(await readdir(prepared.workspace), []);
      step("standby-no-project-or-html", { tools: names(), cwd: lead.session.header.cwd });

      const call = async (name, args = {}, expectedError) => {
        const tool = ctx.tools.get(name, lead);
        assert(tool, `未注册工具 ${name}`);
        if (name === "scheduler_manage") {
          managementCalls.push({ action: args.action, target: args.target, at: new Date().toISOString() });
          const before = (await readFile(prepared.logFile, "utf8")).trim().split("\n").filter(Boolean).length;
          const createUserMessage = globalThis.__schedulerStartupCreateUserMessage;
          assert.equal(typeof createUserMessage, "function", "探针需要宿主消息构造器");
          lead.steer(createUserMessage({
            content: [{ type: "text", text: "AGENTRELAY_PROBE_COMMAND:" + JSON.stringify({ tool: name, args, id: randomUUID() }) }],
            source: { kind: "agent-message", form: "relay", senderSessionId: lead.id }
          }));
          await deadline(lead.whenIdle(), 15000, `模型工具管道${args.action}`);
          const rows = (await readFile(prepared.logFile, "utf8")).trim().split("\n").filter(Boolean).slice(before).map(line => JSON.parse(line));
          const receipt = rows.find(row => row.actor === "lead" && row.toolName === name
            && JSON.stringify(row.toolArgs) === JSON.stringify(args));
          assert(receipt, `宿主未返回${args.action}的工具结果，查看mock.jsonl而非绕过准入重试`);
          if (expectedError) {
            assert.match(receipt.toolResultText, expectedError, "需要预期的文件验收错误，其他准入或工具错误不算通过");
            return { expectedRejected: true };
          }
          assert(receipt.toolResult && typeof receipt.toolResult === "object", `工具${args.action}没有成功结果：${receipt.toolResultText}`);
          return receipt.toolResult;
        }
        return JSON.parse((await tool.execute(args, { agent: lead, signal })).result);
      };
      const loaded = await call("scheduler_manage", { action: "load" });
      assert.equal(loaded.startup.phase, "planning");
      assert.equal(resolve(loaded.paths.projectFile), resolve(prepared.projectFile));
      assert.equal(resolve(loaded.paths.stateFile), resolve(prepared.stateFile));
      assert.equal(resolve(loaded.paths.graphFile), resolve(prepared.graphFile));
      assert.deepEqual(await readdir(prepared.workspace), []);
      assert.deepEqual(names(), ["scheduler_manage", "scheduler_next", "scheduler_report", "scheduler_status"]);
      step("load-current-workspace", { paths: loaded.paths, explicitWorkspaceArgument: false,
        currentWorkingDirectoryService: typeof ctx.get?.("workingDirectory")?.ensure === "function",
        invocation: "native-model-tool-pipeline/local-mock", naturalLanguageRouting: "not-tested" });

      const project = {
        name: "按需启动开发测试", maxSegment: 2,
        agents: [{ id: "developer", categories: ["开发"] }, { id: "tester", categories: ["测试"] }],
        tasks: [
          { id: "A1", title: "交付接口", category: "开发", owner: "developer", outputs: ["api"], review: captureFiles, resources: ["src/api.md"] },
          { id: "Q1", title: "检查接口", category: "测试", owner: "tester", dependsOn: [{ taskId: "A1", output: "api" }], resources: ["tests/"] }
        ]
      };
      const plan = await call("scheduler_manage", { action: "prepare", project: JSON.stringify(project) });
      assert.equal(plan.startup.phase, "waiting");
      assert.equal(plan.agentCount, 2);
      assert.deepEqual(plan.agents.map(agent => agent.id), ["developer", "tester"]);
      assert.deepEqual(plan.waitingForAgents, ["developer", "tester"]);
      const planned = JSON.parse(await readFile(prepared.stateFile, "utf8"));
      assert.equal(planned.paused, true);
      assert.deepEqual(planned.runs, []);
      assert(Object.values(planned.progress).every(progress => progress.status === "pending"));
      assert.match(await readFile(prepared.graphFile, "utf8"), /A1/);
      assert.match(await readFile(prepared.graphFile, "utf8"), /Q1/);
      await writeFile(join(output, "state-after-prepare.json"), JSON.stringify(planned, null, 2) + "\n");
      step("prepare-task-plan-and-html", { agentCount: 2, paused: true, paths: plan.paths, revision: planned.revision });
      if (captureFiles) await writeFile(join(prepared.workspace, "mock-api.md"), "API v1\n");

      for (const [event, type] of [["agent/created", "created"], ["agent/disposed", "disposed"]]) {
        off.push(ctx.on(event, ({ agent }) => {
          if (agent.session.header.parentSession === lead.id) activations.push({ type, id: String(agent.id), at: new Date().toISOString() });
        }));
      }
      await deadline(call("scheduler_manage", { action: "spawn", target: "tester" }), 10000, "tester启动");
      const tester = ctx.agentTeams.listMembers(lead).find(member => member.name === "tester");
      assert(tester, "tester持久成员未注册");
      const partial = await waitFor(async () => {
        const status = await call("scheduler_status");
        return status.startup.readyAgents.includes("tester") ? status : undefined;
      }, 10000, "tester就绪回执");
      assert.equal(partial.startup.phase, "waiting");
      assert.deepEqual(partial.startup.readyAgents, ["tester"]);
      assert.deepEqual(partial.waitingForAgents, ["developer"]);
      assert(partial.startup.readyMessages.tester.trim());
      assert.deepEqual(partial.runs, []);
      const held = JSON.parse(await readFile(prepared.stateFile, "utf8"));
      assert.equal(held.paused, true);
      assert.deepEqual(held.runs, []);
      assert(held.history.every(event => event.action !== "dispatch"));
      await writeFile(join(output, "state-one-member-ready.json"), JSON.stringify(held, null, 2) + "\n");
      await waitFor(() => !ctx.agents.list().some(agent => String(agent.id) === String(tester.id)), 10000, "tester自然卸载");
      step("one-member-ready-no-dispatch", { testerSessionId: String(tester.id),
        readyMessages: partial.startup.readyMessages, waitingForAgents: partial.waitingForAgents,
        paused: true, runs: 0, testerNaturallyUnloaded: true });

      await deadline(call("scheduler_manage", { action: "spawn", target: "developer" }), 10000, "developer启动");
      if (captureFiles) {
        const detail = await waitFor(async () => {
          const value = await call("scheduler_status", { taskId: "A1" });
          return value.progress.status === "review" ? value : undefined;
        }, 30000, "A1带文件证据待验收");
        assert.match(detail.progress.outputs.api.files[0].sha256, /^[a-f0-9]{64}$/);
        const before = await readFile(prepared.stateFile);
        await writeFile(join(prepared.workspace, "mock-api.md"), "API v2\n");
        await call("scheduler_manage", { action: "accept", target: "A1" }, /交付文件内容已变化/u);
        assert.deepEqual(await readFile(prepared.stateFile), before, "内容变化时不得提交验收状态");
        const blocked = JSON.parse(before);
        assert(!blocked.runs.some(run => run.taskId === "Q1"), "未验收不得解锁Q1");
        await writeFile(join(output, "state-rejected-file-accept.json"), before);
        await writeFile(join(prepared.workspace, "mock-api.md"), "API v1\n");
        const accepted = await call("scheduler_manage", { action: "accept", target: "A1" });
        assert.equal(typeof accepted?.revision, "number");
        step("file-evidence-rejected-change-and-accepted-original", {
          file: detail.progress.outputs.api.files[0], rejectedStateUnchanged: true,
          restoredOriginalAccepted: true, invocation: "native-model-tool-pipeline/local-mock"
        });
      }
      await waitFor(async () => {
        const detail = await call("scheduler_status", { taskId: "Q1" });
        return detail.progress.status === "completed";
      }, 60000, "全部就绪后A1到Q1完成");
      const status = await call("scheduler_status");
      assert.equal(status.startup.phase, "running");
      assert.deepEqual([...status.startup.readyAgents].sort(), ["developer", "tester"]);
      assert.deepEqual(status.waitingForAgents, []);
      assert.equal(status.autoDispatch, true);
      const final = JSON.parse(await readFile(prepared.stateFile, "utf8"));
      assert.equal(final.paused, false);
      assert.equal(final.runs.length, 2);
      assert(final.runs.every(run => run.phase === "finished"));
      assert.deepEqual(final.runs.map(run => run.taskId), ["A1", "Q1"]);
      assert(new Set(final.runs.map(run => run.attemptId)).size === 2);
      assert.equal(final.progress.A1.status, "completed");
      assert.equal(final.progress.Q1.status, "completed");
      assert.equal(ctx.agentTeams.listMembers(lead).find(member => member.name === "tester")?.id, tester.id);
      assert(activations.filter(event => event.type === "created" && event.id === String(tester.id)).length >= 2);
      await waitFor(async () => (await readFile(prepared.graphFile, "utf8")).includes(`revision ${final.revision}`), 10000, "HTML跟随最终状态");
      const rows = (await readFile(prepared.logFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const readinessCalls = rows.filter(row => row.action?.tool === "scheduler_next" && row.action.args?.readySummary);
      assert.deepEqual(readinessCalls.map(row => row.actor).sort(), ["developer", "tester"]);
      assert(readinessCalls.every(row => typeof row.action.args.readySummary === "string" && row.action.args.readySummary.trim()));
      const leadToolCalls = rows.filter(row => row.actor === "lead" && row.action?.tool);
      assert.equal(leadToolCalls.length, managementCalls.length);
      assert(leadToolCalls.every(row => row.action.tool === "scheduler_manage"
        && ["load", "prepare", "spawn", "accept"].includes(row.action.args.action)));
      assert.equal(managementCalls.filter(call => call.action === "dispatch").length, 0);
      step("all-ready-auto-cross-member-complete", { testerSessionId: String(tester.id),
        readyMessages: status.startup.readyMessages, readinessCalls: readinessCalls.map(row => ({ actor: row.actor, args: row.action.args, at: row.at })),
        activations, managementCalls, revision: final.revision,
        runs: final.runs.map(run => ({ taskId: run.taskId, agentId: run.agentId, phase: run.phase })),
        leadSchedulingToolCalls: leadToolCalls.length, leadDispatchToolCalls: 0,
        invocation: "native-model-tool-pipeline/local-mock", manualDispatches: 0, realModelCalls: 0 });
    } catch (error) {
      result.errors.push(String(error?.stack ?? error));
    } finally {
      for (const dispose of off) dispose();
      try { await deadline(handle?.dispose() ?? Promise.resolve(), 10000, "释放Lead"); }
      catch (error) { result.errors.push(`Lead清理：${String(error?.stack ?? error)}`); }
    }
    return result;
  })();
}
