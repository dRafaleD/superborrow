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
}
export interface CompletionResult { text: string; version: number }
export interface IdeModelParams {
  requestId: string;
  prompt: string;
  languageId: string;
  maxTokens: number;
}
export interface IdeModelResult { text: string }
export interface InitializeResult { protocolVersion: 1; phase: 1 }
export const Methods = {
  initialize: "initialize",
  updateDocument: "updateDocument",
  closeDocument: "closeDocument",
  requestCompletion: "requestCompletion",
  cancelRequest: "cancelRequest",
  requestIdeModel: "requestIdeModel",
  shutdown: "shutdown",
} as const;
