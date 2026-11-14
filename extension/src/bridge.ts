import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createMessageConnection, StreamMessageReader, StreamMessageWriter,
  MessageConnection, ResponseError, CancellationTokenSource, Message,
} from "vscode-jsonrpc/node";
import {
  Methods, CompletionParams, CompletionResult, UpdateDocumentParams,
  IdeModelParams, IdeModelResult, InitializeResult,
  EngineConfig,
} from "./protocol";

export type IdeHandler = (params: IdeModelParams, signal: AbortSignal) => Promise<IdeModelResult>;

class BridgeWriter extends StreamMessageWriter {
  override write(message: Message): Promise<void> {
    if ("method" in message && message.method === "$/cancelRequest") {
      message = Object.assign({}, message, { method: Methods.cancelRequest });
    }
    return super.write(message);
  }
}

export class CoreBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: MessageConnection;
  private readonly ready: Promise<void>;
  private readonly reverse = new Map<string | number, AbortController>();
  private disposed = false;

  constructor(binary: string, handler: IdeHandler, log: (line: string) => void = () => {}, private readonly onClose: () => void = () => {}) {
    this.child = spawn(binary, [], { stdio: "pipe", windowsHide: true });
    this.ready = new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    void this.ready.catch(() => {});
    this.child.stderr.on("data", (chunk: Buffer) => log(chunk.toString()));
    const reader = new StreamMessageReader(this.child.stdout);
    this.rpc = createMessageConnection(reader, new BridgeWriter(this.child.stdin));
    this.rpc.onError(([error]) => log(`RPC: ${error.message}`));
    this.child.on("error", (error) => { log(`Core: ${error.message}`); this.dispose(); });
    this.child.on("exit", (code, signal) => {
      log(`Core exited (${code ?? signal})`);
      this.dispose();
    });
    this.rpc.onRequest(Methods.requestIdeModel, async (params: IdeModelParams) => {
      const controller = new AbortController();
      this.reverse.set(params.requestId, controller);
      try {
        const abort = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new ResponseError(-32800, "Request cancelled")), { once: true });
        });
        return await Promise.race([handler(params, controller.signal), abort]);
      } finally { this.reverse.delete(params.requestId); }
    });
    this.rpc.onNotification(Methods.cancelRequest, ({ id }: { id: string | number }) => {
      this.reverse.get(id)?.abort();
    });
    this.rpc.listen();
  }

  async initialize(): Promise<InitializeResult> {
    await this.ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.rpc.sendRequest<InitializeResult>(Methods.initialize, { protocolVersion: 1 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { this.dispose(); reject(new Error("Core startup timed out")); }, 5000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (result.protocolVersion !== 1) throw new Error("Unsupported core protocol version");
    return result;
  }

  configure(config: Partial<EngineConfig>): Promise<void> {
    return this.rpc.sendRequest(Methods.configure, config);
  }

  updateDocument(params: UpdateDocumentParams): Promise<void> {
    return this.rpc.sendRequest(Methods.updateDocument, params);
  }

  closeDocument(uri: string): Promise<void> {
    return this.rpc.sendRequest(Methods.closeDocument, { uri });
  }

  async requestCompletion(params: CompletionParams, signal?: AbortSignal): Promise<CompletionResult> {
    if (signal?.aborted) throw new ResponseError(-32800, "Request cancelled");
    const source = new CancellationTokenSource();
    const abort = () => source.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.rpc.sendRequest<CompletionResult>(Methods.requestCompletion, params, source.token);
    } finally {
      signal?.removeEventListener("abort", abort);
      source.dispose();
    }
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.rpc.sendRequest(Methods.shutdown),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Shutdown timeout")), 1000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); this.dispose(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.reverse.values()) controller.abort();
    this.reverse.clear();
    this.rpc.dispose();
    this.child.kill();
    this.onClose();
  }
}
