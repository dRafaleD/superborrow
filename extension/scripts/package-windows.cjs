const { execFileSync } = require('node:child_process');
const { mkdirSync, copyFileSync } = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This packaging command requires Windows x64.');
}
const extension = path.resolve(__dirname, '..');
const root = path.resolve(extension, '..');
const version = require(path.join(extension, 'package.json')).version;
execFileSync('cargo', ['build', '--release', '--manifest-path', path.join(root, 'core-rust', 'Cargo.toml')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(extension, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', extension], { stdio: 'inherit' });
mkdirSync(path.join(extension, 'bin'), { recursive: true });
mkdirSync(path.join(root, 'packages'), { recursive: true });
copyFileSync(path.join(root, 'core-rust', 'target', 'release', 'superborrow-core.exe'), path.join(extension, 'bin', 'superborrow-core.exe'));
copyFileSync(path.join(root, 'LICENSE'), path.join(extension, 'LICENSE'));
execFileSync(process.execPath, [path.join(extension, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--target', 'win32-x64', '--out', path.join(root, 'packages', `superborrow-${version}-win32-x64.vsix`)], { cwd: extension, stdio: 'inherit' });
