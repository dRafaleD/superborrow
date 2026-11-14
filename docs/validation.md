# Validation evidence

## Local Windows development run — 2026-11-15

- Rust unit tests: 7 passed (UTF-16/CRLF, framed transport limits, loopback
  configuration, stream formats, incremental parsing/history and prompt limits).
- Node tests: 17 passed against a real core process / controlled HTTP servers.
  Coverage includes concurrent reverse replies, cancellation, stale versions,
  SSE/NDJSON and Unicode chunks, provider fallback/isolation, next-edit context,
  debounce, HTTP disconnect, timeout, synchronization and ghost-text formatting.
- Rust Clippy with warnings denied and TypeScript strict compile passed.

## Actual local inference

Server: existing Ollama installation. Existing model: `qwen2.5-coder:7b`.
No model was downloaded. The smoke script sent a small Python function with
`return ` at the cursor and a newline suffix. Both responses were `a + b`.

| Run | Router/inference time | State |
| --- | ---: | --- |
| 1 | 5744 ms | First request, including model load |
| 2 | 82 ms | Same prompt repeated while warm |

These are two observations, not a latency benchmark or percentile estimate.
Times exclude editor dispatch/rendering and core context construction. The
second call benefits from identical-prompt caching. New or larger contexts,
longer output and different hardware may be substantially slower.

## Scope of verification

The installed 0.2.0 package activated in Antigravity IDE; its extension-host log
recorded `Connected: protocol 1, phase 4, core 0.2.0` and its bundled core process
was running. The automated desktop inspection was stopped with Escape. Visual
ghost-text acceptance, mode switching, IDE model discovery and Next Edit preview
in the live editor were therefore not verified. Existing unsaved README conflict
tabs were left untouched.

HTTP mocks validate llama.cpp and OpenAI-compatible formats; those two real
servers were not run locally. The actual inference evidence is Ollama only.
The portable IDE model route is implemented; access depends on the host's
exposed providers and user selection/consent. No successful private Antigravity
model call is claimed. Next Edit is a selected-range proposal with preview,
not tested semantic correctness for arbitrary edits.

CI adds independent Windows/Ubuntu builds and tests; its run status must be
checked on the repository and is not inferred from local success.
