import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { FileEvidence } from "../core/model.js";

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

/** Explicit local files only; opaque artifact references are never read here. */
export async function fileEvidence(workspace: string, path: string): Promise<FileEvidence> {
  if (typeof path !== "string" || !path.trim()) throw new Error("files 需要非空文件路径");
  const portable = path.replaceAll("\\", "/"), root = resolve(workspace);
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(portable)) throw new Error(`文件使用工作区相对路径：${path}`);
  const target = resolve(root, ...portable.split("/"));
  if (!within(root, target)) throw new Error(`文件超出工作区：${path}`);
  let canonicalRoot: string, canonicalFile: string;
  try { [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(target)]); }
  catch { throw new Error(`交付文件不存在或无法读取：${path}`); }
  if (!within(canonicalRoot, canonicalFile)) throw new Error(`文件实际位置超出工作区：${path}`);
  const file = await open(canonicalFile, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`交付路径不是普通文件：${path}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk); size += chunk.length;
    }
    const after = await file.stat();
    if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`采集期间文件发生变化，请完成写入后再提交：${path}`);
    }
    return { path: relative(root, target).replaceAll("\\", "/"), size, sha256: hash.digest("hex") };
  } finally { await file.close(); }
}

export function sameFileEvidence(a: FileEvidence[] | undefined, b: FileEvidence[]): boolean {
  return !!a && a.length === b.length && a.every((file, index) => file.path === b[index].path
    && file.size === b[index].size && file.sha256 === b[index].sha256);
}

export async function verifyFileEvidence(workspace: string, files?: FileEvidence[]): Promise<void> {
  if (files === undefined) return;
  if (!Array.isArray(files) || !files.length || files.some(file => !file || typeof file.path !== "string"
    || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256))) {
    throw new Error("文件证据结构无效，请检查原交付记录");
  }
  const current = await Promise.all(files.map(file => fileEvidence(workspace, file.path)));
  if (!sameFileEvidence(files, current)) throw new Error("交付文件内容已变化，未通过本次验收；请重新提交未接受的交付或新增修订任务");
}
