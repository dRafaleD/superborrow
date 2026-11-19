const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const app = args[args.indexOf('--app') + 1];
if (!args.includes('--app') || !['cursor', 'antigravity', 'duskline'].includes(app)) throw new Error('Usage: node scripts/benchmark-editor.cjs --app cursor|antigravity|duskline [--describe]');
const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'packages', `editor-benchmark-${app}-${Date.now()}`);
const portable = path.join(directory, 'portable');
const profile = app === 'duskline' ? path.join(portable, 'user-data') : path.join(directory, 'profile');
const extensions = path.join(app === 'duskline' ? portable : directory, 'extensions');
const fixtures = path.join(directory, 'fixtures');
const report = path.join(directory, 'report.json');
const local = process.env.LOCALAPPDATA || '';
const exe = {
  cursor: path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
  antigravity: process.env.SUPERBORROW_IDE || path.join(local, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
  duskline: process.env.SUPERBORROW_DUSKLINE || path.resolve(root, '../deimoside/runtime/duskline/Duskline.exe'),
}[app];
const cli = path.join(path.dirname(exe), 'resources', 'app', 'out', 'cli.js');
const appArgs = app === 'duskline' ? ['--disable-telemetry', '--disable-background-networking'] : [cli, '--wait'];
const commandArgs = [...appArgs, ...(app === 'cursor' ? ['--classic'] : []), '--user-data-dir', profile, '--extensions-dir', extensions, '--extensionDevelopmentPath', path.join(root, 'extension'), '--extensionTestsPath', path.join(root, 'extension', 'dist', 'test', 'host', 'editor-latency.js'), '--new-window', '--skip-welcome', '--skip-release-notes'];
const settings = {
  'superborrow.enabled': app !== 'cursor', 'superborrow.mode': 'ide', 'superborrow.ideModel': 'auto',
  'superborrow.corePath': path.join(root, 'extension', 'bin', process.platform === 'win32' ? 'superborrow-core.exe' : 'superborrow-core'),
  'editor.inlineSuggest.enabled': false, 'editor.quickSuggestions': false, 'editor.wordBasedSuggestions': 'off',
  'editor.suggestOnTriggerCharacters': false, 'editor.formatOnType': false, 'editor.formatOnSave': false,
  'files.autoSave': 'off'
};
if (app === 'duskline') {
  settings['duskline.tabModel'] = process.env.SUPERBORROW_DUSKLINE_MODEL || 'qwen2.5-coder:0.5b';
  settings['chat.disableAIFeatures'] = true;
}
settings['window.title'] = 'Superborrow isolated test';
if (args.includes('--describe')) {
  process.stdout.write(JSON.stringify({ app, executable: exe, arguments: commandArgs, profileSettings: settings, fixtures, report, userProfileCopied: false, userExtensionsIsolated: true, authenticationAutomation: false, syntheticOnly: true }, null, 2) + '\n');
} else {
  if (!fs.existsSync(exe) || (app !== 'duskline' && !fs.existsSync(cli))) throw new Error('Installed editor CLI is missing');
  if (app !== 'cursor' && !fs.existsSync(settings['superborrow.corePath'])) throw new Error('Build the packaged core before running this benchmark');
  const testModule = path.join(root, 'extension', 'dist', 'test', 'host', 'editor-latency.js');
  if (!fs.existsSync(testModule)) throw new Error('Compile the extension before running the editor benchmark');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true }); fs.mkdirSync(extensions, { recursive: true });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  const env = { ...process.env, SUPERBORROW_EDITOR_TARGET: app, SUPERBORROW_EDITOR_FIXTURES: fixtures, SUPERBORROW_LIVE_REPORT: report, SUPERBORROW_EDITOR_FOCUS_SETUP: args.includes('--focus-setup') ? 'true' : 'false' };
  delete env.VSCODE_PORTABLE;
  delete env.VSCODE_IPC_HOOK_CLI;
  delete env.NODE_OPTIONS;
  if (app === 'duskline') {
    delete env.ELECTRON_RUN_AS_NODE;
    env.VSCODE_PORTABLE = portable;
    env.DUSKLINE_OLLAMA_EXE ||= path.join(local, 'Programs', 'Ollama', 'ollama.exe');
  } else env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(exe, commandArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.resume(); child.stderr.resume();
  let seen = 0, finished = false;
  const poll = setInterval(() => {
    try {
      if (!fs.existsSync(report)) return;
      const value = JSON.parse(fs.readFileSync(report, 'utf8'));
      for (const item of (value.cases || []).slice(seen)) process.stdout.write(JSON.stringify(item) + '\n');
      seen = value.cases?.length || 0;
      if (value.completed) {
        finished = true; clearInterval(poll); clearTimeout(timer);
        process.stdout.write(JSON.stringify({ passed: value.passed, blocked: value.blocked, error: value.error, report }) + '\n');
        process.exitCode = value.passed ? 0 : 1; child.unref(); child.stdout.destroy(); child.stderr.destroy();
      }
    } catch { /* Report writes can be observed midway. */ }
  }, 500);
  const timer = setTimeout(() => { clearInterval(poll); child.kill(); process.stderr.write(`Observation timed out; inspect the owned editor profile before retrying. Report: ${report}\n`); process.exitCode = 1; }, 180000);
  child.on('error', error => { clearInterval(poll); clearTimeout(timer); process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
  child.on('exit', code => { if (!finished && code) { clearInterval(poll); clearTimeout(timer); process.stderr.write(`Editor CLI exited ${code}. Report: ${report}\n`); process.exitCode = 1; } });
}
