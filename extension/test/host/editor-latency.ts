import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { activate } from '../../src/extension';
import { checkEditorSource, editorCorpusDigest, editorCorpusVersion, editorFixtures } from '../editor-corpus';

/** Needs explicit authorization before launching Cursor. Uses only a fresh
 * profile and synthetic files; never reads/copies account storage or signs in.
 */
export async function run(): Promise<void> {
  const app = process.env.SUPERBORROW_EDITOR_TARGET;
  const directory = process.env.SUPERBORROW_EDITOR_FIXTURES!;
  const reportPath = process.env.SUPERBORROW_LIVE_REPORT!;
  const rounds = 2;
  const acceptancePollingMs = 60;
  const cases: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { completed: false, passed: false, scope: 'editor-acceptance-latency-v1', app, appName: vscode.env.appName, rounds, corpusVersion: editorCorpusVersion, corpusDigest: editorCorpusDigest(rounds), cases };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
  let api: Awaited<ReturnType<typeof activate>> | undefined;
  let nativeManaged = false;
  let focusLosses = 0;
  const notReady = (stage: string, message: string): never => { throw Object.assign(new Error(message), { code: 'BENCHMARK_READINESS', stage }); };
  const focusListener = vscode.window.onDidChangeWindowState(state => { if (!state.focused) focusLosses++; });
  const requireFocus = (expectedLosses = focusLosses) => {
    report.windowFocused = vscode.window.state.focused;
    report.windowFocusLosses = focusLosses;
    if (!vscode.window.state.focused || focusLosses !== expectedLosses) {
      notReady('focus', 'The isolated test window is not focused or lost focus during measurement. No foreground switching is automated; run only when this test window can remain focused.');
    }
  };
  try {
    const normalizePath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.ok(normalizePath(directory).startsWith(normalizePath(path.resolve(__dirname, '../../../../packages')) + path.sep), 'Fixture files must stay inside workspace packages/');
    assert.ok(app === 'cursor' || app === 'antigravity' || app === 'duskline');
    assert.equal(vscode.workspace.isTrusted, true, 'Do not bypass workspace trust for this benchmark');
    requireFocus();
    const command = app === 'cursor' ? 'editor.action.acceptCppSuggestion' : 'editor.action.inlineSuggest.commit';
    const commands = await vscode.commands.getCommands(true);
    if (![command, 'type', 'workbench.action.focusActiveEditorGroup'].every(value => commands.includes(value))) notReady('commands', 'Required public editor actions are unavailable; no latency sample can be measured.');
    report.acceptanceCommand = command;
    const extension = vscode.extensions.getExtension<ReturnType<typeof activate>>('superborrow-dev.superborrow')!;
    api = await extension.activate(); await api.ready;
    if (app === 'cursor') {
      assert.match(vscode.env.appName, /cursor/i);
      assert.equal(api.getStatus().enabled, false);
      const builtinRoot = normalizePath(path.resolve(vscode.env.appRoot, 'extensions')) + path.sep;
      const developmentRoot = normalizePath(extension.extensionPath);
      const foreign = vscode.extensions.all.filter(value => !normalizePath(value.extensionPath).startsWith(builtinRoot) && normalizePath(value.extensionPath) !== developmentRoot).map(value => value.id);
      assert.deepEqual(foreign, [], 'Non-built-in extensions would contaminate the native Cursor baseline');
    } else if (app === 'antigravity') {
      const deadline = Date.now() + 40000;
      while (!api.getStatus().ideAvailable && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(api.getStatus().ideAvailable, true);
      await vscode.commands.executeCommand('superborrow.enableCompositeTab'); nativeManaged = true;
      assert.equal(api.getStatus().nativeTabManaged, true);
      report.model = api.getStatus().model; report.coreVersion = api.getStatus().coreVersion;
    } else {
      assert.match(vscode.env.appName, /duskline/i);
      assert.ok(api.getStatus().connected && api.getStatus().ideAvailable, 'Duskline local model did not become ready');
      report.model = api.getStatus().model; report.coreVersion = api.getStatus().coreVersion;
    }
    report.editorVersion = JSON.parse(readFileSync(path.join(vscode.env.appRoot, 'package.json'), 'utf8')).version;
    mkdirSync(directory, { recursive: true });
    for (let round = 0; round < rounds; round++) for (const fixture of editorFixtures(round)) {
      requireFocus();
      await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', false, vscode.ConfigurationTarget.Global);
      const filename = path.join(directory, `${round}-${fixture.id}.${fixture.extension}`);
      writeFileSync(filename, fixture.prefix.slice(0, -1) + fixture.suffix);
      const doc = await vscode.workspace.openTextDocument(filename);
      assert.equal(doc.languageId, fixture.language, 'Fixture language must match in both editors');
      const editor = await vscode.window.showTextDocument(doc);
      if (!cases.length && process.env.SUPERBORROW_EDITOR_FOCUS_SETUP === 'true') {
        report.setup = 'The owned synthetic editor is open; allow 60 seconds for focus inspection before timing.'; save();
        await new Promise(resolve => setTimeout(resolve, 60000));
      }
      if (doc.getText() !== fixture.prefix.slice(0, -1) + fixture.suffix) notReady('fixture', 'The owned synthetic fixture changed during setup; no typing or latency measurement will be attempted.');
      requireFocus();
      // Focus only the editor group inside this already focused, isolated
      // test window. Never bring an application/window to the foreground.
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      requireFocus();
      const position = doc.positionAt(fixture.prefix.length - 1);
      editor.selection = new vscode.Selection(position, position);
      // Let the editor process the fixture's initial selection before enabling
      // suggestions; this setup delay is outside the measured typing interval.
      await new Promise(resolve => setTimeout(resolve, 100));
      requireFocus();
      await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
      const acceptedBefore = api.getStatus().acceptedCount;
      const requestsBefore = api.getStatus().modelRequests;
      const focusLossesBefore = focusLosses;
      const started = performance.now();
      assert.equal(vscode.window.activeTextEditor?.document, doc);
      await vscode.commands.executeCommand('type', { text: fixture.prefix.at(-1)! });
      // The command returns before model/selection notifications reach the
      // extension host. Observe the actual edit instead of assuming RPC return
      // means the extension's TextDocument has already changed.
      const editDeadline = Date.now() + 1000;
      while ((doc.getText() !== fixture.prefix + fixture.suffix || !editor.selection.active.isEqual(doc.positionAt(fixture.prefix.length))) && Date.now() < editDeadline) {
        requireFocus(focusLossesBefore);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (doc.getText() !== fixture.prefix + fixture.suffix) {
        report.inputState = { command: 'type', documentChanged: doc.getText() !== fixture.prefix.slice(0, -1) + fixture.suffix, version: doc.version };
        notReady('input', 'The public typing command did not produce the expected synthetic edit. This is unavailable fixture input, not a model quality or latency result.');
      }
      const cursor = doc.positionAt(fixture.prefix.length);
      assert.ok(editor.selection.isEmpty && editor.selection.active.isEqual(cursor), 'Typing did not leave the expected fixture cursor');
      const sourceBefore = doc.getText();
      const deadline = Date.now() + 12000;
      while (doc.getText() === sourceBefore && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, acceptancePollingMs));
        requireFocus(focusLossesBefore);
        assert.equal(vscode.window.activeTextEditor?.document, doc, 'A jump to another file is not an insertion-fixture acceptance');
        await vscode.commands.executeCommand(command);
      }
      const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      requireFocus(focusLossesBefore);
      const accepted = doc.getText() !== sourceBefore;
      if (!accepted) {
        cases.push({ name: fixture.id, round, accepted: false, passed: false, status: 'unavailable', observationLimitMs: 12000, providerStatus: api.getStatus() });
        report.blocked = 'No native suggestion accepted within the observation limit. Cause is undetermined; do not infer account/quota failure, model latency or correctness from this observation.';
        save(); return;
      }
      const source = doc.getText().replace(/\r\n/g, '\n');
      const passed = await checkEditorSource(source, fixture.quality, fixture.expectedName);
      if (app !== 'cursor') assert.ok(api.getStatus().acceptedCount > acceptedBefore, 'Suggestion came from another provider');
      else assert.equal(api.getStatus().modelRequests, 0, 'Superborrow must not generate in the native Cursor baseline');
      cases.push({ name: fixture.id, round, accepted, passed, editToAcceptedMs: elapsedMs, acceptancePollingMs, generatedModelRequests: api.getStatus().modelRequests - requestsBefore, source }); save();
      assert.equal(await doc.save(), true, 'Save only this owned synthetic fixture before closing');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    report.passed = cases.length === 6 && cases.every(value => value.accepted && value.passed);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string })?.code === 'BENCHMARK_READINESS') {
      report.blocked = report.error; report.failureKind = 'readiness';
      report.readinessStage = (error as { stage?: string }).stage;
    }
  }
  finally {
    focusListener.dispose();
    try { if (nativeManaged) await vscode.commands.executeCommand('superborrow.restoreNativeTab'); }
    catch (error) { report.restoreError = String(error); report.passed = false; }
    finally { report.completed = true; save(); }
  }
}
