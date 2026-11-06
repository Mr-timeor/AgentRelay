import { watch } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { renderGraph } from "./graph.js";
import { readViewState } from "./snapshot.js";
import { replaceOutput } from "./replace-output.js";

export interface ViewExportOptions {
  stateFile: string;
  graphFile: string;
  projectFile?: string;
  onError?: (error: unknown) => void;
}

// 宿主现有Files / Document Preview负责显示与文件刷新；这里不启动HTTP服务。
export async function startViewExport(options: ViewExportOptions, replace = replaceOutput) {
  const stateFile = resolve(options.stateFile), graphFile = resolve(options.graphFile);
  const key = (p: string) => process.platform === "win32" ? p.toLowerCase() : p;
  if (key(stateFile) === key(graphFile) || (options.projectFile && key(resolve(options.projectFile)) === key(graphFile))) {
    throw new Error("流程图输出不能覆盖任务或状态文件");
  }
  await mkdir(dirname(graphFile), { recursive: true });
  // 图可先于调度器启动；仅建立监听目录，不创建或修改状态文件。
  await mkdir(dirname(stateFile), { recursive: true });
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const refresh = () => {
    const job = tail.then(async () => {
      if (stopped) return;
      const state = await readViewState(stateFile, options.projectFile);
      const html = renderGraph(state), temp = `${graphFile}.${randomUUID()}.tmp`;
      try { await writeFile(temp, html, "utf8"); await replace(temp, graphFile); }
      finally { await unlink(temp).catch(() => {}); }
      return { revision: state.revision, graphFile };
    });
    tail = job.catch(() => {});
    return job;
  };
  const observer = watch(dirname(stateFile), (_event, filename) => {
    if (filename && String(filename).toLowerCase() !== basename(stateFile).toLowerCase()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh().catch(options.onError ?? console.error); }, 80);
  });
  observer.on("error", error => options.onError?.(error));
  try { await refresh(); }
  catch (error) { observer.close(); throw error; }
  return {
    graphFile,
    refresh,
    async close() { stopped = true; clearTimeout(timer); observer.close(); await tail; }
  };
}
