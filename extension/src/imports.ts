import * as path from "node:path";
import { open, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { excludedPath } from "./completion";
import { UpdateDocumentParams } from "./protocol";

const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root: string, filename: string) => { const relative = path.relative(root, filename); return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

function importSource(text: string): string {
  let output = "", state = "", escaped = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index], next = text[index + 1];
    if (state === "line") { if (ch === "\n") state = ""; output += ch === "\n" ? ch : " "; continue; }
    if (state === "block") { if (ch === "*" && next === "/") { output += "  "; index++; state = ""; } else output += ch === "\n" ? ch : " "; continue; }
    if (state) {
      output += state === "`" ? (ch === "\n" ? ch : " ") : ch;
      if (!escaped && ch === state) state = "";
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (ch === "/" && (next === "/" || next === "*")) { state = next === "/" ? "line" : "block"; output += "  "; index++; }
    else { output += ch; if (ch === "'" || ch === '"' || ch === "`") { state = ch; escaped = false; } }
  }
  return output;
}

/** Bounded, direct relative imports only. No package resolution, directory
 * traversal, code execution, editor opens or recursive dependency scans.
 */
export class LocalImports {
  private readonly loaded = new Set<string>();
  private anyChange = false;
  private hits = 0;
  private reads = 0;
  private readonly cache = new Map<string, { expires: number; documents: UpdateDocumentParams[] }>();
  get status() { return { hits: this.hits, fileReads: this.reads, entries: this.cache.size, trackedPaths: this.loaded.size, conservativeInvalidation: this.anyChange }; }
  clear(): void { this.loaded.clear(); this.cache.clear(); this.anyChange = false; }
  changed(filename: string): boolean { return this.anyChange || this.loaded.has(normalize(filename)); }

  async resolve(filename: string, source: string, workspace: string, excluded: readonly string[], signal: AbortSignal): Promise<UpdateDocumentParams[]> {
    if (signal.aborted || !extensions.includes(path.extname(filename))) return [];
    const specifiers = [...new Set([...importSource(source.slice(0, 32768)).matchAll(/^\s*(?:import|export)\b[^;]{0,2048}?\bfrom\s*["'](\.{1,2}\/[^"'\r\n]+)["']/gm)].map(match => match[1]))].slice(0, 8);
    // Ordinary body edits must not reread unchanged dependencies on every
    // keystroke. The resolution inputs, not the whole source, identify this cache.
    const key = JSON.stringify([filename, specifiers, workspace, excluded]);
    const saved = this.cache.get(key);
    if (saved && saved.expires > Date.now()) { this.hits++; return saved.documents; }
    const documents: UpdateDocumentParams[] = [];
    try {
      const root = await realpath(workspace);
      const active = await realpath(filename);
      if (!inside(root, active)) return [];
      for (const specifier of specifiers) {
        if (signal.aborted || documents.length === 4) break;
        if (/[?#\x00-\x1f\\]/.test(specifier)) continue;
        const base = path.resolve(path.dirname(active), specifier);
        if (!inside(root, base) || excludedPath(base, excluded)) continue;
        const ext = path.extname(base);
        const candidates = ext ? (/\.[mc]?jsx?$/.test(ext) ? [...extensions.map(extension => base.slice(0, -ext.length) + extension), base] : [base]) : [...extensions.map(extension => base + extension), ...extensions.map(extension => path.join(base, "index" + extension))];
        for (const candidate of [...new Set(candidates)]) {
          if (signal.aborted) break;
          if (!extensions.includes(path.extname(candidate)) || excludedPath(candidate, excluded)) continue;
          // Remember missing candidates too: creating a previously missing
          // import must invalidate completion caches.
          this.loaded.add(normalize(candidate));
          try {
            const resolved = await realpath(candidate);
            this.loaded.add(normalize(resolved));
            if (!inside(root, resolved) || resolved === active || !extensions.includes(path.extname(resolved)) || excludedPath(resolved, excluded)) continue;
            const file = await open(resolved, "r");
            let text: string;
            try {
              const info = await file.stat();
              if (!info.isFile() || info.size > 65536) continue;
              const buffer = Buffer.alloc(65537);
              this.reads++;
              let bytesRead = 0;
              while (bytesRead < buffer.length && !signal.aborted) {
                const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                if (!read.bytesRead) break;
                bytesRead += read.bytesRead;
              }
              if (bytesRead > 65536 || buffer.subarray(0, bytesRead).includes(0)) continue;
              text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
            } finally { await file.close(); }
            if (signal.aborted) break;
            const uri = pathToFileURL(resolved).toString();
            if (!documents.some(document => document.uri === uri)) documents.push({ uri, version: 1, languageId: /\.[mc]?tsx?$/.test(path.extname(resolved)) ? (resolved.endsWith(".tsx") ? "typescriptreact" : "typescript") : "javascript", text });
            break;
          } catch { /* Missing, inaccessible, invalid UTF-8 or unsupported source. */ }
        }
      }
    } catch { return []; }
    if (!signal.aborted) {
      this.cache.set(key, { expires: Date.now() + 2000, documents });
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      // File event tracking remains bounded across long editor sessions.
      if (this.loaded.size > 512) {
        this.cache.clear(); this.loaded.clear();
        // Do not silently lose invalidation for the prediction using these
        // references. The next source event conservatively invalidates it.
        this.anyChange = true;
      }
    }
    return signal.aborted ? [] : documents;
  }
}
