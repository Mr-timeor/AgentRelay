import test from "node:test";
import assert from "node:assert/strict";
import { Script, createContext, runInContext } from "node:vm";
import { initial, normalize } from "../dist/core/model.js";
import { renderGraph } from "../dist/ui/graph.js";

const state = () => initial(normalize({ name: "开发与测试", agents: [
  { id: "developer", categories: ["开发"] }, { id: "tester", categories: ["测试"] }
], tasks: [
  { id: "A1", title: "接口实现", category: "开发", outputs: ["api"] },
  { id: "A2", title: "收尾", category: "开发", dependsOn: ["A1"] },
  { id: "B1", title: "接口测试", category: "测试", dependsOn: [{ taskId: "A1", output: "api" }] }
] }));
const payload = html => JSON.parse(html.match(/<script id="scheduler-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const script = html => html.match(/<script>\n([\s\S]*?)<\/script>/)[1];

// 轻量DOM替身只模拟本页使用的浏览器接口；真实布局和双视图由浏览器验证。
function clientHarness(firstHtml, { fetchResult, fetchError } = {}) {
  const calls = [], intervals = [], listeners = new Map(), known = new Map();
  class Element {
    constructor(id, text = "") {
      this.id = id; this.children = []; this.textContent = text; this.value = ""; this.dataset = {};
      this.attributes = {}; this.classes = new Set(); this.nodes = [];
      this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    }
    addEventListener(name, fn) { listeners.set(this.id + ":" + name, fn); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this._text = ""; this.children = children; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    querySelectorAll(selector) { assert.equal(selector, ".node"); return this.nodes; }
    contains(node) { return this.nodes.includes(node); }
    replaceWith(element) { elements.set(this.id, element); }
  }
  const makeDoc = html => {
    const data = payload(html), result = new Map();
    const overview = new Element("overview"); overview.dataset.schedulerRevision = String(data.revision); result.set("overview", overview);
    const progress = new Element("progress-overview", JSON.stringify(data.summary)); progress.dataset.schedulerRevision = String(data.revision); result.set("progress-overview", progress);
    const graph = new Element("graph"); graph.attributes.viewBox = "0 0 900 600";
    graph.nodes = Object.keys(data.details).map(id => { const node = new Element(id); node.dataset.id = id; node.closest = () => node; return node; });
    result.set("graph", graph); result.set("scheduler-data", new Element("scheduler-data", JSON.stringify(data)));
    result.set("segments", new Element("segments")); result.set("diagnostics", new Element("diagnostics"));
    return { getElementById: id => result.get(id) ?? null };
  };
  const doc = makeDoc(firstHtml), elements = new Map(["overview", "progress-overview", "graph", "scheduler-data", "segments", "diagnostics"].map(id => [id, doc.getElementById(id)]));
  for (const id of ["canvas", "search", "detail", "refresh-status", "plus", "minus", "fit", "zoom-label", "refresh"]) elements.set(id, new Element(id));
  Object.assign(elements.get("canvas"), { clientWidth: 900, clientHeight: 600, scrollLeft: 0, scrollTop: 0 });
  const context = createContext({
    window: {}, document: { hidden: false, getElementById: id => elements.get(id), importNode: n => n, createElement: tag => new Element(tag) },
    location: { href: "http://localhost:1234/graph", origin: "http://localhost:1234" },
    URL, AbortController, Date, setTimeout: () => 1, clearTimeout() {}, setInterval: fn => intervals.push(fn),
    fetch: async (...args) => { calls.push(args); if (fetchError) throw fetchError; return { ok: true, text: async () => fetchResult ?? firstHtml }; },
    DOMParser: class { parseFromString(html) { if (known.has(html)) return known.get(html); return makeDoc(html); } }
  });
  runInContext(script(firstHtml), context);
  return { context, elements, calls, intervals, known, listeners, makeDoc,
    async settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    apply(html) { return context.window.schedulerApplyHtml(html); }
  };
}

test("只读静态图：转义任务文本、脚本可解析、渲染不改变调度状态", () => {
  const current = state(); current.revision = 7;
  current.project.name = '<img src=x onerror="alert(1)">';
  current.project.tasks[0].title = "</script><script>alert(1)</script>";
  const before = structuredClone(current), html = renderGraph(current);
  assert.deepEqual(current, before);
  assert.match(html, /revision 7/);
  assert.match(html, /const refreshConfig=null/);
  assert.ok(!html.includes('id="refresh"'));
  assert.ok(!html.includes("</script><script>alert(1)"));
  assert.match(html, /\\u003c\/script>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.equal(payload(html).details.A1.includes("</script><script>alert(1)</script>"), true);
  new Script(script(html));
});

test("图表达类别、执行者、建议段与解锁消费者；完成态不再显示可领取", () => {
  const current = state(), first = renderGraph(current);
  assert.match(first, /data-category="开发"[^>]*>\s*<title>/);
  assert.match(first, /data-category="测试"/);
  assert.match(first, /class="cat-name"[^>]*>开发/);
  assert.match(first, /class="cat-name"[^>]*>测试/);
  assert.match(first, /段 1 · developer/);
  assert.match(first, /中间交付：A1\/api → B1/);
  assert.match(payload(first).details.A1, /执行者：developer/);
  assert.match(payload(first).details.B1, /下一步：等待 A1\/api/);
  current.progress.A1.status = "completed";
  assert.match(payload(renderGraph(current)).details.A1, /下一步：本任务已完成/);
  const broken = state(); broken.project.tasks[0].dependsOn = [{ taskId: "B1" }];
  assert.match(renderGraph(broken), /循环/);
});

test("竖向布局：依赖自上而下、同阶段同行、阶段标签与竖向连线", () => {
  const html = renderGraph(state());
  const at = id => {
    const match = html.match(new RegExp(`data-id="${id}"[^>]*transform="translate\\(([-\\d.]+),([-\\d.]+)\\)"`));
    return match && { x: Number(match[1]), y: Number(match[2]) };
  };
  const a1 = at("A1"), a2 = at("A2"), b1 = at("B1");
  assert.ok(a1 && a2 && b1, "节点应带坐标");
  assert.ok(a2.y > a1.y && a2.y - a1.y > 112, "下游任务必须在父任务下方一行");
  assert.equal(a2.y, b1.y, "同一阶段的任务同行");
  assert.ok(b1.x > a2.x, "同阶段按类别分组，测试排在开发之后");
  const width = Number(html.match(/id="graph" width="([\d.]+)"/)[1]);
  assert.equal(a1.x + 292 / 2, width / 2, "单节点行应位于画布中线");
  assert.equal((a2.x + b1.x + 292) / 2, width / 2, "多节点行的整体应居中");
  assert.match(html, /class="stage-label"[^>]*>阶段 1</);
  assert.match(html, /class="stage-label"[^>]*>阶段 2</);
  // 每条依赖边都从父节点底部往下走，且终点是子节点顶部。
  const edges = [...html.matchAll(/class="edge" d="M([\d.]+),([\d.]+)[^"]*L([\d.]+),([\d.]+)"/g)];
  assert.ok(edges.length >= 2, "应画出全部依赖边");
  for (const [, , sy, ex, ey] of edges) assert.ok(Number(ey) > Number(sy), `边 ${ex} 必须向下`);
});


test("静态图无网络；宿主HTML刷新保留搜索、选中任务、缩放与滚动", () => {
  const current = state(), harness = clientHarness(renderGraph(current));
  assert.equal(harness.calls.length, 0); assert.equal(harness.intervals.length, 0);
  const { elements, listeners } = harness;
  elements.get("search").value = "接口"; listeners.get("search:input")();
  listeners.get("canvas:click")({ target: elements.get("graph").nodes[0] });
  elements.get("plus").onclick();
  const width = elements.get("graph").getAttribute("width");
  elements.get("canvas").scrollLeft = 40; elements.get("canvas").scrollTop = 20;
  current.revision = 1; current.progress.A1.status = "completed"; current.progress.A1.summary = "实现完成";
  const applied = harness.apply(renderGraph(current));
  assert.equal(applied.applied, true); assert.equal(applied.revision, 1);
  assert.equal(elements.get("search").value, "接口");
  assert.equal(elements.get("graph").getAttribute("width"), width);
  assert.equal(elements.get("canvas").scrollLeft, 40); assert.equal(elements.get("canvas").scrollTop, 20);
  assert.ok(elements.get("graph").nodes[0].classes.has("selected"));
  assert.ok(elements.get("graph").nodes[1].classes.has("dim"));
  assert.match(elements.get("detail").textContent, /实现完成/);
  assert.match(elements.get("progress-overview").textContent, /"completed":1/);
  const previous = elements.get("graph");
  assert.equal(harness.apply(renderGraph(current)).applied, false);
  assert.equal(elements.get("graph"), previous);
  current.revision = 0;
  assert.equal(harness.apply(renderGraph(current)).applied, false);
  assert.equal(elements.get("graph"), previous);
  assert.match(elements.get("refresh-status").textContent, /忽略旧版本/);
});

test("三栏概览按真实任务状态计数，待验收和等待前置不会被计为完成或失败阻塞", () => {
  const current = state(), initialHtml = renderGraph(current), initialData = payload(initialHtml);
  assert.match(initialHtml, /grid-template-columns:232px minmax\(0,1fr\) 320px/);
  assert.match(initialHtml, /aria-label="项目进度概览"/);
  assert.match(initialHtml, /按任务数量计算，非工时/);
  const header = initialHtml.match(/<header>([\s\S]*?)<\/header>/)[1];
  assert.equal((header.match(/<span class="chip(?: [^"]*)?">/g) ?? []).length, 3, "顶部只保留只读、版本与调度状态");
  assert.ok(!/个任务|个就绪|个进行中|个完成|class="progress"/.test(header), "数量与进度只由左侧概览展示");
  assert.equal(initialData.summary.total, 3);
  assert.equal(initialData.summary.completed, 0);
  assert.equal(initialData.summary.ready, 1);
  assert.equal(initialData.summary.pending, 3);
  assert.equal(initialData.summary.blocked, 0);
  assert.equal(initialData.summary.waitingDependencies, 2);
  current.progress.A1.status = "completed";
  current.progress.A2.status = "review";
  current.progress.B1.status = "blocked";
  const html = renderGraph(current), data = payload(html);
  assert.equal(data.summary.completed, 1); assert.equal(data.summary.review, 1); assert.equal(data.summary.blocked, 1);
  assert.match(html, /aria-valuenow="1"/);
  assert.match(html, /<strong>33%<\/strong>/);
  const empty = renderGraph(initial(normalize({ agents: [], tasks: [] })));
  assert.match(empty, /<strong>0%<\/strong>/);
  assert.match(empty, /尚无任务/);
});

test("右侧详情按节点与键盘选择展示文件证据、最近运行和返工数据", () => {
  const current = state();
  current.progress.A1.status = "review";
  current.progress.A1.outputs.api = { accepted: false, reference: "docs/api.md", files: [{ path: "docs/api.md", size: 12, sha256: "a".repeat(64) }] };
  current.runs.push({ taskId: "A1", agentId: "developer", phase: "finished", startedAt: 0,
    dispatchId: "dispatch-1", attemptId: "attempt-1", permitId: "permit-1", tests: [{ command: "node --test", exitCode: 1, source: "reported" }],
    rework: { feedback: "补齐错误输入", outputs: structuredClone(current.progress.A1.outputs) } });
  const html = renderGraph(current), data = payload(html), harness = clientHarness(html);
  assert.match(harness.elements.get("detail").textContent, /选择一个任务/);
  let prevented = false;
  harness.listeners.get("canvas:keydown")({ key: "Enter", target: harness.elements.get("graph").nodes[0], preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const detail = harness.elements.get("detail").textContent;
  for (const text of ["接口实现", "待验收", "docs/api.md", "a".repeat(64), "attempt-1", "node --test", "退出码：1", "执行者自报", "补齐错误输入"]) assert.ok(detail.includes(text), text);
  assert.ok(data.taskDetails.A1.sections.some(section => section.collapsed && section.title === "最近运行"));
});

test("适配视图使完整图回到可见范围，并保留选中和搜索", () => {
  const h = clientHarness(renderGraph(state())), { elements, listeners } = h;
  elements.get("search").value = "接口"; listeners.get("search:input")();
  listeners.get("canvas:click")({ target: elements.get("graph").nodes[0] });
  elements.get("plus").onclick(); elements.get("plus").onclick();
  assert.ok(Number(elements.get("graph").getAttribute("width")) > elements.get("canvas").clientWidth);
  elements.get("canvas").scrollLeft = 90; elements.get("canvas").scrollTop = 40;
  elements.get("fit").onclick();
  assert.ok(Number(elements.get("graph").getAttribute("width")) <= elements.get("canvas").clientWidth - 44);
  assert.ok(Number(elements.get("graph").getAttribute("height")) <= elements.get("canvas").clientHeight - 44);
  assert.equal(elements.get("canvas").scrollLeft, 0); assert.equal(elements.get("canvas").scrollTop, 0);
  assert.equal(elements.get("search").value, "接口"); assert.ok(elements.get("graph").nodes[0].classes.has("selected"));
  assert.match(elements.get("detail").textContent, /接口实现/);
});

test("实时图只GET同源HTML；错误保留旧图并显示上次成功信息", async () => {
  const current = state();
  const harness = clientHarness(renderGraph(current, { refreshUrl: "/graph", refreshIntervalMs: 2000 }));
  await harness.settle();
  assert.equal(harness.calls.length, 1); assert.equal(harness.intervals.length, 1);
  assert.equal(harness.calls[0][1].method, "GET"); assert.equal(harness.calls[0][1].cache, "no-store");
  assert.match(harness.elements.get("refresh-status").textContent, /上次成功/);
  const original = harness.elements.get("graph"), bad = "malformed-snapshot";
  harness.known.set(bad, { getElementById() { return null; } });
  assert.throws(() => harness.apply(bad), /有效流程图/);
  assert.equal(harness.elements.get("graph"), original);
  assert.match(harness.elements.get("refresh-status").textContent, /更新失败.*上次成功/);
  const offline = clientHarness(renderGraph(current, { refreshUrl: "/graph" }), { fetchError: new Error("断网") });
  await offline.settle();
  assert.match(offline.elements.get("refresh-status").textContent, /更新失败，保留当前视图/);
  assert.match(offline.elements.get("refresh-status").textContent, /断网/);
  const foreign = clientHarness(renderGraph(current, { refreshUrl: "https://elsewhere.invalid/graph" }));
  await foreign.settle();
  assert.equal(foreign.calls.length, 0);
  assert.match(foreign.elements.get("refresh-status").textContent, /同源/);
});
