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

/** Stop immediately repeated Rust statement blocks, including a truncated repeat. */
function trimRustRepeat(text: string, prefix: string): string {
  if (!text.trim()) return text;
  const newline = prefix.lastIndexOf("\n");
  if (prefix.slice(newline + 1).trim()) return text;
  const source = prefix + text;
  const lines = [...source.matchAll(/[^\n]+/g)]
    .filter(line => line[0].trim())
    .map(line => ({ value: line[0].trim(), offset: line.index, end: line.index + line[0].length }));
  const firstGenerated = lines.findIndex(line => line.end > prefix.length);
  if (firstGenerated < 0) return text;
  for (let cursor = firstGenerated; cursor < lines.length; cursor++) {
    for (let size = 2; size <= Math.min(cursor, 8); size++) {
      const previous = lines.slice(cursor - size, cursor);
      if (!previous.every(line => line.value.endsWith(";"))) continue;
      const available = Math.min(size, lines.length - cursor);
      if (available < 2) continue;
      const repeats = previous.slice(0, available).every(({ value }, i) => {
        const candidate = lines[cursor + i].value;
        return candidate === value || (cursor + i === lines.length - 1 && candidate.length >= 8 && value.startsWith(candidate));
      });
      if (repeats) return text.slice(0, Math.max(0, lines[cursor].offset - prefix.length)).trimEnd();
    }
  }
  return text;
}

/** Keep the existing call closer and filter repeated Rust statement blocks. */
export function inlineInsertion(text: string, prefix: string, suffix: string, eol: string, languageId: string): string {
  if (languageId === "rust") text = trimRustRepeat(text, prefix);
  if (!/^(?:rust|python|javascript(?:react)?|typescript(?:react)?)$/.test(languageId)
    || !/^[ \t]*\)/.test(suffix)) return insertion(text, suffix, eol);

  const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
  // Keep literal contents out of delimiter matching. Fall back for incomplete
  // quotes and syntax this small scanner cannot identify confidently.
  const tokens = /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\\r\n]|\\.)*`|\/\/|\/\*|# |[()[\]{},'"`]/g;
  const stack: { token: string; index: number; argument: number; previous: string }[] = [];
  const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const match of line.matchAll(tokens)) {
    const token = match[0];
    const index = match.index;
    if (token.length > 1 && (token.startsWith("/") || token === "# ")) return insertion(text, suffix, eol);
    if (/^[([{]$/.test(token)) stack.push({ token, index, argument: index + 1, previous: "" });
    else if (opening[token]) {
      if (stack.pop()?.token !== opening[token]) return insertion(text, suffix, eol);
    } else if (token === "," && stack.length) {
      const frame = stack.at(-1)!;
      frame.previous = line.slice(frame.argument, index).trim();
      frame.argument = index + 1;
    } else if (token.length === 1 && /['"`]/.test(token)) return insertion(text, suffix, eol);
  }
  const call = stack.at(-1);
  if (call?.token !== "(" || !/[\p{ID_Continue}\])][!]?[ \t]*$/u.test(line.slice(0, call.index))) {
    return insertion(text, suffix, eol);
  }

  const existing = line.slice(call.argument);
  const joined = existing + text;
  const nested: string[] = [];
  let start = 0, previous = call.previous, previousSeparator = -1;
  const repeatsPrevious = (end: number) => {
    const argument = joined.slice(start, end).trim();
    // Exact, adjacent expression repeats only. Keep distinct arguments.
    return previous !== "" && argument === previous;
  };
  const finish = (end: number) => insertion(joined.slice(existing.length, Math.max(existing.length, end)), "", eol);
  for (const match of joined.matchAll(tokens)) {
    const token = match[0];
    const index = match.index;
    if (token.length > 1 && (token.startsWith("/") || token === "# ")) return insertion(text, suffix, eol);
    if (/^[([{]$/.test(token)) nested.push(token);
    else if (opening[token]) {
      if (!nested.length && token === ")") return finish(repeatsPrevious(index) ? previousSeparator : index);
      if (nested.pop() !== opening[token]) return insertion(text, suffix, eol);
    } else if (token === "," && !nested.length) {
      if (repeatsPrevious(index)) return finish(previousSeparator);
      previous = joined.slice(start, index).trim();
      previousSeparator = index;
      start = index + 1;
    } else if (token.length === 1 && /['"`]/.test(token)) return insertion(text, suffix, eol);
  }
  return finish(!nested.length && repeatsPrevious(joined.length) ? previousSeparator : joined.length);
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

const explanation = /^(?:\*{0,2}(?:explanation|output|açıklama|çıktı)\*{0,2}\s*:|(?:in this (?:code|example|snippet)|as you can see)\s*,|(?:this (?:code|example|snippet|function)|we (?:then\s+)?(?:have|print|define|declare|create|use|return))\s+[\p{L}]|here(?:'s| is) (?:the |a |an |how\b)|bu (?:kodda|örnekte|fonksiyonda)\b)/iu;
const fillerComment = /^(?:(?:initialize|declare|define|create)\s+(?:(?:a|the)\s+)?(?:new\s+)?variable\b|(?:print|display|output)\s+(?:the\s+)?(?:value|result|output)\b|(?:değişkeni oluştur|değeri yazdır|sonucu yazdır)\b)/iu;
const plainComment = /^[ \t]*(?:\/{2}(?![\/!])|#(?=[ \t]|$)|--(?=[ \t]|$))[ \t]*(.*)$/u;

function filterComments(text: string, languageId: string): string {
  // # and -- can be syntax in other languages. Limit these markers to their
  // known comment languages, and keep documentation comments and directives.
  const lines = text.split(/(?<=\n)/);
  const comments = lines.map(line => {
    const match = plainComment.exec(line.trimEnd());
    if (!match) return undefined;
    const marker = line.trimStart()[0];
    if (marker === "/" && !/^(?:rust|java|javascript(?:react)?|typescript(?:react)?|c|cpp|csharp|go|swift|kotlin|zig|dart|scala|php)$/.test(languageId)) return undefined;
    if (marker === "#" && !/^(?:python|ruby|shellscript|yaml|r|perl)$/.test(languageId)) return undefined;
    if (marker === "-" && !/^(?:sql|lua|haskell)$/.test(languageId)) return undefined;
    if (/^(?:type:|noqa\b|pragma\b|eslint\b|go:|nolint\b|@\w)/i.test(match[1])) return undefined;
    return match[1];
  });
  if (lines.every((line, i) => !line.trim() || comments[i] !== undefined)) return "";
  return lines.filter((_, i) => {
    const body = comments[i];
    return body === undefined || (body !== "" && !explanation.test(body) && !fillerComment.test(body));
  }).join("");
}

/** Filter common chat wrappers and narration from model suggestions. */
export function codeOnlySuggestion(text: string, languageId = ""): string {
  if (explanation.test(text.trimStart())) {
    // Recover a single explicitly fenced code block from a prose introduction.
    const fenced = /^[ \t]*```[\w.+#-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*\r?$/m.exec(text);
    if (!fenced || explanation.test(fenced[1].trimStart())) return "";
    return filterComments(fenced[1], languageId);
  }
  // An explanation appended as a separate paragraph is not part of the edit.
  const boundary = /\r?\n[ \t]*\r?\n(?=[^\r\n])/.exec(text);
  if (boundary && explanation.test(text.slice(boundary.index + boundary[0].length))) {
    text = text.slice(0, boundary.index);
  }
  return filterComments(text, languageId);
}

/** Ignore obvious JavaScript statements emitted as new Rust statements. */
export function isForeignRustStatement(text: string, prefix: string): boolean {
  const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
  return /^[ \t]*$/.test(linePrefix)
    && /^(?:console\.(?:log|warn|error|info)\s*\(|(?:export\s+)?(?:async\s+)?function\s+[$\w]+\s*\(|(?:export\s+)?(?:const|var)\s+[$\w]+\s*=|(?:import|export)\s*\{[^\n]*\}\s*from\s*['"])/.test(text.trimStart());
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
