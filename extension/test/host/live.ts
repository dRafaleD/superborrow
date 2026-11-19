import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { activate } from "../../src/extension";
import { ModelBridge } from "../../src/models";

/** Opt-in real-account tests. Run with scripts/test-host.cjs, never offline CI. */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  let compositeEnabled = false;
  const continuationOnly = process.env.SUPERBORROW_LIVE_FOCUS === "continuation";
  const inflightOnly = process.env.SUPERBORROW_LIVE_FOCUS === "inflight";
  const pipelineOnly = process.env.SUPERBORROW_LIVE_FOCUS === "pipeline";
  const focused = continuationOnly || inflightOnly || pipelineOnly;
  const report: Record<string, unknown> = { completed: false, passed: false, scope: continuationOnly ? "continuation" : inflightOnly ? "inflight" : pipelineOnly ? "pipeline" : "full", app: vscode.env.appName, trusted: vscode.workspace.isTrusted, cases };
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
    // The signed-in host may need a retry after its initial discovery timeout.
    const discoveryDeadline = Date.now() + 40000;
    while (!api.getStatus().ideAvailable && Date.now() < discoveryDeadline) await new Promise(resolve => setTimeout(resolve, 250));
    report.startup = api.getStatus(); save();
    assert.equal(api.getStatus().connected, true);
    assert.equal(api.getStatus().ideAvailable, true);
    assert.equal(api.getStatus().coreVersion, "0.3.14");
    await vscode.commands.executeCommand("superborrow.enableCompositeTab");
    compositeEnabled = true;
    assert.equal(api.getStatus().nativeTabManaged, true);
    // Direct factory checks must not race a second invocation started by the
    // editor itself. Real automatic rendering/acceptance is exercised below.
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", false, vscode.ConfigurationTarget.Global);

    const samples = [
      { language: "python", text: "def add(a: int, b: int) -> int:\n    return ", pattern: /a\s*\+\s*b/ },
      { language: "typescript", text: "function add(a: number, b: number): number {\n  return ", pattern: /a\s*\+\s*b/ },
      { language: "go", text: "func add(a int, b int) int {\n    return ", pattern: /a\s*\+\s*b/ },
      { language: "rust", text: "fn add(a: i32, b: i32) -> i32 {\n    ", pattern: /a\s*\+\s*b/ },
      { language: "java", text: "public static int add(int a, int b) {\n    return ", pattern: /a\s*\+\s*b/ },
      { language: "sql", text: "-- select the integer 42\nSELECT ", pattern: /42/ },
      { language: "html", text: "<!-- add an accessible primary button labelled Save -->\n", pattern: /<button\b/i },
      { language: "javascript", text: "// toplama fonksiyonu oluştur\n", pattern: /return\s+\w+\s*\+\s*\w+|=>\s*\w+\s*\+\s*\w+/ },
      { language: "python", text: "# iki sayıyı toplayan bir fonksiyon oluştur\n", pattern: /return\s+\w+\s*\+\s*\w+/ },
      { language: "python", text: "// iki sayıyı toplayan bir fonksiyon oluştur\n", pattern: /return\s+\w+\s*\+\s*\w+/ },
      { language: "python", text: "//create function\ndef my_function():\n    pass\ndef another_function():\n    pass\n\n# iki sayıyı toplayan bir fonksiyon oluştur\n", pattern: /return\s+\w+\s*\+\s*\w+/ },
      { language: "python", text: "//create function\n", pattern: /^\s*$/, noCompletion: true },
      { language: "css", text: "/* arka planı siyah, yazıları beyaz yap */\n", pattern: /background|color/ },
    ];
    for (const sample of samples) {
      if (focused) break;
      await runCase(`${sample.language}: ${sample.text.startsWith("//") || sample.text.startsWith("#") || sample.text.startsWith("/*") ? "Turkish comment intent" : "automatic inline completion"}`, async () => {
        const doc = await vscode.workspace.openTextDocument({ language: sample.language, content: sample.text });
        const position = doc.positionAt(sample.text.length);
        const fixtureEditor = await vscode.window.showTextDocument(doc);
        fixtureEditor.selection = new vscode.Selection(position, position);
        let list: vscode.InlineCompletionItem[] | undefined;
        let discardedAttempts = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          assert.equal(doc.getText(), sample.text, "Synthetic fixture was changed during the test");
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
        if ("noCompletion" in sample && sample.noCompletion) {
          assert.ok(!list?.length, "An unspecified function request must not produce invented scaffolds");
          assert.equal(api.getStatus().lastProvider, "ide");
          assert.equal(api.getStatus().lastDiscardReason, "empty provider output");
          return { language: doc.languageId, provider: "ide", model: api.getStatus().model, suppressedUnspecifiedRequest: true };
        }
        assert.ok(list?.length, `No ${sample.language} suggestion: ${JSON.stringify(api.getStatus())}`);
        const value = typeof list[0].insertText === "string" ? list[0].insertText : list[0].insertText.value;
        assert.match(value, sample.pattern);
        if (/topla|toplam/.test(sample.text)) {
          assert.doesNotMatch(value, /\bpass\b|NotImplementedError|\bTODO\b|^\s*\.\.\.\s*$/m, "Requested implementation must not be a placeholder");
          assert.equal((value.match(/\bdef\s+|\bfunction\s+/g) ?? []).length, 1, "Return one requested function, not unrelated scaffolds");
        }
        assert.equal(api.getStatus().lastProvider, "ide");
        return { language: doc.languageId, provider: api.getStatus().lastProvider, model: api.getStatus().model, discardedAttempts, outputBytes: Buffer.byteLength(value), suggestion: value };
      });
    }

    if (!inflightOnly) await runCase("typing through a real model completion reuses its remainder without inference", async () => {
      const doc = await vscode.workspace.openTextDocument({ language: "python", content: "def add(a, b):\n    return " });
      const fixtureEditor = await vscode.window.showTextDocument(doc);
      const initial = doc.positionAt(doc.getText().length);
      fixtureEditor.selection = new vscode.Selection(initial, initial);
      const token = new vscode.CancellationTokenSource();
      const inlineContext = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
      try {
        let items: vscode.InlineCompletionItem[] | undefined;
        let discardedAttempts = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          const first = await api.provideInlineCompletionItems(doc, doc.positionAt(doc.getText().length), inlineContext, token.token);
          items = Array.isArray(first) ? first : first?.items;
          if (items?.length || !/cancel|obsolete|context changed/i.test(api.getStatus().lastDiscardReason ?? "")) break;
          discardedAttempts++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(items?.length, JSON.stringify(api.getStatus()));
        const suggestion = String(items[0].insertText);
        assert.match(suggestion, /a\s*\+\s*b/);
        const requests = api.getStatus().modelRequests;
        const hits = api.getStatus().continuationHits;
        const latencies: number[] = [];
        for (let index = 0; index < Math.min(3, suggestion.length - 1); index++) {
          assert.equal(await fixtureEditor.edit(edit => edit.insert(doc.positionAt(doc.getText().length), suggestion[index])), true);
          const nextCursor = doc.positionAt(doc.getText().length);
          fixtureEditor.selection = new vscode.Selection(nextCursor, nextCursor);
          const next = await api.provideInlineCompletionItems(doc, doc.positionAt(doc.getText().length), inlineContext, token.token);
          const remainder = Array.isArray(next) ? next : next?.items;
          assert.equal(remainder?.[0].insertText, suggestion.slice(index + 1));
          assert.equal(api.getStatus().modelRequests, requests, "Matching typing must not call the model again");
          latencies.push(api.getStatus().lastInlineLatencyMs!);
        }
        assert.equal(api.getStatus().continuationHits - hits, latencies.length);
        return { provider: api.getStatus().lastProvider, model: api.getStatus().model, discardedAttempts, extraModelRequests: 0, continuationLatenciesMs: latencies };
      } finally { token.dispose(); }
    });

    if (!continuationOnly) await runCase("overlapping editor callers share one real model request and isolate cancellation", async () => {
      const doc = await vscode.workspace.openTextDocument({ language: "python", content: "def add(a, b):\n    return " });
      const fixtureEditor = await vscode.window.showTextDocument(doc);
      const initial = doc.positionAt(doc.getText().length);
      fixtureEditor.selection = new vscode.Selection(initial, initial);
      const inlineContext = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
      for (let attempt = 0; attempt < 4; attempt++) {
        const tokens = Array.from({ length: 3 }, () => new vscode.CancellationTokenSource());
        const before = api.getStatus();
        try {
          const pending = tokens.map(token => api.provideInlineCompletionItems(doc, doc.positionAt(doc.getText().length), inlineContext, token.token));
          tokens[0].cancel();
          const lists = (await Promise.all(pending)).map(value => Array.isArray(value) ? value : value?.items);
          if (!lists[1]?.length && /cancel|obsolete|context changed/i.test(api.getStatus().lastDiscardReason ?? "") && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 100)); continue;
          }
          assert.ok(!lists[0]?.length, "Cancelled caller must not receive a suggestion");
          assert.ok(lists[1]?.length && lists[2]?.length, JSON.stringify(api.getStatus()));
          assert.equal(lists[1][0].insertText, lists[2][0].insertText);
          assert.match(String(lists[1][0].insertText), /a\s*\+\s*b/);
          const after = api.getStatus();
          assert.equal(after.modelRequests - before.modelRequests, 1, "All three callers must share one inference");
          assert.equal(after.sharedRequests - before.sharedRequests, 2);
          return { model: after.model, provider: after.lastProvider, discardedAttempts: attempt, callers: 3, cancelledCallers: 1, modelRequests: 1, sharedRequests: 2, lastInlineLatencyMs: after.lastInlineLatencyMs };
        } finally { for (const token of tokens) token.dispose(); }
      }
      throw new Error("No stable inference attempt");
    });

    if (focused) { report.passed = true; return; }
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", true, vscode.ConfigurationTarget.Global);
    for (const automatic of [
      { name: "automatic edit trigger and standard Tab acceptance command", before: "def add(a, b):\n    return", edit: " " },
      { name: "Turkish request comment automatic trigger and Tab acceptance", before: "# iki sayıyı toplayan bir fonksiyon oluştur", edit: "\n" },
    ]) await runCase(automatic.name, async () => {
      const acceptedBefore = api.getStatus().acceptedCount;
      const doc = await vscode.workspace.openTextDocument({ language: "python", content: automatic.before });
      const editor = await vscode.window.showTextDocument(doc);
      const position = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(position, position);
      await editor.edit(edit => edit.insert(position, automatic.edit));
      const cursor = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(cursor, cursor);
      const before = doc.getText();
      const deadline = Date.now() + 20000;
      while (doc.getText() === before && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // This is the same commit command used by the host Tab binding for ghost text.
        await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
      }
      assert.notEqual(doc.getText(), before, "Automatic ghost text was not committed in the editor");
      assert.match(doc.getText(), /return\s+\w+\s*\+\s*\w+/);
      assert.doesNotMatch(doc.getText(), /\bpass\b|NotImplementedError/);
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
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", true, vscode.ConfigurationTarget.Global);
    if (compositeEnabled) await vscode.commands.executeCommand("superborrow.restoreNativeTab");
    report.completed = true; save();
  }
}
