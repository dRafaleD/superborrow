import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { CoreBridge } from "./bridge";
import { DocumentSync } from "./documents";
import { ModelBridge } from "./models";
import { CompletionCache, excludedPath, insertion } from "./completion";
import { CompletionParams, EngineConfig, Mode } from "./protocol";
import { NativeTabControl, NativeTabSync } from "./native-tab";

let bridge: CoreBridge | undefined;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Superborrow");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  const models = new ModelBridge();
  const cache = new CompletionCache();
  status.command = "superborrow.cycleMode";
  context.subscriptions.push(output, status);
  let sync: DocumentSync | undefined;
  let ready = false;
  let disposed = false;
  let connecting: Promise<void> | undefined;
  let active: AbortController | undefined;
  let activeUri: string | undefined;
  let epoch = 0;
  let lastError = "";
  let lastLogged = 0;
  let sequence = 0;
  let modelRetry: ReturnType<typeof setTimeout> | undefined;
  let lastModelError = "";
  let coreVersion: string | undefined;
  let lastProvider: "local" | "ide" | undefined;
  let lastLatencyMs: number | undefined;
  let lastDiscardReason: string | undefined;
  let lastCancellationReason: string | undefined;
  let acceptedCount = 0;
  let lastAccepted: { language: string; provider: string | undefined; model: string | undefined } | undefined;
  let modelSetup: Promise<void> | undefined;
  let appliedConfigKey: string | undefined;
  let configQueue: Promise<void> = Promise.resolve();
  let nativeTabSetup: Promise<void> | undefined;
  let nativeTabManaged = false;
  const config = () => vscode.workspace.getConfiguration("superborrow");
  const enabled = () => config().get<boolean>("enabled", true);
  const nativeTab = () => new NativeTabControl((vscode as unknown as { antigravityUnifiedStateSync: NativeTabSync }).antigravityUnifiedStateSync);
  const coordinateNativeTab = (): Promise<void> => {
    if (nativeTabSetup) return nativeTabSetup;
    if (!enabled() || !config().get<boolean>("manageNativeTab", false)) return Promise.resolve();
    nativeTabSetup = (async () => {
      const control = nativeTab();
      const previous = await control.get();
      if (context.globalState.get<number>("previousNativeTab") === undefined) await context.globalState.update("previousNativeTab", previous);
      await control.set(1);
      if (!nativeTabManaged) output.appendLine("Native Tab provider coordinated: Superborrow owns inline suggestions; previous native Tab preference saved.");
      nativeTabManaged = true;
    })().finally(() => { nativeTabSetup = undefined; });
    return nativeTabSetup;
  };
  const mode = () => config().get<Mode>("mode", "hybrid");
  const engineConfig = (): EngineConfig => ({
    localApi: config().get("localApi", "llamaInfill"),
    endpoint: config().get("endpoint", "http://127.0.0.1:8080/infill"),
    model: config().get("model", ""),
    fimFormat: config().get("fimFormat", "qwen"),
    debounceMs: config().get("debounceMs", 60),
    requestTimeoutMs: config().get("requestTimeoutMs", 10000),
    maxTokens: config().get("maxTokens", 128),
    maxContextBytes: config().get("maxContextBytes", 24000),
    projectContext: config().get("projectContext", ""),
    ideAvailable: models.available,
    hybridPreference: config().get("hybridPreference", "auto"),
  });
  const configureEngine = (current: CoreBridge): Promise<void> => {
    const payload = engineConfig();
    const key = JSON.stringify(payload);
    const operation = configQueue.catch(() => {}).then(async () => {
      if (bridge !== current || key === appliedConfigKey) return;
      await current.configure(payload);
      if (bridge === current) appliedConfigKey = key;
    });
    configQueue = operation;
    return operation;
  };
  const showStatus = (detail = "") => {
    const name = mode() === "ide" ? "Antigravity" : mode() === "local" ? "Local" : "Hybrid";
    status.text = !enabled() ? "$(debug-pause) Tab: Paused" : !ready ? "$(warning) Tab: Disconnected" : `$(sparkle) Tab: ${name}${detail ? ` · ${detail}` : ""}`;
    status.tooltip = `Superborrow — click to switch mode\nIDE: ${models.label}\n${lastError || "Ready. Local generation requires a running FIM model server."}`;
    status.show();
  };
  const abortActive = (reason: string) => { if (active && !active.signal.aborted) { lastCancellationReason = reason; active.abort(reason); } };
  const invalidate = (reason = "configuration/model context changed") => { epoch++; cache.clear(); abortActive(reason); };
  const eligible = (doc: vscode.TextDocument): boolean =>
    ["file", "untitled", "vscode-notebook-cell"].includes(doc.uri.scheme) && !doc.isClosed && doc.languageId !== "scminput"
    && Buffer.byteLength(doc.getText(), "utf8") <= 512 * 1024
    && !excludedPath(doc.uri.fsPath, config().get<string[]>("exclude", []));
  const syncDocument = async (doc: vscode.TextDocument): Promise<void> => {
    if (!sync || !ready || !enabled()) return;
    const uri = doc.uri.toString();
    if (!eligible(doc)) { await sync.close(uri); return; }
    await sync.update({ uri, version: doc.version, languageId: doc.languageId, text: doc.getText() });
  };
  const logError = (error: unknown) => {
    const code = (error as { code?: number })?.code;
    if (code === -32800 || code === -32801) return;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError || Date.now() - lastLogged > 30000) {
      output.appendLine(`Completion unavailable: ${message}`); lastLogged = Date.now();
    }
    lastError = message;
    showStatus("Unavailable");
  };
  const connect = async (notify: boolean): Promise<void> => {
    if (!vscode.workspace.isTrusted || disposed) return;
    invalidate(); ready = false;
    bridge?.dispose(); bridge = undefined; sync = undefined; appliedConfigKey = undefined;
    if (!enabled()) { showStatus(); return; }
    status.text = "$(sync~spin) Tab: Connecting"; status.show();
    try {
      const configured = config().get<string>("corePath", "");
      if (configured && !path.isAbsolute(configured)) throw new Error("corePath must be absolute");
      const name = process.platform === "win32" ? "superborrow-core.exe" : "superborrow-core";
      const bundled = path.join(context.extensionPath, "bin", name);
      const binary = configured || (existsSync(bundled) ? bundled : path.resolve(context.extensionPath, "..", "core-rust", "target", "debug", name));
      const current = new CoreBridge(binary, (params, signal) => models.generate(params, signal), line => output.appendLine(line), () => {
        ready = false; invalidate(); if (!disposed) showStatus();
      });
      bridge = current;
      const info = await current.initialize();
      coreVersion = info.version;
      if (disposed) { current.dispose(); return; }
      await configureEngine(current);
      sync = new DocumentSync(current);
      ready = true; lastError = "";
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (activeDoc) await syncDocument(activeDoc);
      for (const doc of vscode.workspace.textDocuments) {
        if (sync.size >= 16) break;
        if (doc !== activeDoc) await syncDocument(doc);
      }
      output.appendLine(`Connected: protocol ${info.protocolVersion}, phase ${info.phase}, core ${info.version}`);
      showStatus();
      if (notify) void vscode.window.showInformationMessage("Superborrow: completion engine connected.");
    } catch (error) {
      ready = false; bridge?.dispose(); bridge = undefined; sync = undefined;
      logError(error);
      if (notify) void vscode.window.showErrorMessage(`Superborrow: ${String(error)}`);
    }
  };
  const start = (notify: boolean): Promise<void> => {
    connecting ??= connect(notify).finally(() => { connecting = undefined; });
    return connecting;
  };
  const request = async (doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, extras: Partial<CompletionParams> = {}) => {
    if (!enabled() || !ready || !bridge || !eligible(doc)) { lastDiscardReason = "engine or document unavailable"; return undefined; }
    abortActive("new completion request");
    const controller = new AbortController(); active = controller; activeUri = doc.uri.toString();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    const version = doc.version;
    const requestEpoch = epoch;
    try {
      await syncDocument(doc);
      if (controller.signal.aborted || doc.version !== version || requestEpoch !== epoch) { lastDiscardReason = controller.signal.aborted ? "cancelled before inference" : "context changed before inference"; return undefined; }
      const result = await bridge.requestCompletion({ uri: doc.uri.toString(), version, position: { line: position.line, character: position.character }, mode: mode(), ...extras }, controller.signal);
      if (controller.signal.aborted || doc.isClosed || doc.version !== version || result.version !== version || epoch !== requestEpoch) { lastDiscardReason = "obsolete provider response"; return undefined; }
      lastDiscardReason = undefined;
      lastProvider = result.provider; lastLatencyMs = result.elapsedMs;
      lastError = ""; showStatus(`${result.provider} ${result.elapsedMs}ms${result.fallback ? " ↪" : ""}`);
      return result;
    } finally { cancellation.dispose(); if (active === controller) { active = undefined; activeUri = undefined; } }
  };

  const previews = new Map<string, string>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("superborrow-preview", {
    provideTextDocumentContent: uri => previews.get(uri.toString()) ?? "",
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.nextEdit", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !eligible(editor.document) || !enabled()) return;
    if (!ready) await start(false);
    const instruction = await vscode.window.showInputBox({ title: "Superborrow: Suggest Next Edit", prompt: "Describe the change for the selection (or current line). Leave empty to continue recent edits.", placeHolder: "Continue the last edit consistently", validateInput: value => value.length > 2048 ? "Maximum 2048 characters" : undefined });
    if (instruction === undefined) return;
    const doc = editor.document;
    const version = doc.version;
    const range = editor.selection.isEmpty ? doc.lineAt(editor.selection.active.line).range : new vscode.Range(editor.selection.start, editor.selection.end);
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Superborrow: preparing edit", cancellable: true }, (_, token) => request(doc, range.start, token, {
        kind: "nextEdit", endPosition: { line: range.end.line, character: range.end.character }, instruction: instruction || "Continue the last edit consistently", explicit: true,
      }));
      if (!result || !result.text || doc.version !== version) return;
      const originalText = doc.getText();
      const text = result.text.replace(/\r\n|\r|\n/g, doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
      if (text === doc.getText(range)) { void vscode.window.showInformationMessage("Superborrow: no change suggested."); return; }
      const key = ++sequence;
      const original = vscode.Uri.parse(`superborrow-preview:/before-${key}/${path.basename(doc.fileName)}`);
      const proposed = vscode.Uri.parse(`superborrow-preview:/after-${key}/${path.basename(doc.fileName)}`);
      previews.set(original.toString(), originalText);
      previews.set(proposed.toString(), originalText.slice(0, doc.offsetAt(range.start)) + text + originalText.slice(doc.offsetAt(range.end)));
      try {
        await vscode.commands.executeCommand("vscode.diff", original, proposed, "Superborrow: Next Edit Preview", { preview: true });
        const choice = await vscode.window.showInformationMessage("Review the proposed edit. Apply it to the original document?", "Apply", "Discard");
        if (choice === "Apply") {
          if (doc.isClosed || doc.version !== version) throw new Error("Document changed while previewing. Request a new edit.");
          const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, range, text);
          if (!await vscode.workspace.applyEdit(edit)) throw new Error("Editor could not apply the edit");
        }
      } finally { previews.delete(original.toString()); previews.delete(proposed.toString()); }
    } catch (error) { logError(error); void vscode.window.showErrorMessage(`Superborrow: ${String(error)}`); }
  }));

  const inlineProvider: vscode.InlineCompletionItemProvider = {
    provideInlineCompletionItems: async (doc, position, completionContext, token) => {
      lastDiscardReason = undefined;
      if (!enabled() || !ready || !eligible(doc)) { lastDiscardReason = `document unavailable (${doc.uri.scheme}, closed=${doc.isClosed}, ready=${ready})`; return []; }
      abortActive("new inline provider invocation");
      const key = `${epoch}:${doc.uri.toString()}:${doc.version}:${position.line}:${position.character}:${mode()}`;
      try {
        let text = cache.get(key);
        if (text === undefined) {
          const result = await request(doc, position, token, { explicit: completionContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke });
          if (!result) return [];
          const suffix = doc.getText(new vscode.Range(position, doc.positionAt(doc.getText().length))).slice(0, 256);
          text = insertion(result.text, suffix, doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
          if (text) cache.put(key, text);
        }
        if (!text || token.isCancellationRequested) { lastDiscardReason = token.isCancellationRequested ? "editor cancelled suggestion" : "empty provider output"; return []; }
        const selected = completionContext.selectedCompletionInfo;
        if (selected) {
          if (!selected.range.contains(position)) return [];
          // VS Code only displays an inline item alongside IntelliSense when it
          // extends the selected suggestion over the same replacement range.
          const before = doc.getText(new vscode.Range(selected.range.start, position));
          const replacement = before + text;
          if (!replacement.startsWith(selected.text)) return [];
          const item = new vscode.InlineCompletionItem(replacement, selected.range);
          item.command = { title: "Superborrow completion accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: lastProvider, model: models.modelId }] };
          return [item];
        }
        const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
        item.command = { title: "Superborrow completion accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: lastProvider, model: models.modelId }] };
        return [item];
      } catch (error) { lastDiscardReason = `provider error ${(error as {code?:number})?.code ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`; logError(error); return []; }
    },
  };
  let inlineRegistration: vscode.Disposable | undefined;
  const registerInlineProvider = () => {
    inlineRegistration?.dispose();
    inlineRegistration = vscode.languages.registerInlineCompletionItemProvider([{ scheme: "file" }, { scheme: "untitled" }, { scheme: "vscode-notebook-cell" }], inlineProvider);
  };
  registerInlineProvider();
  context.subscriptions.push({ dispose: () => inlineRegistration?.dispose() });
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.accepted", (accepted: typeof lastAccepted) => {
    acceptedCount++; lastAccepted = accepted;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.checkBridge", () => start(true)));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.cycleMode", async () => {
    const modes: Mode[] = ["hybrid", "local", "ide"];
    await config().update("mode", modes[(modes.indexOf(mode()) + 1) % modes.length], vscode.ConfigurationTarget.Global);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.toggle", () => config().update("enabled", !enabled(), vscode.ConfigurationTarget.Global)));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.inspectModels", () => models.inspect(output)));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.selectModel", async () => {
    try {
      await models.select(); invalidate();
      if (bridge && ready) await configureEngine(bridge);
      showStatus();
    } catch (error) { logError(error); void vscode.window.showWarningMessage(`Superborrow: ${String(error)}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.showOutput", () => output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.enableCompositeTab", async () => {
    await config().update("manageNativeTab", true, vscode.ConfigurationTarget.Global);
    await config().update("hybridPreference", "ide", vscode.ConfigurationTarget.Global);
    await config().update("mode", "hybrid", vscode.ConfigurationTarget.Global);
    await config().update("enabled", true, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", true, vscode.ConfigurationTarget.Global);
    await initializeModels();
    await coordinateNativeTab();
    await start(false);
    output.appendLine("Composite Tab enabled: Superborrow owns suggestions; native Tab disabled. Restore Antigravity Tab restores the previous setting.");
    return { nativeTabManaged, model: models.modelId };
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.restoreNativeTab", async () => {
    await config().update("manageNativeTab", false, vscode.ConfigurationTarget.Global);
    if (nativeTabSetup) await nativeTabSetup;
    const previous = context.globalState.get<number>("previousNativeTab");
    if (previous === 1 || previous === 2) await nativeTab().set(previous);
    await context.globalState.update("previousNativeTab", undefined);
    nativeTabManaged = false;
    await config().update("enabled", false, vscode.ConfigurationTarget.Global);
    output.appendLine("Previous native Tab setting restored; Superborrow paused.");
  }));
  const initializeModels = (): Promise<void> => {
    if (modelSetup) return modelSetup;
    modelSetup = setupModels().finally(() => { modelSetup = undefined; });
    return modelSetup;
  };
  const setupModels = async () => {
    if (disposed || !enabled()) return;
    if (modelRetry) { clearTimeout(modelRetry); modelRetry = undefined; }
    try {
      await models.initialize();
      if (disposed) return;
      await coordinateNativeTab();
      // Host activation can register its own inline provider. Register this
      // provider afterwards; do not change/disable the user's native settings.
      registerInlineProvider();
      invalidate();
      if (bridge && ready) await configureEngine(bridge);
      output.appendLine(`IDE model ready: ${models.label} (${models.modelId ?? "extension adapter"})`);
      lastModelError = "";
      lastError = ""; showStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastModelError) output.appendLine(`IDE model unavailable; local routing remains available: ${message}`);
      lastModelError = message;
      if (!disposed && enabled()) modelRetry = setTimeout(() => { void initializeModels(); }, 30000);
      showStatus();
    }
  };
  context.subscriptions.push(vscode.extensions.onDidChange(() => { if (!models.available && enabled()) void initializeModels(); }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => { if (!disposed) void syncDocument(doc).catch(logError); }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length) { invalidate("document content changed"); void syncDocument(event.document).catch(logError); }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
    if (sync?.has(doc.uri.toString())) { invalidate(); void sync.close(doc.uri.toString()).catch(logError); }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor?.document.uri.toString() !== activeUri) abortActive("active editor changed");
    if (editor) void syncDocument(editor.document).catch(logError);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration("superborrow")) return;
    invalidate();
    if (event.affectsConfiguration("superborrow.ideAdapterExtension") || event.affectsConfiguration("superborrow.ideModel")) {
      models.reset(); void initializeModels();
    }
    if (event.affectsConfiguration("superborrow.corePath") || event.affectsConfiguration("superborrow.enabled") || event.affectsConfiguration("superborrow.exclude")) {
      void start(false);
    } else if (bridge) {
      const current = bridge;
      ready = false;
      void configureEngine(current).then(async () => {
        if (bridge !== current || disposed) return;
        ready = true; lastError = "";
        for (const doc of vscode.workspace.textDocuments) await syncDocument(doc);
        showStatus();
      }).catch(logError);
    }
    showStatus();
  }));
  context.subscriptions.push({ dispose: () => { disposed = true; if (modelRetry) clearTimeout(modelRetry); invalidate(); previews.clear(); bridge?.dispose(); } });
  const startup = Promise.all([start(false), initializeModels()]).then(() => {});
  return Object.freeze({
    apiVersion: 1,
    ready: startup,
    getStatus: () => ({ connected: ready, enabled: enabled(), mode: mode(), coreVersion, ideAvailable: models.available, model: models.modelId, modelLabel: models.label, nativeTabManaged, lastProvider, lastLatencyMs, lastDiscardReason, lastCancellationReason, acceptedCount, lastAccepted, lastError }),
    provideInlineCompletionItems: (doc: vscode.TextDocument, position: vscode.Position, completionContext: vscode.InlineCompletionContext, token: vscode.CancellationToken) => inlineProvider.provideInlineCompletionItems(doc, position, completionContext, token),
  });
}

export async function deactivate(): Promise<void> { await bridge?.shutdown(); bridge = undefined; }
