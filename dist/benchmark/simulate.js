import { initial, normalize } from "../core/model.js";
import { canOwn, conflicts, diagnose, held, plan, reasons } from "../core/planner.js";
export const policies = ["segments", "per-task", "category", "topological"];
export const policyNames = {
    segments: "当前执行段策略", "per-task": "逐任务派发", category: "按类别整包", topological: "仅拓扑排序"
};
// 时间由合成事件推进；plan 中的虚拟完成从不写入这里的事实状态。
export function scenario(input) {
    const project = normalize(input.project), errors = diagnose(project);
    if (errors.length)
        throw new Error(errors.join("；"));
    const result = {
        name: input.name ?? project.name, description: input.description, project,
        timing: input.timing ?? {}, dispatchOverhead: input.dispatchOverhead ?? 1,
        continuationOverhead: input.continuationOverhead ?? 0.1
    };
    const positive = (value, label, allowZero = true) => {
        if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0))
            throw new Error(`无效时间：${label}`);
    };
    positive(result.dispatchOverhead, "dispatchOverhead");
    positive(result.continuationOverhead, "continuationOverhead");
    for (const task of project.tasks) {
        const timing = result.timing[task.id];
        if (!timing)
            throw new Error(`缺少合成耗时：${task.id}`);
        positive(timing.duration, task.id, false);
        for (const value of timing.failedAttempts ?? [])
            positive(value, `${task.id}/failedAttempts`, false);
        for (const value of [timing.retryDelay ?? 0, timing.reviewDelay ?? 0, timing.approvalAt ?? 0])
            positive(value, task.id);
        for (const [output, offset] of Object.entries(timing.checkpoints ?? {})) {
            positive(offset, `${task.id}/${output}`);
            if (!task.outputs.includes(output) || offset >= timing.duration)
                throw new Error(`无效交付点：${task.id}/${output}`);
        }
        // 首版不模拟失败后撤回已被消费的产物，避免悄悄隐去返工。
        if (timing.failedAttempts?.length && Object.keys(timing.checkpoints ?? {}).length) {
            throw new Error(`失败任务暂不支持提前交付：${task.id}`);
        }
    }
    return result;
}
function topology(project) {
    const result = [], remaining = new Set(project.tasks.map(t => t.id));
    while (remaining.size) {
        const task = project.tasks.find(t => remaining.has(t.id) && t.dependsOn.every(d => !remaining.has(d.taskId)));
        if (!task)
            throw new Error("任务图不是 DAG");
        remaining.delete(task.id);
        result.push(task);
    }
    return result;
}
export function simulate(input, policy) {
    if (!policies.includes(policy))
        throw new Error(`未知策略：${policy}`);
    const spec = scenario(input), state = initial(spec.project), ordered = topology(spec.project);
    const events = [], batches = new Map(), attempts = new Map();
    const assigned = new Map(), consumed = new Set();
    const result = {
        policy, completed: false, makespan: null, elapsed: 0, work: 0, overhead: 0, idle: 0, blocked: 0,
        dispatches: 0, claims: 0, handoffs: 0, deliveries: 0, outputDeliveries: 0, failures: 0, rework: 0,
        violations: [], unfinished: [], trace: []
    };
    let now = 0, sequence = 0;
    const after = (delay, apply) => events.push({ at: now + delay, seq: sequence++, apply });
    const record = (event, taskId, more = {}) => result.trace.push({ at: now, event, taskId, ...more });
    function acceptOutput(task, output) {
        if (!state.progress[task.id].outputs[output]?.accepted)
            result.outputDeliveries++;
        state.progress[task.id].outputs[output] = { reference: `synthetic:${task.id}/${output}`, accepted: true };
        record("accept-output", task.id, { output });
    }
    function acceptTask(task) {
        state.progress[task.id].status = "completed";
        for (const output of task.outputs)
            acceptOutput(task, output);
        result.deliveries++;
        record("accept-task", task.id);
    }
    function eligible(task, agentId) { return canOwn(state, task, agentId) && reasons(state, task).length === 0; }
    function choose(agentId) {
        const old = batches.get(agentId);
        if (old && old.used < state.project.maxSegment) {
            const task = old.category
                ? ordered.find(t => t.category === old.category && eligible(t, agentId))
                : state.project.tasks.find(t => t.id === old.tasks[0] && eligible(t, agentId));
            if (task)
                return { task, batch: old, fresh: false };
        }
        if (policy === "segments" || policy === "per-task") {
            const view = policy === "per-task" ? { ...state, project: { ...state.project, maxSegment: 1 } } : state;
            const segment = plan(view).segments.find(s => s.agentId === agentId);
            if (!segment)
                return;
            return { task: state.project.tasks.find(t => t.id === segment.tasks[0]),
                batch: { number: result.dispatches + 1, tasks: [...segment.tasks], used: 0 }, fresh: true };
        }
        const task = ordered.find(t => eligible(t, agentId));
        if (!task)
            return;
        return { task, batch: { number: result.dispatches + 1, tasks: [task.id], used: 0,
                ...(policy === "category" ? { category: task.category } : {}) }, fresh: true };
    }
    function start(agentId, task, batch, fresh) {
        // 所有策略经过同一个启动检查，并在委托开销开始时占用执行者和任务资源。
        const faults = [...reasons(state, task)];
        if (!canOwn(state, task, agentId))
            faults.push("执行者职责不匹配");
        if (held(state).some(r => r.agentId === agentId))
            faults.push("执行者容量超限");
        if (faults.length) {
            result.violations.push(`${now}/${task.id}：${faults.join("、")}`);
            return;
        }
        if (fresh)
            result.dispatches++;
        result.claims++;
        batch.used++;
        batch.tasks = batch.tasks.filter(id => id !== task.id);
        batches.set(agentId, batch);
        const attempt = (attempts.get(task.id) ?? 0) + 1;
        attempts.set(task.id, attempt);
        const timing = spec.timing[task.id], failed = attempt <= (timing.failedAttempts?.length ?? 0);
        const duration = failed ? timing.failedAttempts[attempt - 1] : timing.duration;
        const overhead = fresh ? spec.dispatchOverhead : spec.continuationOverhead;
        result.work += duration;
        result.overhead += overhead;
        if (failed)
            result.rework += duration;
        const run = { taskId: task.id, agentId, dispatchId: String(result.claims), attemptId: String(attempt),
            permitId: "synthetic", phase: "active", startedAt: now };
        state.runs.push(run);
        state.progress[task.id].status = "running";
        assigned.set(task.id, agentId);
        record("start", task.id, { agentId, attempt, batch: batch.number });
        for (const d of task.dependsOn) {
            const key = `${task.id}/${d.taskId}/${d.output ?? ""}`;
            if (!consumed.has(key) && assigned.get(d.taskId) !== agentId)
                result.handoffs++;
            consumed.add(key);
        }
        if (!failed)
            for (const [output, offset] of Object.entries(timing.checkpoints ?? {}))
                after(overhead + offset, () => {
                    state.progress[task.id].outputs[output] = { accepted: false, reference: `synthetic:${task.id}/${output}` };
                    record("checkpoint", task.id, { output });
                    after(task.review ? timing.reviewDelay ?? 0 : 0, () => acceptOutput(task, output));
                });
        after(overhead + duration, () => {
            run.phase = "finished";
            if (failed) {
                result.failures++;
                state.progress[task.id].status = "failed";
                batches.delete(agentId);
                record("failed", task.id, { agentId, attempt });
                after(timing.retryDelay ?? 0, () => { state.progress[task.id].status = "pending"; record("retry", task.id); });
            }
            else {
                record("completed", task.id, { agentId, attempt });
                if (task.review) {
                    state.progress[task.id].status = "review";
                    after(timing.reviewDelay ?? 0, () => acceptTask(task));
                }
                else
                    acceptTask(task);
            }
        });
    }
    for (const task of state.project.tasks)
        if (task.approval)
            after(spec.timing[task.id].approvalAt ?? 0, () => {
                state.progress[task.id].approved = true;
                record("approve", task.id);
            });
    while (true) {
        // 同时刻的授权、验收、失败和交付先全部落地，再重新判断 ready。
        while (events.some(e => e.at <= now)) {
            events.sort((a, b) => a.at - b.at || a.seq - b.seq);
            events.shift().apply();
        }
        if (state.project.tasks.every(t => state.progress[t.id].status === "completed"))
            break;
        for (const agent of state.project.agents) {
            if (held(state).some(r => r.agentId === agent.id))
                continue;
            const choice = choose(agent.id);
            if (choice)
                start(agent.id, choice.task, choice.batch, choice.fresh);
        }
        if (!events.length)
            break;
        const next = Math.min(...events.map(e => e.at)), elapsed = next - now;
        for (const agent of state.project.agents)
            if (!held(state).some(r => r.agentId === agent.id)) {
                result.idle += elapsed;
                if (state.project.tasks.some(t => state.progress[t.id].status !== "completed" && canOwn(state, t, agent.id)))
                    result.blocked += elapsed;
            }
        now = next;
    }
    result.elapsed = now;
    result.unfinished = state.project.tasks.filter(t => state.progress[t.id].status !== "completed").map(t => t.id);
    result.completed = result.unfinished.length === 0;
    result.makespan = result.completed ? now : null;
    result.violations.push(...auditTrace(spec, result.trace));
    return result;
}
// 独立检查轨迹的关键约束；不能只靠选择器声称自己没有违规。
export function auditTrace(spec, trace) {
    const faults = [], running = new Map();
    const completed = new Set(), outputs = new Set(), approved = new Set();
    for (const row of trace) {
        const task = spec.project.tasks.find(t => t.id === row.taskId);
        if (!task) {
            faults.push(`未知任务：${row.taskId}`);
            continue;
        }
        if (row.event === "approve")
            approved.add(task.id);
        if (row.event === "accept-output")
            outputs.add(`${task.id}/${row.output}`);
        if (row.event === "accept-task")
            completed.add(task.id);
        if (row.event === "start") {
            if (task.approval && !approved.has(task.id))
                faults.push(`未授权：${task.id}`);
            for (const dep of task.dependsOn)
                if (dep.output ? !outputs.has(`${dep.taskId}/${dep.output}`) : !completed.has(dep.taskId))
                    faults.push(`提前消费：${task.id}`);
            for (const other of running.values()) {
                if (other.agentId === row.agentId)
                    faults.push(`执行者重叠：${row.agentId}`);
                if (conflicts(task.resources, other.task.resources))
                    faults.push(`资源重叠：${task.id}/${other.task.id}`);
            }
            running.set(task.id, { task, agentId: row.agentId });
        }
        if (row.event === "failed" || row.event === "completed")
            running.delete(task.id);
    }
    return faults;
}
