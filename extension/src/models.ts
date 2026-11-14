import * as vscode from "vscode";
import { IdeModelParams, IdeModelResult } from "./protocol";
import { AntigravityBridge, AntigravityRpc } from "./antigravity";

/** Opt-in extension contract. Unknown internal methods/commands are never invoked. */
export interface CompletionAdapterV1 {
  version: 1;
  generateCompletion(params: IdeModelParams, token: vscode.CancellationToken): Promise<IdeModelResult>;
}

export class ModelBridge {
  private model: vscode.LanguageModelChat | undefined;
  private adapter: CompletionAdapterV1 | undefined;
  private antigravity: AntigravityBridge | undefined;
  private initialization: Promise<void> | undefined;
  private initializationKey = "";

  get available(): boolean { return !!this.model || !!this.adapter || !!this.antigravity?.label; }
  get label(): string { return this.antigravity?.label ?? this.model?.name ?? (this.adapter ? "Extension adapter" : "IDE model unavailable"); }
  get modelId(): string | undefined { return this.antigravity?.slug ? `antigravity:${this.antigravity.slug}` : this.model ? `vscode:${this.model.id}` : undefined; }
  reset(): void { this.model = undefined; this.adapter = undefined; this.antigravity = undefined; this.initializationKey = ""; }

  async initialize(): Promise<void> {
    const config = vscode.workspace.getConfiguration("superborrow");
    const configured = config.get<string>("ideModel", "auto");
    const adapterId = config.get<string>("ideAdapterExtension", "");
    const key = `${adapterId}:${configured}`;
    if (this.available && this.initializationKey === key) return;
    if (this.initialization) { await this.initialization; if (this.initializationKey === key && this.available) return; }
    this.initialization = this.restore(configured, adapterId).then(() => { this.initializationKey = key; }).finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  private async restore(configured: string, adapterId: string): Promise<void> {
    this.reset();
    if (adapterId) {
      const extension = vscode.extensions.getExtension(adapterId);
      if (!extension) throw new Error(`Adapter extension not installed: ${adapterId}`);
      const api = await extension.activate();
      const adapter: CompletionAdapterV1 | undefined = api?.superborrowCompletionProvider;
      if (adapter?.version !== 1 || typeof adapter.generateCompletion !== "function") throw new Error("Extension does not export superborrowCompletionProvider v1");
      this.adapter = adapter;
      return;
    }
    if (configured.startsWith("vscode:")) {
      if (!vscode.lm?.selectChatModels) throw new Error("vscode.lm is unavailable in this editor");
      const [model] = await vscode.lm.selectChatModels({ id: configured.slice(7) });
      if (!model) throw new Error("The previously selected IDE model is no longer available");
      this.model = model; return;
    }
    this.antigravity = await this.discoverNative(configured.startsWith("antigravity:") ? configured.slice(12) : undefined);
  }

  private async discoverNative(slug?: string): Promise<AntigravityBridge> {
    const extension = vscode.extensions.getExtension("google.google-antigravity");
    if (!extension) throw new Error("No Antigravity host detected. Use Select IDE Model to choose a vscode.lm provider.");
    const api = await extension.activate();
    if (typeof api?.getRpcClient !== "function") throw new Error("Antigravity does not export the expected model client");
    const bridge = new AntigravityBridge(await api.getRpcClient() as AntigravityRpc);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 8000);
    try { await bridge.discover(abort.signal, slug); }
    finally { clearTimeout(timer); }
    return bridge;
  }

  async select(): Promise<void> {
    const adapterId = vscode.workspace.getConfiguration("superborrow").get<string>("ideAdapterExtension", "");
    if (adapterId) {
      const extension = vscode.extensions.getExtension(adapterId);
      if (!extension) throw new Error(`Adapter extension not installed: ${adapterId}`);
      const api = await extension.activate();
      const adapter: CompletionAdapterV1 | undefined = api?.superborrowCompletionProvider;
      if (adapter?.version !== 1 || typeof adapter.generateCompletion !== "function") throw new Error("Extension does not export superborrowCompletionProvider v1");
      this.adapter = adapter; this.model = undefined; this.antigravity = undefined;
      return;
    }
    const choices: Array<{ label: string; description: string; detail: string; id: string }> = [];
    try {
      // Metadata discovery uses the signed-in host; no model prompt is sent.
      const native = this.antigravity ?? await this.discoverNative();
      for (const model of native.models) if (!model.disabled) choices.push({ label: model.label, description: "Antigravity account", detail: model.slug, id: `antigravity:${model.slug}` });
    } catch { /* A generic VS Code host can still offer vscode.lm models. */ }
    if (vscode.lm?.selectChatModels) {
      try {
        for (const model of await vscode.lm.selectChatModels()) choices.push({ label: model.name, description: `${model.vendor} · ${model.family}`, detail: model.id, id: `vscode:${model.id}` });
      } catch (error) { if (!choices.length) throw error; }
    }
    if (!choices.length) throw new Error("No accessible IDE models. Check Antigravity sign-in or configure a local model.");
    const auto = choices.some(choice => choice.id.startsWith("antigravity:")) ? [{ label: "Auto (fast Antigravity model)", description: "Restored automatically on startup", detail: "auto", id: "auto" }] : [];
    const selected = await vscode.window.showQuickPick([...auto, ...choices], { title: "Superborrow: Select IDE Model" });
    if (selected) {
      await vscode.workspace.getConfiguration("superborrow").update("ideModel", selected.id, vscode.ConfigurationTarget.Global);
      await this.initialize();
    }
  }

  async generate(params: IdeModelParams, signal: AbortSignal): Promise<IdeModelResult> {
    if (!this.available) throw new Error("Select an IDE model using Superborrow: Select IDE Model, or configure a local model.");
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) cancellation.cancel();
    try {
      if (this.antigravity) return await this.antigravity.generate(params.prompt, signal);
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
    try { await this.initialize(); } catch (error) { output.appendLine(`Antigravity discovery: ${String(error)}`); }
    if (this.antigravity) {
      output.appendLine(`Antigravity account models: ${this.antigravity.models.length}; selected=${this.antigravity.slug}`);
      for (const model of this.antigravity.models) output.appendLine(`  ${model.slug} | ${model.label} | ${model.disabled ? "disabled" : "enabled"}`);
    }
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
