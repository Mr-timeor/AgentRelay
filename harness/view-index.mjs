import z from "@deepseek-ai/schemastery";
import { startViewExport } from "./dist/ui/export-view.js";

export const name = "dynamic-task-scheduler-view";
export const Config = z.object({
  onDemand: z.boolean().default(true),
  stateFile: z.string().default(""),
  projectFile: z.string().default(""),
  graphFile: z.string().default("")
});

export function apply(ctx, config) {
  // 按需模式由调度器在准备任务后启动图导出。
  if (config.onDemand !== false) return;
  ctx.effect(() => {
    const started = startViewExport({ ...config, onError: error => console.error("scheduler view:", error) });
    started.catch(error => console.error("scheduler view unavailable:", error));
    return async () => { try { await (await started).close(); } catch { /* startup error already reported */ } };
  }, "scheduler.view-export");
}
