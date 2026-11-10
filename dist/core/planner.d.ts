import type { Project, State, Task, Resource, Segment, Dependency } from "./model.js";
export declare function diagnose(project: Project): string[];
export declare function satisfied(state: State, d: Dependency): boolean;
export declare function held(state: State): import("./model.js").Run[];
export declare function resourcePath(value: string): string;
export declare function conflicts(a: Resource[], b: Resource[]): boolean;
export declare function reasons(state: State, t: Task): string[];
export declare function canOwn(state: State, task: Task, agentId: string): boolean;
export declare function segmentFrom(state: State, first: Task, agentId: string, reserved?: Set<string>): Segment;
export declare function plan(state: State): {
    diagnostics: string[];
    ready: string[];
    segments: Segment[];
    blocked: Record<string, string[]>;
};
