import { spawn } from "node:child_process";
import * as path from "node:path";
import * as ts from "typescript";

/** A tiny numeric AST interpreter, not execution of generated JavaScript. */
export function typeScriptAddition(source: string, expectedName?: string): boolean {
  if (source.length > 16384) return false;
  try {
    const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (file.statements.length !== 1 || !ts.isFunctionDeclaration(file.statements[0])) return false;
    const fn = file.statements[0];
    if (expectedName && fn.name?.text !== expectedName) return false;
    if (!fn.body || fn.asteriskToken || fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || fn.parameters.length !== 2 || fn.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)) return false;
    if (fn.body.statements.length !== 1 || !ts.isReturnStatement(fn.body.statements[0]) || !fn.body.statements[0].expression) return false;
    if (ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics?.some(value => value.category === ts.DiagnosticCategory.Error)) return false;
    const expression = fn.body.statements[0].expression;
    const evaluate = (node: ts.Expression, names: Map<string, number>): number => {
      if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, names);
      if (ts.isIdentifier(node)) { const value = names.get(node.text); if (value === undefined) throw new Error('Unknown identifier'); return value; }
      if (ts.isNumericLiteral(node) && Math.abs(Number(node.text)) <= 1e9) return Number(node.text);
      if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) return (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * evaluate(node.operand, names);
      if (ts.isBinaryExpression(node)) {
        const left = evaluate(node.left, names), right = evaluate(node.right, names);
        let value: number;
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken: value = left + right; break;
          case ts.SyntaxKind.MinusToken: value = left - right; break;
          case ts.SyntaxKind.AsteriskToken: value = left * right; break;
          default: throw new Error('Unsupported operator');
        }
        if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('Numeric result outside fixture limit');
        return value;
      }
      throw new Error('Unsupported expression');
    };
    const names = fn.parameters.map(parameter => (parameter.name as ts.Identifier).text);
    return [[2, 5], [5, 2], [3, 3], [-3, -8], [0, 0], [1.5, 1.2]].every(([a, b]) => evaluate(expression, new Map([[names[0], a], [names[1], b]])) === a + b);
  } catch { return false; }
}

export function numericPython(source: string, kind: "maximum" | "addition"): Promise<{ passed: boolean; inputPairs?: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, "../../scripts/benchmark-quality.py");
    const child = spawn(process.platform === "win32" ? "py" : "python3", [...(process.platform === "win32" ? ["-3"] : []), script], { windowsHide: true, stdio: "pipe" });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Fixture validator timed out")); }, 5000);
    child.stdout.on("data", bytes => { output += bytes.toString(); });
    child.stderr.resume();
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      try { if (code) throw new Error(`Fixture validator exited ${code}`); resolve(JSON.parse(output)); }
      catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ source, kind }));
  });
}
