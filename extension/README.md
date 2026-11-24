# Superborrow 0.3.14

[English](https://github.com/dRafaleD/superborrow/blob/main/README.md) ·
[Türkçe](https://github.com/dRafaleD/superborrow/blob/main/README.tr.md) ·
[MIT License](https://github.com/dRafaleD/superborrow/blob/main/LICENSE)

Hybrid local / IDE code completion with a bundled Rust context engine.

Rust is the primary focus. JavaScript,
TypeScript and Python have syntax-aware context, and other languages use
text context. Suggestions may be incorrect or repetitive. Review edits
before accepting them and run your project's checks. Relative speed and
quality against Cursor have not been established.

Duskline uses the selected local Ollama model. Antigravity and other cloud
providers can receive source snippets and relevant context. Filename exclusions
do not detect secrets inside eligible source files.

In a trusted workspace, the engine starts automatically. Click the status bar to
cycle Hybrid, Local and Antigravity modes. The signed-in Antigravity model
catalog is discovered automatically through the host extension's exported API.
**Select IDE Model** pins a model across restarts; auto prefers a fast model.
Generic VS Code hosts can still select `vscode.lm` models or an explicit adapter.

### Duskline IDE

Install the Windows x64 VSIX into Duskline and run **Superborrow: Select IDE
Model**. The picker lists models already installed in Ollama. Choose
`qwen2.5-coder:0.5b` for fast fill-in-the-middle suggestions or pick another
installed model. Duskline warms the selected model in a dedicated managed
Ollama process. Tab accepts ghost text and nearby inline replacements. Model
inference runs locally in trusted workspaces. The TypeScript language service
can suggest a single unambiguous missing import in TypeScript or JavaScript.
Select and overwrite an entire identifier to see follow-up replacements for
references in files already open in the same project. Tab moves to the next
reference, then Tab accepts its replacement. The language service can also
complete a unique property or enum member in saved and untitled files. When
parentheses are already present, it can complete a unique method name.
These suggestions work with the local model turned off. Use **Superborrow:
Pause / Resume Tab** to pause suggestions.

Run **Antigravity Tab: Use Superborrow for Tab** to make Superborrow the active
Tab provider with IDE-only routing (also the default for new configurations). It saves and disables only the
competing native `tabEnabled` preference. **Restore Antigravity Tab** restores
that preference and pauses Superborrow. This is a persistent provider choice;
pausing alone does not re-enable the native provider. Account, chat and privacy
settings remain under the host's control.

For Ollama with a previously installed FIM-capable model:

```json
{
  "superborrow.hybridPreference": "ide",
  "superborrow.ideModel": "auto",
  "superborrow.localApi": "ollama",
  "superborrow.endpoint": "http://127.0.0.1:11434/api/generate",
  "superborrow.model": "qwen2.5-coder:7b"
}
```

Default transport is llama.cpp `http://127.0.0.1:8080/infill`. OpenAI-compatible
local `/v1/completions` is also supported. Only HTTP loopback addresses are
accepted. Models and servers are not downloaded or started by the extension.

Inline suggestions use the editor's standard acceptance key. **Suggest Next
Edit** proposes a replacement for the selection or current line, opens a diff,
and applies it only after **Apply**, provided the document version still matches.

**Inspect Available Models** lists model metadata, active extension export names
and candidate command IDs. It does not execute undocumented internal commands.
**Show Diagnostics** opens connection/error logs without source text or prompts.

Context is bounded, in memory, and collected from up to 16 open eligible
documents. In a trusted workspace, `superborrow.importContext` also reads up to
four directly imported local TypeScript/JavaScript files (64 KB each) for API/type
references, without opening editors or traversing dependencies. Disable that
setting to restrict context to open documents. Common secret/dependency filenames
are excluded via `superborrow.exclude`.
Filename filtering does not detect every secret in arbitrary source code.
Local mode uses only the loopback server; Hybrid can fall back to a selected IDE
provider, which may send code to that provider's service.

No language allowlist is applied to file, untitled or notebook-cell documents.
Languages without an AST grammar use the same text context and model bridge.
Comments can express implementation intent: type `// toplama fonksiyonu oluştur`
and continue on the next line to receive a proposed function, then accept it with
Tab. Python `#`, SQL `--`, CSS/HTML comments and other natural-language comments
use the same automatic flow. Suggestions are never auto-applied.

State the intended behavior, for example `# create a function that adds two
numbers` in Python. A bare `create function` does not define behavior. The
completion prompt requests no invented scaffolds for such ambiguous requests,
and working bodies rather than `pass`/TODO when behavior is specified. Explicit
skeleton requests are still supported. Model output still requires review.

With `hybridPreference: ide`, the IDE model is primary for every language and
the local server is a fallback. `auto` uses the context heuristic; `local` prefers
local inference. The native model adapter was verified against Antigravity
extension 1.11.0; incompatible future APIs produce diagnostics rather than
reading tokens or automating chat windows.

Windows x64 package includes the Rust binary. Other platforms can build the core
and use `superborrow.corePath`. Latency depends on model size, hardware and
prompt cache state. No general sub-100-ms guarantee is made.

Full documentation: https://github.com/dRafaleD/superborrow (private repository).

Matching typing or partial acceptance reuses the remaining model suggestion for up to 15 seconds without another model call. Divergent edits, other document edits, model/configuration changes and expiry invalidate it. Diagnostics expose `continuationHits`, `modelRequests` and `lastInlineLatencyMs` separately from provider latency. Empty results are cached for two seconds for identical requests. Existing explicit Hybrid/Local preferences remain in effect until changed or Use Superborrow for Tab is run.

Concurrent requests at the same snapshot/cursor share one inference with independent cancellation. Document changes cancel immediately; a 25 ms handoff keeps identical requests alive when the editor replaces a cancellation token. Diagnostics also report `sharedRequests`.

Version 0.3.3 ranks cached declarations/types by referenced names and imports,
including exports and distant active-file declarations. Up to eight nearby
errors/warnings are advisory model context; changed diagnostics invalidate old
suggestions. `maxContextBytes` covers instructions and chat framing as well as
source context. See the repository validation report for targeted A/B quality
results; Cursor superiority is not established.

In 0.3.4, IDE mode can reuse an in-flight prediction across exact forward typing
while racing it against a fresh request (up to two client-side jobs). This can
consume additional provider work; set `superborrow.speculativeTyping` to false
for the single version-bound route. Changes outside that typed prefix cancel
the prediction; mismatched old output never wins. Excluded virtual documents
and obsolete requests away from the actual caret no longer interrupt it.

In 0.3.5, automatic selection excludes image/orchestrator models and prefers
low-reasoning Flash fallback variants. Explicit pins remain respected. Small
real-account comparisons supported keeping Hydrogen Low as the primary model;
they do not establish superiority to Cursor. See `docs/validation.md` in the repo.

In 0.3.6, adjacent queued updates to the same document collapse into the latest
snapshot. Preparation, other documents and close remain ordering barriers.
This reduces redundant context RPCs/parses during a backlog without changing
an in-flight snapshot or contacting additional models.

In 0.3.7, closed direct imports contribute bounded, request-scoped symbol
references. Open unsaved buffers take priority. Source file events invalidate
cached suggestions for tracked imports; older cores keep the open-document path.

In 0.3.8, ordinary body edits reuse imported source reads while imports are
unchanged. Import/file/workspace changes still invalidate references. Diagnostics
expose bounded cache/read counts without paths, prompts or source text.
