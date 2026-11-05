import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initial, normalize } from "../dist/core/model.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const project = { agents: [{ id: "dev" }], tasks: [{ id: "A1" }] };
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

async function fixture(t, body = project) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-output-safety-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.json"), original = JSON.stringify(body, null, 2);
  await writeFile(input, original);
  return { dir, input, original };
}

for (const command of ["graph", "demo", "export"]) {
  test(`CLI ${command} 拒绝覆盖输入，原文件字节保持`, async t => {
    const { input, original } = await fixture(t, command === "export" ? initial(normalize(project)) : project);
    const result = run(command, input, input);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不能覆盖/);
    assert.equal(await readFile(input, "utf8"), original);
  });
}

test("CLI 导出保护识别相对路径和 Windows 大小写别名", async t => {
  const { input, dir, original } = await fixture(t);
  const aliases = ["input.json", `.${sep}input.json`];
  if (process.platform === "win32") aliases.push(input.toUpperCase());
  for (const output of aliases) {
    const result = spawnSync(process.execPath, [cli, "graph", input, output], { encoding: "utf8", cwd: dir });
    assert.equal(result.status, 1, output);
    assert.match(result.stderr, /不能覆盖/);
  }
  assert.equal(await readFile(input, "utf8"), original);
});

test("CLI 仍能正常导出不同路径，且不修改输入", async t => {
  const { input, dir, original } = await fixture(t, initial(normalize(project)));
  const output = join(dir, "views", "flow.html");
  const result = run("export", input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(output, "utf8"), /^<!doctype html>/);
  assert.equal(await readFile(input, "utf8"), original);
});
