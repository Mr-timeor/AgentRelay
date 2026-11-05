import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-store-lifecycle-"));
  const path = join(dir, "state.json");
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = await FileStore.open(path, initial(normalize({ agents: [], tasks: [{ id: "A1" }] })));
  stores.push(store);
  return { path, store, stores };
}

test("关闭后旧存储不能继续写入，新写者的状态保持", async t => {
  const { path, store, stores } = await fixture(t);
  await store.close();
  const current = await FileStore.open(path);
  stores.push(current);
  await current.change(s => { s.progress.A1.summary = "当前写者"; });
  const before = await readFile(path, "utf8");
  let called = false;
  await assert.rejects(store.change(s => { called = true; s.paused = true; }), /已关闭/);
  assert.equal(called, false);
  assert.equal(await readFile(path, "utf8"), before);
});

test("关闭等待已排队提交完成，但立即拒绝新的提交", async t => {
  const { path, store } = await fixture(t);
  const first = store.change(s => { s.progress.A1.summary = "已排队"; });
  const second = store.change(s => { s.paused = true; });
  const closing = store.close();
  await assert.rejects(store.change(s => { s.paused = false; }), /已关闭/);
  await Promise.all([first, second, closing]);
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(state.revision, 2);
  assert.equal(state.progress.A1.summary, "已排队");
  assert.equal(state.paused, true);
});

test("旧存储重复关闭不会解除新写者的路径占用", async t => {
  const { path, store, stores } = await fixture(t);
  await store.close();
  const current = await FileStore.open(path);
  stores.push(current);
  await store.close();
  await assert.rejects(FileStore.open(path), /已打开/);
  await current.change(s => { s.paused = true; });
  assert.equal(JSON.parse(await readFile(path, "utf8")).paused, true);
});
