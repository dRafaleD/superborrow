import * as vscode from "vscode";
import { IdeModelParams, IdeModelResult } from "./protocol";

/** Opt-in extension contract. Unknown internal methods/commands are never invoked. */
export interface CompletionAdapterV1 {
  version: 1;
  generateCompletion(params: IdeModelParams, token: vscode.CancellationToken): Promise<IdeModelResult>;
}

export class ModelBridge {
  private model: vscode.LanguageModelChat | undefined;
  private adapter: CompletionAdapterV1 | undefined;

  get available(): boolean { return !!this.model || !!this.adapter; }
  get label(): string { return this.model?.name ?? (this.adapter ? "Extension adapter" : "No IDE model selected"); }
  reset(): void { this.model = undefined; this.adapter = undefined; }

  async select(): Promise<void> {
    const adapterId = vscode.workspace.getConfiguration("superborrow").get<string>("ideAdapterExtension", "");
    if (adapterId) {
      const extension = vscode.extensions.getExtension(adapterId);
      if (!extension) throw new Error(`Adapter extension not installed: ${adapterId}`);
      const api = await extension.activate();
      const adapter: CompletionAdapterV1 | undefined = api?.superborrowCompletionProvider;
      if (adapter?.version !== 1 || typeof adapter.generateCompletion !== "function") throw new Error("Extension does not export superborrowCompletionProvider v1");
      this.adapter = adapter; this.model = undefined;
      return;
    }
    if (!vscode.lm?.selectChatModels) throw new Error("This editor does not expose vscode.lm. Inspect Available Models shows adapter candidates.");
    const models = await vscode.lm.selectChatModels();
    if (!models.length) throw new Error("No models exposed by vscode.lm. Antigravity's built-in chat does not necessarily expose an extension API. Local mode remains available.");
    const selected = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: `${model.vendor} · ${model.family}`, detail: model.id, model })), { title: "Superborrow: Select IDE Model" });
    if (selected) { this.model = selected.model; this.adapter = undefined; }
  }

  async generate(params: IdeModelParams, signal: AbortSignal): Promise<IdeModelResult> {
    if (!this.available) throw new Error("Select an IDE model using Superborrow: Select IDE Model, or configure a local model.");
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) cancellation.cancel();
    try {
      if (this.adapter) {
        const result = await this.adapter.generateCompletion(params, cancellation.token);
        if (typeof result?.text !== "string" || result.text.length > 32768) throw new Error("Invalid adapter response");
        return result;
      }
      const model = this.model!;
      const message = vscode.LanguageModelChatMessage.User(params.prompt);
      if (await model.countTokens(message, cancellation.token) > model.maxInputTokens - params.maxTokens) throw new Error("IDE model context window is too small. Reduce maxContextBytes.");
      const response = await model.sendRequest([message], {}, cancellation.token);
      let text = "";
      // The API has no portable max-output-tokens option; enforce a byte cap.
      for await (const fragment of response.text) {
        if (cancellation.token.isCancellationRequested) throw new Error("Request cancelled");
        text += fragment;
        if (Buffer.byteLength(text, "utf8") >= 16384) { cancellation.cancel(); break; }
      }
      return { text };
    } finally { signal.removeEventListener("abort", abort); cancellation.dispose(); }
  }

  async inspect(output: vscode.OutputChannel): Promise<void> {
    output.clear();
    output.appendLine(`Superborrow model diagnostics\nSelected: ${this.label}`);
    if (vscode.lm?.selectChatModels) {
      try {
        const models = await vscode.lm.selectChatModels();
        output.appendLine(`vscode.lm models: ${models.length}`);
        for (const model of models) output.appendLine(`  ${model.id} | ${model.name} | ${model.vendor}/${model.family} | context ${model.maxInputTokens}`);
      } catch (error) { output.appendLine(`vscode.lm discovery failed: ${String(error)}`); }
    } else { output.appendLine("vscode.lm API unavailable"); }
    output.appendLine("\nInstalled model/Antigravity extension candidates (metadata and active exports only):");
    for (const extension of vscode.extensions.all.filter(e => /antigravity|gemini|copilot|model|superborrow/i.test(e.id))) {
      let keys: string[] = [];
      if (extension.isActive && extension.exports && ["object", "function"].includes(typeof extension.exports)) {
        // Descriptors avoid executing getters in foreign APIs.
        keys = Object.keys(Object.getOwnPropertyDescriptors(extension.exports));
      }
      output.appendLine(`  ${extension.id} | active=${extension.isActive} | exports=${keys.join(", ") || "none"}`);
    }
    const commands = (await vscode.commands.getCommands(true)).filter(id => /antigravity|gemini|completion|model/i.test(id)).sort().slice(0, 100);
    output.appendLine(`\nCandidate commands (inspection only):\n${commands.join("\n")}`);
    output.appendLine("\nFor a custom adapter, export superborrowCompletionProvider { version: 1, generateCompletion(params, token) } and configure ideAdapterExtension.");
    output.show(true);
  }
}
