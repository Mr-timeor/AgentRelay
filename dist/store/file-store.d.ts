import type { State } from "../core/model.js";
export declare class FileStore {
    readonly path: string;
    private readonly pathKey;
    private tail;
    private closing?;
    private state;
    private lock?;
    private readonly lockToken;
    private static paths;
    private constructor();
    static open(path: string, seed?: State): Promise<FileStore>;
    snapshot(): State;
    change<T>(fn: (draft: State) => T | Promise<T>): Promise<T>;
    private acquireLock;
    private releaseLock;
    private write;
    close(): Promise<void>;
}
