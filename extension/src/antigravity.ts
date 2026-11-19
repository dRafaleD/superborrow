/** Structural adapter for the API exported by google.google-antigravity 1.11.
 * Authentication/transport stays inside the host extension. No token discovery,
 * private HTTP client, chat automation or agent tool execution is involved.
 */
export interface AntigravityModel {
  slug: string;
  label: string;
  model: number;
  disabled: boolean;
}

export interface AntigravityRpc {
  getAvailableModels(request: Record<string, never>, options: { signal: AbortSignal }): Promise<{
    response?: { models?: Record<string, { displayName?: string; model?: number; disabled?: boolean; isInternal?: boolean }> };
  }>;
  getModelResponse(request: { prompt: string; model: number }, options: { signal: AbortSignal }): Promise<{ response?: string }>;
}

export function modelCatalog(response: Awaited<ReturnType<AntigravityRpc["getAvailableModels"]>>): AntigravityModel[] {
  return Object.entries(response.response?.models ?? {}).flatMap(([slug, value]) => {
    if (!value || typeof value.displayName !== "string" || !value.displayName.trim() || !Number.isSafeInteger(value.model) || value.model! <= 0 || value.isInternal) return [];
    return [{ slug, label: value.displayName, model: value.model!, disabled: value.disabled === true }];
  }).sort((a, b) => a.label.localeCompare(b.label) || a.slug.localeCompare(b.slug));
}

export function automaticModel(models: readonly AntigravityModel[]): AntigravityModel | undefined {
  const score = (model: AntigravityModel) => {
    if (/hydrogen.*low/i.test(model.label)) return 0;
    if (/sonnet.*low/i.test(model.label)) return 1;
    if (/flash.*low/i.test(model.label)) return 2;
    if (/flash.*lite/i.test(model.label)) return /flash-lite/.test(model.slug) ? 3 : 4;
    if (/flash/i.test(model.label) && !/medium|high|thinking/i.test(model.label)) return 5;
    return 6;
  };
  return models.filter(model => !model.disabled && !/orchestrator|image/i.test(`${model.label} ${model.slug}`)).slice().sort((a, b) => score(a) - score(b) || b.slug.localeCompare(a.slug))[0];
}

export class AntigravityBridge {
  private catalog: AntigravityModel[] = [];
  private selected: AntigravityModel | undefined;
  constructor(private readonly rpc: AntigravityRpc) {
    if (typeof rpc.getAvailableModels !== "function" || typeof rpc.getModelResponse !== "function") {
      throw new Error("Antigravity's exported model API is incompatible with this version.");
    }
  }
  get models(): readonly AntigravityModel[] { return this.catalog; }
  get label(): string | undefined { return this.selected?.label; }
  get slug(): string | undefined { return this.selected?.slug; }

  async discover(signal: AbortSignal, selectedSlug?: string): Promise<void> {
    this.catalog = modelCatalog(await this.rpc.getAvailableModels({}, { signal }));
    this.select(selectedSlug);
  }

  /** Select from the already authenticated catalog without another RPC. */
  select(selectedSlug?: string): void {
    this.selected = undefined;
    const model = selectedSlug ? this.catalog.find(model => model.slug === selectedSlug && !model.disabled) : automaticModel(this.catalog);
    if (!model) throw new Error(selectedSlug ? `Antigravity model unavailable: ${selectedSlug}` : "Antigravity did not expose an enabled text model. Check its signed-in account.");
    this.selected = model;
  }

  async generate(prompt: string, signal: AbortSignal): Promise<{ text: string }> {
    if (!this.selected) throw new Error("Antigravity model has not been initialized");
    if (signal.aborted) throw new Error("Request cancelled");
    const result = await this.rpc.getModelResponse({ prompt, model: this.selected.model }, { signal });
    if (signal.aborted) throw new Error("Request cancelled");
    if (typeof result.response !== "string") throw new Error("Invalid Antigravity model response");
    if (Buffer.byteLength(result.response, "utf8") > 65536) throw new Error("Antigravity model response exceeds the output limit");
    return { text: result.response };
  }
}
