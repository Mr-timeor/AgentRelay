import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.AGENTRELAY_ENTRY_BUNDLE;

// Exercise the shipped entry wiring as well as the adapter; only the two host
// SDKs are stubs. FileStore and its lock are the real compiled implementation.
async function entryHost(t) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-entry-disposal-"));
  const compiledDirectory = join(directory, bundle ? "harness/dist" : "dist");
  await mkdir(join(directory, "harness"));
  await Promise.all([
    cp(join(bundle ?? join(root, "harness"), "index.mjs"), join(directory, "harness/index.mjs")),
    cp(join(bundle ?? join(root, "harness"), "adapter.mjs"), join(directory, "harness/adapter.mjs")),
    cp(bundle ? join(bundle, "dist") : join(root, "dist"), compiledDirectory, { recursive: true })
  ]);
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  for (const [name, content] of [
    ["schemastery", 'const schema = { default() { return this; } }; export default { object: () => schema, boolean: () => schema, string: () => schema, number: () => schema };'],
    ["dsh-tools", 'export const defineTool = definition => definition;']
  ]) {
    const folder = join(directory, "node_modules/@deepseek-ai", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "package.json"), '{"type":"module","exports":"./index.mjs"}\n');
    await writeFile(join(folder, "index.mjs"), content);
  }
  const [{ apply }, { FileStore }] = await Promise.all([
    import(pathToFileURL(join(directory, "harness/index.mjs"))),
    import(pathToFileURL(join(compiledDirectory, "store/file-store.js")))
  ]);
  const tools = new Map(), disposers = [];
  const lead = { id: "entry-lead", session: { header: { cwd: directory } }, ctx: {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } }
  } };
  const ctx = {
    agents: { list: () => [lead] },
    agentTeams: { tryMembership: agent => agent === lead ? { root: lead, name: "lead", role: "lead" } : undefined },
    on: () => () => {},
    effect: factory => { disposers.push(factory()); }
  };
  const projectFile = join(directory, "project.json"), stateFile = join(directory, "state.json");
  await writeFile(projectFile, JSON.stringify({ agents: [{ id: "dev" }], tasks: [{ id: "A" }] }));
  const originalOpen = FileStore.open, originalClose = FileStore.prototype.close, stores = new Set();
  FileStore.open = async (...args) => {
    const store = await originalOpen.apply(FileStore, args); stores.add(store); return store;
  };
  let release = () => {};
  t.after(async () => {
    release();
    FileStore.prototype.close = originalClose;
    await Promise.allSettled(disposers.map(dispose => dispose()));
    await Promise.all([...stores].map(store => originalClose.call(store)));
    FileStore.open = originalOpen;
    await rm(directory, { recursive: true, force: true });
  });
  apply(ctx, { onDemand: false, leadSessionId: lead.id, projectFile, stateFile });
  await tools.get("scheduler_status").execute({}, { agent: lead, signal: new AbortController().signal });
  assert.equal(stores.size, 1);
  assert.equal(disposers.length, 1);
  return { FileStore, stateFile, tools, cleanup: disposers[0], originalClose,
    setRelease: value => { release = value; } };
}

test("真实插件入口的宿主清理等待FileStore关闭，完成后状态可重开且锁释放", async t => {
  const h = await entryHost(t);
  let release, reachedClose;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reachedClose = resolve; });
  h.setRelease(release);
  h.FileStore.prototype.close = async function () {
    reachedClose();
    await gate;
    return h.originalClose.call(this);
  };
  const pending = h.cleanup();
  await entered;
  assert.equal(typeof pending?.then, "function", "effect清理必须向宿主返回异步完成结果");
  let completed = false;
  pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  await access(h.stateFile + ".lock");
  await assert.rejects(h.FileStore.open(h.stateFile), /已打开/);
  release();
  await pending;
  assert.equal(h.tools.size, 0);
  await assert.rejects(access(h.stateFile + ".lock"));
  const reopened = await h.FileStore.open(h.stateFile);
  await reopened.close();
});

test("真实插件入口不吞掉存储关闭失败，宿主可记录清理错误", async t => {
  const h = await entryHost(t), failure = new Error("entry-close-failed");
  h.FileStore.prototype.close = async () => { throw failure; };
  const pending = h.cleanup();
  assert.equal(typeof pending?.then, "function");
  await assert.rejects(pending, error => error === failure);
  await access(h.stateFile + ".lock");
});
