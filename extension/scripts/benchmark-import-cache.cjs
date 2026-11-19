// Offline comparison against the resolver extracted from the immutable 0.3.7
// VSIX. Never opens an editor, runs generated code or calls a model.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const { LocalImports: Baseline } = require(path.join(root, 'packages/import-cache-baseline-0.3.7/imports.js'));
const { LocalImports: Candidate } = require('../dist/src/imports');
(async () => {
  const directory = path.join(root, 'packages', `import-cache-benchmark-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const active = path.join(directory, 'active.ts');
  await fs.writeFile(active, '');
  await fs.writeFile(path.join(directory, 'api.ts'), 'export interface API { amountCents: number }\n' + '// synthetic dependency\n'.repeat(2000));
  const source = "import { API } from './api';\n" + '// unchanged body context\n'.repeat(600) + 'function amount(api: API) { return api.';
  const report = { scope: 'offline-import-cache-typing', baselineVersion: '0.3.7', candidateVersion: require('../package.json').version, edits: 10, rounds: 3, editorLaunched: false, inferenceCalls: 0, sourceBytes: Buffer.byteLength(source), baselineVSIXSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'packages/superborrow-0.3.7-win32-x64.vsix'))).digest('hex'), cases: [] };
  const originalOpen = fs.open;
  try {
    for (let round = 0; round < report.rounds; round++) {
      for (const strategy of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        let opens = 0;
        fs.open = async (...args) => { opens++; return originalOpen(...args); };
        const resolver = strategy === 'baseline' ? new Baseline() : new Candidate();
        const started = performance.now();
        for (let edit = 0; edit < report.edits; edit++) {
          const references = await resolver.resolve(active, source + 'x'.repeat(edit), directory, [], new AbortController().signal);
          assert.equal(references.length, 1); assert.match(references[0].text, /amountCents/);
        }
        const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
        assert.equal(opens, strategy === 'baseline' ? 10 : 1);
        report.cases.push({ strategy, round, elapsedMs, dependencyOpenCalls: opens, allReferencesCorrect: true });
      }
    }
  } finally { fs.open = originalOpen; }
  report.passed = true;
  const filename = path.join(directory, 'report.json'); await fs.writeFile(filename, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); console.log(filename);
})().catch(error => { console.error(error); process.exitCode = 1; });
