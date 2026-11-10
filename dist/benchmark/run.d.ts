import { type Result, type Scenario } from "./simulate.js";
export declare function report(rows: {
    scenario: Scenario;
    results: Result[];
}[]): string;
export declare function main(args?: string[]): Promise<void>;
