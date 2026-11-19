import * as vscode from "vscode";
import { writeFileSync } from "node:fs";
import { AntigravityBridge, AntigravityRpc } from "../../src/antigravity";

/** Opt-in capability probe. No auth metadata is read or reconstructed. */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  const report = { completed: false, passed: false, scope: "native-completion-capability", cases, error: "" };
  const save = () => writeFileSync(process.env.SUPERBORROW_LIVE_REPORT!, JSON.stringify(report, null, 2));
  try {
    const api = await vscode.extensions.getExtension("google.google-antigravity")!.activate();
    const rpc = await api.getRpcClient() as AntigravityRpc & { getCompletions?: (params: unknown, options: { signal: AbortSignal }) => Promise<{ modelTag?: string; completionItems?: Array<{ completion?: { text?: string } }> }> };
    if (typeof rpc.getCompletions !== "function") throw new Error("No exported native completion RPC");
    const selected = new AntigravityBridge(rpc);
    const discovery = new AbortController();
    const discoveryTimer = setTimeout(() => discovery.abort(), 15000);
    try { await selected.discover(discovery.signal); }
    finally { clearTimeout(discoveryTimer); }
    const model = selected.models.find(item => item.slug === selected.slug)!;
    const text = "def add(a, b):\n    return ";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const started = performance.now();
    try {
      const response = await rpc.getCompletions({
        document: { absoluteUri: "untitled:superborrow-native-probe.py", text, editorLanguage: "python", cursorOffset: BigInt(Buffer.byteLength(text)), lineEnding: "\n", isSynthetic: true },
        editorOptions: { tabSize: 4n, insertSpaces: true },
        requestedModelId: model.model, disableCache: true,
      }, { signal: controller.signal });
      const suggestions = response.completionItems?.map(item => item.completion?.text ?? "") ?? [];
      const passed = suggestions.some(value => /a\s*\+\s*b/.test(value));
      cases.push({ name: "selected-model native FIM", passed, requestedModel: model.slug, modelTag: response.modelTag, elapsedMs: Math.round(performance.now() - started), suggestions });
      report.passed = passed;
    } finally { clearTimeout(timer); }
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally { report.completed = true; save(); }
}
