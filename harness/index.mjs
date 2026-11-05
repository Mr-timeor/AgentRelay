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
  ctx.effect(() => () => {
    void dispose().catch(error => console.error("scheduler dispose:", error));
  }, "scheduler.tools");
}
