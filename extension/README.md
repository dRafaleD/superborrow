# Superborrow 0.2

Hybrid local / IDE code completion with a bundled Rust context engine.

In a trusted workspace, the engine starts automatically. Click the status bar to
cycle Hybrid, Local and Antigravity modes. Run **Antigravity Tab: Select IDE
Model** before using an IDE model; the editor must expose `vscode.lm` or a
configured adapter. The internal chat is not automatically an accessible API.

For Ollama with a previously installed FIM-capable model:

```json
{
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

Windows x64 package includes the Rust binary. Other platforms can build the core
and use `superborrow.corePath`. Latency depends on model size, hardware and
prompt cache state. No general sub-100-ms guarantee is made.

Full documentation: https://github.com/dRafaleD/superborrow (private repository).
