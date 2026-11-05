import { plan } from "../core/planner.js";
import type { State } from "../core/model.js";

export interface GraphOptions { refreshUrl?: string; refreshIntervalMs?: number }
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const labels: Record<string, string> = { pending: "待执行", running: "执行中", review: "待验收", completed: "已完成", failed: "失败", blocked: "阻塞", awaiting: "待回执", active: "执行中", unknown: "待对账", finished: "本轮已结束" };

type Task = State["project"]["tasks"][number];

// 竖向拓扑：一列一阶段，依赖只从上往下；卡片按类别分色，同一类别在行内相邻。
const NODE_W = 292, NODE_H = 112, GAP_X = 36, GROUP_GAP = 34, ROW_GAP = 56, PAD = 26, TOP = 80;
const TONES: Record<string, { accent: string; text: string }> = {
  ready: { accent: "#5f9fd8", text: "#dceeff" },
  pending: { accent: "#6b7f96", text: "#e4edf8" },
  running: { accent: "#38bdf8", text: "#dff4ff" },
  review: { accent: "#f5b942", text: "#fff3d6" },
  completed: { accent: "#34d399", text: "#dcfcef" },
  failed: { accent: "#fb7185", text: "#ffe1e6" },
  blocked: { accent: "#a78bfa", text: "#eee4ff" },
  unknown: { accent: "#c084fc", text: "#f1e6ff" }
};
const CATEGORY_COLORS = ["#5aa9e6", "#f0a94c", "#59c9a5", "#b98be8", "#ef8297", "#7fc4d8", "#d4c46a"];
const short = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;
// 粗略字宽：中文按 12px、其余按 6.8px 估算，用于状态胶囊背景。
const textWidth = (s: string) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 12 : 6.8), 0);
function wrap(text: string, max: number, lines = 2): string[] {
  const chars = [...text], out: string[] = [];
  for (let i = 0; i < chars.length && out.length < lines; i += max) out.push(chars.slice(i, i + max).join(""));
  if (out.length === lines && chars.length > max * lines) out[lines - 1] = [...out[lines - 1]].slice(0, max - 1).join("") + "…";
  return out.length ? out : [text];
}
// 折线连接：先竖直下探、再横移、再竖直落到下一阶段，拐角做圆角。
function connector(sx: number, sy: number, ex: number, ey: number): string {
  const dx = ex - sx, dy = ey - sy;
  if (Math.abs(dx) < 1.5 || dy < 12) return `M${sx},${sy} L${ex},${ey}`;
  const mid = (sy + ey) / 2, dir = dx > 0 ? 1 : -1, r = Math.min(16, Math.abs(dx) / 2, dy / 2);
  return `M${sx},${sy} L${sx},${mid - r} Q${sx},${mid} ${sx + dir * r},${mid} L${ex - dir * r},${mid} Q${ex},${mid} ${ex},${mid + r} L${ex},${ey}`;
}

export function renderGraph(state: State, options: GraphOptions = {}): string {
  const p = plan(state), tasks: Task[] = state.project.tasks;
  const levels = new Map<string, number>();
  function level(id: string, visiting = new Set<string>()): number {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = tasks.find(t => t.id === id);
    const n = task?.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(d => level(d.taskId, new Set(visiting)))) : 0;
    levels.set(id, n); return n;
  }
  for (const t of tasks) level(t.id);

  const categories = [...new Set(tasks.map(t => t.category))];
  const categoryOrder = new Map(categories.map((c, i) => [c, i]));
  const categoryColor = new Map(categories.map((c, i) => [c, CATEGORY_COLORS[i % CATEGORY_COLORS.length]]));

  // 按阶段分行；行内先按类别分组，让同类别任务挨在一起。
  const byLevel = new Map<number, Task[]>();
  for (const t of tasks) {
    const bucket = byLevel.get(level(t.id));
    if (bucket) bucket.push(t); else byLevel.set(level(t.id), [t]);
  }
  const rowLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  let contentWidth = 0;
  const rowTop = (row: number) => TOP + row * (NODE_H + ROW_GAP);
  rowLevels.forEach((value, row) => {
    const rowTasks = byLevel.get(value)!.sort((a, b) =>
      (categoryOrder.get(a.category)! - categoryOrder.get(b.category)!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let x = PAD, previous = "";
    for (const t of rowTasks) {
      if (previous && previous !== t.category) x += GROUP_GAP;
      positions.set(t.id, { x, y: rowTop(row) });
      x += NODE_W + GAP_X;
      previous = t.category;
    }
    contentWidth = Math.max(contentWidth, x - GAP_X + PAD);
  });
  const width = Math.max(1000, contentWidth);
  const height = Math.max(420, rowLevels.length ? rowTop(rowLevels.length - 1) + NODE_H + 52 : 420);

  const segmentFor = new Map(p.segments.flatMap((s, i) => s.tasks.map(id => [id, i + 1] as const)));
  function tone(id: string): string {
    const progress = state.progress[id], run = [...state.runs].reverse().find(r => r.taskId === id);
    if (progress.status === "running") return run?.phase === "unknown" ? "unknown" : "running";
    if (progress.status !== "pending") return progress.status;
    const reasons = p.blocked[id] ?? [];
    return reasons.some(r => r.includes("授权") || r.includes("资源")) ? "blocked" : "pending";
  }
  function status(id: string): string {
    const progress = state.progress[id], run = [...state.runs].reverse().find(r => r.taskId === id);
    if (progress.status === "running" && run) return labels[run.phase];
    if (progress.status !== "pending") return labels[progress.status];
    const reasons = p.blocked[id] ?? [];
    return reasons.some(r => r.includes("授权")) ? "等待授权" : reasons.some(r => r.includes("资源")) ? "资源等待"
      : reasons.some(r => r.startsWith("等待")) ? "等待前置" : state.paused ? "调度已暂停" : p.ready.includes(id) ? "可领取" : "待分配";
  }
  const details = Object.fromEntries(tasks.map(t => {
    const progress = state.progress[t.id], run = [...state.runs].reverse().find(r => r.taskId === t.id);
    const checkpoint = p.segments.flatMap(s => s.checkpoints).filter(c => c.taskId === t.id);
    const reasons = (p.blocked[t.id] ?? []).filter(r => !r.startsWith("状态："));
    const next = progress.status === "completed" ? "本任务已完成" : progress.status === "review" ? "等待指定验收"
      : progress.status === "failed" ? "查看失败原因后安排重试" : run?.phase === "unknown" ? "确认执行情况后对账"
      : progress.status === "running" ? "等待执行者提交结果或中间产物" : reasons.join("；") || (p.ready.includes(t.id) ? "已就绪，等待调配" : "等待分配执行者");
    return [t.id, [
      `${t.id} · ${t.title}`, `类别：${t.category}`, `状态：${status(t.id)}`,
      ...(t.specFile ? [`任务卡：${t.specFile}`] : []),
      `执行者：${run?.agentId ?? t.owner ?? p.segments.find(s => s.tasks.includes(t.id))?.agentId ?? "待分配"}`,
      `前置：${t.dependsOn.map(d => d.taskId + (d.output ? "/" + d.output : "")).join("、") || "无"}`,
      `资源：${t.resources.map(r => r.path + (r.mode === "read" ? "（读取）" : "（写入）")).join("、") || "未声明"}`,
      ...(checkpoint.length ? [`中间交付：${checkpoint.map(c => `${c.taskId}${c.output ? "/" + c.output : " 完成"} → ${c.consumers.join("、")}`).join("；")}`] : []),
      `下一步：${next}`, `结果：${progress.summary ?? "尚未提交"}`,
      `产物：${Object.entries(progress.outputs).map(([name, o]) => `${name}：${o.reference}（${o.accepted ? "已接受" : "待验收"}）`).join("；") || "无"}`
    ].join("\n\n")];
  }));

  // 边：父任务底部中心 → 子任务顶部中心，竖向走线。
  const edges = tasks.flatMap(t => t.dependsOn.map((d, k) => {
    const a = positions.get(d.taskId), b = positions.get(t.id);
    if (!a || !b) return "";
    const sx = a.x + NODE_W / 2, sy = a.y + NODE_H, ex = b.x + NODE_W / 2, ey = b.y;
    const label = d.output
      ? `<text class="edge-label" x="${ex + 9}" y="${ey - 11 - k * 14}">${escape(short(d.output, 10))}</text>` : "";
    return `<path class="edge" d="${connector(sx, sy, ex, ey)}" marker-end="url(#arrow)"><title>${escape(d.taskId)} → ${escape(t.id)}${d.output ? "/" + escape(d.output) : ""}</title></path>${label}`;
  })).join("");

  const stages = rowLevels.map((_, row) => {
    const top = rowTop(row);
    return `<g class="stage"><line class="stage-rule" x1="108" y1="${top - 32}" x2="${width - PAD}" y2="${top - 32}"/>`
      + `<rect class="stage-pill" x="${PAD}" y="${top - 44}" width="68" height="24" rx="12"/>`
      + `<text class="stage-label" x="${PAD + 34}" y="${top - 27}" text-anchor="middle">阶段 ${row + 1}</text></g>`;
  }).join("");

  const nodes = tasks.map(t => {
    const pos = positions.get(t.id)!;
    const run = [...state.runs].reverse().find(r => r.taskId === t.id);
    const executor = run?.agentId ?? t.owner ?? p.segments.find(s => s.tasks.includes(t.id))?.agentId ?? "待分配";
    const display = status(t.id), segment = segmentFor.get(t.id);
    const toneDef = TONES[tone(t.id)] ?? TONES.pending;
    const pillW = Math.round(textWidth(display) + 22), pillX = NODE_W - 14 - pillW;
    const titleLines = wrap(t.title, 17, 2), titleY = titleLines.length > 1 ? [57, 78] : [66];
    return `<g class="node" data-id="${escape(t.id)}" data-category="${escape(t.category)}" tabindex="0" role="button" aria-label="${escape(t.id + " " + t.title + "，" + display)}" transform="translate(${pos.x},${pos.y})">
      <title>${escape(t.title)} · ${escape(executor)}</title>
      <rect class="card" width="${NODE_W}" height="${NODE_H}" rx="14"/>
      <rect class="accent" x="1" y="20" width="4" height="${NODE_H - 40}" rx="2" fill="${toneDef.accent}"/>
      <text class="node-id" x="18" y="25">${escape(short(`${t.id}${segment ? ` · 建议段 ${segment}` : ""}`, 26))}</text>
      <rect x="${pillX}" y="12" width="${pillW}" height="23" rx="11.5" fill="${toneDef.accent}" fill-opacity=".16" stroke="${toneDef.accent}" stroke-opacity=".5"/>
      <text class="status-text" x="${pillX + pillW / 2}" y="28" text-anchor="middle" fill="${toneDef.text}">${escape(display)}</text>
      ${titleLines.map((line, i) => `<text class="node-title" x="18" y="${titleY[i]}">${escape(line)}</text>`).join("")}
      <circle class="cat-dot" cx="23" cy="93" r="3.6" fill="${categoryColor.get(t.category) ?? CATEGORY_COLORS[0]}"/>
      <text class="cat-name" x="33" y="97">${escape(short(t.category, 8))}</text>
      <text class="node-meta" x="${NODE_W - 16}" y="97" text-anchor="end">${escape(short(executor, 14))}</text>
    </g>`;
  }).join("");

  const done = tasks.filter(t => state.progress[t.id].status === "completed").length;
  const running = tasks.filter(t => state.progress[t.id].status === "running").length;
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const statusLegend = [["#64748b", "待执行"], ["#5f9fd8", "就绪"], ["#38bdf8", "执行中／待回执"], ["#f5b942", "待验收"], ["#34d399", "已完成"], ["#a78bfa", "阻塞"], ["#fb7185", "失败"]]
    .map(([color, label]) => `<span class="item"><i class="dot" style="background:${color}"></i>${label}</span>`).join("");
  const categoryLegend = categories
    .map(c => `<span class="item"><i class="dot" style="background:${categoryColor.get(c)}"></i>${escape(c)}</span>`).join("");
  const interval = options.refreshIntervalMs;
  const refresh = options.refreshUrl ? { url: options.refreshUrl, interval: Number.isFinite(interval) ? Math.max(500, interval!) : 2000 } : null;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(state.project.name)}</title><style>
:root{color-scheme:dark;--bg:#0a111d;--line:#1f2f45;--text:#e8f0fa;--muted:#93a7c1}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font:15px/1.6 "Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;
background:radial-gradient(1100px 520px at 6% -14%,rgba(38,84,138,.5),transparent 62%),radial-gradient(900px 460px at 106% 2%,rgba(70,54,124,.42),transparent 60%),var(--bg);-webkit-font-smoothing:antialiased}
h1{margin:0;font-size:26px;font-weight:650;letter-spacing:.4px}h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.3px}
header{padding:26px 30px 16px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(16,27,44,.74),rgba(10,17,29,.08))}
.hero{display:flex;gap:26px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}.hero-main{min-width:0}
.sub{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.chip{display:inline-flex;align-items:center;padding:4px 11px;border-radius:999px;border:1px solid var(--line);background:rgba(20,32,51,.72);color:var(--muted);font-size:12.5px;white-space:nowrap}
.chip.ok{color:#7ee2b8;border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.1)}.chip.warn{color:#f7c56b;border-color:rgba(245,185,66,.35);background:rgba(245,185,66,.1)}
.progress{width:110px;height:6px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;margin-left:4px}
.progress span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#34d399,#5ee7b5)}
.legend{display:flex;flex-wrap:wrap;gap:7px 14px;justify-content:flex-end;max-width:560px;font-size:12.5px;color:var(--muted);padding-top:6px}
.legend .item{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.legend-label{color:#617792;font-size:11.5px;letter-spacing:.5px;align-self:center}
.dot{width:8px;height:8px;border-radius:50%;box-shadow:0 0 0 3px rgba(255,255,255,.05)}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px}
.search{position:relative;flex:1 1 300px;max-width:430px;display:flex;align-items:center}
.search svg{position:absolute;left:12px;width:15px;height:15px;color:#7b91ac;pointer-events:none}
input{width:100%;padding:10px 12px 10px 35px;border-radius:10px;border:1px solid var(--line);background:rgba(12,21,35,.92);color:var(--text);font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:#6d829d}input:focus{border-color:#3f78b8;box-shadow:0 0 0 3px rgba(89,168,255,.16)}
button{display:inline-flex;align-items:center;justify-content:center;min-width:40px;padding:9px 14px;border-radius:10px;border:1px solid var(--line);background:rgba(22,35,56,.92);color:#d7e5f7;font:inherit;font-size:14px;cursor:pointer;transition:border-color .15s,background .15s,transform .06s}
button:hover{border-color:#3b5b80;background:rgba(31,48,75,.95)}button:active{transform:translateY(1px)}button:disabled{opacity:.55;cursor:wait}
button.primary{background:linear-gradient(180deg,#3183db,#2568b4);border-color:#3f8de0;color:#fff}button.primary:hover{background:linear-gradient(180deg,#3c90e6,#2a72c0)}
.zoom{display:flex;gap:6px}#refresh-status{font-size:12.5px;color:var(--muted);margin-left:auto}.error{color:#ff9aa6}
main{display:grid;grid-template-columns:minmax(0,1fr) 340px;align-items:stretch}
#canvas{overflow:auto;min-height:480px;padding:6px 0 20px}
#canvas svg{display:block}aside{border-left:1px solid var(--line);background:linear-gradient(180deg,rgba(16,27,44,.9),rgba(10,17,29,.55));padding:22px 24px}
.aside-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid var(--line)}
.aside-head b{font-size:15px;letter-spacing:.3px}.aside-head span{font-size:12px;color:#6f86a1}
#detail{margin:0;font-family:inherit;font-size:13.5px;line-height:1.95;color:#c6d6e9;white-space:pre-wrap;overflow-wrap:anywhere}
svg text{fill:#dbe7f6;font-family:inherit}
.node{cursor:pointer}.node .card{fill:url(#card);stroke:#2a3b53;stroke-width:1;transition:stroke .15s}
.node:hover .card{stroke:#5f8fc4}.node:focus{outline:none}.node:focus-visible .card{stroke:#9cc8f8;stroke-width:1.6}
.node.selected .card{stroke:#a8d4ff;stroke-width:1.8}.node.dim{opacity:.14}
.node-id{font-size:11px;fill:#8fa6c2;letter-spacing:.3px}.node-title{font-size:14.5px;font-weight:600;fill:#eaf2fc}
.node-meta{font-size:11px;fill:#8aa0bc}.cat-name{font-size:11px;fill:#9fb4cf}.status-text{font-size:11px;font-weight:600}
.edge{fill:none;stroke:#41597a;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.edge-label{font-size:10.5px;fill:#7f97b5;paint-order:stroke;stroke:#0a111d;stroke-width:4px;stroke-linejoin:round}
.stage-rule{stroke:#22344b;stroke-dasharray:2 6;stroke-width:1}.stage-pill{fill:#141f31;stroke:#243550}
.stage-label{font-size:11.5px;fill:#8fa6c2;letter-spacing:.6px}
footer{padding:26px 30px 34px;border-top:1px solid var(--line);background:linear-gradient(180deg,rgba(10,17,29,.18),rgba(13,22,36,.72))}
#segments ul{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(286px,1fr));gap:12px;margin:14px 0 0;padding:0}
#segments li{margin:0;padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:rgba(18,29,47,.85)}
.segment-title{font-size:13px;font-weight:600;color:#cfe3fb;letter-spacing:.3px}
.seg-tasks{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;font-size:12.5px}
.seg-task{padding:2px 8px;border-radius:6px;background:rgba(89,168,255,.13);color:#a8d0f8;font-size:12px}
.seg-arrow{color:#5f7896}.seg-note{margin-top:8px;font-size:12px;color:var(--muted)}
.footnote{margin:18px 0 0;font-size:12px;color:#7189a5}
@media(max-width:900px){main{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid var(--line)}header,footer{padding:20px}}
</style></head><body><header>
<div class="hero"><div class="hero-main"><h1>${escape(state.project.name)}</h1>
<div class="sub" id="overview" data-scheduler-revision="${state.revision}">
<span class="chip">${refresh ? "只读实时视图" : "只读快照"}</span><span class="chip">revision ${state.revision}</span>
<span class="chip ${state.paused ? "warn" : "ok"}">${state.paused ? "已暂停" : "可调度"}</span>
<span class="chip">${tasks.length} 个任务</span><span class="chip">${p.ready.length} 个就绪</span><span class="chip">${running} 个进行中</span><span class="chip">${done} 个完成</span>
<span class="progress" role="img" aria-label="完成 ${percent}%"><span style="width:${percent}%"></span></span></div></div>
<div class="legend"><span class="legend-label">状态</span>${statusLegend}${categories.length ? '<span class="legend-label">类别</span>' + categoryLegend : ""}</div></div>
<div class="toolbar"><label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="search" type="search" aria-label="搜索任务、类别或执行者" placeholder="搜索任务、类别或执行者"></label>
<div class="zoom"><button id="minus" aria-label="缩小流程图">−</button><button id="plus" aria-label="放大流程图">＋</button></div>
${refresh ? '<button id="refresh" class="primary">刷新状态</button>' : ""}<span id="refresh-status" role="status">${refresh ? "等待首次更新；刷新只读取状态。" : "静态快照；重新导出后刷新浏览器查看。"}</span></div>
</header>
<main><div id="canvas"><svg id="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2739"/><stop offset="1" stop-color="#151f2e"/></linearGradient>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="#1e2c3f"/></pattern>
<marker id="arrow" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1,1 L9,5.5 L1,10" fill="none" stroke="#6d87a5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<rect width="${width}" height="${height}" fill="url(#dots)"/>
${stages}${edges}${nodes}
${nodes ? "" : '<text class="node-title" x="32" y="60">尚无任务</text>'}</svg></div>
<aside><div class="aside-head"><b>任务详情</b><span>点击节点</span></div><pre id="detail">选择一个节点查看前置、占用和结果。</pre></aside></main>
<footer><section id="segments"><h2>当前建议执行段</h2><p class="footnote" style="margin:4px 0 0">后续任务尚未启动</p><ul>${p.segments.map((s, i) => `<li><div class="segment-title">段 ${i + 1} · ${escape(s.agentId)}</div><div class="seg-tasks">${s.tasks.map((id, k) => (k ? '<span class="seg-arrow">→</span>' : "") + `<span class="seg-task">${escape(id)}</span>`).join("")}</div><div class="seg-note">停止：${escape(s.stop)}</div>${s.checkpoints.length ? `<div class="seg-note">中间交付：${s.checkpoints.map(c => `${escape(c.taskId)}${c.output ? "/" + escape(c.output) : " 完成"} → ${c.consumers.map(escape).join("、")}`).join("；")}</div>` : ""}</li>`).join("") || "<li><div class=\"segment-title\">暂无执行段</div></li>"}</ul></section>
<section id="diagnostics">${p.diagnostics.map(d => `<p class="error">${escape(d)}</p>`).join("")}</section><p class="footnote">流程图从调度状态派生。建议段中的任务须依次满足前置；本页只能查看。</p></footer>
<script id="scheduler-data" type="application/json">${json({ revision: state.revision, details })}</script>
<script>
const refreshConfig=${json(refresh)};
let snapshot=JSON.parse(document.getElementById('scheduler-data').textContent);
let graph=document.getElementById('graph'),zoom=1,selected=null,refreshing=false,lastSuccess=null;
const canvas=document.getElementById('canvas'),search=document.getElementById('search'),detail=document.getElementById('detail'),refreshStatus=document.getElementById('refresh-status');
function applyInteraction(){
  const query=search.value.toLocaleLowerCase().trim();
  graph.querySelectorAll('.node').forEach(n=>{n.classList.toggle('dim',!snapshot.details[n.dataset.id].toLocaleLowerCase().includes(query));n.classList.toggle('selected',n.dataset.id===selected)});
  detail.textContent=selected&&snapshot.details[selected]||'选择一个节点查看前置、占用和结果。';
  const box=graph.getAttribute('viewBox').split(' ').map(Number);graph.setAttribute('width',box[2]*zoom);graph.setAttribute('height',box[3]*zoom);
}
function select(event){const n=event.target.closest('.node');if(n&&graph.contains(n)){selected=n.dataset.id;applyInteraction()}}
canvas.addEventListener('click',select);canvas.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){if(e.target.closest('.node')){e.preventDefault();select(e)}}});
search.addEventListener('input',applyInteraction);
function scale(v){zoom=Math.max(.3,Math.min(3,zoom*v));applyInteraction()}
document.getElementById('plus').onclick=()=>scale(1.2);document.getElementById('minus').onclick=()=>scale(1/1.2);
zoom=Math.max(.3,Math.min(1,canvas.clientWidth/Number(graph.getAttribute('viewBox').split(' ')[2])));applyInteraction();
function updateStatus(message,error=false){refreshStatus.textContent=message;refreshStatus.classList.toggle('error',error)}
function successLabel(){return lastSuccess?'上次成功：'+lastSuccess:'尚未成功更新'}
// 宿主可直接传入新的派生HTML，不必通过HTTP，也不会执行其中的脚本。
function applySnapshotHtml(html){
  const doc=new DOMParser().parseFromString(html,'text/html'),dataElement=doc.getElementById('scheduler-data');
  const incoming=dataElement&&JSON.parse(dataElement.textContent);
  if(!incoming||!Number.isInteger(incoming.revision)||!incoming.details||typeof incoming.details!=='object'||Array.isArray(incoming.details)||Object.values(incoming.details).some(v=>typeof v!=='string'))throw new Error('返回内容不是有效流程图');
  const ids=['graph','overview','segments','diagnostics'];
  if(ids.some(id=>!doc.getElementById(id))||doc.getElementById('overview').dataset.schedulerRevision!==String(incoming.revision))throw new Error('返回内容缺少流程图');
  const nextGraph=doc.getElementById('graph'),viewBox=nextGraph.getAttribute('viewBox');
  if(!viewBox||viewBox.split(' ').length!==4||viewBox.split(' ').some(v=>!Number.isFinite(Number(v)))||[...nextGraph.querySelectorAll('.node')].some(n=>!(n.dataset.id in incoming.details)))throw new Error('返回内容缺少任务详情');
  if(incoming.revision<snapshot.revision){updateStatus('已忽略旧版本；'+successLabel(),true);return {applied:false,revision:snapshot.revision}}
  const changed=incoming.revision>snapshot.revision;
  if(changed){
    const left=canvas.scrollLeft,top=canvas.scrollTop;
    for(const id of ids){const replacement=document.importNode(doc.getElementById(id),true);document.getElementById(id).replaceWith(replacement)}
    snapshot=incoming;graph=document.getElementById('graph');if(selected&&!snapshot.details[selected])selected=null;
    applyInteraction();canvas.scrollLeft=left;canvas.scrollTop=top;
  }
  lastSuccess=new Date().toLocaleTimeString('zh-CN');updateStatus('已更新至 revision '+snapshot.revision+' · '+successLabel());
  return {applied:changed,revision:snapshot.revision};
}
window.schedulerApplyHtml=function(html){
  try{return applySnapshotHtml(html)}catch(error){updateStatus('更新失败，保留当前视图 · '+successLabel()+' · '+error.message,true);throw error}
};
async function refreshGraph(){
  if(!refreshConfig||refreshing)return;refreshing=true;const button=document.getElementById('refresh');button.disabled=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const url=new URL(refreshConfig.url,location.href);
    if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol))throw new Error('刷新地址必须是同源网页');
    const response=await fetch(url,{method:'GET',cache:'no-store',signal:controller.signal});
    if(!response.ok)throw new Error('读取失败（'+response.status+'）');
    window.schedulerApplyHtml(await response.text());
  }catch(error){updateStatus('更新失败，保留当前视图 · '+successLabel()+' · '+(error.name==='AbortError'?'读取超时':error.message),true)}
  finally{clearTimeout(timeout);refreshing=false;button.disabled=false}
}
if(refreshConfig){document.getElementById('refresh').onclick=refreshGraph;setInterval(()=>{if(!document.hidden)refreshGraph()},refreshConfig.interval);refreshGraph()}
</script></body></html>`;
}
