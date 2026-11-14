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

export class CompletionCache {
  private readonly values = new Map<string, { text: string; expires: number }>();
  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (!value || value.expires < Date.now()) { this.values.delete(key); return undefined; }
    return value.text;
  }
  put(key: string, text: string): void {
    this.values.delete(key);
    this.values.set(key, { text, expires: Date.now() + 2000 });
    while (this.values.size > 32) this.values.delete(this.values.keys().next().value!);
  }
  clear(): void { this.values.clear(); }
}

export function excludedPath(filePath: string, patterns: readonly string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some(pattern => {
    // File-name/path fragments with '*' and '?' wildcards, deliberately no shell.
    const expression = pattern.replace(/\\/g, "/").split("*").map(part => part.split("?").map(segment => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*");
    return new RegExp(`(?:^|/)${expression}(?:$|/)`, "i").test(normalized);
  });
}
