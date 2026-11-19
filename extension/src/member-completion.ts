import * as vscode from "vscode";
import { ContinuationCache } from "./completion";

const memberPrefix = /\.([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]{1,63})$/u;
const identifier = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const identifierContinue = /^[$\u200c\u200d\p{ID_Continue}]/u;

function memberAt(doc: vscode.TextDocument, position: vscode.Position) {
  if ((doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") || !/^(typescript|javascript)(react)?$/.test(doc.languageId)) return;
  const line = doc.lineAt(position.line).text;
  const suffix = line.slice(position.character, position.character + 64);
  if (identifierContinue.test(suffix)) return;
  const prefix = memberPrefix.exec(line.slice(Math.max(0, position.character - 65), position.character))?.[1];
  if (prefix) return { prefix, existingCall: /^\s*(?:\?\.)?\(/.test(suffix) };
}

export class MemberCompletion {
  private readonly continuation = new ContinuationCache<undefined>(Date.now, 2000);
  private pendingDisplay?: WeakMap<vscode.InlineCompletionItem, {
    doc: vscode.TextDocument; version: number; offset: number; text: string;
  }>;
  private current?: {
    doc: vscode.TextDocument;
    version: number;
    position: vscode.Position;
    result: Promise<string | undefined>;
    expires: number;
  };
  private busy = false;
  private prefetch?: ReturnType<typeof setTimeout>;

  remaining(doc: vscode.TextDocument, offset: number): string | undefined {
    return this.continuation.get(doc.uri.toString(), doc.version, offset)?.text;
  }

  offered(item: vscode.InlineCompletionItem, doc: vscode.TextDocument, position: vscode.Position, text: string): void {
    (this.pendingDisplay ??= new WeakMap()).set(item, { doc, version: doc.version, offset: doc.offsetAt(position), text });
  }

  shown(item: vscode.InlineCompletionItem): void {
    const origin = this.pendingDisplay?.get(item);
    if (!origin) return;
    this.pendingDisplay?.delete(item);
    const { doc, version, offset, text } = origin;
    const editor = vscode.window.activeTextEditor;
    if (doc.isClosed || doc.version !== version || editor?.document !== doc || editor.selections.length !== 1
      || !editor.selection.isEmpty || doc.offsetAt(editor.selection.active) !== offset) return;
    this.continuation.put(doc.uri.toString(), version, offset, text, undefined);
  }

  changed(event: vscode.TextDocumentChangeEvent): void {
    if (event.reason) this.continuation.clear();
    else this.continuation.advance(event.document.uri.toString(), event.document.version, event.contentChanges);
  }

  find(doc: vscode.TextDocument, position: vscode.Position): Promise<string | undefined> | undefined {
    const member = memberAt(doc, position);
    if (!member) return;
    if (this.current?.doc === doc && this.current.version === doc.version && this.current.position.isEqual(position)
      && performance.now() < this.current.expires) return this.current.result;
    if (this.busy) return;

    const version = doc.version;
    this.busy = true;
    const result: Promise<string | undefined> = this.query(doc, position, version, member)
      .then(text => this.current?.result === result ? text : undefined, () => undefined)
      .finally(() => { this.busy = false; });
    this.current = { doc, version, position, result, expires: performance.now() + 1000 };
    return result;
  }

  prepare(doc: vscode.TextDocument, position: vscode.Position): void {
    if (this.prefetch) clearTimeout(this.prefetch);
    const offset = doc.offsetAt(position);
    if (this.remaining(doc, offset) || !memberAt(doc, position)) return;
    const version = doc.version;
    this.prefetch = setTimeout(() => {
      this.prefetch = undefined;
      const editor = vscode.window.activeTextEditor;
      if (doc.isClosed || doc.version !== version || editor?.document !== doc || editor.selections.length !== 1
        || !editor.selection.isEmpty || !editor.selection.active.isEqual(position)
        || !vscode.workspace.getConfiguration("editor", doc.uri).get("inlineSuggest.enabled", true)) return;
      if (!this.remaining(doc, offset)) void this.find(doc, position);
    }, 20);
  }

  clear(preserveContinuation = false): void {
    if (!preserveContinuation) this.continuation.clear();
    this.pendingDisplay = undefined;
    this.current = undefined;
    if (this.prefetch) clearTimeout(this.prefetch);
    this.prefetch = undefined;
  }

  private async query(doc: vscode.TextDocument, position: vscode.Position, version: number,
    { prefix, existingCall }: { prefix: string; existingCall: boolean }): Promise<string | undefined> {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", doc.uri, position,
    );
    if (!list || list.isIncomplete || doc.isClosed || doc.version !== version) return;
    const typed = new vscode.Range(position.translate(0, -prefix.length), position);
    let unique: string | undefined;
    for (const item of list.items) {
      const label = typeof item.label === "string" ? item.label : item.label.label;
      if (!label.startsWith(prefix) || !identifier.test(label)) continue;
      const plainMember = item.kind === vscode.CompletionItemKind.Property || item.kind === vscode.CompletionItemKind.Field
        || item.kind === vscode.CompletionItemKind.EnumMember;
      const callableMember = existingCall && (item.kind === vscode.CompletionItemKind.Method || item.kind === vscode.CompletionItemKind.Function);
      // The built-in TypeScript provider attaches its resolver command even
      // to ordinary property entries. Only use the plain insertion itself.
      if (label === prefix || (item.command && item.command.command !== "_typescript.applyCompletionCommand") || item.additionalTextEdits?.length
        || (item.insertText !== undefined && item.insertText !== label) || (!plainMember && !callableMember)) return;
      const range = item.range && ("replacing" in item.range ? item.range.replacing : item.range);
      if (range && !range.isEqual(typed)) return;
      if (unique && unique !== label) return;
      unique = label;
    }
    return unique?.slice(prefix.length);
  }
}
