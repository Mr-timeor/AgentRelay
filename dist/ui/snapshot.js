import { readFile } from "node:fs/promises";
import { initial, normalize } from "../core/model.js";
import { diagnose } from "../core/planner.js";
// 只读入口不打开FileStore，避免浏览图触发写者占用或重启对账。
export async function readViewState(stateFile, projectFile) {
    let state;
    try {
        state = JSON.parse(await readFile(stateFile, "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT" || !projectFile)
            throw error;
        const project = normalize(JSON.parse(await readFile(projectFile, "utf8")));
        const errors = diagnose(project);
        if (errors.length)
            throw new Error(errors.join("；"));
        return initial(project);
    }
    if (state.version !== 1 || !Number.isInteger(state.revision) || !state.project?.tasks
        || !state.progress || !Array.isArray(state.runs))
        throw new Error("无法读取调度状态");
    for (const task of state.project.tasks) {
        if (!state.progress[task.id])
            throw new Error(`任务状态缺失：${task.id}`);
    }
    return state;
}
