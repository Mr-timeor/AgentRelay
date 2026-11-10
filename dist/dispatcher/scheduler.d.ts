import { FileStore } from "../store/file-store.js";
import { type ArtifactReference, type Run, type State, type Task, type Segment, type TestReport } from "../core/model.js";
export type Receipt = Pick<Run, "dispatchId" | "attemptId" | "permitId">;
export interface DeliveryDependency {
    taskId: string;
    output?: string;
    reference?: ArtifactReference;
    outputs?: Record<string, ArtifactReference>;
    summary?: string;
}
export interface Delivery extends Run {
    taskId: string;
    agentId: string;
    title: string;
    task: Task;
    specFile?: string;
    acceptedOutputs?: Record<string, ArtifactReference>;
    dependencies: DeliveryDependency[];
    segment: string[];
    checkpoints: unknown[];
    stop: string;
    instructions: string;
    rework?: NonNullable<Run["rework"]> & {
        previousAttemptId: string;
    };
}
export type Transport = (delivery: Delivery) => Promise<void>;
export declare class Scheduler {
    readonly store: FileStore;
    readonly receiptTimeoutMs: number;
    readonly workspace: string;
    constructor(store: FileStore, receiptTimeoutMs?: number, workspace?: string);
    snapshot(): State;
    plan(agentId?: string): {
        diagnostics: string[];
        ready: string[];
        segments: Segment[];
        blocked: Record<string, string[]>;
    };
    delivery(run: Run): Delivery;
    dispatch(agentId: string, send: Transport): Promise<Delivery>;
    acknowledge(agentId: string, ids: Receipt): Promise<void>;
    expire(now?: number): Promise<void>;
    report(agentId: string, ids: Receipt, report: {
        status: "completed" | "blocked" | "failed" | "checkpoint";
        summary: string;
        outputs?: Record<string, ArtifactReference>;
        files?: Record<string, ArtifactReference>;
        tests?: TestReport[];
    }): Promise<void>;
    accept(taskId: string, output?: string): Promise<void>;
    rework(taskId: string, feedback: string): Promise<void>;
    control(action: "pause" | "resume" | "approve" | "retry" | "resolve-stopped", taskId?: string): Promise<void>;
    addTasks(tasks: unknown[]): Promise<void>;
    updateTask(taskId: string, changes: unknown): Promise<void>;
}
