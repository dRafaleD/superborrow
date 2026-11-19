import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { activate } from "../../src/extension";

/** Synthetic diagnostics through the actual extension provider and model. */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { completed: false, passed: false, scope: "diagnostic-context-and-cache", cases };
  const save = () => writeFileSync(process.env.SUPERBORROW_LIVE_REPORT!, JSON.stringify(report, null, 2));
  const collection = vscode.languages.createDiagnosticCollection("superborrow-synthetic-quality");
  try {
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", false, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<ReturnType<typeof activate>>("superborrow-dev.superborrow")!;
    const api = await extension.activate();
    await api.ready;
    const deadline = Date.now() + 40000;
    while (!api.getStatus().ideAvailable && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(api.getStatus().connected, true);
    assert.equal(api.getStatus().ideAvailable, true);
    assert.equal(api.getStatus().preparedIdeAvailable, true);
    report.coreVersion = api.getStatus().coreVersion;
    report.model = api.getStatus().model;
    const prefix = "interface Item { [key: string]: string; }\nfunction labelFor(item: Item): string {\n  return item.";
    const doc = await vscode.workspace.openTextDocument({ language: "typescript", content: prefix + ";\n}\n" });
    const position = doc.positionAt(prefix.length);
    const fixtureEditor = await vscode.window.showTextDocument(doc);
    fixtureEditor.selection = new vscode.Selection(position, position);
    const version = doc.version;
    const range = new vscode.Range(new vscode.Position(2, 2), position);
    const publish = (field: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { subscription.dispose(); reject(new Error("Diagnostic event timed out")); }, 2000);
      const subscription = vscode.languages.onDidChangeDiagnostics(event => {
        if (event.uris.some(uri => uri.toString() === doc.uri.toString())) { clearTimeout(timer); subscription.dispose(); resolve(); }
      });
      collection.set(doc.uri, [new vscode.Diagnostic(range, `Property 'text' does not exist on Item. Did you mean '${field}'?`, vscode.DiagnosticSeverity.Error)]);
    });
    const suggest = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const token = new vscode.CancellationTokenSource();
        try {
          const response = await api.provideInlineCompletionItems(doc, position, { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token);
          const items = Array.isArray(response) ? response : response?.items;
          if (items?.length) return { text: String(items[0].insertText).trim(), discardedAttempts: attempt };
          if (!/cancel|obsolete|context changed/i.test(api.getStatus().lastDiscardReason ?? "") || attempt === 3) throw new Error(JSON.stringify(api.getStatus()));
        } finally { token.dispose(); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("No suggestion");
    };
    await publish("displayLabelA");
    const first = await suggest();
    assert.equal(first.text, "displayLabelA");
    const beforeCache = api.getStatus().modelRequests;
    assert.equal((await suggest()).text, "displayLabelA");
    assert.equal(api.getStatus().modelRequests, beforeCache);
    cases.push({ name: "diagnostic hint reaches the real IDE model and identical context is cached", passed: true, ...first }); save();
    await publish("displayLabelB");
    const second = await suggest();
    assert.equal(second.text, "displayLabelB");
    assert.equal(doc.version, version, "Only diagnostics changed, not source");
    assert.ok(api.getStatus().modelRequests > beforeCache, "Changed diagnostic must invalidate the old suggestion");
    cases.push({ name: "diagnostic change invalidates suggestions without a text/version change", passed: true, ...second, additionalModelRequests: api.getStatus().modelRequests - beforeCache });
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally { collection.dispose(); report.completed = true; save(); }
}
