import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { CoreBridge, IdeHandler } from "../src/bridge";
import { CompletionParams, EngineConfig } from "../src/protocol";

const binary = path.resolve(__dirname, "../../../core-rust/target/debug", process.platform === "win32" ? "superborrow-core.exe" : "superborrow-core");
const doc = { uri: "file:///test.ts", version: 1, languageId: "typescript", text: "const emoji = '😀';\r\nconsole." };
const request: CompletionParams = { uri: doc.uri, version: 1, position: { line: 1, character: 8 }, mode: "ide", explicit: true };
const code = (expected: number) => (error: { code: number }) => error.code === expected;
const unavailable: IdeHandler = async () => { throw new Error("No IDE model"); };

async function setup(handler: IdeHandler = unavailable, config: Partial<EngineConfig> = {}): Promise<CoreBridge> {
  const bridge = new CoreBridge(binary, handler);
  try {
    const info = await bridge.initialize();
    assert.equal(info.protocolVersion, 1); assert.equal(info.phase, 4);
    await bridge.configure({ debounceMs: 0, ...config });
    await bridge.updateDocument(doc);
    return bridge;
  } catch (error) { bridge.dispose(); throw error; }
}

async function server(handler: (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => void) {
  const errors: unknown[] = [];
  const http = createServer(async (req, res) => {
    try {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      handler(JSON.parse(Buffer.concat(parts).toString()), res, req);
    } catch (error) { errors.push(error); res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    endpoint: `http://127.0.0.1:${address.port}/infill`,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      assert.deepEqual(errors, []);
    },
  };
}

test("concurrent documents correlate out-of-order reverse responses", { timeout: 10000 }, async () => {
  let secondStarted!: () => void;
  const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
  const bridge = await setup(async params => {
    assert.equal(params.languageId, "typescript");
    assert.ok(params.prompt.includes("😀"));
    assert.ok(params.prompt.includes("<PRE>"));
    // Tokio may dispatch the second job first. Identify snapshots by content,
    // never by arrival order; hold the first answer until the second is ready.
    if (params.prompt.includes("<PRE>const emoji = '😀 second';")) { secondStarted(); return { text: "reply2" }; }
    await secondReady;
    return { text: "reply1" };
  });
  try {
    const second = { ...doc, uri: "file:///second.ts", text: doc.text.replace("😀", "😀 second") };
    await bridge.updateDocument(second);
    const result = await Promise.all([bridge.requestCompletion(request), bridge.requestCompletion({ ...request, uri: second.uri })]);
    assert.deepEqual(result.map(r => [r.text, r.version, r.provider]), [["reply1", 1, "ide"], ["reply2", 1, "ide"]]);
  } finally { await bridge.shutdown(); }
});

test("cancellation reaches the reverse handler", { timeout: 10000 }, async () => {
  let started!: () => void; let aborted!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const bridge = await setup(async (_params, signal) => {
    signal.addEventListener("abort", aborted, { once: true }); started();
    return new Promise(() => {});
  });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(bridge.requestCompletion(request, controller.signal), code(-32800));
    await ready; controller.abort(); await Promise.all([rejected, cancelled]);
  } finally { await bridge.shutdown(); }
});

test("versions, UTF-16 positions, bounds, and close are enforced", { timeout: 10000 }, async () => {
  const bridge = await setup(async () => ({ text: "ok" }));
  try {
    await assert.rejects(bridge.updateDocument(doc), code(-32801));
    await assert.rejects(bridge.updateDocument({ ...doc, version: 2, text: "x".repeat(524289) }), code(-32602));
    await assert.rejects(bridge.requestCompletion({ ...request, version: 0 }), code(-32801));
    await assert.rejects(bridge.requestCompletion({ ...request, position: { line: 99, character: 0 } }), code(-32602));
    await bridge.closeDocument(doc.uri);
    await assert.rejects(bridge.requestCompletion(request), code(-32602));
  } finally { await bridge.shutdown(); }
});

test("document changes immediately cancel obsolete work", { timeout: 10000 }, async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const bridge = await setup(async () => { started(); return new Promise(() => {}); });
  try {
    const rejected = assert.rejects(bridge.requestCompletion(request), code(-32801));
    await ready; await bridge.updateDocument({ ...doc, version: 2 }); await rejected;
  } finally { await bridge.shutdown(); }
});

test("document patches preserve CRLF and UTF-16 boundaries and cancel obsolete work", { timeout: 10000 }, async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const bridge = await setup(async () => { started(); return new Promise(() => {}); });
  try {
    const start = { line: 0, character: 15 };
    const patch = { uri: doc.uri, baseVersion: 1, version: 2, start, end: { line: 0, character: 17 }, text: "💡" };
    const rejected = assert.rejects(bridge.requestCompletion(request), code(-32801));
    await ready;
    await assert.rejects(bridge.patchDocument({ ...patch, start: { ...start, character: 16 } }), code(-32602));
    await assert.rejects(bridge.patchDocument({ ...patch, baseVersion: 0 }), code(-32801));
    assert.match((await bridge.prepareIdeCompletion(request)).qwenInfill!, /'😀';\r\nconsole\./);
    await bridge.patchDocument(patch);
    await rejected;
    assert.match((await bridge.prepareIdeCompletion({ ...request, version: 2 })).qwenInfill!, /'💡';\r\nconsole\./);
  } finally { await bridge.shutdown(); }
});

test("identical declarative configuration does not cancel a live completion", { timeout: 10000 }, async () => {
  let started!: () => void;
  let finish!: (value: { text: string }) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const bridge = await setup(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  try {
    const result = bridge.requestCompletion(request);
    await ready;
    await bridge.configure({ debounceMs: 0 });
    finish({ text: "still valid" });
    assert.equal((await result).text, "still valid");
  } finally { await bridge.shutdown(); }
});

test("IDE-only failures never contact a local server", { timeout: 10000 }, async () => {
  let calls = 0;
  const mock = await server((_body, res) => { calls++; res.end('{}'); });
  const bridge = await setup(unavailable, { endpoint: mock.endpoint, ideAvailable: true });
  try {
    await assert.rejects(bridge.requestCompletion(request), code(-32003));
    assert.equal(calls, 0);
  } finally { await bridge.shutdown(); await mock.close(); }
});

test("explicit abstention from the IDE model produces no inserted marker", { timeout: 10000 }, async () => {
  const bridge = await setup(async params => {
    assert.match(params.prompt, /return exactly <NO_COMPLETION>/);
    return { text: "<NO_COMPLETION>" };
  });
  try { assert.equal((await bridge.requestCompletion(request)).text, ""); }
  finally { await bridge.shutdown(); }
});

test("IDE context can be prepared without inference or a generation tied to document updates", { timeout: 10000 }, async () => {
  let calls = 0;
  const bridge = await setup(async () => { calls++; return { text: "new" }; });
  try {
    const prepared = await bridge.prepareIdeCompletion(request);
    assert.equal(prepared.version, 1); assert.equal(prepared.kind, "inline");
    assert.ok(prepared.prompt.includes("<PRE>")); assert.equal(calls, 0);
    await bridge.updateDocument({ ...doc, version: 2 });
    assert.equal(prepared.version, 1);
    await assert.rejects(bridge.prepareIdeCompletion(request), code(-32801));
    assert.equal((await bridge.prepareIdeCompletion({ ...request, version: 2 })).version, 2);
    assert.equal(calls, 0);
    assert.equal((await bridge.requestCompletion({ ...request, version: 2 })).text, "new");
    assert.equal(calls, 1);
  } finally { await bridge.shutdown(); }
});

test("nearby diagnostics reach the IDE within the full prompt byte budget; invalid or stale input is bounded", { timeout: 10000 }, async () => {
  let prompt = "";
  const bridge = await setup(async params => { prompt = params.prompt; return { text: "warn" }; }, { maxContextBytes: 2048 });
  const diagnostic = { position: { line: 1, character: 0 }, severity: "error" as const, message: "Property logg does not exist; use log" };
  try {
    await bridge.requestCompletion({ ...request, diagnostics: [diagnostic] });
    assert.ok(prompt.includes(diagnostic.message));
    assert.ok(Buffer.byteLength(prompt, "utf8") <= 2048);
    await assert.rejects(bridge.requestCompletion({ ...request, diagnostics: Array(9).fill(diagnostic) }), code(-32602));
    await assert.rejects(bridge.requestCompletion({ ...request, diagnostics: [{ ...diagnostic, message: "x".repeat(513) }] }), code(-32602));
    await bridge.requestCompletion({ ...request, diagnostics: [{ ...diagnostic, position: { line: 999, character: 0 }, message: "stale diagnostic" }] });
    assert.ok(!prompt.includes("stale diagnostic"));
  } finally { await bridge.shutdown(); }
});

test("reverse timeout and missing executable reject cleanly", { timeout: 10000 }, async () => {
  let aborted = false;
  const bridge = await setup(async (_params, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true }); return new Promise(() => {});
  }, { requestTimeoutMs: 250 });
  try {
    await assert.rejects(bridge.requestCompletion(request), code(-32002)); assert.equal(aborted, true);
  } finally { await bridge.shutdown(); }
  const missing = new CoreBridge(path.join(__dirname, "missing-binary"), unavailable);
  try { await assert.rejects(missing.initialize()); } finally { missing.dispose(); }
});

for (const api of ["llamaInfill", "ollama", "openAi"] as const) {
  test(`${api} streams fragmented UTF-8 and uses the correct payload`, { timeout: 10000 }, async () => {
    const mock = await server((body, res) => {
      assert.equal(body.stream, true);
      if (api === "llamaInfill") { assert.equal(body.input_prefix, doc.text); assert.equal(body.input_suffix, ""); assert.ok(Array.isArray(body.input_extra)); }
      else { assert.equal(body.model, "test-coder"); assert.ok(String(body.prompt).includes("<|fim_prefix|>")); }
      res.writeHead(200, { "Content-Type": api === "ollama" ? "application/x-ndjson" : "text/event-stream" });
      const text = 'log("😀");';
      const data = api === "llamaInfill" ? `data: ${JSON.stringify({ content: text, stop: true })}\n\n`
        : api === "ollama" ? `${JSON.stringify({ response: text, done: true })}\n`
        : `data: ${JSON.stringify({ choices: [{ text, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
      const bytes = Buffer.from(data);
      // A separate write per byte stresses framing at multibyte boundaries.
      for (const byte of bytes) res.write(Buffer.from([byte]));
      res.end();
    });
    const bridge = await setup(unavailable, { localApi: api, endpoint: mock.endpoint, model: "test-coder" });
    try {
      const result = await bridge.requestCompletion({ ...request, mode: "local" });
      assert.equal(result.text, 'log("😀");'); assert.equal(result.provider, "local"); assert.equal(result.fallback, false);
    } finally { await bridge.shutdown(); await mock.close(); }
  });
}

test("hybrid falls back to IDE after local failure; local mode never does", { timeout: 10000 }, async () => {
  const mock = await server((_body, res) => { res.writeHead(503).end(); });
  let ideCalls = 0;
  const bridge = await setup(async () => { ideCalls++; return { text: "ide fallback" }; }, { endpoint: mock.endpoint, ideAvailable: true });
  try {
    const result = await bridge.requestCompletion({ ...request, mode: "hybrid" });
    assert.equal(result.text, "ide fallback"); assert.equal(result.fallback, true); assert.equal(result.provider, "ide");
    await assert.rejects(bridge.requestCompletion({ ...request, mode: "local" }), code(-32004));
    assert.equal(ideCalls, 1);
  } finally { await bridge.shutdown(); await mock.close(); }
});

test("IDE-priority hybrid uses IDE even for small inline contexts in unsupported AST languages", { timeout: 10000 }, async () => {
  let httpCalls = 0;
  const mock = await server((_body, res) => { httpCalls++; res.writeHead(503).end(); });
  const languages = ["go", "java", "csharp", "cpp", "html", "css", "sql", "shellscript", "json", "plaintext", "custom-new-language"];
  const bridge = await setup(async params => ({ text: `answer:${params.languageId}` }), { endpoint: mock.endpoint, ideAvailable: true, hybridPreference: "ide" });
  try {
    for (let index = 0; index < languages.length; index++) {
      const languageId = languages[index];
      await bridge.updateDocument({ ...doc, version: index + 2, languageId });
      const result = await bridge.requestCompletion({ ...request, version: index + 2, mode: "hybrid", explicit: false });
      assert.equal(result.text, `answer:${languageId}`); assert.equal(result.provider, "ide"); assert.equal(result.fallback, false);
    }
    assert.equal(httpCalls, 0);
  } finally { await bridge.shutdown(); await mock.close(); }
});

test("next edit supplies selected code and instruction; IDE failure falls back locally", { timeout: 10000 }, async () => {
  const mock = await server((body, res) => {
    assert.equal(body.input_suffix, "");
    assert.ok(JSON.stringify(body.input_extra).includes("console."));
    assert.ok(JSON.stringify(body.input_extra).includes("Use warn"));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ content: 'console.warn("hello");', stop: true }));
  });
  const bridge = await setup(unavailable, { endpoint: mock.endpoint, ideAvailable: true });
  try {
    const result = await bridge.requestCompletion({ ...request, mode: "hybrid", kind: "nextEdit", position: { line: 1, character: 0 }, endPosition: { line: 1, character: 8 }, instruction: "Use warn" });
    assert.equal(result.text, 'console.warn("hello");'); assert.equal(result.provider, "local"); assert.equal(result.fallback, true);
    await assert.rejects(bridge.requestCompletion({ ...request, kind: "nextEdit" }), code(-32602));
  } finally { await bridge.shutdown(); await mock.close(); }
});

test("debounce supersedes work before inference begins", { timeout: 10000 }, async () => {
  let calls = 0;
  const bridge = await setup(async () => { calls++; return { text: "newest" }; }, { debounceMs: 100 });
  try {
    const rejected = assert.rejects(bridge.requestCompletion({ ...request, explicit: false }), code(-32801));
    await bridge.updateDocument({ ...doc, version: 2 });
    const result = await bridge.requestCompletion({ ...request, version: 2, explicit: false });
    await rejected; assert.equal(result.text, "newest"); assert.equal(calls, 1);
  } finally { await bridge.shutdown(); }
});

test("cancelling a local HTTP stream closes the connection", { timeout: 10000 }, async () => {
  let started!: () => void; let closed!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const mock = await server((_body, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write('data: {"content":"x","stop":false}\n\n');
    res.on("close", closed); started();
  });
  const bridge = await setup(unavailable, { endpoint: mock.endpoint });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(bridge.requestCompletion({ ...request, mode: "local" }, controller.signal), code(-32800));
    await ready; controller.abort(); await Promise.all([rejected, disconnected]);
  } finally { await bridge.shutdown(); await mock.close(); }
});

test("invalid endpoints and incomplete streams fail without suggestions", { timeout: 10000 }, async () => {
  const mock = await server((_body, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"content":"partial","stop":false}\n\n'); });
  const bridge = await setup(unavailable, { endpoint: mock.endpoint });
  try {
    await assert.rejects(bridge.configure({ endpoint: "http://example.com/infill" }), code(-32602));
    await assert.rejects(bridge.requestCompletion({ ...request, mode: "local" }), code(-32004));
  } finally { await bridge.shutdown(); await mock.close(); }
});

test("request-scoped imported types reach the prompt without persisting or overriding unsaved buffers", async () => {
  const bridge = await setup();
  try {
    const text = "import type { Invoice } from './invoice';\nfunction due(value: Invoice) { return value.";
    const source = { uri: "file:///project/active.ts", version: 1, languageId: "typescript", text };
    const related = { uri: "file:///project/invoice.ts", version: 1, languageId: "typescript", text: "export interface Invoice { netCents: number; taxBps: number; }" };
    await bridge.updateDocument(source);
    const params: CompletionParams = { uri: source.uri, version: 1, position: { line: 1, character: text.split('\n')[1].length }, mode: "ide", relatedDocuments: [related] };
    const prepared = await bridge.prepareIdeCompletion(params);
    assert.match(prepared.prompt, /netCents: number/); assert.match(prepared.prompt, /taxBps: number/);
    assert.ok(Buffer.byteLength(prepared.prompt) <= 24000);
    const without = await bridge.prepareIdeCompletion({ ...params, relatedDocuments: [] });
    assert.doesNotMatch(without.prompt, /netCents/);
    await bridge.updateDocument({ ...related, text: "export interface Invoice { unsavedCents: number; }" });
    const unsaved = await bridge.prepareIdeCompletion(params);
    assert.match(unsaved.prompt, /unsavedCents: number/); assert.doesNotMatch(unsaved.prompt, /netCents/);
  } finally { await bridge.shutdown(); }
});

test("untrusted RPC callers cannot supply unbounded imported context", async () => {
  const bridge = await setup();
  try {
    const related = { uri: 'file:///related.ts', version: 1, languageId: 'typescript', text: 'export interface Invoice { value: number }' };
    await assert.rejects(bridge.prepareIdeCompletion({ ...request, relatedDocuments: Array.from({ length: 5 }, () => related) }), code(-32602));
    await assert.rejects(bridge.prepareIdeCompletion({ ...request, relatedDocuments: [{ ...related, text: 'x'.repeat(65537) }] }), code(-32602));
  } finally { await bridge.shutdown(); }
});

test("Rust Tab includes trait method contracts and uses a line boundary for an existing call", async () => {
  const bridge = await setup();
  try {
    const uri = "file:///project/main.rs";
    const prefix = "use crate::repository::Repository;\nfn run(repo: &impl Repository) { repo.fet";
    await bridge.updateDocument({ uri, version: 1, languageId: "rust", text: prefix + "(); }" });
    await bridge.updateDocument({
      uri: "file:///project/repository.rs", version: 1, languageId: "rust",
      text: "pub trait Repository { fn fetch(&self) -> Result<Record, RepoError>; }",
    });
    const script = { uri: "file:///project/repository.ts", version: 1, languageId: "typescript",
      text: "export interface Repository { fetch(): JsOnlyRecord; }" };
    await bridge.updateDocument(script);
    await bridge.updateDocument({ ...script, version: 2, text: script.text + "\nlet jsHistoryOnly = true;" });
    const prepared = await bridge.prepareIdeCompletion({
      uri, version: 1, mode: "ide", position: { line: 1, character: prefix.split("\n")[1].length },
    });
    assert.match(prepared.prompt, /Repository::fn fetch\(&self\) -> Result<Record, RepoError>/);
    assert.doesNotMatch(prepared.prompt, /JsOnlyRecord|jsHistoryOnly/);
    assert.match(prepared.prompt, /Preserve borrowing, mutability and Result\/Option handling/);
    assert.equal(prepared.qwenStopAt, "line");
    assert.match(prepared.qwenInfill!, /^<\|fim_prefix\|>\/\/ Language: Rust\n/);
    assert.match(prepared.qwenInfill!, /repo\.fet<\|fim_suffix\|>\(\); \}/);
  } finally { await bridge.shutdown(); }
});

test("languages without a grammar still receive a language-tagged prefix and suffix", async () => {
  const bridge = await setup();
  try {
    for (const [languageId, prefix, suffix] of [
      ["go", "func answer() int { return ", " }"],
      ["cpp", "int answer() { return ", "; }"],
      ["zig", "fn answer() u32 { return ", "; }"],
    ]) {
      const uri = `file:///project/${languageId}`;
      await bridge.updateDocument({ uri, version: 1, languageId, text: prefix + suffix });
      const prepared = await bridge.prepareIdeCompletion({ uri, version: 1, mode: "ide", position: { line: 0, character: prefix.length } });
      assert.equal(prepared.languageId, languageId);
      assert.ok(prepared.prompt.includes(`<PRE>${prefix}</PRE>\n<SUF>${suffix}</SUF>`));
    }
  } finally { await bridge.shutdown(); }
});
