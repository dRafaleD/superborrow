import * as vscode from "vscode";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AntigravityBridge, AntigravityRpc } from "../../src/antigravity";
import { CoreBridge } from "../../src/bridge";
import { insertion } from "../../src/completion";
import { CompletionDiagnostic } from "../../src/protocol";

/** Before/after synthetic quality probes. Never execute generated code. */
export async function run(): Promise<void> {
  const cases: Array<Record<string, unknown>> = [];
  const summaries: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { completed: false, passed: false, scope: "context-before-after", cases, summaries };
  const save = () => writeFileSync(process.env.SUPERBORROW_LIVE_REPORT!, JSON.stringify(report, null, 2));
  const candidate = vscode.workspace.getConfiguration("superborrow").get<string>("corePath")!;
  const root = path.resolve(__dirname, "../../../..");
  const binaries = { baseline: path.join(root, "packages", "baseline-core-0.3.2.exe"), candidate };
  const cores = new Map<string, CoreBridge>();
  const imports = "import type { Invoice } from './invoice-model';\n";
  const fields = "export interface Invoice { /** ISO currency code */ tenderCode: string; amountCents: number; }";
  const fixtures = [
    { name: "exported type fields", helper: fields, prefix: imports + "function currencyOf(invoice: Invoice): string {\n  // Return the invoice's ISO currency code.\n  return invoice.", expected: "tenderCode", diagnostics: [] as CompletionDiagnostic[] },
    { name: "same-file declaration outside cursor window", helper: "", prefix: "interface Customer { /** public display label */ visibleLabel: string; email: string; }\n" + "// filler\n".repeat(3000) + "function labelFor(customer: Customer): string {\n  // Return the public display label, not the email.\n  return customer.", expected: "visibleLabel", diagnostics: [] as CompletionDiagnostic[] },
    { name: "nearby diagnostic property hint", helper: "", prefix: "function labelFor(item: Item): string {\n  return item.", expected: "displayLabelX", diagnostics: [{ position: { line: 1, character: 2 }, severity: "error", message: "Property 'text' does not exist on type Item. Did you mean 'displayLabelX'?" }] as CompletionDiagnostic[] },
  ];
  try {
    const api = await vscode.extensions.getExtension("google.google-antigravity")!.activate();
    const model = new AntigravityBridge(await api.getRpcClient() as AntigravityRpc);
    for (let attempt = 0; ; attempt++) {
      const signal = new AbortController(); const timer = setTimeout(() => signal.abort(), 15000);
      try { await model.discover(signal.signal); break; }
      catch (error) { if (!signal.signal.aborted || attempt >= 1) throw error; }
      finally { clearTimeout(timer); }
    }
    report.model = model.slug;
    report.binaryHashes = Object.fromEntries(Object.entries(binaries).map(([label, binary]) => [label, createHash("sha256").update(readFileSync(binary)).digest("hex")]));
    for (const [label, binary] of Object.entries(binaries)) {
      const core = new CoreBridge(binary, (params, signal) => model.generate(params.prompt, signal));
      cores.set(label, core);
      await core.initialize();
      await core.configure({ debounceMs: 0, requestTimeoutMs: 6000, maxContextBytes: 4096, ideAvailable: true });
    }
    for (let round = 0; round < 2; round++) for (const fixture of fixtures) for (const label of round ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const core = cores.get(label)!;
      const uri = "file:///synthetic/main.ts";
      const helperUri = "file:///synthetic/invoice-model.ts";
      if (fixture.helper) await core.updateDocument({ uri: helperUri, version: 1, languageId: "typescript", text: fixture.helper });
      const suffix = ";\n}\n";
      await core.updateDocument({ uri, version: 1, languageId: "typescript", text: fixture.prefix + suffix });
      const lines = fixture.prefix.split("\n");
      const started = performance.now();
      try {
        const result = await core.requestCompletion({ uri, version: 1, position: { line: lines.length - 1, character: lines.at(-1)!.length }, mode: "ide", explicit: true, diagnostics: fixture.diagnostics });
        const suggestion = insertion(result.text, suffix, "\n");
        const passed = suggestion.trim() === fixture.expected;
        cases.push({ name: fixture.name, round, variant: label, passed, elapsedMs: Math.round(performance.now() - started), providerMs: result.elapsedMs, expected: fixture.expected, suggestion });
      } catch (error) {
        cases.push({ name: fixture.name, round, variant: label, passed: false, elapsedMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
      } finally { await core.closeDocument(uri); if (fixture.helper) await core.closeDocument(helperUri); save(); }
    }
    for (const label of Object.keys(binaries)) {
      const probes = cases.filter(probe => probe.variant === label);
      const successful = probes.filter(probe => probe.passed);
      const times = successful.map(probe => Number(probe.elapsedMs)).sort((a, b) => a - b);
      summaries.push({ variant: label, passed: successful.length, total: probes.length, medianSuccessfulMs: times.length ? (times[Math.floor(times.length / 2)] + times[Math.floor((times.length - 1) / 2)]) / 2 : null });
    }
    report.passed = summaries.find(summary => summary.variant === "candidate")?.passed === 6;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally { await Promise.all([...cores.values()].map(core => core.shutdown())); report.completed = true; save(); }
}
