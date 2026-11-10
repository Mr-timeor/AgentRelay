export function diagnose(project) {
    const tasks = new Map(project.tasks.map(t => [t.id, t]));
    const errors = [];
    for (const t of project.tasks)
        for (const d of t.dependsOn) {
            if (!tasks.has(d.taskId))
                errors.push(`${t.id} 缺少前置 ${d.taskId}`);
            else if (d.output && !tasks.get(d.taskId).outputs.includes(d.output))
                errors.push(`${t.id} 引用未知产物 ${d.taskId}/${d.output}`);
        }
    const visited = new Set(), stack = [];
    function visit(id) {
        if (stack.includes(id)) {
            errors.push(`循环：${[...stack.slice(stack.indexOf(id)), id].join(" → ")}`);
            return;
        }
        if (visited.has(id) || !tasks.has(id))
            return;
        stack.push(id);
        for (const d of tasks.get(id).dependsOn)
            visit(d.taskId);
        stack.pop();
        visited.add(id);
    }
    for (const t of project.tasks)
        visit(t.id);
    return errors;
}
export function satisfied(state, d) {
    const p = state.progress[d.taskId];
    return d.output ? p?.outputs[d.output]?.accepted === true : p?.status === "completed";
}
export function held(state) { return state.runs.filter(r => r.phase !== "finished"); }
export function resourcePath(value) {
    const parts = [];
    for (const part of value.replaceAll("\\", "/").toLowerCase().split("/")) {
        if (!part || part === ".")
            continue;
        if (part === "..") {
            if (parts.length === 0)
                throw new Error("资源范围不能越过项目根目录");
            parts.pop();
        }
        else
            parts.push(part);
    }
    return parts.join("/");
}
export function conflicts(a, b) {
    return a.some(x => b.some(y => {
        if (x.mode === "read" && y.mode === "read")
            return false;
        const p = resourcePath(x.path), q = resourcePath(y.path);
        return !p || !q || p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
    }));
}
export function reasons(state, t) {
    const p = state.progress[t.id], result = [];
    if (state.paused)
        result.push("调度已暂停");
    if (p.status !== "pending")
        result.push(`状态：${p.status}`);
    if (!p.approved)
        result.push("等待授权");
    for (const d of t.dependsOn)
        if (!satisfied(state, d))
            result.push(`等待 ${d.taskId}${d.output ? `/${d.output}` : ""}`);
    for (const r of held(state)) {
        const other = state.project.tasks.find(x => x.id === r.taskId);
        if (conflicts(t.resources, other.resources))
            result.push(`资源被 ${other.id} 占用`);
    }
    return result;
}
export function canOwn(state, task, agentId) {
    const a = state.project.agents.find(x => x.id === agentId);
    return !!a && (!task.owner || task.owner === agentId)
        && (!a.categories.length || a.categories.includes(task.category));
}
function unlocks(project, id) {
    const seen = new Set();
    function visit(parent) {
        for (const t of project.tasks)
            if (!seen.has(t.id) && t.dependsOn.some(d => d.taskId === parent)) {
                seen.add(t.id);
                visit(t.id);
            }
    }
    visit(id);
    return seen.size;
}
// 以指定首项延伸建议段；也用于给已领取任务重建上下文，不改变真实占用。
export function segmentFrom(state, first, agentId, reserved = new Set()) {
    const virtual = structuredClone(state), tasks = [];
    virtual.runs = virtual.runs.filter(r => r.taskId !== first.id || r.agentId !== agentId || r.phase === "finished");
    let next = first, stop = "等待外部前置或没有连续任务";
    while (next && tasks.length < state.project.maxSegment) {
        tasks.push(next.id);
        reserved.add(next.id);
        if (next.review) {
            stop = "等待检查点验收";
            break;
        }
        virtual.progress[next.id].status = "completed";
        for (const output of next.outputs)
            virtual.progress[next.id].outputs[output] = { accepted: true, reference: "仅规划" };
        const previous = next.id;
        next = state.project.tasks.filter(t => !reserved.has(t.id) && canOwn(state, t, agentId)
            && t.dependsOn.some(d => d.taskId === previous) && !reasons(virtual, t).length)
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
    }
    if (tasks.length === state.project.maxSegment)
        stop = "达到段长上限";
    const checkpoints = [];
    for (const id of tasks) {
        const consumers = state.project.tasks.filter(t => !tasks.includes(t.id) && t.dependsOn.some(d => d.taskId === id));
        for (const key of new Set(consumers.flatMap(t => t.dependsOn.filter(d => d.taskId === id).map(d => d.output)))) {
            checkpoints.push({ taskId: id, ...(key ? { output: key } : {}),
                consumers: consumers.filter(t => t.dependsOn.some(d => d.taskId === id && d.output === key)).map(t => t.id) });
        }
    }
    return { agentId, tasks, checkpoints, stop };
}
export function plan(state) {
    const diagnostics = diagnose(state.project);
    if (diagnostics.length)
        return { diagnostics, ready: [], segments: [], blocked: {} };
    const blocked = Object.fromEntries(state.project.tasks.map(t => [t.id, reasons(state, t)]));
    const candidates = state.project.tasks.filter(t => !blocked[t.id].length).sort((a, b) => a.priority - b.priority || unlocks(state.project, b.id) - unlocks(state.project, a.id) || a.id.localeCompare(b.id));
    const reserved = new Set(), chosen = [], segments = [];
    for (const agent of state.project.agents) {
        if (held(state).some(r => r.agentId === agent.id))
            continue;
        const first = candidates.find(t => !reserved.has(t.id) && canOwn(state, t, agent.id)
            && !chosen.some(c => conflicts(t.resources, c.resources)));
        if (!first)
            continue;
        chosen.push(first);
        segments.push(segmentFrom(state, first, agent.id, reserved));
    }
    return { diagnostics, ready: candidates.map(t => t.id), segments, blocked };
}
