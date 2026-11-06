import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initial, normalize } from "../dist/core/model.js";
import { FileStore } from "../dist/store/file-store.js";
import { Scheduler } from "../dist/dispatcher/scheduler.js";

async function setup(t, { review = true, outputs = ["api"] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-file-evidence-"));
  const workspace = join(directory, "workspace"), path = join(directory, "state.json");
  await mkdir(workspace);
  let store = await FileStore.open(path, initial(normalize({
    agents: [{ id: "dev" }, { id: "qa" }], tasks: [
      { id: "a", owner: "dev", review, outputs },
      { id: "q", owner: "qa", dependsOn: [{ taskId: "a", output: outputs[0] }] }
    ]
  })));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const env = { directory, workspace, path, scheduler: new Scheduler(store, undefined, workspace),
    async file(path, content) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content);
    },
    async reopen() {
      await store.close(); store = await FileStore.open(path);
      return env.scheduler = new Scheduler(store, undefined, workspace);
    } };
  return env;
}
async function start(s, agentId = "dev") {
  const run = await s.dispatch(agentId, async () => {});
  await s.acknowledge(agentId, run);
  return run;
}
async function unchanged(env, operation, error) {
  const before = env.scheduler.snapshot(), bytes = await readFile(env.path);
  await assert.rejects(operation(), error);
  assert.deepEqual(env.scheduler.snapshot(), before);
  assert.deepEqual(await readFile(env.path), bytes);
}
const digest = data => createHash("sha256").update(data).digest("hex");

test("显式本地文件由调度器采集实际字节，待验收和重新打开后证据保留", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  const api = Buffer.from("接口\n\0binary"), example = Buffer.from([0, 1, 2, 255]);
  await env.file("docs/api.md", api); await env.file("docs/example.bin", example);
  await s.report("dev", run, { status: "completed", summary: "待验收", outputs: { api: "接口交付" },
    files: { api: ["docs/api.md", "docs/example.bin"] } });
  const files = [
    { path: "docs/api.md", size: api.length, sha256: digest(api) },
    { path: "docs/example.bin", size: example.length, sha256: digest(example) }
  ];
  const state = s.snapshot();
  assert.equal(state.progress.a.status, "review");
  assert.deepEqual(state.progress.a.outputs.api, { accepted: false, reference: "接口交付", files });
  assert.deepEqual(state.runs[0].outputs, state.progress.a.outputs);
  assert.equal(s.delivery(run).outputs, undefined);
  assert.equal(s.delivery(run).tests, undefined);
  assert.ok(!s.plan().ready.includes("q"));
  const reopened = await env.reopen();
  assert.deepEqual(reopened.snapshot().progress.a.outputs.api.files, files);
  await reopened.accept("a");
  assert.equal(reopened.snapshot().progress.a.status, "completed");
  assert.ok(reopened.plan().ready.includes("q"));
});

test("验收检测同路径内容变化，拒绝时不写状态、不解锁，恢复原文件后可接受", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  await env.file("api.md", "v1");
  await s.report("dev", run, { status: "completed", summary: "v1", outputs: { api: "api.md" }, files: { api: "api.md" } });
  await env.file("api.md", "v2");
  await unchanged(env, () => s.accept("a"), /文件内容已变化/);
  assert.ok(!s.plan().ready.includes("q"));
  await env.file("api.md", "v1");
  await s.accept("a");
  assert.ok(s.plan().ready.includes("q"));
});

test("验收检测文件缺失，提交缺失文件也不保存半份报告", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  await unchanged(env, () => s.report("dev", run, { status: "completed", summary: "missing",
    outputs: { api: "api.md" }, files: { api: "api.md" } }), /文件不存在/);
  await env.file("api.md", "v1");
  await s.report("dev", run, { status: "completed", summary: "v1", outputs: { api: "api.md" }, files: { api: "api.md" } });
  await rm(join(env.workspace, "api.md"));
  await unchanged(env, () => s.accept("a", "api"), /文件不存在/);
});

test("文件证据拒绝越界、绝对路径、URL和目录，不猜测普通引用", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  await mkdir(join(env.workspace, "folder"));
  for (const path of ["../outside.md", "C:/outside.md", "/outside.md", "https://example.invalid/file", "folder"]) {
    await unchanged(env, () => s.report("dev", run, { status: "completed", summary: "invalid",
      outputs: { api: "ref:api" }, files: { api: path } }), /工作区|普通文件/);
  }
  await s.report("dev", run, { status: "completed", summary: "旧引用语义", outputs: { api: [
    "missing/local.md", "git:abc123", "https://example.invalid/api", "opaque:result"
  ] } });
  await s.accept("a");
  assert.equal(s.snapshot().progress.a.outputs.api.files, undefined);
});

test("文件路径经junction或symlink逃出工作区时拒绝", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  const outside = join(env.directory, "outside");
  await mkdir(outside); await writeFile(join(outside, "api.md"), "outside");
  try { await symlink(outside, join(env.workspace, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("当前系统不允许创建链接"); throw error; }
  await unchanged(env, () => s.report("dev", run, { status: "completed", summary: "escape",
    outputs: { api: "ref:api" }, files: { api: "linked/api.md" } }), /实际位置超出工作区/);
});

test("普通任务提交文件可直接完成，不新增审批，后续不能重写已接受文件证据", async t => {
  const env = await setup(t, { review: false }), s = env.scheduler, run = await start(s);
  await env.file("api.md", "v1");
  await s.report("dev", run, { status: "checkpoint", summary: "v1", outputs: { api: "api.md" }, files: { api: "api.md" } });
  const accepted = s.snapshot().progress.a.outputs.api;
  assert.equal(accepted.accepted, true);
  await start(s, "qa");
  const downstream = s.snapshot().runs[1];
  await s.report("dev", run, { status: "checkpoint", summary: "同文件", outputs: { api: "api.md" }, files: { api: "./api.md" } });
  assert.deepEqual(s.snapshot().progress.a.outputs.api, accepted);
  await env.file("api.md", "v2");
  await unchanged(env, () => s.report("dev", run, { status: "completed", summary: "不能偷偷换证据",
    outputs: { api: "api.md" }, files: { api: "api.md" } }), /已被接受.*文件证据/);
  assert.deepEqual(s.snapshot().runs[1], downstream);
  await env.file("api.md", "v1");
  await s.report("dev", run, { status: "completed", summary: "仍沿用原文件" });
  assert.equal(s.snapshot().progress.a.status, "completed");
  assert.deepEqual(s.snapshot().progress.a.outputs.api, accepted);
});

test("旧已接受引用不能事后补文件证据，未接受的同引用重报不会丢掉已有证据", async t => {
  const regular = await setup(t, { review: false }), a = await start(regular.scheduler);
  await regular.file("api.md", "v1");
  await regular.scheduler.report("dev", a, { status: "checkpoint", summary: "无证据", outputs: { api: "api.md" } });
  await unchanged(regular, () => regular.scheduler.report("dev", a, { status: "checkpoint", summary: "事后补写",
    files: { api: "api.md" } }), /已被接受.*文件证据/);
  const env = await setup(t), s = env.scheduler, run = await start(s);
  await env.file("api.md", "v1");
  await s.report("dev", run, { status: "checkpoint", summary: "有证据", outputs: { api: "api.md" }, files: { api: "api.md" } });
  const files = s.snapshot().progress.a.outputs.api.files;
  await env.file("api.md", "v2");
  await s.report("dev", run, { status: "completed", summary: "省略files", outputs: { api: "api.md" } });
  assert.deepEqual(s.snapshot().progress.a.outputs.api.files, files);
  await unchanged(env, () => s.accept("a"), /文件内容已变化/);
});

test("返工保留原attempt文件证据与自报测试，已接受契约沿用，新产物独立采集", async t => {
  const env = await setup(t, { outputs: ["api", "implementation"] }), s = env.scheduler, first = await start(s);
  await env.file("contract.md", "contract"); await env.file("v1.mjs", "v1");
  await s.report("dev", first, { status: "completed", summary: "首轮失败", outputs: { api: "contract.md", implementation: "v1.mjs" },
    files: { api: "contract.md", implementation: "v1.mjs" }, tests: [{ command: "node --test", exitCode: 1, stdout: "initial.log" }] });
  await s.accept("a", "api");
  const original = s.snapshot().runs[0], accepted = s.snapshot().progress.a.outputs.api;
  await s.rework("a", "修复实现，保留契约");
  assert.deepEqual(s.snapshot().progress.a.outputs.api, accepted);
  assert.deepEqual(s.snapshot().runs[0].outputs, original.outputs);
  assert.deepEqual(s.snapshot().runs[0].tests, original.tests);
  assert.deepEqual(s.snapshot().runs[0].rework.outputs.implementation.files, original.outputs.implementation.files);
  const second = await start(s);
  await env.file("v2.mjs", "v2");
  await s.report("dev", second, { status: "completed", summary: "修正完成", outputs: { implementation: "v2.mjs" },
    files: { implementation: "v2.mjs" }, tests: [{ command: "node --test", exitCode: 0, stdout: "final.log" }] });
  await s.accept("a");
  const final = s.snapshot();
  assert.deepEqual(final.progress.a.outputs.api, accepted);
  assert.equal(final.progress.a.outputs.implementation.files[0].sha256, digest("v2"));
  assert.equal(final.runs[0].tests[0].exitCode, 1);
  assert.equal(final.runs[1].tests[0].exitCode, 0);
  assert.equal(final.runs[0].outputs.implementation.files[0].sha256, digest("v1"));
});

test("tests只留执行者自报记录，不执行命令、不把非零退出码改判成任务失败", async t => {
  const env = await setup(t, { review: false }), s = env.scheduler, run = await start(s);
  const marker = join(env.workspace, "must-not-exist");
  const tests = [{ command: `node -e "require('fs').writeFileSync('${marker.replaceAll("\\", "/")}','oops')"`,
    exitCode: 7, stdout: "logs/out.txt", stderr: "logs/err.txt" }];
  await s.report("dev", run, { status: "completed", summary: "按成员报告", outputs: { api: "git:abc123" }, tests });
  tests[0].exitCode = 0;
  assert.equal(s.snapshot().progress.a.status, "completed");
  assert.equal(s.snapshot().runs[0].tests[0].exitCode, 7);
  assert.equal(s.snapshot().runs[0].tests[0].source, "reported");
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("非法files/test字段拒绝整份报告；已记录的测试在后续checkpoint追加保留", async t => {
  const env = await setup(t), s = env.scheduler, run = await start(s);
  for (const fields of [
    { files: [] }, { files: { api: "" } }, { files: { api: ["x", null] } },
    { files: { other: "api.md" } }, { files: { api: "api.md" } },
    { tests: {} }, { tests: [null] }, { tests: [{ command: "", exitCode: 0 }] },
    { tests: [{ command: "test", exitCode: "0" }] }, { tests: [{ command: "test", exitCode: 0.5 }] },
    { tests: [{ command: "test", exitCode: 0, stdout: [] }] }
  ]) await unchanged(env, () => s.report("dev", run, { status: "checkpoint", summary: "invalid", ...fields }), /files|引用|未声明|tests/);
  await s.report("dev", run, { status: "checkpoint", summary: "第一次", tests: [{ command: "first", exitCode: 1 }] });
  await s.report("dev", run, { status: "checkpoint", summary: "第二次", tests: [{ command: "second", exitCode: 0 }] });
  assert.deepEqual(s.snapshot().runs[0].tests.map(test => test.command), ["first", "second"]);
  await s.report("dev", run, { status: "completed", summary: "保留测试记录", outputs: { api: "ref:result" } });
  assert.equal(s.snapshot().runs[0].tests.length, 2);
});
