import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { policies, policyNames, scenario, simulate } from "./simulate.js";
export function report(rows) {
    const n = (value) => value === null ? "未完成" : String(Math.round(value * 100) / 100);
    return [
        "# 离线合成评测", "",
        "时间单位为合成分钟。每个场景四种策略使用相同任务、容量、资源、授权、验收、耗时、失败和中间交付事件。空闲/阻塞为所有执行者的时间之和；阻塞是空闲的子集。",
        "",
        "| 场景 | 策略 | 总时长 | 空闲 | 阻塞 | 委托批次 | 逐项领取 | 跨人交接 | 有效任务/产物 | 失败 | 返工 | 违规 |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...rows.flatMap(row => row.results.map(r => `| ${row.scenario.name} | ${policyNames[r.policy]} | ${n(r.makespan)} | ${n(r.idle)} | ${n(r.blocked)} | ${r.dispatches} | ${r.claims} | ${r.handoffs} | ${r.deliveries}/${r.outputDeliveries} | ${r.failures} | ${n(r.rework)} | ${r.violations.length} |`)),
        "", "开销假设：",
        ...rows.map(row => `- ${row.scenario.name}：新委托 ${row.scenario.dispatchOverhead}，连续领取 ${row.scenario.continuationOverhead}，段长上限 ${row.scenario.project.maxSegment}。`),
        "", "逐项领取不会因融合而消失；委托批次是模拟的说明/唤醒开销单位，不等于真实宿主消息或模型请求数。失败与返工完整保留，产物在约定验收事件发生后才解锁。",
        "", "这些结果只说明给定合成条件下的差异，不证明真实开发更快、Token更少或上下文压缩更少。未完成结果不参与速度比较。", ""
    ].join("\n");
}
export async function main(args = process.argv.slice(2)) {
    const json = args.includes("--json"), zero = args.includes("--zero-overhead");
    const folder = resolve(args.find(arg => !arg.startsWith("--")) ?? "fixtures/benchmarks");
    const files = (await readdir(folder)).filter(file => file.endsWith(".json")).sort();
    if (!files.length)
        throw new Error("没有找到评测场景");
    const rows = [];
    for (const file of files) {
        const spec = scenario(JSON.parse(await readFile(resolve(folder, file), "utf8")));
        if (zero) {
            spec.dispatchOverhead = 0;
            spec.continuationOverhead = 0;
        }
        rows.push({ scenario: spec, results: policies.map(policy => simulate(spec, policy)) });
    }
    console.log(json ? JSON.stringify(rows, null, 2) : report(rows));
    if (rows.some(row => row.results.some(result => !result.completed || result.violations.length)))
        process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
