import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { compileCore, defaultBuildRoot, repositoryRoot } from "./bundle-build.mjs";

if (process.platform !== "win32") throw new Error("此宿主测试入口使用Windows PowerShell");
const mode = process.argv[2];
if (!["basic", "loop", "view"].includes(mode)) throw new Error("宿主测试类型应为basic、loop或view");
const env = { ...process.env,
  SCHEDULER_BUNDLE_DIR: process.env.SCHEDULER_BUNDLE_DIR || join(defaultBuildRoot, "harness/bundle"),
  SCHEDULER_VIEW_BUNDLE_DIR: process.env.SCHEDULER_VIEW_BUNDLE_DIR || join(defaultBuildRoot, "harness/view-bundle")
};
await access(join(mode === "view" ? env.SCHEDULER_VIEW_BUNDLE_DIR : env.SCHEDULER_BUNDLE_DIR, "index.mjs"));
// 旧探针的辅助导入仍指向仓库dist；实际宿主插件继续使用上面选定的bundle。
await compileCore(join(repositoryRoot, "dist"));
async function run(command, args) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? accept() : reject(new Error(`宿主测试失败：exit ${code}`)));
  });
}
if (mode !== "view") await run(process.execPath, ["tests/host/setup-isolated.mjs", "--legacy"]);
await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
  mode === "view" ? "tests/view-host.ps1" : "tests/host/run-isolated.ps1",
  ...(mode === "view" ? ["-Legacy"] : mode === "loop" ? ["-Loop"] : [])]);
