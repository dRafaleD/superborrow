import { test } from "node:test";
import * as assert from "node:assert/strict";
import { InflightCompletion } from "../src/inflight";

test("identical snapshots share inference while individual cancellations stay isolated", async () => {
  const pending = new InflightCompletion<string>();
  let finish!: (text: string) => void;
  let calls = 0;
  let inference!: AbortSignal;
  const work = (signal: AbortSignal) => { calls++; inference = signal; return new Promise<string>(resolve => { finish = resolve; }); };
  const first = new AbortController();
  const second = new AbortController();
  const a = pending.run("doc:v1:cursor", first.signal, work);
  const rejected = assert.rejects(a, { code: -32800 });
  const b = pending.run("doc:v1:cursor", second.signal, work);
  await Promise.resolve();
  first.abort();
  await rejected;
  assert.equal(inference.aborted, false);
  finish("answer");
  assert.equal(await b, "answer");
  assert.equal(calls, 1);
  assert.equal(pending.shared, 1);
});

test("editor token handoff reuses the same job; abandoned work is eventually aborted", async () => {
  const pending = new InflightCompletion<string>();
  let finish!: (text: string) => void;
  let inference!: AbortSignal;
  const work = (signal: AbortSignal) => { inference = signal; return new Promise<string>(resolve => { finish = resolve; }); };
  const first = new AbortController();
  const a = pending.run("same", first.signal, work);
  const rejected = assert.rejects(a, { code: -32800 });
  await Promise.resolve();
  first.abort();
  await rejected;
  const b = pending.run("same", new AbortController().signal, () => { throw new Error("Must reuse"); });
  finish("kept");
  assert.equal(await b, "kept");
  assert.equal(inference.aborted, false);

  const last = new AbortController();
  const c = pending.run("other", last.signal, work);
  const abandoned = assert.rejects(c, { code: -32800 });
  await Promise.resolve();
  last.abort();
  await abandoned;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(inference.aborted, true);
  finish("ignored");
});

test("new context cancels immediately and late obsolete output cannot escape", async () => {
  const pending = new InflightCompletion<string>();
  let finish!: (text: string) => void;
  let inference!: AbortSignal;
  const a = pending.run("v1", new AbortController().signal, signal => {
    inference = signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const rejected = assert.rejects(a, { code: -32800 });
  await Promise.resolve();
  const b = pending.run("v2", new AbortController().signal, async () => "new");
  assert.equal(inference.aborted, true);
  finish("old");
  await rejected;
  assert.equal(await b, "new");
});

test("errors are shared, cancellation does not start work, and failed jobs can retry", async () => {
  const pending = new InflightCompletion<string>();
  let calls = 0;
  const work = async () => { calls++; throw new Error("Service unavailable"); };
  const signal = new AbortController().signal;
  await Promise.all([
    assert.rejects(pending.run("same", signal, work), /Service unavailable/),
    assert.rejects(pending.run("same", signal, work), /Service unavailable/),
  ]);
  assert.equal(calls, 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(pending.run("other", cancelled.signal, work), { code: -32800 });
  assert.equal(calls, 1);
  assert.equal(await pending.run("same", signal, async () => "recovered"), "recovered");
});
