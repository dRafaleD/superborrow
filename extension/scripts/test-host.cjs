const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const benchmark = process.argv.includes('--benchmark');
const nativeProbe = process.argv.includes('--native-probe');
const contextBenchmark = process.argv.includes('--context-benchmark');
const diagnosticsTest = process.argv.includes('--diagnostics-test');
const speculativeTest = process.argv.includes('--speculative-test');
const report = path.join(root, 'packages', `host-live-${Date.now()}.json`);
const profile = path.join(root, 'packages', `host-live-profile-${Date.now()}`);
const ide = process.env.SUPERBORROW_IDE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe');
const cli = path.join(path.dirname(ide), 'resources', 'app', 'out', 'cli.js');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
// This is an isolated test profile inside packages/, never the user's profile.
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'superborrow.corePath': path.join(root, 'core-rust', 'target', 'debug', process.platform === 'win32' ? 'superborrow-core.exe' : 'superborrow-core'),
  'superborrow.enabled': !nativeProbe && !contextBenchmark, 'superborrow.mode': 'ide', 'superborrow.hybridPreference': 'ide', 'superborrow.ideModel': 'auto',
  'superborrow.localApi': 'ollama', 'superborrow.endpoint': 'http://127.0.0.1:11434/api/generate', 'superborrow.model': 'qwen2.5-coder:7b',
  'superborrow.maxTokens': 128, 'superborrow.maxContextBytes': 24000, 'superborrow.requestTimeoutMs': 10000, 'superborrow.debounceMs': 60,
  'editor.inlineSuggest.enabled': !benchmark
}, null, 2));
const testModule = speculativeTest ? 'speculative-live.js' : diagnosticsTest ? 'diagnostics-live.js' : contextBenchmark ? 'context-benchmark.js' : nativeProbe ? 'native-probe.js' : benchmark ? 'benchmark.js' : 'live.js';
const child = spawn(ide, [cli, '--user-data-dir', profile, '--extensionDevelopmentPath', path.join(root, 'extension'), '--extensionTestsPath', path.join(root, 'extension', 'dist', 'test', 'host', testModule), '--new-window', '--skip-welcome', '--skip-release-notes', '--wait'], {
  windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SUPERBORROW_LIVE_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe']
});
let seen = 0;
child.stdout.resume(); child.stderr.resume();
let finished = false;
const poll = setInterval(() => {
  try {
    if (!fs.existsSync(report)) return;
    const state = JSON.parse(fs.readFileSync(report, 'utf8'));
    for (const result of (state.cases || []).slice(seen)) process.stdout.write(JSON.stringify(result) + '\n');
    seen = state.cases?.length || 0;
    if (state.completed) {
      finished = true; clearInterval(poll); clearTimeout(timeout);
      process.stdout.write(JSON.stringify({ passed: state.passed, error: state.error, report }) + '\n');
      process.exitCode = state.passed ? 0 : 1;
      child.unref(); child.stdout.destroy(); child.stderr.destroy();
    }
  } catch { /* A report can be rewritten between filesystem reads. */ }
}, 500);
const timeout = setTimeout(() => {
  clearInterval(poll); child.kill(); process.stderr.write(`Live editor test timed out. Report: ${report}\n`); process.exitCode = 1;
}, benchmark ? 240000 : 180000);
child.on('error', error => { clearInterval(poll); clearTimeout(timeout); process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
child.on('exit', code => { if (!finished && code) { clearInterval(poll); clearTimeout(timeout); process.stderr.write(`Editor test process exited ${code}. Report: ${report}\n`); process.exitCode = 1; } });
