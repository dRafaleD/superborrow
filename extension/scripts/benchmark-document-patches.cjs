const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CoreBridge } = require('../dist/src/bridge');
const { DocumentSync } = require('../dist/src/documents');

const root = path.resolve(__dirname, '../..');
const binary = path.join(root, 'extension', 'bin', process.platform === 'win32' ? 'superborrow-core.exe' : 'superborrow-core');
const lines = 6400;
const editsPerStrategy = 100;
const header = Array.from({ length: lines }, (_, index) => `export const currentValue${index} = ${index};\n`).join('');
const doc = { uri: 'file:///synthetic/patches.ts', languageId: 'typescript', version: 1, text: `${header}const marker = 1000;\n` };
const percentile = (sorted, fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];

async function measure() {
  const core = new CoreBridge(binary, () => { throw new Error('Unexpected inference'); });
  try {
    const { capabilities } = await core.initialize();
    assert.equal(capabilities.documentPatches, true);
    let full = 0;
    let patches = 0;
    const sync = new DocumentSync({
      updateDocument(snapshot) { full++; return core.updateDocument(snapshot); },
      patchDocument(patch) { patches++; return core.patchDocument(patch); },
      closeDocument(uri) { return core.closeDocument(uri); },
    }, true);
    await sync.update(doc);
    const statistics = { full: { samples: [], update: [], textBytes: 0 }, patch: { samples: [], update: [], textBytes: 0 } };
    // Interleave strategies on the same core and document to limit timing
    // drift. An eight-edit warm-up leaves the parse and recent history ready.
    for (let index = -8; index < editsPerStrategy * 2; index++) {
      const order = (index + 8) % 4;
      const strategy = order === 0 || order === 3 ? 'full' : 'patch';
      const tally = statistics[strategy];
      const version = doc.version + index + 9;
      const number = String(1000 + index + 9);
      const line = `const marker = ${number};`;
      const snapshot = { ...doc, version, text: `${header}${line}\n` };
      const patch = { uri: doc.uri, baseVersion: version - 1, version,
        start: { line: lines, character: 15 }, end: { line: lines, character: 19 }, text: number };
      const start = performance.now();
      await sync.update(snapshot, strategy === 'patch' ? patch : undefined);
      const updated = performance.now();
      const prepared = await core.prepareIdeCompletion({ uri: doc.uri, version, position: { line: lines, character: line.length }, mode: 'ide' });
      if (index >= 0) {
        tally.update.push(updated - start);
        tally.samples.push(performance.now() - start);
        tally.textBytes += Buffer.byteLength(strategy === 'patch' ? patch.text : snapshot.text);
      }
      assert(prepared.qwenInfill.includes(line));
    }
    assert.equal(full, editsPerStrategy + 5);
    assert.equal(patches, editsPerStrategy + 4);
    return Object.entries(statistics).map(([strategy, { samples, update, textBytes }]) => {
      samples.sort((a, b) => a - b);
      update.sort((a, b) => a - b);
      return { strategy, textBytes, updateP50Ms: percentile(update, .5), p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95) };
    });
  } finally { await core.shutdown(); }
}

(async () => {
  const cases = await measure();
  const report = { scope: 'document update plus prompt preparation, without inference', lines, editsPerStrategy, cases };
  const reportFile = path.join(root, 'packages', `document-patches-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportFile }));
})().catch(error => { console.error(error); process.exitCode = 1; });
