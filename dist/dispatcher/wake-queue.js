// 一轮执行中仅保留一轮补跑；补跑采用这一批最后一次触发的参数。
export class WakeQueue {
    run;
    running;
    pending;
    constructor(run) {
        this.run = run;
    }
    request(input) {
        if (!this.running) {
            const batch = this.batch(input);
            this.start(batch);
            return batch.promise;
        }
        if (!this.pending)
            this.pending = this.batch(input);
        else
            this.pending.input = input;
        return this.pending.promise;
    }
    async idle() {
        while (this.running)
            await this.running.promise.catch(() => { });
    }
    batch(input) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // 触发方可以只登记工作；仍向等待该批的调用者保留原始失败。
        void promise.catch(() => { });
        return { input, promise, resolve, reject };
    }
    start(batch) {
        this.running = batch;
        void this.execute(batch);
    }
    async execute(batch) {
        try {
            batch.resolve(await this.run(batch.input));
        }
        catch (error) {
            batch.reject(error);
        }
        finally {
            const next = this.pending;
            this.pending = undefined;
            this.running = undefined;
            if (next)
                this.start(next);
        }
    }
}
