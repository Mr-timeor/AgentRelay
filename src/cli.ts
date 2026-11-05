#!/usr/bin/env node
import { readFile, writeFile, mkdir, open, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { normalize, initial } from "./core/model.js";
import { diagnose, plan } from "./core/planner.js";
import { renderGraph } from "./ui/graph.js";

function checkGraphOutput(inputFile: string, outputFile: string): void {
  const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (key(inputFile) === key(outputFile)) throw new Error("流程图输出不能覆盖任务或状态文件");
}

async function readJson(path: string, label: string): Promise<any> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error: any) {
    if (error.code === "ENOENT") throw new Error(`${label}未找到：${path}`);
    if (["EACCES", "EPERM"].includes(error.code)) throw new Error(`${label}无法读取，权限不足：${path}`);
    throw new Error(`${label}无法读取：${path}（${error.code ?? error.message}）`);
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error: any) { throw new Error(`${label} JSON 格式错误：${path}（${error.message}）`); }
}

// 只读预检，不打开写者，也不为检查创建目录或文件。
async function checkStatePath(path: string): Promise<boolean> {
  let exists = false;
  try {
    if (!(await stat(path)).isFile()) throw new Error(`状态路径应为文件：${path}`);
    exists = true;
  } catch (error: any) {
    if (error.code === "ENOTDIR") throw new Error(`状态文件的父路径不是目录：${path}`);
    if (["EACCES", "EPERM"].includes(error.code)) throw new Error(`状态存储路径权限不足：${path}`);
    if (error.code !== "ENOENT") throw error;
  }
  if (exists) {
    const state = await readJson(path, "状态文件");
    if (state?.version !== 1 || !state.project || !state.progress || !Array.isArray(state.runs)) {
      throw new Error(`状态文件结构无法识别，请检查文件或 .bak：${path}`);
    }
    try { await access(path, constants.W_OK); }
    catch { throw new Error(`状态文件不可写：${path}`); }
  }
  let parent = dirname(path);
  while (true) {
    try {
      if (!(await stat(parent)).isDirectory()) throw new Error(`状态文件的父路径不是目录：${parent}`);
      await access(parent, constants.W_OK);
      return exists;
    } catch (error: any) {
      if (error.code === "ENOENT" && dirname(parent) !== parent) { parent = dirname(parent); continue; }
      if (["EACCES", "EPERM"].includes(error.code)) throw new Error(`状态存储路径权限不足：${parent}`);
      throw error;
    }
  }
}

const [command = "help", input, output] = process.argv.slice(2);
try {
  if (command === "check") {
    if (!input) throw new Error("用法：check <任务JSON> [状态JSON]");
    const path = resolve(input);
    const project = normalize(await readJson(path, "任务文件"));
    const errors = diagnose(project);
    if (errors.length) throw new Error(errors.join("\n"));
    const statePath = output ? resolve(output) : undefined;
    const exists = statePath ? await checkStatePath(statePath) : undefined;
    console.log(`任务定义有效：${path}（${project.tasks.length} 项任务）`);
    if (statePath) console.log(exists
      ? `状态文件可读取，路径可写：${statePath}（未修改）`
      : `状态路径可用：${statePath}（首次运行时创建，本次未创建）`);
  } else if (command === "plan" || command === "graph" || command === "demo") {
    const path = resolve(input ?? "fixtures/development.json");
    const project = normalize(JSON.parse(await readFile(path, "utf8")));
    const errors = diagnose(project);
    if (errors.length) throw new Error(errors.join("\n"));
    const state = initial(project);
    if (command === "plan") console.log(JSON.stringify(plan(state), null, 2));
    else {
      const out = resolve(output ?? ".scheduler/flow.html");
      checkGraphOutput(path, out);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, renderGraph(state));
      console.log(`流程图：${out}`);
      if (command === "demo") {
        // 演示只生成方案与图，不伪造真实开发结果。
        console.log(JSON.stringify(plan(state), null, 2));
      }
    }
  } else if (command === "init") {
    if (!input || !output) throw new Error("用法：init <任务JSON> <新状态文件>");
    const project = normalize(JSON.parse(await readFile(input, "utf8")));
    const errors = diagnose(project);
    if (errors.length) throw new Error(errors.join("\n"));
    // init 不应悄悄采用或覆盖已有项目。
    await mkdir(dirname(resolve(output)), { recursive: true });
    const handle = await open(output, "wx");
    try { await handle.writeFile(JSON.stringify(initial(project), null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    console.log(`已初始化 ${resolve(output)}`);
  } else if (command === "status" || command === "export") {
    if (!input) throw new Error("需要状态文件");
    // 查询不打开写者，也不改变重启状态。
    const state = JSON.parse(await readFile(input, "utf8"));
    if (command === "status") console.log(JSON.stringify(plan(state), null, 2));
    else {
      const out = resolve(output ?? ".scheduler/flow.html");
      checkGraphOutput(input, out);
      await mkdir(dirname(out), { recursive: true }); await writeFile(out, renderGraph(state)); console.log(out);
    }
  } else console.log("命令：check <任务JSON> [状态JSON] | plan <任务JSON> | graph <任务JSON> [HTML] | demo | init <任务JSON> <状态JSON> | status <状态JSON> | export <状态JSON> [HTML]");
} catch (error) { console.error(String(error)); process.exitCode = 1; }
