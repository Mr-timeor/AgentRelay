export type Status = "pending" | "running" | "review" | "completed" | "blocked" | "failed";
export type ArtifactReference = string | string[];
export interface FileEvidence {
    path: string;
    size: number;
    sha256: string;
}
export interface TestReport {
    command: string;
    exitCode: number;
    stdout?: string;
    stderr?: string;
}
export interface TestEvidence extends TestReport {
    source: "reported";
}
export interface Dependency {
    taskId: string;
    output?: string;
}
export interface Resource {
    path: string;
    mode: "read" | "write";
}
export interface Task {
    id: string;
    title: string;
    category: string;
    dependsOn: Dependency[];
    resources: Resource[];
    outputs: string[];
    priority: number;
    review: boolean;
    approval: boolean;
    owner?: string;
    specFile?: string;
}
export interface Agent {
    id: string;
    categories: string[];
}
export interface Project {
    name: string;
    tasks: Task[];
    agents: Agent[];
    maxSegment: number;
}
export interface Run {
    taskId: string;
    agentId: string;
    dispatchId: string;
    attemptId: string;
    permitId: string;
    phase: "awaiting" | "active" | "unknown" | "finished";
    startedAt: number;
    summary?: string;
    outputs?: Progress["outputs"];
    tests?: TestEvidence[];
    rework?: {
        feedback: string;
        outputs: Progress["outputs"];
    };
}
export interface Progress {
    status: Status;
    approved: boolean;
    outputs: Record<string, {
        accepted: boolean;
        reference: ArtifactReference;
        files?: FileEvidence[];
    }>;
    summary?: string;
}
export interface State {
    version: 1;
    revision: number;
    project: Project;
    paused: boolean;
    progress: Record<string, Progress>;
    runs: Run[];
    history: {
        at: string;
        action: string;
        taskId?: string;
        detail?: string;
    }[];
}
export interface Segment {
    agentId: string;
    tasks: string[];
    checkpoints: {
        taskId: string;
        output?: string;
        consumers: string[];
    }[];
    stop: string;
}
export declare function normalize(input: any): Project;
export declare function initial(project: Project): State;
