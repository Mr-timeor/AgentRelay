// 按需启动探针独用的隔离home和工作区，与旧分发接入目录分离。
import { access, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceBundle = process.env.SCHEDULER_STARTUP_BUNDLE_DIR;
if (!sourceBundle) throw new Error("先设置SCHEDULER_STARTUP_BUNDLE_DIR为本轮固定bundle目录");
const source = resolve(sourceBundle);
for (const file of ["package.json", "index.mjs", "adapter.mjs", "dist/dispatcher/scheduler.js"]) {
  await access(join(source, file));
}
const parent = join(root, ".harness-startup");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const home = join(directory, "home"), profile = "scheduler-startup";
const profileDirectory = join(home, "profiles", profile);
const installedBundle = join(profileDirectory, "node_modules/dynamic-task-scheduler");
const workspace = join(directory, "workspace 启动测试");
await mkdir(workspace);
await mkdir(dirname(installedBundle), { recursive: true });
await cp(source, installedBundle, { recursive: true });
await writeFile(join(profileDirectory, "package.json"), JSON.stringify({
  name: "dsh-profile-scheduler-startup", private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dynamic-task-scheduler"] } }
}, null, 2) + "\n");
await writeFile(join(profileDirectory, "cordis.yml"), "[]\n");
const patchFile = join(profileDirectory, "cordis.patch.yml");
const probe = pathToFileURL(join(root, "tests/host/probe-startup.mjs")).href;
await writeFile(patchFile, `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      mock:
        displayName: Startup Mock
        api: openai-completions
        baseURL: '__STARTUP_MOCK_BASE_URL__'
        apiKeyEnv: SCHEDULER_STARTUP_MOCK_KEY
        models:
          - id: mock-model
            name: Startup Mock
            contextWindow: 128000
            maxTokens: 4096
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mock
    model: mock-model
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 8
        maxTasks: 256
        maxMessageBytes: 65536
        disposalTimeoutMs: 5000
    - id: scheduler-startup-probe
      name: '${probe}'
- id: dynamic-task-scheduler
  disabled: false
  config:
    onDemand: true
    leadSessionId: auto
`, "utf8");
const prepared = {
  directory, home, profile, profileDirectory, patchFile, workspace,
  sourceBundle: source, installedBundle,
  projectFile: join(workspace, ".scheduler/tasks.json"),
  stateFile: join(workspace, ".scheduler/state.json"),
  graphFile: join(workspace, ".scheduler/flow.html"),
  logFile: join(directory, "mock-startup.jsonl"),
  installationMode: "isolated-profile-copy", realModelCalls: 0
};
await writeFile(join(directory, "prepared.json"), JSON.stringify(prepared, null, 2) + "\n");
await writeFile(join(parent, "prepared.json"), JSON.stringify(prepared, null, 2) + "\n");
console.log(JSON.stringify(prepared, null, 2));
