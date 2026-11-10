export declare class WakeQueue<Input, Result> {
    private readonly run;
    private running?;
    private pending?;
    constructor(run: (input: Input) => Result | PromiseLike<Result>);
    request(input: Input): Promise<Result>;
    idle(): Promise<void>;
    private batch;
    private start;
    private execute;
}
