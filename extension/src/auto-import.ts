import * as vscode from "vscode";

const identifierPattern = String.raw`[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*`;
const wordPattern = new RegExp(identifierPattern, "u");
const identifier = new RegExp(`^${identifierPattern}$`, "u");
const namespacePattern = new RegExp(String.raw`^\*\s+as\s+(${identifierPattern})$`, "u");
const bindingPattern = new RegExp(String.raw`^(type\s+)?(${identifierPattern})(?:\s+as\s+(${identifierPattern}))?$`, "u");

export function missingImportAt(doc: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  if (doc.uri.scheme !== "file" || !/^(typescript|javascript)(react)?$/.test(doc.languageId)) return;
  for (const diagnostic of vscode.languages.getDiagnostics(doc.uri)) {
    const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
    const { range } = diagnostic;
    if (diagnostic.source !== "ts" || (code !== 2304 && code !== 2552) || !range.isSingleLine
      || range.start.line !== position.line || position.character < range.start.character || position.character > range.end.character + 2) continue;
    const word = doc.getWordRangeAtPosition(range.start, wordPattern);
    if (word?.isEqual(range) && identifier.test(doc.getText(range))) return range;
  }
}

function importDeclaration(text: string) {
  const declaration = /^\s*import\s+(type\s+)?([^;'"`]+?)\s+from\s+(['"])([^'"\r\n]+)\3[ \t]*;?\s*$/.exec(text);
  if (!declaration) return;
  const clause = declaration[2].trim();
  const namedStart = clause.indexOf("{");
  const firstBinding = namedStart < 0 ? clause : clause.slice(0, namedStart).trim();
  if (namedStart >= 0 && firstBinding && !firstBinding.endsWith(",")) return;
  const defaultOrNamespace = firstBinding.replace(/,$/, "").trim();
  const bindings = new Map<string, string>();
  if (defaultOrNamespace) {
    const namespace = namespacePattern.exec(defaultOrNamespace);
    if (namespace && namedStart < 0) bindings.set(namespace[1], "*");
    else if (identifier.test(defaultOrNamespace)) bindings.set(defaultOrNamespace, "default");
    else return;
  }
  if (namedStart >= 0) {
    if (!clause.endsWith("}")) return;
    const names = clause.slice(namedStart + 1, -1).trim().replace(/,$/, "");
    for (const entry of names ? names.split(",") : []) {
      const binding = bindingPattern.exec(entry.trim());
      if (!binding) return;
      const local = binding[3] ?? binding[2];
      if (bindings.has(local)) return;
      bindings.set(local, `named:${binding[1] ? "type:" : ""}${binding[2]}`);
    }
  }
  return { module: declaration[4], typeOnly: Boolean(declaration[1]), bindings };
}

function addsImport(doc: vscode.TextDocument, edit: vscode.TextEdit, name: string): boolean {
  if (edit.newEol !== undefined || edit.newText.length > 1024) return false;
  const { range } = edit;
  if (!doc.validateRange(range).isEqual(range)) return false;
  if (range.isEmpty) {
    const inserted = importDeclaration(edit.newText);
    if (inserted?.bindings.size === 1 && inserted.bindings.has(name)) {
      const line = doc.lineAt(range.start.line).text;
      return /^[ \t]*$/.test(line.slice(0, range.start.character)) || (range.start.character === line.length && /^\r?\n/.test(edit.newText));
    }
  }
  // The server can instead insert a binding into an existing import. Inspect a
  // bounded declaration around the edit, preserving its module and bindings.
  const first = Math.max(0, range.start.line - 11);
  for (let start = range.start.line; start >= first; start--) {
    if (!/^\s*import\s/.test(doc.lineAt(start).text)) continue;
    const beginning = new vscode.Position(start, 0);
    const baseOffset = doc.offsetAt(beginning);
    const limit = Math.min(doc.lineCount - 1, start + 11);
    for (let end = range.end.line; end <= limit; end++) {
      const ending = doc.lineAt(end).range.end;
      if (doc.offsetAt(ending) - baseOffset > 1024) return false;
      const text = doc.getText(new vscode.Range(beginning, ending));
      const before = importDeclaration(text);
      if (!before) continue;
      if (before.bindings.has(name)) return false;
      const after = importDeclaration(text.slice(0, doc.offsetAt(range.start) - baseOffset)
        + edit.newText + text.slice(doc.offsetAt(range.end) - baseOffset));
      return !!after && before.module === after.module && before.typeOnly === after.typeOnly
        && after.bindings.size === before.bindings.size + 1 && after.bindings.has(name)
        && [...before.bindings].every(([local, binding]) => after.bindings.get(local) === binding);
    }
    break;
  }
  return false;
}

export class AutoImports {
  private current?: { doc: vscode.TextDocument; version: number; range: vscode.Range; expires: number; result: Promise<vscode.TextEdit | undefined> };

  find(doc: vscode.TextDocument, range: vscode.Range, onReady: (edit: vscode.TextEdit) => void): Promise<vscode.TextEdit | undefined> {
    if (this.current?.doc === doc && this.current.version === doc.version && this.current.range.isEqual(range)
      && this.current.expires > performance.now()) return this.current.result;
    const version = doc.version;
    const name = doc.getText(range);
    const result = this.query(doc, range, version, name);
    const pending = { doc, version, range, result, expires: Infinity };
    this.current = pending;
    void result.then(edit => {
      pending.expires = performance.now() + 2000;
      if (edit && this.current === pending) onReady(edit);
    }, () => {
      if (this.current === pending) this.current = undefined;
    });
    return result;
  }

  clear(): void { this.current = undefined; }

  private async query(doc: vscode.TextDocument, range: vscode.Range, version: number, name: string): Promise<vscode.TextEdit | undefined> {
    const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
      "vscode.executeCodeActionProvider", doc.uri, range, vscode.CodeActionKind.QuickFix.value, 4,
    );
    if (doc.isClosed || doc.version !== version || !actions || actions.length > 24) return;
    let result: vscode.TextEdit | undefined;
    for (const action of actions) {
      if (!("edit" in action) || action.disabled || !action.kind || !vscode.CodeActionKind.QuickFix.contains(action.kind)) continue;
      const entries = action.edit?.entries();
      if (entries?.length !== 1 || entries[0][0].toString() !== doc.uri.toString() || entries[0][1].length !== 1) continue;
      const [edit] = entries[0][1];
      if (!addsImport(doc, edit, name)) continue;
      if (result && (!result.range.isEqual(edit.range) || result.newText !== edit.newText)) return;
      result = edit;
    }
    return result;
  }
}
