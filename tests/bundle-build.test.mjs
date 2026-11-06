import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assembleBundle, runBundleBuild } from "../scripts/bundle-build.mjs";
import { verifyBuild } from "../scripts/check-build.mjs";

test("共享组装：从源码和模板构建，清除旧dist，忽略旧安装副本", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-bundle-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo"), compiledDirectory = join(directory, "package/core/dist");
  const packageDirectory = join(directory, "package"), buildRoot = join(directory, "development");
  const save = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  await save(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await save(join(root, "LICENSE"), "license\n");
  await save(join(root, "harness/index.mjs"), "export const source = 'scheduler';\n");
  await save(join(root, "harness/view-index.mjs"), "export const source = 'view';\n");
  await save(join(root, "harness/adapter.mjs"), 'import { core } from "../dist/core/index.js";\n');
  const installed = {};
  for (const kind of ["bundle", "view-bundle"]) {
    await save(join(root, "harness/templates", kind, "package.json"), JSON.stringify({ name: kind, main: "index.mjs" }));
    await save(join(root, "harness/templates", kind, "cordis.patch.yml"), `# ${kind}\n`);
    const old = join(root, "harness", kind, "index.mjs");
    await save(old, "old installed contents\n");
    installed[kind] = await readFile(old);
  }
  for (const [file, text] of Object.entries({ "core/index.js": "export const core = 1;\n", "ui/graph.js": "export const graph = 2;\n", "cli.js": "console.log('cli');\n" })) {
    await save(join(compiledDirectory, file), text);
  }
  for (const kind of ["bundle", "view-bundle"]) {
    await assembleBundle({ kind, compiledDirectory, target: join(packageDirectory, "harness", kind), root });
    await assembleBundle({ kind, compiledDirectory, target: join(buildRoot, "harness", kind), root });
    assert.deepEqual(await readFile(join(root, "harness", kind, "index.mjs")), installed[kind]);
  }
  assert.equal((await verifyBuild({ packageDirectory, buildRoot, root })).packages, 2);
  const view = join(buildRoot, "harness/view-bundle");
  await save(join(view, "dist/ui/obsolete.js"), "old file\n");
  await assert.rejects(verifyBuild({ packageDirectory, buildRoot, root }), /清单不匹配/);
  await assembleBundle({ kind: "view-bundle", compiledDirectory, target: view, root });
  await verifyBuild({ packageDirectory, buildRoot, root });
  await writeFile(join(packageDirectory, "harness/bundle/adapter.mjs"), "stale adapter\n");
  await assert.rejects(verifyBuild({ packageDirectory, buildRoot, root }), assert.AssertionError);
});

test("构建显式路径：拒绝覆盖编译输入和不明确的参数", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-bundle-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(assembleBundle({ kind: "bundle", compiledDirectory: directory, target: directory }), /覆盖或包含/);
  await assert.rejects(assembleBundle({ kind: "view-bundle", compiledDirectory: join(directory, "dist"), target: directory }), /覆盖或包含/);
  await assert.rejects(runBundleBuild("bundle", ["unexpected-directory"]), /用法/);
});
