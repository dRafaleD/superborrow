import { CompletionDiagnostic } from "./protocol";

interface DiagnosticInput {
  severity: number;
  message: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function boundedMessage(value: string): string {
  let result = "";
  let bytes = 0;
  for (let character of value) {
    if (character.length === 1 && /[\uD800-\uDFFF]/.test(character)) character = "�";
    const count = Buffer.byteLength(character, "utf8");
    if (bytes + count > 512) break;
    result += character; bytes += count;
  }
  return result;
}

/** Local editor diagnostics only; no language-server commands or file reads. */
export function nearbyDiagnostics(values: readonly DiagnosticInput[], line: number): CompletionDiagnostic[] {
  return values.filter(value => value.severity <= 1 && value.severity >= 0)
    .map(value => ({ value, distance: Math.abs(value.range.start.line - line) }))
    .filter(item => item.distance <= 32)
    .sort((a, b) => a.distance - b.distance || a.value.severity - b.value.severity || a.value.range.start.line - b.value.range.start.line || a.value.range.start.character - b.value.range.start.character || a.value.message.localeCompare(b.value.message))
    .slice(0, 8)
    .map(({ value }) => ({ position: { line: value.range.start.line, character: value.range.start.character }, severity: value.severity === 0 ? "error" : "warning", message: boundedMessage(value.message) }));
}

export function diagnosticMeaningKey(values: readonly CompletionDiagnostic[]): string {
  return JSON.stringify(values.map(value => `${value.severity}:${value.message}`).sort());
}
