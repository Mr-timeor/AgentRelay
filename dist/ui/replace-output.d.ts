export declare function replaceOutput(source: string, target: string, operations?: {
    rename: (source: string, target: string) => Promise<void>;
    sleep: (milliseconds: number) => Promise<unknown>;
}): Promise<void>;
