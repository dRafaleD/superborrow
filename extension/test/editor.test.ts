import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DocumentSync } from "../src/documents";
import { CompletionCache, ContinuationCache, cleanCompletion, codeOnlySuggestion, excludedPath, followDeclarationRename, inlineInsertion, insertion } from "../src/completion";

test("document synchronization preserves order and skips stale snapshots", async () => {
  const events: string[] = [];
  const sync = new DocumentSync({
    async updateDocument(doc) { await new Promise(resolve => setTimeout(resolve, 1)); events.push(`${doc.uri}:${doc.version}`); },
    async closeDocument(uri) { events.push(`close:${uri}`); },
  });
  const doc = { uri: "a", version: 1, languageId: "rust", text: "a" };
  await Promise.all([sync.update(doc), sync.update({ ...doc, version: 3 }), sync.update({ ...doc, version: 2 }), sync.close("a"), sync.update(doc)]);
  assert.deepEqual(events, ["a:3", "close:a", "a:1"]);
  for (let index = 0; index < 20; index++) await sync.update({ ...doc, uri: `doc${index}` });
  assert.equal(sync.size, 16); assert.equal(sync.has("a"), false);
});

test("document synchronization recovers after a failed snapshot", async () => {
  let calls = 0;
  const sync = new DocumentSync({ async updateDocument() { if (++calls === 1) throw new Error("Disconnected"); }, async closeDocument() {} });
  const doc = { uri: "a", version: 1, languageId: "rust", text: "a" };
  await assert.rejects(sync.update(doc)); await sync.update(doc); assert.equal(sync.has("a"), true);
});

test("patches use the acknowledged base and fall back to a snapshot after coalescing or rejection", async () => {
  const sent: string[] = [];
  const sync = new DocumentSync({
    async updateDocument(doc) { sent.push(`full:${doc.version}`); },
    async patchDocument(patch) {
      sent.push(`patch:${patch.baseVersion}->${patch.version}`);
      if (patch.version === 5) throw Object.assign(new Error("missing base"), { code: -32801 });
    },
    async closeDocument() {},
  }, true);
  const doc = { uri: "a", version: 1, languageId: "typescript", text: "1" };
  const update = (version: number) => sync.update({ ...doc, version, text: String(version) }, {
    uri: doc.uri, baseVersion: version - 1, version, start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, text: String(version),
  });
  await sync.update(doc);
  await update(2);
  await Promise.all([update(3), update(4)]);
  await update(5);
  await update(6);
  assert.deepEqual(sent, ["full:1", "patch:1->2", "full:4", "patch:4->5", "full:5", "patch:5->6"]);
});

test("typing bursts collapse behind a busy transport without mutating its in-flight snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: number[] = [];
  const sync = new DocumentSync({
    async updateDocument(doc) { sent.push(doc.version); if (doc.version === 1) await gate; },
    async closeDocument() {},
  });
  const doc = { uri: "a", version: 1, languageId: "python", text: "x" };
  const first = sync.update(doc);
  await new Promise(resolve => setImmediate(resolve));
  const queued = Array.from({ length: 100 }, (_, index) => sync.update({ ...doc, version: index + 2, text: `x${index}` }));
  assert.deepEqual(sent, [1]);
  release(); await Promise.all([first, ...queued]);
  assert.deepEqual(sent, [1, 101]);
});

test("preparation and cross-document updates prevent queued snapshots overtaking context", async () => {
  const events: string[] = [];
  const sync = new DocumentSync({
    async updateDocument(doc) { events.push(`${doc.uri}:${doc.version}:${doc.text}`); },
    async closeDocument(uri) { events.push(`close:${uri}`); },
  });
  const doc = { uri: "a", version: 1, languageId: "python", text: "one" };
  const before = sync.update(doc);
  const prepared = sync.withSnapshot(doc, async () => { events.push("prepare:1"); });
  const after = sync.update({ ...doc, version: 2, text: "two" });
  const other = sync.update({ ...doc, uri: "b" });
  const newest = sync.update({ ...doc, version: 3, text: "three" });
  await Promise.all([before, prepared, after, other, newest]);
  assert.deepEqual(events, ["a:1:one", "prepare:1", "a:2:two", "b:1:one", "a:3:three"]);
});

test("every coalesced caller sees transport failure and the latest snapshot can retry", async () => {
  let fail = true;
  const versions: number[] = [];
  const sync = new DocumentSync({ async updateDocument(doc) { versions.push(doc.version); if (fail) throw new Error("Disconnected"); }, async closeDocument() {} });
  const doc = { uri: "a", version: 1, languageId: "python", text: "x" };
  const first = sync.update(doc), latest = sync.update({ ...doc, version: 2 });
  const results = await Promise.allSettled([first, latest]);
  assert.ok(results.every(result => result.status === "rejected"));
  fail = false; await sync.update({ ...doc, version: 2 });
  assert.deepEqual(versions, [2, 2]);
});

test("prompt preparation and its snapshot stay atomic relative to later editor updates", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sync = new DocumentSync({ async updateDocument(doc) { events.push(`update:${doc.version}`); }, async closeDocument() {} });
  const snapshot = { uri: "a", version: 1, languageId: "python", text: "return " };
  const prepared = sync.withSnapshot(snapshot, async () => { events.push("prepare:1"); await gate; events.push("prepared:1"); return "prompt"; });
  const updated = sync.update({ ...snapshot, version: 2, text: "return a" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["update:1", "prepare:1"]);
  release(); assert.equal(await prepared, "prompt"); await updated;
  assert.deepEqual(events, ["update:1", "prepare:1", "prepared:1", "update:2"]);
  await assert.rejects(sync.withSnapshot(snapshot, async () => "stale"), { code: -32801 });
});

test("IDE direct output cleanup preserves indentation, bounds UTF-8 and strips protocol/fence markers", () => {
  assert.equal(cleanCompletion("```python\n  answer\n```"), "  answer");
  assert.equal(cleanCompletion(" \n<NO_COMPLETION>\n"), "");
  assert.equal(cleanCompletion("  value<|fim_suffix|>ignored"), "  value");
  assert.equal(cleanCompletion("😀".repeat(5000)), "😀".repeat(4096));
  assert.equal(cleanCompletion("x".repeat(16383) + "😀"), "x".repeat(16383));
});

test("ghost text keeps suffix and EOL; exclusions protect matching documents", () => {
  assert.equal(insertion('log("x");', ');\n}', "\n"), 'log("x"');
  assert.equal(insertion("a\nb", "", "\r\n"), "a\r\nb");
  for (const file of ["C:\\project\\.env", "C:\\project\\.env.local", "/project/private.KEY", "/project/node_modules/a.ts"]) {
    assert.equal(excludedPath(file, [".env*", "*.key", "node_modules"]), true);
  }
  assert.equal(excludedPath("/project/keymap.ts", ["*.key"]), false);
});

test("code-only suggestions preserve explicit code and comments while filtering chat wrappers", () => {
  const prose = "In this code, we have a variable `y` initialized to 10. We then print the value of `y`.";
  const code = '    println!("{y}");';
  assert.equal(codeOnlySuggestion(prose), "");
  assert.equal(codeOnlySuggestion(`Here is the code:\n\n\`\`\`rust\n${code}\n\`\`\`\n\n${prose}`), code);
  assert.equal(codeOnlySuggestion(`${code}\r\n\r\n${prose}`), code);
  assert.equal(codeOnlySuggestion(`    // ${prose}\n${code}`, "rust"), code);
  assert.equal(codeOnlySuggestion("    // Print the value of y.", "rust"), "");
  assert.equal(codeOnlySuggestion("    # Print the value of y.\r\n    print(y)", "python"), "    print(y)");
  assert.equal(codeOnlySuggestion("/// API contract\nfn run() {}", "rust"), "/// API contract\nfn run() {}");
  assert.equal(codeOnlySuggestion("#include <stdio.h>", "cpp"), "#include <stdio.h>");
  assert.equal(codeOnlySuggestion("#[derive(Debug)]", "rust"), "#[derive(Debug)]");
  assert.equal(codeOnlySuggestion("// 2", "python"), "// 2");
  assert.equal(codeOnlySuggestion('y + 1'), 'y + 1');
});

test("inline call completions stop repeated arguments without dropping nested parentheses", () => {
  const complete = (text: string, prefix = "println!(") => inlineInsertion(text, prefix, ");", "\n", "rust");
  assert.equal(complete("value, value, value"), "value");
  assert.equal(complete(", value, value", "println!(value"), "");
  assert.equal(complete("count, count", 'println!("{count}", '), "count");
  assert.equal(complete('"count {}", count'), '"count {}", count');
  assert.equal(complete("number(), number(), number()"), "number()");
  assert.equal(complete("expression())\nignored();"), "expression()");
  assert.equal(complete('pair("x,y", other)'), 'pair("x,y", other)');
  assert.equal(complete("value", "    // println!("), "value");
});

test("Rust Tab keeps one copy of an adjacent statement block across requests", () => {
  const block = 'let mut spaces = "   ";\n    spaces = spaces.len();\n    println!("The value of spaces is: {}", spaces);';
  const open = "fn main() {\n    ";
  const next = "\n\n    ";
  const insert = (text: string, prefix = open) => inlineInsertion(text, prefix, "\n}", "\n", "rust");
  assert.equal(insert(block + next + block + next + block), block);
  assert.equal(insert(block, open + block + next), "");
  assert.equal(insert(block.split("\n").slice(0, 2).join("\n") + '\n    println!("The value', open + block + next), "");
  assert.equal(insert(block + next + block.replaceAll("spaces", "tabs")), block + next + block.replaceAll("spaces", "tabs"));
  assert.equal(insert('println!("retry");\n    println!("retry");'), 'println!("retry");\n    println!("retry");');
});

test("a local declaration rename updates references in the same flat statement only", () => {
  assert.equal(followDeclarationRename("const subtotal = 10, total = price * 2;", 6, "price", "subtotal"), "const subtotal = 10, total = subtotal * 2;");
  assert.equal(followDeclarationRename("const subtotal = 10, label = 'price';", 6, "price", "subtotal"), undefined);
  assert.equal(followDeclarationRename("const subtotal = 10, total = other.price;", 6, "price", "subtotal"), undefined);
  assert.equal(followDeclarationRename("const subtotal = 10, price = 2;", 6, "price", "subtotal"), undefined);
});

test("cache is bounded and can be invalidated on any context change", () => {
  const cache = new CompletionCache();
  for (let index = 0; index < 40; index++) cache.put(String(index), "x");
  assert.equal(cache.get("0"), undefined); assert.equal(cache.get("39"), "x");
  cache.clear(); assert.equal(cache.get("39"), undefined);
});

test("typing and partial acceptance reuse the remaining suggestion with its original model", () => {
  const cache = new ContinuationCache<string>();
  cache.put("a", 1, 10, "😀\r\n  return a + b", "antigravity:model");
  cache.advance("a", 2, [{ rangeOffset: 10, rangeLength: 0, text: "😀\r\n" }]);
  assert.deepEqual(cache.get("a", 2, 14), { text: "  return a + b", metadata: "antigravity:model" });
  assert.equal(cache.get("a", 1, 10), undefined);
  assert.equal(cache.get("a", 2, 13), undefined);
  cache.advance("a", 3, [{ rangeOffset: 14, rangeLength: 0, text: "  return a + b" }]);
  assert.equal(cache.get("a", 3, 28), undefined);
});

test("continuations reject divergent edits, replacements, other context changes and expired results", () => {
  let now = 0;
  const cache = new ContinuationCache<string>(() => now);
  const insertion = { rangeOffset: 10, rangeLength: 0, text: "a" };
  for (const [uri, version, changes] of [
    ["b", 2, [insertion]],
    ["a", 3, [insertion]],
    ["a", 2, [{ ...insertion, text: "x" }]],
    ["a", 2, [{ ...insertion, rangeLength: 1 }]],
    ["a", 2, [{ ...insertion, rangeOffset: 9 }]],
    ["a", 2, [insertion, insertion]],
  ] as const) {
    cache.put("a", 1, 10, "abc", "model");
    cache.advance(uri, version, changes);
    assert.equal(cache.get("a", 1, 10), undefined);
    assert.equal(cache.get("a", 2, 11), undefined);
  }
  cache.put("a", 1, 10, "abc", "model");
  now = 15000;
  assert.equal(cache.get("a", 1, 10), undefined);
});
