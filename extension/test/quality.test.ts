import { test } from "node:test";
import * as assert from "node:assert/strict";
import { numericPython, typeScriptAddition } from "./quality";
import { checkEditorSource, editorCorpusDigest, editorFixtures } from './editor-corpus';

test("numeric fixtures accept equivalent implementations and reject incorrect or executable model code", async () => {
  for (const body of ["return max(a, b)", "return a if a > b else b", "if a > b:\n        return a\n    return b"]) {
    assert.equal((await numericPython(`def maximum(a, b):\n    ${body}`, "maximum")).passed, true);
  }
  for (const source of [
    "def maximum(a, b):\n    return min(a,b)",
    "def maximum(a, b):\n    return a",
    "def maximum(a, b):\n    return __import__('os').getcwd()",
    "def maximum(a, b):\n    if a > 999999:\n        print(a)\n    return max(a,b)",
    "def maximum(a, b):\n    while True:\n        pass",
    "def maximum(a, b=print(1)):\n    return max(a,b)",
  ]) assert.equal((await numericPython(source, "maximum")).passed, false);
});

test('editor comparison accepts equivalent numeric TypeScript without running generated code', () => {
  for (const expression of ['a + b', 'b + a', '(a) + (+b)']) assert.equal(typeScriptAddition(`function add(a: number,b: number): number { return ${expression}; }`, 'add'), true);
  for (const source of [
    'function add(a: number,b: number): number { return a - b; }',
    'async function add(a: number,b: number) { return a + b; }',
    'function* add(a: number,b: number) { return a + b; }',
    'function add(a: number,b: number) { return process.exit(); }',
    'function add(a: number,b: number) { console.log(a); return a + b; }',
    'function renamed(a: number,b: number) { return a + b; }',
  ]) assert.equal(typeScriptAddition(source, 'add'), false);
});

test('both editor roles use an identical versioned corpus with declared function names preserved', async () => {
  assert.equal(editorCorpusDigest(2), editorCorpusDigest(2));
  assert.notEqual(editorCorpusDigest(1), editorCorpusDigest(2));
  const fixture = editorFixtures(0)[0];
  assert.equal(await checkEditorSource(fixture.prefix + 'a + b' + fixture.suffix, fixture.quality, fixture.expectedName), true);
  assert.equal(await checkEditorSource('def renamed(a,b):\n    return a + b', fixture.quality, fixture.expectedName), false);
});
