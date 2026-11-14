# Superborrow 0.3

Hybrid local / IDE code completion with a bundled Rust context engine.

In a trusted workspace, the engine starts automatically. Click the status bar to
cycle Hybrid, Local and Antigravity modes. The signed-in Antigravity model
catalog is discovered automatically through the host extension's exported API.
**Select IDE Model** pins a model across restarts; auto prefers a fast model.
Generic VS Code hosts can still select `vscode.lm` models or an explicit adapter.

Run **Antigravity Tab: Use Superborrow for Tab** to make Superborrow the active
Tab provider with IDE-first Hybrid routing. It saves and disables only the
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
It does not predict an edit location or modify multiple files.

**Inspect Available Models** lists model metadata, active extension export names
and candidate command IDs. It does not execute undocumented internal commands.
**Show Diagnostics** opens connection/error logs without source text or prompts.

Context is bounded, in memory, and collected from up to 16 open eligible
documents. Common secret/dependency filenames are excluded via `superborrow.exclude`.
Filename filtering does not detect every secret in arbitrary source code.
Local mode uses only the loopback server; Hybrid can fall back to a selected IDE
provider, which may send code to that provider's service.

No language allowlist is applied to file, untitled or notebook-cell documents.
Languages without an AST grammar use the same text context and model bridge.
Comments can express implementation intent: type `// toplama fonksiyonu oluştur`
and continue on the next line to receive a proposed function, then accept it with
Tab. Python `#`, SQL `--`, CSS/HTML comments and other natural-language comments
use the same automatic flow. Suggestions are never auto-applied.

With `hybridPreference: ide`, the IDE model is primary for every language and
the local server is a fallback. `auto` uses the context heuristic; `local` prefers
local inference. The native model adapter was verified against Antigravity
extension 1.11.0; incompatible future APIs produce diagnostics rather than
reading tokens or automating chat windows.

Windows x64 package includes the Rust binary. Other platforms can build the core
and use `superborrow.corePath`. Latency depends on model size, hardware and
prompt cache state. No general sub-100-ms guarantee is made.

Full documentation: https://github.com/dRafaleD/superborrow (private repository).
