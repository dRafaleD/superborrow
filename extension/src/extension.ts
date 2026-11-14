import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { CoreBridge } from "./bridge";
import { DocumentSync } from "./documents";
import { ModelBridge } from "./models";
import { CompletionCache, excludedPath, insertion } from "./completion";
import { CompletionParams, EngineConfig, Mode } from "./protocol";

let bridge: CoreBridge | undefined;

export function activate(context: vscode.ExtensionContext): void {
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
  let epoch = 0;
  let lastError = "";
  let lastLogged = 0;
  let sequence = 0;
  const config = () => vscode.workspace.getConfiguration("superborrow");
  const enabled = () => config().get<boolean>("enabled", true);
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
  });
  const showStatus = (detail = "") => {
    const name = mode() === "ide" ? "Antigravity" : mode() === "local" ? "Local" : "Hybrid";
    status.text = !enabled() ? "$(debug-pause) Tab: Paused" : !ready ? "$(warning) Tab: Disconnected" : `$(sparkle) Tab: ${name}${detail ? ` · ${detail}` : ""}`;
    status.tooltip = `Superborrow — click to switch mode\nIDE: ${models.label}\n${lastError || "Ready. Local generation requires a running FIM model server."}`;
    status.show();
  };
  const invalidate = () => { epoch++; cache.clear(); active?.abort(); };
  const eligible = (doc: vscode.TextDocument): boolean =>
    ["file", "untitled"].includes(doc.uri.scheme) && !doc.isClosed && doc.languageId !== "scminput"
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
    bridge?.dispose(); bridge = undefined; sync = undefined;
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
      if (disposed) { current.dispose(); return; }
      await current.configure(engineConfig());
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
    if (!enabled() || !ready || !bridge || !eligible(doc)) return undefined;
    active?.abort();
    const controller = new AbortController(); active = controller;
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    const version = doc.version;
    const requestEpoch = epoch;
    try {
      await syncDocument(doc);
      if (controller.signal.aborted || doc.version !== version || requestEpoch !== epoch) return undefined;
      const result = await bridge.requestCompletion({ uri: doc.uri.toString(), version, position: { line: position.line, character: position.character }, mode: mode(), ...extras }, controller.signal);
      if (controller.signal.aborted || doc.isClosed || doc.version !== version || result.version !== version || epoch !== requestEpoch) return undefined;
      lastError = ""; showStatus(`${result.provider} ${result.elapsedMs}ms${result.fallback ? " ↪" : ""}`);
      return result;
    } finally { cancellation.dispose(); if (active === controller) active = undefined; }
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

  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider([{ scheme: "file" }, { scheme: "untitled" }], {
    provideInlineCompletionItems: async (doc, position, completionContext, token) => {
      if (completionContext.selectedCompletionInfo || !enabled() || !ready || !eligible(doc)) return [];
      active?.abort();
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
        if (!text || token.isCancellationRequested) return [];
        return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
      } catch (error) { logError(error); return []; }
    },
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
      if (bridge && ready) await bridge.configure(engineConfig());
      showStatus();
    } catch (error) { logError(error); void vscode.window.showWarningMessage(`Superborrow: ${String(error)}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.showOutput", () => output.show(true)));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => { if (!disposed) void syncDocument(doc).catch(logError); }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length) { invalidate(); void syncDocument(event.document).catch(logError); }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
    invalidate(); if (sync) void sync.close(doc.uri.toString()).catch(logError);
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    active?.abort(); if (editor) void syncDocument(editor.document).catch(logError);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration("superborrow")) return;
    invalidate();
    if (event.affectsConfiguration("superborrow.ideAdapterExtension")) models.reset();
    if (event.affectsConfiguration("superborrow.corePath") || event.affectsConfiguration("superborrow.enabled") || event.affectsConfiguration("superborrow.exclude")) {
      void start(false);
    } else if (bridge) {
      const current = bridge;
      ready = false;
      void current.configure(engineConfig()).then(async () => {
        if (bridge !== current || disposed) return;
        ready = true; lastError = "";
        for (const doc of vscode.workspace.textDocuments) await syncDocument(doc);
        showStatus();
      }).catch(logError);
    }
    showStatus();
  }));
  context.subscriptions.push({ dispose: () => { disposed = true; invalidate(); previews.clear(); bridge?.dispose(); } });
  void start(false);
}

export async function deactivate(): Promise<void> { await bridge?.shutdown(); bridge = undefined; }
