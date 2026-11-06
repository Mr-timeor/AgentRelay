import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterSource } from "./adapter-source.mjs";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultBuildRoot = join(repositoryRoot, ".scheduler/build");

export async function compileCore(target, root = repositoryRoot) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
      "--project", join(root, "tsconfig.json"), "--outDir", target, "--sourceMap", "false"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? accept() : reject(new Error(`编译失败 (${code})：${output}`)));
  });
}

function overlaps(first, second) {
  const inside = relative(first, second);
  return inside === "" || (inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside));
}

// 所有安装包入口共用此处；harness/bundle中的已安装副本不是构建输入。
export async function assembleBundle({ kind, compiledDirectory, target, root = repositoryRoot }) {
  if (!["bundle", "view-bundle"].includes(kind)) throw new Error(`未知插件类型：${kind}`);
  const source = resolve(compiledDirectory), destination = resolve(target);
  if (overlaps(source, destination) || overlaps(destination, source)) throw new Error("bundle输出不能覆盖或包含编译输入");
  const template = join(root, "harness/templates", kind);
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(template, "package.json"), "utf8"));
  await mkdir(destination, { recursive: true });
  await rm(join(destination, "dist"), { recursive: true, force: true });
  await writeFile(join(destination, "package.json"), JSON.stringify({ ...manifest, version: metadata.version }, null, 2) + "\n");
  await cp(join(template, "cordis.patch.yml"), join(destination, "cordis.patch.yml"));
  await cp(join(root, "LICENSE"), join(destination, "LICENSE"));
  await cp(join(root, "harness", kind === "bundle" ? "index.mjs" : "view-index.mjs"), join(destination, "index.mjs"));
  if (kind === "bundle") {
    await writeFile(join(destination, "adapter.mjs"), await adapterSource(root));
    await cp(source, join(destination, "dist"), { recursive: true });
  } else {
    for (const folder of ["core", "ui"]) await cp(join(source, folder), join(destination, "dist", folder), { recursive: true });
  }
  return destination;
}

export async function runBundleBuild(kind, args = process.argv.slice(2)) {
  let target = join(defaultBuildRoot, "harness", kind);
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--output") throw new Error("用法：--output <输出目录>（省略时使用.scheduler/build/harness）");
    target = resolve(args[1]);
  }
  await mkdir(defaultBuildRoot, { recursive: true });
  const staging = await mkdtemp(join(defaultBuildRoot, ".compile-"));
  try {
    await compileCore(join(staging, "dist"));
    await assembleBundle({ kind, compiledDirectory: join(staging, "dist"), target });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ kind, directory: target }, null, 2));
}
