// 在独立DSH_HOME中加载按需启动插件，模型端点仅为本地mock。
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startStartupMock } from "./mock-startup.mjs";
import { saveProbeReport } from "./probe-result.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const preparedFile = process.env.SCHEDULER_STARTUP_PREPARED || join(root, ".harness-startup/prepared.json");
const prepared = JSON.parse(await readFile(preparedFile, "utf8"));
process.env.DSH_HOME = prepared.home;
process.env.SCHEDULER_STARTUP_PREPARED = preparedFile;
process.env.SCHEDULER_STARTUP_MOCK_KEY = "mock";
const runId = process.env.SCHEDULER_STARTUP_RUN_ID || randomUUID();
const reportFile = process.env.SCHEDULER_STARTUP_REPORT || join(root, ".scheduler/startup-host-reports", runId, "report.json");
const output = dirname(reportFile);
process.env.SCHEDULER_STARTUP_REPORT_DIR = output;
await mkdir(output, { recursive: true });
let mock, booted, reopened = false;
let result = { steps: [], errors: [] };
const cleanupErrors = [];
try {
  await writeFile(prepared.logFile, "");
  mock = await startStartupMock(prepared.logFile);
  const patch = await readFile(prepared.patchFile, "utf8");
  if (!patch.includes("__STARTUP_MOCK_BASE_URL__")) throw new Error("该隔离profile已运行，请重新setup生成独立现场");
  await writeFile(prepared.patchFile, patch.replace("__STARTUP_MOCK_BASE_URL__", mock.url));
  const resources = process.env.SCHEDULER_STARTUP_HOST_RESOURCES || "D:/deepseek-harness/desktop/resources";
  const modulePath = name => pathToFileURL(join(resources, "app.asar/dsh/node_modules/@deepseek-ai", name, "lib", name === "dsh" ? "profile-boot.js" : "index.js")).href;
  const [{ runProfile }, { loadLayeredEnv }] = await Promise.all([
    import(modulePath("dsh")), import(modulePath("dsh-app-boot"))
  ]);
  booted = await runProfile({ environment: loadLayeredEnv("dsh"), profile: prepared.profile, patchFiles: [], args: [] });
  if (!globalThis.__schedulerStartupProbe) throw new Error("按需启动探针未加载");
  result = await globalThis.__schedulerStartupProbe;
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
}
for (const [source, name] of [[prepared.stateFile, "state-at-result.json"], [prepared.graphFile, "flow-at-result.html"], [prepared.logFile, "mock.jsonl"]]) {
  try { await copyFile(source, join(output, name)); }
  catch (error) { cleanupErrors.push(`现场${name}：${String(error)}`); }
}
try { await booted?.ctx.fiber.dispose(); }
catch (error) { cleanupErrors.push(`宿主清理：${String(error)}`); }
try { await mock?.close(); }
catch (error) { cleanupErrors.push(`mock清理：${String(error)}`); }
try {
  const { FileStore } = await import(pathToFileURL(join(prepared.installedBundle, "dist/store/file-store.js")));
  const store = await FileStore.open(prepared.stateFile);
  reopened = true;
  await store.close();
} catch (error) { cleanupErrors.push(`状态复开：${String(error)}`); }
const report = await saveProbeReport(reportFile, {
  runId, mode: "startup", result, reopened, cleanupErrors, sourceBundle: prepared.sourceBundle,
  installedBundle: prepared.installedBundle, installationMode: prepared.installationMode,
  workspace: prepared.workspace, node: process.version, reportFile, realModelCalls: 0
});
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
