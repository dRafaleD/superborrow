# Superborrow

[English](README.md) · [Türkçe](README.tr.md)

Tab completion for Duskline, Antigravity, and compatible VS Code–based editors.
Version **0.3.14** is an early development preview.

> **Early preview.** The current priority is reliable Rust Tab completion in
> Duskline. Review suggestions before accepting them and run your project's
> compiler and tests. A model can suggest incorrect code, repeat a block, or
> answer in the wrong language. Filters catch some of these cases.

| Language | Support |
| --- | --- |
| Rust | Primary focus. Tree-sitter context, trait and method signatures, Rust-specific prompts, and repetition filters. |
| TypeScript, JavaScript, TSX, JSX, and Python | Syntax-aware completion. In Duskline, some TS/JS suggestions come from the language service. |
| Other languages | General completion uses the language ID and text around the cursor. Coverage and quality depend on the selected model. |

### Limitations and data use

- Tests cover context, suggestion filters, and the bridge protocol. Real-editor
  behavior varies by language, model, and editor version. Comparative speed
  and quality against Cursor have not been established.
- Duskline runs the selected model in a local Ollama process. Model size and
  hardware affect latency and memory use. Antigravity uses the host's model
  provider and account quota. Its integration depends on the host API and may
  change with editor updates.
- A selected cloud provider can receive source snippets and related context.
  `superborrow.exclude` filters by filename and cannot detect secrets inside
  eligible files. Set `superborrow.importContext` to `false` to disable reading
  unopened TS/JS imports for additional context.

## Features

- Fill-in-the-middle (FIM) using text before and after the cursor, with Qwen
  and Codestral formats.
- Ranked symbols, relevant imports, recent edits, and nearby diagnostics.
  Identical requests can share an inference call, and typing the start of a
  suggestion can reuse its remaining text.
- Local HTTP adapters for llama.cpp, Ollama, and OpenAI-compatible completions.
  IDE models are available through Antigravity, `vscode.lm`, or a compatible
  adapter extension.
- Code suggestions from comments describing a specific behavior. A vague
  request such as `create function` may produce no suggestion.
- **Superborrow: Suggest Next Edit** previews a proposed replacement for the
  selection or current line. It checks the document version before applying.
  Rust Tab normally inserts at the cursor. In Duskline, TS/JS language-service
  features can also offer missing imports and rename follow-ups.

## Build and install

Use a Rust toolchain that supports edition 2024, Node.js 22+, and npm.
Tree-sitter requires MSVC Build Tools on Windows or a C compiler on Linux.

```powershell
npm --prefix extension ci --ignore-scripts
cargo build --locked --manifest-path core-rust/Cargo.toml
npm --prefix extension test
cargo test --locked --manifest-path core-rust/Cargo.toml
cargo clippy --locked --manifest-path core-rust/Cargo.toml --all-targets -- -D warnings
npm --prefix extension run package:windows
```

The last command creates a Windows x64 VSIX under `packages/` with the bundled
Rust core. Install it from the editor's **Install from VSIX…** command and
run **Developer: Reload Window**. The engine starts in trusted workspaces.
For development, open the repository and press F5. Use `superborrow.corePath`
to point to a different core binary.

## Usage

### Duskline

If the profile restricts extension versions, add the exact VSIX version to
the allowlist. Run **Superborrow: Select IDE Model** and choose a model already
installed in Ollama. Type in a source file and press **Tab** when a suggestion
appears. Use **Superborrow: Pause / Resume Tab** to pause or resume suggestions.

### Antigravity

Run **Antigravity Tab: Use Superborrow for Tab** to activate IDE-only routing
and turn off the competing native Tab provider. **Antigravity Tab: Restore
Antigravity Tab** restores the saved native preference and pauses Superborrow.
The automatic model picker discovers available models from the signed-in
account. **Superborrow: Select IDE Model** lets you pin a specific model.

The integration uses the exported model client from Antigravity host extension
1.11. On generic VS Code hosts, use the model picker for a compatible
`vscode.lm` provider or configure an explicit adapter.

### Local servers in other editors

Install a compatible model and start the server first. For an Ollama setup
that should use only the local server, use:

```json
{
  "superborrow.mode": "local",
  "superborrow.localApi": "ollama",
  "superborrow.endpoint": "http://127.0.0.1:11434/api/generate",
  "superborrow.model": "qwen2.5-coder:7b",
  "superborrow.fimFormat": "qwen"
}
```

Replace the model name with one you have installed. For llama.cpp, use
`llamaInfill` and the `/infill` endpoint. For an OpenAI-compatible server, use
`openAi` and the complete `/v1/completions` endpoint URL. Local HTTP connections
use loopback addresses. **IDE** mode uses the selected IDE provider, **Local**
uses the configured local server, and **Hybrid** can route or fall back between
them. Set `superborrow.hybridPreference` to `ide`, `local`, or `auto`.

## Context and controls

- The engine syncs up to 16 eligible open documents, with a 512 KiB per-file
  limit and an 8 MiB aggregate limit. It does not scan the entire repository.
- Trusted TS/JS workspaces can supply up to four directly imported local
  files, with a 64 KiB limit per file. Built-in exclusions include `.env*`,
  `*.pem`, `*.key`, `.git`, `node_modules`, `target`, and `dist`.
- `superborrow.speculativeTyping` allows up to two compatible client-side IDE
  predictions. It can consume additional provider work or quota. Disable it
  to use a single version-bound request path.
- Use **Superborrow: Show Diagnostics** for connection and error information
  or **Superborrow: Check Bridge** to reconnect. Superborrow keeps prompt
  context in memory and does not include source text in its normal logs.

## Validation

Windows and Ubuntu CI run formatting checks, Clippy, Rust builds and tests,
and Node tests against the actual core process. Those checks use controlled
fixtures and require no external model. With an installed Ollama model,
`npm --prefix extension run smoke:local` runs an optional local smoke test.
`SUPERBORROW_MODEL` selects a different installed model.

An optional signed-in Antigravity test runs on Windows with
`npm --prefix extension run test:host`. It uses synthetic files, an isolated
test profile, and account quota. The host test records acceptance separately
from provider responses.

[Validation notes](docs/validation.md) · [Architecture](docs/architecture.md) ·
[Bridge protocol](docs/protocol.md) · [IDE adapter contract](docs/ide-adapter.md)

## License

Superborrow is distributed under the [MIT License](LICENSE). Third-party
dependencies, model weights, and host editors have their own licenses.
