import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";

async function setup(t, { review = true, outputs = ["api", "draft"], seed } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-artifacts-")), path = join(directory, "state.json");
  const state = initial(normalize({ agents: [{ id: "dev" }, { id: "qa" }], tasks: [
    { id: "a", owner: "dev", review, outputs },
    { id: "q", owner: "qa", dependsOn: [{ taskId: "a", output: "api" }] }
  ] }));
  seed?.(state);
  let store = await FileStore.open(path, state);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, scheduler: new Scheduler(store), reopen: async () => {
    await store.close(); store = await FileStore.open(path); return new Scheduler(store);
  } };
}
async function start(s, agentId = "dev") {
  const run = await s.dispatch(agentId, async () => {});
  await s.acknowledge(agentId, run);
  return run;
}
async function unchanged(path, s, operation, error) {
  const before = s.snapshot(), bytes = await readFile(path);
  await assert.rejects(operation(), error);
  assert.deepEqual(s.snapshot(), before);
  assert.deepEqual(await readFile(path), bytes);
}

test("已接受中间产物：同引用重复交付保留接受状态和已启动下游", async t => {
  const { scheduler: s } = await setup(t), a = await start(s);
  await s.report("dev", a, { status: "checkpoint", summary: "接口v1", outputs: { api: "docs/api-v1.md" } });
  await s.accept("a", "api");
  const q = await start(s, "qa"), downstream = s.snapshot().runs.find(run => run.taskId === "q");
  for (const status of ["checkpoint", "completed"]) {
    await s.report("dev", a, { status, summary: "同一接口", outputs: { api: "docs/api-v1.md", draft: "draft.md" } });
    assert.deepEqual(s.snapshot().progress.a.outputs.api, { accepted: true, reference: "docs/api-v1.md" });
    assert.deepEqual(s.snapshot().runs.find(run => run.taskId === "q"), downstream);
    assert.equal(s.delivery(q).dependencies[0].reference, "docs/api-v1.md");
  }
  assert.equal(s.snapshot().progress.a.status, "review");
  assert.equal(s.snapshot().progress.a.outputs.draft.accepted, false);
  await s.accept("a");
  assert.equal(s.snapshot().progress.a.status, "completed");
});

test("已接受引用变更：包含其他更新的整份报告拒绝，状态/文件/历史保持", async t => {
  const { path, scheduler: s } = await setup(t), a = await start(s);
  await s.report("dev", a, { status: "checkpoint", summary: "接口v1", outputs: { api: "api-v1.md", draft: "draft-v1.md" } });
  await s.accept("a", "api");
  await start(s, "qa");
  for (const status of ["checkpoint", "completed", "failed", "blocked"]) {
    await unchanged(path, s, () => s.report("dev", a, { status, summary: "不应写入", outputs: {
      draft: "draft-v2.md", api: "api-v2.md"
    } }), /已被接受.*修订任务/);
  }
});

test("普通checkpoint同样保护已接受引用；尚未验收的草稿可修订", async t => {
  const regular = await setup(t, { review: false }), a = await start(regular.scheduler);
  await regular.scheduler.report("dev", a, { status: "checkpoint", summary: "初版", outputs: { api: "v1.md" } });
  await unchanged(regular.path, regular.scheduler, () => regular.scheduler.report("dev", a, {
    status: "completed", summary: "改写", outputs: { api: "v2.md", draft: "draft.md" }
  }), /已被接受/);
  const review = await setup(t), b = await start(review.scheduler);
  for (const reference of ["v1.md", "v2.md"]) await review.scheduler.report("dev", b, {
    status: "checkpoint", summary: "草稿", outputs: { api: reference }
  });
  assert.deepEqual(review.scheduler.snapshot().progress.a.outputs.api, { accepted: false, reference: "v2.md" });
  assert.ok(!review.scheduler.plan().ready.includes("q"));
});

test("无效产物映射、空引用或混合数组不提交、不解锁；缺失声明产物也不提交", async t => {
  const { path, scheduler: s } = await setup(t, { review: false }), a = await start(s);
  const invalid = [null, [], "api.md", 0, true, new Date(), new Map(),
    ...[null, undefined, 0, false, "", " \n\t", [], [""], ["a.md", null], ["a.md", 3], ["a.md", " "], [["a.md"]], Array(1)]
      .map(api => ({ draft: "valid.md", api }))];
  for (const outputs of invalid) {
    await unchanged(path, s, () => s.report("dev", a, { status: "completed", summary: "不应交付", outputs }), /outputs|引用/);
    assert.ok(!s.plan().ready.includes("q"));
  }
  await unchanged(path, s, () => s.report("dev", a, { status: "completed", summary: "缺产物", outputs: {} }), /补齐/);
  await unchanged(path, s, () => s.report("dev", a, { status: "checkpoint", summary: "多余产物", outputs: { other: "a.md" } }), /未声明/);
});

test("多引用数组原样交付与持久化，保存隔离外部修改，按原顺序判断同一引用", async t => {
  const env = await setup(t, { outputs: ["api"] }), s = env.scheduler, a = await start(s);
  const references = ["tests/core.test.mjs", "tests/cli.test.mjs"];
  await s.report("dev", a, { status: "checkpoint", summary: "测试产物", outputs: { api: references } });
  references[0] = "mutated.mjs";
  const original = ["tests/core.test.mjs", "tests/cli.test.mjs"];
  assert.deepEqual(s.snapshot().progress.a.outputs.api.reference, original);
  assert.deepEqual(JSON.parse(await readFile(env.path, "utf8")).progress.a.outputs.api.reference, original);
  await s.accept("a", "api");
  const q = await start(s, "qa");
  assert.deepEqual(q.dependencies[0].reference, original);
  await s.report("dev", a, { status: "checkpoint", summary: "同列表", outputs: { api: [...original] } });
  assert.equal(s.snapshot().progress.a.outputs.api.accepted, true);
  await unchanged(env.path, s, () => s.report("dev", a, { status: "checkpoint", summary: "重排", outputs: {
    api: [...original].reverse()
  } }), /已被接受/);
  await unchanged(env.path, s, () => s.report("dev", a, { status: "checkpoint", summary: "类型变更", outputs: {
    api: original.join(",")
  } }), /已被接受/);
  await s.report("dev", a, { status: "completed", summary: "完成" });
  await s.accept("a");
  await s.report("qa", q, { status: "completed", summary: "完成" });
  const reopened = await env.reopen();
  assert.deepEqual(reopened.snapshot().progress.a.outputs.api, { accepted: true, reference: original });
});

test("引用保持文件/提交/URL/opaque语义，特殊产物名按自身键保存", async t => {
  const { path, scheduler: s } = await setup(t, { review: false, outputs: ["api", "constructor", "__proto__", "opaque"] });
  const a = await start(s), outputs = JSON.parse('{"api":" folder/api.md ","constructor":"git:abc123","__proto__":"https://example.invalid/artifact","opaque":"ref:build-1"}');
  await unchanged(path, s, () => s.report("dev", a, {
    status: "completed", summary: "缺少自身键", outputs: { api: "a.md", opaque: "ref:1" }
  }), /补齐/);
  await s.report("dev", a, { status: "completed", summary: "引用完成", outputs });
  assert.deepEqual(s.delivery(await start(s, "qa")).dependencies[0].reference, outputs.api);
  for (const [name, reference] of Object.entries(outputs)) {
    assert.equal(Object.hasOwn(s.snapshot().progress.a.outputs, name), true);
    assert.deepEqual(s.snapshot().progress.a.outputs[name], { accepted: true, reference });
  }
});

test("旧版未接受的无效引用不能验收；校验只针对本次接受目标", async t => {
  const { path, scheduler: s } = await setup(t, { seed(state) {
    state.progress.a.status = "running";
    state.progress.a.outputs = { api: { accepted: false, reference: null }, draft: { accepted: false, reference: ["a.md", "b.md"] } };
  } });
  await unchanged(path, s, () => s.accept("a", "api"), /引用/);
  await s.accept("a", "draft");
  assert.equal(s.snapshot().progress.a.outputs.draft.accepted, true);
  assert.ok(!s.plan().ready.includes("q"));
  const review = await setup(t, { seed(state) {
    state.progress.a.status = "review";
    state.progress.a.outputs = { api: { accepted: false, reference: null }, draft: { accepted: false, reference: "valid.md" } };
  } });
  await unchanged(review.path, review.scheduler, () => review.scheduler.accept("a"), /引用/);
  const historical = await setup(t, { seed(state) {
    state.progress.a.status = "review";
    state.progress.a.outputs = { api: { accepted: true, reference: null }, draft: { accepted: false, reference: "valid.md" } };
  } });
  await historical.scheduler.accept("a");
  assert.deepEqual(historical.scheduler.snapshot().progress.a.outputs.api, { accepted: true, reference: null });
  assert.equal(historical.scheduler.snapshot().progress.a.outputs.draft.accepted, true);
});
