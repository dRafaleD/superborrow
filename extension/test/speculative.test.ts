import { test } from "node:test";
import * as assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { SpeculativeCompletion, TypingSnapshot, Prediction } from "../src/speculative";
import { withDeadline } from "../src/generation";

const origin = (): TypingSnapshot => ({ uri: "a", version: 1, languageId: "python", text: "return ;\n", offset: 7 });
function type(manager: SpeculativeCompletion<string>, previous: TypingSnapshot, text: string): TypingSnapshot {
  const next = { ...previous, version: previous.version + 1, text: previous.text.slice(0, previous.offset) + text + previous.text.slice(previous.offset), offset: previous.offset + text.length };
  assert.equal(manager.advance(next, [{ rangeOffset: previous.offset, rangeLength: 0, text }]), true);
  return next;
}
function fixture() {
  const manager = new SpeculativeCompletion<string>();
  const calls: Array<{ origin: TypingSnapshot; signal: AbortSignal; finish(value: Prediction<string>): void; fail(error: unknown): void }> = [];
  const work = (origin: TypingSnapshot, signal: AbortSignal) => new Promise<Prediction<string>>((finish, fail) => { calls.push({ origin, signal, finish, fail }); });
  return { manager, calls, work };
}

test("matching typing reuses the oldest cloud result and cancels the fresh competitor", async t => {
  const { manager, calls, work } = fixture(); t.after(() => manager.cancel());
  const first = new AbortController();
  const p0 = manager.run(origin(), "context", first.signal, work);
  const cancelled = assert.rejects(p0, { code: -32800 });
  await flush();
  const next = type(manager, origin(), "a"); first.abort(); await cancelled;
  const p1 = manager.run(next, "context", new AbortController().signal, work);
  await flush(); assert.equal(calls.length, 2);
  calls[0].finish({ text: "a + b", metadata: "old model" });
  assert.deepEqual(await p1, { text: " + b", metadata: "old model", version: 2, offset: 8, speculative: true });
  assert.equal(calls[1].signal.aborted, true);
  calls[1].finish({ text: "WRONG LATE", metadata: "fresh" }); await flush();
  assert.equal((await manager.run(next, "context", new AbortController().signal, work)).text, " + b");
  assert.equal(manager.hits, 1);
});

test("a mismatched old result cannot win or block the already running fresh request", async t => {
  const { manager, calls, work } = fixture(); t.after(() => manager.cancel());
  const controller = new AbortController();
  const cancelled = assert.rejects(manager.run(origin(), "context", controller.signal, work), { code: -32800 });
  await flush(); const next = type(manager, origin(), "x"); controller.abort(); await cancelled;
  let settled = false;
  const result = manager.run(next, "context", new AbortController().signal, work).then(value => { settled = true; return value; });
  await flush(); calls[0].finish({ text: "a + b", metadata: "wrong" }); await flush();
  assert.equal(settled, false); assert.equal(calls[1].signal.aborted, false);
  calls[1].finish({ text: ".value", metadata: "fresh" });
  assert.equal((await result).text, ".value"); assert.equal(manager.misses, 1);
});

test("a fresh result can win first and late old output is ignored", async t => {
  const { manager, calls, work } = fixture(); t.after(() => manager.cancel());
  const controller = new AbortController();
  const rejected = assert.rejects(manager.run(origin(), "context", controller.signal, work), { code: -32800 });
  await flush(); const next = type(manager, origin(), "a"); controller.abort(); await rejected;
  const result = manager.run(next, "context", new AbortController().signal, work);
  await flush(); calls[1].finish({ text: " + b", metadata: "fresh" });
  assert.equal((await result).metadata, "fresh"); assert.equal(calls[0].signal.aborted, true);
  calls[0].finish({ text: "a BAD", metadata: "late" }); await flush();
  assert.equal((await manager.run(next, "context", new AbortController().signal, work)).text, " + b");
});

test("repeated typing holds at most two predictions and keeps the oldest one", async t => {
  const { manager, calls, work } = fixture(); t.after(() => manager.cancel());
  let snapshot = origin(); let controller = new AbortController();
  let waiting = manager.run(snapshot, "context", controller.signal, work);
  let rejection = assert.rejects(waiting, { code: -32800 });
  await flush();
  for (const character of ["a", "b", "c"]) {
    snapshot = type(manager, snapshot, character); controller.abort(); await rejection;
    controller = new AbortController(); waiting = manager.run(snapshot, "context", controller.signal, work);
    rejection = assert.rejects(waiting, { code: -32800 });
    await flush(); assert.equal(manager.status.pending, 2); assert.equal(calls[0].signal.aborted, false);
  }
  // This last assertion consumes the rejection handler installed for the latest caller.
  controller.abort(); await rejection;
  const latest = manager.run(snapshot, "context", new AbortController().signal, work);
  calls[0].finish({ text: "abcNEXT", metadata: "old" });
  assert.equal((await latest).text, "NEXT");
  assert.ok(calls.slice(1).every(call => call.signal.aborted));
});

test("only exact single-cursor insertions can be forwarded; other context changes cancel", async () => {
  for (const change of [
    { rangeOffset: 6, rangeLength: 0, text: "a" },
    { rangeOffset: 7, rangeLength: 1, text: "a" },
    { rangeOffset: 7, rangeLength: 0, text: "" },
    { rangeOffset: 7, rangeLength: 0, text: "a".repeat(257) },
  ]) {
    const { manager, calls, work } = fixture();
    const rejected = assert.rejects(manager.run(origin(), "context", new AbortController().signal, work), { code: -32800 });
    await flush();
    assert.equal(manager.advance({ ...origin(), version: 2, text: "return a;\n" }, [change]), false);
    manager.cancel(); await rejected; assert.equal(calls[0].signal.aborted, true);
  }
  const { manager, calls, work } = fixture();
  const rejected = assert.rejects(manager.run(origin(), "model A", new AbortController().signal, work), { code: -32800 });
  await flush();
  assert.equal(manager.advance({ ...origin(), version: 2, text: "return aCHANGED_SUFFIX" }, [{ rangeOffset: 7, rangeLength: 0, text: "a" }]), false);
  const changed = manager.run(origin(), "model B", new AbortController().signal, work); await rejected;
  await flush(); assert.equal(calls[0].signal.aborted, true); calls[1].finish({ text: "ok", metadata: "B" }); await changed;
  manager.cancel();
});

test("UTF-16 emoji and CRLF consumption preserve the exact suffix and old subscribers cannot receive a new version", async t => {
  const { manager, calls, work } = fixture(); t.after(() => manager.cancel());
  const old = manager.run(origin(), "context", new AbortController().signal, work);
  const rejected = assert.rejects(old, { code: -32800 });
  await flush(); const next = type(manager, origin(), "😀\r\n");
  const latest = manager.run(next, "context", new AbortController().signal, work);
  await flush(); calls[0].finish({ text: "😀\r\n  answer", metadata: "unicode" });
  await rejected; assert.equal((await latest).text, "  answer");
});

test("completed predictions can be consumed while no caller is present, then expire", async t => {
  let now = 0;
  const manager = new SpeculativeCompletion<string>(() => now); t.after(() => manager.cancel());
  let calls = 0;
  const work = async () => { calls++; return { text: "a + b", metadata: "model" }; };
  await manager.run(origin(), "context", new AbortController().signal, work);
  const next = type(manager, origin(), "a");
  assert.equal((await manager.run(next, "context", new AbortController().signal, work)).text, " + b"); assert.equal(calls, 1);
  now = 15000;
  assert.equal((await manager.run(next, "context", new AbortController().signal, work)).text, "a + b"); assert.equal(calls, 2);
});

test("independent cancellation, errors and uncooperative-provider timeouts do not leak jobs", async t => {
  const manager = new SpeculativeCompletion<string>(); t.after(() => manager.cancel());
  let inference!: AbortSignal;
  const work = (_origin: TypingSnapshot, signal: AbortSignal) => withDeadline(signal, 15, async generated => { inference = generated; return new Promise<Prediction<string>>(() => {}); });
  const first = new AbortController();
  const a = manager.run(origin(), "context", first.signal, work);
  const cancelled = assert.rejects(a, { code: -32800 });
  const b = assert.rejects(manager.run(origin(), "context", new AbortController().signal, work), { code: -32002 });
  first.abort(); await cancelled; await b;
  assert.equal(inference.aborted, true); assert.equal(manager.status.pending, 0); assert.equal(manager.shared, 1);
  await assert.rejects(manager.run(origin(), "context", new AbortController().signal, async () => { throw new Error("Quota"); }), /Quota/);
});
