// 用真实宿主验证可选只读图插件；不创建Agent，不调用模型，不写真实DSH_HOME。
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initial, normalize } from "../dist/core/model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportFile = process.env.SCHEDULER_VIEW_REPORT ?? join(root, ".scheduler", "view-host-report.json");
const sourceViewBundle = resolve(process.env.SCHEDULER_VIEW_BUNDLE_DIR || join(root, "harness", "view-bundle"));
const coldStart = process.env.SCHEDULER_VIEW_COLD_START === "1";
const runId = process.env.SCHEDULER_VIEW_RUN_ID;
await mkdir(join(root, ".scheduler"), { recursive: true });
const work = await mkdtemp(join(root, ".scheduler", "view-host-"));
const home = join(work, "home"), profile = join(home, "profiles", "scheduler-view");
const stateFile = coldStart ? join(work, "state", "state.json") : join(work, "state.json");
const projectFile = join(work, "project.json"), graphFile = join(work, "flow.html");
const steps = [];
const report = { runId, sourceViewBundle, coldStart, work, stateFile, graphFile, modelCalls: 0, steps };
process.env.DSH_HOME = home;
await mkdir(join(profile, "node_modules"), { recursive: true });
await cp(sourceViewBundle, join(profile, "node_modules", "dynamic-task-scheduler-view"), { recursive: true });
await writeFile(join(profile, "package.json"), JSON.stringify({ name: "scheduler-view-isolated", private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dynamic-task-scheduler-view"] } } }));
await writeFile(join(profile, "cordis.yml"), "[]\n");
await writeFile(join(profile, "cordis.patch.yml"), `- id: dynamic-task-scheduler-view\n  disabled: false\n  config:\n    stateFile: '${stateFile.replaceAll("\\", "/")}'\n    projectFile: '${projectFile.replaceAll("\\", "/")}'\n    graphFile: '${graphFile.replaceAll("\\", "/")}'\n`);
const project = normalize({ name: "隔离只读图", agents: [], tasks: [{ id: "a" }] });
const state = initial(project);
const original = JSON.stringify(state);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitRevision(revision) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const html = await readFile(graphFile, "utf8").catch(() => "");
    if (html.includes(`data-scheduler-revision="${revision}"`)) return html;
    await delay(50);
  }
  throw new Error(`等待导出revision ${revision}超时`);
}
let booted;
// 没有Agent的最小profile在启动期间可能没有其他事件源，保留一个有界计时器。
const startupTimeout = setTimeout(() => { console.error("view host startup timeout"); process.exitCode = 1; }, 20000);
try {
  await writeFile(projectFile, JSON.stringify(project));
  if (coldStart) {
    await assert.rejects(stat(dirname(stateFile)), { code: "ENOENT" });
    steps.push("state-directory-absent-before-start");
  } else {
    await writeFile(stateFile, original);
  }
  const { runProfile } = await import("file:///D:/deepseek-harness/desktop/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot.js");
  const { loadLayeredEnv } = await import("file:///D:/deepseek-harness/desktop/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js");
  booted = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "scheduler-view", patchFiles: [], args: [] });
  steps.push("real-host-loaded");
  await waitRevision(0);
  steps.push("html-exported");
  if (coldStart) {
    assert((await stat(dirname(stateFile))).isDirectory(), "图插件未建立监听目录");
    await assert.rejects(stat(stateFile), { code: "ENOENT" });
    steps.push("cold-start-preview-without-state-file");
  } else {
    assert.equal(await readFile(stateFile, "utf8"), original, "图插件修改了任务状态");
  }
  state.revision = 2;
  state.progress.a.status = "completed";
  const persisted = JSON.stringify(state);
  await writeFile(stateFile, persisted);
  const updated = await waitRevision(2);
  steps.push("snapshot-updated");
  assert.equal(await readFile(stateFile, "utf8"), persisted, "图插件修改了落盘状态");
  steps.push("state-unchanged");
  const twoViews = await Promise.all([readFile(graphFile, "utf8"), readFile(graphFile, "utf8")]);
  if (twoViews[0] !== twoViews[1]) throw new Error("两个读取视图不一致");
  steps.push("two-readers-match");
  await booted.ctx.fiber.dispose(); booted = undefined;
  state.revision = 3; await writeFile(stateFile, JSON.stringify(state)); await delay(200);
  if (await readFile(graphFile, "utf8") !== updated) throw new Error("释放插件后仍在导出");
  steps.push("disposed-no-more-writes");
  const result = { passed: true, ...report };
  await writeFile(reportFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 0;
} catch (error) {
  await writeFile(reportFile, JSON.stringify({ passed: false, ...report, error: String(error?.stack ?? error) }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(startupTimeout);
  await booted?.ctx.fiber.dispose();
}
