import * as vscode from "vscode";

const identifier = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const identifierWord = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u;
const placeholder = "__superborrowRenameTarget__";
const maxLocations = 32;
const planLifetimeMs = 4000;
const followupLifetimeMs = 12000;

interface Location {
  doc: vscode.TextDocument;
  version: number;
  start: number;
  end: number;
}

interface Query {
  origin: Location;
  oldName: string;
  references?: Location[];
  expires: number;
}

interface Session {
  origin: Location;
  anchor: Location;
  oldName: string;
  name: string;
  references: Location[];
  applied: boolean;
  expires: number;
}

export type RenameSuggestion =
  | { kind: "jump"; uri: vscode.Uri; version: number; position: vscode.Position }
  | { kind: "edit"; range: vscode.Range; text: string };

/** Follow one intentional rename at a time. The language service only supplies
 * locations. Each replacement is a separate native inline edit. */
export class RenameFollowup {
  private query?: Query;
  private session?: Session;

  constructor(private readonly eligible: (doc: vscode.TextDocument) => boolean) {}

  get prepared(): boolean { return !!this.query?.references && this.query.expires > performance.now(); }
  get active(): boolean { return !!this.session?.references.length && this.session.expires > performance.now(); }

  observe(editor: vscode.TextEditor): void {
    const { document: doc, selection, selections } = editor;
    if (this.active || selections.length !== 1 || selection.isEmpty || !selection.isSingleLine || !this.file(doc)) return;
    const word = doc.getWordRangeAtPosition(selection.start, identifierWord);
    const oldName = doc.getText(selection);
    if (!word?.isEqual(selection) || oldName.length > 96 || !identifier.test(oldName)) return;
    const origin = this.location(doc, selection);
    if (this.query && this.query.origin.doc === doc && this.query.origin.version === doc.version
      && this.query.origin.start === origin.start && this.query.expires > performance.now()) return;
    const query: Query = { origin, oldName, expires: performance.now() + planLifetimeMs };
    this.query = query;
    void this.prepare(query, selection.start).catch(() => { if (this.query === query) this.query = undefined; });
  }

  private async prepare(query: Query, position: vscode.Position): Promise<void> {
    const { origin, oldName } = query;
    const open = new Map(vscode.workspace.textDocuments.map(doc => [doc.uri.toString(), { doc, version: doc.version }]));
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider", origin.doc.uri, position, placeholder,
    );
    if (!edit || this.query !== query || !this.valid(origin, oldName)) return;
    const root = (doc: vscode.TextDocument) => (vscode.workspace.getWorkspaceFolder(doc.uri)?.uri ?? vscode.Uri.joinPath(doc.uri, "..")).toString();
    const folder = root(origin.doc);
    const references: Location[] = [];
    let includesOrigin = false;
    for (const [uri, edits] of edit.entries()) {
      const snapshot = open.get(uri.toString());
      if (!snapshot || snapshot.doc.version !== snapshot.version || !this.file(snapshot.doc) || root(snapshot.doc) !== folder) continue;
      const { doc } = snapshot;
      for (const value of edits) {
        if (value.newText !== placeholder || !doc.validateRange(value.range).isEqual(value.range) || doc.getText(value.range) !== oldName) continue;
        const reference = this.location(doc, value.range);
        if (doc === origin.doc && reference.start === origin.start && reference.end === origin.end) includesOrigin = true;
        else if (!references.some(other => other.doc === doc && other.start === reference.start)) references.push(reference);
        if (references.length > maxLocations) return;
      }
    }
    if (!includesOrigin || !references.length) return;
    references.sort((a, b) => Number(b.doc === origin.doc) - Number(a.doc === origin.doc)
      || a.doc.uri.toString().localeCompare(b.doc.uri.toString()) || a.start - b.start);
    query.references = references;
  }

  changed(event: vscode.TextDocumentChangeEvent): void {
    const doc = event.document;
    const change = event.contentChanges[0];
    if (!change) return;
    if (this.query?.origin.doc === doc) {
      const query = this.query;
      this.query = undefined;
      const origin = query.origin;
      if (!event.reason && event.contentChanges.length === 1 && query.references && query.expires > performance.now()
        && doc.version === origin.version + 1 && change.rangeOffset === origin.start && change.rangeLength === origin.end - origin.start
        && this.nameAllowed(change.text)) {
        const replacement = { doc, version: doc.version, start: origin.start, end: origin.start + change.text.length };
        this.shift(query.references, origin, replacement);
        this.session = { origin: replacement, anchor: replacement, references: query.references, oldName: query.oldName,
          name: change.text, applied: false, expires: performance.now() + followupLifetimeMs };
        return;
      }
    }
    const session = this.session;
    if (!session || (doc !== session.origin.doc && doc !== session.anchor.doc && !session.references.some(reference => reference.doc === doc))) return;
    const target = session.references[0];
    if (!event.reason && event.contentChanges.length === 1 && this.active) {
      if (!session.applied && doc === session.origin.doc && this.inside(session.origin, change)) {
        const replacement = { ...session.origin, version: doc.version, end: session.origin.end + change.text.length - change.rangeLength };
        const name = doc.getText(this.range(replacement));
        if (this.nameAllowed(name)) {
          this.shift(session.references, session.origin, replacement);
          session.origin = replacement;
          session.anchor = replacement;
          session.name = name;
          session.expires = performance.now() + followupLifetimeMs;
          return;
        }
      } else if (target?.doc === doc && this.inside(target, change)) {
        const replacement = { ...target, version: doc.version, end: target.end + change.text.length - change.rangeLength };
        if (doc.getText(this.range(replacement)) === session.name) {
          session.references.shift();
          this.shift(session.references, target, replacement);
          session.anchor = replacement;
          session.applied = true;
          session.expires = performance.now() + followupLifetimeMs;
          return;
        }
      }
    }
    this.session = undefined;
  }

  suggest(doc: vscode.TextDocument, position: vscode.Position): RenameSuggestion | undefined {
    const session = this.session;
    const target = session?.references[0];
    if (!session || !target || !this.active || !session.name || session.name === session.oldName) return;
    if (doc !== target.doc && doc !== session.anchor.doc) return;
    const offset = doc.offsetAt(position);
    const atTarget = doc === target.doc && offset === target.start;
    const atAnchor = doc === session.anchor.doc && offset === session.anchor.end && this.valid(session.anchor, session.name);
    if ((!atTarget && !atAnchor) || !this.valid(target, session.oldName)) return;
    return atTarget ? { kind: "edit", range: this.range(target), text: session.name }
      : { kind: "jump", uri: target.doc.uri, version: target.version, position: target.doc.positionAt(target.start) };
  }

  destination(uri: string, version: number, line: number, character: number): vscode.TextDocument | undefined {
    const session = this.session;
    const target = session?.references[0];
    if (!session || !target || !this.active || target.doc.uri.toString() !== uri || target.version !== version
      || !this.valid(target, session.oldName) || !this.valid(session.anchor, session.name)) return;
    const position = target.doc.positionAt(target.start);
    if (position.line === line && position.character === character) return target.doc;
  }

  clear(): void { this.query = undefined; this.session = undefined; }

  closed(doc: vscode.TextDocument): void {
    const query = this.query;
    if (query?.origin.doc === doc || query?.references?.some(reference => reference.doc === doc)) this.query = undefined;
    const session = this.session;
    if (session?.origin.doc === doc || session?.anchor.doc === doc || session?.references.some(reference => reference.doc === doc)) this.session = undefined;
  }

  private file(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === "file" && !doc.uri.authority && /^(?:javascript|typescript)(?:react)?$/.test(doc.languageId) && this.eligible(doc);
  }

  private location(doc: vscode.TextDocument, range: vscode.Range): Location {
    return { doc, version: doc.version, start: doc.offsetAt(range.start), end: doc.offsetAt(range.end) };
  }

  private range(location: Location): vscode.Range {
    return new vscode.Range(location.doc.positionAt(location.start), location.doc.positionAt(location.end));
  }

  private valid(location: Location, text: string): boolean {
    return !location.doc.isClosed && location.doc.version === location.version && location.doc.getText(this.range(location)) === text;
  }

  private nameAllowed(name: string): boolean { return name === "" || (name.length <= 96 && identifier.test(name)); }

  private inside(location: Location, change: vscode.TextDocumentContentChangeEvent): boolean {
    return location.doc.version === location.version + 1 && change.rangeOffset >= location.start
      && change.rangeOffset + change.rangeLength <= location.end;
  }

  private shift(references: Location[], before: Location, after: Location): void {
    for (const reference of references) {
      if (reference.doc !== before.doc) continue;
      reference.version = after.version;
      if (reference.start >= before.end) {
        reference.start += after.end - before.end;
        reference.end += after.end - before.end;
      }
    }
  }
}
