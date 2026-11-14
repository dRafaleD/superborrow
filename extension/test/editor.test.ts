import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DocumentSync } from "../src/documents";
import { CompletionCache, excludedPath, insertion } from "../src/completion";

test("document synchronization preserves order and skips stale snapshots", async () => {
  const events: string[] = [];
  const sync = new DocumentSync({
    async updateDocument(doc) { await new Promise(resolve => setTimeout(resolve, 1)); events.push(`${doc.uri}:${doc.version}`); },
    async closeDocument(uri) { events.push(`close:${uri}`); },
  });
  const doc = { uri: "a", version: 1, languageId: "rust", text: "a" };
  await Promise.all([sync.update(doc), sync.update({ ...doc, version: 3 }), sync.update({ ...doc, version: 2 }), sync.close("a"), sync.update(doc)]);
  assert.deepEqual(events, ["a:1", "a:3", "close:a", "a:1"]);
  for (let index = 0; index < 20; index++) await sync.update({ ...doc, uri: `doc${index}` });
  assert.equal(sync.size, 16); assert.equal(sync.has("a"), false);
});

test("document synchronization recovers after a failed snapshot", async () => {
  let calls = 0;
  const sync = new DocumentSync({ async updateDocument() { if (++calls === 1) throw new Error("Disconnected"); }, async closeDocument() {} });
  const doc = { uri: "a", version: 1, languageId: "rust", text: "a" };
  await assert.rejects(sync.update(doc)); await sync.update(doc); assert.equal(sync.has("a"), true);
});

test("ghost text keeps suffix and EOL; exclusions protect matching documents", () => {
  assert.equal(insertion('log("x");', ');\n}', "\n"), 'log("x"');
  assert.equal(insertion("a\nb", "", "\r\n"), "a\r\nb");
  for (const file of ["C:\\project\\.env", "C:\\project\\.env.local", "/project/private.KEY", "/project/node_modules/a.ts"]) {
    assert.equal(excludedPath(file, [".env*", "*.key", "node_modules"]), true);
  }
  assert.equal(excludedPath("/project/keymap.ts", ["*.key"]), false);
});

test("cache is bounded and can be invalidated on any context change", () => {
  const cache = new CompletionCache();
  for (let index = 0; index < 40; index++) cache.put(String(index), "x");
  assert.equal(cache.get("0"), undefined); assert.equal(cache.get("39"), "x");
  cache.clear(); assert.equal(cache.get("39"), undefined);
});
