import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createStub, document, Position, Selection, Range, CancellationTokenSource } from './vscode-stub';
import type * as VS from 'vscode';

const stub = createStub();
const loader = require('node:module') as { _load: (...args: any[]) => any };
const original = loader._load;
let runtime: typeof import('../src/extension');
try {
  loader._load = (id, ...args) => id === 'vscode' ? stub.vscode : original(id, ...args);
  runtime = require('../src/extension');
} finally { loader._load = original; }

function editor(doc: VS.TextDocument, position: Position) {
  const selection = new Selection(position, position);
  stub.vscode.window.activeTextEditor = { document: doc, selection, selections: [selection] };
  stub.vscode.workspace.textDocuments = [doc];
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'Expected runtime state was not reached');
}
async function close() {
  await runtime.deactivate();
  for (const item of stub.context.subscriptions.splice(0).reverse()) item.dispose();
}

test('Duskline Tab hides prose and strips filler comments from code suggestions', async () => {
  const doc = document('fn run() {\n    \n}', 'rust', 'file:///synthetic/code-only.rs');
  const cursor = new Position(1, 4) as VS.Position;
  editor(doc, cursor);
  let response = "In this code, we have a variable `y` initialized to 10. We then print the value of `y`.";
  stub.state.adapter = {
    version: 1, modelId: 'duskline:qwen2.5-coder:1.5b-base', supportsConcurrentRequests: false,
    generateCompletion: async () => ({ text: response }),
  };
  const api = runtime.activate(stub.context);
  try {
    await api.ready;
    const token = new CancellationTokenSource().token as VS.CancellationToken;
    const context = { triggerKind: 0, selectedCompletionInfo: undefined } as const;
    assert.deepEqual(await api.provideInlineCompletionItems(doc, cursor, context, token), []);
    response = '// Print the value of y.\nprintln!("{y}");';
    const next = document('fn run() {\n    let y = 10;\n    \n}', 'rust', 'file:///synthetic/code-only-with-value.rs');
    const nextCursor = next.positionAt(next.getText().lastIndexOf('    ') + 4);
    editor(next, nextCursor);
    const items = await api.provideInlineCompletionItems(next, nextCursor, context, token);
    assert.ok(Array.isArray(items) && items.length === 1);
    assert.equal(items[0].insertText, 'println!("{y}");');
  } finally { await close(); }
});

test('Rust Tab hides a JavaScript statement from the Duskline model', async () => {
  const doc = document('fn run() {\n    \n}', 'rust', 'file:///synthetic/fixture.rs');
  const cursor = doc.positionAt(doc.getText().indexOf('    ') + 4);
  editor(doc, cursor);
  stub.state.adapter = {
    version: 1, modelId: 'duskline:qwen2.5-coder:1.5b-base',
    supportsConcurrentRequests: false,
    generateCompletion: async () => ({ text: 'console.log("hello");' }),
  };
  const api = runtime.activate(stub.context);
  try {
    await api.ready;
    const token = new CancellationTokenSource().token as VS.CancellationToken;
    const items = await api.provideInlineCompletionItems(doc, cursor, { triggerKind: 0, selectedCompletionInfo: undefined }, token);
    assert.deepEqual(items, []);
    assert.equal(api.getStatus().modelRequests, 1);
  } finally { await close(); }
});

test('a Rust replacement still requests a cursor insertion from Duskline Tab', async () => {
  const before = 'fn run() { let result = compute(old); }';
  const doc = document(before, 'rust');
  const start = before.indexOf('compute');
  const end = before.indexOf(';');
  editor(doc, doc.positionAt(end));
  const kinds: string[] = [];
  stub.state.adapter = {
    version: 1, modelId: 'test:rust', supportsConcurrentRequests: false,
    generateCompletion: async ({ kind }: { kind: string }) => { kinds.push(kind); return { text: 'argument)' }; },
  };
  const api = runtime.activate(stub.context);
  try {
    await api.ready;
    const range = new Range(0, start, 0, end);
    doc.replaceText(before.slice(0, start) + 'compute(' + before.slice(end));
    const cursor = doc.positionAt(start + 'compute('.length);
    editor(doc, cursor);
    stub.vscode.workspace.onDidChangeTextDocument.fire({
      document: doc, contentChanges: [{ range, rangeOffset: start, rangeLength: end - start, text: 'compute(' }],
    });
    const token = new CancellationTokenSource().token as VS.CancellationToken;
    const items = await api.provideInlineCompletionItems(doc, cursor, { triggerKind: 0, selectedCompletionInfo: undefined }, token);
    assert.deepEqual(kinds, ['inline']);
    assert.ok(Array.isArray(items) && items.length === 1);
    assert.equal(items[0].insertText, 'argument)');
    assert.ok(items[0].range?.isEmpty);
  } finally { await close(); }
});

test('Duskline respects a non-concurrent adapter while identical callers share one request', async () => {
  const doc = document('def add(a, b):\n    return ', 'python');
  const position = doc.positionAt(doc.getText().length); editor(doc, position);
  let calls = 0, finish!: (value: { text: string }) => void;
  stub.state.adapter = { version: 1, modelId: 'test:serial', supportsConcurrentRequests: false, generateCompletion: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const api = runtime.activate(stub.context);
  try {
    await api.ready;
    const token = new CancellationTokenSource().token as VS.CancellationToken;
    const first = Promise.resolve(api.provideInlineCompletionItems(doc, position, { triggerKind: 0, selectedCompletionInfo: undefined }, token));
    await until(() => calls === 1);
    const second = Promise.resolve(api.provideInlineCompletionItems(doc, position, { triggerKind: 0, selectedCompletionInfo: undefined }, token));
    await until(() => api.getStatus().sharedRequests === 1);
    assert.equal(api.getStatus().speculative.pending, 0, 'Serial adapters must use the version-bound shared route');
    finish({ text: 'a + b' });
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1); assert.ok(results.every(items => Array.isArray(items) && items.length === 1));
  } finally { finish?.({ text: '' }); await close(); }
});

test('a ready language-service import cancels an older AI completion for the same snapshot', async t => {
  const doc = document('const value = Foo', 'typescript', 'file:///synthetic/fixture.ts');
  const position = doc.positionAt(doc.getText().length); editor(doc, position);
  const target = new Range(0, 14, 0, 17);
  stub.state.diagnostics = [{ source: 'ts', code: 2304, severity: 0, range: target, message: 'Cannot find name Foo' }];
  let ready = false, finish!: (value: { text: string }) => void, modelToken: VS.CancellationToken | undefined;
  stub.state.command = async name => name === 'vscode.executeCodeActionProvider' ? (ready ? [{ kind: { value: 'quickfix' }, edit: { entries: () => [[doc.uri, [{ range: new Range(0, 0, 0, 0), newText: "import { Foo } from './foo';\n" }]]] } }] : []) : undefined;
  stub.state.adapter = { version: 1, modelId: 'test:parallel', supportsConcurrentRequests: true, generateCompletion: (_params: unknown, token: VS.CancellationToken) => { modelToken = token; return new Promise(resolve => { finish = resolve; }); } };
  const api = runtime.activate(stub.context);
  try {
    await api.ready;
    const token = new CancellationTokenSource().token as VS.CancellationToken;
    const old = Promise.resolve(api.provideInlineCompletionItems(doc, position, { triggerKind: 0, selectedCompletionInfo: undefined }, token));
    await until(() => !!modelToken);
    assert.equal(modelToken!.isCancellationRequested, false);
    const now = performance.now.bind(performance);
    t.mock.method(performance, 'now', () => now() + 2100);
    ready = true;
    const items = await api.provideInlineCompletionItems(doc, position, { triggerKind: 0, selectedCompletionInfo: undefined }, token) as any[];
    assert.equal(items.length, 1); assert.equal(items[0].isInlineEdit, true);
    assert.equal(modelToken!.isCancellationRequested, true, 'The old AI result must lose ownership when an import edit wins');
    assert.equal(api.getStatus().speculative.pending, 0);
    assert.deepEqual(await old, []);
  } finally { finish?.({ text: '' }); stub.state.diagnostics = []; t.mock.restoreAll(); await close(); }
});
