import { mkdir, open, readFile, rename, copyFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { State } from "../core/model.js";

export class FileStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private state!: State;
  private static paths = new Set<string>();
  private constructor(readonly path: string) {}

  static async open(path: string, seed?: State): Promise<FileStore> {
    const absolute = resolve(path), key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (this.paths.has(key)) throw new Error("此进程已打开该项目状态");
    this.paths.add(key);
    const store = new FileStore(absolute);
    try {
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
    } catch (error) { this.paths.delete(key); throw error; }
  }
  snapshot(): State { return structuredClone(this.state); }
  change<T>(fn: (draft: State) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error("状态存储已关闭，不能再提交修改"));
    const job = this.tail.then(async () => {
      const draft = this.snapshot(), result = fn(draft);
      draft.revision++;
      await this.write(draft);
      this.state = draft;
      return result;
    });
    this.tail = job.catch(() => {});
    return job;
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
    return this.closing ??= this.tail.then(() => {
      FileStore.paths.delete(process.platform === "win32" ? this.path.toLowerCase() : this.path);
    });
  }
}
