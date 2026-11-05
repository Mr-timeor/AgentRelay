import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { normalize, initial } from "../dist/core/model.js";
import { diagnose } from "../dist/core/planner.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";
import { WakeQueue } from "../dist/dispatcher/wake-queue.js";
import { startViewExport } from "../dist/ui/export-view.js";

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
  const onDemand = config.onDemand === true;
  if (!onDemand && (!config.projectFile || !config.stateFile)) {
    throw new Error("需要 projectFile 和 stateFile");
  }
  const explicitLead = config.leadSessionId && config.leadSessionId !== "auto"
    ? String(config.leadSessionId) : undefined;
  let boundLeadId = onDemand ? undefined : explicitLead;
  let phase = onDemand ? "standby" : "running";
  let paths = { projectFile: config.projectFile, stateFile: config.stateFile, graphFile: config.graphFile };
  let plannedAgents = [], view;
  const ready = new Map();
  const installed = new Map();
  // 逻辑等待属于持久成员/session；live Agent只是当前回合的载体。
  const waiting = new Map();
  const memberNames = new WeakMap();
  const shutdown = new AbortController();
  let disposed = false;
  let servicePromise, preparation, activeTools = 0;
  const automatic = () => onDemand ? phase === "running" : config.autoDispatch === true;
  const startupStatus = () => ({ phase, agentCount: plannedAgents.length, agents: plannedAgents,
    readyAgents: [...ready.keys()], waitingForAgents: plannedAgents.filter(a => !ready.has(a.id)).map(a => a.id),
    readyMessages: Object.fromEntries([...ready].map(([name, entry]) => [name, entry.summary])) });
  const startupResult = () => ({ startup: startupStatus(), paths: { ...paths },
    agentCount: plannedAgents.length, agents: plannedAgents,
    waitingForAgents: plannedAgents.filter(a => !ready.has(a.id)).map(a => a.id) });
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
    const project = normalize(await readJson(resolve(paths.projectFile), "任务文件"));
    const errors = diagnose(project);
    if (errors.length) throw new Error(errors.join("\n"));
    if (onDemand && (!project.tasks.length || !project.agents.length)) throw new Error("请先提供具体任务和专项成员计划");
    const path = resolve(paths.stateFile);
    try { return new Scheduler(await FileStore.open(path, initial(project)), config.receiptTimeoutMs ?? 120000); }
    catch (error) {
      const reason = ["EACCES", "EPERM"].includes(error.code) ? "无法读写，请检查权限"
        : ["ENOTDIR", "EISDIR"].includes(error.code) ? "路径不是可用文件，请检查目录层级"
        : error.code === "ENOSPC" ? "磁盘空间不足" : `无法打开：${error.message}`;
      throw new Error(`状态存储${reason}：${path}`, { cause: error });
    }
  })().catch(error => { servicePromise = undefined; throw error; });

  async function load(args, exec) {
    const m = ctx.agentTeams.tryMembership(exec.agent);
    if (!m || m.role !== "lead" || (explicitLead && String(m.root.id) !== explicitLead)) throw new Error("加载仅限调度Lead");
    if (phase !== "standby") { member(exec.agent, true); return startupResult(); }
    const workingDirectory = ctx.get?.("workingDirectory");
    const workspace = args.workspace ?? (workingDirectory
      ? await workingDirectory.ensure(exec.agent, exec.signal) : exec.agent.session?.header.cwd);
    if (disposed) throw new Error("调度器已释放");
    if (phase !== "standby") { member(exec.agent, true); return startupResult(); }
    if (typeof workspace !== "string" || !isAbsolute(workspace)) throw new Error("需要当前工作区绝对路径，请填写workspace");
    const stateFile = resolve(workspace, config.stateFile || ".scheduler/state.json");
    const selected = { projectFile: resolve(workspace, config.projectFile || ".scheduler/tasks.json"), stateFile,
      graphFile: config.graphFile ? resolve(workspace, config.graphFile) : resolve(dirname(stateFile), "flow.html") };
    const keys = Object.values(selected).map(path => process.platform === "win32" ? path.toLowerCase() : path);
    if (new Set(keys).size !== 3) throw new Error("任务、状态和HTML需要不同文件路径");
    paths = selected;
    phase = "planning";
    bindLead(String(m.root.id));
    return { ...startupResult(), instructions: "请先了解用户的开发测试任务。由当前Lead规划任务依赖、文件范围及专项成员，使用prepare提交完整project JSON（含name、agents和tasks）；也可先写入返回的projectFile，再调用prepare读取。成员数量按需要声明。若任务文件已存在，prepare不传project恢复原任务，再在开工后追加新需求。此时只做计划；prepare会保存任务文件、生成HTML并返回分工，然后按返回列表spawn专项成员。" };
  }

  async function prepare(args) {
    if (phase !== "planning") throw new Error("当前计划已准备，请先结束并卸载后再加载新计划");
    phase = "preparing";
    try {
      if (args.project !== undefined) {
        if (typeof args.project !== "string") throw new Error("project需要完整项目JSON文本");
        const project = normalize(JSON.parse(args.project));
        const errors = diagnose(project);
        if (errors.length) throw new Error(errors.join("\n"));
        if (!project.tasks.length || !project.agents.length) throw new Error("请先提供具体任务和专项成员计划");
        try { await access(paths.stateFile); throw new Error("已有状态不能替换计划，请不传project恢复原任务或选择新工作区"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await mkdir(dirname(paths.projectFile), { recursive: true });
        await writeFile(paths.projectFile, JSON.stringify(project, null, 2) + "\n", { flag: "wx" });
      }
      const s = await service();
      plannedAgents = s.snapshot().project.agents;
      if (!plannedAgents.length || !s.snapshot().project.tasks.length) throw new Error("请先提供具体任务和专项成员计划");
      if (!s.snapshot().paused) await s.control("pause");
      view = await startViewExport({ ...paths, onError: error => console.error("scheduler view:", error) });
      ready.clear();
      phase = "waiting";
      return { ...startupResult(), instructions: "按agents列表逐一调用spawn。每个专项成员先阅读计划并用scheduler_next的readySummary回复分工和就绪情况；全部成员就绪后插件才自动派发。" };
    } catch (error) { phase = "planning"; throw error; }
  }

  async function unload() {
    if (activeTools > 1) throw new Error("其他工具正在提交，请等待本次操作结束后卸载");
    if (["preparing", "starting", "unloading"].includes(phase)) throw new Error("启动状态正在提交，请等待本次操作结束");
    const previousPhase = phase;
    phase = "unloading";
    await wakeQueue.idle();
    const s = await servicePromise?.catch(() => undefined);
    if (s?.snapshot().runs.some(run => run.phase !== "finished")) {
      phase = previousPhase;
      throw new Error("仍有未结束运行，请先完成或确认停止并对账");
    }
    await view?.close(); view = undefined;
    await s?.store.close(); servicePromise = undefined;
    waiting.clear(); ready.clear(); plannedAgents = [];
    boundLeadId = undefined;
    phase = "standby";
    refreshTools();
    return startupResult();
  }

  async function tasksInput(args) {
    if ((args.tasks !== undefined) === (args.tasksFile !== undefined)) {
      throw new Error("add-tasks 需要 tasks 或 tasksFile，二选一");
    }
    let value;
    if (args.tasksFile !== undefined) {
      if (typeof args.tasksFile !== "string" || !args.tasksFile.trim()) throw new Error("tasksFile 需要任务 JSON 文件路径");
      value = await readJson(resolve(dirname(resolve(paths.projectFile)), args.tasksFile), "追加任务文件");
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
    if (!automatic() || !liveLead(root)) return Promise.resolve(undefined);
    return wakeQueue.request(root);
  }

  const wakeQueue = new WakeQueue(async root => {
      if (!automatic() || !liveLead(root)) return undefined;
      const s = await service(), result = { dispatched: [], errors: [] };
      const candidates = s.snapshot().project.agents.filter(agent => waiting.has(agent.id))
        .flatMap(agent => s.plan(agent.id).segments);
      await Promise.all(candidates.map(async ({ agentId }) => {
        if (!automatic() || !liveLead(root)) return;
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
        if (onDemand && target?.status === "provisioning") return;
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
    if (onDemand && phase === "standby") throw new Error("请先说加载调度器并调用load");
    if (boundLeadId === undefined) bindLead(String(m.root.id));
    if (String(m.root.id) !== boundLeadId) throw new Error("此调度器已绑定另一个 Lead");
    if (leadOnly && m.role !== "lead") throw new Error("此动作仅限 Lead");
    if (m.role === "teammate") memberNames.set(agent, m.name);
    return m;
  }

  // 绑定后只保留该团队的工具；其他 root 已注册的工具一并撤回。
  function bindLead(rootId) {
    boundLeadId = rootId;
    refreshTools();
  }

  function refreshTools() {
    for (const disposers of installed.values()) for (const dispose of disposers) dispose();
    installed.clear();
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
      async execute(args, exec) {
        if (disposed) throw new Error("调度器已释放");
        if (phase === "unloading") throw new Error("调度器正在卸载");
        activeTools++;
        try { return { result: JSON.stringify(await execute(args, exec)) }; }
        finally { activeTools--; }
      }
    });
  }

  const definitions = [
    tool("scheduler_status", "空参查看概览，摘要最多300字符；传taskId读取该任务完整摘要与最近运行。详情不检查回执到期，首次调用仍会初始化状态。", {
      taskId: textParam("可选：读取指定任务详情与完整摘要")
    }, async (args, exec) => {
      member(exec.agent);
      if (onDemand && ["planning", "preparing"].includes(phase)) return startupResult();
      const s = await service();
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
        autoDispatch: automatic(), ...waitingStatus(), ...(onDemand ? startupResult() : {}),
        runs: state.runs.filter(r => r.phase !== "finished").map(runInfo) };
    }),
    tool("scheduler_next", "专项执行者领取下一任务。收到委托可传 dispatchId 确认；当前项完成后空参领取下一项。", {
      dispatchId: textParam("收到的委托 ID"),
      readySummary: textParam("启动准备时先阅读项目计划，用一句话回复自己的分工和已就绪")
    }, async (args, exec) => {
      const m = member(exec.agent);
      if (m.role !== "teammate") throw new Error("Lead 请使用 scheduler_manage 派发");
      if (onDemand && phase !== "running") {
        if (phase !== "waiting") return { waiting: true, ...startupResult(), reason: "等待Lead准备计划" };
        if (!plannedAgents.some(a => a.id === m.name)) throw new Error("你不在本次专项成员计划内");
        const roster = ctx.agentTeams.listMembers(m.root);
        if (!roster.some(row => row.name === m.name && String(row.id) === String(exec.agent.id)
          && ["provisioning", "running", "inactive"].includes(row.status))) throw new Error("专项成员身份与持久会话不匹配");
        for (const [name, entry] of ready) {
          if (!roster.some(row => row.name === name && String(row.id) === entry.id && ["provisioning", "running", "inactive"].includes(row.status))) ready.delete(name);
        }
        if (typeof args.readySummary !== "string" || !args.readySummary.trim()) {
          return { waiting: true, ...startupResult(), reason: "阅读项目计划后，用readySummary回复分工和已就绪" };
        }
        ready.set(m.name, { id: String(exec.agent.id), summary: args.readySummary.trim() });
        waitForMember(m, exec.agent);
        if (plannedAgents.every(a => ready.has(a.id))) {
          phase = "starting";
          try { await (await service()).control("resume"); }
          catch (error) { phase = "waiting"; throw error; }
          phase = "running";
          const wakeups = await wakeReady(m.root);
          return { waiting: true, ...startupResult(), wakeups };
        }
        return { waiting: true, ...startupResult(), reason: "等待其他专项成员就绪" };
      }
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
      if (!worked && !automatic()) {
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
    tool("scheduler_manage", (onDemand ? "默认待机。用户说加载调度器时调用load；获得任务后用prepare提交完整项目JSON，按返回分工spawn；全部专项成员回复就绪才自动执行。结束后可unload返回待机。" : "") + "Lead 管理：spawn、dispatch、accept、rework、approve、pause、resume、retry、resolve-stopped、add-tasks、update-task。停止对账前先确认执行者已停止。", {
      action: textParam("管理动作", true), target: textParam("执行者名称或任务 ID"),
      workspace: textParam("load可选：工作区绝对路径，通常使用当前会话目录"),
      project: textParam("prepare可选：完整项目JSON文本，含name、agents、tasks；省略时读取既有任务文件"),
      output: textParam("仅验收指定中间产物时填写"),
      feedback: textParam("rework：具体返工反馈，不能留空"),
      changes: textParam("update-task：修改字段的 JSON 对象文本，可用 title、specFile、dependsOn、owner、resources、priority"),
      tasks: textParam("add-tasks：单任务对象或任务数组的 JSON 文本；与 tasksFile 二选一"),
      tasksFile: textParam("add-tasks：任务 JSON 文件路径，相对 projectFile 所在目录；也可用绝对路径")
    }, async (args, exec) => {
      if (onDemand && args.action === "load") return load(args, exec);
      const m = member(exec.agent, true);
      if (onDemand && args.action === "unload") return unload();
      if (onDemand && args.action === "prepare") {
        if (preparation) throw new Error("计划正在准备，请等待本次操作结束");
        preparation = prepare(args);
        try { return await preparation; }
        finally { preparation = undefined; }
      }
      if (onDemand && phase !== "running" && !(phase === "waiting" && args.action === "spawn")) {
        throw new Error("先准备计划并等待全部专项成员就绪，再开始调度");
      }
      const s = await service();
      if (args.action === "spawn") {
        const a = s.snapshot().project.agents.find(a => a.id === args.target);
        if (!a) throw new Error("执行者须先在项目中声明");
        const prompt = [{ type: "text", text: onDemand && phase === "waiting"
          ? `你是专项执行者${a.id}。先阅读项目计划${paths.projectFile}和自己相关的任务卡，只回复分工与准备情况。用scheduler_next({readySummary:"你的分工与已就绪"})通知调度器。等待全部成员就绪和正式委托后才修改文件或运行业务测试。waiting即结束回合。开始后用scheduler_report提交结果，再next继续。`
          : automatic()
            ? "你是专项执行者。先用scheduler_next领取或确认当前任务；使用scheduler_report提交简短摘要与产物引用，随后next继续。waiting即结束回合，依赖满足后插件会发送委托唤醒，不要轮询。只执行当前taskId，未知委托不重复执行。"
            : "你是专项执行者。等待 Lead 派发；收到任务后用 scheduler_next 确认委托，只执行当前任务，使用 scheduler_report 提交简短摘要与产物引用。首个任务完成后可继续领取下一项，暂无任务则停止等待。" }];
        const existing = onDemand ? ctx.agentTeams.listMembers(exec.agent).find(row => row.name === a.id) : undefined;
        if (existing) {
          if (!["running", "inactive"].includes(existing.status)) throw new Error("原专项成员不可发送，请核对会话状态");
          await ctx.agentTeams.sendMessage(exec.agent, { target: String(existing.id), content: prompt, signal: exec.signal });
          return { spawned: a.id, reused: true };
        }
        await ctx.agentTeams.spawnTeammate(exec.agent, {
          name: a.id, description: `专项执行者：${a.categories.join("、") || "通用"}`,
          prompt,
          context: "fresh", provider: config.provider ?? "spawn", signal: exec.signal
        });
        const wakeups = onDemand ? await wakeReady(exec.agent) : undefined;
        return { spawned: a.id, ...(wakeups ? { wakeups } : {}) };
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
      else if (args.action === "update-task") {
        if (typeof args.changes !== "string" || !args.changes.trim()) throw new Error("update-task 需要 changes JSON 文本");
        let changes;
        try { changes = JSON.parse(args.changes); }
        catch (error) { throw new Error(`修改任务 JSON 格式错误：${error.message}`, { cause: error }); }
        await s.updateTask(args.target, changes);
      }
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
    if (onDemand && phase === "standby") {
      if (m.role !== "lead" || (explicitLead && String(m.root.id) !== explicitLead)) return;
      installed.set(agent, definitions.filter(t => t.name === "scheduler_manage").map(t => agent.ctx.tools.register(t)));
      return;
    }
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
    await preparation?.catch(() => undefined);
    waiting.clear();
    for (const dispose of off) if (typeof dispose === "function") dispose();
    for (const disposers of installed.values()) for (const dispose of disposers) dispose();
    installed.clear();
    await wakeQueue.idle();
    await view?.close();
    const s = await servicePromise?.catch(() => undefined);
    if (s) await s.store.close();
  };
}
