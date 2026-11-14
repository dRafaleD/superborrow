import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { CoreBridge, IdeHandler } from "../src/bridge";
import { CompletionParams } from "../src/protocol";

const binary = path.resolve(__dirname, "../../../core-rust/target/debug", process.platform === "win32" ? "superborrow-core.exe" : "superborrow-core");
const doc = { uri: "file:///test.ts", version: 1, languageId: "typescript", text: "const emoji = '😀';\r\nconsole." };
const request: CompletionParams = { uri: doc.uri, version: 1, position: { line: 1, character: 8 }, mode: "ide" };

async function setup(handler: IdeHandler): Promise<CoreBridge> {
  const bridge = new CoreBridge(binary, handler);
  try {
    assert.deepEqual(await bridge.initialize(), { protocolVersion: 1, phase: 1 });
    await bridge.updateDocument(doc);
    return bridge;
  } catch (error) { bridge.dispose(); throw error; }
}

test("real Rust process routes concurrent reverse responses by ID", { timeout: 10000 }, async () => {
  let count = 0;
  const bridge = await setup(async (params) => {
    assert.equal(params.languageId, "typescript");
    assert.ok(params.prompt.includes("😀"));
    assert.ok(params.prompt.endsWith("console.\n[CURSOR]\n"));
    const index = ++count;
    await new Promise(resolve => setTimeout(resolve, index === 1 ? 40 : 1));
    return { text: `reply${index}` };
  });
  try {
    const result = await Promise.all([bridge.requestCompletion(request), bridge.requestCompletion(request)]);
    assert.deepEqual(result, [{ text: "reply1", version: 1 }, { text: "reply2", version: 1 }]);
  } finally { await bridge.shutdown(); }
});

test("cancellation reaches reverse handler and frees pending request", { timeout: 10000 }, async () => {
  let started!: () => void;
  let aborted!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const bridge = await setup(async (_params, signal) => {
    signal.addEventListener("abort", aborted, { once: true });
    started();
    return new Promise(() => {});
  });
  try {
    const controller = new AbortController();
    const completion = bridge.requestCompletion(request, controller.signal);
    const rejected = assert.rejects(completion, (error: { code: number }) => error.code === -32800);
    await ready;
    controller.abort();
    await Promise.all([rejected, cancelled]);
    await bridge.updateDocument({ ...doc, version: 2 });
  } finally { await bridge.shutdown(); }
});

test("document versions, positions, close, and local placeholder are enforced", { timeout: 10000 }, async () => {
  const bridge = await setup(async () => ({ text: "ok" }));
  try {
    await assert.rejects(bridge.updateDocument(doc), (e: { code: number }) => e.code === -32801);
    await assert.rejects(bridge.requestCompletion({ ...request, version: 0 }), (e: { code: number }) => e.code === -32801);
    await assert.rejects(bridge.requestCompletion({ ...request, position: { line: 99, character: 0 } }), (e: { code: number }) => e.code === -32602);
    await assert.rejects(bridge.requestCompletion({ ...request, mode: "local" }), (e: { code: number }) => e.code === -32004);
    await bridge.closeDocument(doc.uri);
    await assert.rejects(bridge.requestCompletion(request), (e: { code: number }) => e.code === -32602);
  } finally { await bridge.shutdown(); }
});

test("a changed document rejects an obsolete reverse response", { timeout: 10000 }, async () => {
  let started!: () => void;
  let release!: (value: { text: string }) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const bridge = await setup(async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  });
  try {
    const completion = bridge.requestCompletion(request);
    const rejected = assert.rejects(completion, (e: { code: number }) => e.code === -32801);
    await ready;
    await bridge.updateDocument({ ...doc, version: 2 });
    release({ text: "obsolete" });
    await rejected;
  } finally { await bridge.shutdown(); }
});

test("IDE model errors propagate and unavailable executable rejects startup", { timeout: 10000 }, async () => {
  const bridge = await setup(async () => { throw new Error("No model"); });
  try {
    await assert.rejects(bridge.requestCompletion(request), (e: { code: number }) => e.code === -32003);
  } finally { await bridge.shutdown(); }
  const missing = new CoreBridge(path.join(__dirname, "missing-binary"), async () => ({ text: "" }));
  try { await assert.rejects(missing.initialize()); }
  finally { missing.dispose(); }
});

test("reverse timeout aborts handler and rejects the original request", { timeout: 15000 }, async () => {
  let aborted = false;
  const bridge = await setup(async (_params, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  });
  try {
    await assert.rejects(bridge.requestCompletion(request), (e: { code: number }) => e.code === -32002);
    assert.equal(aborted, true);
  } finally { await bridge.shutdown(); }
});
