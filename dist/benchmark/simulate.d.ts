import { type Project } from "../core/model.js";
export declare const policies: readonly ["segments", "per-task", "category", "topological"];
export type Policy = typeof policies[number];
export declare const policyNames: Record<Policy, string>;
export interface Timing {
    duration: number;
    failedAttempts?: number[];
    retryDelay?: number;
    approvalAt?: number;
    reviewDelay?: number;
    checkpoints?: Record<string, number>;
}
export interface Scenario {
    name: string;
    description?: string;
    project: Project;
    timing: Record<string, Timing>;
    dispatchOverhead: number;
    continuationOverhead: number;
}
export interface Trace {
    at: number;
    event: "start" | "checkpoint" | "accept-output" | "completed" | "failed" | "retry" | "approve" | "accept-task";
    taskId: string;
    agentId?: string;
    attempt?: number;
    batch?: number;
    output?: string;
}
export interface Result {
    policy: Policy;
    completed: boolean;
    makespan: number | null;
    elapsed: number;
    work: number;
    overhead: number;
    idle: number;
    blocked: number;
    dispatches: number;
    claims: number;
    handoffs: number;
    deliveries: number;
    outputDeliveries: number;
    failures: number;
    rework: number;
    violations: string[];
    unfinished: string[];
    trace: Trace[];
}
export declare function scenario(input: any): Scenario;
export declare function simulate(input: Scenario, policy: Policy): Result;
export declare function auditTrace(spec: Scenario, trace: Trace[]): string[];
