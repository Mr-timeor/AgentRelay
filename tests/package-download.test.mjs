import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildDownloadPackage } from "../scripts/package-download.mjs";

const exec = promisify(execFile);

async function files(folder, prefix = "") {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(join(folder, entry.name), name + "/"));
    else result.push(name);
  }
  return result;
}

test("下载ZIP：解压迁移后两个bundle完整，CLI无需源码，中文说明和校验文件可用", { skip: process.platform !== "win32" }, async t => {
  const work = await mkdtemp(join(tmpdir(), "scheduler-download-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const built = await buildDownloadPackage(join(work, "build"));
  const expected = JSON.parse(await readFile(built.receipt, "utf8"));
  const hash = createHash("sha256").update(await readFile(built.archive)).digest("hex").toUpperCase();
  assert.equal(hash, built.sha256);
  assert.equal(await readFile(built.checksumFile, "utf8"), `${hash}  dynamic-task-scheduler-${expected.version}.zip\n`);
  const extracted = join(work, "迁移后的 解压目录");
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:SCHEDULER_ARCHIVE_SOURCE, $env:SCHEDULER_ARCHIVE_TARGET)"], {
    windowsHide: true,
    env: { ...process.env, SCHEDULER_ARCHIVE_SOURCE: built.archive, SCHEDULER_ARCHIVE_TARGET: extracted }
  });
  const name = `dynamic-task-scheduler-${expected.version}`;
  assert.deepEqual(await readdir(extracted), [name]);
  const folder = join(extracted, name);
  await rm(built.packageDirectory, { recursive: true });
  await rm(join(built.directory, "build"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.kind, "download-candidate");
  assert.equal(manifest.files.length, built.files);
  assert.deepEqual((await files(folder)).sort(), Object.keys(expected.fileHashes).sort());
  for (const [file, sha256] of Object.entries(expected.fileHashes)) {
    assert.equal(createHash("sha256").update(await readFile(join(folder, file))).digest("hex").toUpperCase(), sha256, file);
  }
  assert.deepEqual(Object.keys(expected.fileHashes).sort(), [...manifest.files, "manifest.json"].sort());
  assert.ok(!manifest.files.some(file => /node_modules|\.scheduler|\.pi\/|trials\/|接入结果|项目记录/.test(file)));
  assert.match(await readFile(join(folder, "安装说明.md"), "utf8"), /无需 npm 或重新构建/);
  assert.match(await readFile(join(folder, "examples/desktop.patch.yml"), "utf8"), /onDemand: true/);
  for (const file of manifest.files.filter(file => file.endsWith(".md"))) {
    const text = await readFile(join(folder, file), "utf8");
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].replace(/^<|>$/g, "").split("#")[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      await assert.doesNotReject(access(resolve(folder, dirname(file), decodeURIComponent(link))), `${file}: ${link}`);
    }
  }
  for (const name of ["bundle", "view-bundle"]) {
    const plugin = join(folder, "harness", name);
    const pkg = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
    assert.equal(pkg.version, expected.version);
    assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
    assert.ok((await readFile(join(plugin, pkg.main))).length > 0);
    assert.match(await readFile(join(plugin, pkg.dsh.bundle.patch), "utf8"), /disabled: true/);
    assert.match(await readFile(join(plugin, "LICENSE"), "utf8"), /MIT License/);
  }
  const { install } = await import(pathToFileURL(join(folder, "harness/bundle/adapter.mjs")));
  assert.equal(typeof install, "function");
  const { startViewExport } = await import(pathToFileURL(join(folder, "harness/view-bundle/dist/ui/export-view.js")));
  assert.equal(typeof startViewExport, "function");
  const cli = (...args) => exec(process.execPath, [join(folder, "core/dist/cli.js"), ...args], { cwd: folder });
  assert.match((await cli("check", "fixtures/development.json")).stdout, /任务定义有效/);
  assert.deepEqual(JSON.parse((await cli("plan", "fixtures/development.json")).stdout).ready, ["A1"]);
  await cli("graph", "fixtures/development.json", "flow.html");
  assert.match(await readFile(join(folder, "flow.html"), "utf8"), /A1/);
});
