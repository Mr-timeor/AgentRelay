import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { normalize, initial } from "./dist/core/model.js";
import { diagnose } from "./dist/core/planner.js";
import { FileStore } from "./dist/store/file-store.js";
import { Scheduler } from "./dist/dispatcher/scheduler.js";
import { WakeQueue } from "./dist/dispatcher/wake-queue.js";

function compactProgress(taskId, progress) {
  if (typeof progress.summary !== "string") return progress;
  const chars = Array.from(progress.summary), truncated = chars.length > 300;
  return { ...progress, summary: truncated ? chars.slice(0, 299).join("") + "…" : progress.summary,
    summaryChars: chars.length, summaryTruncated: truncated,
    ...(truncated ? { summaryRead: { taskId } } : {}) };
}

const runInfo = ({ summary: _summary, rework: _rework, ...run }) => run;

// 仅这一层认识宿主 Agent；核心可以由其他平台复用。
//
// 与 DSH 0.2.1-rc.2 的实际接口对齐：
// - defineTool 的 output.schema 是值 schema DSL（普通对象），不是 schemastery 实例；
// - 可选参数必须省略 required，写成 required:false 会被拒绝；
// - tryMembership 要求传入 agents 服务中的同一个 live Agent 对象。
export function install(ctx, config, { defineTool, z }) {
  if (!config.projectFile || !config.stateFile) {
    throw new Error("需要 projectFile 和 stateFile");
  }
  const explicitLead = config.leadSessionId && config.leadSessionId !== "auto"
    ? String(config.leadSessionId) : undefined;
  let boundLeadId = explicitLead;
  const installed = new Map();
  // 逻辑等待属于持久成员/session；live Agent只是当前回合的载体。
  const waiting = new Map();
  const memberNames = new WeakMap();
  const shutdown = new AbortController();
  let disposed = false;
  let servicePromise;
  async function readJson(path, label) {
    let text;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      const reason = ["ENOENT", "ENOTDIR"].includes(error.code) ? "未找到，请确认路径或先创建文件"
        : ["EACCES", "EPERM"].includes(error.code) ? "无法读取，请检查权限" : `无法读取：${error.message}`;
      throw new Error(`${label}${reason}：${path}`, { cause: error });
    }
    try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch (error) { throw new Error(`${label} JSON 格式错误：${path}；${error.message}`, { cause: error }); }
  }

  // 初始化失败不锁死插件；修正文件后，可由下一次明确工具调用重试。
  const service = () => servicePromise ??= (async () => {
    const project = normalize(await readJson(resolve(config.projectFile), "任务文件"));
    const errors = diagnose(project);
    if (errors.length) throw new Error(errors.join("\n"));
    const path = resolve(config.stateFile);
    try { return new Scheduler(await FileStore.open(path, initial(project)), config.receiptTimeoutMs ?? 120000); }
    catch (error) {
      const reason = ["EACCES", "EPERM"].includes(error.code) ? "无法读写，请检查权限"
        : ["ENOTDIR", "EISDIR"].includes(error.code) ? "路径不是可用文件，请检查目录层级"
        : error.code === "ENOSPC" ? "磁盘空间不足" : `无法打开：${error.message}`;
      throw new Error(`状态存储${reason}：${path}`, { cause: error });
    }
  })().catch(error => { servicePromise = undefined; throw error; });

  async function tasksInput(args) {
    if ((args.tasks !== undefined) === (args.tasksFile !== undefined)) {
      throw new Error("add-tasks 需要 tasks 或 tasksFile，二选一");
    }
    let value;
    if (args.tasksFile !== undefined) {
      if (typeof args.tasksFile !== "string" || !args.tasksFile.trim()) throw new Error("tasksFile 需要任务 JSON 文件路径");
      value = await readJson(resolve(dirname(resolve(config.projectFile)), args.tasksFile), "追加任务文件");
    } else {
      if (typeof args.tasks !== "string") throw new Error("tasks 需要 JSON 文本；也可用 tasksFile 指定文件");
      try { value = JSON.parse(args.tasks); }
      catch (error) { throw new Error(`追加任务 JSON 格式错误：${error.message}`, { cause: error }); }
    }
    const tasks = Array.isArray(value) ? value : [value];
    if (!tasks.length || tasks.some(task => !task || typeof task !== "object" || Array.isArray(task))) {
      throw new Error("追加任务需要非空任务数组或单任务对象");
    }
    return tasks;
  }

  function liveLead(root) {
    return !disposed && ctx.agents.list().includes(root)
      && ctx.agentTeams.tryMembership(root)?.role === "lead" && String(root.id) === boundLeadId;
  }

  function send(root, signal, delivery) {
    return ctx.agentTeams.sendMessage(root, {
      target: delivery.agentId, content: [{ type: "text", text: JSON.stringify(delivery) }], signal
    });
  }

  function waitForMember(m, agent) {
    memberNames.set(agent, m.name);
    waiting.set(m.name, { id: String(agent.id), agent });
  }

  function waitingStatus() {
    const result = { waitingAgents: [], inactiveWaitingAgents: [] };
    for (const [name, entry] of waiting) {
      if (entry.agent && !ctx.agents.list().includes(entry.agent)) entry.agent = undefined;
      (entry.agent ? result.waitingAgents : result.inactiveWaitingAgents).push(name);
    }
    return result;
  }

  // 只响应当前工具中的真实状态变更；不轮询、不创建成员、不自动重试。
  function wakeReady(root) {
    if (!config.autoDispatch || !liveLead(root)) return Promise.resolve(undefined);
    return wakeQueue.request(root);
  }

  const wakeQueue = new WakeQueue(async root => {
      if (!liveLead(root)) return undefined;
      const s = await service(), result = { dispatched: [], errors: [] };
      const candidates = s.snapshot().project.agents.filter(agent => waiting.has(agent.id))
        .flatMap(agent => s.plan(agent.id).segments);
      await Promise.all(candidates.map(async ({ agentId }) => {
        if (!liveLead(root)) return;
        const entry = waiting.get(agentId);
        if (!entry) return;
        // inactive不是成员消失：原生消息服务会恢复同一个持久Session。
        let target;
        try {
          target = ctx.agentTeams.listMembers(root).find(member =>
            member.name === agentId && String(member.id) === entry.id);
        } catch (error) {
          result.errors.push({ agentId, error: `无法核对持久成员：${String(error?.message ?? error)}` });
          return;
        }
        if (!target || !["running", "inactive"].includes(target.status)) {
          waiting.delete(agentId);
          result.errors.push({ agentId, error: "原持久成员不可发送；未创建替代会话，请Lead核对" });
          return;
        }
        // 先移除等待标记，避免两个同时交付事件重复派发同一成员。
        if (waiting.get(agentId) !== entry || !waiting.delete(agentId)) return;
        try {
          // 状态已提交，自动唤醒属于插件；单个报告工具取消不取消共享扫描。
          const delivery = await s.dispatch(agentId, d => send(root, shutdown.signal, d));
          const phase = s.snapshot().runs.find(run => run.dispatchId === delivery.dispatchId)?.phase;
          result.dispatched.push({ agentId, taskId: delivery.taskId, dispatchId: delivery.dispatchId, phase });
        } catch (error) {
          // 上游交付已经提交；唤醒失败不能把它报成失败或诱使模型重复提交。
          // 同一就绪任务已被其他成员或next领取属于正常竞争，继续等待。
          if (error.code !== "NO_READY_TASK") result.errors.push({ agentId, error: String(error?.message ?? error) });
          if (!disposed && !s.snapshot().runs.some(run => run.agentId === agentId && run.phase !== "finished")) {
            waiting.set(agentId, entry); // 尚未占用/发送时，保留等待，留给后续真实事件或手动派发。
          }
        }
      }));
      return result;
  });

  // 只接受本调度团队的 live 调用者；auto 模式由第一次合法调用确定唯一 Lead。
  function member(agent, leadOnly = false) {
    const m = ctx.agentTeams.tryMembership(agent);
    if (!m) throw new Error("此工具仅供调度团队使用");
    if (boundLeadId === undefined) bindLead(String(m.root.id));
    if (String(m.root.id) !== boundLeadId) throw new Error("此调度器已绑定另一个 Lead");
    if (leadOnly && m.role !== "lead") throw new Error("此动作仅限 Lead");
    if (m.role === "teammate") memberNames.set(agent, m.name);
    return m;
  }

  // 绑定后只保留该团队的工具；其他 root 已注册的工具一并撤回。
  function bindLead(rootId) {
    boundLeadId = rootId;
    for (const [agent, disposers] of installed) {
      const m = ctx.agentTeams.tryMembership(agent);
      if (m && String(m.root.id) === boundLeadId) continue;
      for (const dispose of disposers) dispose();
      installed.delete(agent);
    }
    for (const a of ctx.agents.list()) attach(a);
  }

  const textParam = (description, required = false) => ({
    type: "string", description, ...(required ? { required: true } : {})
  });

  function tool(name, description, parameters, execute) {
    return defineTool({
      name, description, parameters,
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: { result: { type: "string", required: true } }
        },
        render: (_args, value) => [{ type: "text", text: value.result }]
      },
      async execute(args, exec) { return { result: JSON.stringify(await execute(args, exec)) }; }
    });
  }

  const definitions = [
    tool("scheduler_status", "空参查看概览，摘要最多300字符；传taskId读取该任务完整摘要与最近运行。详情不检查回执到期，首次调用仍会初始化状态。", {
      taskId: textParam("可选：读取指定任务详情与完整摘要")
    }, async (args, exec) => {
      member(exec.agent); const s = await service();
      if (args.taskId !== undefined) {
        if (typeof args.taskId !== "string" || !args.taskId.trim()) throw new Error("需要有效 taskId");
        const state = s.snapshot(), task = state.project.tasks.find(task => task.id === args.taskId);
        if (!task) throw new Error(`未知任务：${args.taskId}`);
        const run = state.runs.filter(run => run.taskId === task.id).at(-1);
        const reworks = state.runs.filter(run => run.taskId === task.id && run.rework)
          .map(run => ({ attemptId: run.attemptId, summary: run.summary, ...run.rework }));
        return { revision: state.revision, taskId: task.id, task, progress: state.progress[task.id],
          runs: run ? [runInfo(run)] : [], ...(reworks.length ? { reworks } : {}) };
      }
      await s.expire();
      const state = s.snapshot();
      return { revision: state.revision, ...s.plan(), tasks: Object.fromEntries(Object.entries(state.progress)
        .map(([taskId, progress]) => [taskId, compactProgress(taskId, progress)])),
        autoDispatch: config.autoDispatch === true, ...waitingStatus(),
        runs: state.runs.filter(r => r.phase !== "finished").map(runInfo) };
    }),
    tool("scheduler_next", "专项执行者领取下一任务。收到委托可传 dispatchId 确认；当前项完成后空参领取下一项。", {
      dispatchId: textParam("收到的委托 ID")
    }, async (args, exec) => {
      const m = member(exec.agent);
      if (m.role !== "teammate") throw new Error("Lead 请使用 scheduler_manage 派发");
      const s = await service(); await s.expire();
      const state = s.snapshot();
      const run = state.runs.find(r => r.agentId === m.name && r.phase !== "finished");
      if (run) {
        if (args.dispatchId && args.dispatchId !== run.dispatchId) throw new Error("dispatchId 与当前委托不匹配");
        waiting.delete(m.name);
        await s.acknowledge(m.name, run);
        return s.delivery(run);
      }
      if (args.dispatchId) throw new Error("旧委托已结束，不再执行");
      const worked = state.runs.some(r => r.agentId === m.name && r.phase === "finished");
      if (!worked && !config.autoDispatch) {
        waitForMember(m, exec.agent);
        return { waiting: true, reason: "等待 Lead 派发第一个任务" };
      }
      const p = s.plan(m.name);
      if (p.diagnostics.length) throw new Error(p.diagnostics.join("\n"));
      if (!p.segments.some(x => x.agentId === m.name)) {
        waitForMember(m, exec.agent);
        return { waiting: true, reason: "暂无属于你的连续任务" };
      }
      waiting.delete(m.name);
      let delivery;
      try { delivery = await s.dispatch(m.name, async () => {}); }
      catch (error) {
        // 交付唤醒与成员自行领取同时发生时，采用已分配的同一run。
        delivery = s.snapshot().runs.find(r => r.agentId === m.name && r.phase !== "finished");
        if (!delivery) {
          if (error.code !== "NO_READY_TASK") throw error;
          // 其他成员先领走了共享任务；本成员仍须保留后续唤醒入口。
          waitForMember(m, exec.agent);
          return { waiting: true, reason: "暂无属于你的连续任务" };
        }
      }
      await s.acknowledge(m.name, delivery);
      return s.delivery(delivery);
    }),
    tool("scheduler_report", "报告当前委托结果。普通任务直接完成；声明 review 的任务等待检查点验收。", {
      dispatchId: textParam("当前委托 ID", true),
      summary: textParam("简短结果与检查依据", true),
      status: textParam("completed（默认）、checkpoint、blocked 或 failed"),
      outputs: textParam('产物引用 JSON；值为非空字符串或非空字符串数组，如 {"api":"docs/api.md"}')
    }, async (args, exec) => {
      const m = member(exec.agent), s = await service();
      const run = s.snapshot().runs.find(r => r.dispatchId === args.dispatchId && r.agentId === m.name);
      if (!run || m.role !== "teammate") throw new Error("没有属于你的委托");
      await s.report(m.name, run, {
        summary: args.summary, status: args.status ?? "completed",
        outputs: args.outputs ? JSON.parse(args.outputs) : undefined
      });
      const wakeups = await wakeReady(m.root);
      return { taskId: run.taskId, state: s.snapshot().progress[run.taskId], ...(wakeups ? { wakeups } : {}) };
    }),
    tool("scheduler_manage", "Lead 管理：spawn、dispatch、accept、rework、approve、pause、resume、retry、resolve-stopped、add-tasks。rework填写反馈退回待验收任务的未完成部分，保留已接受交付。停止对账前先确认执行者已停止。", {
      action: textParam("管理动作", true), target: textParam("执行者名称或任务 ID"),
      output: textParam("仅验收指定中间产物时填写"),
      feedback: textParam("rework：具体返工反馈，不能留空"),
      tasks: textParam("add-tasks：单任务对象或任务数组的 JSON 文本；与 tasksFile 二选一"),
      tasksFile: textParam("add-tasks：任务 JSON 文件路径，相对 projectFile 所在目录；也可用绝对路径")
    }, async (args, exec) => {
      const m = member(exec.agent, true); const s = await service();
      if (args.action === "spawn") {
        const a = s.snapshot().project.agents.find(a => a.id === args.target);
        if (!a) throw new Error("执行者须先在项目中声明");
        await ctx.agentTeams.spawnTeammate(exec.agent, {
          name: a.id, description: `专项执行者：${a.categories.join("、") || "通用"}`,
          prompt: [{ type: "text", text: config.autoDispatch
            ? "你是专项执行者。先用scheduler_next领取或确认当前任务；使用scheduler_report提交简短摘要与产物引用，随后next继续。waiting即结束回合，依赖满足后插件会发送委托唤醒，不要轮询。只执行当前taskId，未知委托不重复执行。"
            : "你是专项执行者。等待 Lead 派发；收到任务后用 scheduler_next 确认委托，只执行当前任务，使用 scheduler_report 提交简短摘要与产物引用。首个任务完成后可继续领取下一项，暂无任务则停止等待。" }],
          context: "fresh", provider: config.provider ?? "spawn", signal: exec.signal
        });
        return { spawned: a.id };
      }
      if (args.action === "dispatch") {
        if (!args.target) throw new Error("dispatch 需要执行者名称");
        const entry = waiting.get(args.target);
        waiting.delete(args.target);
        try { return await s.dispatch(args.target, delivery => send(exec.agent, exec.signal, delivery)); }
        catch (error) {
          // 尚未形成委托的派发失败不应取消原来的等待；已有run则留给确认或对账。
          if (entry && !disposed && !waiting.has(args.target)
            && !s.snapshot().runs.some(run => run.agentId === args.target && run.phase !== "finished")) {
            waiting.set(args.target, entry);
          }
          throw error;
        }
      }
      if (args.action === "add-tasks") {
        const tasks = await tasksInput(args);
        await s.addTasks(tasks);
        const wakeups = await wakeReady(m.root);
        return { revision: s.snapshot().revision, added: tasks.length, ...(wakeups ? { wakeups } : {}) };
      }
      if (args.action === "accept") await s.accept(args.target, args.output);
      else if (args.action === "rework") await s.rework(args.target, args.feedback);
      else if (["approve", "pause", "resume", "retry", "resolve-stopped"].includes(args.action)) await s.control(args.action, args.target);
      else throw new Error("未知管理动作");
      const wakeups = await wakeReady(m.root);
      return { revision: s.snapshot().revision, ...(wakeups ? { wakeups } : {}) };
    })
  ];

  function attach(agent) {
    if (installed.has(agent)) return;
    const m = ctx.agentTeams.tryMembership(agent);
    if (!m) return;
    if (boundLeadId !== undefined) {
      if (String(m.root.id) !== boundLeadId) return;
    } else if (m.role !== "lead") {
      return;
    }
    if (m.role === "teammate") memberNames.set(agent, m.name);
    installed.set(agent, definitions.map(t => agent.ctx.tools.register(t)));
  }
  for (const a of ctx.agents.list()) attach(a);
  const off = [
    ctx.on("agent/created", ({ agent }) => attach(agent)),
    ctx.on("agent/disposed", ({ agent }) => {
      // 此时agents可能已经注销，不能再用tryMembership解析身份。
      const name = memberNames.get(agent), entry = waiting.get(name);
      if (entry?.agent === agent) entry.agent = undefined;
      for (const dispose of installed.get(agent) ?? []) dispose();
      installed.delete(agent);
    })
  ];
  return async () => {
    disposed = true;
    shutdown.abort();
    waiting.clear();
    for (const dispose of off) if (typeof dispose === "function") dispose();
    for (const disposers of installed.values()) for (const dispose of disposers) dispose();
    installed.clear();
    await wakeQueue.idle();
    const s = await servicePromise?.catch(() => undefined);
    if (s) await s.store.close();
  };
}
