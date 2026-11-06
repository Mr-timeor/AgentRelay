import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterSource } from "./adapter-source.mjs";
import { defaultBuildRoot, repositoryRoot } from "./bundle-build.mjs";

async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), name + "/"));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`构建产物中出现链接：${name}`);
  }
  return result.sort();
}

async function sameFile(first, second) {
  assert.deepEqual(await readFile(first), await readFile(second), `构建内容不一致：${first} / ${second}`);
}

// 同时核对源码映射和两个构建入口，不把仓库旧安装副本当作预期产物。
export async function verifyBuild({ packageDirectory, buildRoot = defaultBuildRoot, root = repositoryRoot }) {
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  let runtimeFiles = 0;
  for (const kind of ["bundle", "view-bundle"]) {
    const bundled = join(packageDirectory, "harness", kind), built = join(buildRoot, "harness", kind);
    const template = join(root, "harness/templates", kind);
    const expectedMetadata = { ...JSON.parse(await readFile(join(template, "package.json"), "utf8")), version: metadata.version };
    assert.deepEqual(JSON.parse(await readFile(join(bundled, "package.json"), "utf8")), expectedMetadata);
    await sameFile(join(bundled, "index.mjs"), join(root, "harness", kind === "bundle" ? "index.mjs" : "view-index.mjs"));
    await sameFile(join(bundled, "cordis.patch.yml"), join(template, "cordis.patch.yml"));
    await sameFile(join(bundled, "LICENSE"), join(root, "LICENSE"));
    if (kind === "bundle") assert.equal(await readFile(join(bundled, "adapter.mjs"), "utf8"), await adapterSource(root));
    const core = join(packageDirectory, "core/dist");
    const expected = kind === "bundle" ? await files(core) : (await files(core)).filter(file => /^(core|ui)\//.test(file));
    assert.deepEqual(await files(join(bundled, "dist")), expected, `${kind}的核心文件清单不匹配`);
    for (const file of expected) await sameFile(join(bundled, "dist", file), join(core, file));
    const packagedFiles = await files(bundled);
    assert.deepEqual(await files(built), packagedFiles, `${kind}的开发构建与打包清单不匹配`);
    for (const file of packagedFiles) await sameFile(join(built, file), join(bundled, file));
    runtimeFiles += packagedFiles.length;
  }
  return { packages: 2, runtimeFiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const latest = JSON.parse(await readFile(join(repositoryRoot, ".scheduler/releases/latest.json"), "utf8"));
  console.log(JSON.stringify(await verifyBuild({ packageDirectory: latest.directory }), null, 2));
}
