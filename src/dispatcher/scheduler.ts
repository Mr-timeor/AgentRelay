import { randomUUID } from "node:crypto";
import { FileStore } from "../store/file-store.js";
import { canOwn, diagnose, held, plan, segmentFrom } from "../core/planner.js";
import { normalize, type ArtifactReference, type Run, type State, type Task, type Segment } from "../core/model.js";

export type Receipt = Pick<Run, "dispatchId" | "attemptId" | "permitId">;
export interface DeliveryDependency {
  taskId: string;
  output?: string;
  reference?: ArtifactReference;
  outputs?: Record<string, ArtifactReference>;
  summary?: string;
}
export interface Delivery extends Run {
  taskId: string; agentId: string; title: string;
  task: Task;
  specFile?: string;
  acceptedOutputs?: Record<string, ArtifactReference>;
  dependencies: DeliveryDependency[];
  segment: string[]; checkpoints: unknown[]; stop: string;
  instructions: string;
  rework?: NonNullable<Run["rework"]> & { previousAttemptId: string };
}
export type Transport = (delivery: Delivery) => Promise<void>;
function event(s: State, action: string, taskId?: string, detail?: string) {
  s.history.push({ at: new Date().toISOString(), action, taskId, detail });
}
function validateReference(reference: unknown, name: string): asserts reference is ArtifactReference {
  const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  if (!nonempty(reference) && !(Array.isArray(reference) && reference.length > 0 && Array.from(reference).every(nonempty))) {
    throw new Error(`产物 ${name} 的引用须为非空字符串或非空字符串数组`);
  }
}
function outputEntries(outputs: unknown): [string, ArtifactReference][] {
  if (outputs === undefined) return [];
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(outputs))) {
    throw new Error("outputs 须为产物名称到引用的对象");
  }
  return Object.entries(outputs).map(([name, reference]) => {
    validateReference(reference, name);
    return [name, reference];
  });
}
function sameReference(a: ArtifactReference, b: ArtifactReference): boolean {
  return a === b || Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => value === b[index]);
}
function resolveDependencies(state: State, task: State["project"]["tasks"][number]): DeliveryDependency[] {
  const summarized = new Set<string>();
  return task.dependsOn.map(d => {
    const progress = state.progress[d.taskId];
    const out = d.output ? progress?.outputs[d.output] : undefined;
    const outputs = Object.fromEntries(Object.entries(progress?.outputs ?? {})
      .filter(([, value]) => value.accepted).map(([name, value]) => [name, value.reference]));
    const summary = !summarized.has(d.taskId) && progress?.summary
      ? Array.from(progress.summary).slice(0, 300).join("") + (Array.from(progress.summary).length > 300 ? "…" : "") : undefined;
    summarized.add(d.taskId);
    return {
      taskId: d.taskId,
      ...(d.output ? { output: d.output } : {}),
      ...(out?.accepted ? { reference: out.reference } : {}),
      ...(!d.output && Object.keys(outputs).length ? { outputs } : {}),
      ...(summary ? { summary } : {})
    };
  });
}
function describe(state: State, run: Run, segment: Segment): Delivery {
  const task = state.project.tasks.find(t => t.id === run.taskId)!;
  const previous = [...state.runs].reverse().find(r => r.taskId === task.id && r.rework);
  const acceptedOutputs = Object.fromEntries(Object.entries(state.progress[task.id].outputs)
    .filter(([, output]) => output.accepted).map(([name, output]) => [name, output.reference]));
  const { rework: _rework, ...current } = run;
  return structuredClone({
    ...current, title: task.title, task,
    ...(previous?.rework ? { rework: { previousAttemptId: previous.attemptId, ...previous.rework } } : {}),
    ...(task.specFile ? { specFile: task.specFile } : {}),
    ...(Object.keys(acceptedOutputs).length ? { acceptedOutputs } : {}),
    dependencies: resolveDependencies(state, task),
    segment: segment.tasks, checkpoints: segment.checkpoints, stop: segment.stop,
    instructions: (run.phase === "active" ? "当前委托已确认，直接执行当前 taskId。" : "先用scheduler_next确认，再执行当前 taskId。")
      + "如有specFile请读取任务卡，并查看dependencies中的产物引用。segment后续项仅为计划，完成后report并next继续；只报告摘要和引用。"
      + (Object.keys(acceptedOutputs).length ? "acceptedOutputs是本任务已接受的交付，请沿用这些引用，只继续未完成部分。" : "")
      + (previous ? "本项为返工，请按rework.feedback修正，rework.outputs为上次被退回提交的产物快照，其中已接受引用须保留。" : "")
  });
}
function active(s: State, agentId: string, ids: Receipt): Run {
  const run = s.runs.find(r => r.dispatchId === ids.dispatchId && r.attemptId === ids.attemptId && r.permitId === ids.permitId);
  if (!run || run.agentId !== agentId) throw new Error("委托不属于当前执行者或已更换");
  return run;
}
export class Scheduler {
  constructor(readonly store: FileStore, readonly receiptTimeoutMs = 120_000) {}
  snapshot() { return this.store.snapshot(); }
  plan(agentId?: string) {
    const s = this.snapshot();
    if (agentId !== undefined) s.project.agents = s.project.agents.filter(agent => agent.id === agentId);
    return plan(s);
  }

  delivery(run: Run): Delivery {
    const s = this.snapshot();
    const current = s.runs.find(r => r.dispatchId === run.dispatchId) ?? run;
    const task = s.project.tasks.find(t => t.id === current.taskId);
    if (!task) throw new Error("未知任务");
    return describe(s, current, segmentFrom(s, task, current.agentId));
  }

  // 先保存占用，再投递；不等待模型回执，也不自动重发。
  async dispatch(agentId: string, send: Transport): Promise<Delivery> {
    const delivery = await this.store.change(s => {
      // 指定执行者领取时，不让另一个空闲执行者的全局建议占走它可做的任务。
      const p = plan({ ...s, project: { ...s.project, agents: s.project.agents.filter(agent => agent.id === agentId) } });
      if (p.diagnostics.length) throw new Error(p.diagnostics.join("\n"));
      const segment = p.segments.find(x => x.agentId === agentId);
      if (!segment) throw Object.assign(new Error(`执行者 ${agentId} 暂无可启动任务`), { code: "NO_READY_TASK" });
      const task = s.project.tasks.find(t => t.id === segment.tasks[0])!;
      const run: Run = {
        taskId: task.id, agentId, dispatchId: randomUUID(), attemptId: randomUUID(), permitId: randomUUID(),
        phase: "awaiting", startedAt: Date.now()
      };
      s.runs.push(run); s.progress[task.id].status = "running";
      event(s, "dispatch", task.id, run.dispatchId);
      return describe(s, run, segment);
    });
    // 超时包括宿主调用悬挂；只有确认未发送的错误也统一保守保留待对账。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        send(delivery),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("投递响应超时")), this.receiptTimeoutMs); })
      ]);
    } catch (e) {
      await this.store.change(s => {
        const run = active(s, agentId, delivery);
        if (run.phase === "awaiting") run.phase = "unknown";
        event(s, "delivery-uncertain", run.taskId, String(e));
      });
    } finally { clearTimeout(timer); }
    return delivery;
  }
  async acknowledge(agentId: string, ids: Receipt): Promise<void> {
    await this.store.change(s => {
      const run = active(s, agentId, ids);
      if (run.phase === "finished") throw new Error("此轮已结束，不可再次执行");
      run.phase = "active";
      event(s, "acknowledge", run.taskId);
    });
  }
  async expire(now = Date.now()): Promise<void> {
    const expired = this.snapshot().runs.some(r => r.phase === "awaiting" && now - r.startedAt >= this.receiptTimeoutMs);
    if (!expired) return;
    await this.store.change(s => {
      for (const r of s.runs) if (r.phase === "awaiting" && now - r.startedAt >= this.receiptTimeoutMs) {
        r.phase = "unknown"; event(s, "receipt-timeout", r.taskId);
      }
    });
  }
  async report(agentId: string, ids: Receipt, report: {
    status: "completed" | "blocked" | "failed" | "checkpoint";
    summary: string; outputs?: Record<string, ArtifactReference>;
  }): Promise<void> {
    await this.store.change(s => {
      const run = active(s, agentId, ids);
      if (run.phase !== "active") throw new Error("请先确认当前委托，结束或未知的运行不能提交");
      if (!["completed", "blocked", "failed", "checkpoint"].includes(report.status)) throw new Error("未知结果状态");
      const task = s.project.tasks.find(t => t.id === run.taskId)!, progress = s.progress[task.id];
      for (const [name, reference] of outputEntries(report.outputs)) {
        if (!task.outputs.includes(name)) throw new Error(`未声明产物：${name}`);
        const previous = Object.hasOwn(progress.outputs, name) ? progress.outputs[name] : undefined;
        if (previous?.accepted) {
          if (!sameReference(previous.reference, reference)) throw new Error(`产物 ${name} 已被接受，请新增修订任务`);
          continue;
        }
        progress.outputs = { ...progress.outputs, [name]: { accepted: !task.review, reference: structuredClone(reference) } };
      }
      if (report.status === "completed" && task.outputs.some(o => !Object.hasOwn(progress.outputs, o))) {
        throw new Error("请补齐声明产物的引用");
      }
      progress.summary = report.summary; run.summary = report.summary;
      if (report.status !== "checkpoint") {
        progress.status = report.status === "completed" && task.review ? "review" : report.status;
        run.phase = "finished";
      }
      event(s, report.status, task.id, report.summary);
    });
  }
  async accept(taskId: string, output?: string): Promise<void> {
    await this.store.change(s => {
      const p = s.progress[taskId];
      if (!p) throw new Error("未知任务");
      if (output) {
        if (!Object.hasOwn(p.outputs, output) || !["running", "review"].includes(p.status)) throw new Error("无待验收产物");
        if (!p.outputs[output].accepted) validateReference(p.outputs[output].reference, output);
        p.outputs[output].accepted = true;
      } else {
        if (p.status !== "review") throw new Error("任务未进入验收");
        for (const [name, value] of Object.entries(p.outputs)) if (!value.accepted) validateReference(value.reference, name);
        p.status = "completed";
        Object.values(p.outputs).forEach(o => { o.accepted = true; });
      }
      event(s, "accept", taskId, output);
    });
  }
  async rework(taskId: string, feedback: string): Promise<void> {
    await this.store.change(s => {
      const task = s.project.tasks.find(t => t.id === taskId);
      if (!task) throw new Error("需要有效 taskId");
      if (typeof feedback !== "string" || !feedback.trim()) throw new Error("返工需要具体 feedback");
      const p = s.progress[taskId];
      if (!task.review || p.status !== "review") throw new Error("仅待验收任务可退回返工");
      if (held(s).some(r => r.taskId === taskId)) throw new Error("任务仍有未结束运行，请先核对现场");
      const run = s.runs.filter(r => r.taskId === taskId).at(-1);
      if (!run || run.phase !== "finished" || run.rework) throw new Error("没有可退回的已结束提交");
      run.rework = { feedback, outputs: structuredClone(p.outputs) };
      p.status = "pending";
      p.outputs = Object.fromEntries(Object.entries(p.outputs).filter(([, output]) => output.accepted));
      delete p.summary;
      event(s, "rework", taskId, feedback);
    });
  }
  async control(action: "pause" | "resume" | "approve" | "retry" | "resolve-stopped", taskId?: string): Promise<void> {
    await this.store.change(s => {
      if (action === "pause" || action === "resume") s.paused = action === "pause";
      else {
        const p = taskId ? s.progress[taskId] : undefined;
        if (!p) throw new Error("需要有效 taskId");
        if (action === "approve") p.approved = true;
        else if (action === "resolve-stopped") {
          const run = held(s).find(r => r.taskId === taskId);
          if (!run) throw new Error("没有待对账运行");
          run.phase = "finished"; p.status = "blocked";
        } else {
          if (!["failed", "blocked"].includes(p.status) || held(s).some(r => r.taskId === taskId)) throw new Error("任务仍在执行或不需要重试");
          // 继续未完成部分，保留已交付引用和已解锁下游，仅清理未接受草稿。
          p.status = "pending";
          p.outputs = Object.fromEntries(Object.entries(p.outputs).filter(([, output]) => output.accepted));
        }
      }
      event(s, action, taskId);
    });
  }
  async addTasks(tasks: unknown[]): Promise<void> {
    await this.store.change(s => {
      const project = normalize({ ...s.project, tasks: [...s.project.tasks, ...tasks] });
      const errors = diagnose(project);
      if (errors.length) throw new Error(errors.join("\n"));
      const added = project.tasks.filter(t => !Object.hasOwn(s.progress, t.id));
      s.progress = { ...s.progress, ...Object.fromEntries(added.map(t => [t.id,
        { status: "pending", approved: !t.approval, outputs: {} }])) };
      s.project = project;
      event(s, "add-tasks", undefined, String(tasks.length));
    });
  }
  async updateTask(taskId: string, changes: unknown): Promise<void> {
    await this.store.change(s => {
      const task = s.project.tasks.find(t => t.id === taskId);
      if (!task) throw new Error("需要有效 taskId");
      if (s.progress[taskId].status !== "pending" || s.runs.some(run => run.taskId === taskId)) {
        throw new Error("仅未派发过的 pending 任务可修改，请为已执行任务新增修订任务");
      }
      if (!changes || typeof changes !== "object" || Array.isArray(changes)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(changes))) {
        throw new Error("changes 须为非空任务修改对象");
      }
      const patch = structuredClone(changes) as Record<string, unknown>, fields = Object.keys(patch);
      const allowed = ["title", "specFile", "dependsOn", "owner", "resources", "priority"];
      if (!fields.length || fields.some(field => !allowed.includes(field))) {
        throw new Error("仅可修改 title、specFile、dependsOn、owner、resources、priority，且至少提供一项");
      }
      if (Object.hasOwn(patch, "title") && (typeof patch.title !== "string" || !patch.title.trim())) {
        throw new Error("title 须为非空字符串");
      }
      for (const field of ["owner", "specFile"] as const) {
        if (Object.hasOwn(patch, field) && patch[field] !== null && typeof patch[field] !== "string") {
          throw new Error(`${field} 须为字符串或 null`);
        }
      }
      for (const field of ["dependsOn", "resources"] as const) {
        if (Object.hasOwn(patch, field) && !Array.isArray(patch[field])) throw new Error(`${field} 须为数组`);
      }
      if (Object.hasOwn(patch, "priority") && !Number.isFinite(patch.priority)) throw new Error("priority 须为有限数字");
      const project = normalize({ ...s.project, tasks: s.project.tasks.map(t => t.id === taskId ? { ...t, ...patch } : t) });
      const errors = diagnose(project);
      if (errors.length) throw new Error(errors.join("\n"));
      const updated = project.tasks.find(t => t.id === taskId)!;
      if (updated.owner && !canOwn({ ...s, project }, updated, updated.owner)) {
        throw new Error(`执行者 ${updated.owner} 不支持任务类别 ${updated.category}`);
      }
      s.project = project;
      if (updated.approval) s.progress[taskId].approved = false;
      event(s, "update-task", taskId, fields.join(","));
    });
  }
}
