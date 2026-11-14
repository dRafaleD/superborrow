import { UpdateDocumentParams } from "./protocol";

interface DocumentTransport {
  updateDocument(params: UpdateDocumentParams): Promise<void>;
  closeDocument(uri: string): Promise<void>;
}

/** Serializes snapshots and closes to preserve versions under rapid editing. */
export class DocumentSync {
  private chain: Promise<void> = Promise.resolve();
  private readonly versions = new Map<string, number>();
  constructor(private readonly bridge: DocumentTransport) {}

  update(snapshot: UpdateDocumentParams): Promise<void> {
    const operation = this.chain.then(async () => {
      if ((this.versions.get(snapshot.uri) ?? -1) >= snapshot.version) return;
      if (!this.versions.has(snapshot.uri) && this.versions.size >= 16) {
        const oldest = this.versions.keys().next().value!;
        await this.bridge.closeDocument(oldest);
        this.versions.delete(oldest);
      }
      await this.bridge.updateDocument(snapshot);
      this.versions.set(snapshot.uri, snapshot.version);
    });
    this.chain = operation.catch(() => {});
    return operation;
  }

  close(uri: string): Promise<void> {
    const operation = this.chain.then(async () => {
      if (!this.versions.has(uri)) return;
      await this.bridge.closeDocument(uri);
      this.versions.delete(uri);
    });
    this.chain = operation.catch(() => {});
    return operation;
  }

  get size(): number { return this.versions.size; }
  has(uri: string): boolean { return this.versions.has(uri); }
}
