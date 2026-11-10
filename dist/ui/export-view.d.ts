import { replaceOutput } from "./replace-output.js";
export interface ViewExportOptions {
    stateFile: string;
    graphFile: string;
    projectFile?: string;
    onError?: (error: unknown) => void;
}
export declare function startViewExport(options: ViewExportOptions, replace?: typeof replaceOutput): Promise<{
    graphFile: string;
    refresh: () => Promise<{
        revision: number;
        graphFile: string;
    } | undefined>;
    close(): Promise<void>;
}>;
