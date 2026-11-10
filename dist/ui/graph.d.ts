import type { State } from "../core/model.js";
export interface GraphOptions {
    refreshUrl?: string;
    refreshIntervalMs?: number;
}
export declare function renderGraph(state: State, options?: GraphOptions): string;
