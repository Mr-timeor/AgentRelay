// 缺省业务参数直接补齐；只拒绝无法调度的结构。
export function normalize(input) {
    if (!input || !Array.isArray(input.tasks) || !Array.isArray(input.agents)) {
        throw new Error("输入需要 tasks 和 agents 数组");
    }
    const project = {
        name: input.name ?? "未命名项目",
        maxSegment: input.maxSegment ?? 4,
        agents: input.agents.map((a) => ({ id: a.id, categories: a.categories ?? [] })),
        tasks: input.tasks.map((t) => ({
            id: t.id, title: t.title ?? t.id, category: t.category ?? "general",
            dependsOn: (t.dependsOn ?? []).map((d) => typeof d === "string" ? { taskId: d } : d),
            resources: (t.resources ?? []).map((r) => typeof r === "string" ? { path: r, mode: "write" } : r),
            outputs: t.outputs ?? [], priority: t.priority ?? 2,
            review: t.review ?? false, approval: t.approval ?? false,
            ...(t.owner ? { owner: t.owner } : {}),
            ...(t.specFile !== undefined && t.specFile !== null && t.specFile !== "" ? { specFile: t.specFile } : {})
        }))
    };
    if (!Number.isInteger(project.maxSegment) || project.maxSegment < 1 || project.maxSegment > 100) {
        throw new Error("maxSegment 应为 1 至 100");
    }
    for (const [label, rows] of [["任务", project.tasks], ["执行者", project.agents]]) {
        const ids = new Set();
        for (const row of rows) {
            if (typeof row.id !== "string" || !/^[\p{L}\p{N}_.-]+$/u.test(row.id) || ids.has(row.id)) {
                throw new Error(`${label} ID 缺失、重复或包含不支持的字符：${row.id}`);
            }
            ids.add(row.id);
        }
    }
    for (const t of project.tasks) {
        if (t.owner && !project.agents.some(a => a.id === t.owner))
            throw new Error(`未知执行者：${t.owner}`);
        if (t.specFile !== undefined) {
            if (typeof t.specFile !== "string" || !t.specFile.trim())
                throw new Error(`无效任务卡路径：${t.id}`);
            if (/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(t.specFile))
                throw new Error(`任务卡使用项目相对路径：${t.id}`);
            let depth = 0;
            for (const part of t.specFile.replaceAll("\\", "/").split("/")) {
                if (part === "..") {
                    if (--depth < 0)
                        throw new Error(`任务卡超出项目根目录：${t.id}`);
                }
                else if (part && part !== ".")
                    depth++;
            }
        }
        if (!Number.isFinite(t.priority))
            throw new Error(`无效优先级：${t.id}`);
        if (!Array.isArray(t.outputs) || t.outputs.some(o => typeof o !== "string"))
            throw new Error(`无效产物：${t.id}`);
        for (const r of t.resources) {
            if (typeof r.path !== "string" || !r.path.trim() || !["read", "write"].includes(r.mode)) {
                throw new Error(`无效资源：${t.id}`);
            }
            if (/^(?:[a-z]:|[/\\])/i.test(r.path))
                throw new Error(`资源使用项目相对路径：${t.id}`);
            let depth = 0;
            for (const part of r.path.replaceAll("\\", "/").split("/")) {
                if (part === "..") {
                    if (--depth < 0)
                        throw new Error(`资源超出项目根目录：${t.id}`);
                }
                else if (part && part !== ".")
                    depth++;
            }
        }
    }
    return project;
}
export function initial(project) {
    return {
        version: 1, revision: 0, project, paused: false, runs: [], history: [],
        progress: Object.fromEntries(project.tasks.map(t => [
            t.id, { status: "pending", approved: !t.approval, outputs: {} }
        ]))
    };
}
