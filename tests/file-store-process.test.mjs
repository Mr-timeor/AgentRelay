import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rename, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";

const workerFile = fileURLToPath(new URL("./fixtures/file-store-worker.mjs", import.meta.url));
const seed = () => initial(normalize({ agents: [], tasks: [{ id: "A1" }] }));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-writer-process-"));
  const children = [];
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map(({ exited }) => exited));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, path: join(directory, "state.json"),
    async worker(path, label) {
      const child = fork(workerFile, [path, label], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
      const exited = new Promise(resolve => child.once("exit", resolve));
      const pending = new Map();
      let serial = 0, stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("exit", (code, signal) => {
        for (const { reject } of pending.values()) reject(new Error(`Worker exited: ${code}/${signal}: ${stderr}`));
        pending.clear();
      });
      child.on("message", message => {
        const request = pending.get(message.id);
        if (request) { pending.delete(message.id); request.resolve(message); }
      });
      const ready = new Promise((resolve, reject) => {
        child.on("message", message => { if (message.ready) resolve(); });
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`Worker startup failed: ${code}: ${stderr}`)));
      });
      const result = {
        child, exited,
        request(action, options = {}) {
          const id = ++serial;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.send({ id, action, ...options }, error => {
              if (error) { pending.delete(id); reject(error); }
            });
          });
        }
      };
      children.push(result);
      await ready;
      return result;
    }
  };
}

test("两个独立进程同时写同一状态：一个成功，另一个拒绝且不覆盖", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const workers = await Promise.all([f.worker(f.path, "first"), f.worker(f.path, "second")]);
  const results = await Promise.all(workers.map(worker => worker.request("open", { write: true })));
  assert.equal(results.filter(result => result.ok).length, 1);
  const winner = results.findIndex(result => result.ok), loser = 1 - winner;
  assert.match(results[loser].error, /其他进程打开.*PID/);
  const state = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(state.revision, 1);
  assert.equal(state.progress.A1.summary, winner === 0 ? "first" : "second");
  const lock = JSON.parse(await readFile(`${f.path}.lock`, "utf8"));
  assert.equal(lock.pid, results[winner].pid);
  assert.equal(typeof lock.token, "string");
  assert.ok(Number.isFinite(Date.parse(lock.createdAt)));
  assert.equal((await workers[winner].request("close")).ok, true);
  await assert.rejects(access(`${f.path}.lock`), { code: "ENOENT" });
  assert.equal((await workers[loser].request("open", { write: true })).ok, true);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).revision, 2);
  await workers[loser].request("close");
});

test("写者强制退出：残留锁拒绝自动接管，人工恢复后原状态保留", { timeout: 15000 }, async t => {
  const f = await fixture(t), writer = await f.worker(f.path, "before-crash");
  assert.equal((await writer.request("open", { write: true })).ok, true);
  const before = await readFile(f.path), lock = await readFile(`${f.path}.lock`);
  writer.child.kill("SIGKILL");
  await writer.exited;
  const next = await f.worker(f.path, "after-recovery");
  const rejected = await next.request("open", { write: true });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /异常退出.*手动移走/);
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(await readFile(`${f.path}.lock`), lock);
  // Manual recovery is only performed after the owner has demonstrably exited.
  await rename(`${f.path}.lock`, `${f.path}.lock.crashed`);
  const recovered = await next.request("open");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.revision, 1);
  assert.equal(recovered.state.progress.A1.summary, "before-crash");
  await next.request("write");
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).revision, 2);
  await next.request("close");
});

test("初始化失败释放自己的跨进程锁，坏状态文件不被覆盖", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.path, "broken");
  const writer = await f.worker(f.path, "valid");
  assert.equal((await writer.request("open")).ok, false);
  assert.equal(await readFile(f.path, "utf8"), "broken");
  await assert.rejects(access(`${f.path}.lock`), { code: "ENOENT" });
  await writeFile(f.path, JSON.stringify(seed()));
  assert.equal((await writer.request("open", { write: true })).ok, true);
  await writer.request("close");
});

test("同一状态的junction或目录软链接别名不能绕过写者锁", { timeout: 15000 }, async t => {
  const f = await fixture(t), alias = `${f.directory}-alias`;
  await symlink(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(alias, { force: true }));
  const writer = await f.worker(f.path, "original");
  assert.equal((await writer.request("open", { write: true })).ok, true);
  const other = await f.worker(join(alias, "state.json"), "alias");
  const rejected = await other.request("open", { write: true });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /其他进程打开/);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).revision, 1);
  await writer.request("close");
});

test("异步提交串行且失败不落盘，关闭等待提交后再释放锁", { timeout: 15000 }, async t => {
  const f = await fixture(t), store = await FileStore.open(f.path, seed());
  let release = () => {}, entered;
  t.after(() => { release(); return store.close(); });
  const before = await readFile(f.path);
  await assert.rejects(store.change(async state => {
    state.paused = true;
    await Promise.resolve();
    throw new Error("evidence unavailable");
  }), /evidence unavailable/);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(store.snapshot().revision, 0);
  const holding = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const first = store.change(async state => {
    state.progress.A1.summary = "async";
    entered();
    await holding;
    return "written";
  });
  const second = store.change(state => { state.paused = true; });
  const closing = store.close();
  await started;
  await access(`${f.path}.lock`);
  const other = await f.worker(f.path, "contender");
  assert.equal((await other.request("open")).ok, false);
  await assert.rejects(store.change(() => {}), /已关闭/);
  release();
  assert.equal(await first, "written");
  await Promise.all([second, closing]);
  await assert.rejects(access(`${f.path}.lock`), { code: "ENOENT" });
  const reopened = await other.request("open");
  assert.equal(reopened.ok, true);
  assert.equal(reopened.state.revision, 2);
  assert.equal(reopened.state.progress.A1.summary, "async");
  assert.equal(reopened.state.paused, true);
  await other.request("close");
});
