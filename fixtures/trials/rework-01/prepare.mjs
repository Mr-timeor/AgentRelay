// 只准备工作副本；调度状态由试用宿主首次初始化。
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../../..");
const runtime = join(root, ".scheduler", "trials", "rework-01");

try {
  await mkdir(dirname(runtime), { recursive: true });
  await mkdir(runtime);
  await cp(join(source, "seed"), join(runtime, "app"), { recursive: true });
  for (const folder of ["developer", "initial", "final", "snapshots"]) {
    await mkdir(join(runtime, "evidence", folder), { recursive: true });
  }
  await cp(join(source, "结果记录模板.md"), join(runtime, "result.md"));
  const result = {
    preparedAt: new Date().toISOString(), node: process.version,
    projectFile: join(source, "tasks.json"), runtime,
    app: join(runtime, "app"), stateFile: join(runtime, "state.json"),
    graphFile: join(runtime, "flow.html"), modelStarted: false
  };
  await writeFile(join(runtime, "preparation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.code === "EEXIST" ? `试用目录已存在，保留原记录：${runtime}` : String(error));
  process.exitCode = 1;
}
