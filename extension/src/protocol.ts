/** Protocol v1. Positions count UTF-16 code units, as in VS Code. */
export type Mode = "local" | "ide" | "hybrid";
export interface UpdateDocumentParams {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}
export interface DocumentPatchParams {
  uri: string;
  baseVersion: number;
  version: number;
  start: { line: number; character: number };
  end: { line: number; character: number };
  text: string;
}
export interface CompletionParams {
  uri: string;
  version: number;
  position: { line: number; character: number };
  mode: Mode;
  kind?: "inline" | "nextEdit";
  endPosition?: { line: number; character: number };
  instruction?: string;
  explicit?: boolean;
  diagnostics?: CompletionDiagnostic[];
  relatedDocuments?: UpdateDocumentParams[];
}
export interface CompletionDiagnostic {
  position: { line: number; character: number };
  severity: "error" | "warning";
  message: string;
}
export interface CompletionResult { text: string; version: number; provider: "local" | "ide"; fallback: boolean; elapsedMs: number }
export interface IdeModelParams {
  requestId: string;
  prompt: string;
  languageId: string;
  maxTokens: number;
  kind: "inline" | "nextEdit";
  qwenInfill?: string | null;
  qwenStopAt?: "line" | "pythonFunction" | null;
}
export interface IdeModelResult { text: string }
export interface PreparedIdeCompletion extends Omit<IdeModelParams, "requestId"> { version: number }
export interface InitializeResult { protocolVersion: 1; phase: number; version: string; capabilities: Record<string, boolean> }
export interface EngineConfig {
  localApi: "llamaInfill" | "ollama" | "openAi";
  endpoint: string;
  model: string;
  fimFormat: "qwen" | "codestral";
  debounceMs: number;
  requestTimeoutMs: number;
  maxTokens: number;
  maxContextBytes: number;
  projectContext: string;
  ideAvailable: boolean;
  hybridPreference: "auto" | "local" | "ide";
}
export const Methods = {
  initialize: "initialize",
  configure: "configure",
  updateDocument: "updateDocument",
  patchDocument: "patchDocument",
  closeDocument: "closeDocument",
  requestCompletion: "requestCompletion",
  prepareIdeCompletion: "prepareIdeCompletion",
  cancelRequest: "cancelRequest",
  requestIdeModel: "requestIdeModel",
  shutdown: "shutdown",
} as const;
