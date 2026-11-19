import * as vscode from "vscode";
import { writeFileSync } from "node:fs";
import { AntigravityBridge, AntigravityRpc, automaticModel } from "../../src/antigravity";
import { CoreBridge } from "../../src/bridge";
import { insertion } from "../../src/completion";
import { numericPython } from "../quality";
import { activate } from "../../src/extension";
import { createHash } from "node:crypto";

/** Opt-in, sequential same-corpus probes using only synthetic source code.
 * Python numeric fixtures use an AST interpreter; other checks are smoke gates.
 */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  const summaries: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { completed: false, passed: false, scope: "model-comparison", cases, summaries, error: "" };
  const save = () => writeFileSync(process.env.SUPERBORROW_LIVE_REPORT!, JSON.stringify(report, null, 2));
  const fixtures: Array<{ name: string; language: string; prefix: string; suffix: string; pattern: RegExp; helper?: string }> = [
    { name: "expression", language: "python", prefix: "def add(a: int, b: int) -> int:\n    return ", suffix: "\n", pattern: /^a\s*\+\s*b\s*$/ },
    { name: "middle-gap", language: "typescript", prefix: "function add(a: number, b: number): number {\n  return a + ", suffix: ";\n}\n", pattern: /^b\s*$/ },
    { name: "comment-implementation", language: "python", prefix: "# İki sayının büyük olanını döndüren bir fonksiyon yaz.\n", suffix: "", pattern: /def\s+\w+\([^)]*\)[^\n]*:\s*\n\s+return\s+max\(/ },
  ];
  if (process.env.SUPERBORROW_BENCH_EXTENDED === "true") fixtures.push(
    { name: "exported-type-field", language: "typescript", prefix: "import type { Invoice } from './invoice-model';\nfunction currencyOf(invoice: Invoice): string {\n  // Return the invoice ISO currency code.\n  return invoice.", suffix: ";\n}\n", helper: "export interface Invoice { /** ISO currency code */ tenderCode: string; amountCents: number; }", pattern: /^tenderCode\s*$/ },
    { name: "abstention", language: "python", prefix: "//create function\n", suffix: "", pattern: /^\s*$/ },
  );
  let core: CoreBridge | undefined;
  let promptHash = "";
  try {
    const extension = vscode.extensions.getExtension<ReturnType<typeof activate>>('superborrow-dev.superborrow')!;
    const engine = await extension.activate(); await engine.ready;
    const readyDeadline = Date.now() + 40000;
    while (!engine.getStatus().ideAvailable && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!engine.getStatus().ideAvailable) throw new Error(`Model startup unavailable: ${engine.getStatus().lastError}`);
    const host = vscode.extensions.getExtension("google.google-antigravity");
    if (!host) throw new Error("Antigravity host unavailable");
    const api = await host.activate();
    let selected!: AntigravityBridge;
    for (let attempt = 0; ; attempt++) {
      const discovery = new AbortController();
      const timer = setTimeout(() => discovery.abort(), 15000);
      try { selected = new AntigravityBridge(await api.getRpcClient() as AntigravityRpc); await selected.discover(discovery.signal); break; }
      catch (error) { if (!discovery.signal.aborted || attempt >= 1) throw error; }
      finally { clearTimeout(timer); }
    }
    const catalog = selected.models;
    const auto = automaticModel(catalog);
    const lite = automaticModel(catalog.filter(model => /flash.*lite/i.test(model.label)));
    const flash = automaticModel(catalog.filter(model => /flash/i.test(model.label) && !/lite/i.test(model.label)));
    const sonnet = automaticModel(catalog.filter(model => /sonnet.*low/i.test(model.label)));
    const choices = new Map([['auto', auto], ['flash-lite', lite], ['flash', flash], ['sonnet-low', sonnet]]);
    const requested = process.env.SUPERBORROW_BENCH_MODELS?.split(',').map(value => value.trim()).filter(Boolean);
    const models = (requested ? requested.map(key => choices.get(key) ?? catalog.find(model => model.slug === key && !model.disabled)) : [auto, lite, flash]).filter((value, index, all) => value && all.findIndex(item => item?.slug === value.slug) === index);
    if (!models.length) throw new Error("No enabled benchmark models");
    if (models.length > 3 || (fixtures.length > 3 && models.length > 2)) throw new Error("Choose at most three models, or two for the extended corpus, to bound account quota and runtime");
    if (requested && models.length !== new Set(requested).size) throw new Error("Requested benchmark model unavailable or duplicated by an alias");
    report.availableModels = catalog.filter(model => !model.disabled).map(model => ({ slug: model.slug, label: model.label }));
    report.selectedModels = models.map(model => model!.slug);
    const binary = vscode.workspace.getConfiguration("superborrow").get<string>("corePath")!;
    core = new CoreBridge(binary, (params, signal) => { promptHash = createHash('sha256').update(params.prompt).digest('hex'); return selected.generate(params.prompt, signal); });
    report.coreVersion = (await core.initialize()).version;
    await core.configure({ debounceMs: 0, requestTimeoutMs: 6000, ideAvailable: true });
    const repeatPrompts = process.env.SUPERBORROW_BENCH_REPEAT_PROMPTS === 'true';
    report.repeatPrompts = repeatPrompts;
    // Round-robin order reduces the effect of comparing only a cold first model.
    for (let round = 0; round < 2; round++) for (const model of round ? models.slice().reverse() : models) {
      selected.select(model!.slug);
      for (const fixture of fixtures) {
        const uri = `untitled:benchmark-${round}-${model!.slug}-${fixture.name}`;
        const prefix = repeatPrompts ? fixture.prefix : `${fixture.language === 'python' ? '#' : '//'} Independent trial ${round}\n${fixture.prefix}`;
        const text = prefix + fixture.suffix;
        const helperUri = 'file:///synthetic/invoice-model.ts';
        if (fixture.helper) await core.updateDocument({ uri: helperUri, version: 1, languageId: 'typescript', text: fixture.helper });
        await core.updateDocument({ uri, version: 1, languageId: fixture.language, text });
        const lines = prefix.split("\n");
        const started = performance.now();
        promptHash = '';
        try {
          const answer = await core.requestCompletion({ uri, version: 1, mode: "ide", explicit: true, position: { line: lines.length - 1, character: lines.at(-1)!.length } });
          const elapsedMs = Math.round(performance.now() - started);
          const suggestion = insertion(answer.text, fixture.suffix, "\n");
          const quality = fixture.language === "python" && fixture.name !== "abstention" ? await numericPython(prefix + suggestion + fixture.suffix, fixture.name === "expression" ? "addition" : "maximum") : { passed: fixture.pattern.test(suggestion) };
          const passed = quality.passed && !/\bpass\b|TODO|NotImplementedError|```/.test(suggestion);
          cases.push({ name: fixture.name, round, model: model!.slug, passed, elapsedMs, providerMs: answer.elapsedMs, promptHash, quality, suggestion });
        } catch (error) {
          cases.push({ name: fixture.name, round, model: model!.slug, passed: false, elapsedMs: Math.round(performance.now() - started), promptHash, error: error instanceof Error ? error.message : String(error) });
        } finally { await core.closeDocument(uri); if (fixture.helper) await core.closeDocument(helperUri); save(); }
      }
    }
    for (const model of models) {
      const probes = cases.filter(probe => probe.model === model!.slug);
      const successful = probes.filter(probe => probe.passed);
      const latencies = successful.map(probe => Number(probe.elapsedMs)).sort((a, b) => a - b);
      const middle = Math.floor(latencies.length / 2);
      const median = latencies.length ? (latencies[middle] + latencies[Math.floor((latencies.length - 1) / 2)]) / 2 : null;
      const allTimes = probes.map(probe => Number(probe.elapsedMs)).sort((a, b) => a - b);
      const medianAll = allTimes.length ? (allTimes[Math.floor(allTimes.length / 2)] + allTimes[Math.floor((allTimes.length - 1) / 2)]) / 2 : null;
      summaries.push({ model: model!.slug, label: model!.label, passed: successful.length, total: probes.length, timeouts: probes.filter(probe => /timed out/i.test(String(probe.error ?? ''))).length, medianAllAttemptsMs: medianAll, maxAttemptMs: allTimes.at(-1) ?? null, medianSuccessfulMs: median, maxSuccessfulMs: latencies.at(-1) ?? null });
    }
    report.passed = summaries.some(summary => summary.passed === summary.total);
    report.backgroundModelRequests = engine.getStatus().modelRequests;
    if (report.backgroundModelRequests !== 0) { report.passed = false; report.error = 'Unexpected background model generation contaminated the comparison'; }
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { await core?.shutdown(); report.completed = true; save(); }
}
