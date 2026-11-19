import { DocumentPatchParams, UpdateDocumentParams } from "./protocol";

interface DocumentTransport {
  updateDocument(params: UpdateDocumentParams): Promise<void>;
  patchDocument?(params: DocumentPatchParams): Promise<void>;
  closeDocument(uri: string): Promise<void>;
}

/** Serializes snapshots and closes to preserve versions under rapid editing. */
export class DocumentSync {
  private chain: Promise<void> = Promise.resolve();
  private readonly versions = new Map<string, { version: number; languageId: string }>();
  private pendingUpdate: { snapshot: UpdateDocumentParams; patch?: DocumentPatchParams; operation: Promise<void> } | undefined;
  private appliedPatches = 0;
  constructor(private readonly bridge: DocumentTransport, readonly allowPatches = false) {}

  /** Keep snapshot synchronization and prompt preparation in one queue slot.
   * Newer editor updates cannot overtake preparation of this exact version.
   */
  withSnapshot<T>(snapshot: UpdateDocumentParams, prepare: () => Promise<T>): Promise<T> {
    // Preparation is an ordering barrier: never merge a later edit into an
    // update that must precede this exact snapshot.
    this.pendingUpdate = undefined;
    const operation = this.chain.then(async () => {
      if ((this.versions.get(snapshot.uri)?.version ?? -1) > snapshot.version) throw Object.assign(new Error("Document snapshot superseded"), { code: -32801 });
      await this.transmit(snapshot);
      return prepare();
    });
    this.chain = operation.then(() => {}, () => {});
    return operation;
  }

  private async transmit(snapshot: UpdateDocumentParams, patch?: DocumentPatchParams): Promise<void> {
    const previous = this.versions.get(snapshot.uri);
    if ((previous?.version ?? -1) >= snapshot.version) return;
    if (!this.versions.has(snapshot.uri) && this.versions.size >= 16) {
      const oldest = this.versions.keys().next().value!;
      await this.bridge.closeDocument(oldest);
      this.versions.delete(oldest);
    }
    if (this.allowPatches && this.bridge.patchDocument && patch?.uri === snapshot.uri
      && patch.version === snapshot.version && previous?.version === patch.baseVersion && previous.languageId === snapshot.languageId) {
      try {
        await this.bridge.patchDocument(patch);
        this.appliedPatches++;
        this.versions.set(snapshot.uri, { version: snapshot.version, languageId: snapshot.languageId });
        return;
      } catch (error) {
        if (![-32801, -32602].includes((error as { code?: number })?.code ?? 0)) throw error;
        // The core still holds its old snapshot after rejecting the patch.
      }
    }
    await this.bridge.updateDocument(snapshot);
    this.versions.set(snapshot.uri, { version: snapshot.version, languageId: snapshot.languageId });
  }

  update(snapshot: UpdateDocumentParams, patch?: DocumentPatchParams): Promise<void> {
    const previous = this.pendingUpdate;
    if (previous?.snapshot.uri === snapshot.uri) {
      if (snapshot.version > previous.snapshot.version) { previous.snapshot = snapshot; previous.patch = patch; }
      return previous.operation;
    }
    const pending = { snapshot, patch, operation: Promise.resolve() };
    const operation = this.chain.then(() => {
      // Once transmission starts its payload is immutable. Only queued,
      // adjacent updates to the same document may collapse into the latest.
      if (this.pendingUpdate === pending) this.pendingUpdate = undefined;
      return this.transmit(pending.snapshot, pending.patch);
    });
    pending.operation = operation;
    this.pendingUpdate = pending;
    this.chain = operation.catch(() => {});
    return operation;
  }

  close(uri: string): Promise<void> {
    this.pendingUpdate = undefined;
    const operation = this.chain.then(async () => {
      if (!this.versions.has(uri)) return;
      await this.bridge.closeDocument(uri);
      this.versions.delete(uri);
    });
    this.chain = operation.catch(() => {});
    return operation;
  }

  get size(): number { return this.versions.size; }
  get patches(): number { return this.appliedPatches; }
  has(uri: string): boolean { return this.versions.has(uri); }
}
