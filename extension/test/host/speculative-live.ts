import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { activate } from "../../src/extension";

/** Same-model before/after typing observations through the real provider.
 * Synthetic source only; timings include the actual provider callback.
 */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { completed: false, passed: false, scope: "inflight-typing-before-after", cases };
  const save = () => writeFileSync(process.env.SUPERBORROW_LIVE_REPORT!, JSON.stringify(report, null, 2));
  const config = vscode.workspace.getConfiguration("superborrow");
  const previous = config.get<boolean>("speculativeTyping", true);
  const logUri = vscode.Uri.parse("superborrow-test-log:/synthetic");
  const logChanged = new vscode.EventEmitter<vscode.Uri>();
  let logText = "synthetic log 0";
  let logSequence = 0;
  const logProvider = vscode.workspace.registerTextDocumentContentProvider(logUri.scheme, { onDidChange: logChanged.event, provideTextDocumentContent: () => logText });
  try {
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", false, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<ReturnType<typeof activate>>("superborrow-dev.superborrow")!;
    const api = await extension.activate(); await api.ready;
    const deadline = Date.now() + 40000;
    while ((!api.getStatus().ideAvailable || !api.getStatus().connected) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.getStatus().preparedIdeAvailable, true);
    report.coreVersion = api.getStatus().coreVersion; report.model = api.getStatus().model;
    await vscode.workspace.openTextDocument(logUri);
    const appendLog = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { subscription.dispose(); reject(new Error("Synthetic log update timed out")); }, 2000);
      const subscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === logUri.toString()) { clearTimeout(timer); subscription.dispose(); resolve(); }
      });
      logText = `synthetic log ${++logSequence}`; logChanged.fire(logUri);
    });
    let wins = 0;
    for (let round = 0; round < 2; round++) for (const enabled of round ? [false, true] : [true, false]) {
      await config.update("speculativeTyping", enabled, vscode.ConfigurationTarget.Global);
      await new Promise(resolve => setTimeout(resolve, 100));
      const readyDeadline = Date.now() + 5000;
      while (!api.getStatus().connected && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      const prefix = `def sum_pair_${round}_${enabled ? "prediction" : "baseline"}(a: int, b: int) -> int:\n    # Return the sum of the two parameters.\n    return a`;
      const doc = await vscode.workspace.openTextDocument({ language: "python", content: prefix + "\n" });
      const context = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
      const position = doc.positionAt(prefix.length);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(position, position);
      const before = api.getStatus();
      let oldToken: vscode.CancellationTokenSource | undefined;
      let oldPromise: PromiseLike<unknown> | undefined;
      let oldFinished = false;
      let discardedAttempts = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        oldToken?.dispose(); oldToken = new vscode.CancellationTokenSource(); oldFinished = false;
        const requests = api.getStatus().modelRequests;
        oldPromise = Promise.resolve(api.provideInlineCompletionItems(doc, position, context, oldToken.token)).then(value => { oldFinished = true; return value; });
        const startDeadline = Date.now() + 5000;
        while (!oldFinished && api.getStatus().modelRequests === requests && Date.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        const beforeLog = api.getStatus().ignoredDocumentChanges;
        await appendLog();
        assert.ok(api.getStatus().ignoredDocumentChanges > beforeLog, "An excluded virtual document must not invalidate the code prediction");
        const ignoredBefore = api.getStatus().ignoredCursorRequests;
        const staleToken = new vscode.CancellationTokenSource();
        try {
          const stale = await api.provideInlineCompletionItems(doc, new vscode.Position(0, 0), context, staleToken.token);
          const staleItems = Array.isArray(stale) ? stale : stale?.items;
          assert.ok(!staleItems?.length);
          assert.equal(api.getStatus().ignoredCursorRequests, ignoredBefore + 1, "A stale cursor request must not supersede the actual caret prediction");
        } finally { staleToken.dispose(); }
        await new Promise(resolve => setTimeout(resolve, 500));
        if (oldFinished) {
          const response = await oldPromise as vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined;
          const items = Array.isArray(response) ? response : response?.items;
          if (items?.length) break;
          if (!/cancel|obsolete|context changed/i.test(api.getStatus().lastDiscardReason ?? "") || attempt === 3) throw new Error(JSON.stringify(api.getStatus()));
        } else break;
        discardedAttempts++; await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(oldToken && oldPromise);
      const wasPendingAtEdit = !oldFinished;
      // Use an actual visible editor and keep its selection aligned with the
      // factory request; hidden documents otherwise attract host cursor-0 calls.
      assert.equal(await editor.edit(builder => builder.insert(position, " ")), true);
      assert.equal(doc.getText(), prefix + " \n");
      oldToken.cancel(); await oldPromise; oldToken.dispose();
      const latest = doc.positionAt(prefix.length + 1);
      editor.selection = new vscode.Selection(latest, latest);
      assert.equal(editor.selection.active.isEqual(latest), true);
      const token = new vscode.CancellationTokenSource();
      const started = performance.now();
      let peakPending = api.getStatus().speculative.pending;
      const poll = setInterval(() => { peakPending = Math.max(peakPending, api.getStatus().speculative.pending); }, 5);
      try {
        const response = await api.provideInlineCompletionItems(doc, latest, context, token.token);
        const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
        const items = Array.isArray(response) ? response : response?.items;
        assert.ok(items?.length, JSON.stringify(api.getStatus()));
        const suggestion = String(items[0].insertText);
        assert.match(suggestion.trim(), /^\+\s*b$/);
        assert.equal(items[0].range?.start.character, latest.character);
        const after = api.getStatus();
        const speculativeWin = after.speculative.hits > before.speculative.hits;
        if (speculativeWin) wins++;
        assert.ok(peakPending <= 2);
        cases.push({ name: enabled ? "speculation enabled" : "version-bound baseline", round, enabled, passed: true, wasPendingAtEdit, speculativeWin, discardedAttempts, modelRequests: after.modelRequests - before.modelRequests, peakPending, ignoredDocumentChanges: after.ignoredDocumentChanges - before.ignoredDocumentChanges, ignoredCursorRequests: after.ignoredCursorRequests - before.ignoredCursorRequests, lastIgnoredScheme: after.lastIgnoredScheme, waitAfterEditMs: elapsedMs, lastModelMs: after.lastLatencyMs, suggestion }); save();
      } finally { clearInterval(poll); token.dispose(); }
    }
    report.observedSpeculativeWins = wins;
    report.passed = wins > 0;
    if (!wins) report.error = "No in-flight speculative win observed; inspect cache hits or fresh-request winners instead of claiming a speedup.";
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally { logProvider.dispose(); logChanged.dispose(); await config.update("speculativeTyping", previous, vscode.ConfigurationTarget.Global); report.completed = true; save(); }
}
