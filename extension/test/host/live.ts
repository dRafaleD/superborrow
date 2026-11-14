import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { activate } from "../../src/extension";
import { ModelBridge } from "../../src/models";

/** Opt-in real-account tests. Run with scripts/test-host.cjs, never offline CI. */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  let compositeEnabled = false;
  const report: Record<string, unknown> = { completed: false, passed: false, app: vscode.env.appName, trusted: vscode.workspace.isTrusted, cases };
  const save = () => writeFileSync(process.env.SUPERBORROW_LIVE_REPORT!, JSON.stringify(report, null, 2));
  const runCase = async (name: string, work: () => Promise<Record<string, unknown>>) => {
    const start = Date.now();
    try { cases.push({ name, passed: true, ...await work(), elapsedMs: Date.now() - start }); save(); }
    catch (error) { cases.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); save(); throw error; }
  };
  try {
    assert.equal(vscode.workspace.isTrusted, true, "Test host should be an empty trusted window; do not disable workspace trust");
    const extension = vscode.extensions.getExtension<ReturnType<typeof activate>>("superborrow-dev.superborrow");
    assert.ok(extension);
    const api = await extension.activate();
    await api.ready;
    report.startup = api.getStatus(); save();
    assert.equal(api.getStatus().connected, true);
    assert.equal(api.getStatus().ideAvailable, true);
    assert.equal(api.getStatus().coreVersion, "0.3.0");
    await vscode.commands.executeCommand("superborrow.enableCompositeTab");
    compositeEnabled = true;
    assert.equal(api.getStatus().nativeTabManaged, true);

    const samples = [
      { language: "python", text: "def add(a: int, b: int) -> int:\n    return ", pattern: /a\s*\+\s*b/ },
      { language: "typescript", text: "function add(a: number, b: number): number {\n  return ", pattern: /a\s*\+\s*b/ },
      { language: "go", text: "func add(a int, b int) int {\n    return ", pattern: /a\s*\+\s*b/ },
      { language: "rust", text: "fn add(a: i32, b: i32) -> i32 {\n    ", pattern: /a\s*\+\s*b/ },
      { language: "java", text: "public static int add(int a, int b) {\n    return ", pattern: /a\s*\+\s*b/ },
      { language: "sql", text: "-- select the integer 42\nSELECT ", pattern: /42/ },
      { language: "html", text: "<!-- add an accessible primary button labelled Save -->\n", pattern: /<button\b/i },
      { language: "javascript", text: "// toplama fonksiyonu oluştur\n", pattern: /function|=>/ },
      { language: "python", text: "# iki sayıyı toplayan bir fonksiyon oluştur\n", pattern: /def\s+/ },
      { language: "css", text: "/* arka planı siyah, yazıları beyaz yap */\n", pattern: /background|color/ },
    ];
    for (const sample of samples) {
      await runCase(`${sample.language}: ${sample.text.startsWith("//") || sample.text.startsWith("#") || sample.text.startsWith("/*") ? "Turkish comment intent" : "automatic inline completion"}`, async () => {
        const doc = await vscode.workspace.openTextDocument({ language: sample.language, content: sample.text });
        const position = doc.positionAt(sample.text.length);
        let activeSubscription: vscode.Disposable | undefined;
        const activated = new Promise<void>(resolve => {
          activeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor?.document === doc) resolve();
          });
        });
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        await activated; activeSubscription?.dispose();
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
        let list: vscode.InlineCompletionItem[] | undefined;
        let discardedAttempts = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          await vscode.window.showTextDocument(doc, { preview: true });
          const cancellation = new vscode.CancellationTokenSource();
          try {
            const items = await api.provideInlineCompletionItems(doc, position, { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined }, cancellation.token);
            list = Array.isArray(items) ? items : items?.items;
          } finally { cancellation.dispose(); }
          if (list?.length || !/cancel|obsolete|context changed/i.test(api.getStatus().lastDiscardReason ?? "")) break;
          // Language extensions can change the active editor during activation.
          // Only a verified cancellation is retried; provider errors/empty output fail.
          discardedAttempts++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(list?.length, `No ${sample.language} suggestion: ${JSON.stringify(api.getStatus())}`);
        const value = typeof list[0].insertText === "string" ? list[0].insertText : list[0].insertText.value;
        assert.match(value, sample.pattern);
        assert.equal(api.getStatus().lastProvider, "ide");
        return { language: doc.languageId, provider: api.getStatus().lastProvider, model: api.getStatus().model, discardedAttempts, outputBytes: Buffer.byteLength(value), suggestion: value };
      });
    }

    await runCase("automatic edit trigger and standard Tab acceptance command", async () => {
      const acceptedBefore = api.getStatus().acceptedCount;
      const doc = await vscode.workspace.openTextDocument({ language: "python", content: "def add(a, b):\n    return" });
      const editor = await vscode.window.showTextDocument(doc);
      const position = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(position, position);
      await editor.edit(edit => edit.insert(position, " "));
      const before = doc.getText();
      const deadline = Date.now() + 20000;
      while (doc.getText() === before && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // This is the same commit command used by the host Tab binding for ghost text.
        await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
      }
      assert.notEqual(doc.getText(), before, "Automatic ghost text was not committed in the editor");
      assert.match(doc.getText(), /a\s*\+\s*b/);
      assert.ok(api.getStatus().acceptedCount > acceptedBefore, "A different provider's suggestion was accepted instead of Superborrow's");
      assert.equal(api.getStatus().lastAccepted?.provider, "ide");
      return { accepted: true, text: doc.getText(), acceptance: api.getStatus().lastAccepted };
    });

    await runCase("a second Antigravity model uses the same automatic bridge", async () => {
      const host = await vscode.extensions.getExtension("google.google-antigravity")!.activate();
      const rpc = await host.getRpcClient();
      const catalog = await rpc.getAvailableModels({});
      const entry = Object.entries(catalog.response.models).find(([slug, model]: [string, any]) => /claude-sonnet.*low/.test(slug) && !model.disabled);
      assert.ok(entry, "No enabled partner model available for the plural-model smoke test");
      const config = vscode.workspace.getConfiguration("superborrow");
      const previous = config.get("ideModel", "auto");
      try {
        await config.update("ideModel", `antigravity:${entry[0]}`, vscode.ConfigurationTarget.Global);
        const models = new ModelBridge(); await models.initialize();
        const result = await models.generate({ requestId: "live-partner", prompt: "Return only missing code, no markdown. Python prefix: def add(a,b): return ", languageId: "python", maxTokens: 32, kind: "inline" }, new AbortController().signal);
        assert.match(result.text, /a\s*\+\s*b/);
        return { model: models.modelId, suggestion: result.text };
      } finally { await config.update("ideModel", previous, vscode.ConfigurationTarget.Global); }
    });
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    if (compositeEnabled) await vscode.commands.executeCommand("superborrow.restoreNativeTab");
    report.completed = true; save();
  }
}
