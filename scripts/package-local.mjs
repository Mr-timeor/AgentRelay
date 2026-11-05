// 在独立目录编译和组装，不更新已通过junction安装的harness目录。
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterSource } from "./adapter-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function compile(target) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
      "--project", join(root, "tsconfig.json"), "--outDir", target, "--sourceMap", "false"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? accept() : reject(new Error(`编译失败 (${code})：${output}`)));
  });
}

async function listFiles(folder, prefix = "") {
  const files = [];
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(folder, entry.name), name + "/"));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`分发目录不支持链接：${name}`);
  }
  return files;
}

export async function buildLocalPackage(outputParent = join(root, ".scheduler/releases")) {
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await mkdir(outputParent, { recursive: true });
  const target = await mkdtemp(join(outputParent, `scheduler-${metadata.version}-`));
  const core = join(target, "core");
  await mkdir(core);
  await compile(join(core, "dist"));
  await writeFile(join(core, "package.json"), JSON.stringify({
    name: metadata.name, version: metadata.version, private: true, type: "module",
    license: metadata.license,
    engines: metadata.engines, bin: { "task-scheduler": "./dist/cli.js" }
  }, null, 2) + "\n");

  const bundle = join(target, "harness/bundle"), view = join(target, "harness/view-bundle");
  await mkdir(bundle, { recursive: true });
  await mkdir(view, { recursive: true });
  for (const folder of [target, core, bundle, view]) await cp(join(root, "LICENSE"), join(folder, "LICENSE"));
  for (const file of ["package.json", "cordis.patch.yml"]) {
    await cp(join(root, "harness/bundle", file), join(bundle, file));
  }
  await cp(join(root, "harness/index.mjs"), join(bundle, "index.mjs"));
  await writeFile(join(bundle, "adapter.mjs"), await adapterSource(root));
  for (const file of ["package.json", "index.mjs", "cordis.patch.yml"]) {
    await cp(join(root, "harness/view-bundle", file), join(view, file));
  }
  await cp(join(core, "dist"), join(bundle, "dist"), { recursive: true });
  for (const folder of ["core", "ui"]) {
    await cp(join(core, "dist", folder), join(view, "dist", folder), { recursive: true });
  }
  await mkdir(join(target, "fixtures/benchmarks"), { recursive: true });
  await cp(join(root, "fixtures/development.json"), join(target, "fixtures/development.json"));
  await cp(join(root, "fixtures/wakeup.json"), join(target, "fixtures/wakeup.json"));
  for (const file of (await readdir(join(root, "fixtures/benchmarks"))).filter(file => file.endsWith(".json"))) {
    await cp(join(root, "fixtures/benchmarks", file), join(target, "fixtures/benchmarks", file));
  }
  await mkdir(join(target, "docs"));
  for (const file of ["快速开始.md", "下载安装.md", "设计方案.md", "调度算法.md", "接口与数据契约.md", "离线评测.md"]) {
    await cp(join(root, "docs", file), join(target, "docs", file));
  }
  await writeFile(join(target, "README.md"), `# Scheduler 本地验证包 ${metadata.version}\n\n` +
    "需要Node.js 22或更新版本。核心无需安装npm依赖；两个DSH插件由宿主提供peer依赖。\n\n" +
    "在本目录执行：\n\n```powershell\nnode core/dist/cli.js check fixtures/development.json\nnode core/dist/cli.js plan fixtures/development.json\n" +
    "node core/dist/cli.js graph fixtures/development.json flow.html\n" +
    "node core/dist/benchmark/run.js fixtures/benchmarks\n```\n\n" +
    "插件分别位于harness/bundle和harness/view-bundle，默认禁用。通过宿主的本地bundle安装入口安装对应目录，随后配置agent-team和项目路径；步骤见docs/快速开始.md。此分发目录的根目录供离线CLI使用。\n\n" +
    "用量只记录，不设预算卡点；没有就绪任务则结束回合，未知投递不自动重发，失败不自动重试。\n\n" +
    `这是本地验证目录，未做正式版本发布；采用${metadata.license}许可证，完整条款见LICENSE。未包含宿主、node_modules、真实会话、运行状态或凭据。\n`);
  const manifest = {
    name: metadata.name, version: metadata.version, createdAt: new Date().toISOString(),
    kind: "local-validation", license: metadata.license, licenseStatus: "declared", node: metadata.engines.node,
    hostBaseline: "0.2.1-rc.2", files: await listFiles(target)
  };
  // manifest最后写入；缺少它表示组装尚未完成。
  await writeFile(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { directory: target, manifest: join(target, "manifest.json"), files: manifest.files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLocalPackage().then(async result => {
    await writeFile(join(root, ".scheduler/releases/latest.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
