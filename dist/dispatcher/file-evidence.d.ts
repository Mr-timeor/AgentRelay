import type { FileEvidence } from "../core/model.js";
/** Explicit local files only; opaque artifact references are never read here. */
export declare function fileEvidence(workspace: string, path: string): Promise<FileEvidence>;
export declare function sameFileEvidence(a: FileEvidence[] | undefined, b: FileEvidence[]): boolean;
export declare function verifyFileEvidence(workspace: string, files?: FileEvidence[]): Promise<void>;
