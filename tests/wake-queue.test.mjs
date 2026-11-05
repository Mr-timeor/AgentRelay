import test from "node:test";
import assert from "node:assert/strict";
import { WakeQueue } from "../dist/dispatcher/wake-queue.js";

function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("唤醒合并器首轮立即执行，突发请求共用一轮补跑及其结果", async () => {
  const firstGate = gate(), nextGate = gate(), inputs = [];
  const queue = new WakeQueue(input => { inputs.push(input); return inputs.length === 1 ? firstGate.promise : nextGate.promise; });
  const first = queue.request("first");
  assert.deepEqual(inputs, ["first"]);
  const second = queue.request("second"), third = queue.request("third"), fourth = queue.request("fourth");
  assert.equal(second, third);
  assert.equal(second, fourth);
  assert.notEqual(first, second);
  firstGate.resolve({ dispatched: ["first"] });
  assert.deepEqual(await first, { dispatched: ["first"] });
  assert.deepEqual(inputs, ["first", "fourth"]);
  nextGate.resolve({ dispatched: ["fourth"] });
  assert.deepEqual(await second, { dispatched: ["fourth"] });
  assert.equal(await second, await third);
  await queue.idle();
  assert.equal(inputs.length, 2);
});

test("补跑中收到新请求再合并一次，idle等待后续批次完成", async () => {
  const gates = [gate(), gate(), gate()], inputs = [];
  const queue = new WakeQueue(input => { inputs.push(input); return gates[inputs.length - 1].promise; });
  const first = queue.request(1), second = queue.request(2);
  gates[0].resolve("one");
  assert.equal(await first, "one");
  const third = queue.request(3), fourth = queue.request(4);
  assert.equal(third, fourth);
  assert.notEqual(second, third);
  let idle = false;
  const finished = queue.idle().then(() => { idle = true; });
  gates[1].resolve("two");
  assert.equal(await second, "two");
  assert.deepEqual(inputs, [1, 2, 4]);
  assert.equal(idle, false);
  gates[2].resolve("four");
  assert.equal(await third, "four");
  await finished;
  assert.equal(idle, true);
});

test("补跑使用最新触发上下文，不复用已取消的旧signal", async () => {
  const firstGate = gate(), old = new AbortController(), latest = new AbortController(), signals = [];
  const queue = new WakeQueue(({ signal }) => {
    signals.push(signal);
    return signals.length === 1 ? firstGate.promise : signal.aborted;
  });
  const first = queue.request({ signal: new AbortController().signal });
  const oldRequest = queue.request({ signal: old.signal });
  old.abort();
  const latestRequest = queue.request({ signal: latest.signal });
  assert.equal(oldRequest, latestRequest);
  firstGate.resolve(false);
  await first;
  assert.equal(await latestRequest, false);
  assert.equal(signals[1], latest.signal);
  await queue.idle();
});

test("首轮失败仍执行已提出的补跑，失败不自动产生重试", async () => {
  const firstGate = gate(), inputs = [];
  const queue = new WakeQueue(input => {
    inputs.push(input);
    return inputs.length === 1 ? firstGate.promise : "next-result";
  });
  const first = queue.request("first"), next = queue.request("next");
  firstGate.reject(new Error("send failed"));
  await assert.rejects(first, /send failed/);
  assert.equal(await next, "next-result");
  await queue.idle();
  assert.deepEqual(inputs, ["first", "next"]);
});

test("执行函数内的重入请求和完成回调的新请求均不丢失", async () => {
  const inputs = [];
  let queue, reentered;
  queue = new WakeQueue(input => {
    inputs.push(input);
    if (input === 1) reentered = queue.request(2);
    return input;
  });
  const first = queue.request(1);
  const afterFirst = first.then(() => queue.request(3));
  assert.equal(await first, 1);
  assert.equal(await reentered, 2);
  assert.equal(await afterFirst, 3);
  await queue.idle();
  assert.deepEqual(inputs, [1, 2, 3]);
});

test("无人等待的失败不会产生未处理拒绝，idle后可重新触发", async () => {
  const queue = new WakeQueue(input => {
    if (input === "fail") throw new Error("expected failure");
    return input;
  });
  queue.request("fail");
  await queue.idle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await queue.request("next"), "next");
  await queue.idle();
});
