import * as vscode from "vscode";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { CoreBridge } from "./bridge";
import { AutoImports, missingImportAt } from "./auto-import";
import { DocumentSync } from "./documents";
import { LocalImports } from "./imports";
import { ModelBridge } from "./models";
import { CompletionCache, ContinuationCache, cleanCompletion, codeOnlySuggestion, excludedPath, followDeclarationRename, inlineInsertion, isForeignRustStatement } from "./completion";
import { CompletionParams, CompletionResult, DocumentPatchParams, EngineConfig, Mode } from "./protocol";
import { InflightCompletion } from "./inflight";
import { diagnosticMeaningKey, nearbyDiagnostics } from "./diagnostics";
import { SpeculativeCompletion } from "./speculative";
import { cancelled, debounce, withDeadline } from "./generation";
import { NativeTabControl, NativeTabSync } from "./native-tab";
import { MemberCompletion } from "./member-completion";
import { RenameFollowup } from "./rename-followup";

let bridge: CoreBridge | undefined;
type SuggestionMetadata = { provider: "local" | "ide"; model: string | undefined; diagnosticsKey: string };

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Superborrow");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  const models = new ModelBridge();
  const cache = new CompletionCache<{ text: string; metadata: SuggestionMetadata }>();
  const continuation = new ContinuationCache<SuggestionMetadata>();
  const imports = new LocalImports();
  const autoImports = new AutoImports();
  const members = new MemberCompletion();
  const duskline = vscode.env.appName.startsWith("Duskline IDE");
  let relatedDocumentsAvailable = false;
  const inflight = new InflightCompletion<CompletionResult | undefined>();
  const editCache = new CompletionCache<CompletionResult | null>();
  const speculative = new SpeculativeCompletion<{ model: string | undefined; elapsedMs: number }>(Date.now, duskline ? 350 : 25);
  let preparedIdeAvailable = false;
  let continuationHits = 0;
  let modelRequests = 0;
  let inlineEditRequests = 0;
  let lastInlineLatencyMs: number | undefined;
  let ignoredDocumentChanges = 0;
  let ignoredCursorRequests = 0;
  let lastIgnoredScheme: string | undefined;
  type Rename = { oldName: string; typed: string; offset: number; column: number };
  let recentReplacement: { doc: vscode.TextDocument; version: number; startLine: number; endLine: number; time: number; localText?: string; rename?: Rename } | undefined;
  let lastInlineRequest: { doc: vscode.TextDocument; version: number; offset: number } | undefined;
  let dusklineTrigger: ReturnType<typeof setTimeout> | undefined;
  status.command = duskline ? "superborrow.selectModel" : "superborrow.cycleMode";
  context.subscriptions.push(output, status);
  let sync: DocumentSync | undefined;
  let ready = false;
  let disposed = false;
  let connecting: Promise<void> | undefined;
  let active: AbortController | undefined;
  let activeUri: string | undefined;
  let activeCursor: { version: number; offset: number } | undefined;
  let diagnosticsContext: { doc: vscode.TextDocument; position: vscode.Position; key: string; meaning: string } | undefined;
  let diagnosticRetry: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  let lastError = "";
  let lastLogged = 0;
  let sequence = 0;
  let modelRetry: ReturnType<typeof setTimeout> | undefined;
  let lastModelError = "";
  let modelRetryAttempts = 0;
  let coreVersion: string | undefined;
  let lastProvider: "local" | "ide" | undefined;
  let lastLatencyMs: number | undefined;
  let lastDiscardReason: string | undefined;
  let lastCancellationReason: string | undefined;
  let acceptedCount = 0;
  let shownCount = 0;
  let shownEditCount = 0;
  let shownJumpCount = 0;
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
  const mode = (): Mode => duskline ? "ide" : config().get<Mode>("mode", "ide");
  const usesRawInfill = () => duskline && models.modelId?.startsWith("duskline:qwen2.5-coder:") && config().get("fimFormat", "qwen") === "qwen";
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
    const name = mode() === "ide" ? (duskline ? "Duskline" : "IDE") : mode() === "local" ? "Local" : "Hybrid";
    status.text = !enabled() ? "$(debug-pause) Tab: Paused" : !ready ? "$(warning) Tab: Disconnected" : `$(sparkle) Tab: ${name}${detail ? ` · ${detail}` : ""}`;
    status.tooltip = `Superborrow · click to ${duskline ? "select the local Tab model" : "switch mode"}\nIDE: ${models.label}\n${lastError || "Ready"}`;
    status.show();
  };
  const abortActive = (reason: string) => { if (active && !active.signal.aborted) { lastCancellationReason = reason; active.abort(reason); } };
  const invalidate = (reason = "configuration/model context changed", preserveContinuation = false) => { epoch++; cache.clear(); editCache.clear(); autoImports.clear(); members.clear(preserveContinuation); if (!preserveContinuation) continuation.clear(); if (diagnosticRetry) { clearTimeout(diagnosticRetry); diagnosticRetry = undefined; } speculative.cancel(reason); inflight.cancel(); abortActive(reason); };
  const claimLanguageSuggestion = (reason: string) => {
    // Only one suggestion lane owns the cursor. Do not let a late AI answer
    // replace an import, rename, or member proposal from the language service.
    cache.clear(); editCache.clear(); continuation.clear();
    speculative.cancel(reason); inflight.cancel(); abortActive(reason);
  };
  const snapshots = new WeakMap<vscode.TextDocument, { version: number; text: string | undefined }>();
  const snapshotText = (doc: vscode.TextDocument): string | undefined => {
    const previous = snapshots.get(doc);
    if (previous?.version === doc.version) return previous.text;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    const limit = 512 * 1024;
    // UTF-8 is at least as large as the UTF-16 code unit count. Avoid
    // materializing files that already exceed the cap by their editor offset.
    const text = doc.offsetAt(end) <= limit ? doc.getText() : undefined;
    const bounded = text !== undefined && Buffer.byteLength(text, "utf8") <= limit ? text : undefined;
    snapshots.set(doc, { version: doc.version, text: bounded });
    return bounded;
  };
  const eligible = (doc: vscode.TextDocument): boolean =>
    ["file", "untitled", "vscode-notebook-cell"].includes(doc.uri.scheme) && !doc.isClosed && doc.languageId !== "scminput"
    && !excludedPath(doc.uri.fsPath, config().get<string[]>("exclude", []))
    && snapshotText(doc) !== undefined;
  const renameFollowup = new RenameFollowup(eligible);
  const languageEditsEnabled = () => duskline && vscode.workspace.isTrusted && config().get("inlineNextEdit", true);
  if (duskline) context.subscriptions.push(vscode.commands.registerCommand("superborrow.followRename", async (uri: string, version: number, line: number, character: number) => {
    if (disposed || !ready || !enabled() || !languageEditsEnabled()) return;
    const doc = renameFollowup.destination(uri, version, line, character);
    if (!doc || vscode.window.activeTextEditor?.document !== doc) return;
    // This workbench opens the cross-file target before running the item
    // command, but only reveals the line. Place the caret on the tracked word.
    const position = new vscode.Position(line, character);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position) });
  }));
  const refreshImport = (doc: vscode.TextDocument, version: number, target: vscode.Range) => {
    const editor = vscode.window.activeTextEditor;
    if (disposed || !ready || !enabled() || !languageEditsEnabled() || editor?.document !== doc || doc.version !== version
      || editor.selections.length !== 1 || !editor.selection.isEmpty || !missingImportAt(doc, editor.selection.active)?.isEqual(target)
      || !vscode.workspace.getConfiguration("editor", doc.uri).get("inlineSuggest.enabled", true)) return;
    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(undefined, logError);
  };
  const syncDocument = async (doc: vscode.TextDocument, patch?: DocumentPatchParams): Promise<void> => {
    if (!sync || !ready || !enabled()) return;
    const uri = doc.uri.toString();
    if (!eligible(doc)) { await sync.close(uri); return; }
    await sync.update({ uri, version: doc.version, languageId: doc.languageId, text: snapshotText(doc)! }, patch);
  };
  const importedContext = async (doc: vscode.TextDocument, text: string, signal: AbortSignal) => {
    if (!relatedDocumentsAvailable || !vscode.workspace.isTrusted || !config().get<boolean>("importContext", true) || doc.uri.scheme !== "file") return [];
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder || folder.uri.scheme !== "file") return [];
    const references = await imports.resolve(doc.uri.fsPath, text, folder.uri.fsPath, config().get<string[]>("exclude", []), signal);
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const result = [];
    for (const reference of references) {
      if (signal.aborted) break;
      const filename = fileURLToPath(reference.uri);
      const open = vscode.workspace.textDocuments.find(value => value.uri.scheme === "file" && normalize(value.uri.fsPath) === normalize(filename));
      // VS Code and Node serialize Windows file URIs differently. Reuse the
      // editor URI and synchronize its unsaved buffer before sending references.
      if (open) { if (!eligible(open)) continue; await syncDocument(open); }
      result.push({ ...reference, uri: open ? open.uri.toString() : vscode.Uri.file(filename).toString() });
    }
    return result;
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
      const current = new CoreBridge(binary, (params, signal) => { modelRequests++; return models.generate(params, signal); }, line => output.appendLine(line), () => {
        ready = false; invalidate(); if (!disposed) showStatus();
      });
      bridge = current;
      const info = await current.initialize();
      coreVersion = info.version;
      preparedIdeAvailable = info.capabilities.preparedIdeCompletion === true;
      relatedDocumentsAvailable = info.capabilities.relatedDocuments === true;
      if (disposed) { current.dispose(); return; }
      await configureEngine(current);
      sync = new DocumentSync(current, info.capabilities.documentPatches === true);
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
    speculative.cancel("version-bound request");
    const controller = new AbortController(); active = controller; activeUri = doc.uri.toString();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    const version = doc.version;
    activeCursor = { version, offset: doc.offsetAt(position) };
    const requestEpoch = epoch;
    try {
      await syncDocument(doc);
      const relatedDocuments = await withDeadline(controller.signal, engineConfig().requestTimeoutMs, signal => importedContext(doc, snapshotText(doc) ?? "", signal));
      if (controller.signal.aborted || doc.version !== version || requestEpoch !== epoch) { lastDiscardReason = controller.signal.aborted ? "cancelled before inference" : "context changed before inference"; return undefined; }
      const rawInfill = extras.kind !== "nextEdit" && usesRawInfill();
      const diagnostics = rawInfill ? [] : nearbyDiagnostics(vscode.languages.getDiagnostics(doc.uri), position.line);
      diagnosticsContext = rawInfill ? undefined : { doc, position, key: JSON.stringify(diagnostics), meaning: diagnosticMeaningKey(diagnostics) };
      const result = await bridge.requestCompletion({ uri: doc.uri.toString(), version, position: { line: position.line, character: position.character }, mode: mode(), diagnostics, ...(relatedDocumentsAvailable ? { relatedDocuments } : {}), ...extras }, controller.signal);
      if (controller.signal.aborted || doc.isClosed || doc.version !== version || result.version !== version || epoch !== requestEpoch) { lastDiscardReason = "obsolete provider response"; return undefined; }
      lastDiscardReason = undefined;
      lastProvider = result.provider; lastLatencyMs = result.elapsedMs;
      lastError = ""; showStatus(`${result.provider} ${result.elapsedMs}ms${result.fallback ? " ↪" : ""}`);
      return result;
    } finally { cancellation.dispose(); if (active === controller) { active = undefined; activeUri = undefined; activeCursor = undefined; } }
  };

  const previews = new Map<string, string>();
  const sharedRequest = (key: string, signal: AbortSignal, doc: vscode.TextDocument, position: vscode.Position, extras: Partial<CompletionParams>) =>
    inflight.run(key, signal, async sharedSignal => {
      const source = new vscode.CancellationTokenSource();
      const abort = () => source.cancel();
      sharedSignal.addEventListener("abort", abort, { once: true });
      if (sharedSignal.aborted) source.cancel();
      try { return await request(doc, position, source.token, extras); }
      finally { sharedSignal.removeEventListener("abort", abort); source.dispose(); }
    });
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
      const code = codeOnlySuggestion(result.text, doc.languageId);
      if (!code.trim()) return;
      const text = code.replace(/\r\n|\r|\n/g, doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
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

  const inlineProvider: vscode.InlineCompletionItemProvider & {
    handleDidShowCompletionItem(item: vscode.InlineCompletionItem & { isInlineEdit?: boolean; jumpToPosition?: vscode.Position }): void;
  } = {
    handleDidShowCompletionItem(item) {
      shownCount++;
      members.shown(item);
      if (item.jumpToPosition) shownJumpCount++;
      else if (item.isInlineEdit) shownEditCount++;
    },
    provideInlineCompletionItems: async (doc, position, completionContext, token) => {
      const started = performance.now();
      lastDiscardReason = undefined;
      if (!enabled() || !ready || !eligible(doc)) { lastDiscardReason = `document unavailable (${doc.uri.scheme}, closed=${doc.isClosed}, ready=${ready})`; return []; }
      if (token.isCancellationRequested || (completionContext.selectedCompletionInfo && !completionContext.selectedCompletionInfo.range.contains(position))) return [];
      const editor = vscode.window.activeTextEditor;
      if (editor?.document === doc) {
        const actual = doc.offsetAt(editor.selection.active);
        const requested = doc.offsetAt(position);
        const forecastAtCaret = speculative.matchesCursor(doc.uri.toString(), doc.version, actual)
          || (!!active && !active.signal.aborted && activeUri === doc.uri.toString() && activeCursor?.version === doc.version && activeCursor.offset === actual);
        if (actual !== requested && forecastAtCaret) { ignoredCursorRequests++; lastDiscardReason = "obsolete editor cursor request"; return []; }
      }
      const version = doc.version;
      const requestEpoch = epoch;
      if (duskline) lastInlineRequest = { doc, version, offset: doc.offsetAt(position) };
      if (duskline && vscode.workspace.isTrusted && !completionContext.selectedCompletionInfo && editor?.document === doc
        && editor.selections.length === 1 && editor.selection.isEmpty && editor.selection.active.isEqual(position)) {
        const languageEdits = languageEditsEnabled();
        const rename = languageEdits ? renameFollowup.suggest(doc, position) : undefined;
        if (rename) {
          claimLanguageSuggestion("language service rename");
          lastInlineLatencyMs = Math.round((performance.now() - started) * 100) / 100;
          if (rename.kind === "jump") {
            const acrossFiles = rename.uri.toString() !== doc.uri.toString();
            return [Object.assign(new vscode.InlineCompletionItem("", new vscode.Range(position, position)), {
              isInlineEdit: true,
              jumpToPosition: rename.position,
              uri: acrossFiles ? rename.uri : undefined,
              command: acrossFiles ? {
                title: "Superborrow go to rename reference",
                command: "superborrow.followRename",
                arguments: [rename.uri.toString(), rename.version, rename.position.line, rename.position.character],
              } : undefined,
            })];
          }
          return [Object.assign(new vscode.InlineCompletionItem(rename.text, rename.range), {
            isInlineEdit: true,
            showRange: rename.range,
            command: { title: "Superborrow rename accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: "language-server" }] },
          })];
        }
        const target = languageEdits ? missingImportAt(doc, position) : undefined;
        if (target) {
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const lookup = autoImports.find(doc, target, () => { if (timedOut) refreshImport(doc, version, target); });
          const wait = new Promise<undefined>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(undefined); }, 90); });
          const edit = await Promise.race([lookup.catch(() => undefined), wait]);
          clearTimeout(timer);
          if (token.isCancellationRequested || doc.isClosed || doc.version !== version || epoch !== requestEpoch) return [];
          if (edit && editor === vscode.window.activeTextEditor && editor.selection.active.isEqual(position)
            && missingImportAt(doc, position)?.isEqual(target)) {
            claimLanguageSuggestion("language service import");
            const item: vscode.InlineCompletionItem & { isInlineEdit: boolean; showRange: vscode.Range } =
              Object.assign(new vscode.InlineCompletionItem(edit.newText, edit.range), {
                isInlineEdit: true,
                showRange: new vscode.Range(target.start, doc.lineAt(target.end.line).range.end),
                command: { title: "Superborrow import accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: "language-server" }] },
              });
            lastInlineLatencyMs = Math.round((performance.now() - started) * 100) / 100;
            return [item];
          }
        }
        const remaining = members.remaining(doc, doc.offsetAt(position));
        const lookup = remaining ? undefined : members.find(doc, position);
        let member = remaining;
        if (lookup) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const limit = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), models.available ? 60 : 150); });
          member = await Promise.race([lookup, limit]);
          clearTimeout(timer);
          if (token.isCancellationRequested || doc.isClosed || doc.version !== version || epoch !== requestEpoch
            || editor !== vscode.window.activeTextEditor || editor.selections.length !== 1
            || !editor.selection.isEmpty || !editor.selection.active.isEqual(position)) return [];
        }
        if (member) {
          claimLanguageSuggestion("language service completed member");
          const item = new vscode.InlineCompletionItem(member, new vscode.Range(position, position));
          item.command = { title: "Superborrow completion accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: "language-server" }] };
          if (remaining === undefined) members.offered(item, doc, position, member);
          lastInlineLatencyMs = Math.round((performance.now() - started) * 100) / 100;
          return [item];
        }
      }
      if (mode() === "ide" && !models.available) { lastDiscardReason = "IDE model unavailable"; return []; }
      const replacement = recentReplacement;
      // General Rust replacements can change ownership, patterns and error
      // handling outside the requested gap. Keep them in reviewed Next Edit.
      if (duskline && doc.languageId !== "rust" && config().get("inlineNextEdit", true) && !completionContext.selectedCompletionInfo
        && replacement?.doc === doc && replacement.version === version && performance.now() - replacement.time < 4000
        && position.line >= replacement.startLine && position.line <= replacement.endLine) {
        const range = new vscode.Range(replacement.startLine, 0, replacement.endLine, doc.lineAt(replacement.endLine).range.end.character);
        const before = doc.getText(range);
        if (before.trim() && Buffer.byteLength(before) <= 512) {
          inlineEditRequests++;
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          if (token.isCancellationRequested) controller.abort();
          try {
            const key = `edit:${requestEpoch}:${doc.uri}:${version}`;
            const saved = editCache.get(key);
            const result = replacement.localText || saved !== undefined ? saved : await sharedRequest(key, controller.signal, doc, range.start, {
              kind: "nextEdit", endPosition: { line: range.end.line, character: range.end.character },
              instruction: "Predict a minimal follow-up to the latest edit within the selected lines. Keep unrelated code. Return <NO_COMPLETION> if the selection already looks correct.",
              explicit: true,
            });
            const text = replacement.localText ?? (result && codeOnlySuggestion(result.text, doc.languageId).replace(/\r\n|\r|\n/g, doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
            if (token.isCancellationRequested || doc.isClosed || doc.version !== version || epoch !== requestEpoch) return [];
            if (saved === undefined && result) editCache.put(key, text && text !== before ? result : null);
            if (text?.trim() && text !== before && !text.includes("```")) {
              const item: vscode.InlineCompletionItem & { isInlineEdit?: boolean; showRange?: vscode.Range } = new vscode.InlineCompletionItem(text, range);
              item.isInlineEdit = true;
              item.showRange = range;
              item.command = { title: "Superborrow edit accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: replacement.localText ? "local" : result?.provider, model: replacement.localText ? undefined : models.modelId }] };
              return [item];
            }
          } catch (error) { logError(error); }
          finally { cancellation.dispose(); lastInlineLatencyMs = Math.round((performance.now() - started) * 100) / 100; }
          return [];
        }
      }
      const rawInfill = usesRawInfill();
      const diagnostics = rawInfill ? [] : nearbyDiagnostics(vscode.languages.getDiagnostics(doc.uri), position.line);
      const diagnosticsKey = JSON.stringify(diagnostics);
      // A raw FIM request carries just source before/after the cursor. A late
      // linter refresh cannot invalidate the input and cancel a visible result.
      diagnosticsContext = rawInfill ? undefined : { doc, position, key: diagnosticsKey, meaning: diagnosticMeaningKey(diagnostics) };
      const key = `${epoch}:${doc.uri.toString()}:${doc.version}:${position.line}:${position.character}:${mode()}:${diagnosticsKey}`;
      try {
        const saved = continuation.get(doc.uri.toString(), doc.version, doc.offsetAt(position));
        const reused = saved?.metadata.diagnosticsKey === diagnosticsKey ? saved : undefined;
        const cached = reused ?? cache.get(key);
        let metadata = cached?.metadata;
        let text = cached?.text;
        if (reused) { continuationHits++; lastProvider = reused.metadata.provider; showStatus("cached"); }
        if (text === undefined) {
          const caller = new AbortController();
          const subscription = token.onCancellationRequested(() => caller.abort());
          if (token.isCancellationRequested) caller.abort();
          let result: CompletionResult | undefined;
          let normalized = false;
          let resultModel = models.modelId;
          try {
            if (mode() === "ide" && preparedIdeAvailable && models.concurrent && config().get<boolean>("speculativeTyping", true) && bridge && sync) {
              const current = bridge;
              const documents = sync;
              const settings = engineConfig();
              const model = models.modelId;
              const value = await speculative.run({ uri: doc.uri.toString(), version, languageId: doc.languageId, text: snapshotText(doc)!, offset: doc.offsetAt(position) }, `${requestEpoch}:${model ?? "adapter"}:${diagnosticMeaningKey(diagnostics)}`, caller.signal, (origin, signal) => withDeadline(signal, settings.requestTimeoutMs, async generationSignal => {
                abortActive("new IDE inline request");
                await debounce(duskline || completionContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? 0 : settings.debounceMs, generationSignal);
                if (generationSignal.aborted || doc.isClosed || epoch !== requestEpoch || bridge !== current) throw cancelled();
                // Forwarded edits never change text before the origin cursor;
                // use the editor's line index instead of splitting a large file.
                const originPosition = doc.positionAt(origin.offset);
                const relatedDocuments = await importedContext(doc, origin.text, generationSignal);
                if (generationSignal.aborted) throw cancelled();
                const prepared = await documents.withSnapshot({ uri: origin.uri, version: origin.version, languageId: origin.languageId, text: origin.text }, () => current.prepareIdeCompletion({ uri: origin.uri, version: origin.version, position: { line: originPosition.line, character: originPosition.character }, mode: "ide", diagnostics, ...(relatedDocumentsAvailable ? { relatedDocuments } : {}) }));
                if (generationSignal.aborted || doc.isClosed || epoch !== requestEpoch || bridge !== current) throw cancelled();
                if (prepared.version !== origin.version || prepared.kind !== "inline" || typeof prepared.prompt !== "string" || Buffer.byteLength(prepared.prompt, "utf8") > settings.maxContextBytes) throw new Error("Invalid prepared IDE context");
                const modelStarted = performance.now();
                modelRequests++;
                const answer = await models.generate({ ...prepared, requestId: `inline:${++sequence}` }, generationSignal);
                const clean = codeOnlySuggestion(cleanCompletion(answer.text), origin.languageId);
                const foreign = origin.languageId === "rust" && isForeignRustStatement(clean, origin.text.slice(0, origin.offset));
                return { text: foreign ? "" : inlineInsertion(clean, origin.text.slice(Math.max(0, origin.offset - 2048), origin.offset), origin.text.slice(origin.offset, origin.offset + 256), doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n", origin.languageId), metadata: { model, elapsedMs: Math.round(performance.now() - modelStarted) } };
              }));
              result = { text: value.text, version: value.version, provider: "ide", fallback: false, elapsedMs: value.metadata.elapsedMs };
              resultModel = value.metadata.model;
              normalized = true;
              lastProvider = "ide"; lastLatencyMs = result.elapsedMs; lastError = ""; lastDiscardReason = undefined;
              showStatus(`ide ${result.elapsedMs}ms${value.speculative ? " · reused" : ""}`);
            } else result = await sharedRequest(key, caller.signal, doc, position, { explicit: duskline || completionContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke });
          } finally { subscription.dispose(); }
          if (!result) return [];
          if (doc.isClosed || doc.version !== version || result.version !== version || epoch !== requestEpoch) { lastDiscardReason = "obsolete shared response"; return []; }
          const offset = doc.offsetAt(position);
          const sourceText = snapshotText(doc)!;
          const suffix = sourceText.slice(offset, offset + 256);
          text = normalized ? result.text : inlineInsertion(codeOnlySuggestion(result.text, doc.languageId), sourceText.slice(Math.max(0, offset - 2048), offset), suffix, doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n", doc.languageId);
          if (!normalized && doc.languageId === "rust" && isForeignRustStatement(text, doc.lineAt(position.line).text.slice(0, position.character))) text = "";
          metadata = { provider: result.provider, model: resultModel, diagnosticsKey };
          cache.put(key, { text, metadata });
          if (text) {
            continuation.put(doc.uri.toString(), doc.version, doc.offsetAt(position), text, metadata);
          }
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
          item.command = { title: "Superborrow completion accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: metadata?.provider ?? lastProvider, model: metadata?.model ?? models.modelId }] };
          return [item];
        }
        const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
        item.command = { title: "Superborrow completion accepted", command: "superborrow.accepted", arguments: [{ language: doc.languageId, provider: metadata?.provider ?? lastProvider, model: metadata?.model ?? models.modelId }] };
        return [item];
      } catch (error) { lastDiscardReason = `provider error ${(error as {code?:number})?.code ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`; logError(error); return []; }
      finally { lastInlineLatencyMs = Math.round((performance.now() - started) * 100) / 100; }
    },
  };
  let inlineRegistration: vscode.Disposable | undefined;
  const registerInlineProvider = () => {
    inlineRegistration?.dispose();
    const selector = [{ scheme: "file" }, { scheme: "untitled" }, { scheme: "vscode-notebook-cell" }];
    if (duskline) {
      // Duskline grants only this extension the inline-completions additions.
      // Keep the editor debounce for ordinary model requests.
      const register = vscode.languages.registerInlineCompletionItemProvider as (
        selector: vscode.DocumentSelector,
        provider: vscode.InlineCompletionItemProvider,
        metadata: { displayName: string; debounceDelayMs: number },
      ) => vscode.Disposable;
      inlineRegistration = register(selector, inlineProvider, { displayName: "Superborrow", debounceDelayMs: config().get("debounceMs", 60) });
    } else inlineRegistration = vscode.languages.registerInlineCompletionItemProvider(selector, inlineProvider);
  };
  registerInlineProvider();
  context.subscriptions.push({ dispose: () => inlineRegistration?.dispose() });
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.accepted", (accepted: typeof lastAccepted) => {
    acceptedCount++; lastAccepted = accepted;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.checkBridge", () => start(true)));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.cycleMode", async () => {
    if (duskline) return vscode.commands.executeCommand("superborrow.selectModel");
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
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.showOutput", () => {
    output.appendLine(`Tab performance: IDE model requests=${modelRequests}, shared requests=${inflight.shared + speculative.shared}, speculative hits=${speculative.hits}, continuation hits=${continuationHits}, last inline=${lastInlineLatencyMs ?? "n/a"}ms, last provider=${lastLatencyMs ?? "n/a"}ms; mode=${mode()}, model=${models.modelId ?? "unavailable"}`);
    output.show(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.enableCompositeTab", async () => {
    await config().update("manageNativeTab", true, vscode.ConfigurationTarget.Global);
    await config().update("hybridPreference", "ide", vscode.ConfigurationTarget.Global);
    await config().update("mode", "ide", vscode.ConfigurationTarget.Global);
    await config().update("enabled", true, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("editor").update("inlineSuggest.enabled", true, vscode.ConfigurationTarget.Global);
    await initializeModels();
    await coordinateNativeTab();
    await start(false);
    output.appendLine("Antigravity Tab enabled: IDE-only model routing; native Tab disabled. Restore Antigravity Tab restores the previous setting.");
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
      modelRetryAttempts = 0;
      lastError = ""; showStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastModelError) output.appendLine(`IDE model unavailable: ${message}`);
      lastModelError = message;
      lastError = message; showStatus("Model unavailable");
      const retryMs = Math.min(30000, 1500 * 2 ** Math.min(modelRetryAttempts++, 5));
      if (!disposed && enabled()) modelRetry = setTimeout(() => { void initializeModels(); }, retryMs);
      showStatus();
    }
  };
  context.subscriptions.push(vscode.extensions.onDidChange(() => { if (!models.available && enabled()) void initializeModels(); }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(event => {
    const tracked = diagnosticsContext;
    if (!tracked || tracked.doc.isClosed || !event.uris.some(uri => uri.toString() === tracked.doc.uri.toString())) return;
    const values = nearbyDiagnostics(vscode.languages.getDiagnostics(tracked.doc.uri), tracked.position.line);
    const key = JSON.stringify(values);
    if (key !== tracked.key) {
      const meaning = diagnosticMeaningKey(values);
      const movedOnly = meaning === tracked.meaning && speculative.uri === tracked.doc.uri.toString() && speculative.status.forwarded > 0;
      tracked.key = key; tracked.meaning = meaning;
      if (movedOnly) return;
      invalidate("nearby diagnostics changed");
      const version = tracked.doc.version;
      diagnosticRetry = setTimeout(() => {
        diagnosticRetry = undefined;
        const editor = vscode.window.activeTextEditor;
        if (disposed || !enabled() || !ready || diagnosticsContext !== tracked || !editor
          || editor.document !== tracked.doc || tracked.doc.version !== version
          || !editor.selection.active.isEqual(tracked.position)
          || !vscode.workspace.getConfiguration("editor", tracked.doc.uri).get<boolean>("inlineSuggest.enabled", true)) return;
        void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(undefined, logError);
      }, 120);
    }
  }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(event => {
    const editor = vscode.window.activeTextEditor;
    if (!ready || !enabled() || !languageEditsEnabled() || !editor?.selection.isEmpty || editor.selections.length !== 1) return;
    const doc = editor.document;
    if (!event.uris.some(uri => uri.toString() === doc.uri.toString()) || !eligible(doc)
      || !vscode.workspace.getConfiguration("editor", doc.uri).get("inlineSuggest.enabled", true)) return;
    const target = missingImportAt(doc, editor.selection.active);
    if (target) {
      const version = doc.version;
      void autoImports.find(doc, target, () => refreshImport(doc, version, target)).catch(() => {});
    }
  }));
  const importChanged = (uri: vscode.Uri) => {
    if (uri.scheme === "file" && imports.changed(uri.fsPath)) { imports.clear(); invalidate("imported source changed"); }
  };
  const importWatcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
  const sourceChanged = (uri: vscode.Uri) => { members.clear(); importChanged(uri); };
  context.subscriptions.push(importWatcher, importWatcher.onDidChange(sourceChanged), importWatcher.onDidCreate(sourceChanged), importWatcher.onDidDelete(sourceChanged));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { imports.clear(); renameFollowup.clear(); invalidate("workspace roots changed"); }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => { if (!disposed) { importChanged(doc.uri); void syncDocument(doc).catch(logError); } }));
  if (duskline) context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
    if (disposed || !ready || !enabled() || !languageEditsEnabled() || vscode.window.activeTextEditor !== textEditor) return;
    renameFollowup.observe(textEditor);
    const { document: doc, selection, selections } = textEditor;
    if (selections.length !== 1 || !selection.isEmpty || renameFollowup.suggest(doc, selection.active)?.kind !== "edit") return;
    if (dusklineTrigger) clearTimeout(dusklineTrigger);
    dusklineTrigger = setTimeout(() => {
      dusklineTrigger = undefined;
      if (disposed || !ready || !enabled() || !languageEditsEnabled() || vscode.window.activeTextEditor !== textEditor
        || !textEditor.selection.isEqual(selection) || textEditor.selections.length !== 1
        || renameFollowup.suggest(doc, selection.active)?.kind !== "edit"
        || !vscode.workspace.getConfiguration("editor", doc.uri).get("inlineSuggest.enabled", true)) return;
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(undefined, logError);
    }, 16);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length) {
      renameFollowup.changed(event);
      const uri = event.document.uri.toString();
      const previous = snapshots.get(event.document);
      if (!eligible(event.document) && !sync?.has(uri) && speculative.uri !== uri && activeUri !== uri) {
        ignoredDocumentChanges++; lastIgnoredScheme = event.document.uri.scheme;
        return;
      }
      const previousReplacement = recentReplacement?.doc === event.document ? recentReplacement : undefined;
      if (previousReplacement) recentReplacement = undefined;
      const change = event.contentChanges[0];
      if (duskline && !event.reason && event.contentChanges.length === 1) {
        const doc = event.document;
        const startLine = change.range.start.line;
        const endLine = doc.positionAt(change.rangeOffset + change.text.length).line;
        const now = performance.now();
        let rename: Rename | undefined;
        if (startLine === endLine && /^[$\w]{1,96}$/.test(change.text) && /^(java|type)script(?:react)?$/.test(doc.languageId)) {
          const earlier = previousReplacement?.rename;
          if (earlier && previousReplacement!.version + 1 === doc.version && now - previousReplacement!.time < 1500
            && change.rangeLength === 0 && change.rangeOffset === earlier.offset + earlier.typed.length) {
            rename = { ...earlier, typed: earlier.typed + change.text };
          } else if (change.rangeLength > 1 && previous?.version === doc.version - 1) {
            const oldName = previous.text?.slice(change.rangeOffset, change.rangeOffset + change.rangeLength);
            if (oldName && /^[$A-Z_a-z][$\w]{1,95}$/.test(oldName)) rename = { oldName, typed: change.text, offset: change.rangeOffset, column: change.range.start.character };
          }
        }
        if (endLine - startLine <= 2 && (rename || (change.rangeLength > 0 && (change.text.length > 1 || change.range.start.line !== change.range.end.line)))) {
          const localText = rename && followDeclarationRename(doc.lineAt(startLine).text, rename.column, rename.oldName, rename.typed);
          recentReplacement = { doc, version: doc.version, startLine, endLine, time: now, localText, rename };
        }
      }
      if (duskline && vscode.window.activeTextEditor?.document === event.document) {
        if (dusklineTrigger) clearTimeout(dusklineTrigger);
        dusklineTrigger = undefined;
        const renamePending = renameFollowup.active && languageEditsEnabled();
        if (!event.reason && event.contentChanges.length === 1 && enabled() && (models.available || renamePending)) {
          const doc = event.document;
          const version = doc.version;
          const offset = change.rangeOffset + change.text.length;
          dusklineTrigger = setTimeout(() => {
            dusklineTrigger = undefined;
            const editor = vscode.window.activeTextEditor;
            if (disposed || !ready || !enabled() || (!models.available && !(renameFollowup.active && languageEditsEnabled()))
              || editor?.document !== doc || doc.version !== version
              || editor.selections.length !== 1 || !editor.selection.isEmpty || doc.offsetAt(editor.selection.active) !== offset
              || (lastInlineRequest?.doc === doc && lastInlineRequest.version === version && lastInlineRequest.offset === offset)
              || !vscode.workspace.getConfiguration("editor", doc.uri).get("inlineSuggest.enabled", true)) return;
            void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(undefined, logError);
          }, renamePending ? 16 : Math.max(225, config().get<number>("debounceMs", 60)));
        }
      }
      continuation.advance(event.document.uri.toString(), event.document.version, event.contentChanges);
      members.changed(event);
      const forwarded = speculative.uri === uri && mode() === "ide" && enabled() && eligible(event.document) && speculative.advance({ uri, version: event.document.version, languageId: event.document.languageId, text: snapshotText(event.document)! }, event.contentChanges);
      if (forwarded) {
        cache.clear();
        if (diagnosticRetry) { clearTimeout(diagnosticRetry); diagnosticRetry = undefined; }
        if (diagnosticsContext?.doc === event.document) diagnosticsContext.position = event.document.positionAt(event.contentChanges[0].rangeOffset + event.contentChanges[0].text.length);
      } else invalidate("document content changed", true);
      const doc = event.document;
      if (duskline && ready && enabled() && vscode.workspace.isTrusted && !event.reason && event.contentChanges.length === 1
        && vscode.window.activeTextEditor?.document === doc && change.range.isSingleLine && !/\r|\n/.test(change.text)) {
        members.prepare(doc, doc.positionAt(change.rangeOffset + change.text.length));
      }
      const currentText = snapshots.get(doc)?.text;
      const before = previous?.text;
      let patch: DocumentPatchParams | undefined;
      if (sync?.allowPatches && event.contentChanges.length === 1 && previous?.version === doc.version - 1 && before !== undefined
        && currentText !== undefined && before.length >= 1024 && Buffer.byteLength(change.text, "utf8") <= 8192
        && change.text.length < currentText.length) {
        const { range, rangeOffset, rangeLength, text } = change;
        if (currentText === before.slice(0, rangeOffset) + text + before.slice(rangeOffset + rangeLength)) {
          patch = {
            uri, baseVersion: previous.version, version: doc.version,
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character }, text,
          };
        }
      }
      void syncDocument(doc, patch).catch(logError);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
    renameFollowup.closed(doc);
    if (sync?.has(doc.uri.toString()) || speculative.uri === doc.uri.toString()) { invalidate(); void sync?.close(doc.uri.toString()).catch(logError); }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    members.clear();
    if (editor?.document.uri.toString() !== activeUri) abortActive("active editor changed");
    if (speculative.uri && editor?.document.uri.toString() !== speculative.uri) speculative.cancel("active editor changed");
    if (editor) void syncDocument(editor.document).catch(logError);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration("superborrow") && !(duskline && event.affectsConfiguration("duskline.tabModel"))) return;
    imports.clear();
    renameFollowup.clear();
    invalidate();
    if (duskline && event.affectsConfiguration("superborrow.debounceMs")) registerInlineProvider();
    if (event.affectsConfiguration("superborrow.ideAdapterExtension") || event.affectsConfiguration("superborrow.ideModel") || (duskline && event.affectsConfiguration("duskline.tabModel"))) {
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
  context.subscriptions.push({ dispose: () => { disposed = true; if (modelRetry) clearTimeout(modelRetry); if (dusklineTrigger) clearTimeout(dusklineTrigger); renameFollowup.clear(); invalidate(); previews.clear(); bridge?.dispose(); } });
  const startup = Promise.all([start(false), initializeModels()]).then(() => {});
  return Object.freeze({
    apiVersion: 1,
    ready: startup,
    getStatus: () => ({ connected: ready, enabled: enabled(), mode: mode(), coreVersion, preparedIdeAvailable, documentPatches: sync?.patches ?? 0, imports: imports.status, speculative: speculative.status, ignoredDocumentChanges, ignoredCursorRequests, lastIgnoredScheme, ideAvailable: models.available, model: models.modelId, modelLabel: models.label, nativeTabManaged, lastProvider, lastLatencyMs, lastInlineLatencyMs, continuationHits, sharedRequests: inflight.shared + speculative.shared, modelRequests, inlineEditRequests, lastDiscardReason, lastCancellationReason, shownCount, shownEditCount, shownJumpCount, renamePrepared: renameFollowup.prepared, renameActive: renameFollowup.active, acceptedCount, lastAccepted, lastError }),
    provideInlineCompletionItems: (doc: vscode.TextDocument, position: vscode.Position, completionContext: vscode.InlineCompletionContext, token: vscode.CancellationToken) => inlineProvider.provideInlineCompletionItems(doc, position, completionContext, token),
  });
}

export async function deactivate(): Promise<void> { await bridge?.shutdown(); bridge = undefined; }
