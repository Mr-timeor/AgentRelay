import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { plan, conflicts, diagnose } from "../dist/core/planner.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";
import { renderGraph } from "../dist/ui/graph.js";

const project = tasks => normalize({ name: "测试", agents: [{ id: "dev", categories: ["dev"] }, { id: "qa", categories: ["qa"] }], tasks });
const t = (id, extra = {}) => ({ id, category: "dev", ...extra });
async function setup(ctx, tasks, timeout = 120000) {
  const dir = await mkdtemp(join(tmpdir(), "scheduler-")), path = join(dir, "state.json");
  let store = await FileStore.open(path, initial(project(tasks)));
  ctx.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, path, scheduler: new Scheduler(store, timeout), reopen: async () => {
    await store.close(); store = await FileStore.open(path); return new Scheduler(store);
  } };
}
async function start(s, agent = "dev") {
  const d = await s.dispatch(agent, async () => {}); await s.acknowledge(agent, d); return d;
}
test("V01：循环、缺失产物与前置定位；计划不改真实进度", () => {
  assert.match(diagnose(project([t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })])).join(), /循环/);
  assert.match(diagnose(project([t("a", { dependsOn: ["missing"] })])).join(), /缺少前置/);
  assert.match(diagnose(project([t("a"), t("b", { dependsOn: [{ taskId: "a", output: "x" }] })])).join(), /未知产物/);
  const state = initial(project([t("a"), t("b", { dependsOn: ["a"] })]));
  assert.deepEqual(plan(state).ready, ["a"]); assert.equal(state.progress.a.status, "pending");
});
test("V02：连续段减少委托说明，跨类别阻断；段内不提前发许可", async ctx => {
  const { scheduler: s } = await setup(ctx, [
    t("a"), t("b", { dependsOn: ["a"] }), t("q", { category: "qa", dependsOn: ["b"] }), t("c", { dependsOn: ["q"] })
  ]);
  assert.deepEqual(s.plan().segments[0].tasks, ["a", "b"]);
  const d = await start(s);
  assert.equal(s.snapshot().runs.length, 1); assert.equal(s.snapshot().progress.b.status, "pending");
  await s.report("dev", d, { status: "completed", summary: "完成" });
  assert.deepEqual(s.plan().ready, ["b"]);
});
test("V03：分叉汇合、粗粒度目录冲突、不同资源并行", async ctx => {
  assert.equal(conflicts([{ path: "SRC/./api", mode: "write" }], [{ path: "src\\api\\x.ts", mode: "read" }]), true);
  assert.equal(conflicts([{ path: "src", mode: "read" }], [{ path: "src/a", mode: "read" }]), false);
  const { scheduler: s } = await setup(ctx, [
    t("a", { resources: ["src"] }), t("q", { category: "qa", resources: ["tests"] }),
    t("end", { dependsOn: ["a", "q"] })
  ]);
  assert.equal(s.plan().segments.length, 2);
  const a = await start(s), q = await start(s, "qa");
  await s.report("dev", a, { status: "completed", summary: "a" });
  assert.ok(!s.plan().ready.includes("end"));
  await s.report("qa", q, { status: "completed", summary: "q" });
  assert.ok(s.plan().ready.includes("end"));
});
test("V04：中间交付先验收后解锁，不等整个任务结束", async ctx => {
  const { scheduler: s } = await setup(ctx, [
    t("a", { outputs: ["api"], review: true }),
    t("q", { category: "qa", dependsOn: [{ taskId: "a", output: "api" }] })
  ]);
  const a = await start(s);
  await s.report("dev", a, { status: "checkpoint", summary: "接口就绪", outputs: { api: "docs/api.md" } });
  assert.ok(!s.plan().ready.includes("q"));
  await s.accept("a", "api");
  assert.ok(s.plan().ready.includes("q")); assert.equal(s.snapshot().progress.a.status, "running");
  await s.report("dev", a, { status: "completed", summary: "完成" });
  assert.equal(s.snapshot().progress.a.status, "review");
  await s.accept("a"); assert.equal(s.snapshot().progress.a.status, "completed");
});
test("V05：授权与暂停；暂停保留占用，确认停止后才重试", async ctx => {
  const { scheduler: s } = await setup(ctx, [t("a", { approval: true, resources: ["src"] })]);
  await assert.rejects(s.dispatch("dev", async () => {}), /暂无/);
  await s.control("approve", "a");
  await start(s); await s.control("pause");
  assert.equal(s.plan().segments.length, 0); assert.equal(s.snapshot().runs[0].phase, "active");
  await assert.rejects(s.control("retry", "a"), /仍在执行/);
  await s.control("resolve-stopped", "a"); await s.control("retry", "a");
  await s.control("resume"); assert.ok(s.plan().ready.includes("a"));
});
test("V06：超时未知、不重发、三ID匹配与重复回执", async ctx => {
  const { scheduler: s } = await setup(ctx, [t("a")], 15);
  let sends = 0;
  const d = await s.dispatch("dev", async () => { sends++; throw new Error("发送结果未知"); });
  assert.equal(s.snapshot().runs[0].phase, "unknown"); assert.equal(sends, 1);
  await assert.rejects(s.dispatch("dev", async () => sends++), /暂无/);
  await assert.rejects(s.acknowledge("qa", d), /不属于/);
  await assert.rejects(s.acknowledge("dev", { ...d, permitId: "bad" }), /不属于/);
  await s.acknowledge("dev", d); await s.acknowledge("dev", d);
  assert.equal(s.snapshot().runs.length, 1);
  await s.report("dev", d, { status: "completed", summary: "收到并完成" });
  await assert.rejects(s.acknowledge("dev", d), /已结束/);
});
test("V07：重启待对账、保留失败重试、文件保存失败不投递", async ctx => {
  const env = await setup(ctx, [t("a")]);
  const a = await start(env.scheduler);
  let s = await env.reopen();
  assert.equal(s.snapshot().runs[0].phase, "unknown");
  await s.acknowledge("dev", a); await s.report("dev", a, { status: "failed", summary: "编译失败" });
  await s.control("retry", "a");
  const b = await start(s);
  assert.notEqual(a.attemptId, b.attemptId); assert.equal(s.snapshot().runs.length, 2);
  assert.ok(JSON.parse(await readFile(env.path, "utf8")).history.some(e => e.action === "failed"));
  await s.control("resolve-stopped", "a"); await s.control("retry", "a");
  await rm(env.path + ".bak", { force: true }); await mkdir(env.path + ".bak");
  let sent = false;
  await assert.rejects(s.dispatch("dev", async () => { sent = true; }));
  assert.equal(sent, false); assert.equal(s.snapshot().progress.a.status, "pending");
});
test("V08 离线部分：只读图含revision、详情和执行段，转义注入", () => {
  const state = initial(project([t("a", { title: "</script><script>alert(1)</script>" })]));
  state.revision = 7;
  const html = renderGraph(state);
  assert.match(html, /revision 7/); assert.match(html, /当前建议执行段/);
  assert.ok(!html.includes("</script><script>alert"));
  assert.match(html, /\\u003c\/script>/);
});
test("动态新增任务：无效图不写回，新增依赖不篡改原记录", async ctx => {
  const { scheduler: s } = await setup(ctx, [t("a")]);
  await assert.rejects(s.addTasks([t("b", { dependsOn: ["bad"] })]), /缺少前置/);
  assert.equal(s.snapshot().project.tasks.length, 1);
  await s.addTasks([t("b", { dependsOn: ["a"] })]);
  assert.equal(s.snapshot().project.tasks.length, 2);
});
test("回执时间到期与悬挂发送均标未知", async ctx => {
  const { scheduler: s } = await setup(ctx, [t("a")], 15);
  const d = await s.dispatch("dev", async () => {});
  await s.expire(Date.now() + 50);
  assert.equal(s.snapshot().runs[0].phase, "unknown");
  await s.control("resolve-stopped", d.taskId); await s.control("retry", d.taskId);
  await s.dispatch("dev", () => new Promise(() => {}));
  assert.equal(s.snapshot().runs.at(-1).phase, "unknown");
});
test("冲突分支排队；同时领取不会产生双重占用", async ctx => {
  const { scheduler: s } = await setup(ctx, [
    t("a", { resources: ["src"] }), t("q", { category: "qa", resources: ["src/a.ts"] })
  ]);
  assert.equal(s.plan().segments.length, 1);
  const result = await Promise.allSettled([s.dispatch("dev", async () => {}), s.dispatch("dev", async () => {})]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(s.snapshot().runs.length, 1);
  await assert.rejects(s.dispatch("qa", async () => {}), /暂无/);
});
test("坏文件不覆盖；同进程重复写者拒绝", async ctx => {
  const env = await setup(ctx, [t("a")]);
  await assert.rejects(FileStore.open(env.path), /已打开/);
  const bad = join(env.dir, "bad.json");
  await writeFile(bad, "broken");
  await assert.rejects(FileStore.open(bad, initial(project([]))));
  assert.equal(await readFile(bad, "utf8"), "broken");
});
test("交付上下文自动带入：specFile合规检查与直接前置产物/摘要带入", async ctx => {
  assert.throws(() => normalize({ name: "x", agents: [{ id: "dev" }], tasks: [{ id: "a", specFile: "/abs/path.md" }] }), /任务卡使用项目相对路径/);
  assert.throws(() => normalize({ name: "x", agents: [{ id: "dev" }], tasks: [{ id: "a", specFile: "../out.md" }] }), /任务卡超出项目根目录/);

  const { scheduler: s } = await setup(ctx, [
    t("a", { outputs: ["api"], specFile: "docs/tasks/a.md" }),
    t("b", { dependsOn: [{ taskId: "a", output: "api" }], specFile: "docs/tasks/b.md" })
  ]);
  const da = await s.dispatch("dev", async () => {});
  assert.equal(da.specFile, "docs/tasks/a.md");
  assert.deepEqual(da.dependencies, []);
  await s.acknowledge("dev", da);
  await s.report("dev", da, { status: "completed", summary: "接口已写好", outputs: { api: "docs/api.json" } });

  const db = await s.dispatch("dev", async () => {});
  assert.equal(db.taskId, "b");
  assert.equal(db.specFile, "docs/tasks/b.md");
  assert.deepEqual(db.dependencies, [{
    taskId: "a",
    output: "api",
    reference: "docs/api.json",
    summary: "接口已写好"
  }]);
  const delivery = s.delivery(s.snapshot().runs.find(r => r.taskId === "b"));
  assert.deepEqual(delivery.dependencies, db.dependencies);
  assert.equal(delivery.specFile, "docs/tasks/b.md");
});
