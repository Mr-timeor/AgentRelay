import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { install } from "./adapter.mjs";

export const name = "dynamic-task-scheduler";
export const inject = ["agents", "agentTeams", "tools"];
export const Config = z.object({
  onDemand: z.boolean().default(true),
  leadSessionId: z.string().default("auto"),
  projectFile: z.string().default(""),
  stateFile: z.string().default(""),
  graphFile: z.string().default(""),
  provider: z.string().default("spawn"),
  autoDispatch: z.boolean().default(false),
  receiptTimeoutMs: z.number().default(120000)
});

export function apply(ctx, config) {
  const dispose = install(ctx, config, { defineTool, z });
  // 宿主会等待清理Promise；不能用void丢弃，否则状态锁尚未释放就会完成卸载。
  ctx.effect(() => dispose, "scheduler.tools");
}
