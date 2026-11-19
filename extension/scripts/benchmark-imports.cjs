// Closed-import context availability and preparation cost. No editor or model.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CoreBridge } = require('../dist/src/bridge');
const { LocalImports } = require('../dist/src/imports');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
(async () => {
  const directory = path.join(root, 'packages', `import-benchmark-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const source = "import type { Invoice } from './invoice.js';\nfunction due(invoice: Invoice) { return invoice.";
  const active = path.join(directory, 'active.ts');
  await fs.writeFile(active, source);
  await fs.writeFile(path.join(directory, 'invoice.ts'), 'export interface Invoice { netCents: number; taxBps: number; discountCents: number; }');
  let calls = 0;
  const core = new CoreBridge(path.join(root, 'extension/bin/superborrow-core.exe'), async () => { calls++; throw Error('Inference is forbidden'); });
  const report = { scope: 'closed-import-context-availability', editorLaunched: false, synthetic: true, cases: [] };
  try {
    const info = await core.initialize(); report.coreVersion = info.version;
    assert.equal(info.capabilities.relatedDocuments, true);
    await core.configure({ ideAvailable: true });
    await core.updateDocument({ uri: pathToFileURL(active).toString(), version: 1, languageId: 'typescript', text: source });
    const imports = new LocalImports();
    for (let round = 0; round < 3; round++) {
      for (const enabled of round % 2 ? [true, false] : [false, true]) {
        const started = performance.now();
        const relatedDocuments = enabled ? await imports.resolve(active, source, directory, [], new AbortController().signal) : [];
        const loadedMs = performance.now() - started;
        const prepared = await core.prepareIdeCompletion({ uri: pathToFileURL(active).toString(), version: 1, position: { line: 1, character: source.split('\n')[1].length }, mode: 'ide', relatedDocuments });
        const fields = ['netCents', 'taxBps', 'discountCents'];
        const available = fields.filter(field => prepared.prompt.includes(field));
        assert.equal(available.length, enabled ? 3 : 0);
        assert.ok(Buffer.byteLength(prepared.prompt) <= 24000);
        report.cases.push({ enabled, round, readAndResolveMs: Math.round(loadedMs * 100) / 100, totalPreparationMs: Math.round((performance.now() - started) * 100) / 100, referencedFiles: relatedDocuments.length, requiredFactsInPrompt: available.length, requiredFacts: fields.length, promptBytes: Buffer.byteLength(prepared.prompt) });
      }
    }
    report.inferenceCalls = calls; assert.equal(calls, 0); report.passed = true;
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); console.log(path.join(directory, 'report.json'));
  } finally { await core.shutdown(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
