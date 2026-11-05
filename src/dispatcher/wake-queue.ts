interface Batch<Input, Result> {
  input: Input;
  promise: Promise<Result>;
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
}

// 一轮执行中仅保留一轮补跑；补跑采用这一批最后一次触发的参数。
export class WakeQueue<Input, Result> {
  private running?: Batch<Input, Result>;
  private pending?: Batch<Input, Result>;

  constructor(private readonly run: (input: Input) => Result | PromiseLike<Result>) {}

  request(input: Input): Promise<Result> {
    if (!this.running) {
      const batch = this.batch(input);
      this.start(batch);
      return batch.promise;
    }
    if (!this.pending) this.pending = this.batch(input);
    else this.pending.input = input;
    return this.pending.promise;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running.promise.catch(() => {});
  }

  private batch(input: Input): Batch<Input, Result> {
    let resolve!: Batch<Input, Result>["resolve"], reject!: Batch<Input, Result>["reject"];
    const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
    // 触发方可以只登记工作；仍向等待该批的调用者保留原始失败。
    void promise.catch(() => {});
    return { input, promise, resolve, reject };
  }

  private start(batch: Batch<Input, Result>): void {
    this.running = batch;
    void this.execute(batch);
  }

  private async execute(batch: Batch<Input, Result>): Promise<void> {
    try { batch.resolve(await this.run(batch.input)); }
    catch (error) { batch.reject(error); }
    finally {
      const next = this.pending;
      this.pending = undefined;
      this.running = undefined;
      if (next) this.start(next);
    }
  }
}
