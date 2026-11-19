/** Keep the existing suffix and normalize generated text to the document EOL. */
export function insertion(text: string, suffix: string, eol: string): string {
  text = text.replace(/\r\n|\r/g, "\n");
  suffix = suffix.replace(/\r\n|\r/g, "\n");
  const limit = Math.min(text.length, suffix.length, 256);
  for (let count = limit; count > 0; count--) {
    if (text.endsWith(suffix.slice(0, count))) { text = text.slice(0, -count); break; }
  }
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Same bounded output cleanup used by the Rust provider path. */
export function cleanCompletion(text: string): string {
  if (text.trim() === "<NO_COMPLETION>") return "";
  if (text.trimStart().startsWith("```")) {
    const trimmed = text.trim();
    const newline = trimmed.indexOf("\n");
    if (newline >= 0) {
      text = trimmed.slice(newline + 1).split(/^\s*```[ \t]*\r?$/m, 1)[0].replace(/[\r\n]+$/, "");
    }
  }
  for (const token of ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>", "<|im_end|>", "[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"]) {
    const position = text.indexOf(token);
    if (position >= 0) text = text.slice(0, position);
  }
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, 16384);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Propagate a declaration rename within a flat JS/TS declaration statement.
 * Leave strings, properties, nested scopes and separate statements to the model.
 */
export function followDeclarationRename(line: string, column: number, previousName: string, name: string): string | undefined {
  const identifier = /^[$A-Z_a-z][$\w]*$/;
  if (line.length > 512 || name === previousName || !identifier.test(previousName) || !identifier.test(name)
    || !/^\s*(?:(?:export)\s+)?(?:const|let|var)\s+$/.test(line.slice(0, column))) return undefined;
  const rest = line.slice(column + name.length);
  if (!/^\s*=[\w$ ,+=*%()\-\t]+;?[ \t]*$/.test(rest)) return undefined;
  let nesting = 0;
  let nextDeclaration = -1;
  for (let index = 0; index < rest.length; index++) {
    const character = rest[index];
    if (character === "(") nesting++;
    else if (character === ")") nesting--;
    else if (character === "," && nesting === 0 && nextDeclaration < 0) nextDeclaration = index + 1;
    if (nesting < 0) return undefined;
  }
  if (nesting || nextDeclaration < 0) return undefined;
  // Reject bindings of the old or new name, and avoid suggesting a rename
  // when the new name already occurs in another expression.
  const referenced = /[$A-Z_a-z][$\w]*/g;
  const references = [...rest.matchAll(referenced)];
  if (references.some(value => value[0] === name || (value[0] === previousName && /^\s*=/.test(rest.slice(value.index + previousName.length))))) return undefined;
  const remaining = rest.slice(nextDeclaration);
  const updated = remaining.replace(referenced, value => value === previousName ? name : value);
  return updated === remaining ? undefined : line.slice(0, column + name.length + nextDeclaration) + updated;
}

export class CompletionCache<T = string> {
  private readonly values = new Map<string, { text: T; expires: number }>();
  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (!value || value.expires < Date.now()) { this.values.delete(key); return undefined; }
    return value.text;
  }
  put(key: string, text: T): void {
    this.values.delete(key);
    this.values.set(key, { text, expires: Date.now() + 2000 });
    while (this.values.size > 32) this.values.delete(this.values.keys().next().value!);
  }
  clear(): void { this.values.clear(); }
}

/** Reuse only a verified continuation consumed by insertions at its cursor.
 * Offsets and lengths use editor UTF-16 units, including CRLF and emoji.
 */
export class ContinuationCache<T> {
  private value: { uri: string; version: number; offset: number; text: string; metadata: T; expires: number } | undefined;
  constructor(private readonly now: () => number = Date.now, private readonly lifetimeMs = 15000) {}
  put(uri: string, version: number, offset: number, text: string, metadata: T): void {
    this.value = text ? { uri, version, offset, text, metadata, expires: this.now() + this.lifetimeMs } : undefined;
  }
  get(uri: string, version: number, offset: number): { text: string; metadata: T } | undefined {
    const value = this.value;
    if (value && value.expires <= this.now()) this.clear();
    return this.value && this.value.uri === uri && this.value.version === version && this.value.offset === offset
      ? { text: this.value.text, metadata: this.value.metadata } : undefined;
  }
  advance(uri: string, version: number, changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]): void {
    const value = this.value;
    const change = changes[0];
    if (!value || value.uri !== uri || version !== value.version + 1 || changes.length !== 1
      || change.rangeOffset !== value.offset || change.rangeLength !== 0 || !change.text
      || !value.text.startsWith(change.text) || value.expires <= this.now()) { this.clear(); return; }
    value.version = version;
    value.offset += change.text.length;
    value.text = value.text.slice(change.text.length);
    if (!value.text) this.clear();
  }
  clear(): void { this.value = undefined; }
}

export function excludedPath(filePath: string, patterns: readonly string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some(pattern => {
    // File-name/path fragments with '*' and '?' wildcards, deliberately no shell.
    const expression = pattern.replace(/\\/g, "/").split("*").map(part => part.split("?").map(segment => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*");
    return new RegExp(`(?:^|/)${expression}(?:$|/)`, "i").test(normalized);
  });
}
