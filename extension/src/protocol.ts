/** Protocol v1. Positions count UTF-16 code units, as in VS Code. */
export type Mode = "local" | "ide" | "hybrid";
export interface UpdateDocumentParams {
  uri: string;
  languageId: string;
  version: number;
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
}
export interface CompletionResult { text: string; version: number; provider: "local" | "ide"; fallback: boolean; elapsedMs: number }
export interface IdeModelParams {
  requestId: string;
  prompt: string;
  languageId: string;
  maxTokens: number;
  kind: "inline" | "nextEdit";
}
export interface IdeModelResult { text: string }
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
}
export const Methods = {
  initialize: "initialize",
  configure: "configure",
  updateDocument: "updateDocument",
  closeDocument: "closeDocument",
  requestCompletion: "requestCompletion",
  cancelRequest: "cancelRequest",
  requestIdeModel: "requestIdeModel",
  shutdown: "shutdown",
} as const;
