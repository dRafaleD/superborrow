import * as path from 'node:path';
import type * as VS from 'vscode';

export class Position {
  constructor(public line: number, public character: number) {}
  isEqual(other: Position) { return this.line === other.line && this.character === other.character; }
  translate(line = 0, character = 0) { return new Position(this.line + line, this.character + character); }
}
export class Range {
  start: Position; end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c!, d!) : b as Position;
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  isEqual(other: Range) { return this.start.isEqual(other.start) && this.end.isEqual(other.end); }
  contains(position: Position) { return position.line >= this.start.line && position.line <= this.end.line && (position.line !== this.start.line || position.character >= this.start.character) && (position.line !== this.end.line || position.character <= this.end.character); }
}
export class Selection extends Range { get active() { return this.end; } }
export class CancellationTokenSource {
  private listeners = new Set<() => void>();
  token = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; } };
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; for (const listener of this.listeners) listener(); } }
  dispose() { this.listeners.clear(); }
}
const disposable = () => ({ dispose() {} });
const event = () => {
  const listeners = new Set<(value: any) => void>();
  return Object.assign((listener: (value: any) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, { fire: (value: any) => { for (const listener of listeners) listener(value); } });
};
const uri = (value: string) => ({ scheme: value.split(':')[0], authority: '', fsPath: value.replace(/^file:\/\//, ''), toString: () => value });

export function createStub() {
  const commands = new Map<string, (...args: any[]) => any>();
  const settings = new Map<string, unknown>([['corePath', path.resolve(__dirname, '../../../core-rust/target/debug', process.platform === 'win32' ? 'superborrow-core.exe' : 'superborrow-core')], ['debounceMs', 0], ['requestTimeoutMs', 4000]]);
  const state = {
    adapter: {} as any,
    diagnostics: [] as any[],
    command: async (_name: string, ..._args: any[]): Promise<any> => undefined,
  };
  const noop = () => {};
  const vscode = {
    Position, Range, Selection, CancellationTokenSource,
    Uri: { parse: uri, file: (filename: string) => uri(`file://${filename}`) },
    EndOfLine: { LF: 1, CRLF: 2 }, ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Right: 2 },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    InlineCompletionItem: class { command?: unknown; constructor(public insertText: string, public range?: Range) {} },
    CodeActionKind: { QuickFix: { value: 'quickfix', contains: (kind: any) => kind.value === 'quickfix' } },
    CompletionItemKind: { Property: 9, Field: 4, EnumMember: 19, Method: 1, Function: 2 },
    env: { appName: 'Duskline IDE' },
    commands: {
      registerCommand: (name: string, action: (...args: any[]) => any) => { commands.set(name, action); return disposable(); },
      executeCommand: (name: string, ...args: any[]) => commands.has(name) ? Promise.resolve(commands.get(name)!(...args)) : state.command(name, ...args),
    },
    extensions: { getExtension: () => ({ activate: async () => ({ superborrowCompletionProvider: state.adapter }) }), onDidChange: event() },
    window: {
      activeTextEditor: undefined as any,
      createOutputChannel: () => ({ appendLine: noop, clear: noop, dispose: noop, show: noop }),
      createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: noop, dispose: noop }),
      onDidChangeTextEditorSelection: event(), onDidChangeActiveTextEditor: event(),
    },
    languages: { getDiagnostics: () => state.diagnostics, onDidChangeDiagnostics: event(), registerInlineCompletionItemProvider: disposable },
    workspace: {
      isTrusted: true, textDocuments: [] as any[],
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.has(key) ? settings.get(key) : fallback }),
      getWorkspaceFolder: () => undefined,
      createFileSystemWatcher: () => ({ dispose: noop, onDidChange: event(), onDidCreate: event(), onDidDelete: event() }),
      registerTextDocumentContentProvider: disposable,
      onDidChangeWorkspaceFolders: event(), onDidOpenTextDocument: event(), onDidChangeTextDocument: event(), onDidCloseTextDocument: event(), onDidChangeConfiguration: event(),
    },
  };
  const context = { subscriptions: [] as VS.Disposable[], extensionPath: path.resolve(__dirname, '../..'), globalState: { get: () => undefined, update: async () => {} } } as unknown as VS.ExtensionContext;
  return { vscode, state, context, settings };
}

export function document(text: string, languageId: string, filename = 'untitled:fixture') {
  const doc = {
    uri: uri(filename), version: 1, languageId, isClosed: false, eol: 1,
    get lineCount() { return text.split('\n').length; },
    getText: (range?: Range) => range ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : text,
    offsetAt: (position: Position) => text.split('\n').slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character,
    positionAt: (offset: number) => { const lines = text.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines.at(-1)!.length); },
    lineAt: (line: number) => { const value = text.split('\n')[line]; return { text: value, range: new Range(line, 0, line, value.length) }; },
    validateRange: (range: Range) => range,
    getWordRangeAtPosition: (position: Position) => { const line = text.split('\n')[position.line]; for (const match of line.matchAll(/[$\w]+/g)) if (match.index! <= position.character && position.character <= match.index! + match[0].length) return new Range(position.line, match.index!, position.line, match.index! + match[0].length); },
  };
  return doc as unknown as VS.TextDocument;
}
