import { mkdir, open, readFile, rename, copyFile, unlink, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { State } from "../core/model.js";

export class FileStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private state!: State;
  private lock?: FileHandle;
  private readonly lockToken = randomUUID();
  private static paths = new Set<string>();
  private constructor(readonly path: string, private readonly pathKey: string) {}

  static async open(path: string, seed?: State): Promise<FileStore> {
    const input = resolve(path);
    await mkdir(dirname(input), { recursive: true });
    // Resolve junctions before choosing the shared lock path.
    let absolute: string;
    try { absolute = await realpath(input); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      absolute = resolve(await realpath(dirname(input)), basename(input));
    }
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (this.paths.has(key)) throw new Error("此进程已打开该项目状态");
    this.paths.add(key);
    const store = new FileStore(absolute, key);
    try {
      await store.acquireLock();
      try {
        store.state = JSON.parse(await readFile(absolute, "utf8"));
        if (store.state.version !== 1 || !store.state.project || !store.state.progress || !Array.isArray(store.state.runs)) {
          throw new Error("无法读取状态结构，请检查文件或 .bak");
        }
        if (store.state.runs.some(r => r.phase !== "finished")) {
          await store.change(s => {
            for (const run of s.runs) if (run.phase !== "finished") run.phase = "unknown";
            s.history.push({ at: new Date().toISOString(), action: "restart", detail: "未结束运行等待对账" });
          });
        }
      } catch (error: any) {
        if (error.code !== "ENOENT" || !seed) throw error;
        store.state = structuredClone(seed);
        await store.write(store.state);
      }
      return store;
    } catch (error) {
      try { await store.releaseLock(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "状态初始化失败，写者锁清理失败"); }
      finally { this.paths.delete(key); }
      throw error;
    }
  }
  snapshot(): State { return structuredClone(this.state); }
  change<T>(fn: (draft: State) => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("状态存储已关闭，不能再提交修改"));
    const job = this.tail.then(async () => {
      const draft = this.snapshot(), result = await fn(draft);
      draft.revision++;
      await this.write(draft);
      this.state = draft;
      return result;
    });
    this.tail = job.catch(() => {});
    return job;
  }
  private async acquireLock(): Promise<void> {
    const path = `${this.path}.lock`;
    let file: FileHandle;
    try { file = await open(path, "wx"); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      let pid: string | number = "未知";
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) pid = owner.pid;
      } catch { /* A partially written or stale lock still blocks a second writer. */ }
      throw new Error(`项目状态已由其他进程打开（PID ${pid}）：${this.path}。锁文件：${path}。请先关闭占用进程；异常退出后确认旧进程已结束，再手动移走锁文件。`);
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken, createdAt: new Date().toISOString() }) + "\n", "utf8");
      await file.sync();
      this.lock = file;
    } catch (error) {
      try { await file.close(); }
      finally { await unlink(path); }
      throw error;
    }
  }
  private async releaseLock(): Promise<void> {
    const file = this.lock;
    if (!file) return;
    this.lock = undefined;
    await file.close();
    const path = `${this.path}.lock`;
    let owner: { token?: string };
    try { owner = JSON.parse(await readFile(path, "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    if (owner.token !== this.lockToken) throw new Error(`写者锁已变更，未移除：${path}`);
    await unlink(path);
  }
  private async write(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx");
      try { await file.writeFile(JSON.stringify(state, null, 2), "utf8"); await file.sync(); }
      finally { await file.close(); }
      try { await copyFile(this.path, `${this.path}.bak`); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => {}); }
  }
  close(): Promise<void> {
    return this.closing ??= this.tail.then(async () => {
      await this.releaseLock();
      FileStore.paths.delete(this.pathKey);
    });
  }
}
