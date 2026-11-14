# Superborrow protocol v1

Transport: stdin/stdout, JSON-RPC 2.0 objects with VS Code-style framing:

```text
Content-Length: <UTF-8 body byte length>\r\n
\r\n
<JSON body>
```

Stdout is reserved for protocol messages; stderr carries diagnostics. Maximum
body size is 8 MiB; headers are limited to 8 KiB. Framing violations close the
process. This is an application-specific JSON-RPC profile, not an LSP server.
Only individual objects, named parameters and integer/string request IDs are
supported; batches are outside this profile. Notifications omit `id` and never
receive replies. Each connection has its own document and request state.

## TS → Rust

| Method | Parameters | Result |
| --- | --- | --- |
| `initialize` | `{protocolVersion: 1}` | `{protocolVersion: 1, phase: 1}` |
| `updateDocument` | `{uri, languageId, version, text}` | `null` |
| `closeDocument` | `{uri}` | `null` |
| `requestCompletion` | `{uri, version, position: {line, character}, mode}` | `{text, version}` |
| `cancelRequest` | `{id: originalCompletionRequestId}` | notification |
| `shutdown` | omitted | `null`, then process exits |

Initialize before document/completion operations. Document updates are full
snapshots; versions must increase until close. Positions use zero-based lines
and UTF-16 code units, excluding CR/LF. Invalid positions and surrogate splits
are rejected. `mode` is `local`, `ide` or `hybrid`.

## Rust → TS

`requestIdeModel` request, with string ID `core:<counter>`:

```json
{
  "jsonrpc": "2.0",
  "id": "core:1",
  "method": "requestIdeModel",
  "params": {
    "requestId": "core:1",
    "prompt": "prefix\n[CURSOR]\nsuffix",
    "languageId": "typescript",
    "maxTokens": 128
  }
}
```

Reply with `{jsonrpc: "2.0", id: "core:1", result: {text: "..."}}`, or a
JSON-RPC error. `requestId` repeats the envelope ID so the typed handler can
register cancellation without inspecting transport internals. Rust also sends
`cancelRequest` notifications with this ID; the TS adapter aborts its handler.
TS uses numeric forward IDs, a separate namespace. Replies may arrive out of
order. Cancelling completes the original request with `-32800`; late reverse
replies are ignored. Reverse calls expire after 10 seconds and are limited to
128 pending calls. The TS client maps vscode-jsonrpc's cancellation wire method
to the public `cancelRequest` method.

Errors: `-32700` parse, `-32600` invalid envelope, `-32601` unknown method,
`-32602` invalid parameters, `-32603` invalid reverse result, `-32000` not
initialized, `-32002` bridge timeout, `-32003` IDE unavailable, `-32004` provider
not implemented, `-32005` pending limit, `-32800` cancelled, `-32801` stale
document/version. Closing or updating a document invalidates its pending results.

Phase 1 routes `ide` and `hybrid` through the same bridge for transport testing.
`local` returns an explicit unimplemented error. The prompt is a diagnostic
cursor split, not a FIM implementation. The editor adapter deliberately returns
an unavailable-model error until phase 4. No fabricated model output is shown.

References: [JSON-RPC 2.0](https://www.jsonrpc.org/specification),
[VS Code API](https://code.visualstudio.com/api/references/vscode-api).
