import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalPackage } from "./package-local.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase();

export async function buildDownloadPackage(outputParent = join(root, ".scheduler/downloads")) {
  if (process.platform !== "win32") throw new Error("ZIP打包命令当前使用Windows PowerShell");
  await mkdir(outputParent, { recursive: true });
  const directory = await mkdtemp(join(outputParent, "download-"));
  const built = await buildLocalPackage(join(directory, "build"));
  const manifest = JSON.parse(await readFile(built.manifest, "utf8"));
  const name = `dynamic-task-scheduler-${manifest.version}`;
  const packageDirectory = join(directory, name);
  await cp(built.directory, packageDirectory, { recursive: true });
  await cp(join(root, "docs/下载安装.md"), join(packageDirectory, "安装说明.md"));
  await mkdir(join(packageDirectory, "examples"));
  await cp(join(root, "fixtures/desktop.patch.yml"), join(packageDirectory, "examples/desktop.patch.yml"));
  await writeFile(join(packageDirectory, "README.md"), `# DSH任务调度插件 ${manifest.version}\n\n` +
    "先阅读安装说明.md。解压后，通过Harness的本地bundle安装通道安装harness/bundle，启用后默认待机。\n\n" +
    "下载者无需npm依赖或编译。配置示例在examples/desktop.patch.yml。重启后发送“加载调度器”，告知任务，由Lead生成任务集、HTML和专项分工；全部专项成员就绪后自动开工。\n\n" +
    "按需模式由主插件维护HTML。harness/view-bundle用于onDemand:false的独立固定项目预览。示例任务在fixtures/development.json。\n\n" +
    "独立CLI需要Node.js 22+，可在本目录运行：\n\n```powershell\nnode core/dist/cli.js check fixtures/development.json\n" +
    "node core/dist/cli.js graph fixtures/development.json flow.html\n```\n\n" +
    "采用MIT许可证，条款见LICENSE。宿主依赖由Harness提供。宿主安装验收结果以对应发布说明为准。\n");
  manifest.kind = "download-candidate";
  manifest.files = [...manifest.files, "安装说明.md", "examples/desktop.patch.yml"].sort();
  const manifestPath = join(packageDirectory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const archive = join(directory, name + ".zip");
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    "[System.IO.Compression.ZipFile]::CreateFromDirectory($env:SCHEDULER_ARCHIVE_SOURCE, $env:SCHEDULER_ARCHIVE_TARGET, [System.IO.Compression.CompressionLevel]::Optimal, $true)"], {
    windowsHide: true,
    env: { ...process.env, SCHEDULER_ARCHIVE_SOURCE: packageDirectory, SCHEDULER_ARCHIVE_TARGET: archive }
  });
  const sha256 = await digest(archive);
  const checksumFile = archive + ".sha256";
  await writeFile(checksumFile, `${sha256}  ${name}.zip\n`);
  const fileHashes = Object.fromEntries(await Promise.all([...manifest.files, "manifest.json"].map(async file =>
    [file, await digest(join(packageDirectory, file))])));
  const result = { directory, archive, checksumFile, packageDirectory, manifest: manifestPath,
    files: manifest.files.length, sha256, receipt: join(directory, "receipt.json") };
  await writeFile(result.receipt, JSON.stringify({ ...result, version: manifest.version,
    createdAt: manifest.createdAt, fileHashes, hostValidation: "pending" }, null, 2) + "\n");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDownloadPackage().then(async result => {
    await writeFile(join(root, ".scheduler/downloads/latest.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
