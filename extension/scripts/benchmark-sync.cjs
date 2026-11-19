// Offline RPC benchmark. Never opens an editor or invokes a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CoreBridge } = require('../dist/src/bridge');
const { DocumentSync } = require('../dist/src/documents');
const root = path.resolve(__dirname, '../..');
const body = Array.from({ length: 4096 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n';
const count = 40;
const report = { scope: 'offline-document-sync-burst', synthetic: true, inferenceCalls: 0, editorLaunched: false, updates: count, rounds: 3, cases: [] };
async function measure(strategy, round) {
  let transmissions = 0, bytes = 0;
  const core = new CoreBridge(path.join(root, 'extension/bin/superborrow-core.exe'), async () => { report.inferenceCalls++; throw Error('Inference is forbidden in this benchmark'); });
  try {
    const info = await core.initialize(); report.coreVersion = info.version;
    await core.configure({ ideAvailable: true, debounceMs: 0 });
    const sync = new DocumentSync({ async updateDocument(snapshot) { transmissions++; bytes += Buffer.byteLength(snapshot.text); await core.updateDocument(snapshot); }, closeDocument: uri => core.closeDocument(uri) });
    const doc = { uri: 'file:///synthetic/sync-burst.ts', version: 1, languageId: 'typescript', text: body + 'const latestMarker1 = ' };
    // Establish the initial parse before timing either strategy.
    await sync.update(doc); transmissions = 0; bytes = 0;
    const started = performance.now();
    const pending = [];
    for (let version = 2; version <= count + 1; version++) {
      const snapshot = { ...doc, version, text: body + `const latestMarker${version} = ` };
      // withSnapshot supplies an explicit barrier and the same transmission
      // path, reproducing FIFO's one-RPC-per-version behavior. No model work.
      pending.push(strategy === 'fifo' ? sync.withSnapshot(snapshot, async () => {}) : sync.update(snapshot));
    }
    await Promise.all(pending);
    const drainedMs = performance.now() - started;
    const prepared = await sync.withSnapshot({ ...doc, version: count + 1, text: body + `const latestMarker${count + 1} = ` }, () => core.prepareIdeCompletion({ uri: doc.uri, version: count + 1, position: { line: 4096, character: `const latestMarker${count + 1} = `.length }, mode: 'ide' }));
    assert.equal(prepared.version, count + 1);
    assert.ok(prepared.prompt.includes(`const latestMarker${count + 1} = `));
    assert.equal(transmissions, strategy === 'fifo' ? count : 1);
    return { strategy, round, drainedMs: Math.round(drainedMs * 100) / 100, transmissions, sourceBytesSent: bytes, latestVersion: prepared.version, latestContextVerified: true };
  } finally { await core.shutdown(); }
}
(async () => {
  for (let round = 0; round < report.rounds; round++) {
    for (const strategy of round % 2 ? ['coalesced', 'fifo'] : ['fifo', 'coalesced']) {
      const value = await measure(strategy, round); report.cases.push(value); console.log(JSON.stringify(value));
    }
  }
  assert.equal(report.inferenceCalls, 0); report.passed = true;
  const filename = path.join(root, 'packages', `sync-benchmark-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(report, null, 2)); console.log(filename);
})().catch(error => { console.error(error); process.exitCode = 1; });
