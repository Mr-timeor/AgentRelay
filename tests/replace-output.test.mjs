import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { replaceOutput } from "../dist/ui/replace-output.js";
import { startViewExport } from "../dist/ui/export-view.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-html-replace-"));
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, source: join(dir, "flow.html.tmp"), target: join(dir, "flow.html"), stateFile: join(dir, "state.json"),
    cleanup: close => closers.push(close) };
}
const failure = code => Object.assign(new Error(`simulated ${code}`), { code });

test("HTML替换遇到一次EPERM后同次调用完成，不需要另一个状态事件", async t => {
  const { source, target } = await fixture(t), waits = [];
  await writeFile(source, "revision 9"); await writeFile(target, "revision 8");
  let attempts = 0;
  await replaceOutput(source, target, {
    rename: async (...args) => { if (++attempts === 1) throw failure("EPERM"); await rename(...args); },
    sleep: async ms => { waits.push(ms); }
  });
  assert.equal(attempts, 2); assert.deepEqual(waits, [20]);
  assert.equal(await readFile(target, "utf8"), "revision 9");
  await assert.rejects(readFile(source), { code: "ENOENT" });
});

test("持续占用最多六次尝试并保留旧HTML，其他错误立即返回", async t => {
  const { source, target } = await fixture(t), waits = [], error = failure("EACCES");
  await writeFile(source, "revision 9"); await writeFile(target, "revision 8");
  let attempts = 0;
  await assert.rejects(replaceOutput(source, target, {
    rename: async () => { attempts++; throw error; }, sleep: async ms => { waits.push(ms); }
  }), value => value === error);
  assert.equal(attempts, 6); assert.deepEqual(waits, [20, 40, 80, 160, 320]);
  assert.equal(await readFile(target, "utf8"), "revision 8");
  attempts = 0;
  await assert.rejects(replaceOutput(source, target, {
    rename: async () => { attempts++; throw failure("ENOENT"); },
    sleep: async () => { assert.fail("非暂态错误不应等待重试"); }
  }), { code: "ENOENT" });
  assert.equal(attempts, 1);
});

test("最后一次状态更新的刷新可自行恢复短暂占用并导出最新revision", async t => {
  const { stateFile, target, cleanup } = await fixture(t);
  const state = initial(normalize({ agents: [], tasks: [{ id: "a" }] })); state.revision = 8;
  await writeFile(stateFile, JSON.stringify(state));
  let failOnce = false, attempts = 0;
  const exporter = await startViewExport({ stateFile, graphFile: target }, (source, destination) =>
    replaceOutput(source, destination, {
      rename: async (...args) => {
        attempts++;
        if (failOnce) { failOnce = false; throw failure("EBUSY"); }
        await rename(...args);
      }, sleep: async () => {}
    }));
  cleanup(() => exporter.close());
  state.revision = 9; const bytes = JSON.stringify(state); await writeFile(stateFile, bytes);
  failOnce = true; const before = attempts;
  assert.equal((await exporter.refresh()).revision, 9);
  await exporter.close();
  assert.equal(attempts - before, 2);
  assert.match(await readFile(target, "utf8"), /revision 9/);
  assert.equal(await readFile(stateFile, "utf8"), bytes);
});

test("监听刷新持续写出失败会报告错误、保留旧图，不修改权威状态", async t => {
  const { dir, stateFile, target, cleanup } = await fixture(t);
  const state = initial(normalize({ agents: [], tasks: [{ id: "a" }] })); state.revision = 8;
  await writeFile(stateFile, JSON.stringify(state));
  const error = failure("EPERM"); let blocked = false, attempts = 0, observed;
  const onError = new Promise(resolve => { observed = resolve; });
  const exporter = await startViewExport({ stateFile, graphFile: target, onError: observed },
    (source, destination) => replaceOutput(source, destination, {
      rename: async (...args) => { if (blocked) { attempts++; throw error; } await rename(...args); }, sleep: async () => {}
    }));
  cleanup(() => exporter.close());
  const previous = await readFile(target, "utf8");
  blocked = true; state.revision = 9; const bytes = JSON.stringify(state);
  await writeFile(stateFile, bytes);
  let timer;
  try {
    assert.equal(await Promise.race([onError, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("未报告监听刷新失败")), 3000);
    })]), error);
  } finally { clearTimeout(timer); }
  await exporter.close();
  assert.equal(attempts, 6);
  assert.equal(await readFile(target, "utf8"), previous);
  assert.equal(await readFile(stateFile, "utf8"), bytes);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith(".tmp")), "失败临时文件应清理");
});

test("关闭等待在途替换完成，已关闭后不再写图或排队重试", async t => {
  const { stateFile, target, cleanup } = await fixture(t);
  const state = initial(normalize({ agents: [], tasks: [{ id: "a" }] }));
  await writeFile(stateFile, JSON.stringify(state));
  let pause = false, release, entered, replacements = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const exporter = await startViewExport({ stateFile, graphFile: target }, async (source, destination) => {
    replacements++;
    if (pause) { entered(); await gate; }
    await rename(source, destination);
  });
  cleanup(async () => { release(); await exporter.close(); });
  pause = true;
  const updating = exporter.refresh(); await reached;
  const closing = exporter.close(); let closed = false;
  closing.then(() => { closed = true; }); await Promise.resolve();
  assert.equal(closed, false);
  release(); await Promise.all([updating, closing]);
  const previous = await readFile(target, "utf8"), count = replacements;
  state.revision = 9; await writeFile(stateFile, JSON.stringify(state));
  await exporter.refresh();
  assert.equal(replacements, count); assert.equal(await readFile(target, "utf8"), previous);
});
