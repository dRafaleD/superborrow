const path = require('node:path');
const { CoreBridge } = require('../dist/src/bridge');

async function main() {
  const core = process.env.SUPERBORROW_CORE || path.resolve(__dirname, '../../core-rust/target/debug', process.platform === 'win32' ? 'superborrow-core.exe' : 'superborrow-core');
  const bridge = new CoreBridge(core, async () => { throw new Error('Local smoke test must not use IDE'); });
  try {
    await bridge.initialize();
    await bridge.configure({ localApi: 'ollama', endpoint: 'http://127.0.0.1:11434/api/generate', model: process.env.SUPERBORROW_MODEL || 'qwen2.5-coder:7b', debounceMs: 0, requestTimeoutMs: 120000, maxTokens: 32, maxContextBytes: 4096 });
    await bridge.updateDocument({ uri: 'untitled:smoke.py', version: 1, languageId: 'python', text: 'def add(a: int, b: int) -> int:\n    return \n' });
    const results = [];
    for (let run = 0; run < 2; run++) {
      const answer = await bridge.requestCompletion({ uri: 'untitled:smoke.py', version: 1, position: { line: 1, character: 11 }, mode: 'local', explicit: true });
      if (!answer.text.trim() || answer.provider !== 'local') throw new Error('No local completion returned');
      results.push({ run: run + 1, ...answer });
    }
    process.stdout.write(JSON.stringify({ model: process.env.SUPERBORROW_MODEL || 'qwen2.5-coder:7b', results }, null, 2) + '\n');
  } finally { await bridge.shutdown(); }
}
main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
