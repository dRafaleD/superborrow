import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { LocalImports } from "../src/imports";

async function fixture(run: (root: string) => Promise<void>) {
  const packages = path.resolve(__dirname, "../../../packages");
  await mkdir(packages, { recursive: true });
  const root = await mkdtemp(path.join(packages, "imports-test-"));
  try { await run(root); }
  finally { assert.ok(path.resolve(root).startsWith(packages + path.sep)); await rm(root, { recursive: true, force: true }); }
}

test("direct local imports resolve TS behind JS specifiers and index files, without opening an editor", async () => fixture(async root => {
  const active = path.join(root, "active.ts"); await writeFile(active, "");
  await writeFile(path.join(root, "api.ts"), "export interface Invoice { netCents: number }");
  await mkdir(path.join(root, "util")); await writeFile(path.join(root, "util/index.ts"), "export function formatMoney(value: number): string { return ''; }");
  const imports = new LocalImports(); const signal = new AbortController().signal;
  const text = `import type {\n Invoice\n} from './api.js';\nexport { formatMoney } from './util';\nimport { Invoice as Copy } from './api.js';`;
  const documents = await imports.resolve(active, text, root, [], signal);
  assert.equal(documents.length, 2);
  assert.match(documents[0].text, /netCents/); assert.match(documents[1].text, /formatMoney/);
  assert.equal(imports.changed(path.join(root, "api.ts")), true);
  await writeFile(path.join(root, "api.ts"), "export interface Invoice { grossCents: number }");
  imports.clear();
  assert.match((await imports.resolve(active, text, root, [], signal))[0].text, /grossCents/);
}));

test("workspace boundaries, exclusions, size, binary data and cancellation bound import reads", async () => fixture(async root => {
  await mkdir(path.join(root, "project")); const workspace = path.join(root, "project");
  const active = path.join(workspace, "active.ts"); await writeFile(active, "");
  await writeFile(path.join(root, "outside.ts"), "export const outsideSecret = 1;");
  await writeFile(path.join(workspace, "private.ts"), "export const privateValue = 1;");
  await writeFile(path.join(workspace, "large.ts"), "x".repeat(65537));
  await writeFile(path.join(workspace, "binary.ts"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(workspace, "bad.ts"), Buffer.from([255]));
  const source = ['../outside', './private', './large', './binary', './bad'].map((value, i) => `import { value${i} } from '${value}';`).join('\n');
  const imports = new LocalImports();
  assert.deepEqual(await imports.resolve(active, source, workspace, ['private.ts'], new AbortController().signal), []);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await imports.resolve(active, source, workspace, [], controller.signal), []);
  assert.equal(imports.changed(path.join(workspace, "bad.ts")), true);
}));

test("at most four direct dependencies are read and missing imports remain tracked for creation", async () => fixture(async root => {
  const active = path.join(root, "active.ts"); await writeFile(active, "");
  for (let i = 0; i < 8; i++) await writeFile(path.join(root, `api${i}.ts`), `export const value${i} = ${i};`);
  const imports = new LocalImports();
  const source = Array.from({ length: 8 }, (_, i) => `import { value${i} } from './api${i}';`).join('\n');
  assert.equal((await imports.resolve(active, source, root, [], new AbortController().signal)).length, 4);
  await imports.resolve(active, "import { created } from './missing';", root, [], new AbortController().signal);
  assert.equal(imports.changed(path.join(root, 'missing.ts')), true);
}));

test("commented imports and template contents do not cause source reads", async () => fixture(async root => {
  const active = path.join(root, 'active.ts'); await writeFile(active, '');
  await writeFile(path.join(root, 'api.ts'), 'export const ignored = 1;');
  const source = "/*\nimport { ignored } from './api';\n*/\nconst example = `\nimport { ignored } from './api';\n`;\n// import { ignored } from './api';";
  const imports = new LocalImports();
  assert.deepEqual(await imports.resolve(active, source, root, [], new AbortController().signal), []);
  assert.equal(imports.changed(path.join(root, 'api.ts')), false);
}));

test("a source-looking junction cannot import a file outside the workspace", async () => fixture(async root => {
  const workspace = path.join(root, 'project'), outside = path.join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  const active = path.join(workspace, 'active.ts'); await writeFile(active, '');
  await writeFile(path.join(outside, 'api.ts'), 'export interface Hidden { outsideOnly: string }');
  await symlink(outside, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await new LocalImports().resolve(active, "import { Hidden } from './link/api';", workspace, [], new AbortController().signal), []);
}));

test("ordinary typing reuses dependency reads while import changes and file events refresh them", async () => fixture(async root => {
  const active = path.join(root, 'active.ts'); await writeFile(active, '');
  await writeFile(path.join(root, 'api.ts'), 'export interface API { oldValue: number }');
  await writeFile(path.join(root, 'other.ts'), 'export interface Other { otherValue: number }');
  const imports = new LocalImports(); const signal = new AbortController().signal;
  const source = "import { API } from './api';\nfunction value() { return ";
  for (let i = 0; i < 10; i++) {
    const references = await imports.resolve(active, source + 'x'.repeat(i), root, [], signal);
    assert.match(references[0].text, /oldValue/);
  }
  assert.equal(imports.status.fileReads, 1); assert.equal(imports.status.hits, 9);
  await imports.resolve(active, "import { Other } from './other';", root, [], signal);
  assert.equal(imports.status.fileReads, 2);
  await writeFile(path.join(root, 'api.ts'), 'export interface API { newValue: number }');
  assert.equal(imports.changed(path.join(root, 'api.ts')), true); imports.clear();
  const refreshed = await imports.resolve(active, source + 'latest', root, [], signal);
  assert.match(refreshed[0].text, /newValue/); assert.doesNotMatch(refreshed[0].text, /oldValue/);
  assert.equal(imports.status.fileReads, 3);
}));
