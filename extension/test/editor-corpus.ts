import { createHash } from 'node:crypto';
import { numericPython, typeScriptAddition } from './quality';

export const editorCorpusVersion = 1;
export function editorFixtures(round: number) {
  return [
    { id: 'python-expression', language: 'python', extension: 'py', prefix: `def add_trial_${round}(a: int, b: int) -> int:\n    return `, suffix: '\n', quality: 'python-addition', expectedName: `add_trial_${round}` },
    { id: 'typescript-middle-gap', language: 'typescript', extension: 'ts', prefix: `function add_trial_${round}(a: number, b: number): number {\n  return a + `, suffix: ';\n}\n', quality: 'typescript-addition', expectedName: `add_trial_${round}` },
    { id: 'python-comment', language: 'python', extension: 'py', prefix: `# Trial ${round}\n# İki sayının büyük olanını döndüren bir fonksiyon yaz.\n`, suffix: '', quality: 'python-maximum', expectedName: undefined },
  ];
}
export function editorCorpusDigest(rounds: number): string {
  return createHash('sha256').update(JSON.stringify({ version: editorCorpusVersion, rounds: Array.from({ length: rounds }, (_, round) => editorFixtures(round)) })).digest('hex');
}
export async function checkEditorSource(source: string, quality: string, expectedName?: string): Promise<boolean> {
  if (/\bTODO\b|NotImplementedError|```/.test(source)) return false;
  if (quality === 'typescript-addition') return typeScriptAddition(source, expectedName);
  if (expectedName && source.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/m)?.[1] !== expectedName) return false;
  return (await numericPython(source, quality === 'python-maximum' ? 'maximum' : 'addition')).passed;
}
